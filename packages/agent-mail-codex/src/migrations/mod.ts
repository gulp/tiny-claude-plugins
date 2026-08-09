/**
 * F3: forward-only, transactional SQLite migrations for Codex ingress state.
 * Schema DDL matches docs/plans/codex-agent-mail-ingress.md.
 */

import { DatabaseSync } from "node:sqlite";

/** Highest schema version this binary understands. */
export const CURRENT_SCHEMA_VERSION = 2 as const;

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "schema_too_new"
      | "destructive_without_backup"
      | "migration_failed"
      | "invalid_db",
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface Migration {
  version: number;
  /** Human label for logs / doctor. */
  name: string;
  /** True if the SQL drops/rebuilds user data — requires online backup first. */
  destructive: boolean;
  /** Statements applied inside one transaction. */
  sql: string;
}

/** v1: bindings, leases, cursors, source_events, batches (+ indexes). */
export const MIGRATION_V1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE bindings (
  binding_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  adapter TEXT NOT NULL,
  thread_id TEXT,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE leases (
  binding_id TEXT PRIMARY KEY REFERENCES bindings(binding_id),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE cursors (
  binding_id TEXT PRIMARY KEY REFERENCES bindings(binding_id),
  last_message_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_events (
  binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
  message_id INTEGER NOT NULL,
  project_slug TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  subject TEXT NOT NULL,
  importance TEXT,
  ack_required INTEGER,
  source_path_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, message_id)
);

CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES bindings(binding_id),
  first_message_id INTEGER NOT NULL,
  last_message_id INTEGER NOT NULL,
  event_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  urgency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'delivering', 'accepted', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  accepted_turn_id TEXT,
  last_error_code TEXT,
  last_error_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX batches_ready
ON batches(binding_id, state, next_attempt_at, first_message_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_durable_state",
    destructive: false,
    sql: MIGRATION_V1_SQL,
  },
  {
    version: 2,
    name: "persist_first_baseline_state",
    destructive: false,
    sql: `ALTER TABLE cursors
      ADD COLUMN baseline_initialized INTEGER NOT NULL DEFAULT 0;`,
  },
];

export interface MigrateOptions {
  /** ISO timestamp for schema_migrations.applied_at (injectable for tests). */
  now?: string;
  /**
   * Required when any pending migration is destructive.
   * Must return the backup file path (reported to operators).
   */
  createOnlineBackup?: (dbPath: string) => string | Promise<string>;
  /** Path used for backup reporting; defaults to ":memory:" label. */
  dbPath?: string;
}

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  backupPath: string | null;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(name) as { ok: number } | undefined;
  return row?.ok === 1;
}

/** Highest applied migration version, or 0 if none. */
export function readSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations`)
    .get() as { v: number };
  return Number(row.v);
}

function assertNotTooNew(fromVersion: number): void {
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new MigrationError(
      `database schema version ${fromVersion} is newer than binary ${CURRENT_SCHEMA_VERSION}`,
      "schema_too_new",
    );
  }
}

function runMigrationTransaction(
  db: DatabaseSync,
  pending: readonly Migration[],
  now: string,
): number[] {
  const applied: number[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
      ).run(migration.version, now);
      applied.push(migration.version);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`migration failed: ${detail}`, "migration_failed");
  }
  return applied;
}

/**
 * Apply a custom forward-only migration list (tests / future runners).
 * Still refuses DBs newer than CURRENT_SCHEMA_VERSION.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrateResult {
  const now = options.now ?? new Date().toISOString();
  const dbPath = options.dbPath ?? ":memory:";
  const fromVersion = readSchemaVersion(db);
  assertNotTooNew(fromVersion);

  const pending = migrations.filter((m) => m.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };
  }

  const needsBackup = pending.some((m) => m.destructive);
  let backupPath: string | null = null;
  if (needsBackup) {
    if (!options.createOnlineBackup) {
      throw new MigrationError(
        "destructive migration pending but createOnlineBackup was not provided",
        "destructive_without_backup",
      );
    }
    const path = options.createOnlineBackup(dbPath);
    if (path instanceof Promise) {
      throw new MigrationError(
        "async createOnlineBackup requires migrateAsync / applyMigrationsAsync",
        "destructive_without_backup",
      );
    }
    if (!path) {
      throw new MigrationError(
        "createOnlineBackup returned an empty path",
        "destructive_without_backup",
      );
    }
    backupPath = path;
  }

  const applied = runMigrationTransaction(db, pending, now);
  return { fromVersion, toVersion: readSchemaVersion(db), applied, backupPath };
}

/** Apply shipped migrations up to CURRENT_SCHEMA_VERSION. */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateResult {
  return applyMigrations(db, MIGRATIONS, options);
}

/** Async variant when backup is Promise-returning. */
export async function applyMigrationsAsync(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const now = options.now ?? new Date().toISOString();
  const dbPath = options.dbPath ?? ":memory:";
  const fromVersion = readSchemaVersion(db);
  assertNotTooNew(fromVersion);

  const pending = migrations.filter((m) => m.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };
  }

  const needsBackup = pending.some((m) => m.destructive);
  let backupPath: string | null = null;
  if (needsBackup) {
    if (!options.createOnlineBackup) {
      throw new MigrationError(
        "destructive migration pending but createOnlineBackup was not provided",
        "destructive_without_backup",
      );
    }
    backupPath = await options.createOnlineBackup(dbPath);
    if (!backupPath) {
      throw new MigrationError(
        "createOnlineBackup returned an empty path",
        "destructive_without_backup",
      );
    }
  }

  const applied = runMigrationTransaction(db, pending, now);
  return { fromVersion, toVersion: readSchemaVersion(db), applied, backupPath };
}

export async function migrateAsync(
  db: DatabaseSync,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  return await applyMigrationsAsync(db, MIGRATIONS, options);
}

/** Open an in-memory or file DB with WAL when file-backed (F5 production path). */
export function openMigratableDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/**
 * Test/helper: record a fake future schema version so migrate() must refuse.
 * Does not run unknown DDL — only stamps schema_migrations.
 */
export function stampSchemaVersion(db: DatabaseSync, version: number, at: string): void {
  if (!tableExists(db, "schema_migrations")) {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
  }
  db.prepare(
    `INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
  ).run(version, at);
}

/**
 * Encode the destructive-backup rule for a hypothetical migration not yet shipped.
 * Used by contract tests so F5 cannot omit backup wiring.
 */
export function requireBackupForDestructive(
  migrations: readonly Migration[],
  createOnlineBackup: MigrateOptions["createOnlineBackup"],
): void {
  if (!migrations.some((m) => m.destructive)) return;
  if (!createOnlineBackup) {
    throw new MigrationError(
      "destructive migration requires createOnlineBackup",
      "destructive_without_backup",
    );
  }
}
