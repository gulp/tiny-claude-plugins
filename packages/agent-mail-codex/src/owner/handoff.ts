/** C6: explicit exclusive-handoff state machine. */

export type HandoffOwner = "headless" | "none" | "human";

export interface PendingDelivery {
  id: string;
  sequence: number;
}

export interface HandoffSnapshot {
  owner: HandoffOwner;
  threadId: string;
  activeTurnId: string | null;
  unresolvedRequestIds: string[];
  pending: PendingDelivery[];
}

export interface HandoffResult {
  owner: "human";
  threadId: string;
  resumeCommand: string;
}

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly code:
      | "active_turn"
      | "unresolved_requests"
      | "wrong_owner"
      | "overlap"
      | "thread_mismatch"
      | "delivery_blocked",
  ) {
    super(message);
    this.name = "HandoffError";
  }
}

export class ExclusiveHandoff {
  #owner: HandoffOwner = "headless";
  #threadId: string;
  #activeTurnId: string | null = null;
  #requests = new Set<string>();
  #pending: PendingDelivery[] = [];

  constructor(threadId: string) {
    if (!threadId.trim()) throw new TypeError("threadId must be non-empty");
    this.#threadId = threadId;
  }

  snapshot(): HandoffSnapshot {
    return {
      owner: this.#owner,
      threadId: this.#threadId,
      activeTurnId: this.#activeTurnId,
      unresolvedRequestIds: [...this.#requests].sort(),
      pending: [...this.#pending].sort((left, right) => left.sequence - right.sequence),
    };
  }

  setActiveTurn(turnId: string | null): void {
    this.#requireHeadless();
    this.#activeTurnId = turnId;
  }

  openRequest(requestId: string): void {
    this.#requireHeadless();
    this.#requests.add(requestId);
  }

  resolveRequest(requestId: string): void {
    this.#requests.delete(requestId);
  }

  enqueue(delivery: PendingDelivery): void {
    if (this.#pending.some((item) => item.id === delivery.id)) return;
    this.#pending.push(delivery);
  }

  takeNextForDelivery(): PendingDelivery | null {
    if (this.#owner !== "headless") {
      throw new HandoffError(
        `delivery blocked while owner is ${this.#owner}`,
        "delivery_blocked",
      );
    }
    this.#pending.sort((left, right) => left.sequence - right.sequence);
    return this.#pending.shift() ?? null;
  }

  /**
   * Explicit drain/release. Authority passes through owner=none before human.
   * Pending mail is preserved; only active protocol work blocks handoff.
   */
  releaseToHuman(): HandoffResult {
    this.#requireHeadless();
    if (this.#activeTurnId) {
      throw new HandoffError(
        `cannot hand off with active turn ${this.#activeTurnId}`,
        "active_turn",
      );
    }
    if (this.#requests.size > 0) {
      throw new HandoffError(
        `cannot hand off with unresolved requests: ${[...this.#requests].join(",")}`,
        "unresolved_requests",
      );
    }
    this.#owner = "none";
    const resumeCommand = `codex resume ${shellQuote(this.#threadId)}`;
    this.#owner = "human";
    return { owner: "human", threadId: this.#threadId, resumeCommand };
  }

  /** Reacquisition is always explicit and must name the exact durable thread. */
  reacquireHeadless(expectedThreadId: string): PendingDelivery[] {
    if (this.#owner === "headless") {
      throw new HandoffError("headless owner already active; overlap refused", "overlap");
    }
    if (this.#owner !== "human") {
      throw new HandoffError(`cannot reacquire from owner ${this.#owner}`, "wrong_owner");
    }
    if (expectedThreadId !== this.#threadId) {
      throw new HandoffError(
        `expected thread ${expectedThreadId} != durable ${this.#threadId}`,
        "thread_mismatch",
      );
    }
    this.#owner = "none";
    this.#owner = "headless";
    return [...this.#pending].sort((left, right) => left.sequence - right.sequence);
  }

  /** Process loss does not transfer authority or infer human completion. */
  recordDisconnect(): void {
    // Intentionally no state transition.
  }

  #requireHeadless(): void {
    if (this.#owner !== "headless") {
      throw new HandoffError(`headless operation while owner is ${this.#owner}`, "wrong_owner");
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
