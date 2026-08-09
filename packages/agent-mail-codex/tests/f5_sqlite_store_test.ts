/**
 * F5: SQLite DurableStateStore against the shared contract + crash/backup checks.
 */
import { runDurableStateStoreContract } from "../src/store/contract.ts";
import { SqliteDurableStateStore } from "../src/store/sqlite.ts";
import { StoreError } from "../src/store/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function withTempDb(
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "amc-f5-" });
  const path = `${dir}/state.sqlite`;
  try {
    await fn(path);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
}

Deno.test("F5: SqliteDurableStateStore passes store contract suite", async () => {
  await withTempDb(async (path) => {
    let n = 0;
    await runDurableStateStoreContract(() => {
      n += 1;
      // Fresh file per contract section so leftover batches do not collide.
      return new SqliteDurableStateStore({
        path: `${path}.${n}`,
        now: () => "2026-07-28T22:00:00.000Z",
      });
    });
  });
});

Deno.test("F5: crash before cursor rolls back accept atomically", async () => {
  await withTempDb(async (path) => {
    const store = new SqliteDurableStateStore({
      path,
      now: () => "2026-07-28T22:00:00.000Z",
      armCrash: "after_accept_before_cursor",
    });
    const binding = {
      bindingId: "sqlite-crash",
      agent: "AmberOtter",
      configHash: "h1",
      adapter: "headless-app-server-owner",
      scopeJson: "{}",
      threadId: "t1",
    };
    const lease = await store.open(binding, "owner-a");
    await lease.transact({
      kind: "enqueueBatch",
      batch: {
        batchId: "batch:sqlite-crash:1-1",
        bindingId: binding.bindingId,
        firstMessageId: 1,
        lastMessageId: 1,
        eventIds: ["agent-mail:1"],
        payloadJson: "{}",
        urgency: "routine",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: null,
        acceptedTurnId: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        createdAt: "2026-07-28T22:00:00.000Z",
        updatedAt: "2026-07-28T22:00:00.000Z",
      },
    });
    try {
      await lease.transact({
        kind: "acceptBatch",
        batchId: "batch:sqlite-crash:1-1",
        turnId: "turn-x",
        cursorMessageId: 1,
        at: "2026-07-28T22:00:01.000Z",
      });
      throw new Error("expected crash");
    } catch (error) {
      assert(error instanceof StoreError, "StoreError");
      assertEquals(error.code, "invalid_change");
    }
    const state = await lease.load();
    assertEquals(state.cursor.lastMessageId, 0);
    assertEquals(state.batches[0].state, "pending");
    await lease.close();
    await store.close();
  });
});

Deno.test("F5: reopen persists accepted cursor; online backup writes a file", async () => {
  await withTempDb(async (path) => {
    const binding = {
      bindingId: "sqlite-persist",
      agent: "AmberOtter",
      configHash: "h1",
      adapter: "headless-app-server-owner",
      scopeJson: "{}",
      threadId: "t1",
    };
    {
      const store = new SqliteDurableStateStore({
        path,
        now: () => "2026-07-28T22:00:00.000Z",
      });
      const lease = await store.open(binding, "owner-a");
      await lease.transact({
        kind: "enqueueBatch",
        batch: {
          batchId: "batch:sqlite-persist:5-5",
          bindingId: binding.bindingId,
          firstMessageId: 5,
          lastMessageId: 5,
          eventIds: ["agent-mail:5"],
          payloadJson: "{}",
          urgency: "urgent",
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          acceptedTurnId: null,
          lastErrorCode: null,
          lastErrorDetail: null,
          createdAt: "2026-07-28T22:00:00.000Z",
          updatedAt: "2026-07-28T22:00:00.000Z",
        },
      });
      await lease.transact({
        kind: "acceptBatch",
        batchId: "batch:sqlite-persist:5-5",
        turnId: "turn-persist",
        cursorMessageId: 5,
        at: "2026-07-28T22:00:02.000Z",
      });
      const bak = store.createOnlineBackup();
      assert(bak.startsWith(path), "backup beside db");
      assert((await Deno.stat(bak)).size > 0, "backup non-empty");
      await lease.close();
      await store.close();
    }
    {
      const store = new SqliteDurableStateStore({
        path,
        now: () => "2026-07-28T22:00:10.000Z",
      });
      const lease = await store.open(binding, "owner-b");
      const state = await lease.load();
      assertEquals(state.cursor.lastMessageId, 5);
      assertEquals(state.batches[0].state, "accepted");
      assertEquals(state.batches[0].acceptedTurnId, "turn-persist");
      await lease.close();
      await store.close();
    }
  });
});

Deno.test("F5: two owners cannot hold one binding lease", async () => {
  await withTempDb(async (path) => {
    const store = new SqliteDurableStateStore({
      path,
      now: () => "2026-07-28T22:00:00.000Z",
    });
    const binding = {
      bindingId: "sqlite-excl",
      agent: "AmberOtter",
      configHash: "h1",
      adapter: "headless-app-server-owner",
      scopeJson: "{}",
      threadId: null,
    };
    const a = await store.open(binding, "owner-a");
    try {
      await store.open(binding, "owner-b");
      throw new Error("expected lease_held");
    } catch (error) {
      assert(error instanceof StoreError, "StoreError");
      assertEquals(error.code, "lease_held");
    }
    await a.close();
    await store.close();
  });
});
