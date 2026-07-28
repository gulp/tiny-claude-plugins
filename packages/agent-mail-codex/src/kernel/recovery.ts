/** K2: pure startup reconciliation for the durable cursor/outbox state. */

export type RecoveryBatchState =
  | "pending"
  | "delivering"
  | "accepted"
  | "dead_letter";

export interface RecoveryBatch {
  batchId: string;
  firstMessageId: number;
  lastMessageId: number;
  state: RecoveryBatchState;
  acceptedTurnId: string | null;
}

export interface RecoverySourceEvent {
  messageId: number;
}

export interface RecoveryState {
  cursor: { lastMessageId: number };
  batches: RecoveryBatch[];
  sourceEvents: RecoverySourceEvent[];
}

export type RecoveryAction =
  | { kind: "deliver"; batchId: string; stableReplay: false }
  | { kind: "replayAmbiguous"; batchId: string; stableReplay: true }
  | { kind: "rebatch"; messageIds: number[] };

export interface RecoveryPlan {
  cursor: number;
  actions: RecoveryAction[];
  retainedDeadLetters: string[];
}

export class RecoveryError extends Error {
  constructor(
    message: string,
    readonly code:
      | "cursor_without_acceptance"
      | "acceptance_without_cursor"
      | "invalid_batch"
      | "duplicate_batch_id",
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

/**
 * Produces a replay plan without mutating durable state.
 * Outbox rows, including accepted and dead-letter rows, are never discarded.
 */
export function reconcileRecovery(state: RecoveryState): RecoveryPlan {
  const sorted = [...state.batches].sort((left, right) =>
    left.firstMessageId - right.firstMessageId ||
    left.lastMessageId - right.lastMessageId ||
    left.batchId.localeCompare(right.batchId)
  );
  const ids = new Set<string>();
  let maxAcceptedCursor = 0;
  const covered = new Set<number>();
  const actions: RecoveryAction[] = [];
  const retainedDeadLetters: string[] = [];

  for (const batch of sorted) {
    validateBatch(batch);
    if (ids.has(batch.batchId)) {
      throw new RecoveryError(`duplicate batch ID ${batch.batchId}`, "duplicate_batch_id");
    }
    ids.add(batch.batchId);
    for (let messageId = batch.firstMessageId; messageId <= batch.lastMessageId; messageId++) {
      covered.add(messageId);
    }
    switch (batch.state) {
      case "accepted":
        if (!batch.acceptedTurnId) {
          throw new RecoveryError(
            `accepted batch ${batch.batchId} has no turn`,
            "acceptance_without_cursor",
          );
        }
        maxAcceptedCursor = Math.max(maxAcceptedCursor, batch.lastMessageId);
        break;
      case "pending":
        actions.push({ kind: "deliver", batchId: batch.batchId, stableReplay: false });
        break;
      case "delivering":
        actions.push({ kind: "replayAmbiguous", batchId: batch.batchId, stableReplay: true });
        break;
      case "dead_letter":
        retainedDeadLetters.push(batch.batchId);
        break;
    }
  }

  if (maxAcceptedCursor > state.cursor.lastMessageId) {
    throw new RecoveryError(
      `accepted through ${maxAcceptedCursor} but cursor is ${state.cursor.lastMessageId}`,
      "acceptance_without_cursor",
    );
  }
  if (state.cursor.lastMessageId > 0 && maxAcceptedCursor < state.cursor.lastMessageId) {
    throw new RecoveryError(
      `cursor ${state.cursor.lastMessageId} has no recorded acceptance`,
      "cursor_without_acceptance",
    );
  }

  const unbatched = [...new Set(state.sourceEvents.map((event) => event.messageId))]
    .filter((messageId) => messageId > state.cursor.lastMessageId && !covered.has(messageId))
    .sort((left, right) => left - right);
  if (unbatched.length > 0) actions.push({ kind: "rebatch", messageIds: unbatched });

  return {
    cursor: state.cursor.lastMessageId,
    actions,
    retainedDeadLetters,
  };
}

function validateBatch(batch: RecoveryBatch): void {
  if (
    !batch.batchId ||
    !Number.isSafeInteger(batch.firstMessageId) ||
    !Number.isSafeInteger(batch.lastMessageId) ||
    batch.firstMessageId <= 0 ||
    batch.lastMessageId < batch.firstMessageId
  ) {
    throw new RecoveryError(`invalid batch ${batch.batchId}`, "invalid_batch");
  }
}
