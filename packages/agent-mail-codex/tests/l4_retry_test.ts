/**
 * L4: FakeClock + RetryPolicy tests.
 */
import { DEFAULT_RETRY_CONFIG, FakeClock, fullJitter, RetryPolicy } from "../src/retry/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

Deno.test("L4: full jitter stays in [0, delay]", () => {
  for (const delay of [0, 1, 10, 1000]) {
    for (let i = 0; i < 50; i++) {
      const j = fullJitter(delay, (max) => Math.floor(Math.random() * max));
      assert(j >= 0 && j <= delay, `jitter ${j} for delay ${delay}`);
    }
  }
  // Deterministic RNG: always pick max-1 → delay
  assertEquals(fullJitter(10, (max) => max - 1), 10);
  assertEquals(fullJitter(10, () => 0), 0);
});

Deno.test("L4: exponential backoff capped with deterministic jitter", () => {
  const clock = new FakeClock(1_000);
  // random always returns 0 → delayMs always 0 (lower bound of full jitter)
  const policy = new RetryPolicy({
    clock,
    random: () => 0,
  });
  const d1 = policy.decide("bind-a", "connect", "transient");
  assertEquals(d1.kind, "retry");
  if (d1.kind === "retry") {
    assertEquals(d1.attempt, 1);
    assertEquals(d1.delayMs, 0); // jittered to 0
    assertEquals(d1.nextAttemptAt, 1_000);
  }

  // Upper-bound RNG: delay == uncapped exp
  const policyHi = new RetryPolicy({
    clock,
    random: (max) => max - 1,
  });
  const hi1 = policyHi.decide("bind-b", "connect", "transient");
  assert(hi1.kind === "retry", "hi1 retry");
  if (hi1.kind === "retry") {
    assertEquals(hi1.delayMs, DEFAULT_RETRY_CONFIG.connect.baseMs); // 250
  }
  const hi2 = policyHi.decide("bind-b", "connect", "transient");
  assert(hi2.kind === "retry", "hi2 retry");
  if (hi2.kind === "retry") {
    assertEquals(hi2.delayMs, 500);
  }
  const hi3 = policyHi.decide("bind-b", "connect", "transient");
  assert(hi3.kind === "retry", "hi3 retry");
  if (hi3.kind === "retry") {
    assertEquals(hi3.delayMs, 1_000);
  }
});

Deno.test("L4: max attempts and max elapsed give up", () => {
  const clock = new FakeClock(0);
  const policy = new RetryPolicy({
    clock,
    random: () => 0,
    config: {
      delivery: { maxAttempts: 3, maxElapsedMs: 10_000, baseMs: 100, maxDelayMs: 100 },
    },
  });
  assertEquals(policy.decide("b1", "delivery", "transient").kind, "retry");
  assertEquals(policy.decide("b1", "delivery", "transient").kind, "retry");
  assertEquals(policy.decide("b1", "delivery", "transient").kind, "retry");
  const give = policy.decide("b1", "delivery", "transient");
  assertEquals(give.kind, "give_up");
  if (give.kind === "give_up") assertEquals(give.reason, "max_attempts");

  const policyTime = new RetryPolicy({
    clock,
    random: () => 0,
    config: {
      mailbox: { maxAttempts: 100, maxElapsedMs: 500, baseMs: 10, maxDelayMs: 10 },
    },
  });
  assertEquals(policyTime.decide("m1", "mailbox", "transient").kind, "retry");
  clock.advance(600);
  const timed = policyTime.decide("m1", "mailbox", "transient");
  assertEquals(timed.kind, "give_up");
  if (timed.kind === "give_up") assertEquals(timed.reason, "max_elapsed");
});

Deno.test("L4: permanent errors never retry; reset clears series", () => {
  const clock = new FakeClock();
  const policy = new RetryPolicy({ clock, random: () => 0 });
  const permanent = policy.decide("x", "delivery", "permanent");
  assertEquals(permanent.kind, "give_up");
  if (permanent.kind === "give_up") assertEquals(permanent.reason, "permanent");

  assertEquals(policy.decide("y", "delivery", "transient").kind, "retry");
  policy.reset("y");
  const again = policy.decide("y", "delivery", "transient");
  assert(again.kind === "retry", "retry after reset");
  if (again.kind === "retry") assertEquals(again.attempt, 1);
});

Deno.test("L4: ownership/lease loss cancels retries", () => {
  const clock = new FakeClock();
  const policy = new RetryPolicy({ clock, random: () => 0 });
  assertEquals(policy.decide("z", "connect", "transient").kind, "retry");
  const lost = policy.decide("z", "connect", "ownership_lost");
  assertEquals(lost.kind, "give_up");
  if (lost.kind === "give_up") assertEquals(lost.reason, "ownership_lost");

  const policy2 = new RetryPolicy({ clock, random: () => 0 });
  policy2.cancel("lease-1", "lease_lost");
  const cancelled = policy2.decide("lease-1", "lease", "transient");
  assertEquals(cancelled.kind, "give_up");
  if (cancelled.kind === "give_up") assertEquals(cancelled.reason, "lease_lost");
});

Deno.test("L4: FakeClock advances monotonically", () => {
  const clock = new FakeClock(100);
  assertEquals(clock.now(), 100);
  clock.advance(50);
  assertEquals(clock.now(), 150);
  try {
    clock.advance(-1);
    throw new Error("expected throw");
  } catch (error) {
    assert(error instanceof Error && error.message.includes("rewind"), String(error));
  }
});
