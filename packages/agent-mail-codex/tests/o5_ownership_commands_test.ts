/// <reference lib="deno.window" />

/**
 * O5: ownership release/acquire operator commands.
 */

import { ExclusiveHandoff } from "../src/owner/handoff.ts";
import {
  formatOwnershipResult,
  MemoryOwnerStateStore,
  OwnershipCommandError,
  OwnershipCommands,
} from "../src/operator/ownership_commands.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

Deno.test("O5 release-owner refuses unresolved turn/request and persists human", async () => {
  const store = new MemoryOwnerStateStore();
  const cmds = new OwnershipCommands({
    store,
    now: () => "2026-07-29T03:00:00.000Z",
  });
  await cmds.ensureHeadless("amber", "thread-exact");

  const live = ExclusiveHandoff.restore({
    ...(await cmds.status("amber")),
    activeTurnId: "turn-1",
  });
  await store.save({
    schemaVersion: 1,
    bindingId: "amber",
    ...live.snapshot(),
    updatedAt: "2026-07-29T03:00:00.000Z",
  });
  await expectCode(cmds.releaseOwnerToHuman("amber", "human"), "active_turn");

  await store.save({
    schemaVersion: 1,
    bindingId: "amber",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: ["approval-1"],
    pending: [{ id: "mail-1", sequence: 1 }],
    updatedAt: "2026-07-29T03:00:00.000Z",
  });
  await expectCode(cmds.releaseOwnerToHuman("amber", "human"), "unresolved_requests");

  await store.save({
    schemaVersion: 1,
    bindingId: "amber",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: [{ id: "mail-1", sequence: 1 }],
    updatedAt: "2026-07-29T03:00:00.000Z",
  });
  const released = await cmds.releaseOwnerToHuman("amber", "human");
  assertEquals(released.owner, "human");
  assertEquals(released.resumeCommand, "codex resume 'thread-exact'");
  assertEquals(released.pendingCount, 1);
  assertEquals((await cmds.status("amber")).owner, "human");
  assertEquals(await cmds.deliveryAllowed("amber"), false);
  assert(
    formatOwnershipResult(released).includes("resume=codex resume 'thread-exact'"),
    "human resume printed",
  );
});

Deno.test("O5 acquire-owner requires explicit exact-thread reacquire", async () => {
  const store = new MemoryOwnerStateStore();
  const cmds = new OwnershipCommands({
    store,
    now: () => "2026-07-29T03:00:00.000Z",
  });
  await cmds.ensureHeadless("amber", "thread-exact");
  await cmds.releaseOwnerToHuman("amber", "human");

  await expectCode(
    cmds.acquireOwnerHeadless("amber", "headless", "wrong-thread"),
    "thread_mismatch",
  );

  // Overlap: already headless.
  const headlessStore = new MemoryOwnerStateStore();
  const headlessCmds = new OwnershipCommands({ store: headlessStore });
  await headlessCmds.ensureHeadless("amber", "thread-exact");
  await expectCode(
    headlessCmds.acquireOwnerHeadless("amber", "headless", "thread-exact"),
    "overlap",
  );

  const acquired = await cmds.acquireOwnerHeadless("amber", "headless", "thread-exact");
  assertEquals(acquired.owner, "headless");
  assertEquals(acquired.threadId, "thread-exact");
  assertEquals(await cmds.deliveryAllowed("amber"), true);
});

Deno.test("O5 preserves queue across release and drains on acquire", async () => {
  const store = new MemoryOwnerStateStore();
  const cmds = new OwnershipCommands({
    store,
    now: () => "2026-07-29T03:00:00.000Z",
  });
  await store.save({
    schemaVersion: 1,
    bindingId: "amber",
    threadId: "thread-exact",
    owner: "headless",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: [
      { id: "later", sequence: 2 },
      { id: "first", sequence: 1 },
    ],
    updatedAt: "2026-07-29T03:00:00.000Z",
  });
  await cmds.releaseOwnerToHuman("amber", "human");
  assertEquals((await cmds.status("amber")).pending.map((item) => item.id), [
    "first",
    "later",
  ]);
  const acquired = await cmds.acquireOwnerHeadless("amber", "headless", "thread-exact");
  assertEquals(acquired.drainedPending.map((item) => item.id), ["first", "later"]);
});

Deno.test("O5 gateway mode is not applicable for v1", async () => {
  const cmds = new OwnershipCommands({
    store: new MemoryOwnerStateStore(),
    gatewaySelected: true,
  });
  await expectCode(cmds.ensureHeadless("amber", "thread-exact"), "gateway_not_applicable");
});

Deno.test("O5 disconnect never auto-transfers; missing binding fails loud", async () => {
  const store = new MemoryOwnerStateStore();
  const cmds = new OwnershipCommands({ store });
  await cmds.ensureHeadless("amber", "thread-exact");
  const handoff = ExclusiveHandoff.restore(await cmds.status("amber"));
  handoff.recordDisconnect();
  assertEquals(handoff.snapshot().owner, "headless");
  await expectCode(cmds.status("missing"), "not_found");
});
