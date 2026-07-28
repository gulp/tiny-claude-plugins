/// <reference lib="deno.window" />

import {
  reconcileRecovery,
  type RecoveryBatch,
  RecoveryError,
  type RecoveryState,
} from "../src/kernel/recovery.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function batch(
  batchId: string,
  firstMessageId: number,
  state: RecoveryBatch["state"],
  acceptedTurnId: string | null = null,
): RecoveryBatch {
  return {
    batchId,
    firstMessageId,
    lastMessageId: firstMessageId,
    state,
    acceptedTurnId,
  };
}

function state(
  cursor: number,
  batches: RecoveryBatch[],
  sourceIds: number[] = [],
): RecoveryState {
  return {
    cursor: { lastMessageId: cursor },
    batches,
    sourceEvents: sourceIds.map((messageId) => ({ messageId })),
  };
}

function expectCode(input: RecoveryState, code: RecoveryError["code"]): void {
  try {
    reconcileRecovery(input);
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof RecoveryError)) throw error;
    assertEquals(error.code, code);
  }
}

Deno.test("K2 crash states retain zero-loss replay work", () => {
  const beforeEnqueue = reconcileRecovery(state(0, [], [10]));
  assertEquals(beforeEnqueue.actions, [{ kind: "rebatch", messageIds: [10] }]);

  const afterEnqueue = reconcileRecovery(state(0, [batch("batch:10", 10, "pending")], [10]));
  assertEquals(afterEnqueue.actions, [{
    kind: "deliver",
    batchId: "batch:10",
    stableReplay: false,
  }]);

  const duringDelivery = reconcileRecovery(
    state(0, [batch("batch:10", 10, "delivering")], [10]),
  );
  assertEquals(duringDelivery.actions, [{
    kind: "replayAmbiguous",
    batchId: "batch:10",
    stableReplay: true,
  }]);

  const afterAtomicAccept = reconcileRecovery(
    state(10, [batch("batch:10", 10, "accepted", "turn-10")], [10]),
  );
  assertEquals(afterAtomicAccept.actions, []);
  assertEquals(afterAtomicAccept.cursor, 10);
});

Deno.test("K2 ambiguous replay preserves the stable batch ID", () => {
  const plan = reconcileRecovery(state(0, [
    batch("batch:binding:20-20", 20, "delivering"),
  ]));
  assertEquals(plan.actions[0], {
    kind: "replayAmbiguous",
    batchId: "batch:binding:20-20",
    stableReplay: true,
  });
});

Deno.test("K2 acceptance and cursor corruption fail closed", () => {
  expectCode(
    state(0, [batch("batch:10", 10, "accepted", "turn-10")]),
    "acceptance_without_cursor",
  );
  expectCode(
    state(10, [batch("batch:9", 9, "accepted", "turn-9")]),
    "cursor_without_acceptance",
  );
  expectCode(
    state(10, [batch("batch:10", 10, "accepted", null)]),
    "acceptance_without_cursor",
  );
});

Deno.test("K2 poison dead letter is retained while later events proceed", () => {
  const plan = reconcileRecovery(state(12, [
    batch("batch:poison:11", 11, "dead_letter"),
    batch("batch:later:12", 12, "accepted", "turn-12"),
    batch("batch:next:13", 13, "pending"),
  ], [11, 12, 13, 14]));
  assertEquals(plan.retainedDeadLetters, ["batch:poison:11"]);
  assertEquals(plan.actions, [
    { kind: "deliver", batchId: "batch:next:13", stableReplay: false },
    { kind: "rebatch", messageIds: [14] },
  ]);
});

Deno.test("K2 never drops accepted or dead-letter outbox records to heal", () => {
  const input = state(2, [
    batch("batch:accepted", 2, "accepted", "turn-2"),
    batch("batch:dead", 3, "dead_letter"),
    batch("batch:retry", 4, "delivering"),
  ]);
  const before = JSON.stringify(input);
  const plan = reconcileRecovery(input);
  assertEquals(JSON.stringify(input), before);
  assertEquals(plan.retainedDeadLetters, ["batch:dead"]);
  assertEquals(plan.actions, [{
    kind: "replayAmbiguous",
    batchId: "batch:retry",
    stableReplay: true,
  }]);
});
