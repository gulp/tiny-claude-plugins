/// <reference lib="deno.window" />

import {
  InProcessLiveOwnershipAuthority,
  LiveOwnershipCommands,
  type LiveOwnerSnapshot,
} from "../src/operator/live_ownership.ts";
import {
  MemoryOwnerStateStore,
  OwnershipCommandError,
} from "../src/operator/ownership_commands.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: OwnershipCommandError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof OwnershipCommandError)) throw error;
    assertEquals(error.code, code);
  }
}

function fixture(
  overrides: Partial<LiveOwnerSnapshot> = {},
) {
  let state: LiveOwnerSnapshot = {
    bindingId: "demo",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: [{ id: "mail-2", sequence: 2 }, { id: "mail-1", sequence: 1 }],
    connection: "open",
    soleOwnershipProven: true,
    revision: 1,
    ...overrides,
  };
  let releases = 0;
  let acquires = 0;
  const authority = new InProcessLiveOwnershipAuthority({
    snapshot: () => Promise.resolve(structuredClone(state)),
    releaseOwnership: () => {
      releases++;
      state = {
        ...state,
        owner: "human",
        soleOwnershipProven: false,
        revision: state.revision + 1,
      };
      return Promise.resolve();
    },
    closeConnection: () => {
      state = { ...state, connection: "closed" };
      return Promise.resolve();
    },
    acquireOwnership: (threadId) => {
      acquires++;
      if (threadId !== state.threadId) throw new Error("wrong thread");
      state = {
        ...state,
        owner: "headless",
        connection: "open",
        soleOwnershipProven: true,
        revision: state.revision + 1,
      };
      return Promise.resolve();
    },
  });
  return {
    authority,
    state: () => state,
    calls: () => ({ releases, acquires }),
  };
}

Deno.test("O5 live release proves drain and connection close before persistence", async () => {
  const live = fixture();
  const store = new MemoryOwnerStateStore();
  const commands = new LiveOwnershipCommands({ client: live.authority, store });
  const result = await commands.releaseOwnerToHuman("demo", "release-1");
  assertEquals(result.owner, "human");
  assertEquals(result.resumeCommand, "codex resume 'thread-exact'");
  assertEquals(live.state().connection, "closed");
  assertEquals((await store.load("demo"))?.owner, "human");
  assertEquals(live.calls().releases, 1);
});

Deno.test("O5 live release refuses active turn and unresolved requests", async () => {
  const active = fixture({ activeTurnId: "turn-1" });
  await expectCode(
    new LiveOwnershipCommands({
      client: active.authority,
      store: new MemoryOwnerStateStore(),
    }).releaseOwnerToHuman("demo", "release-active"),
    "active_turn",
  );
  const requested = fixture({ unresolvedRequestIds: ["approval-1"] });
  await expectCode(
    new LiveOwnershipCommands({
      client: requested.authority,
      store: new MemoryOwnerStateStore(),
    }).releaseOwnerToHuman("demo", "release-request"),
    "unresolved_requests",
  );
  assertEquals(active.calls().releases, 0);
  assertEquals(requested.calls().releases, 0);
});

Deno.test("O5 live acquire requires exact thread and sole-owner proof", async () => {
  const live = fixture({
    owner: "human",
    connection: "closed",
    soleOwnershipProven: false,
    revision: 2,
  });
  const commands = new LiveOwnershipCommands({
    client: live.authority,
    store: new MemoryOwnerStateStore(),
  });
  await expectCode(
    commands.acquireOwnerHeadless("demo", "acquire-wrong", "wrong"),
    "thread_mismatch",
  );
  const result = await commands.acquireOwnerHeadless(
    "demo",
    "acquire-1",
    "thread-exact",
  );
  assertEquals(result.owner, "headless");
  assertEquals(result.drainedPending.map((item) => item.id), [
    "mail-1",
    "mail-2",
  ]);
  assertEquals(live.state().soleOwnershipProven, true);
});

Deno.test("O5 live commands are idempotent and reject request-ID races", async () => {
  const live = fixture();
  const first = await live.authority.release("demo", "same", 1);
  const retry = await live.authority.release("demo", "same", 1);
  assertEquals(retry, first);
  assertEquals(live.calls().releases, 1);
  await expectCode(
    live.authority.acquire("demo", "same", "thread-exact", 2),
    "daemon_race",
  );
});

Deno.test("O5 daemon absence and revision race fail loud without state success", async () => {
  const store = new MemoryOwnerStateStore();
  const absent = new LiveOwnershipCommands({
    client: {
      snapshot: () => Promise.reject(new Error("socket missing")),
      release: () => Promise.reject(new Error("unreachable")),
      acquire: () => Promise.reject(new Error("unreachable")),
    },
    store,
  });
  await expectCode(
    absent.releaseOwnerToHuman("demo", "release-absent"),
    "daemon_absent",
  );
  assertEquals(await store.load("demo"), null);

  const live = fixture();
  const snapshot = await live.authority.snapshot("demo");
  await expectCode(
    live.authority.release("demo", "stale", snapshot.revision + 1),
    "daemon_race",
  );
  assertEquals(live.calls().releases, 0);
});

Deno.test("O5 release fails if daemon cannot prove connection closed", async () => {
  let state: LiveOwnerSnapshot = {
    bindingId: "demo",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: [],
    connection: "open",
    soleOwnershipProven: true,
    revision: 1,
  };
  const authority = new InProcessLiveOwnershipAuthority({
    snapshot: () => Promise.resolve(state),
    releaseOwnership: () => {
      state = { ...state, owner: "human", revision: 2 };
      return Promise.resolve();
    },
    closeConnection: () => Promise.resolve(),
    acquireOwnership: () => Promise.resolve(),
  });
  await expectCode(authority.release("demo", "release-open", 1), "connection_open");
});
