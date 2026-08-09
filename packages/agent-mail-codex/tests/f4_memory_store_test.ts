/**
 * F4: in-memory DurableStateStore + reusable contract suite.
 */
import { runDurableStateStoreContract } from "../src/store/contract.ts";
import { MemoryDurableStateStore } from "../src/store/memory.ts";
import { STORE_INVARIANTS, StoreError } from "../src/store/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

Deno.test("F4: MemoryDurableStateStore passes store contract suite", async () => {
  await runDurableStateStoreContract();
});

Deno.test("F4: fake clock drives lease TTL expiry then re-open", async () => {
  let nowMs = Date.parse("2026-07-28T22:00:00.000Z");
  const store = new MemoryDurableStateStore({
    now: () => new Date(nowMs).toISOString(),
  });
  const binding = {
    bindingId: "clock-binding",
    agent: "AmberOtter",
    configHash: "h1",
    adapter: "headless-app-server-owner",
    scopeJson: "{}",
    threadId: null,
  };
  const a = await store.open(binding, "owner-a");
  const lease = (await a.load()).lease;
  assert(lease !== null, "lease expected");
  assertEquals(STORE_INVARIANTS.leaseTtlSeconds, 20);

  // Advance past TTL without closing handle — next load fails lease_lost.
  nowMs += (STORE_INVARIANTS.leaseTtlSeconds + 1) * 1000;
  try {
    await a.load();
    throw new Error("expected lease_lost");
  } catch (error) {
    assert(error instanceof StoreError, "StoreError");
    assertEquals(error.code, "lease_lost");
  }

  // New owner can open after expiry.
  const b = await store.open(binding, "owner-b");
  assertEquals((await b.load()).lease?.ownerId, "owner-b");
  await b.close();
  await store.close();
});

Deno.test("F4: renewLease extends expiry under fake clock", async () => {
  const store = new MemoryDurableStateStore({
    now: () => "2026-07-28T22:00:00.000Z",
  });
  const binding = {
    bindingId: "renew-binding",
    agent: "AmberOtter",
    configHash: "h1",
    adapter: "headless-app-server-owner",
    scopeJson: "{}",
    threadId: "t1",
  };
  const lease = await store.open(binding, "owner-a");
  const renewed = await lease.transact({
    kind: "renewLease",
    ownerId: "owner-a",
    expiresAt: "2026-07-28T22:00:25.000Z",
    heartbeatAt: "2026-07-28T22:00:05.000Z",
  });
  assertEquals(renewed.lease?.expiresAt, "2026-07-28T22:00:25.000Z");
  assertEquals(renewed.lease?.heartbeatAt, "2026-07-28T22:00:05.000Z");
  await lease.close();
  await store.close();
});
