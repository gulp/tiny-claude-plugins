/// <reference lib="deno.window" />

import { createProductionOwner, PRODUCTION_OWNER } from "../src/owner/production_owner.ts";
import type { ThreadIdStore } from "../src/owner/thread_lifecycle.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

class MemoryIds implements ThreadIdStore {
  load(): Promise<string | null> {
    return Promise.resolve("thread-production");
  }

  persistFirst(): Promise<void> {
    return Promise.resolve();
  }
}

function streams() {
  return {
    inbound: new TransformStream<Uint8Array>(),
    outbound: new TransformStream<Uint8Array>(),
  };
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

Deno.test("C8 names exactly one production owner with no fallback", () => {
  assertEquals(PRODUCTION_OWNER, {
    name: "exclusive-handoff",
    transport: "private-stdio",
    authority: "single-responder",
    fallback: null,
    selectedBy: "S5",
    implementationBead: "tcp-efp.4.6",
  });
  assertEquals(PRODUCTION_OWNER.fallback, null);
});

Deno.test("C8 composition packages C2/C3/C6 behind one factory", async () => {
  const io = streams();
  const owner = createProductionOwner({
    transport: {
      readable: io.inbound.readable,
      writable: io.outbound.writable,
    },
    store: new MemoryIds(),
    threadId: "thread-production",
    compatibility,
  });
  assertEquals(owner.descriptor.name, "exclusive-handoff");
  assert(owner.transport.healthy);
  assertEquals(owner.handoff.snapshot().owner, "headless");
  assert(owner.lifecycle);
  await owner.transport.close();
});

Deno.test("C8 refuses unpromoted protocol drift before creating owner", () => {
  const io = streams();
  try {
    createProductionOwner({
      transport: {
        readable: io.inbound.readable,
        writable: io.outbound.writable,
      },
      store: new MemoryIds(),
      threadId: "thread-production",
      compatibility: { ...compatibility, codexVersion: "0.145.0" },
    });
    throw new Error("expected drift refusal");
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("drift_probe"));
  }
});

Deno.test("C8 package exports no alternative owner constructors", async () => {
  const exports = await import("../src/owner/production_owner.ts");
  const names = Object.keys(exports).sort();
  assertEquals(names, ["PRODUCTION_OWNER", "createProductionOwner"]);
  assertEquals(names.some((name) => /gateway|native|exec|fallback/i.test(name)), false);
});
