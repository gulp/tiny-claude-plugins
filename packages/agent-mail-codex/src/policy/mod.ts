/**
 * L2: DeliveryPolicy — pure state machine for when to start/steer/queue.
 */

import type { DeliveryBatch, MailEvent, ThreadSnapshot } from "../schemas/mod.ts";

export type BatchUrgency = "urgent" | "routine";

export type QueueReason =
  | "routine_during_turn"
  | "human_owner"
  | "owner_none"
  | "human_gate"
  | "status_unknown"
  | "missing_turn_id"
  | "expected_turn_race";

export type HumanGate = "approval" | "user_input" | "plan_decision";

/** Thread view for policy — F2 snapshot plus optional gates / unknown flag. */
export type ThreadDeliveryView = ThreadSnapshot & {
  /** True when App Server status could not be proven — never guess. */
  statusUnknown?: boolean;
  /** Human-facing interactive gates; always beat mail delivery. */
  humanGate?: HumanGate | null;
};

export type DeliveryAction =
  | { kind: "startTurn"; batch: DeliveryBatch }
  | { kind: "steerTurn"; turnId: string; batch: DeliveryBatch }
  | { kind: "queue"; reason: QueueReason; batch: DeliveryBatch }
  | { kind: "deadLetter"; reason: string; batch: DeliveryBatch };

export interface DeliveryPolicy {
  decide(
    batch: DeliveryBatch,
    thread: ThreadDeliveryView,
    urgency: BatchUrgency,
  ): DeliveryAction;
}

/** Urgent = importance in {high, urgent} OR ack_required === true. */
export function urgencyFromEvents(events: readonly MailEvent[]): BatchUrgency {
  for (const event of events) {
    if (
      event.importance === "high" ||
      event.importance === "urgent" ||
      event.ackRequired === true
    ) {
      return "urgent";
    }
  }
  return "routine";
}

export class DefaultDeliveryPolicy implements DeliveryPolicy {
  decide(
    batch: DeliveryBatch,
    thread: ThreadDeliveryView,
    urgency: BatchUrgency,
  ): DeliveryAction {
    if (thread.statusUnknown) {
      return { kind: "queue", reason: "status_unknown", batch };
    }
    if (thread.owner === "human") {
      return { kind: "queue", reason: "human_owner", batch };
    }
    if (thread.owner === "none") {
      return { kind: "queue", reason: "owner_none", batch };
    }
    if (thread.humanGate) {
      return { kind: "queue", reason: "human_gate", batch };
    }

    // Headless owner from here.
    const active = !thread.idle && thread.activeTurnId !== null;
    const idle = thread.idle && thread.activeTurnId === null;

    if (!idle && !active) {
      // Contradictory snapshot — refresh, do not guess.
      return { kind: "queue", reason: "status_unknown", batch };
    }

    if (idle) {
      return { kind: "startTurn", batch };
    }

    // Active turn.
    if (urgency === "routine") {
      return { kind: "queue", reason: "routine_during_turn", batch };
    }

    const turnId = thread.activeTurnId;
    if (!turnId) {
      return { kind: "queue", reason: "missing_turn_id", batch };
    }
    return { kind: "steerTurn", turnId, batch };
  }
}

/**
 * After a status refresh, re-decide. If an urgent steer was intended but the
 * expected turn id no longer matches the live active turn, queue (race).
 */
export function decideAfterRefresh(
  policy: DeliveryPolicy,
  batch: DeliveryBatch,
  previous: ThreadDeliveryView,
  refreshed: ThreadDeliveryView,
  urgency: BatchUrgency,
): DeliveryAction {
  const prior = policy.decide(batch, previous, urgency);
  const next = policy.decide(batch, refreshed, urgency);
  if (
    prior.kind === "steerTurn" &&
    next.kind === "steerTurn" &&
    prior.turnId !== next.turnId
  ) {
    return { kind: "queue", reason: "expected_turn_race", batch };
  }
  if (prior.kind === "steerTurn" && next.kind !== "steerTurn") {
    return { kind: "queue", reason: "expected_turn_race", batch };
  }
  return next;
}
