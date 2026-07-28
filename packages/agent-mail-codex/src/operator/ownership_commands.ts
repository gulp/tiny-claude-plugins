/**
 * O5: operator commands for explicit ownership release/acquire.
 *
 * Wraps C6 ExclusiveHandoff with durable owner-state persistence. No implicit
 * timeout transfer; delivery stays blocked until acquire-owner --owner headless.
 */

import {
  ExclusiveHandoff,
  HandoffError,
  type HandoffOwner,
  type HandoffSnapshot,
  type PendingDelivery,
} from "../owner/handoff.ts";

export type PersistedOwnerState = {
  schemaVersion: 1;
  bindingId: string;
  threadId: string;
  owner: HandoffOwner;
  activeTurnId: string | null;
  unresolvedRequestIds: string[];
  pending: PendingDelivery[];
  updatedAt: string;
};

export interface OwnerStateStore {
  load(bindingId: string): Promise<PersistedOwnerState | null>;
  save(state: PersistedOwnerState): Promise<void>;
}

export class MemoryOwnerStateStore implements OwnerStateStore {
  #rows = new Map<string, PersistedOwnerState>();

  load(bindingId: string): Promise<PersistedOwnerState | null> {
    return Promise.resolve(this.#rows.get(bindingId) ?? null);
  }

  save(state: PersistedOwnerState): Promise<void> {
    this.#rows.set(state.bindingId, structuredClone(state));
    return Promise.resolve();
  }
}

export type ReleaseOwnerResult = {
  ok: true;
  bindingId: string;
  owner: "human";
  threadId: string;
  resumeCommand: string;
  pendingCount: number;
  message: string;
};

export type AcquireOwnerResult = {
  ok: true;
  bindingId: string;
  owner: "headless";
  threadId: string;
  drainedPending: PendingDelivery[];
  message: string;
};

export class OwnershipCommandError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "active_turn"
      | "unresolved_requests"
      | "wrong_owner"
      | "overlap"
      | "thread_mismatch"
      | "delivery_blocked"
      | "usage"
      | "gateway_not_applicable"
      | "daemon_absent"
      | "daemon_race"
      | "connection_open"
      | "proof_failed",
  ) {
    super(message);
    this.name = "OwnershipCommandError";
  }
}

export type OwnershipCommandsOptions = {
  store: OwnerStateStore;
  now?: () => string;
  /** When true, refuse with ADR reference (gateway not selected for v1). */
  gatewaySelected?: boolean;
};

export class OwnershipCommands {
  #store: OwnerStateStore;
  #now: () => string;
  #gatewaySelected: boolean;

  constructor(options: OwnershipCommandsOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#gatewaySelected = options.gatewaySelected ?? false;
  }

  /** Ensure a binding row exists (operator bootstrap / first headless run). */
  async ensureHeadless(bindingId: string, threadId: string): Promise<PersistedOwnerState> {
    this.#refuseGateway();
    const existing = await this.#store.load(bindingId);
    if (existing) return existing;
    const state = persistFrom(
      bindingId,
      new ExclusiveHandoff(threadId).snapshot(),
      this.#now(),
    );
    await this.#store.save(state);
    return state;
  }

  async status(bindingId: string): Promise<PersistedOwnerState> {
    const state = await this.#requireState(bindingId);
    return state;
  }

  /**
   * `binding release-owner <binding> --to human`
   * Refuses unresolved turns/requests; persists human owner; prints exact resume.
   */
  async releaseOwnerToHuman(bindingId: string, to: "human"): Promise<ReleaseOwnerResult> {
    this.#refuseGateway();
    if (to !== "human") {
      throw new OwnershipCommandError(
        `unsupported release target ${to}; only --to human is valid`,
        "usage",
      );
    }
    const state = await this.#requireState(bindingId);
    const handoff = ExclusiveHandoff.restore(state);
    let result;
    try {
      result = handoff.releaseToHuman();
    } catch (error) {
      throw mapHandoff(error);
    }
    const next = persistFrom(bindingId, handoff.snapshot(), this.#now());
    await this.#store.save(next);
    return {
      ok: true,
      bindingId,
      owner: "human",
      threadId: result.threadId,
      resumeCommand: result.resumeCommand,
      pendingCount: next.pending.length,
      message:
        `owner released to human; mail delivery paused until acquire-owner --owner headless. Resume: ${result.resumeCommand}`,
    };
  }

  /**
   * `binding acquire-owner <binding> --owner headless`
   * Requires explicit reacquire naming the exact durable thread.
   */
  async acquireOwnerHeadless(
    bindingId: string,
    owner: "headless",
    expectedThreadId: string,
  ): Promise<AcquireOwnerResult> {
    this.#refuseGateway();
    if (owner !== "headless") {
      throw new OwnershipCommandError(
        `unsupported acquire owner ${owner}; only --owner headless is valid for v1`,
        "usage",
      );
    }
    const state = await this.#requireState(bindingId);
    const handoff = ExclusiveHandoff.restore(state);
    let drained: PendingDelivery[];
    try {
      drained = handoff.reacquireHeadless(expectedThreadId);
    } catch (error) {
      throw mapHandoff(error);
    }
    const next = persistFrom(bindingId, handoff.snapshot(), this.#now());
    await this.#store.save(next);
    return {
      ok: true,
      bindingId,
      owner: "headless",
      threadId: expectedThreadId,
      drainedPending: drained,
      message:
        `headless owner reacquired on exact thread ${expectedThreadId}; ${drained.length} queued deliver(ies) ready`,
    };
  }

  /** True when headless delivery is allowed for this binding. */
  async deliveryAllowed(bindingId: string): Promise<boolean> {
    const state = await this.#store.load(bindingId);
    return state?.owner === "headless";
  }

  async #requireState(bindingId: string): Promise<PersistedOwnerState> {
    const state = await this.#store.load(bindingId);
    if (!state) {
      throw new OwnershipCommandError(
        `no owner state for binding ${bindingId}; run ensure/bootstrap first`,
        "not_found",
      );
    }
    return state;
  }

  #refuseGateway(): void {
    if (this.#gatewaySelected) {
      throw new OwnershipCommandError(
        "gateway ownership not selected for v1 (S5 ADR); exclusive-handoff release/acquire only",
        "gateway_not_applicable",
      );
    }
  }
}

function persistFrom(
  bindingId: string,
  snapshot: HandoffSnapshot,
  updatedAt: string,
): PersistedOwnerState {
  return {
    schemaVersion: 1,
    bindingId,
    threadId: snapshot.threadId,
    owner: snapshot.owner,
    activeTurnId: snapshot.activeTurnId,
    unresolvedRequestIds: snapshot.unresolvedRequestIds,
    pending: snapshot.pending,
    updatedAt,
  };
}

function mapHandoff(error: unknown): OwnershipCommandError {
  if (error instanceof HandoffError) {
    return new OwnershipCommandError(error.message, error.code);
  }
  throw error;
}

/** Human-readable one-liner for CLI stdout. */
export function formatOwnershipResult(
  result: ReleaseOwnerResult | AcquireOwnerResult,
): string {
  if ("resumeCommand" in result) {
    return [
      `owner=${result.owner}`,
      `binding=${result.bindingId}`,
      `thread=${result.threadId}`,
      `pending=${result.pendingCount}`,
      `resume=${result.resumeCommand}`,
    ].join(" ");
  }
  return [
    `owner=${result.owner}`,
    `binding=${result.bindingId}`,
    `thread=${result.threadId}`,
    `drained=${result.drainedPending.length}`,
  ].join(" ");
}
