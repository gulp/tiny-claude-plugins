/**
 * Reusable DurableStateStore contract suite (F4).
 * F5 runs the same suite against the SQLite adapter.
 */

import {
  type BatchRecord,
  type BindingRef,
  type DurableStateStore,
  STORE_INVARIANTS,
  StoreError,
} from "./mod.ts";
import { MemoryDurableStateStore } from "./memory.ts";

export type StoreFactory = () => DurableStateStore;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function expectCode(
  fn: () => Promise<unknown>,
  code: StoreError["code"],
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected StoreError ${code}`);
  } catch (error) {
    assert(error instanceof StoreError, `expected StoreError, got ${error}`);
    assertEquals(error.code, code);
  }
}

const SAMPLE_BINDING: BindingRef = {
  bindingId: "amber-apply-patch",
  agent: "AmberOtter",
  configHash: "cfg-hash-1",
  adapter: "headless-app-server-owner",
  scopeJson: JSON.stringify({ kind: "project", projectPath: "/tmp/x" }),
  threadId: "thread-durable-f4",
};

function sampleBatch(
  overrides:
    & Partial<BatchRecord>
    & Pick<BatchRecord, "batchId" | "firstMessageId" | "lastMessageId">,
): BatchRecord {
  return {
    bindingId: SAMPLE_BINDING.bindingId,
    eventIds: overrides.eventIds ??
      ([`agent-mail:${overrides.firstMessageId}`] as BatchRecord["eventIds"]),
    payloadJson: overrides.payloadJson ?? "{}",
    urgency: overrides.urgency ?? "routine",
    state: overrides.state ?? "pending",
    attemptCount: overrides.attemptCount ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? null,
    acceptedTurnId: overrides.acceptedTurnId ?? null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorDetail: overrides.lastErrorDetail ?? null,
    createdAt: overrides.createdAt ?? "2026-07-28T22:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-28T22:00:00.000Z",
    batchId: overrides.batchId,
    firstMessageId: overrides.firstMessageId,
    lastMessageId: overrides.lastMessageId,
  };
}

/** Full F4/F5 store contract. Default factory: MemoryDurableStateStore. */
export async function runDurableStateStoreContract(
  factory: StoreFactory = () =>
    new MemoryDurableStateStore({ now: () => "2026-07-28T22:00:00.000Z" }),
): Promise<void> {
  await contractLeaseExclusion(factory);
  await contractBaselinePersistsOnce(factory);
  await contractAcceptAdvancesCursorAtomically(factory);
  await contractAttemptTransitionsAndDeadLetter(factory);
  await contractCrashDiscardsInFlightChange();
  await contractInvariantsDocumented();
}

async function contractBaselinePersistsOnce(factory: StoreFactory): Promise<void> {
  const store = factory();
  const lease = await store.open(SAMPLE_BINDING, "owner-a");
  const state = await lease.transact({
    kind: "setBaseline",
    cursorMessageId: 9,
    at: "2026-07-28T22:00:00.500Z",
  });
  assertEquals(state.cursor.lastMessageId, 9);
  await expectCode(
    () =>
      lease.transact({
        kind: "setBaseline",
        cursorMessageId: 10,
        at: "2026-07-28T22:00:00.600Z",
      }),
    "invalid_change",
  );
  await lease.close();
  await store.close();
}

async function contractLeaseExclusion(factory: StoreFactory): Promise<void> {
  const store = factory();
  const a = await store.open(SAMPLE_BINDING, "owner-a");
  await expectCode(() => store.open(SAMPLE_BINDING, "owner-b"), "lease_held");
  const state = await a.load();
  assertEquals(state.lease?.ownerId, "owner-a");
  assertEquals(state.cursor.lastMessageId, 0);
  await a.close();
  const b = await store.open(SAMPLE_BINDING, "owner-b");
  assertEquals((await b.load()).lease?.ownerId, "owner-b");
  await b.close();
  await store.close();
}

async function contractAcceptAdvancesCursorAtomically(
  factory: StoreFactory,
): Promise<void> {
  const store = factory();
  const lease = await store.open(SAMPLE_BINDING, "owner-a");
  await lease.transact({
    kind: "enqueueBatch",
    batch: sampleBatch({
      batchId: "batch:amber-apply-patch:10-10",
      firstMessageId: 10,
      lastMessageId: 10,
    }),
  });
  const after = await lease.transact({
    kind: "acceptBatch",
    batchId: "batch:amber-apply-patch:10-10",
    turnId: "turn-1",
    cursorMessageId: 10,
    at: "2026-07-28T22:00:01.000Z",
  });
  assertEquals(after.cursor.lastMessageId, 10);
  assertEquals(after.batches[0].state, "accepted");
  assertEquals(after.batches[0].acceptedTurnId, "turn-1");
  // Outbox retained after accept — never discarded for green startup.
  assertEquals(after.batches.length, 1);
  await lease.close();
  await store.close();
}

async function contractAttemptTransitionsAndDeadLetter(
  factory: StoreFactory,
): Promise<void> {
  const store = factory();
  const lease = await store.open(SAMPLE_BINDING, "owner-a");
  await lease.transact({
    kind: "enqueueBatch",
    batch: sampleBatch({
      batchId: "batch:amber-apply-patch:11-12",
      firstMessageId: 11,
      lastMessageId: 12,
      eventIds: ["agent-mail:11", "agent-mail:12"],
      urgency: "urgent",
    }),
  });
  await lease.transact({
    kind: "transitionBatch",
    batchId: "batch:amber-apply-patch:11-12",
    from: "pending",
    to: "delivering",
    at: "2026-07-28T22:00:02.000Z",
    attemptCount: 1,
    nextAttemptAt: "2026-07-28T22:00:07.000Z",
  });
  const dead = await lease.transact({
    kind: "deadLetter",
    batchId: "batch:amber-apply-patch:11-12",
    code: "delivery_exhausted",
    detail: "max attempts",
    at: "2026-07-28T22:00:08.000Z",
  });
  assertEquals(dead.batches[0].state, "dead_letter");
  assertEquals(dead.batches[0].lastErrorCode, "delivery_exhausted");
  assertEquals(dead.batches[0].attemptCount, 1);

  await expectCode(
    () =>
      lease.transact({
        kind: "transitionBatch",
        batchId: "batch:amber-apply-patch:11-12",
        from: "pending",
        to: "delivering",
        at: "2026-07-28T22:00:09.000Z",
      }),
    "batch_state",
  );
  await lease.close();
  await store.close();
}

/** Crash simulation is memory-specific (armCrash); F5 uses process kill points. */
async function contractCrashDiscardsInFlightChange(): Promise<void> {
  const store = new MemoryDurableStateStore({
    now: () => "2026-07-28T22:00:00.000Z",
    armCrash: "after_accept_before_cursor",
  });
  const lease = await store.open(SAMPLE_BINDING, "owner-a");
  await lease.transact({
    kind: "enqueueBatch",
    batch: sampleBatch({
      batchId: "batch:amber-apply-patch:20-20",
      firstMessageId: 20,
      lastMessageId: 20,
    }),
  });
  await expectCode(
    () =>
      lease.transact({
        kind: "acceptBatch",
        batchId: "batch:amber-apply-patch:20-20",
        turnId: "turn-crash",
        cursorMessageId: 20,
        at: "2026-07-28T22:00:03.000Z",
      }),
    "invalid_change",
  );
  const state = await lease.load();
  // Neither accept nor cursor advanced — atomic discard.
  assertEquals(state.cursor.lastMessageId, 0);
  assertEquals(state.batches[0].state, "pending");
  assertEquals(state.batches[0].acceptedTurnId, null);
  // Retry without crash succeeds.
  const ok = await lease.transact({
    kind: "acceptBatch",
    batchId: "batch:amber-apply-patch:20-20",
    turnId: "turn-ok",
    cursorMessageId: 20,
    at: "2026-07-28T22:00:04.000Z",
  });
  assertEquals(ok.cursor.lastMessageId, 20);
  assertEquals(ok.batches[0].state, "accepted");
  await lease.close();
  await store.close();
}

async function contractInvariantsDocumented(): Promise<void> {
  assertEquals(STORE_INVARIANTS.leaseRenewSeconds, 5);
  assertEquals(STORE_INVARIANTS.leaseTtlSeconds, 20);
  assertEquals(STORE_INVARIANTS.acceptAdvancesCursorAtomically, true);
  assertEquals(STORE_INVARIANTS.neverDiscardOutboxForGreenStartup, true);
  assert(
    STORE_INVARIANTS.crashPoints.includes("after_accept_before_cursor"),
    "crash point missing",
  );
}
