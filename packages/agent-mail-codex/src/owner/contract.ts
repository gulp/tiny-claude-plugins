/**
 * Reusable ThreadOwnerAdapter contract suite (C1).
 * Call with any adapter factory that produces a fresh exclusive-handoff owner.
 */

import { DOMAIN_SCHEMA_VERSION, type ThreadBinding } from "../schemas/mod.ts";
import { FakeThreadOwnerAdapter } from "./fake.ts";
import { type ModelInput, OwnershipError, type ThreadOwnerAdapter } from "./types.ts";

export type OwnerFactory = () => ThreadOwnerAdapter;

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
  code: OwnershipError["code"],
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected OwnershipError ${code}`);
  } catch (error) {
    assert(error instanceof OwnershipError, `expected OwnershipError, got ${error}`);
    assertEquals(error.code, code);
  }
}

const SAMPLE_BINDING: ThreadBinding = {
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  bindingId: "amber-apply-patch",
  agent: "AmberOtter",
  projectSlug: "home-gulp-projects-apply-patch",
  threadId: "thread-durable-c1",
  ownershipModel: "exclusive-handoff",
};

const SAMPLE_INPUT: ModelInput = {
  schemaVersion: 1,
  text: "<agent_mail_events>untrusted</agent_mail_events>",
  byteLength: 48,
};

/** Run the full C1 contract against a factory (default: FakeThreadOwnerAdapter). */
export async function runThreadOwnerContract(
  factory: OwnerFactory = () =>
    new FakeThreadOwnerAdapter({
      now: () => "2026-07-28T22:00:00.000Z",
      autoCompleteTurns: false,
    }),
): Promise<void> {
  await contractConnectAcquireRelease(factory);
  await contractExactThreadAndSnapshot(factory);
  await contractStartSteerIdempotency(factory);
  await contractFailClosedWithoutProof(factory);
  await contractCompetingResponder(factory);
  await contractServerRequests(factory);
  await contractEventsAndClose(factory);
}

async function contractConnectAcquireRelease(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  await expectCode(() => owner.acquireOwnership(), "not_connected");
  await owner.connect(SAMPLE_BINDING);
  const proof = await owner.acquireOwnership();
  assertEquals(proof.mode, "exclusive-handoff");
  assertEquals(proof.owner, "headless");
  assertEquals(proof.subscriberCount, 1);
  assertEquals(proof.competingResponder, false);
  assertEquals(proof.threadId, SAMPLE_BINDING.threadId);
  await owner.releaseOwnership();
  const snap = await owner.snapshot();
  assertEquals(snap.owner, "none");
  await owner.close();
}

async function contractExactThreadAndSnapshot(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  await owner.connect(SAMPLE_BINDING);
  await owner.acquireOwnership();
  const snap = await owner.snapshot();
  assertEquals(snap.threadId, "thread-durable-c1");
  assertEquals(snap.idle, true);
  assertEquals(snap.activeTurnId, null);
  assertEquals(snap.owner, "headless");
  await owner.close();
}

async function contractStartSteerIdempotency(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  await owner.connect(SAMPLE_BINDING);
  await owner.acquireOwnership();
  const key = "batch:amber:1-1#1";
  const a1 = await owner.startTurn(SAMPLE_INPUT, key);
  assert(a1.turnId.length > 0, "turnId");
  const a2 = await owner.startTurn(SAMPLE_INPUT, key);
  assertEquals(a1, a2, "idempotent startTurn");
  await expectCode(
    () => owner.startTurn(SAMPLE_INPUT, "batch:amber:1-1#2"),
    "turn_mismatch",
  );
  const steerKey = "batch:amber:2-2#1";
  const s1 = await owner.steerTurn(a1.turnId, SAMPLE_INPUT, steerKey);
  assertEquals(s1.turnId, a1.turnId);
  await expectCode(
    () => owner.steerTurn("wrong-turn", SAMPLE_INPUT, "batch:amber:2-2#2"),
    "turn_mismatch",
  );
  if (owner instanceof FakeThreadOwnerAdapter) {
    owner.completeActiveTurn();
  }
  await owner.releaseOwnership();
  await owner.close();
}

async function contractFailClosedWithoutProof(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  await owner.connect(SAMPLE_BINDING);
  await expectCode(() => owner.startTurn(SAMPLE_INPUT, "k"), "not_acquired");
  await expectCode(
    () => owner.steerTurn("t", SAMPLE_INPUT, "k2"),
    "not_acquired",
  );
  await owner.close();
}

async function contractCompetingResponder(factory: OwnerFactory): Promise<void> {
  if (!(factory() instanceof FakeThreadOwnerAdapter)) {
    // Production adapters prove this under C5/C6; fake covers the contract shape.
    return;
  }
  const competing = new FakeThreadOwnerAdapter({
    competingResponder: true,
    now: () => "2026-07-28T22:00:00.000Z",
  });
  await competing.connect(SAMPLE_BINDING);
  await expectCode(() => competing.acquireOwnership(), "competing_responder");
  await competing.close();

  const owner = new FakeThreadOwnerAdapter({ now: () => "2026-07-28T22:00:00.000Z" });
  await owner.connect(SAMPLE_BINDING);
  await owner.acquireOwnership();
  owner.simulateCompetingResponder();
  // Loss clears acquire immediately; subsequent delivery fails closed (not_acquired).
  await expectCode(() => owner.startTurn(SAMPLE_INPUT, "lost"), "not_acquired");
  const lost = owner.eventHistory().some((e) => e.kind === "ownershipLost");
  assert(lost, "ownershipLost event required");
  await owner.close();
}

async function contractServerRequests(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  if (!(owner instanceof FakeThreadOwnerAdapter)) return;
  await owner.connect(SAMPLE_BINDING);
  await owner.acquireOwnership();
  owner.injectServerRequest({
    id: "req-1",
    type: "elicitation",
    method: "mcpServer/elicitation/request",
  });
  await owner.respondToServerRequest("req-1", { kind: "cancel" });
  assertEquals(owner.answeredRequests().get("req-1")?.kind, "cancel");
  await expectCode(
    () => owner.respondToServerRequest("missing", { kind: "decline" }),
    "proof_failed",
  );
  await owner.close();
}

async function contractEventsAndClose(factory: OwnerFactory): Promise<void> {
  const owner = factory();
  if (!(owner instanceof FakeThreadOwnerAdapter)) {
    await owner.connect(SAMPLE_BINDING);
    await owner.close();
    await expectCode(() => owner.connect(SAMPLE_BINDING), "closed");
    return;
  }
  await owner.connect(SAMPLE_BINDING);
  await owner.acquireOwnership();
  const ac = new AbortController();
  const iter = owner.events(ac.signal);
  const reader = iter[Symbol.asyncIterator]();
  const started = owner.startTurn(SAMPLE_INPUT, "batch:e:1-1#1");
  const first = await reader.next();
  assert(!first.done, "expected turnStarted");
  assertEquals(first.value.kind, "turnStarted");
  await started;
  owner.completeActiveTurn();
  const second = await reader.next();
  assertEquals(second.value.kind, "turnCompleted");
  await owner.close();
  const third = await reader.next();
  assertEquals(third.value.kind, "disconnected");
  ac.abort();
  await expectCode(() => owner.acquireOwnership(), "closed");
}
