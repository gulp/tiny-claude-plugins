/**
 * F3: DurableStateStore contract — lease, transactional state, crash points.
 * Adapters (F4 in-memory, F5 SQLite) must implement this exact surface.
 */

import type { BatchId, BatchState, EventId, Importance } from "../schemas/mod.ts";

/** Named crash points F5/K2 must recover from without lost events. */
export const CRASH_POINTS = [
  "before_transact_commit",
  "after_batch_enqueue",
  "after_accept_before_cursor",
  "after_cursor_advance",
  "after_lease_renew",
  "after_dead_letter",
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

/** Online backup is mandatory before any destructive migration (F3/F5). */
export interface OnlineBackupRequirement {
  readonly requiredBeforeDestructiveMigration: true;
  /** Create a SQLite online backup; return the backup file path for operator logs. */
  createOnlineBackup(dbPath: string): Promise<string>;
}

export interface BindingRef {
  bindingId: string;
  agent: string;
  /** Hash of resolved binding config; mismatch is a loud operator error. */
  configHash: string;
  adapter: string;
  scopeJson: string;
  threadId: string | null;
}

export interface LeaseRecord {
  bindingId: string;
  ownerId: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface CursorRecord {
  bindingId: string;
  lastMessageId: number;
  /** Distinguishes first-ever startup from a durable baseline at message 0. */
  initialized: boolean;
  updatedAt: string;
}

export interface SourceEventRecord {
  bindingId: string;
  messageId: number;
  projectSlug: string;
  createdTs: string;
  subject: string;
  importance: Importance | null;
  ackRequired: boolean | null;
  sourcePathHash: string;
  observedAt: string;
}

export interface BatchRecord {
  batchId: BatchId;
  bindingId: string;
  firstMessageId: number;
  lastMessageId: number;
  eventIds: EventId[];
  payloadJson: string;
  urgency: "routine" | "urgent";
  state: BatchState;
  attemptCount: number;
  nextAttemptAt: string | null;
  acceptedTurnId: string | null;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Snapshot returned by load() / transact(). */
export interface DeliveryState {
  binding: BindingRef;
  lease: LeaseRecord | null;
  cursor: CursorRecord;
  /** Outbox ordered by firstMessageId. */
  batches: BatchRecord[];
  /** Recent source metadata retained for audit/replay (bounded by adapter). */
  sourceEvents: SourceEventRecord[];
}

/**
 * Atomic state mutations. Cursor may advance only with an accepted batch
 * in the same change (or via AcceptBatch). Never discard outbox to recover.
 */
export type StateChange =
  | { kind: "upsertBinding"; binding: BindingRef; at: string }
  | { kind: "setBaseline"; cursorMessageId: number; at: string }
  | { kind: "renewLease"; ownerId: string; expiresAt: string; heartbeatAt: string }
  | { kind: "releaseLease"; ownerId: string }
  | { kind: "observeSourceEvents"; events: SourceEventRecord[] }
  | { kind: "enqueueBatch"; batch: BatchRecord }
  | {
    kind: "transitionBatch";
    batchId: BatchId;
    from: BatchState;
    to: BatchState;
    at: string;
    attemptCount?: number;
    nextAttemptAt?: string | null;
    lastErrorCode?: string | null;
    lastErrorDetail?: string | null;
    /** Bind in-flight turn while delivering; clear on ambiguous replay. */
    acceptedTurnId?: string | null;
  }
  | {
    kind: "acceptBatch";
    batchId: BatchId;
    turnId: string;
    /** Source cursor advances to this id in the same transaction. */
    cursorMessageId: number;
    at: string;
  }
  | {
    kind: "deadLetter";
    batchId: BatchId;
    code: string;
    detail: string;
    at: string;
  };

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "lease_held"
      | "lease_lost"
      | "lease_mismatch"
      | "batch_missing"
      | "batch_state"
      | "config_hash_mismatch"
      | "invalid_change"
      | "closed",
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export interface BindingLease {
  load(): Promise<DeliveryState>;
  transact(change: StateChange): Promise<DeliveryState>;
  close(): Promise<void>;
}

/**
 * Opens a single-writer lease for one binding.
 * Two concurrent opens for the same binding must refuse with lease_held.
 */
export interface DurableStateStore {
  open(binding: BindingRef, ownerId: string): Promise<BindingLease>;
  close(): Promise<void>;
}

/** Documented invariants adapters must honor (contract suite asserts these). */
export const STORE_INVARIANTS = {
  walModeRequired: true,
  leaseRenewSeconds: 5,
  leaseTtlSeconds: 20,
  acceptAdvancesCursorAtomically: true,
  neverDiscardOutboxForGreenStartup: true,
  crashPoints: CRASH_POINTS,
} as const;

export { MemoryDurableStateStore } from "./memory.ts";
export type { MemoryStoreOptions } from "./memory.ts";
export { createSqliteOnlineBackup, SqliteDurableStateStore } from "./sqlite.ts";
export type { SqliteStoreOptions } from "./sqlite.ts";
export { runDurableStateStoreContract } from "./contract.ts";
export type { StoreFactory } from "./contract.ts";
