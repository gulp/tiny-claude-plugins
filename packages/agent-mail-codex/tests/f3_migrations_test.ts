/**
 * F3: migrations + DurableStateStore contract encoding.
 */
import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  migrate,
  MigrationError,
  MIGRATIONS,
  openMigratableDatabase,
  readSchemaVersion,
  requireBackupForDestructive,
  stampSchemaVersion,
} from "../src/migrations/mod.ts";
import {
  CRASH_POINTS,
  type DurableStateStore,
  type StateChange,
  STORE_INVARIANTS,
} from "../src/store/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assertThrowsCode(fn: () => unknown, code: MigrationError["code"]): void {
  try {
    fn();
    throw new Error(`expected MigrationError ${code}`);
  } catch (error) {
    assert(error instanceof MigrationError, `expected MigrationError, got ${error}`);
    assertEquals(error.code, code);
  }
}

Deno.test("F3: fresh migrate applies shipped schema and creates plan tables", () => {
  const db = openMigratableDatabase();
  const result = migrate(db, { now: "2026-07-28T22:00:00.000Z" });
  assertEquals(result.fromVersion, 0);
  assertEquals(result.toVersion, CURRENT_SCHEMA_VERSION);
  assertEquals(result.applied, [1, 2]);
  assertEquals(result.backupPath, null);
  assertEquals(readSchemaVersion(db), 2);

  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  for (
    const required of [
      "schema_migrations",
      "bindings",
      "leases",
      "cursors",
      "source_events",
      "batches",
    ]
  ) {
    assert(names.includes(required), `missing table ${required}`);
  }

  // Idempotent second migrate
  const again = migrate(db);
  assertEquals(again.applied, []);
  assertEquals(again.toVersion, 2);
  db.close();
});

Deno.test("F3: incremental migrate applies only newer versions", () => {
  const db = openMigratableDatabase();
  migrate(db, { now: "2026-07-28T22:00:00.000Z" });

  const v3 = {
    version: 3,
    name: "add_operator_notes",
    destructive: false,
    sql: `CREATE TABLE operator_notes (
      binding_id TEXT PRIMARY KEY REFERENCES bindings(binding_id),
      note TEXT NOT NULL
    );`,
  };

  const result = applyMigrations(db, [...MIGRATIONS, v3], {
    now: "2026-07-28T22:05:00.000Z",
  });
  assertEquals(result.fromVersion, 2);
  assertEquals(result.toVersion, 3);
  assertEquals(result.applied, [3]);

  const noteTable = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'operator_notes'`,
    )
    .get() as { ok: number } | undefined;
  assert(noteTable?.ok === 1, "operator_notes missing after incremental migrate");
  db.close();
});

Deno.test("F3: schema newer than binary is refused", () => {
  const db = openMigratableDatabase();
  stampSchemaVersion(db, CURRENT_SCHEMA_VERSION + 1, "2026-07-28T22:10:00.000Z");
  assertThrowsCode(() => migrate(db), "schema_too_new");
  db.close();
});

Deno.test("F3: destructive migration requires online backup path", () => {
  const db = openMigratableDatabase();
  migrate(db);

  const destructive = {
    version: 3,
    name: "rebuild_batches",
    destructive: true,
    sql: `CREATE TABLE batches_v2 (batch_id TEXT PRIMARY KEY);`,
  };

  assertThrowsCode(
    () => applyMigrations(db, [...MIGRATIONS, destructive]),
    "destructive_without_backup",
  );

  try {
    requireBackupForDestructive([destructive], undefined);
    throw new Error("expected requireBackupForDestructive to throw");
  } catch (error) {
    assert(error instanceof MigrationError, "expected MigrationError");
    assertEquals(error.code, "destructive_without_backup");
  }

  const result = applyMigrations(db, [...MIGRATIONS, destructive], {
    dbPath: "/tmp/agent-mail-codex-state.sqlite",
    createOnlineBackup: (path) => `${path}.bak-test`,
    now: "2026-07-28T22:15:00.000Z",
  });
  assertEquals(result.applied, [3]);
  assertEquals(result.backupPath, "/tmp/agent-mail-codex-state.sqlite.bak-test");
  db.close();
});

Deno.test("F3: crash-point and store invariants are encoded for F4/F5", () => {
  assertEquals(STORE_INVARIANTS.walModeRequired, true);
  assertEquals(STORE_INVARIANTS.leaseRenewSeconds, 5);
  assertEquals(STORE_INVARIANTS.leaseTtlSeconds, 20);
  assertEquals(STORE_INVARIANTS.acceptAdvancesCursorAtomically, true);
  assertEquals(STORE_INVARIANTS.neverDiscardOutboxForGreenStartup, true);
  assert(
    CRASH_POINTS.includes("after_accept_before_cursor"),
    "missing after_accept_before_cursor",
  );
  assert(
    CRASH_POINTS.includes("before_transact_commit"),
    "missing before_transact_commit",
  );
  assertEquals([...STORE_INVARIANTS.crashPoints], [...CRASH_POINTS]);

  // Compile-time shape sample — Discriminated StateChange covers accept+cursor.
  const change: StateChange = {
    kind: "acceptBatch",
    batchId: "batch:example:1-2",
    turnId: "turn_1",
    cursorMessageId: 2,
    at: "2026-07-28T22:20:00.000Z",
  };
  assertEquals(change.kind, "acceptBatch");

  // Interface exists for adapters (structural check via assignment).
  const _typeProbe: DurableStateStore | null = null;
  assert(_typeProbe === null, "type probe");
});

Deno.test("F3: shipped migration list is forward-only and starts at 1", () => {
  assertEquals(MIGRATIONS.length >= 1, true);
  assertEquals(MIGRATIONS[0].version, 1);
  assertEquals(MIGRATIONS[0].destructive, false);
  for (let i = 1; i < MIGRATIONS.length; i++) {
    assert(
      MIGRATIONS[i].version > MIGRATIONS[i - 1].version,
      "migrations must be strictly increasing",
    );
  }
  assertEquals(CURRENT_SCHEMA_VERSION, MIGRATIONS[MIGRATIONS.length - 1].version);
});
