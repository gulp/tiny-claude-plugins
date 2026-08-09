/**
 * K1: IngressKernel end-to-end with fake adapters.
 */
import { IngressKernel, type KernelBinding } from "../src/kernel/mod.ts";
import { FakeMailboxSource } from "../src/mailbox/fake.ts";
import { FakeThreadOwnerAdapter } from "../src/owner/fake.ts";
import { FakeClock } from "../src/retry/mod.ts";
import { MemoryDurableStateStore } from "../src/store/memory.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const BINDING: KernelBinding = {
  bindingId: "amber-apply-patch",
  agent: "AmberOtter",
  configHash: "hash-1",
  adapter: "headless-app-server-owner",
  threadId: "thread-k1",
  projectSlug: "home-fixture-project",
  projectPath: "/home/fixture/project",
};

function mail(
  id: number,
  subject: string,
  opts: { importance?: "normal" | "high" | "urgent"; ack?: boolean } = {},
) {
  return {
    messageId: id,
    projectSlug: "home-fixture-project",
    createdTs: `2026-07-28T10:00:${String(id).padStart(2, "0")}Z`,
    subject,
    importance: opts.importance ?? ("normal" as const),
    ackRequired: opts.ack ?? false,
  };
}

Deno.test("K1: baseline then idle delivery", async () => {
  const clock = new FakeClock(1_000_000);
  const mailbox = new FakeMailboxSource({
    records: [mail(10, "pre-existing")],
  });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () =>
      new FakeThreadOwnerAdapter({ now: () => new Date(clock.now()).toISOString() }),
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(20);
  // Pre-existing must not deliver; push new mail.
  mailbox.push(mail(11, "hello"));
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);
  assertEquals(result.baselineCursor, 10);
  assert(result.acceptedBatchIds.length >= 1, "accepted idle delivery");
  assert(!result.acceptedBatchIds.some((id) => id.includes(":10-10")), "no baseline replay");
});

Deno.test("K1: routine queues during active turn; urgent would steer", async () => {
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

  // First deliver a batch and leave turn active (no auto-complete).
  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  const owner = owners[0];
  assert(owner, "owner created");
  mailbox.push(mail(1, "first-idle"));
  await delay(40);
  assert(owner.eventHistory().some((e) => e.kind === "turnStarted"), "started");

  mailbox.push(mail(2, "routine-during-turn", { importance: "normal" }));
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.queuedBatchIds.length >= 1, `expected queue, got ${JSON.stringify(result)}`);
  owner.completeActiveTurn();
});

Deno.test("K1: ownership loss stops delivery", async () => {
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
  owners[0]?.simulateCompetingResponder();
  mailbox.push(mail(5, "after-loss", { importance: "urgent" }));
  await delay(50);
  ac.abort();
  const result = await run;
  assert(
    result.reason === "ownership_lost" || result.acceptedBatchIds.length === 0,
    `expected ownership stop, got ${JSON.stringify(result)}`,
  );
});

Deno.test("K1: poison skip is observed; shutdown clean", async () => {
  const clock = new FakeClock(4_000_000);
  const mailbox = new FakeMailboxSource({
    records: [
      mail(1, "ok"),
      {
        ...mail(2, "bad"),
        skip: "malformed_frontmatter",
      },
    ],
  });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () =>
      new FakeThreadOwnerAdapter({ now: () => new Date(clock.now()).toISOString() }),
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });
  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.ok || result.reason === "shutdown", result.reason);
  assert(
    result.deadLetterBatchIds.some((id) => id.includes("skip:")),
    "poison skip recorded",
  );
});

Deno.test("K1: nonzero batching window stages each source event once", async () => {
  const clock = new FakeClock(5_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () =>
      new FakeThreadOwnerAdapter({ now: () => new Date(clock.now()).toISOString() }),
    clock,
    batchWindowMs: 40,
    pollIntervalMs: 5,
  });
  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(21, "one event"));
  await delay(20);
  clock.advance(50);
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);

  const lease = await store.open({
    bindingId: BINDING.bindingId,
    agent: BINDING.agent,
    configHash: BINDING.configHash,
    adapter: BINDING.adapter,
    scopeJson: JSON.stringify({ kind: "project", projectPath: BINDING.projectPath }),
    threadId: BINDING.threadId,
  }, "inspect");
  const state = await lease.load();
  assertEquals(state.batches.length, 1);
  assertEquals(state.batches[0].eventIds, ["agent-mail:21"]);
  await lease.close();
});

Deno.test("K1: durable zero baseline preserves mail arriving while stopped", async () => {
  const clock = new FakeClock(6_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const makeKernel = () =>
    new IngressKernel({
      store,
      mailbox,
      createOwner: () =>
        new FakeThreadOwnerAdapter({ now: () => new Date(clock.now()).toISOString() }),
      clock,
      batchWindowMs: 0,
      pollIntervalMs: 5,
    });

  const firstAbort = new AbortController();
  const first = makeKernel().run(BINDING, firstAbort.signal);
  await delay(15);
  firstAbort.abort();
  await first;

  mailbox.push(mail(31, "arrived during downtime"));
  const secondAbort = new AbortController();
  const second = makeKernel().run(BINDING, secondAbort.signal);
  await delay(50);
  secondAbort.abort();
  const result = await second;
  assert(
    result.acceptedBatchIds.some((id) => id.includes(":31-31")),
    `downtime mail was not delivered: ${JSON.stringify(result)}`,
  );
});

Deno.test("K1: renews its own lease before the 20-second TTL", async () => {
  const clock = new FakeClock(7_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () =>
      new FakeThreadOwnerAdapter({ now: () => new Date(clock.now()).toISOString() }),
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 2,
  });
  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(10);
  for (let i = 0; i < 4; i++) {
    clock.advance(6_000);
    await delay(10);
  }
  mailbox.push(mail(41, "after original ttl"));
  await delay(30);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);
  assert(result.acceptedBatchIds.some((id) => id.includes(":41-41")), "lease expired");
});

Deno.test("K1: transient delivery retries the stable batch and continues", async () => {
  const clock = new FakeClock(8_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  let attempts = 0;
  const kernel = new IngressKernel({
    store,
    mailbox,
    createOwner: () => {
      const owner = new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
      });
      const start = owner.startTurn.bind(owner);
      owner.startTurn = (input, key) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("temporary reset"));
        return start(input, key);
      };
      return owner;
    },
    clock,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });
  const ac = new AbortController();
  const run = kernel.run(BINDING, ac.signal);
  await delay(15);
  mailbox.push(mail(51, "retry me"));
  await delay(30);
  clock.advance(11_000);
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);
  assertEquals(attempts, 2);
  assertEquals(result.deadLetterBatchIds, []);
  assert(result.acceptedBatchIds.some((id) => id.includes(":51-51")), "retry not accepted");
});

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
