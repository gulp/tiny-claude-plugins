/**
 * F5: production SQLite DurableStateStore (WAL, leases, transactional changes).
 * Passes the same runDurableStateStoreContract suite as the F4 memory adapter.
 */

import { DatabaseSync } from "node:sqlite";
import type { EventId, Importance } from "../schemas/mod.ts";
import { migrate, openMigratableDatabase } from "../migrations/mod.ts";
import {
  type BatchRecord,
  type BindingLease,
  type BindingRef,
  type CrashPoint,
  type DeliveryState,
  type DurableStateStore,
  type LeaseRecord,
  type SourceEventRecord,
  type StateChange,
  STORE_INVARIANTS,
  StoreError,
} from "./mod.ts";

export interface SqliteStoreOptions {
  /** Absolute path to the SQLite file (not :memory: — backup needs a file). */
  path: string;
  now?: () => string;
  /** Simulate crash before commit; next matching point rolls back. */
  armCrash?: CrashPoint | null;
}

/** Online backup: WAL checkpoint + copy. (VACUUM INTO unavailable when max_attached=0.) */
export function createSqliteOnlineBackup(db: DatabaseSync, dbPath: string): string {
  if (dbPath === ":memory:") {
    throw new StoreError("online backup requires a file-backed database", "invalid_change");
  }
  db.exec("PRAGMA wal_checkpoint(FULL);");
  const backupPath = `${dbPath}.bak-${Date.now()}`;
  Deno.copyFileSync(dbPath, backupPath);
  return backupPath;
}

export class SqliteDurableStateStore implements DurableStateStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly nowFn: () => string;
  armCrash: CrashPoint | null;
  private closed = false;
  /** Process-local open handles (lease table covers cross-process). */
  private readonly openOwners = new Map<string, string>();

  constructor(options: SqliteStoreOptions) {
    if (!options.path.startsWith("/")) {
      throw new StoreError("sqlite path must be absolute", "invalid_change");
    }
    this.path = options.path;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.armCrash = options.armCrash ?? null;
    this.db = openMigratableDatabase(options.path);
    migrate(this.db, {
      dbPath: options.path,
      createOnlineBackup: (p) => createSqliteOnlineBackup(this.db, p),
    });
    const mode = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (String(mode.journal_mode).toLowerCase() !== "wal") {
      throw new StoreError(
        `WAL mode required, got ${mode.journal_mode}`,
        "invalid_change",
      );
    }
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

  /** Operator-facing online backup path. */
  createOnlineBackup(): string {
    this.ensureOpen();
    return createSqliteOnlineBackup(this.db, this.path);
  }

  async open(binding: BindingRef, ownerId: string): Promise<BindingLease> {
    this.ensureOpen();
    const now = this.now();

    if (this.openOwners.has(binding.bindingId)) {
      const holder = this.openOwners.get(binding.bindingId)!;
      if (holder !== ownerId) {
        throw new StoreError(
          `binding ${binding.bindingId} already open by ${holder}`,
          "lease_held",
        );
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(`SELECT config_hash FROM bindings WHERE binding_id = ?`)
        .get(binding.bindingId) as { config_hash: string } | undefined;

      if (existing && existing.config_hash !== binding.configHash) {
        throw new StoreError(
          `config hash mismatch for ${binding.bindingId}`,
          "config_hash_mismatch",
        );
      }

      if (!existing) {
        this.db.prepare(
          `INSERT INTO bindings (
            binding_id, agent, scope_json, adapter, thread_id, config_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          binding.bindingId,
          binding.agent,
          binding.scopeJson,
          binding.adapter,
          binding.threadId,
          binding.configHash,
          now,
          now,
        );
        this.db.prepare(
          `INSERT INTO cursors (
             binding_id, last_message_id, baseline_initialized, updated_at
           ) VALUES (?, 0, 0, ?)`,
        ).run(binding.bindingId, now);
      } else {
        this.db.prepare(
          `UPDATE bindings SET agent = ?, scope_json = ?, adapter = ?, thread_id = ?, updated_at = ?
           WHERE binding_id = ?`,
        ).run(
          binding.agent,
          binding.scopeJson,
          binding.adapter,
          binding.threadId,
          now,
          binding.bindingId,
        );
      }

      const leaseRow = this.db
        .prepare(
          `SELECT owner_id, expires_at, heartbeat_at FROM leases WHERE binding_id = ?`,
        )
        .get(binding.bindingId) as
          | { owner_id: string; expires_at: string; heartbeat_at: string }
          | undefined;

      if (
        leaseRow &&
        leaseRow.owner_id !== ownerId &&
        now <= leaseRow.expires_at
      ) {
        throw new StoreError(
          `lease held by ${leaseRow.owner_id} until ${leaseRow.expires_at}`,
          "lease_held",
        );
      }

      const expiresAt = new Date(
        Date.parse(now) + STORE_INVARIANTS.leaseTtlSeconds * 1000,
      ).toISOString();
      this.db.prepare(
        `INSERT INTO leases (binding_id, owner_id, expires_at, heartbeat_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(binding_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           expires_at = excluded.expires_at,
           heartbeat_at = excluded.heartbeat_at`,
      ).run(binding.bindingId, ownerId, expiresAt, now);

      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }

    this.openOwners.set(binding.bindingId, ownerId);
    return new SqliteBindingLease(this, binding.bindingId, ownerId);
  }

  /** @internal */
  _load(bindingId: string, ownerId: string): DeliveryState {
    this.ensureOpen();
    this.requireLiveLease(bindingId, ownerId);
    return this.readState(bindingId);
  }

  /** @internal */
  _transact(bindingId: string, ownerId: string, change: StateChange): DeliveryState {
    this.ensureOpen();
    this.requireLiveLease(bindingId, ownerId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.applyChange(bindingId, change);
      this.maybeCrash("before_transact_commit");
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
    return this.readState(bindingId);
  }

  /** @internal */
  _closeLease(bindingId: string, ownerId: string): void {
    this.openOwners.delete(bindingId);
    if (this.closed) return;
    this.db.prepare(
      `DELETE FROM leases WHERE binding_id = ? AND owner_id = ?`,
    ).run(bindingId, ownerId);
  }

  private requireLiveLease(bindingId: string, ownerId: string): void {
    const now = this.now();
    const row = this.db
      .prepare(
        `SELECT owner_id, expires_at FROM leases WHERE binding_id = ?`,
      )
      .get(bindingId) as { owner_id: string; expires_at: string } | undefined;
    if (!row) throw new StoreError("lease lost", "lease_lost");
    if (row.owner_id !== ownerId) {
      throw new StoreError("lease owner mismatch", "lease_mismatch");
    }
    if (now > row.expires_at) {
      this.db.prepare(`DELETE FROM leases WHERE binding_id = ?`).run(bindingId);
      this.openOwners.delete(bindingId);
      throw new StoreError("lease expired", "lease_lost");
    }
  }

  private readState(bindingId: string): DeliveryState {
    const b = this.db
      .prepare(
        `SELECT binding_id, agent, scope_json, adapter, thread_id, config_hash
         FROM bindings WHERE binding_id = ?`,
      )
      .get(bindingId) as {
        binding_id: string;
        agent: string;
        scope_json: string;
        adapter: string;
        thread_id: string | null;
        config_hash: string;
      };
    const leaseRow = this.db
      .prepare(
        `SELECT binding_id, owner_id, expires_at, heartbeat_at FROM leases WHERE binding_id = ?`,
      )
      .get(bindingId) as
        | { binding_id: string; owner_id: string; expires_at: string; heartbeat_at: string }
        | undefined;
    const cursorRow = this.db
      .prepare(
        `SELECT binding_id, last_message_id, baseline_initialized, updated_at
         FROM cursors WHERE binding_id = ?`,
      )
      .get(bindingId) as {
        binding_id: string;
        last_message_id: number;
        baseline_initialized: number;
        updated_at: string;
      };

    const batchRows = this.db
      .prepare(
        `SELECT * FROM batches WHERE binding_id = ? ORDER BY first_message_id ASC`,
      )
      .all(bindingId) as Record<string, unknown>[];

    const eventRows = this.db
      .prepare(
        `SELECT * FROM source_events WHERE binding_id = ? ORDER BY message_id ASC`,
      )
      .all(bindingId) as Record<string, unknown>[];

    const lease: LeaseRecord | null = leaseRow
      ? {
        bindingId: leaseRow.binding_id,
        ownerId: leaseRow.owner_id,
        expiresAt: leaseRow.expires_at,
        heartbeatAt: leaseRow.heartbeat_at,
      }
      : null;

    return {
      binding: {
        bindingId: b.binding_id,
        agent: b.agent,
        scopeJson: b.scope_json,
        adapter: b.adapter,
        threadId: b.thread_id,
        configHash: b.config_hash,
      },
      lease,
      cursor: {
        bindingId: cursorRow.binding_id,
        lastMessageId: Number(cursorRow.last_message_id),
        initialized: Number(cursorRow.baseline_initialized) === 1,
        updatedAt: cursorRow.updated_at,
      },
      batches: batchRows.map(rowToBatch),
      sourceEvents: eventRows.map(rowToSourceEvent),
    };
  }

  private applyChange(bindingId: string, change: StateChange): void {
    switch (change.kind) {
      case "upsertBinding": {
        this.db.prepare(
          `UPDATE bindings SET agent = ?, scope_json = ?, adapter = ?, thread_id = ?,
            config_hash = ?, updated_at = ? WHERE binding_id = ?`,
        ).run(
          change.binding.agent,
          change.binding.scopeJson,
          change.binding.adapter,
          change.binding.threadId,
          change.binding.configHash,
          change.at,
          bindingId,
        );
        return;
      }
      case "setBaseline": {
        const cursor = this.db.prepare(
          `SELECT last_message_id, baseline_initialized FROM cursors WHERE binding_id = ?`,
        ).get(bindingId) as { last_message_id: number; baseline_initialized: number };
        const counts = this.db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM batches WHERE binding_id = ?) AS batches,
             (SELECT COUNT(*) FROM source_events WHERE binding_id = ?) AS events`,
        ).get(bindingId, bindingId) as { batches: number; events: number };
        if (
          Number(cursor.baseline_initialized) !== 0 ||
          Number(counts.batches) !== 0 ||
          Number(counts.events) !== 0 ||
          !Number.isSafeInteger(change.cursorMessageId) ||
          change.cursorMessageId < 0
        ) {
          throw new StoreError("baseline can only initialize empty state", "invalid_change");
        }
        this.db.prepare(
          `UPDATE cursors
           SET last_message_id = ?, baseline_initialized = 1, updated_at = ?
           WHERE binding_id = ?`,
        ).run(change.cursorMessageId, change.at, bindingId);
        return;
      }
      case "renewLease": {
        const row = this.db
          .prepare(`SELECT owner_id FROM leases WHERE binding_id = ?`)
          .get(bindingId) as { owner_id: string } | undefined;
        if (!row || row.owner_id !== change.ownerId) {
          throw new StoreError("cannot renew foreign/missing lease", "lease_mismatch");
        }
        this.db.prepare(
          `UPDATE leases SET expires_at = ?, heartbeat_at = ? WHERE binding_id = ?`,
        ).run(change.expiresAt, change.heartbeatAt, bindingId);
        this.maybeCrash("after_lease_renew");
        return;
      }
      case "releaseLease": {
        this.db.prepare(
          `DELETE FROM leases WHERE binding_id = ? AND owner_id = ?`,
        ).run(bindingId, change.ownerId);
        return;
      }
      case "observeSourceEvents": {
        for (const event of change.events) {
          if (event.bindingId !== bindingId) {
            throw new StoreError("source event binding mismatch", "invalid_change");
          }
          this.db.prepare(
            `INSERT INTO source_events (
              binding_id, message_id, project_slug, created_ts, subject,
              importance, ack_required, source_path_hash, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(binding_id, message_id) DO UPDATE SET
              project_slug = excluded.project_slug,
              created_ts = excluded.created_ts,
              subject = excluded.subject,
              importance = excluded.importance,
              ack_required = excluded.ack_required,
              source_path_hash = excluded.source_path_hash,
              observed_at = excluded.observed_at`,
          ).run(
            event.bindingId,
            event.messageId,
            event.projectSlug,
            event.createdTs,
            event.subject,
            event.importance,
            event.ackRequired === null ? null : event.ackRequired ? 1 : 0,
            event.sourcePathHash,
            event.observedAt,
          );
        }
        return;
      }
      case "enqueueBatch": {
        if (change.batch.bindingId !== bindingId) {
          throw new StoreError("batch binding mismatch", "invalid_change");
        }
        try {
          this.db.prepare(
            `INSERT INTO batches (
              batch_id, binding_id, first_message_id, last_message_id, event_ids_json,
              payload_json, urgency, state, attempt_count, next_attempt_at,
              accepted_turn_id, last_error_code, last_error_detail, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            change.batch.batchId,
            change.batch.bindingId,
            change.batch.firstMessageId,
            change.batch.lastMessageId,
            JSON.stringify(change.batch.eventIds),
            change.batch.payloadJson,
            change.batch.urgency,
            change.batch.state,
            change.batch.attemptCount,
            change.batch.nextAttemptAt,
            change.batch.acceptedTurnId,
            change.batch.lastErrorCode,
            change.batch.lastErrorDetail,
            change.batch.createdAt,
            change.batch.updatedAt,
          );
        } catch {
          throw new StoreError(`duplicate batch ${change.batch.batchId}`, "invalid_change");
        }
        this.maybeCrash("after_batch_enqueue");
        return;
      }
      case "transitionBatch": {
        const batch = this.requireBatch(change.batchId);
        if (batch.state !== change.from) {
          throw new StoreError(
            `batch ${change.batchId} state ${batch.state} != ${change.from}`,
            "batch_state",
          );
        }
        this.db.prepare(
          `UPDATE batches SET state = ?, updated_at = ? WHERE batch_id = ?`,
        ).run(change.to, change.at, change.batchId);
        if (change.attemptCount !== undefined) {
          this.db.prepare(`UPDATE batches SET attempt_count = ? WHERE batch_id = ?`).run(
            change.attemptCount,
            change.batchId,
          );
        }
        if (change.nextAttemptAt !== undefined) {
          this.db.prepare(`UPDATE batches SET next_attempt_at = ? WHERE batch_id = ?`).run(
            change.nextAttemptAt,
            change.batchId,
          );
        }
        if (change.lastErrorCode !== undefined) {
          this.db.prepare(`UPDATE batches SET last_error_code = ? WHERE batch_id = ?`).run(
            change.lastErrorCode,
            change.batchId,
          );
        }
        if (change.lastErrorDetail !== undefined) {
          this.db.prepare(`UPDATE batches SET last_error_detail = ? WHERE batch_id = ?`).run(
            change.lastErrorDetail,
            change.batchId,
          );
        }
        if (change.acceptedTurnId !== undefined) {
          this.db.prepare(`UPDATE batches SET accepted_turn_id = ? WHERE batch_id = ?`).run(
            change.acceptedTurnId,
            change.batchId,
          );
        }
        return;
      }
      case "acceptBatch": {
        const batch = this.requireBatch(change.batchId);
        if (batch.state !== "pending" && batch.state !== "delivering") {
          throw new StoreError(
            `cannot accept batch in state ${batch.state}`,
            "batch_state",
          );
        }
        this.db.prepare(
          `UPDATE batches SET state = 'accepted', accepted_turn_id = ?, updated_at = ?
           WHERE batch_id = ?`,
        ).run(change.turnId, change.at, change.batchId);
        this.maybeCrash("after_accept_before_cursor");
        this.db.prepare(
          `UPDATE cursors
           SET last_message_id = ?, baseline_initialized = 1, updated_at = ?
           WHERE binding_id = ?`,
        ).run(change.cursorMessageId, change.at, bindingId);
        this.maybeCrash("after_cursor_advance");
        return;
      }
      case "deadLetter": {
        this.requireBatch(change.batchId);
        this.db.prepare(
          `UPDATE batches SET state = 'dead_letter', last_error_code = ?, last_error_detail = ?,
            updated_at = ? WHERE batch_id = ?`,
        ).run(change.code, change.detail, change.at, change.batchId);
        this.maybeCrash("after_dead_letter");
        return;
      }
      default: {
        const _exhaustive: never = change;
        throw new StoreError(`unknown change ${JSON.stringify(_exhaustive)}`, "invalid_change");
      }
    }
  }

  private requireBatch(batchId: string): BatchRecord {
    const row = this.db
      .prepare(`SELECT * FROM batches WHERE batch_id = ?`)
      .get(batchId) as Record<string, unknown> | undefined;
    if (!row) throw new StoreError(`batch missing ${batchId}`, "batch_missing");
    return rowToBatch(row);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.openOwners.clear();
    this.db.close();
  }
}

class SqliteBindingLease implements BindingLease {
  private closed = false;

  constructor(
    private readonly store: SqliteDurableStateStore,
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

function rowToBatch(row: Record<string, unknown>): BatchRecord {
  return {
    batchId: String(row.batch_id),
    bindingId: String(row.binding_id),
    firstMessageId: Number(row.first_message_id),
    lastMessageId: Number(row.last_message_id),
    eventIds: JSON.parse(String(row.event_ids_json)) as EventId[],
    payloadJson: String(row.payload_json),
    urgency: row.urgency as BatchRecord["urgency"],
    state: row.state as BatchRecord["state"],
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined
      ? null
      : String(row.next_attempt_at),
    acceptedTurnId: row.accepted_turn_id === null || row.accepted_turn_id === undefined
      ? null
      : String(row.accepted_turn_id),
    lastErrorCode: row.last_error_code === null || row.last_error_code === undefined
      ? null
      : String(row.last_error_code),
    lastErrorDetail: row.last_error_detail === null || row.last_error_detail === undefined
      ? null
      : String(row.last_error_detail),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToSourceEvent(row: Record<string, unknown>): SourceEventRecord {
  const ack = row.ack_required;
  return {
    bindingId: String(row.binding_id),
    messageId: Number(row.message_id),
    projectSlug: String(row.project_slug),
    createdTs: String(row.created_ts),
    subject: String(row.subject),
    importance:
      (row.importance === null || row.importance === undefined ? null : String(row.importance)) as
        | Importance
        | null,
    ackRequired: ack === null || ack === undefined ? null : Number(ack) === 1,
    sourcePathHash: String(row.source_path_hash),
    observedAt: String(row.observed_at),
  };
}
