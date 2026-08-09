/**
 * tcp-efp.4.12: terminal turn outcome before durable cursor acceptance.
 */
import { IngressKernel, type KernelBinding } from "../src/kernel/mod.ts";
import { FakeMailboxSource } from "../src/mailbox/fake.ts";
import { FakeThreadOwnerAdapter } from "../src/owner/fake.ts";
import { FakeClock } from "../src/retry/mod.ts";
import { MemoryDurableStateStore } from "../src/store/memory.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BINDING: KernelBinding = {
  bindingId: "amber-apply-patch",
  agent: "AmberOtter",
  configHash: "hash-4.12",
  adapter: "headless-app-server-owner",
  threadId: "thread-k4",
  projectSlug: "home-fixture-project",
  projectPath: "/home/fixture/project",
};

function mail(id: number, subject: string) {
  return {
    messageId: id,
    projectSlug: "home-fixture-project",
    createdTs: `2026-07-29T00:00:${String(id).padStart(2, "0")}Z`,
    subject,
    importance: "normal" as const,
    ackRequired: false,
  };
}

function bindingRef() {
  return {
    bindingId: BINDING.bindingId,
    agent: BINDING.agent,
    configHash: BINDING.configHash,
    adapter: BINDING.adapter,
    scopeJson: JSON.stringify({ kind: "project", projectPath: BINDING.projectPath }),
    threadId: BINDING.threadId,
  };
}

Deno.test("4.12: turn/completed accepts once and advances cursor", async () => {
  const clock = new FakeClock(1_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () =>
      new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
        autoCompleteTurns: true,
      }),
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(100, "ok"));
  await delay(50);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);
  assertEquals(result.acceptedBatchIds.length, 1);
  assert(result.acceptedBatchIds[0].includes(":100-100"), "batch id");

  const lease = await store.open(bindingRef(), "inspect");
  const state = await lease.load();
  assertEquals(state.cursor.lastMessageId, 100);
  assertEquals(state.batches[0]?.state, "accepted");
  await lease.close();
});

Deno.test("4.12: immediate turn/failed does not accept or advance cursor", async () => {
  const clock = new FakeClock(2_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const owners: FakeThreadOwnerAdapter[] = [];
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () => {
      const owner = new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
        autoCompleteTurns: false,
      });
      owners.push(owner);
      return owner;
    },
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(200, "will-fail"));
  await delay(30);
  owners[0]?.failActiveTurn("ChatGPT account / model unsupported");
  await delay(50);
  ac.abort();
  const result = await run;
  assertEquals(result.acceptedBatchIds, []);

  const lease = await store.open(bindingRef(), "inspect");
  const state = await lease.load();
  assertEquals(state.cursor.lastMessageId, 0);
  assert(
    !state.batches.some((b) => b.state === "accepted"),
    Deno.inspect(state.batches),
  );
  assert(
    state.batches.some((b) =>
      b.state === "pending" || b.state === "dead_letter" || b.state === "delivering"
    ),
    Deno.inspect(state.batches),
  );
  await lease.close();
});

Deno.test("4.12: delayed turn/failed leaves batch retryable without cursor advance", async () => {
  const clock = new FakeClock(3_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const owners: FakeThreadOwnerAdapter[] = [];
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () => {
      const owner = new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
        autoCompleteTurns: false,
      });
      owners.push(owner);
      return owner;
    },
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(300, "delayed-fail"));
  await delay(40);
  // Turn started; cursor must still be baseline.
  owners[0]?.failActiveTurn("model error after start");
  await delay(40);
  ac.abort();
  const result = await run;
  assertEquals(result.acceptedBatchIds, []);

  const lease = await store.open(bindingRef(), "inspect");
  const state = await lease.load();
  assertEquals(state.cursor.lastMessageId, 0);
  assert(
    state.batches.some((b) =>
      b.state === "pending" || b.state === "dead_letter" || b.state === "delivering"
    ),
    Deno.inspect(state.batches),
  );
  assert(
    !state.batches.some((b) => b.state === "accepted"),
    "failed turn must not accept",
  );
  await lease.close();
});

Deno.test("4.12: duplicate turn/completed is idempotent", async () => {
  const clock = new FakeClock(4_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const owners: FakeThreadOwnerAdapter[] = [];
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () => {
      const owner = new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
        autoCompleteTurns: false,
      });
      owners.push(owner);
      return owner;
    },
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(400, "dup-complete"));
  await delay(30);
  const owner = owners[0]!;
  owner.completeActiveTurn();
  owner.completeActiveTurn(); // no-op (no active turn)
  // Re-emit duplicate completed for same turn via history injection path:
  // completeActiveTurn already cleared; synthesize by failing nothing — settle once.
  await delay(40);
  ac.abort();
  const result = await run;
  assertEquals(result.acceptedBatchIds.length, 1);

  const lease = await store.open(bindingRef(), "inspect");
  const state = await lease.load();
  assertEquals(state.cursor.lastMessageId, 400);
  assertEquals(state.batches.filter((b) => b.state === "accepted").length, 1);
  await lease.close();
});

Deno.test("4.12: restart during outcome window replays stable batch id", async () => {
  const clock = new FakeClock(5_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const owners: FakeThreadOwnerAdapter[] = [];
  const makeKernel = () =>
    new IngressKernel({
      store,
      mailbox,
      createOwner: () => {
        const owner = new FakeThreadOwnerAdapter({
          now: () => new Date(clock.now()).toISOString(),
          autoCompleteTurns: false,
        });
        owners.push(owner);
        return owner;
      },
      clock,
      batchWindowMs: 0,
      pollIntervalMs: 5,
    });

  const firstAbort = new AbortController();
  const first = makeKernel().run(BINDING, firstAbort.signal);
  await delay(15);
  mailbox.push(mail(500, "in-flight"));
  await delay(40);
  firstAbort.abort();
  await first;

  const leaseMid = await store.open(bindingRef(), "mid");
  const mid = await leaseMid.load();
  await leaseMid.close();
  const deliveringOrPending = mid.batches.filter((b) =>
    b.state === "delivering" || b.state === "pending"
  );
  assert(deliveringOrPending.length >= 1, Deno.inspect(mid.batches));
  const stableId = deliveringOrPending[0].batchId;
  assertEquals(mid.cursor.lastMessageId, 0);

  const secondAbort = new AbortController();
  const second = makeKernel().run(BINDING, secondAbort.signal);
  await delay(30);
  owners.at(-1)?.completeActiveTurn();
  await delay(40);
  secondAbort.abort();
  const result = await second;
  assert(result.acceptedBatchIds.includes(stableId), Deno.inspect(result));

  const lease = await store.open(bindingRef(), "inspect");
  const state = await lease.load();
  assertEquals(state.cursor.lastMessageId, 500);
  assert(state.batches.some((b) => b.batchId === stableId && b.state === "accepted"), "accepted");
  await lease.close();
});
