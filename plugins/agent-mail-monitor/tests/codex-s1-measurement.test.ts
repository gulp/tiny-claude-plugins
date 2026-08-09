/**
 * S1 (tcp-efp.1.2) evidence: headless App Server tracer measurement.
 *
 * Private stdio client only. Uses the S0 fixture harness + fake App Server.
 * Does not attach a remote TUI or a second controlling client.
 */
import { CodexIngressHarness } from "./codex-ingress-harness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected output to include: ${expected}\nactual output:\n${actual}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("empty sample");
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

interface TimingEvent {
  event: string;
  atMs: number;
  turnId?: string;
  eventIds?: string;
  ordinal?: number;
  threadId?: string;
  method?: string;
}

async function readTiming(path: string): Promise<TimingEvent[]> {
  try {
    const text = await Deno.readTextFile(path);
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TimingEvent);
  } catch {
    return [];
  }
}

function wallClockNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

async function writeFakeCodex(temp: string): Promise<string> {
  const here = new URL(".", import.meta.url).pathname;
  const wrapper = `${temp}/fake-codex`;
  await Deno.writeTextFile(
    wrapper,
    `#!/bin/sh\nexec deno run --allow-env --allow-write "${here}codex-fake-app-server.ts" "$@"\n`,
  );
  await Deno.chmod(wrapper, 0o755);
  return wrapper;
}

async function runMeasuredOnce(options: {
  agent: string;
  project: string;
  root: string;
  inbox: string;
  wrapper: string;
  timingPath: string;
  since?: number;
  holdMs?: number;
  once?: boolean;
  interval?: number;
  thread?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-run",
    new URL("../scripts/codex-monitor.ts", import.meta.url).pathname,
    "monitor",
    "--agent",
    options.agent,
    "--project",
    options.project,
    "--root",
    options.root,
    "--interval",
    String(options.interval ?? 1),
    "--since",
    String(options.since ?? 0),
  ];
  if (options.once !== false) args.push("--once");
  if (options.thread) args.push("--thread", options.thread);
  if (options.holdMs !== undefined) {
    // hold is fake-server env, not a CLI flag
  }

  const result = await new Deno.Command("deno", {
    args,
    env: {
      ...Deno.env.toObject(),
      CODEX_BIN: options.wrapper,
      TEST_MONITOR_INBOX: options.inbox,
      TEST_SKIP_AUTO_MAIL: "1",
      TEST_TIMING_PATH: options.timingPath,
      ...(options.holdMs !== undefined ? { TEST_TURN_HOLD_MS: String(options.holdMs) } : {}),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("S1: #27982/#27983-shaped wake nudge is delivered for a fixture identity", async () => {
  const temp = await Deno.makeTempDir({ prefix: "codex-s1-wake-nudge-" });
  try {
    const project = `${temp}/project`;
    const root = `${temp}/mailbox`;
    const agent = "CobaltJaguar";
    const harness = new CodexIngressHarness({ root, project, agent, nowNs: wallClockNs });
    const written = await harness.writeMail({
      id: 27982,
      created: "2026-07-28T21:04:29.583807Z",
      from: "GoldenLake",
      to: [agent],
      subject: "Monitor wake nudge",
      body:
        "Your Agent Mail monitor is armed on durable thread `thread-durable`. Please acknowledge this message and reply on this thread if the monitor wakes you successfully.",
      importance: "high",
      ackRequired: true,
    });
    const timingPath = `${temp}/timing.jsonl`;
    const wrapper = await writeFakeCodex(temp);
    const result = await runMeasuredOnce({
      agent,
      project,
      root,
      inbox: harness.inbox,
      wrapper,
      timingPath,
      since: 0,
      thread: "thread-durable",
    });

    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertStringIncludes(result.stdout, "MAIL #27982");
    assertStringIncludes(result.stdout, "monitor-wake-nudge");
    assertStringIncludes(result.stdout, "Thread:  thread-durable");
    assertStringIncludes(result.stdout, "DELIVERED through #27982");
    // Non-consuming: fixture file remains after delivery.
    assert((await Deno.stat(written.path)).isFile, "fixture mail must remain after delivery");

    const timing = await readTiming(timingPath);
    const accepted = timing.find((event) => event.event === "turn_start_accepted");
    assert(accepted, "expected turn_start_accepted timing mark");
    assertEquals(accepted.eventIds, "27982");
    harness.transcript(
      `wake-nudge fixture delivered: mail=#27982 thread=thread-durable turn=${accepted.turnId}`,
    );
    assert(
      harness.evidenceJson().includes("wake-nudge fixture delivered"),
      "evidence transcript must record wake-nudge delivery",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("S1: message-to-turn latency p50/p95 are recorded over repeated idle wakes", async () => {
  const samples: number[] = [];
  const evidenceRoot = await Deno.makeTempDir({ prefix: "codex-s1-latency-evidence-" });
  try {
    const runs = 11;
    for (let i = 0; i < runs; i++) {
      const temp = await Deno.makeTempDir({ prefix: `codex-s1-latency-run-${i}-` });
      try {
        const project = `${temp}/project`;
        const root = `${temp}/mailbox`;
        const agent = "CobaltJaguar";
        const harness = new CodexIngressHarness({ root, project, agent, nowNs: wallClockNs });
        const mailId = 1000 + i;
        const writtenAtMs = Date.now();
        await harness.writeMail({
          id: mailId,
          created: "2026-07-28T21:04:29.583807Z",
          from: "GoldenLake",
          to: [agent],
          subject: `latency sample ${i}`,
          body: "fixture latency sample",
          importance: "normal",
        });
        const timingPath = `${temp}/timing.jsonl`;
        const wrapper = await writeFakeCodex(temp);
        const result = await runMeasuredOnce({
          agent,
          project,
          root,
          inbox: harness.inbox,
          wrapper,
          timingPath,
          since: 0,
        });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const timing = await readTiming(timingPath);
        const accepted = timing.find((event) => event.event === "turn_start_accepted");
        assert(accepted, "missing turn_start_accepted");
        assertEquals(accepted.eventIds, String(mailId));
        samples.push(accepted.atMs - writtenAtMs);
        harness.record(
          "transcript",
          JSON.stringify({
            run: i,
            mailId,
            writtenAtMs,
            turnStartAcceptedAtMs: accepted.atMs,
            mailToTurnMs: accepted.atMs - writtenAtMs,
          }),
        );
        await Deno.writeTextFile(
          `${evidenceRoot}/run-${i}.json`,
          harness.evidenceJson(),
        );
      } finally {
        await Deno.remove(temp, { recursive: true });
      }
    }

    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const summary = {
      scenario: "idle_turn_start",
      adapter: "private-stdio-fake-app-server",
      samplesMs: samples,
      p50Ms: p50,
      p95Ms: p95,
      n: samples.length,
      note:
        "Fake App Server timings bound the tracer+fixture path only; they are not live Codex 0.144.6/0.145.0 model latency.",
    };
    await Deno.writeTextFile(
      `${evidenceRoot}/summary.json`,
      JSON.stringify(summary, null, 2),
    );
    // Soft budget for the fake path: observation+acceptance should stay well under 2s.
    assert(p95 < 2000, `fake-path p95 ${p95}ms exceeded 2000ms soft budget`);
    assert(samples.length === 11, "expected 11 latency samples");
    // Keep the summary readable in failure output / CI logs.
    console.log(`S1 latency summary: ${JSON.stringify(summary)}`);
  } finally {
    // Leave evidenceRoot only if DENY cleanup is requested; default cleans.
    if (Deno.env.get("S1_KEEP_EVIDENCE") === "1") {
      console.log(`S1 evidence kept at ${evidenceRoot}`);
    } else {
      await Deno.remove(evidenceRoot, { recursive: true });
    }
  }
});

Deno.test({
  name: "S1: active-turn mail is serialized (no turn/steer); second event waits",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const temp = await Deno.makeTempDir({ prefix: "codex-s1-active-serialize-" });
    const deadline = Date.now() + 20_000;
    let child: Deno.ChildProcess | undefined;
    try {
      const project = `${temp}/project`;
      const root = `${temp}/mailbox`;
      const agent = "CobaltJaguar";
      const harness = new CodexIngressHarness({ root, project, agent, nowNs: wallClockNs });
      await harness.writeMail({
        id: 41,
        created: "2026-07-28T21:04:29.583807Z",
        from: "GoldenLake",
        to: [agent],
        subject: "first during idle",
        body: "first",
      });
      const timingPath = `${temp}/timing.jsonl`;
      const wrapper = await writeFakeCodex(temp);

      // Fake peer exits cleanly after 2 completed turns — no SIGTERM/pipe races.
      child = new Deno.Command("deno", {
        args: [
          "run",
          "--allow-env",
          "--allow-read",
          "--allow-run",
          new URL("../scripts/codex-monitor.ts", import.meta.url).pathname,
          "monitor",
          "--agent",
          agent,
          "--project",
          project,
          "--root",
          root,
          "--interval",
          "1",
          "--since",
          "0",
        ],
        env: {
          ...Deno.env.toObject(),
          CODEX_BIN: wrapper,
          TEST_MONITOR_INBOX: harness.inbox,
          TEST_SKIP_AUTO_MAIL: "1",
          TEST_TIMING_PATH: timingPath,
          TEST_TURN_HOLD_MS: "300",
          TEST_EXIT_AFTER_TURNS: "2",
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const stdoutPromise = new Response(child.stdout).text();
      const stderrPromise = new Response(child.stderr).text();

      let planted = false;
      while (Date.now() < deadline) {
        const timing = await readTiming(timingPath);
        if (timing.some((event) => event.event === "turn_start_accepted")) {
          await harness.writeMail({
            id: 42,
            created: "2026-07-28T21:04:30.583807Z",
            from: "GoldenLake",
            to: [agent],
            subject: "second during active turn",
            body: "second",
            importance: "urgent",
          });
          planted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert(planted, "failed to observe first turn_start_accepted before planting second mail");

      // Await natural exit (fake server exits after 2 turns → monitor fails closed).
      const status = await Promise.race([
        child.status,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`active-turn test exceeded ${deadline - Date.now()}ms budget`)),
            Math.max(1, deadline - Date.now()),
          )
        ),
      ]);
      const [stdout, _stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      child = undefined;

      const timing = await readTiming(timingPath);
      assertStringIncludes(stdout, "MAIL #41");
      assertStringIncludes(stdout, "DELIVERED through #41");
      assertStringIncludes(stdout, "MAIL #42");
      assertStringIncludes(stdout, "DELIVERED through #42");
      assertEquals(
        timing.filter((event) => event.event === "turn_steer_received").length,
        0,
        "headless tracer must not emit turn/steer",
      );
      const starts = timing.filter((event) => event.event === "turn_start_accepted");
      assertEquals(starts.length, 2);
      assertEquals(starts[0].eventIds, "41");
      assertEquals(starts[1].eventIds, "42");
      assert(
        starts[1].atMs - starts[0].atMs >= 250,
        `second turn started too early (${starts[1].atMs - starts[0].atMs}ms); expected serialization`,
      );
      // Monitor exits non-zero when the fake peer closes after the second turn.
      assert(
        status.code !== 0,
        `expected monitor to observe peer exit after 2 turns, got code=${status.code}`,
      );
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort.
        }
        try {
          await Promise.race([
            child.status,
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        } catch {
          // ignore
        }
      }
      await Deno.remove(temp, { recursive: true });
    }
  },
});
