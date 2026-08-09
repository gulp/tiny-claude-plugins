/**
 * F4: deterministic in-memory DurableStateStore.
 * Same contract as production SQLite (F5); optional crash-arm for recovery tests.
 */

import {
  type BatchRecord,
  type BindingLease,
  type BindingRef,
  type CrashPoint,
  type CursorRecord,
  type DeliveryState,
  type DurableStateStore,
  type LeaseRecord,
  type SourceEventRecord,
  type StateChange,
  STORE_INVARIANTS,
  StoreError,
} from "./mod.ts";

export interface MemoryStoreOptions {
  /** Fake clock — ISO-8601 strings. */
  now?: () => string;
  /**
   * When set, the next matching crash point during transact throws and
   * discards the in-flight change (previous committed state preserved).
   */
  armCrash?: CrashPoint | null;
}

interface BindingBucket {
  binding: BindingRef;
  lease: LeaseRecord | null;
  cursor: CursorRecord;
  batches: Map<string, BatchRecord>;
  sourceEvents: Map<number, SourceEventRecord>;
  /** Active lease handle owner (process-side); null when closed. */
  openOwnerId: string | null;
}

function cloneState(bucket: BindingBucket): DeliveryState {
  return {
    binding: { ...bucket.binding },
    lease: bucket.lease ? { ...bucket.lease } : null,
    cursor: { ...bucket.cursor },
    batches: [...bucket.batches.values()]
      .map((b) => ({ ...b, eventIds: [...b.eventIds] }))
      .sort((a, b) => a.firstMessageId - b.firstMessageId),
    sourceEvents: [...bucket.sourceEvents.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => a.messageId - b.messageId),
  };
}

function leaseExpired(lease: LeaseRecord, now: string): boolean {
  return now > lease.expiresAt;
}

export class MemoryDurableStateStore implements DurableStateStore {
  private readonly buckets = new Map<string, BindingBucket>();
  private closed = false;
  private readonly nowFn: () => string;
  armCrash: CrashPoint | null;

  constructor(options: MemoryStoreOptions = {}) {
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.armCrash = options.armCrash ?? null;
  }

  private now(): string {
    return this.nowFn();
  }

  private ensureOpen(): void {
    if (this.closed) throw new StoreError("store is closed", "closed");
  }

  private maybeCrash(point: CrashPoint): void {
    if (this.armCrash === point) {
      this.armCrash = null;
      throw new StoreError(`simulated crash at ${point}`, "invalid_change");
    }
  }

  async open(binding: BindingRef, ownerId: string): Promise<BindingLease> {
    this.ensureOpen();
    const now = this.now();
    let bucket = this.buckets.get(binding.bindingId);

    if (!bucket) {
      bucket = {
        binding: { ...binding },
        lease: null,
        cursor: {
          bindingId: binding.bindingId,
          lastMessageId: 0,
          initialized: false,
          updatedAt: now,
        },
        batches: new Map(),
        sourceEvents: new Map(),
        openOwnerId: null,
      };
      this.buckets.set(binding.bindingId, bucket);
    } else if (bucket.binding.configHash !== binding.configHash) {
      throw new StoreError(
        `config hash mismatch for ${binding.bindingId}`,
        "config_hash_mismatch",
      );
    } else {
      bucket.binding = { ...binding };
    }

    if (bucket.openOwnerId !== null && bucket.openOwnerId !== ownerId) {
      throw new StoreError(
        `binding ${binding.bindingId} already open by ${bucket.openOwnerId}`,
        "lease_held",
      );
    }

    if (
      bucket.lease &&
      bucket.lease.ownerId !== ownerId &&
      !leaseExpired(bucket.lease, now)
    ) {
      throw new StoreError(
        `lease held by ${bucket.lease.ownerId} until ${bucket.lease.expiresAt}`,
        "lease_held",
      );
    }

    const expiresAt = new Date(
      Date.parse(now) + STORE_INVARIANTS.leaseTtlSeconds * 1000,
    ).toISOString();
    bucket.lease = {
      bindingId: binding.bindingId,
      ownerId,
      expiresAt,
      heartbeatAt: now,
    };
    bucket.openOwnerId = ownerId;

    return new MemoryBindingLease(this, binding.bindingId, ownerId);
  }

  /** @internal */
  _load(bindingId: string, ownerId: string): DeliveryState {
    this.ensureOpen();
    const bucket = this.requireBucket(bindingId);
    this.requireLiveLease(bucket, ownerId);
    return cloneState(bucket);
  }

  /** @internal */
  _transact(bindingId: string, ownerId: string, change: StateChange): DeliveryState {
    this.ensureOpen();
    const bucket = this.requireBucket(bindingId);
    this.requireLiveLease(bucket, ownerId);

    // Work on a deep clone; commit only if no crash.
    const draft: BindingBucket = {
      binding: { ...bucket.binding },
      lease: bucket.lease ? { ...bucket.lease } : null,
      cursor: { ...bucket.cursor },
      batches: new Map(
        [...bucket.batches.entries()].map(([k, v]) => [k, { ...v, eventIds: [...v.eventIds] }]),
      ),
      sourceEvents: new Map(
        [...bucket.sourceEvents.entries()].map(([k, v]) => [k, { ...v }]),
      ),
      openOwnerId: bucket.openOwnerId,
    };

    try {
      this.applyChange(draft, change);
      this.maybeCrash("before_transact_commit");
    } catch (error) {
      // Discard draft — committed bucket unchanged.
      throw error;
    }

    // Commit
    bucket.binding = draft.binding;
    bucket.lease = draft.lease;
    bucket.cursor = draft.cursor;
    bucket.batches = draft.batches;
    bucket.sourceEvents = draft.sourceEvents;
    return cloneState(bucket);
  }

  /** @internal */
  _closeLease(bindingId: string, ownerId: string): void {
    const bucket = this.buckets.get(bindingId);
    if (!bucket) return;
    if (bucket.openOwnerId === ownerId) bucket.openOwnerId = null;
    if (bucket.lease?.ownerId === ownerId) bucket.lease = null;
  }

  private requireBucket(bindingId: string): BindingBucket {
    const bucket = this.buckets.get(bindingId);
    if (!bucket) {
      throw new StoreError(`unknown binding ${bindingId}`, "invalid_change");
    }
    return bucket;
  }

  private requireLiveLease(bucket: BindingBucket, ownerId: string): void {
    const now = this.now();
    if (!bucket.lease) {
      throw new StoreError("lease lost", "lease_lost");
    }
    if (bucket.lease.ownerId !== ownerId) {
      throw new StoreError("lease owner mismatch", "lease_mismatch");
    }
    if (leaseExpired(bucket.lease, now)) {
      bucket.lease = null;
      bucket.openOwnerId = null;
      throw new StoreError("lease expired", "lease_lost");
    }
  }

  private applyChange(draft: BindingBucket, change: StateChange): void {
    switch (change.kind) {
      case "upsertBinding": {
        if (
          draft.binding.configHash !== change.binding.configHash &&
          draft.binding.bindingId === change.binding.bindingId
        ) {
          // Allow upsert only when hashes match or first write already set in open().
          if (draft.batches.size > 0 || draft.cursor.lastMessageId > 0) {
            throw new StoreError("config hash mismatch", "config_hash_mismatch");
          }
        }
        draft.binding = { ...change.binding };
        return;
      }
      case "setBaseline": {
        if (
          draft.cursor.initialized ||
          draft.batches.size > 0 ||
          draft.sourceEvents.size > 0 ||
          !Number.isSafeInteger(change.cursorMessageId) ||
          change.cursorMessageId < 0
        ) {
          throw new StoreError("baseline can only initialize empty state", "invalid_change");
        }
        draft.cursor = {
          bindingId: draft.binding.bindingId,
          lastMessageId: change.cursorMessageId,
          initialized: true,
          updatedAt: change.at,
        };
        return;
      }
      case "renewLease": {
        if (!draft.lease || draft.lease.ownerId !== change.ownerId) {
          throw new StoreError("cannot renew foreign/missing lease", "lease_mismatch");
        }
        draft.lease = {
          bindingId: draft.binding.bindingId,
          ownerId: change.ownerId,
          expiresAt: change.expiresAt,
          heartbeatAt: change.heartbeatAt,
        };
        this.maybeCrash("after_lease_renew");
        return;
      }
      case "releaseLease": {
        if (draft.lease && draft.lease.ownerId !== change.ownerId) {
          throw new StoreError("cannot release foreign lease", "lease_mismatch");
        }
        draft.lease = null;
        return;
      }
      case "observeSourceEvents": {
        for (const event of change.events) {
          if (event.bindingId !== draft.binding.bindingId) {
            throw new StoreError("source event binding mismatch", "invalid_change");
          }
          draft.sourceEvents.set(event.messageId, { ...event });
        }
        return;
      }
      case "enqueueBatch": {
        if (change.batch.bindingId !== draft.binding.bindingId) {
          throw new StoreError("batch binding mismatch", "invalid_change");
        }
        if (draft.batches.has(change.batch.batchId)) {
          throw new StoreError(`duplicate batch ${change.batch.batchId}`, "invalid_change");
        }
        draft.batches.set(change.batch.batchId, {
          ...change.batch,
          eventIds: [...change.batch.eventIds],
        });
        this.maybeCrash("after_batch_enqueue");
        return;
      }
      case "transitionBatch": {
        const batch = draft.batches.get(change.batchId);
        if (!batch) throw new StoreError(`batch missing ${change.batchId}`, "batch_missing");
        if (batch.state !== change.from) {
          throw new StoreError(
            `batch ${change.batchId} state ${batch.state} != ${change.from}`,
            "batch_state",
          );
        }
        batch.state = change.to;
        batch.updatedAt = change.at;
        if (change.attemptCount !== undefined) batch.attemptCount = change.attemptCount;
        if (change.nextAttemptAt !== undefined) batch.nextAttemptAt = change.nextAttemptAt;
        if (change.lastErrorCode !== undefined) batch.lastErrorCode = change.lastErrorCode;
        if (change.lastErrorDetail !== undefined) {
          batch.lastErrorDetail = change.lastErrorDetail;
        }
        if (change.acceptedTurnId !== undefined) {
          batch.acceptedTurnId = change.acceptedTurnId;
        }
        return;
      }
      case "acceptBatch": {
        const batch = draft.batches.get(change.batchId);
        if (!batch) throw new StoreError(`batch missing ${change.batchId}`, "batch_missing");
        if (batch.state !== "pending" && batch.state !== "delivering") {
          throw new StoreError(
            `cannot accept batch in state ${batch.state}`,
            "batch_state",
          );
        }
        batch.state = "accepted";
        batch.acceptedTurnId = change.turnId;
        batch.updatedAt = change.at;
        this.maybeCrash("after_accept_before_cursor");
        draft.cursor = {
          bindingId: draft.binding.bindingId,
          lastMessageId: change.cursorMessageId,
          initialized: true,
          updatedAt: change.at,
        };
        this.maybeCrash("after_cursor_advance");
        return;
      }
      case "deadLetter": {
        const batch = draft.batches.get(change.batchId);
        if (!batch) throw new StoreError(`batch missing ${change.batchId}`, "batch_missing");
        batch.state = "dead_letter";
        batch.lastErrorCode = change.code;
        batch.lastErrorDetail = change.detail;
        batch.updatedAt = change.at;
        this.maybeCrash("after_dead_letter");
        return;
      }
      default: {
        const _exhaustive: never = change;
        throw new StoreError(`unknown change ${JSON.stringify(_exhaustive)}`, "invalid_change");
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.buckets.clear();
  }
}

class MemoryBindingLease implements BindingLease {
  private closed = false;

  constructor(
    private readonly store: MemoryDurableStateStore,
    private readonly bindingId: string,
    private readonly ownerId: string,
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new StoreError("lease handle closed", "closed");
  }

  async load(): Promise<DeliveryState> {
    this.ensureOpen();
    return this.store._load(this.bindingId, this.ownerId);
  }

  async transact(change: StateChange): Promise<DeliveryState> {
    this.ensureOpen();
    return this.store._transact(this.bindingId, this.ownerId, change);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store._closeLease(this.bindingId, this.ownerId);
  }
}
