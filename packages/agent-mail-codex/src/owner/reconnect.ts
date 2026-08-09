/**
 * C5: reconnect + ambiguous-acceptance reconciliation for the headless owner.
 *
 * At-least-once only: never claim exactly-once. After a disconnect at any
 * send/write/response/commit boundary, retry the same batch/idempotency key or
 * resume the exact stored thread. Never invent a replacement thread.
 */

import type { RetryDecision, RetryPolicy } from "../retry/mod.ts";

/** Where the owner died relative to one delivery attempt. */
export type KillBoundary =
  | "before_send"
  | "after_write"
  | "after_response"
  | "after_commit";

export type ThreadFate =
  | { kind: "exact"; threadId: string }
  | { kind: "missing" }
  | { kind: "mismatched"; expected: string; actual: string };

export type InFlightDelivery = {
  batchId: string;
  idempotencyKey: string;
  threadId: string;
  /** Present only once App Server returned an acceptance. */
  turnId: string | null;
  boundary: KillBoundary;
};

export type ReconnectInput = {
  bindingId: string;
  storedThreadId: string;
  /** Fate of exact resume after reconnect. */
  threadFate: ThreadFate;
  /** Outstanding delivery when the process died; null if idle. */
  inFlight: InFlightDelivery | null;
  /** How many connect attempts have already been recorded for this outage. */
  connectAttempts: number;
};

export type ReconnectAction =
  | {
    kind: "continue";
    detail: "idle_after_commit" | "idle_clean";
  }
  | {
    kind: "retry_same_batch";
    batchId: string;
    idempotencyKey: string;
    threadId: string;
    boundary: KillBoundary;
    /** Always true: ambiguous paths must reuse stable ids. */
    stableReplay: true;
    /** True when App Server may already have accepted the turn. */
    ambiguous: boolean;
  }
  | {
    kind: "resume_exact";
    threadId: string;
    next: Extract<ReconnectAction, { kind: "retry_same_batch" | "continue" }>;
  }
  | {
    kind: "stop";
    reason:
      | "permanent_thread_loss"
      | "thread_mismatch"
      | "max_reconnect"
      | "ownership_lost";
    detail: string;
  };

export class ReconnectError extends Error {
  constructor(
    message: string,
    readonly code:
      | "permanent_thread_loss"
      | "thread_mismatch"
      | "max_reconnect"
      | "invalid_state",
  ) {
    super(message);
    this.name = "ReconnectError";
  }
}

/**
 * Classify whether a kill boundary leaves acceptance ambiguous.
 * after_write: bytes may have reached App Server; response unknown.
 * after_response: acceptance known locally but durable commit may be missing.
 */
export function acceptanceAmbiguous(boundary: KillBoundary): boolean {
  return boundary === "after_write" || boundary === "after_response";
}

/**
 * Pure plan for one reconnect cycle. Does not sleep, open sockets, or start threads.
 */
export function planReconnect(input: ReconnectInput): ReconnectAction {
  if (input.threadFate.kind === "missing") {
    return {
      kind: "stop",
      reason: "permanent_thread_loss",
      detail:
        `stored thread ${input.storedThreadId} is gone; replacement thread creation forbidden`,
    };
  }
  if (input.threadFate.kind === "mismatched") {
    return {
      kind: "stop",
      reason: "thread_mismatch",
      detail:
        `expected ${input.threadFate.expected}, App Server returned ${input.threadFate.actual}; refuse replacement`,
    };
  }

  const threadId = input.threadFate.threadId;
  if (threadId !== input.storedThreadId) {
    return {
      kind: "stop",
      reason: "thread_mismatch",
      detail: `resume returned ${threadId}, stored ${input.storedThreadId}`,
    };
  }

  const afterResume = planAfterExactResume(input.inFlight, threadId);
  return {
    kind: "resume_exact",
    threadId,
    next: afterResume,
  };
}

function planAfterExactResume(
  inFlight: InFlightDelivery | null,
  threadId: string,
): Extract<ReconnectAction, { kind: "retry_same_batch" | "continue" }> {
  if (!inFlight) {
    return { kind: "continue", detail: "idle_clean" };
  }
  if (inFlight.threadId !== threadId) {
    // Should have been caught as mismatch earlier; keep fail-closed.
    throw new ReconnectError(
      `in-flight thread ${inFlight.threadId} != resumed ${threadId}`,
      "thread_mismatch",
    );
  }
  if (inFlight.boundary === "after_commit") {
    return { kind: "continue", detail: "idle_after_commit" };
  }
  if (inFlight.boundary === "before_send") {
    return {
      kind: "retry_same_batch",
      batchId: inFlight.batchId,
      idempotencyKey: inFlight.idempotencyKey,
      threadId,
      boundary: "before_send",
      stableReplay: true,
      ambiguous: false,
    };
  }
  // after_write / after_response — same ids only; at-least-once.
  return {
    kind: "retry_same_batch",
    batchId: inFlight.batchId,
    idempotencyKey: inFlight.idempotencyKey,
    threadId,
    boundary: inFlight.boundary,
    stableReplay: true,
    ambiguous: true,
  };
}

export type EventReplayBudget = {
  /** Inclusive lower bound (exclusive cursor semantics: events with id > cursor). */
  afterMessageId: number;
  /** Hard cap on events replayed into one reconnect drain. */
  maxEvents: number;
  availableMessageIds: number[];
};

export type EventReplayPlan = {
  messageIds: number[];
  truncated: boolean;
  nextAfterMessageId: number;
};

/** Bound event replay after reconnect so recovery stays finite. */
export function planEventReplay(budget: EventReplayBudget): EventReplayPlan {
  if (budget.maxEvents <= 0) {
    throw new ReconnectError("maxEvents must be positive", "invalid_state");
  }
  const pending = budget.availableMessageIds
    .filter((id) => id > budget.afterMessageId)
    .sort((a, b) => a - b);
  const messageIds = pending.slice(0, budget.maxEvents);
  const truncated = pending.length > messageIds.length;
  const nextAfterMessageId = messageIds.length > 0
    ? messageIds[messageIds.length - 1]!
    : budget.afterMessageId;
  return { messageIds, truncated, nextAfterMessageId };
}

/**
 * Drive connect-class retries via L4. Permanent thread loss / ownership loss
 * cancel the series; never falls back to exec-resume or a new thread.
 */
export class ReconnectController {
  #retries: RetryPolicy;
  #seriesId: string;
  #maxConnectAttempts: number;

  constructor(
    retries: RetryPolicy,
    options: { bindingId: string; maxConnectAttempts?: number },
  ) {
    this.#retries = retries;
    this.#seriesId = `reconnect:${options.bindingId}`;
    this.#maxConnectAttempts = options.maxConnectAttempts ?? 8;
  }

  /** Record a transient disconnect and obtain the next connect delay, or stop. */
  onTransientDisconnect(): RetryDecision | ReconnectAction {
    const decision = this.#retries.decide(this.#seriesId, "connect", "transient");
    if (decision.kind === "give_up") {
      return {
        kind: "stop",
        reason: "max_reconnect",
        detail: `connect retries exhausted (${decision.reason})`,
      };
    }
    if (decision.attempt > this.#maxConnectAttempts) {
      this.#retries.cancel(this.#seriesId, "ownership_lost");
      return {
        kind: "stop",
        reason: "max_reconnect",
        detail: `connect attempt ${decision.attempt} exceeds cap ${this.#maxConnectAttempts}`,
      };
    }
    return decision;
  }

  onOwnershipLost(): ReconnectAction {
    this.#retries.cancel(this.#seriesId, "ownership_lost");
    return {
      kind: "stop",
      reason: "ownership_lost",
      detail: "ownership lost; refuse reconnect delivery until explicit reacquire",
    };
  }

  onPermanentThreadLoss(threadId: string): ReconnectAction {
    this.#retries.cancel(this.#seriesId, "ownership_lost");
    return {
      kind: "stop",
      reason: "permanent_thread_loss",
      detail: `thread ${threadId} permanently unavailable; no replacement`,
    };
  }

  /** Successful exact resume clears the connect series. */
  onResumed(): void {
    this.#retries.reset(this.#seriesId);
  }
}
