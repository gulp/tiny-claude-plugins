/// <reference lib="deno.window" />

/**
 * O4: confirmed replay, rebind, cursor, and dead-letter commands.
 */

import {
  MemoryBindingRecoveryStore,
  RecoveryCommandError,
  RecoveryCommands,
} from "../src/operator/recovery_commands.ts";

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
  code: RecoveryCommandError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof RecoveryCommandError)) throw error;
    assertEquals(error.code, code);
  }
}

function seed() {
  const store = new MemoryBindingRecoveryStore();
  store.seed({
    bindingId: "amber",
    threadId: "thread-old",
    cursorMessageId: 40,
    pendingBatchIds: ["batch:pending"],
    deadLetters: [{
      batchId: "batch:dead",
      firstMessageId: 10,
      lastMessageId: 10,
      code: "delivery_failed",
      detail: "boom",
      retained: true,
    }],
    audit: [],
  });
  const cmds = new RecoveryCommands({
    store,
    now: () => "2026-07-29T04:00:00.000Z",
    nextId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `audit-${n}`;
      };
    })(),
  });
  return { store, cmds };
}

Deno.test("O4 mutations require confirm and show current→new state", async () => {
  const { cmds, store } = seed();
  const preview = await cmds.previewResetCursor("amber", 10);
  assertEquals(preview.requiresConfirm, true);
  assertEquals(preview.current, { cursorMessageId: 40 });
  assertEquals(preview.proposed, { cursorMessageId: 10 });
  await expectCode(cmds.confirmResetCursor("amber", 10, {}), "confirm_required");
  await expectCode(
    cmds.confirmResetCursor("amber", 10, { token: "wrong" }),
    "confirm_mismatch",
  );
  const applied = await cmds.confirmResetCursor("amber", 10, {
    token: preview.confirmToken,
  });
  assertEquals(applied.before, { cursorMessageId: 40 });
  assertEquals(applied.after, { cursorMessageId: 10 });
  assertEquals((await store.load("amber"))?.cursorMessageId, 10);
  assertEquals((await store.load("amber"))?.audit[0]?.op, "reset_cursor");
});

Deno.test("O4 rebind-thread persists exact new id with confirm", async () => {
  const { cmds, store } = seed();
  const preview = await cmds.previewRebindThread("amber", "thread-new");
  const result = await cmds.confirmRebindThread("amber", "thread-new", {
    explicit: true,
  });
  assertEquals(result.before, { threadId: "thread-old" });
  assertEquals(result.after, { threadId: "thread-new" });
  assertEquals((await store.load("amber"))?.threadId, "thread-new");
  assert(preview.confirmToken.includes("rebind_thread"), "token names op");
});

Deno.test("O4 dead-letter inspect/replay retains provenance and stable ids", async () => {
  const { cmds, store } = seed();
  const letters = await cmds.inspectDeadLetters("amber");
  assertEquals(letters.map((row) => row.batchId), ["batch:dead"]);
  assertEquals(letters[0]?.retained, true);

  await expectCode(
    cmds.confirmDeadLetterReplay("amber", "batch:missing", { explicit: true }),
    "not_dead_letter",
  );

  const preview = await cmds.previewDeadLetterReplay("amber", "batch:dead");
  assertEquals(preview.proposed.pendingBatchIds, ["batch:pending", "batch:dead"]);
  const result = await cmds.confirmDeadLetterReplay("amber", "batch:dead", {
    token: preview.confirmToken,
  });
  const next = await store.load("amber");
  assertEquals(next?.pendingBatchIds, ["batch:pending", "batch:dead"]);
  assertEquals(next?.deadLetters.map((row) => row.batchId), ["batch:dead"]);
  assertEquals(result.after.replayedBatchId, "batch:dead");
});

Deno.test("O4 replay keeps stable batch ids; broad reset forbidden", async () => {
  const { cmds } = seed();
  const preview = await cmds.previewReplayBatch("amber", "batch:pending");
  const result = await cmds.confirmReplayBatch("amber", "batch:pending", {
    explicit: true,
  });
  assertEquals(result.after.replayedBatchId, "batch:pending");
  assertEquals(
    preview.proposed.note,
    "stable batch id retained; at-least-once replay",
  );

  try {
    cmds.refuseBroadReset();
    throw new Error("expected refusal");
  } catch (error) {
    assert(error instanceof RecoveryCommandError, "typed");
    assertEquals(error.code, "no_broad_reset");
  }
});
