/**
 * C4: turn/start, turn/steer (expectedTurnId), lifecycle events, turn snapshots.
 *
 * L2 decides *whether* to start/steer/queue; this module owns the App Server
 * JSON-RPC and the authoritative local turn view. One active turn per thread.
 * Never steer over human interaction or unresolved server requests.
 */

import { type Acceptance, DOMAIN_SCHEMA_VERSION } from "../schemas/mod.ts";
import type { ModelInput } from "./types.ts";
import {
  type OwnershipMode,
  type PolicyAction,
  RequestPolicyError,
  ServerRequestArbiter,
} from "./request_policy.ts";
import type { ServerRequest } from "./types.ts";

export type TurnTransport = {
  request(method: string, params?: unknown): Promise<unknown>;
  readonly healthy: boolean;
};

export type TurnNotification = {
  method: string;
  params: unknown;
};

export type HumanGate = "approval" | "user_input" | "plan_decision";

export type TurnSessionEvent =
  | { kind: "turnStarted"; turnId: string; at: string }
  | { kind: "turnCompleted"; turnId: string; at: string }
  | { kind: "turnFailed"; turnId: string; at: string; detail: string }
  | { kind: "routineQueued"; at: string; reason: "routine_during_turn" }
  | { kind: "serverRequestResolved"; requestId: string; at: string; diagnostic: string };

export type TurnSessionSnapshot = {
  schemaVersion: 1;
  threadId: string;
  activeTurnId: string | null;
  idle: boolean;
  humanGate: HumanGate | null;
  openRequestIds: string[];
  ownerMode: OwnershipMode;
};

export type DeliverySignal =
  | { kind: "startTurn" }
  | { kind: "steerTurn"; turnId: string }
  | {
    kind: "queue";
    reason: "routine_during_turn" | "human_gate" | "open_server_request" | "owner_not_headless";
  };

export class TurnSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "transport_unhealthy"
      | "not_idle"
      | "not_active"
      | "turn_mismatch"
      | "non_steerable"
      | "human_gate"
      | "open_server_request"
      | "invalid_response"
      | "idempotency_conflict"
      | "owner_not_headless",
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TurnSessionError";
  }
}

export interface TurnSessionOptions {
  threadId: string;
  /** When false, urgent steer is refused (queue/serialized path). Default true for C4. */
  urgentSteerEnabled?: boolean;
  ownershipMode?: OwnershipMode;
  now?: () => string;
  clientId?: string;
  /** Bounded diagnostic replay history; durable delivery state lives in SQLite. */
  historyLimit?: number;
}

export class TurnSession {
  #transport: TurnTransport;
  #threadId: string;
  #urgentSteerEnabled: boolean;
  #ownerMode: OwnershipMode;
  #now: () => string;
  #clientId: string;
  #historyLimit: number;
  #activeTurnId: string | null = null;
  #humanGate: HumanGate | null = null;
  #idempotency = new Map<string, Acceptance>();
  #arbiter = new ServerRequestArbiter();
  #openRequests = new Map<string, ServerRequest>();
  #history: TurnSessionEvent[] = [];
  #waiters = new Set<(event: TurnSessionEvent) => void>();

  constructor(transport: TurnTransport, options: TurnSessionOptions) {
    if (!options.threadId.trim()) throw new TypeError("threadId must be non-empty");
    this.#transport = transport;
    this.#threadId = options.threadId;
    this.#urgentSteerEnabled = options.urgentSteerEnabled ?? true;
    this.#ownerMode = options.ownershipMode ?? "headless";
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#clientId = options.clientId ?? "headless-ingress";
    this.#historyLimit = options.historyLimit ?? 1_024;
    if (!Number.isSafeInteger(this.#historyLimit) || this.#historyLimit < 1) {
      throw new TypeError("historyLimit must be a positive safe integer");
    }
  }

  snapshot(): TurnSessionSnapshot {
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      threadId: this.#threadId,
      activeTurnId: this.#activeTurnId,
      idle: this.#activeTurnId === null,
      humanGate: this.#humanGate,
      openRequestIds: [...this.#openRequests.keys()].sort(),
      ownerMode: this.#ownerMode,
    };
  }

  /**
   * Authoritative delivery signal before calling start/steer.
   * Routine-during-turn emits a `routineQueued` event for observability.
   */
  signalDelivery(urgency: "urgent" | "routine"): DeliverySignal {
    if (this.#humanGate) {
      return { kind: "queue", reason: "human_gate" };
    }
    if (this.#openRequests.size > 0) {
      return { kind: "queue", reason: "open_server_request" };
    }
    if (this.#ownerMode !== "headless") {
      return { kind: "queue", reason: "owner_not_headless" };
    }
    if (this.#activeTurnId === null) {
      return { kind: "startTurn" };
    }
    if (urgency === "routine") {
      this.#emit({
        kind: "routineQueued",
        at: this.#now(),
        reason: "routine_during_turn",
      });
      return { kind: "queue", reason: "routine_during_turn" };
    }
    if (!this.#urgentSteerEnabled) {
      this.#emit({
        kind: "routineQueued",
        at: this.#now(),
        reason: "routine_during_turn",
      });
      return { kind: "queue", reason: "routine_during_turn" };
    }
    return { kind: "steerTurn", turnId: this.#activeTurnId };
  }

  async startTurn(input: ModelInput, idempotencyKey: string): Promise<Acceptance> {
    this.#requireHealthy();
    this.#requireHeadlessDelivery();
    const existing = this.#idempotency.get(idempotencyKey);
    if (existing) return existing;
    if (this.#activeTurnId !== null) {
      throw new TurnSessionError(
        `cannot turn/start while turn ${this.#activeTurnId} is active`,
        "not_idle",
      );
    }
    if (this.#humanGate) {
      throw new TurnSessionError(
        `cannot turn/start during human gate ${this.#humanGate}`,
        "human_gate",
      );
    }
    if (this.#openRequests.size > 0) {
      throw new TurnSessionError(
        `cannot turn/start with open server requests: ${[...this.#openRequests.keys()].join(",")}`,
        "open_server_request",
      );
    }
    this.#requireInput(input);

    const response = asObject(
      await this.#transport.request("turn/start", {
        threadId: this.#threadId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
      }),
      "turn/start",
    );
    const turnId = stringField(asObject(response.turn, "turn/start.turn"), "id", "turn/start.turn");
    this.#activeTurnId = turnId;
    const acceptance = this.#acceptance(idempotencyKey, turnId);
    this.#idempotency.set(idempotencyKey, acceptance);
    this.#emit({ kind: "turnStarted", turnId, at: acceptance.acceptedAt });
    return acceptance;
  }

  async steerTurn(
    expectedTurnId: string,
    input: ModelInput,
    idempotencyKey: string,
  ): Promise<Acceptance> {
    this.#requireHealthy();
    this.#requireHeadlessDelivery();
    const existing = this.#idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.turnId !== expectedTurnId) {
        throw new TurnSessionError(
          `idempotency key bound to turn ${existing.turnId}, not ${expectedTurnId}`,
          "idempotency_conflict",
        );
      }
      return existing;
    }
    if (!this.#urgentSteerEnabled) {
      throw new TurnSessionError("urgent steer is disabled", "non_steerable");
    }
    if (this.#humanGate) {
      throw new TurnSessionError(
        `refuse steer over human gate ${this.#humanGate}`,
        "human_gate",
      );
    }
    if (this.#openRequests.size > 0) {
      throw new TurnSessionError(
        `refuse steer over open server requests: ${[...this.#openRequests.keys()].join(",")}`,
        "open_server_request",
      );
    }
    if (this.#activeTurnId === null) {
      throw new TurnSessionError("no active turn to steer", "not_active");
    }
    if (this.#activeTurnId !== expectedTurnId) {
      throw new TurnSessionError(
        `expectedTurnId ${expectedTurnId} != active ${this.#activeTurnId}`,
        "turn_mismatch",
      );
    }
    this.#requireInput(input);

    const response = asObject(
      await this.#transport.request("turn/steer", {
        threadId: this.#threadId,
        turnId: expectedTurnId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
      }),
      "turn/steer",
    );
    const turn = response.turn === undefined ? null : asObject(response.turn, "turn/steer.turn");
    const turnId = turn ? stringField(turn, "id", "turn/steer.turn") : expectedTurnId;
    if (turnId !== expectedTurnId) {
      throw new TurnSessionError(
        `turn/steer returned ${turnId}, expected ${expectedTurnId}`,
        "turn_mismatch",
      );
    }
    const acceptance = this.#acceptance(idempotencyKey, turnId);
    this.#idempotency.set(idempotencyKey, acceptance);
    return acceptance;
  }

  /**
   * Apply a server-initiated request under C9 policy.
   * Approval / user-input / permissions mark a non-steerable human gate until resolved
   * when ownership is human; headless auto-responds and does not block the turn.
   */
  handleServerRequest(request: ServerRequest): {
    decision: PolicyAction;
    response: ReturnType<ServerRequestArbiter["answered"]>;
  } {
    const decision = this.#arbiter.open(this.#ownerMode, request);
    this.#openRequests.set(request.id, request);

    if (this.#ownerMode === "human") {
      this.#humanGate = humanGateFor(request);
    }

    let response = null;
    try {
      response = this.#arbiter.applyPolicyDecision(request.id, this.#clientId, decision);
    } catch (error) {
      this.#openRequests.delete(request.id);
      throw error;
    }

    if (decision.action !== "defer") {
      this.#openRequests.delete(request.id);
      if (this.#ownerMode === "human" && this.#openRequests.size === 0) {
        this.#humanGate = null;
      }
      this.#emit({
        kind: "serverRequestResolved",
        requestId: request.id,
        at: this.#now(),
        diagnostic: decision.diagnostic,
      });
    }
    return { decision, response };
  }

  /** Human (or deferred) owner completes a previously deferred request. */
  resolveDeferredRequest(
    requestId: string,
    response: {
      kind: "cancel" | "decline" | "answered" | "reject";
      body?: unknown;
      code?: number;
      message?: string;
    },
  ): void {
    const request = this.#openRequests.get(requestId);
    if (!request) {
      throw new RequestPolicyError(`unknown server request ${requestId}`, "unknown_request");
    }
    const payload = response.kind === "answered"
      ? { kind: "answered" as const, body: response.body }
      : response.kind === "reject"
      ? {
        kind: "reject" as const,
        code: response.code ?? -32001,
        message: response.message ?? "rejected",
      }
      : { kind: response.kind };
    this.#arbiter.answer(requestId, this.#clientId, "interactive_human", payload);
    this.#openRequests.delete(requestId);
    if (this.#openRequests.size === 0) this.#humanGate = null;
    this.#emit({
      kind: "serverRequestResolved",
      requestId,
      at: this.#now(),
      diagnostic: `deferred ${request.type} resolved by interactive owner`,
    });
  }

  /** Drive turn lifecycle from App Server notifications. */
  handleNotification(notification: TurnNotification): void {
    const at = this.#now();
    if (notification.method === "turn/started") {
      const turnId = turnIdFromParams(notification.params);
      if (turnId && this.#activeTurnId === null) {
        this.#activeTurnId = turnId;
        this.#emit({ kind: "turnStarted", turnId, at });
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turnId = turnIdFromParams(notification.params) ?? this.#activeTurnId;
      if (!turnId) return;
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      this.#emit({ kind: "turnCompleted", turnId, at });
      return;
    }
    if (notification.method === "turn/failed") {
      const turnId = turnIdFromParams(notification.params) ?? this.#activeTurnId;
      if (!turnId) return;
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      const detail = detailFromParams(notification.params) ?? "turn failed";
      for (const [key, acceptance] of this.#idempotency) {
        if (acceptance.turnId === turnId) this.#idempotency.delete(key);
      }
      this.#emit({ kind: "turnFailed", turnId, at, detail });
    }
  }

  eventHistory(): readonly TurnSessionEvent[] {
    return this.#history;
  }

  async *events(signal: AbortSignal): AsyncIterable<TurnSessionEvent> {
    const queue: TurnSessionEvent[] = [...this.#history];
    let wake: (() => void) | null = null;
    const push = (event: TurnSessionEvent) => {
      queue.push(event);
      wake?.();
    };
    this.#waiters.add(push);
    const onAbort = () => wake?.();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#waiters.delete(push);
    }
  }

  #acceptance(idempotencyKey: string, turnId: string): Acceptance {
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      batchId: idempotencyKey.split("#")[0] || idempotencyKey,
      threadId: this.#threadId,
      turnId,
      acceptedAt: this.#now(),
      idempotencyKey,
    };
  }

  #emit(event: TurnSessionEvent): void {
    this.#history.push(event);
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    for (const waiter of this.#waiters) waiter(event);
  }

  #requireHealthy(): void {
    if (!this.#transport.healthy) {
      throw new TurnSessionError("transport is unhealthy", "transport_unhealthy");
    }
  }

  #requireHeadlessDelivery(): void {
    if (this.#ownerMode !== "headless") {
      throw new TurnSessionError(
        `mail delivery forbidden while owner mode is ${this.#ownerMode}`,
        "owner_not_headless",
      );
    }
  }

  #requireInput(input: ModelInput): void {
    if (input.byteLength <= 0 || !input.text) {
      throw new TurnSessionError("empty model input", "invalid_response");
    }
  }
}

function humanGateFor(request: ServerRequest): HumanGate | null {
  switch (request.type) {
    case "approval":
    case "permissions":
      return "approval";
    case "userInput":
    case "elicitation":
      return "user_input";
    default:
      return null;
  }
}

function turnIdFromParams(params: unknown): string | null {
  if (!isObject(params)) return null;
  if (typeof params.turnId === "string" && params.turnId) return params.turnId;
  if (isObject(params.turn) && typeof params.turn.id === "string" && params.turn.id) {
    return params.turn.id;
  }
  return null;
}

function detailFromParams(params: unknown): string | null {
  if (!isObject(params)) return null;
  if (typeof params.error === "string") return params.error;
  if (isObject(params.error) && typeof params.error.message === "string") {
    return params.error.message;
  }
  if (typeof params.message === "string") return params.message;
  return null;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TurnSessionError(`${field} must be an object`, "invalid_response");
  }
  return value as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, key: string, field: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TurnSessionError(`${field}.${key} must be a string`, "invalid_response");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
