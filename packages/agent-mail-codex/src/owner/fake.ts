/**
 * Deterministic FakeThreadOwnerAdapter for contract tests (C1).
 * No JSON-RPC, no filesystem, no SQLite.
 */

import type { Acceptance, OwnershipProof, ThreadBinding, ThreadSnapshot } from "../schemas/mod.ts";
import { DOMAIN_SCHEMA_VERSION } from "../schemas/mod.ts";
import {
  type ModelInput,
  OwnershipError,
  type ServerRequest,
  type ServerRequestResponse,
  type ThreadEvent,
  type ThreadOwnerAdapter,
} from "./types.ts";

export interface FakeOwnerOptions {
  /** When true, acquireOwnership fails with competing_responder. */
  competingResponder?: boolean;
  /** Override clock for provenAt / acceptedAt. */
  now?: () => string;
  /**
   * When true (default), emit turnCompleted after startTurn via microtask so the
   * kernel can wait for a terminal outcome without a test harness hook.
   * Set false to keep the turn active for queue/steer tests.
   */
  autoCompleteTurns?: boolean;
}

type Waiter = {
  push: (event: ThreadEvent) => void;
  close: () => void;
};

export class FakeThreadOwnerAdapter implements ThreadOwnerAdapter {
  #binding: ThreadBinding | null = null;
  #connected = false;
  #acquired = false;
  #closed = false;
  #owner: ThreadSnapshot["owner"] = "none";
  #activeTurnId: string | null = null;
  #turnSeq = 0;
  #idempotency = new Map<string, Acceptance>();
  #openRequests = new Map<string, ServerRequest>();
  #answered = new Map<string, ServerRequestResponse>();
  #waiters = new Set<Waiter>();
  #history: ThreadEvent[] = [];
  #competing: boolean;
  #now: () => string;
  #autoCompleteTurns: boolean;

  constructor(options: FakeOwnerOptions = {}) {
    this.#competing = options.competingResponder ?? false;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#autoCompleteTurns = options.autoCompleteTurns ?? true;
  }

  /** Test seam: inject a competing client while acquired. */
  simulateCompetingResponder(): void {
    this.#competing = true;
    if (this.#acquired) {
      this.#acquired = false;
      this.#owner = "none";
      this.#emit({
        kind: "ownershipLost",
        at: this.#now(),
        detail: "competing responder detected",
      });
    }
  }

  /** Test seam: inject a server-initiated request. */
  injectServerRequest(request: ServerRequest): void {
    this.#requireLive();
    if (!this.#acquired) {
      throw new OwnershipError("cannot inject server request without ownership", "not_acquired");
    }
    this.#openRequests.set(request.id, request);
    this.#emit({ kind: "serverRequest", request, at: this.#now() });
  }

  /** Test seam: inspect answered server requests. */
  answeredRequests(): ReadonlyMap<string, ServerRequestResponse> {
    return this.#answered;
  }

  eventHistory(): readonly ThreadEvent[] {
    return this.#history;
  }

  async connect(binding: ThreadBinding): Promise<void> {
    this.#requireNotClosed();
    if (binding.ownershipModel !== "exclusive-handoff") {
      throw new OwnershipError(
        `fake owner only supports exclusive-handoff (got ${binding.ownershipModel})`,
        "proof_failed",
      );
    }
    if (!binding.threadId.trim()) {
      throw new OwnershipError("threadId required", "thread_mismatch");
    }
    this.#binding = binding;
    this.#connected = true;
    this.#owner = "none";
    this.#acquired = false;
  }

  async acquireOwnership(): Promise<OwnershipProof> {
    this.#requireConnected();
    if (this.#competing) {
      throw new OwnershipError(
        "competing responder present; refuse acquire",
        "competing_responder",
      );
    }
    if (this.#acquired) {
      return this.#proof();
    }
    this.#acquired = true;
    this.#owner = "headless";
    return this.#proof();
  }

  async releaseOwnership(): Promise<void> {
    this.#requireConnected();
    if (this.#activeTurnId !== null) {
      throw new OwnershipError(
        `refuse release while turn ${this.#activeTurnId} active`,
        "not_acquired",
      );
    }
    if (this.#openRequests.size > 0) {
      throw new OwnershipError(
        "refuse release while server requests open",
        "not_acquired",
      );
    }
    this.#acquired = false;
    this.#owner = "none";
  }

  async snapshot(): Promise<ThreadSnapshot> {
    this.#requireConnected();
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      threadId: this.#binding!.threadId,
      activeTurnId: this.#activeTurnId,
      idle: this.#activeTurnId === null,
      owner: this.#owner,
    };
  }

  async startTurn(input: ModelInput, idempotencyKey: string): Promise<Acceptance> {
    this.#requireAcquired();
    this.#assertOwnershipStillHolds();
    const existing = this.#idempotency.get(idempotencyKey);
    if (existing) return existing;
    if (this.#activeTurnId !== null) {
      throw new OwnershipError(
        `turn already active: ${this.#activeTurnId}`,
        "turn_mismatch",
      );
    }
    if (input.byteLength <= 0 || !input.text) {
      throw new OwnershipError("empty model input", "proof_failed");
    }
    this.#turnSeq += 1;
    const turnId = `turn-fake-${this.#turnSeq}`;
    this.#activeTurnId = turnId;
    const at = this.#now();
    this.#emit({ kind: "turnStarted", turnId, at });
    const acceptance: Acceptance = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      batchId: idempotencyKey.split("#")[0] || idempotencyKey,
      threadId: this.#binding!.threadId,
      turnId,
      acceptedAt: at,
      idempotencyKey,
    };
    this.#idempotency.set(idempotencyKey, acceptance);
    if (this.#autoCompleteTurns) {
      queueMicrotask(() => this.completeActiveTurn());
    }
    return acceptance;
  }

  async steerTurn(
    expectedTurnId: string,
    input: ModelInput,
    idempotencyKey: string,
  ): Promise<Acceptance> {
    this.#requireAcquired();
    this.#assertOwnershipStillHolds();
    if (this.#activeTurnId === null) {
      throw new OwnershipError("no active turn to steer", "turn_mismatch");
    }
    if (this.#activeTurnId !== expectedTurnId) {
      throw new OwnershipError(
        `expectedTurnId ${expectedTurnId} != active ${this.#activeTurnId}`,
        "turn_mismatch",
      );
    }
    const existing = this.#idempotency.get(idempotencyKey);
    if (existing) return existing;
    if (input.byteLength <= 0 || !input.text) {
      throw new OwnershipError("empty model input", "proof_failed");
    }
    const at = this.#now();
    const acceptance: Acceptance = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      batchId: idempotencyKey.split("#")[0] || idempotencyKey,
      threadId: this.#binding!.threadId,
      turnId: expectedTurnId,
      acceptedAt: at,
      idempotencyKey,
    };
    this.#idempotency.set(idempotencyKey, acceptance);
    return acceptance;
  }

  async respondToServerRequest(
    requestId: string,
    response: ServerRequestResponse,
  ): Promise<void> {
    this.#requireAcquired();
    this.#assertOwnershipStillHolds();
    if (!this.#openRequests.has(requestId)) {
      throw new OwnershipError(`unknown server request ${requestId}`, "proof_failed");
    }
    this.#openRequests.delete(requestId);
    this.#answered.set(requestId, response);
  }

  async *events(signal: AbortSignal): AsyncIterable<ThreadEvent> {
    this.#requireNotClosed();
    const queue: ThreadEvent[] = [...this.#history];
    let resolveWait: (() => void) | null = null;
    let closed = false;

    const waiter: Waiter = {
      push: (event) => {
        queue.push(event);
        resolveWait?.();
      },
      close: () => {
        closed = true;
        resolveWait?.();
      },
    };
    this.#waiters.add(waiter);

    const onAbort = () => {
      waiter.close();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      while (!signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
        resolveWait = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#waiters.delete(waiter);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#acquired = false;
    this.#owner = "none";
    const at = this.#now();
    this.#emit({ kind: "disconnected", at, detail: "adapter closed" });
    for (const waiter of this.#waiters) waiter.close();
    this.#waiters.clear();
  }

  /** Complete the active turn (test/kernel helper). */
  completeActiveTurn(): void {
    if (this.#activeTurnId === null) return;
    const turnId = this.#activeTurnId;
    this.#activeTurnId = null;
    this.#emit({ kind: "turnCompleted", turnId, at: this.#now() });
  }

  /** Fail the active turn (test helper for terminal-outcome semantics). */
  failActiveTurn(detail = "turn failed"): void {
    if (this.#activeTurnId === null) return;
    const turnId = this.#activeTurnId;
    this.#activeTurnId = null;
    this.#clearIdempotencyForTurn(turnId);
    this.#emit({ kind: "turnFailed", turnId, at: this.#now(), detail });
  }

  #clearIdempotencyForTurn(turnId: string): void {
    for (const [key, acceptance] of this.#idempotency) {
      if (acceptance.turnId === turnId) this.#idempotency.delete(key);
    }
  }

  #proof(): OwnershipProof {
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      mode: "exclusive-handoff",
      owner: "headless",
      bindingId: this.#binding!.bindingId,
      threadId: this.#binding!.threadId,
      subscriberCount: 1,
      competingResponder: false,
      provenAt: this.#now(),
    };
  }

  #emit(event: ThreadEvent): void {
    this.#history.push(event);
    for (const waiter of this.#waiters) waiter.push(event);
  }

  #requireNotClosed(): void {
    if (this.#closed) throw new OwnershipError("adapter closed", "closed");
  }

  #requireConnected(): void {
    this.#requireNotClosed();
    if (!this.#connected || !this.#binding) {
      throw new OwnershipError("not connected", "not_connected");
    }
  }

  #requireLive(): void {
    this.#requireConnected();
  }

  #requireAcquired(): void {
    this.#requireConnected();
    if (!this.#acquired || this.#owner !== "headless") {
      throw new OwnershipError("ownership not acquired", "not_acquired");
    }
  }

  #assertOwnershipStillHolds(): void {
    if (this.#competing) {
      this.#acquired = false;
      this.#owner = "none";
      this.#emit({
        kind: "ownershipLost",
        at: this.#now(),
        detail: "competing responder detected",
      });
      throw new OwnershipError("ownership lost", "ownership_lost");
    }
  }
}
