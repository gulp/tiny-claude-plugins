/// <reference lib="deno.window" />

import {
  ExactThreadLifecycle,
  type LifecycleTransport,
  type ThreadIdStore,
  ThreadLifecycleError,
} from "../src/owner/thread_lifecycle.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: ThreadLifecycleError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof ThreadLifecycleError)) throw error;
    assertEquals(error.code, code);
  }
}

class MemoryThreadStore implements ThreadIdStore {
  value: string | null;
  persists: string[] = [];

  constructor(value: string | null = null) {
    this.value = value;
  }

  load(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  persistFirst(_bindingId: string, threadId: string): Promise<void> {
    if (this.value !== null) throw new Error("binding already persisted");
    this.value = threadId;
    this.persists.push(threadId);
    return Promise.resolve();
  }
}

class ScriptedTransport implements LifecycleTransport {
  healthy = true;
  calls: Array<{ method: string; params: unknown }> = [];
  responses: unknown[] = [];

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses.shift();
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }
}

const BINDING = {
  bindingId: "binding-c3",
  projectPath: "/work/project",
};

Deno.test("C3 first creation starts explicitly and persists before proof", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ thread: { id: "thread-first" } });
  const store = new MemoryThreadStore();
  const lifecycle = new ExactThreadLifecycle(
    transport,
    store,
    () => "2026-07-29T01:00:00.000Z",
  );
  const proof = await lifecycle.acquire(BINDING);
  assertEquals(store.persists, ["thread-first"]);
  assertEquals(proof, {
    schemaVersion: 1,
    mode: "exclusive-handoff",
    owner: "headless",
    bindingId: "binding-c3",
    threadId: "thread-first",
    subscriberCount: 1,
    competingResponder: false,
    provenAt: "2026-07-29T01:00:00.000Z",
  });
  assertEquals(transport.calls[0], {
    method: "thread/start",
    params: {
      cwd: "/work/project",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      ephemeral: false,
    },
  });
});

Deno.test("C3 resumes only the stored exact thread", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ thread: { id: "thread-stored" } });
  const store = new MemoryThreadStore("thread-stored");
  const lifecycle = new ExactThreadLifecycle(transport, store);
  await lifecycle.acquire({ ...BINDING, expectedThreadId: "thread-stored" });
  assertEquals(transport.calls, [{
    method: "thread/resume",
    params: { threadId: "thread-stored" },
  }]);
  assertEquals(store.persists, []);
});

Deno.test("C3 missing or mismatched resume never starts a replacement", async () => {
  const mismatchTransport = new ScriptedTransport();
  mismatchTransport.responses.push({ thread: { id: "wrong" } });
  const mismatch = new ExactThreadLifecycle(
    mismatchTransport,
    new MemoryThreadStore("stored"),
  );
  await expectCode(mismatch.acquire(BINDING), "binding_mismatch");
  assertEquals(mismatchTransport.calls.map((call) => call.method), ["thread/resume"]);

  const missingTransport = new ScriptedTransport();
  missingTransport.responses.push(new Error("not found"));
  const missing = new ExactThreadLifecycle(
    missingTransport,
    new MemoryThreadStore("gone"),
  );
  await expectCode(missing.acquire(BINDING), "missing_thread");
  assertEquals(missingTransport.calls.map((call) => call.method), ["thread/resume"]);

  const unbound = new ExactThreadLifecycle(
    new ScriptedTransport(),
    new MemoryThreadStore(),
  );
  await expectCode(
    unbound.acquire({ ...BINDING, expectedThreadId: "expected-but-unbound" }),
    "missing_thread",
  );
});

Deno.test("C3 snapshot verifies exact thread and active turn", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push(
    { thread: { id: "thread-stored" } },
    { thread: { id: "thread-stored", activeTurn: { id: "turn-1" } } },
  );
  const lifecycle = new ExactThreadLifecycle(
    transport,
    new MemoryThreadStore("thread-stored"),
  );
  await lifecycle.acquire(BINDING);
  assertEquals(await lifecycle.snapshot(), {
    schemaVersion: 1,
    threadId: "thread-stored",
    activeTurnId: "turn-1",
    idle: false,
    owner: "headless",
  });
});

Deno.test("C3 private owner exposes no attachable transport", () => {
  const lifecycle = new ExactThreadLifecycle(
    new ScriptedTransport(),
    new MemoryThreadStore(),
  );
  try {
    lifecycle.attachableTransport;
    throw new Error("expected private transport refusal");
  } catch (error) {
    if (!(error instanceof ThreadLifecycleError)) throw error;
    assertEquals(error.code, "not_acquired");
  }
});
