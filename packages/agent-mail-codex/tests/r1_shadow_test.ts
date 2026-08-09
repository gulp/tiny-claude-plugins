/**
 * R1: shadow observation vs Claude-monitor reference comparison.
 */
import { FakeMailboxSource } from "../src/mailbox/fake.ts";
import { FakeClock } from "../src/retry/mod.ts";
import { MemoryDurableStateStore } from "../src/store/memory.ts";
import {
  compareShadowToReference,
  encodeShadowGateArtifact,
  runShadowObservation,
  type ShadowBinding,
} from "../src/verification/shadow.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message ?? "assertEquals"}: expected ${Deno.inspect(expected)}, got ${
        Deno.inspect(actual)
      }`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BINDING: ShadowBinding = {
  bindingId: "shadow-canary",
  agent: "AmberOtter",
  configHash: "hash-shadow-1",
  adapter: "headless-app-server-owner",
  projectSlug: "home-fixture-project",
  projectPath: "/home/fixture/project",
  threadId: "thread-shadow",
};

function mail(
  id: number,
  subject: string,
  opts: {
    importance?: "normal" | "high" | "urgent";
    ack?: boolean;
    projectSlug?: string;
    skip?: "malformed_frontmatter" | "subject_too_long";
  } = {},
) {
  return {
    messageId: id,
    projectSlug: opts.projectSlug ?? "home-fixture-project",
    createdTs: `2026-07-28T10:00:${String(id).padStart(2, "0")}Z`,
    subject,
    importance: opts.importance ?? ("normal" as const),
    ackRequired: opts.ack ?? false,
    skip: opts.skip,
  };
}

Deno.test("R1 compare: equal sets pass; missed/extra fail", () => {
  const pass = compareShadowToReference({
    shadowIds: new Set([1, 2, 3]),
    referenceIds: new Set([1, 2, 3]),
  });
  assert(pass.ok, "equal sets");
  assertEquals(pass.missedIds, []);
  assertEquals(pass.extraIds, []);

  const missed = compareShadowToReference({
    shadowIds: new Set([1, 2]),
    referenceIds: new Set([1, 2, 3]),
  });
  assert(!missed.ok, "missed must fail");
  assertEquals(missed.missedIds, [3]);

  const extra = compareShadowToReference({
    shadowIds: new Set([1, 2, 9]),
    referenceIds: new Set([1, 2]),
  });
  assert(!extra.ok, "extra must fail");
  assertEquals(extra.extraIds, [9]);

  const badScope = compareShadowToReference({
    shadowIds: new Set([1]),
    referenceIds: new Set([1]),
    wrongScopeIds: [1],
  });
  assert(!badScope.ok, "wrong-scope must fail");

  const silent = compareShadowToReference({
    shadowIds: new Set([1]),
    referenceIds: new Set([1]),
    malformedSilent: ["skip:agents/x/1.md"],
  });
  assert(!silent.ok, "malformed-silent must fail");
});

Deno.test("R1 shadow: observes new mail, never delivers, cursor stays 0", async () => {
  const clock = new FakeClock(5_000_000);
  const mailbox = new FakeMailboxSource({
    records: [mail(10, "pre-existing")],
  });
  // Same underlying mailbox as Claude-monitor oracle.
  const reference = mailbox;
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });

  const ac = new AbortController();
  const run = runShadowObservation({
    store,
    mailbox,
    referenceMailbox: reference,
    clock,
    binding: BINDING,
    signal: ac.signal,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });

  await delay(20);
  mailbox.push(mail(11, "shadow-hello"));
  mailbox.push(mail(12, "shadow-hello-2"));
  await delay(50);
  ac.abort();
  const result = await run;

  assert(result.ok, result.detail ?? result.reason);
  assertEquals(result.baselineCursor, 10);
  assert(result.observedIds.includes(11), `observed ${result.observedIds}`);
  assert(result.observedIds.includes(12), `observed ${result.observedIds}`);
  assert(!result.observedIds.includes(10), "baseline must not replay");
  assertEquals(result.deliveryCursor, 0, "delivery cursor must not advance");
  assertEquals(result.modelCalls, 0, "no Codex delivery");
  assert(result.batchesEnqueued.length >= 1, "shadow still batches");
  assert(result.compare.ok, JSON.stringify(result.compare));

  const artifact = encodeShadowGateArtifact(result);
  assert(artifact.includes('"gate": "r1-shadow"'), artifact);
  assert(artifact.includes('"deliveryEnabled": false'), artifact);
  assert(artifact.includes('"noCodexDelivery": true'), artifact);
});

Deno.test("R1 shadow: records malformed skips; silent drop fails compare", async () => {
  const clock = new FakeClock(6_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });

  const ac = new AbortController();
  const run = runShadowObservation({
    store,
    mailbox,
    referenceMailbox: mailbox,
    clock,
    binding: BINDING,
    signal: ac.signal,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });
  await delay(15);
  mailbox.push(mail(1, "ok"));
  mailbox.push(mail(2, "bad", { skip: "malformed_frontmatter" }));
  await delay(50);
  ac.abort();
  const result = await run;

  assert(result.ok, result.detail ?? result.reason);
  assertEquals(result.observedIds, [1]);
  assert(
    result.deadLetterSkips.some((s) => s.includes("2")),
    `expected skip for msg 2, got ${result.deadLetterSkips}`,
  );
  assertEquals(result.compare.malformedSilent, []);
});

Deno.test("R1 shadow: renews lease across TTL wall-clock", async () => {
  const clock = new FakeClock(8_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const ac = new AbortController();
  const run = runShadowObservation({
    store,
    mailbox,
    referenceMailbox: mailbox,
    clock,
    binding: BINDING,
    signal: ac.signal,
    batchWindowMs: 0,
    pollIntervalMs: 5,
  });
  // Advance past several 20s lease TTLs; renewals must keep the observer alive.
  for (let i = 0; i < 6; i++) {
    clock.advance(10_000);
    await delay(20);
  }
  mailbox.push(mail(90, "after-ttl-window"));
  await delay(40);
  ac.abort();
  const result = await run;
  assert(result.ok, result.detail ?? result.reason);
  assert(result.observedIds.includes(90), Deno.inspect(result.observedIds));
  assertEquals(result.deliveryCursor, 0);
  assertEquals(result.modelCalls, 0);
});

Deno.test("R1 shadow: lease conflict is loud", async () => {
  const clock = new FakeClock(7_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const held = await store.open(
    {
      bindingId: BINDING.bindingId,
      agent: BINDING.agent,
      configHash: BINDING.configHash,
      adapter: BINDING.adapter,
      scopeJson: JSON.stringify({
        kind: "project",
        projectPath: BINDING.projectPath,
      }),
      threadId: BINDING.threadId,
    },
    "other-owner",
  );

  const ac = new AbortController();
  const result = await runShadowObservation({
    store,
    mailbox,
    referenceMailbox: mailbox,
    clock,
    binding: BINDING,
    signal: ac.signal,
    pollIntervalMs: 5,
  });
  assert(!result.ok, "must fail");
  assertEquals(result.reason, "lease_lost");
  await held.close();
});
