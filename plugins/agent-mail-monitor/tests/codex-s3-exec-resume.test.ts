/**
 * S3 (tcp-efp.1.6) evidence: exec-resume degraded single-owner baseline.
 */
import {
  ExecResumeError,
  ExecResumeOwner,
  fakeExecResumeTransport,
  percentile,
} from "./codex-s3-exec-resume.ts";
import { CodexIngressHarness } from "./codex-ingress-harness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const encode = (value: unknown) => JSON.stringify(value);
  if (encode(actual) !== encode(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function assertRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ExecResumeError ${code}`);
  } catch (error) {
    assert(error instanceof ExecResumeError, `expected ExecResumeError, got ${error}`);
    assertEquals(error.code, code);
  }
}

Deno.test("s3: exact-thread resume succeeds; process-per-event lifetime", async () => {
  const transport = fakeExecResumeTransport({ holdMs: 20 });
  const owner = new ExecResumeOwner("thread-durable", transport);
  const a = await owner.deliver({
    id: "b1",
    eventIds: [1],
    prompt: "MAIL #1 wake",
  });
  const b = await owner.deliver({
    id: "b2",
    eventIds: [2],
    prompt: "MAIL #2 wake",
  });
  assertEquals(a.threadId, "thread-durable");
  assertEquals(b.threadId, "thread-durable");
  assertEquals(transport.invocations.length, 2);
  assert(a.pid !== b.pid, "each exec resume must be a distinct process");
  assertEquals(transport.invocations.map((item) => item.threadId), [
    "thread-durable",
    "thread-durable",
  ]);
});

Deno.test("s3: concurrent delivers serialize (maxConcurrent === 1)", async () => {
  const transport = fakeExecResumeTransport({ holdMs: 80 });
  const owner = new ExecResumeOwner("thread-durable", transport);
  const started = Date.now();
  const results = await owner.deliverConcurrent([
    { id: "c1", eventIds: [10], prompt: "one" },
    { id: "c2", eventIds: [11], prompt: "two" },
    { id: "c3", eventIds: [12], prompt: "three" },
  ]);
  const elapsed = Date.now() - started;
  assertEquals(results.length, 3);
  assertEquals(transport.maxConcurrent, 1, "owner must serialize concurrent resumes");
  assert(
    elapsed >= 200,
    `expected ~3×80ms serialization, got ${elapsed}ms`,
  );
  // No overlapping intervals.
  const spans = transport.invocations.map((item) => [item.startedAtMs, item.endedAtMs]);
  for (let i = 1; i < spans.length; i++) {
    assert(
      spans[i][0] >= spans[i - 1][1],
      `invocation ${i} overlapped previous`,
    );
  }
});

Deno.test("s3: resume failure fails closed — no replacement thread", async () => {
  const transport = fakeExecResumeTransport({
    missingThreadId: "thread-missing",
    failMessage: "thread not found / config error (ambiguous)",
  });
  const owner = new ExecResumeOwner("thread-missing", transport);
  await assertRejectsCode(
    owner.deliver({ id: "x", eventIds: [99], prompt: "wake" }),
    "resume_failed",
  );
  assertEquals(owner.threadId, "thread-missing");
  assertEquals(transport.invocations.length, 1);
  // Contender must not invent a new thread id after failure.
  assertEquals(transport.invocations[0].threadId, "thread-missing");
});

Deno.test("s3: ambiguity after failure — same error path for missing vs forced fail", async () => {
  const missing = fakeExecResumeTransport({ missingThreadId: "t1" });
  const forced = fakeExecResumeTransport({
    failCodes: { t1: 1 },
    failMessage: "configuration failure",
  });
  const a = new ExecResumeOwner("t1", missing);
  const b = new ExecResumeOwner("t1", forced);
  let codeA = "";
  let codeB = "";
  try {
    await a.deliver({ id: "a", eventIds: [1], prompt: "a" });
  } catch (error) {
    assert(error instanceof ExecResumeError, "missing-thread path must throw ExecResumeError");
    codeA = error.code;
  }
  try {
    await b.deliver({ id: "b", eventIds: [2], prompt: "b" });
  } catch (error) {
    assert(error instanceof ExecResumeError, "forced-fail path must throw ExecResumeError");
    codeB = error.code;
  }
  assertEquals(codeA, "resume_failed");
  assertEquals(codeB, "resume_failed");
  // Both surfaces collapse to the same owner error code — operator cannot
  // safely distinguish "missing thread" from "config" without richer stderr.
});

Deno.test("s3: message-to-resume latency p50/p95 recorded (fake path)", async () => {
  const samples: number[] = [];
  for (let i = 0; i < 11; i++) {
    const transport = fakeExecResumeTransport({ holdMs: 5 });
    const owner = new ExecResumeOwner("thread-durable", transport);
    const writtenAtMs = Date.now();
    const result = await owner.deliver({
      id: `lat-${i}`,
      eventIds: [1000 + i],
      prompt: `MAIL #${1000 + i}`,
    });
    samples.push(result.endedAtMs - writtenAtMs);
  }
  samples.sort((a, b) => a - b);
  const summary = {
    scenario: "exec_resume_serialized",
    adapter: "fake-codex-exec-resume",
    samplesMs: samples,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    n: samples.length,
    note:
      "Fake-path process overhead only. Live codex exec resume adds model + session load latency and must not be auto-selected on App Server failure.",
  };
  console.log(`S3 latency summary: ${JSON.stringify(summary)}`);
  assert(summary.p95Ms < 2000, `fake p95 ${summary.p95Ms} exceeded soft budget`);
});

Deno.test("s3: harness fixture prompt preserves event ids across resume", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-s3-fixture-" });
  try {
    const harness = new CodexIngressHarness({
      root: `${root}/mailbox`,
      project: `${root}/project`,
      agent: "CobaltJaguar",
      nowNs: () => BigInt(Date.now()) * 1_000_000n,
    });
    const written = await harness.writeMail({
      id: 27982,
      created: "2026-07-28T21:04:29.583807Z",
      from: "GoldenLake",
      to: ["CobaltJaguar"],
      subject: "Monitor wake nudge",
      body: "exec-resume contender wake",
      importance: "high",
      ackRequired: true,
    });
    const transport = fakeExecResumeTransport();
    const owner = new ExecResumeOwner("thread-durable", transport);
    const prompt =
      `<agent_mail_events schema_version="1" event_ids="${written.id}">\nMAIL #${written.id}\n</agent_mail_events>`;
    const result = await owner.deliver({
      id: `mail-${written.id}`,
      eventIds: [written.id],
      prompt,
    });
    assertEquals(result.code, 0);
    assert(
      transport.invocations[0].prompt.includes("27982"),
      "resume prompt must carry event id 27982",
    );
    assert((await Deno.stat(written.path)).isFile, "non-consuming: fixture remains");
    harness.transcript("s3 exec-resume delivered fixture #27982 on exact thread-durable");
    assert(
      harness.evidenceJson().includes("exec-resume delivered fixture #27982"),
      "evidence must record exec-resume delivery",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("s3: duplicate batch id does not spawn a second process", async () => {
  const transport = fakeExecResumeTransport();
  const owner = new ExecResumeOwner("thread-durable", transport);
  await owner.deliver({ id: "same", eventIds: [1], prompt: "first" });
  await owner.deliver({ id: "same", eventIds: [1], prompt: "first-again" });
  assertEquals(transport.invocations.length, 1);
});
