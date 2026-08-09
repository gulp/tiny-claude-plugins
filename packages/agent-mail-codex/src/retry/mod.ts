/**
 * L4: Clock + RetryPolicy — deterministic schedules with full jitter.
 * No sleeps here; callers schedule using nextDelayMs.
 */

export type InstantMs = number;

export interface Clock {
  now(): InstantMs;
}

/** Fake clock for tests — advance explicitly. */
export class FakeClock implements Clock {
  #now: InstantMs;
  constructor(start = 0) {
    this.#now = start;
  }
  now(): InstantMs {
    return this.#now;
  }
  advance(ms: number): void {
    if (ms < 0) throw new Error("cannot rewind FakeClock");
    this.#now += ms;
  }
  set(ms: InstantMs): void {
    this.#now = ms;
  }
}

export class SystemClock implements Clock {
  now(): InstantMs {
    return Date.now();
  }
}

export type RetryClass =
  | "connect"
  | "delivery"
  | "mailbox"
  | "lease"
  | "dead_letter";

export type FailureKind = "transient" | "permanent" | "ownership_lost" | "lease_lost";

export type RetryDecision =
  | {
    kind: "retry";
    attempt: number;
    delayMs: number;
    nextAttemptAt: InstantMs;
    class: RetryClass;
  }
  | {
    kind: "give_up";
    attempt: number;
    reason: "max_attempts" | "max_elapsed" | "permanent" | "ownership_lost" | "lease_lost";
    class: RetryClass;
  };

export type RetryClassConfig = {
  /** Base delay for attempt 1 (before jitter). */
  baseMs: number;
  /** Cap on exponential backoff (before jitter). */
  maxDelayMs: number;
  /** Maximum attempts including the first failure's first retry as attempt 1. */
  maxAttempts: number;
  /** Wall-clock budget from first failure. */
  maxElapsedMs: number;
};

export const DEFAULT_RETRY_CONFIG: Record<RetryClass, RetryClassConfig> = {
  connect: { baseMs: 250, maxDelayMs: 10_000, maxAttempts: 8, maxElapsedMs: 60_000 },
  delivery: { baseMs: 500, maxDelayMs: 10_000, maxAttempts: 8, maxElapsedMs: 600_000 },
  mailbox: { baseMs: 1_000, maxDelayMs: 1_000, maxAttempts: 3, maxElapsedMs: 10_000 },
  lease: { baseMs: 250, maxDelayMs: 3_000, maxAttempts: 5, maxElapsedMs: 15_000 },
  dead_letter: { baseMs: 1_000, maxDelayMs: 1_000, maxAttempts: 1, maxElapsedMs: 1_000 },
};

export type JitterFn = (maxExclusive: number) => number;

/** Full jitter: uniform in [0, delay] (AWS-style). */
export function fullJitter(delayMs: number, random: JitterFn): number {
  if (delayMs <= 0) return 0;
  return Math.floor(random(delayMs + 1));
}

export type RetryPolicyOptions = {
  clock: Clock;
  config?: Partial<Record<RetryClass, Partial<RetryClassConfig>>>;
  /** Deterministic RNG for tests: returns [0, maxExclusive). */
  random?: JitterFn;
};

type SeriesState = {
  class: RetryClass;
  attempt: number;
  firstFailureAt: InstantMs;
  cancelled: boolean;
  cancelReason?: "ownership_lost" | "lease_lost";
};

/**
 * One RetryPolicy instance tracks independent series keyed by id
 * (e.g. bindingId or batchId).
 */
export class RetryPolicy {
  readonly #clock: Clock;
  readonly #config: Record<RetryClass, RetryClassConfig>;
  readonly #random: JitterFn;
  readonly #series = new Map<string, SeriesState>();

  constructor(options: RetryPolicyOptions) {
    this.#clock = options.clock;
    this.#config = { ...DEFAULT_RETRY_CONFIG };
    if (options.config) {
      for (const key of Object.keys(options.config) as RetryClass[]) {
        this.#config[key] = { ...this.#config[key], ...options.config[key] };
      }
    }
    this.#random = options.random ?? ((max) => Math.floor(Math.random() * max));
  }

  reset(seriesId: string): void {
    this.#series.delete(seriesId);
  }

  /** Cancel retries after ownership or lease loss — next decide gives up. */
  cancel(seriesId: string, reason: "ownership_lost" | "lease_lost"): void {
    const existing = this.#series.get(seriesId);
    if (existing) {
      existing.cancelled = true;
      existing.cancelReason = reason;
    } else {
      this.#series.set(seriesId, {
        class: "delivery",
        attempt: 0,
        firstFailureAt: this.#clock.now(),
        cancelled: true,
        cancelReason: reason,
      });
    }
  }

  decide(
    seriesId: string,
    retryClass: RetryClass,
    failure: FailureKind,
  ): RetryDecision {
    if (failure === "permanent") {
      this.#series.delete(seriesId);
      return { kind: "give_up", attempt: 0, reason: "permanent", class: retryClass };
    }
    if (failure === "ownership_lost" || failure === "lease_lost") {
      this.cancel(seriesId, failure);
      return {
        kind: "give_up",
        attempt: this.#series.get(seriesId)?.attempt ?? 0,
        reason: failure,
        class: retryClass,
      };
    }

    let state = this.#series.get(seriesId);
    if (state?.cancelled) {
      const reason = state.cancelReason ?? "ownership_lost";
      this.#series.delete(seriesId);
      return { kind: "give_up", attempt: state.attempt, reason, class: retryClass };
    }

    if (!state || state.class !== retryClass) {
      state = {
        class: retryClass,
        attempt: 0,
        firstFailureAt: this.#clock.now(),
        cancelled: false,
      };
      this.#series.set(seriesId, state);
    }

    const cfg = this.#config[retryClass];
    state.attempt += 1;
    const elapsed = this.#clock.now() - state.firstFailureAt;

    if (state.attempt > cfg.maxAttempts) {
      this.#series.delete(seriesId);
      return {
        kind: "give_up",
        attempt: state.attempt,
        reason: "max_attempts",
        class: retryClass,
      };
    }
    if (elapsed > cfg.maxElapsedMs) {
      this.#series.delete(seriesId);
      return {
        kind: "give_up",
        attempt: state.attempt,
        reason: "max_elapsed",
        class: retryClass,
      };
    }

    // Exponential backoff: base * 2^(attempt-1), capped, then full jitter.
    const exp = Math.min(
      cfg.maxDelayMs,
      cfg.baseMs * 2 ** (state.attempt - 1),
    );
    const delayMs = fullJitter(exp, this.#random);
    return {
      kind: "retry",
      attempt: state.attempt,
      delayMs,
      nextAttemptAt: this.#clock.now() + delayMs,
      class: retryClass,
    };
  }
}
