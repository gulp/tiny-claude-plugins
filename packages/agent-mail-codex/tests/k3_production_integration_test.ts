/// <reference lib="deno.window" />

import { PRODUCTION_RUNTIME, ProductionThreadOwnerAdapter } from "../src/kernel/production.ts";
import type { ThreadIdStore } from "../src/owner/thread_lifecycle.ts";
import type { ThreadBinding } from "../src/schemas/mod.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

class MemoryIds implements ThreadIdStore {
  constructor(readonly threadId: string) {}
  load(): Promise<string | null> {
    return Promise.resolve(this.threadId);
  }
  persistFirst(): Promise<void> {
    throw new Error("replacement thread must never be persisted");
  }
}

class AppServer {
  readonly inbound = new TransformStream<Uint8Array>();
  readonly outbound = new TransformStream<Uint8Array>();
  readonly methods: string[] = [];
  #reader = this.outbound.readable.getReader();
  #writer = this.inbound.writable.getWriter();
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #turn = 0;
  #task: Promise<void>;

  constructor(readonly threadId: string) {
    this.#task = this.#serve();
  }

  async #serve(): Promise<void> {
    let buffer = "";
    while (true) {
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
        let result: unknown;
        if (frame.method === "thread/resume") {
          result = { thread: { id: this.threadId } };
        } else if (frame.method === "thread/read") {
          result = { thread: { id: this.threadId, activeTurn: null } };
        } else if (frame.method === "turn/start") {
          result = { turn: { id: `turn-${++this.#turn}` } };
        } else if (frame.method === "turn/steer") {
          result = { turn: { id: frame.params.turnId } };
        } else {
          result = {};
        }
        await this.#writer.write(
          this.#encoder.encode(`${JSON.stringify({ id: frame.id, result })}\n`),
        );
      }
    }
  }

  async close(): Promise<void> {
    await this.#writer.close().catch(() => {});
    await this.#task.catch(() => {});
  }
}

const compatibility = {
  codexVersion: "0.144.6",
  capabilities: {
    protocolVersion: "2026-07-28",
    methods: [
      "initialize",
      "thread/start",
      "thread/resume",
      "turn/start",
      "turn/steer",
    ],
  },
  daemonVersion: "0.1.0-phase0",
  pluginVersion: "0.1.0-phase0",
  schemaVersion: 1,
};

function binding(threadId = "thread-k3"): ThreadBinding {
  return {
    schemaVersion: 1,
    bindingId: "binding-k3",
    agent: "BeigeHorizon",
    projectSlug: "tiny-claude-plugins",
    threadId,
    ownershipModel: "exclusive-handoff",
  };
}

Deno.test("K3 production owner proves exact binding and delivers/queues safely", async () => {
  const server = new AppServer("thread-k3");
  const owner = ProductionThreadOwnerAdapter.create({
    transport: {
      readable: server.inbound.readable,
      writable: server.outbound.writable,
    },
    store: new MemoryIds("thread-k3"),
    threadId: "thread-k3",
    compatibility,
    projectPath: "/tmp/project",
    now: () => "2026-07-29T00:00:00Z",
  });

  await owner.connect(binding());
  const proof = await owner.acquireOwnership();
  assertEquals(proof.subscriberCount, 1);
  assertEquals(proof.competingResponder, false);
  assertEquals(proof.threadId, "thread-k3");

  const first = await owner.startTurn(
    { schemaVersion: 1, text: "mail one", byteLength: 8 },
    "batch:one#stable",
  );
  const replay = await owner.startTurn(
    { schemaVersion: 1, text: "mail one", byteLength: 8 },
    "batch:one#stable",
  );
  assertEquals(replay, first);
  assertEquals((await owner.snapshot()).activeTurnId, "turn-1");

  await owner.steerTurn(
    "turn-1",
    { schemaVersion: 1, text: "urgent", byteLength: 6 },
    "batch:urgent#stable",
  );
  assertEquals(server.methods, ["thread/resume", "turn/start", "turn/steer"]);
  await owner.close();
  await server.close();
});

Deno.test("K3 restart resumes exact durable thread and mismatch is fatal", async () => {
  const server = new AppServer("thread-other");
  const owner = ProductionThreadOwnerAdapter.create({
    transport: {
      readable: server.inbound.readable,
      writable: server.outbound.writable,
    },
    store: new MemoryIds("thread-k3"),
    threadId: "thread-k3",
    compatibility,
    projectPath: "/tmp/project",
  });
  await owner.connect(binding());
  let failed = false;
  try {
    await owner.acquireOwnership();
  } catch (error) {
    failed = true;
    assert(error instanceof Error);
    assert(error.message.includes("expected thread-k3"));
  }
  assert(failed, "mismatched exact resume must fail");
  assertEquals(server.methods, ["thread/resume"]);
  await owner.close();
  await server.close();
});

Deno.test("K3 artifact reports one selected owner and no fallback", () => {
  assertEquals(PRODUCTION_RUNTIME.owner.name, "exclusive-handoff");
  assertEquals(PRODUCTION_RUNTIME.owner.transport, "private-stdio");
  assertEquals(PRODUCTION_RUNTIME.owner.fallback, null);
  assertEquals(PRODUCTION_RUNTIME.version, "0.1.0-phase0");
});
