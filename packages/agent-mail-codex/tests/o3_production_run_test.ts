/**
 * O3 follow-up: production run reaches a fake App Server turn (not heartbeat-only).
 */

import type { IngressConfig } from "../src/config.ts";
import { slugForProject } from "../src/mailbox/mod.ts";
import { runProductionIngress, type SpawnedAppServer } from "../src/operator/production_run.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeAppServer {
  readonly inbound = new TransformStream<Uint8Array>();
  readonly outbound = new TransformStream<Uint8Array>();
  readonly methods: string[] = [];
  #reader = this.outbound.readable.getReader();
  #writer = this.inbound.writable.getWriter();
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #turn = 0;
  #task: Promise<void>;
  #closed = false;

  constructor(readonly threadId: string) {
    this.#task = this.#serve();
  }

  asSpawned(): SpawnedAppServer {
    return {
      readable: this.inbound.readable,
      writable: this.outbound.writable,
      processExit: new Promise(() => {
        // stays open until kill
      }),
      kill: () => {
        void this.close();
      },
    };
  }

  async #serve(): Promise<void> {
    let buffer = "";
    while (!this.#closed) {
      const { value, done } = await this.#reader.read();
      if (done) return;
      buffer += this.#decoder.decode(value, { stream: true });
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (!frame.id) continue;
        this.methods.push(frame.method);
        let result: unknown = {};
        if (frame.method === "thread/resume") {
          result = { thread: { id: this.threadId } };
        } else if (frame.method === "thread/read") {
          result = { thread: { id: this.threadId, activeTurn: null } };
        } else if (frame.method === "turn/start") {
          result = { turn: { id: `turn-${++this.#turn}` } };
        } else if (frame.method === "turn/steer") {
          result = { turn: { id: frame.params.turnId } };
        }
        await this.#writer.write(
          this.#encoder.encode(`${JSON.stringify({ id: frame.id, result })}\n`),
        );
        if (frame.method === "turn/start" || frame.method === "turn/steer") {
          const turnId = frame.method === "turn/start"
            ? (result as { turn: { id: string } }).turn.id
            : frame.params.turnId;
          queueMicrotask(() => {
            void this.#writer.write(
              this.#encoder.encode(
                `${JSON.stringify({
                  method: "turn/completed",
                  params: { turn: { id: turnId, status: "completed" } },
                })}\n`,
              ),
            );
          });
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.close().catch(() => {});
    await this.#task.catch(() => {});
  }
}

async function writeMail(
  root: string,
  projectPath: string,
  agent: string,
  id: number,
  subject: string,
): Promise<void> {
  const slug = slugForProject(projectPath);
  const inbox = `${root}/projects/${slug}/agents/${agent}/inbox/2026/07`;
  await Deno.mkdir(inbox, { recursive: true });
  const name = `2026-07-28T12-00-00Z__${subject}__${id}.md`;
  const body = `---json\n${
    JSON.stringify({ ack_required: false, importance: "normal" }, null, 2)
  }\n---\n\nbody\n`;
  await Deno.writeTextFile(`${inbox}/${name}`, body);
}

function configFor(statePath: string, projectPath: string, agent: string): IngressConfig {
  return {
    schemaVersion: 1,
    statePath,
    bindings: {
      demo: {
        agent,
        mailScope: { kind: "project", projectPath },
        codex: {
          adapter: "headless-app-server-owner",
          ownership: "explicit-handoff",
          threadId: "thread-prod-run",
          cwd: projectPath,
          transport: { kind: "private-stdio" },
        },
        delivery: {
          batchWindowMs: 50,
          maxEvents: 50,
          maxBytes: 32768,
          urgentDuringTurn: "steer",
          routineDuringTurn: "queue",
        },
      },
    },
  };
}

Deno.test("O3 follow-up: production run resumes thread and starts a turn via fake App Server", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "amc-prod-run-" });
  const projectPath = "/home/fixture/o3-prod-run";
  const agent = "CobaltJaguar";
  const mailboxRoot = `${tmp}/mailbox`;
  const statePath = `${tmp}/state.sqlite3`;
  const config = configFor(statePath, projectPath, agent);

  // Baseline empty, then deliver mail after ownership so cursor advances past baseline.
  await Deno.mkdir(`${mailboxRoot}/projects`, { recursive: true });

  const server = new FakeAppServer("thread-prod-run");
  const controller = new AbortController();

  const runPromise = runProductionIngress({
    config,
    bindingName: "demo",
    mailboxRoot,
    signal: controller.signal,
    spawnAppServer: () => server.asSpawned(),
    startupTimeoutMs: 5_000,
  });

  // Wait until initialize + thread/resume prove App Server ownership path.
  const deadline = Date.now() + 5_000;
  while (!server.methods.includes("thread/resume") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert(server.methods.includes("initialize"), `missing initialize; methods=${server.methods}`);
  assert(server.methods.includes("thread/resume"), `methods=${server.methods}`);
  assert(
    server.methods.indexOf("initialize") < server.methods.indexOf("thread/resume"),
    `initialize must precede resume; methods=${server.methods}`,
  );

  await writeMail(mailboxRoot, projectPath, agent, 42, "wake");

  while (!server.methods.includes("turn/start") && Date.now() < deadline + 5_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(
    server.methods.includes("turn/start"),
    `expected turn/start, methods=${JSON.stringify(server.methods)}`,
  );

  controller.abort();
  const result = await runPromise;
  assert(result.ok || result.reason === "shutdown", Deno.inspect(result));
  assert(
    !!result.startupReport && result.startupReport.owner === "exclusive-handoff",
    Deno.inspect(result.startupReport),
  );
  assert(result.acceptedBatchIds.length >= 1, Deno.inspect(result));

  const runtimePath = `${tmp}/runtime/demo.json`;
  const snapshot = JSON.parse(await Deno.readTextFile(runtimePath));
  assert(snapshot.threadId === "thread-prod-run", JSON.stringify(snapshot));
  assert(snapshot.owner === "headless", JSON.stringify(snapshot));
  if (Deno.build.os !== "windows") {
    const runtimeMode = (await Deno.stat(runtimePath)).mode! & 0o777;
    const threadMode = (
      await Deno.stat(`${tmp}/owner-state/demo.thread.json`)
    ).mode! & 0o777;
    assert(runtimeMode === 0o600, `runtime mode=${runtimeMode.toString(8)}`);
    assert(threadMode === 0o600, `thread mode=${threadMode.toString(8)}`);
  }

  await server.close();
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("O3 follow-up: deploy wrapper grants --allow-run for App Server spawn", async () => {
  const wrapper = await Deno.readTextFile(
    new URL("../deploy/agent-mail-codex-run.sh", import.meta.url),
  );
  assert(
    wrapper.includes("permissions") && wrapper.includes("allow-run"),
    "wrapper must compute scoped permissions including allow-run",
  );
  assert(!wrapper.includes("heartbeat-only"), "no heartbeat-only wording");
  assert(
    !wrapper.includes("  --allow-read \\\n") && !/\n\s*--allow-read\s*\n/.test(wrapper),
    "wrapper must not use bare --allow-read (tcp-efp.5.13)",
  );
});
