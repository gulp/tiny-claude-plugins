/// <reference lib="deno.window" />

import { ExclusiveHandoff, HandoffError, type HandoffSnapshot } from "../src/owner/handoff.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function expectCode(fn: () => unknown, code: HandoffError["code"]): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof HandoffError)) throw error;
    assertEquals(error.code, code);
  }
}

Deno.test("C6 handoff refuses active turn and unresolved requests", () => {
  const active = new ExclusiveHandoff("thread-1");
  active.setActiveTurn("turn-1");
  expectCode(() => active.releaseToHuman(), "active_turn");
  assertEquals(active.snapshot().owner, "headless");

  const request = new ExclusiveHandoff("thread-1");
  request.openRequest("approval-1");
  expectCode(() => request.releaseToHuman(), "unresolved_requests");
  request.resolveRequest("approval-1");
  assertEquals(request.releaseToHuman().owner, "human");
});

Deno.test("C6 explicit handoff prints exact resume and preserves queue", () => {
  const handoff = new ExclusiveHandoff("thread durable 'quoted'");
  handoff.enqueue({ id: "later", sequence: 2 });
  handoff.enqueue({ id: "first", sequence: 1 });
  const result = handoff.releaseToHuman();
  assertEquals(result, {
    owner: "human",
    threadId: "thread durable 'quoted'",
    resumeCommand: "codex resume 'thread durable '\\''quoted'\\'''",
  });
  assertEquals(handoff.snapshot().pending, [
    { id: "first", sequence: 1 },
    { id: "later", sequence: 2 },
  ]);
  expectCode(() => handoff.takeNextForDelivery(), "delivery_blocked");
});

Deno.test("C6 overlap and wrong-thread reacquire fail loudly", () => {
  const alreadyHeadless = new ExclusiveHandoff("thread-1");
  expectCode(() => alreadyHeadless.reacquireHeadless("thread-1"), "overlap");

  const human = new ExclusiveHandoff("thread-1");
  human.releaseToHuman();
  expectCode(() => human.reacquireHeadless("other-thread"), "thread_mismatch");
  assertEquals(human.snapshot().owner, "human");
});

Deno.test("C6 explicit reacquire drains preserved queue in order", () => {
  const handoff = new ExclusiveHandoff("thread-1");
  handoff.enqueue({ id: "three", sequence: 3 });
  handoff.enqueue({ id: "one", sequence: 1 });
  handoff.enqueue({ id: "two", sequence: 2 });
  handoff.releaseToHuman();
  assertEquals(handoff.reacquireHeadless("thread-1"), [
    { id: "one", sequence: 1 },
    { id: "two", sequence: 2 },
    { id: "three", sequence: 3 },
  ]);
  assertEquals(handoff.takeNextForDelivery()?.id, "one");
  assertEquals(handoff.takeNextForDelivery()?.id, "two");
  assertEquals(handoff.takeNextForDelivery()?.id, "three");
});

Deno.test("C6 disconnect never implies handoff or reacquire", () => {
  const headless = new ExclusiveHandoff("thread-1");
  headless.recordDisconnect();
  assertEquals(headless.snapshot().owner, "headless");

  const human = new ExclusiveHandoff("thread-1");
  human.releaseToHuman();
  human.recordDisconnect();
  const snapshot: HandoffSnapshot = human.snapshot();
  assertEquals(snapshot.owner, "human");
});
