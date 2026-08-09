/// <reference lib="deno.window" />

/**
 * C5: reconnect and ambiguous-acceptance reconciliation.
 */

import { FakeClock, RetryPolicy } from "../src/retry/mod.ts";
import {
  acceptanceAmbiguous,
  type InFlightDelivery,
  planEventReplay,
  planReconnect,
  ReconnectController,
  ReconnectError,
} from "../src/owner/reconnect.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function flight(
  boundary: InFlightDelivery["boundary"],
  turnId: string | null = null,
): InFlightDelivery {
  return {
    batchId: "batch:amber:10-10",
    idempotencyKey: "batch:amber:10-10#1",
    threadId: "thread-exact",
    turnId,
    boundary,
  };
}

Deno.test("C5 kill boundaries: no loss; ambiguous paths keep stable ids", () => {
  assertEquals(acceptanceAmbiguous("before_send"), false);
  assertEquals(acceptanceAmbiguous("after_write"), true);
  assertEquals(acceptanceAmbiguous("after_response"), true);
  assertEquals(acceptanceAmbiguous("after_commit"), false);

  const beforeSend = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "exact", threadId: "thread-exact" },
    inFlight: flight("before_send"),
    connectAttempts: 0,
  });
  assert(beforeSend.kind === "resume_exact", "resume");
  assertEquals(beforeSend.next, {
    kind: "retry_same_batch",
    batchId: "batch:amber:10-10",
    idempotencyKey: "batch:amber:10-10#1",
    threadId: "thread-exact",
    boundary: "before_send",
    stableReplay: true,
    ambiguous: false,
  });

  for (const boundary of ["after_write", "after_response"] as const) {
    const plan = planReconnect({
      bindingId: "b1",
      storedThreadId: "thread-exact",
      threadFate: { kind: "exact", threadId: "thread-exact" },
      inFlight: flight(boundary, boundary === "after_response" ? "turn-10" : null),
      connectAttempts: 1,
    });
    assert(plan.kind === "resume_exact", boundary);
    assert(plan.next.kind === "retry_same_batch", boundary);
    assertEquals(plan.next.batchId, "batch:amber:10-10");
    assertEquals(plan.next.idempotencyKey, "batch:amber:10-10#1");
    assertEquals(plan.next.stableReplay, true);
    assertEquals(plan.next.ambiguous, true);
  }

  const committed = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "exact", threadId: "thread-exact" },
    inFlight: flight("after_commit", "turn-10"),
    connectAttempts: 0,
  });
  assert(committed.kind === "resume_exact", "commit");
  assertEquals(committed.next, { kind: "continue", detail: "idle_after_commit" });
});

Deno.test("C5 permanent thread loss and mismatch stop without replacement", () => {
  assertEquals(
    planReconnect({
      bindingId: "b1",
      storedThreadId: "thread-exact",
      threadFate: { kind: "missing" },
      inFlight: flight("after_write"),
      connectAttempts: 0,
    }).kind,
    "stop",
  );
  const missing = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "missing" },
    inFlight: null,
    connectAttempts: 0,
  });
  assert(missing.kind === "stop", "missing");
  assertEquals(missing.reason, "permanent_thread_loss");

  const mismatch = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "mismatched", expected: "thread-exact", actual: "other" },
    inFlight: null,
    connectAttempts: 0,
  });
  assert(mismatch.kind === "stop", "mismatch");
  assertEquals(mismatch.reason, "thread_mismatch");
});

Deno.test("C5 event replay is bounded and ordered", () => {
  const plan = planEventReplay({
    afterMessageId: 10,
    maxEvents: 3,
    availableMessageIds: [5, 12, 11, 14, 13, 20],
  });
  assertEquals(plan, {
    messageIds: [11, 12, 13],
    truncated: true,
    nextAfterMessageId: 13,
  });

  const idle = planEventReplay({
    afterMessageId: 100,
    maxEvents: 10,
    availableMessageIds: [1, 2, 3],
  });
  assertEquals(idle, {
    messageIds: [],
    truncated: false,
    nextAfterMessageId: 100,
  });

  try {
    planEventReplay({ afterMessageId: 0, maxEvents: 0, availableMessageIds: [] });
    throw new Error("expected invalid_state");
  } catch (error) {
    assert(error instanceof ReconnectError, "ReconnectError");
    assertEquals(error.code, "invalid_state");
  }
});

Deno.test("C5 reconnect controller uses L4 connect retries and stops loudly", () => {
  const clock = new FakeClock(0);
  const retries = new RetryPolicy({
    clock,
    random: () => 0,
    config: {
      connect: { baseMs: 250, maxDelayMs: 10_000, maxAttempts: 3, maxElapsedMs: 60_000 },
    },
  });
  const ctl = new ReconnectController(retries, {
    bindingId: "amber",
    maxConnectAttempts: 8,
  });

  const first = ctl.onTransientDisconnect();
  assert(first.kind === "retry", "retry1");
  assertEquals(first.attempt, 1);

  clock.advance(250);
  assert(ctl.onTransientDisconnect().kind === "retry", "retry2");
  clock.advance(500);
  assert(ctl.onTransientDisconnect().kind === "retry", "retry3");
  clock.advance(1000);
  const exhausted = ctl.onTransientDisconnect();
  assert(exhausted.kind === "stop", "stop");
  if (exhausted.kind === "stop") {
    assertEquals(exhausted.reason, "max_reconnect");
  }

  const lost = new ReconnectController(
    new RetryPolicy({ clock: new FakeClock(0), random: () => 0 }),
    { bindingId: "lost" },
  );
  const ownershipLost = lost.onOwnershipLost();
  assert(ownershipLost.kind === "stop", "ownership stop");
  assertEquals(ownershipLost.reason, "ownership_lost");
  const permanent = lost.onPermanentThreadLoss("thread-x");
  assert(permanent.kind === "stop", "permanent stop");
  assertEquals(permanent.reason, "permanent_thread_loss");
});

Deno.test("C5 idle reconnect resumes exact thread then continues", () => {
  const plan = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "exact", threadId: "thread-exact" },
    inFlight: null,
    connectAttempts: 2,
  });
  assertEquals(plan, {
    kind: "resume_exact",
    threadId: "thread-exact",
    next: { kind: "continue", detail: "idle_clean" },
  });
});

Deno.test("C5 unknown acceptance retries the same batch only", () => {
  const plan = planReconnect({
    bindingId: "b1",
    storedThreadId: "thread-exact",
    threadFate: { kind: "exact", threadId: "thread-exact" },
    inFlight: flight("after_write"),
    connectAttempts: 0,
  });
  assert(
    plan.kind === "resume_exact" && plan.next.kind === "retry_same_batch",
    "retry same batch",
  );
  // Same batch id + idempotency key — never a fresh delivery identity.
  assertEquals(plan.next.batchId, plan.next.idempotencyKey.split("#")[0]);
  assertEquals(plan.next.ambiguous, true);
  assertEquals(plan.next.stableReplay, true);
});
