/**
 * O4: confirmed operator mutations — replay, rebind, cursor reset, dead-letter.
 *
 * Every mutation returns a preview of current → new state. Destructive paths
 * require `confirm: true`. No broad reset, no outbox deletion, no identity guess.
 */

export type DeadLetterRecord = {
  batchId: string;
  firstMessageId: number;
  lastMessageId: number;
  code: string;
  detail: string;
  retained: true;
};

export type BindingRecoveryState = {
  bindingId: string;
  threadId: string;
  cursorMessageId: number;
  pendingBatchIds: string[];
  deadLetters: DeadLetterRecord[];
  /** Append-only audit trail retained for provenance. */
  audit: AuditRow[];
};

export type AuditRow = {
  id: string;
  at: string;
  op:
    | "preview"
    | "replay_batch"
    | "rebind_thread"
    | "reset_cursor"
    | "dead_letter_replay";
  bindingId: string;
  detail: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type MutationPreview<T extends string> = {
  op: T;
  bindingId: string;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  requiresConfirm: boolean;
  confirmToken: string;
};

export type MutationResult<T extends string> = {
  ok: true;
  op: T;
  bindingId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  auditId: string;
};

export class RecoveryCommandError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "confirm_required"
      | "confirm_mismatch"
      | "unknown_batch"
      | "not_dead_letter"
      | "invalid_cursor"
      | "thread_empty"
      | "no_broad_reset",
  ) {
    super(message);
    this.name = "RecoveryCommandError";
  }
}

export interface BindingRecoveryStore {
  load(bindingId: string): Promise<BindingRecoveryState | null>;
  save(state: BindingRecoveryState): Promise<void>;
}

export class MemoryBindingRecoveryStore implements BindingRecoveryStore {
  #rows = new Map<string, BindingRecoveryState>();

  seed(state: BindingRecoveryState): void {
    this.#rows.set(state.bindingId, structuredClone(state));
  }

  load(bindingId: string): Promise<BindingRecoveryState | null> {
    return Promise.resolve(this.#rows.get(bindingId) ?? null);
  }

  save(state: BindingRecoveryState): Promise<void> {
    this.#rows.set(state.bindingId, structuredClone(state));
    return Promise.resolve();
  }
}

export type RecoveryCommandsOptions = {
  store: BindingRecoveryStore;
  now?: () => string;
  /** Stable id factory for audit rows / confirm tokens. */
  nextId?: () => string;
};

export class RecoveryCommands {
  #store: BindingRecoveryStore;
  #now: () => string;
  #nextId: () => string;
  #seq = 0;

  constructor(options: RecoveryCommandsOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nextId = options.nextId ?? (() => {
      this.#seq += 1;
      return `audit-${this.#seq}`;
    });
  }

  async previewReplayBatch(
    bindingId: string,
    batchId: string,
  ): Promise<MutationPreview<"replay_batch">> {
    const state = await this.#require(bindingId);
    if (
      !state.pendingBatchIds.includes(batchId) &&
      !state.deadLetters.some((row) => row.batchId === batchId)
    ) {
      throw new RecoveryCommandError(
        `batch ${batchId} not found in pending or dead-letter outbox`,
        "unknown_batch",
      );
    }
    const current = {
      pendingBatchIds: state.pendingBatchIds,
      cursorMessageId: state.cursorMessageId,
    };
    const proposed = {
      pendingBatchIds: unique([...state.pendingBatchIds, batchId]),
      cursorMessageId: state.cursorMessageId,
      note: "stable batch id retained; at-least-once replay",
    };
    return this.#preview("replay_batch", bindingId, current, proposed, true);
  }

  async confirmReplayBatch(
    bindingId: string,
    batchId: string,
    confirm: { token?: string; explicit?: boolean },
  ): Promise<MutationResult<"replay_batch">> {
    const preview = await this.previewReplayBatch(bindingId, batchId);
    this.#requireConfirm(preview, confirm);
    const state = await this.#require(bindingId);
    const before = {
      pendingBatchIds: [...state.pendingBatchIds],
      cursorMessageId: state.cursorMessageId,
    };
    if (!state.pendingBatchIds.includes(batchId)) {
      state.pendingBatchIds = [...state.pendingBatchIds, batchId];
    }
    // Dead-letter rows stay retained (no deletion).
    return await this.#commit(state, "replay_batch", before, {
      pendingBatchIds: state.pendingBatchIds,
      cursorMessageId: state.cursorMessageId,
      replayedBatchId: batchId,
    });
  }

  async previewRebindThread(
    bindingId: string,
    newThreadId: string,
  ): Promise<MutationPreview<"rebind_thread">> {
    if (!newThreadId.trim()) {
      throw new RecoveryCommandError("thread id must be non-empty", "thread_empty");
    }
    const state = await this.#require(bindingId);
    return this.#preview(
      "rebind_thread",
      bindingId,
      { threadId: state.threadId },
      { threadId: newThreadId },
      true,
    );
  }

  async confirmRebindThread(
    bindingId: string,
    newThreadId: string,
    confirm: { token?: string; explicit?: boolean },
  ): Promise<MutationResult<"rebind_thread">> {
    const preview = await this.previewRebindThread(bindingId, newThreadId);
    this.#requireConfirm(preview, confirm);
    const state = await this.#require(bindingId);
    const before = { threadId: state.threadId };
    state.threadId = newThreadId;
    return await this.#commit(state, "rebind_thread", before, { threadId: newThreadId });
  }

  async previewResetCursor(
    bindingId: string,
    toMessageId: number,
  ): Promise<MutationPreview<"reset_cursor">> {
    if (!Number.isSafeInteger(toMessageId) || toMessageId < 0) {
      throw new RecoveryCommandError(
        `cursor target ${toMessageId} is invalid`,
        "invalid_cursor",
      );
    }
    const state = await this.#require(bindingId);
    return this.#preview(
      "reset_cursor",
      bindingId,
      { cursorMessageId: state.cursorMessageId },
      { cursorMessageId: toMessageId },
      true,
    );
  }

  async confirmResetCursor(
    bindingId: string,
    toMessageId: number,
    confirm: { token?: string; explicit?: boolean },
  ): Promise<MutationResult<"reset_cursor">> {
    const preview = await this.previewResetCursor(bindingId, toMessageId);
    this.#requireConfirm(preview, confirm);
    const state = await this.#require(bindingId);
    const before = { cursorMessageId: state.cursorMessageId };
    state.cursorMessageId = toMessageId;
    return await this.#commit(state, "reset_cursor", before, {
      cursorMessageId: toMessageId,
    });
  }

  async inspectDeadLetters(bindingId: string): Promise<DeadLetterRecord[]> {
    const state = await this.#require(bindingId);
    return [...state.deadLetters];
  }

  async previewDeadLetterReplay(
    bindingId: string,
    batchId: string,
  ): Promise<MutationPreview<"dead_letter_replay">> {
    const state = await this.#require(bindingId);
    const row = state.deadLetters.find((item) => item.batchId === batchId);
    if (!row) {
      throw new RecoveryCommandError(
        `dead-letter ${batchId} not found`,
        "not_dead_letter",
      );
    }
    return this.#preview(
      "dead_letter_replay",
      bindingId,
      {
        deadLetterBatchIds: state.deadLetters.map((item) => item.batchId),
        pendingBatchIds: state.pendingBatchIds,
      },
      {
        deadLetterBatchIds: state.deadLetters.map((item) => item.batchId),
        pendingBatchIds: unique([...state.pendingBatchIds, batchId]),
        note: "dead-letter row retained; pending gains stable batch id",
      },
      true,
    );
  }

  async confirmDeadLetterReplay(
    bindingId: string,
    batchId: string,
    confirm: { token?: string; explicit?: boolean },
  ): Promise<MutationResult<"dead_letter_replay">> {
    const preview = await this.previewDeadLetterReplay(bindingId, batchId);
    this.#requireConfirm(preview, confirm);
    const state = await this.#require(bindingId);
    const before = {
      deadLetterBatchIds: state.deadLetters.map((item) => item.batchId),
      pendingBatchIds: [...state.pendingBatchIds],
    };
    if (!state.pendingBatchIds.includes(batchId)) {
      state.pendingBatchIds = [...state.pendingBatchIds, batchId];
    }
    // Intentionally do not remove the dead-letter row.
    return await this.#commit(state, "dead_letter_replay", before, {
      deadLetterBatchIds: state.deadLetters.map((item) => item.batchId),
      pendingBatchIds: state.pendingBatchIds,
      replayedBatchId: batchId,
    });
  }

  /** Broad wipe is forbidden — operator must name a target. */
  refuseBroadReset(): never {
    throw new RecoveryCommandError(
      "broad reset is forbidden; use reset-cursor --to <id> --confirm or named rebind/replay",
      "no_broad_reset",
    );
  }

  async #require(bindingId: string): Promise<BindingRecoveryState> {
    const state = await this.#store.load(bindingId);
    if (!state) {
      throw new RecoveryCommandError(
        `binding ${bindingId} not found`,
        "not_found",
      );
    }
    return structuredClone(state);
  }

  #preview<T extends string>(
    op: T,
    bindingId: string,
    current: Record<string, unknown>,
    proposed: Record<string, unknown>,
    requiresConfirm: boolean,
  ): MutationPreview<T> {
    const confirmToken = `${op}:${bindingId}:${stableHash(current)}:${stableHash(proposed)}`;
    return { op, bindingId, current, proposed, requiresConfirm, confirmToken };
  }

  #requireConfirm(
    preview: MutationPreview<string>,
    confirm: { token?: string; explicit?: boolean },
  ): void {
    if (confirm.token === preview.confirmToken) return;
    if (confirm.explicit === true) return;
    throw new RecoveryCommandError(
      `${preview.op} requires --confirm (preview token ${preview.confirmToken})`,
      confirm.token ? "confirm_mismatch" : "confirm_required",
    );
  }

  async #commit<T extends string>(
    state: BindingRecoveryState,
    op: T,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<MutationResult<T>> {
    const auditId = this.#nextId();
    state.audit.push({
      id: auditId,
      at: this.#now(),
      op: op as AuditRow["op"],
      bindingId: state.bindingId,
      detail: `${op} applied`,
      before,
      after,
    });
    await this.#store.save(state);
    return {
      ok: true,
      op,
      bindingId: state.bindingId,
      before,
      after,
      auditId,
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stableHash(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
