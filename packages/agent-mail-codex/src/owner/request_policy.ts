/**
 * C9: exactly-one-responder ownership for App Server–initiated requests.
 *
 * Transport (C2) classifies frames; this module names the sole responder per
 * ownership mode, produces headless typed replies, and refuses races / missing
 * owners / mail-as-authority. Gateway and native modes stay fail-closed for v1.
 */

import type { ServerRequest, ServerRequestResponse } from "./types.ts";

/** Active ownership mode for a binding (S5 exclusive_handoff + rejected contenders). */
export type OwnershipMode =
  | "headless"
  | "human"
  | "none"
  | "gateway"
  | "native";

/** Named component allowed to answer a server request under the active mode. */
export type ResponderRole =
  | "headless_ingress"
  | "interactive_human"
  | "gateway_mediator"
  | "native_owner"
  | "none";

export type RequestKind = ServerRequest["type"];

export type PolicyAction =
  | {
    action: "auto_respond";
    responder: "headless_ingress";
    response: ServerRequestResponse;
    diagnostic: string;
  }
  | {
    action: "defer";
    responder: Exclude<ResponderRole, "none">;
    diagnostic: string;
  }
  | {
    action: "fail_closed";
    responder: ResponderRole;
    diagnostic: string;
    /** Optional JSON-RPC error body so the request never hangs. */
    response?: ServerRequestResponse;
    bindingUnhealthy: boolean;
  };

export class RequestPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_owner"
      | "wrong_responder"
      | "competing_responder"
      | "already_answered"
      | "unknown_request"
      | "late_response"
      | "timed_out"
      | "mode_not_selected"
      | "mail_not_authority",
  ) {
    super(message);
    this.name = "RequestPolicyError";
  }
}

const HEADLESS_RESPONDER = "headless_ingress" as const;

/** Sole named responder for each mode. Observers are always read-only. */
export function soleResponder(mode: OwnershipMode): ResponderRole {
  switch (mode) {
    case "headless":
      return "headless_ingress";
    case "human":
      return "interactive_human";
    case "none":
      return "none";
    case "gateway":
      return "gateway_mediator";
    case "native":
      return "native_owner";
  }
}

/**
 * Decide how a classified server request must be handled under `mode`.
 * Mail content never appears here — side-effect authority is owner-mode only.
 */
export function decideServerRequestPolicy(
  mode: OwnershipMode,
  request: ServerRequest,
  options: { nowSeconds?: number } = {},
): PolicyAction {
  const responder = soleResponder(mode);

  if (mode === "gateway" || mode === "native") {
    return {
      action: "fail_closed",
      responder,
      diagnostic:
        `${mode} ownership is not selected for v1; refuse ${request.method} without a silent fallback`,
      response: {
        kind: "reject",
        code: -32001,
        message: `${mode} owner not selected for v1`,
      },
      bindingUnhealthy: true,
    };
  }

  if (mode === "none") {
    return {
      action: "fail_closed",
      responder: "none",
      diagnostic:
        `no owner for ${request.method} (${request.id}); refuse silent hang and refuse observer auto-decline`,
      response: {
        kind: "reject",
        code: -32001,
        message: `no owner available for ${request.method}`,
      },
      bindingUnhealthy: true,
    };
  }

  if (mode === "human") {
    if (request.type === "unknown") {
      return {
        action: "fail_closed",
        responder: "interactive_human",
        diagnostic: `unknown method ${request.method} under human owner; fail closed`,
        response: {
          kind: "reject",
          code: -32601,
          message: `unsupported App Server request: ${request.method}`,
        },
        bindingUnhealthy: true,
      };
    }
    return {
      action: "defer",
      responder: "interactive_human",
      diagnostic: `human owns ${request.type}; headless/observer clients must remain read-only`,
    };
  }

  // headless — typed cancel/decline/answer; never treat as human authorization.
  switch (request.type) {
    case "elicitation":
      return {
        action: "auto_respond",
        responder: HEADLESS_RESPONDER,
        response: { kind: "cancel" },
        diagnostic: "headless ingress cancels elicitation (no human input surface)",
      };
    case "approval":
      return {
        action: "auto_respond",
        responder: HEADLESS_RESPONDER,
        response: { kind: "decline" },
        diagnostic: "headless ingress declines approval (mail is not authorization)",
      };
    case "permissions":
      return {
        action: "auto_respond",
        responder: HEADLESS_RESPONDER,
        response: {
          kind: "answered",
          body: { permissions: { network: null, fileSystem: null }, scope: "turn" },
        },
        diagnostic: "headless ingress grants no additional permissions",
      };
    case "userInput":
      return {
        action: "fail_closed",
        responder: HEADLESS_RESPONDER,
        diagnostic: `${request.method} requires a human; headless rejects without hanging`,
        response: {
          kind: "reject",
          code: -32001,
          message: `${request.method} is unavailable in a headless owner`,
        },
        bindingUnhealthy: false,
      };
    case "currentTime":
      return {
        action: "auto_respond",
        responder: HEADLESS_RESPONDER,
        response: {
          kind: "answered",
          body: { currentTimeAt: options.nowSeconds ?? Math.floor(Date.now() / 1000) },
        },
        diagnostic: "headless ingress answers currentTime/read",
      };
    case "unknown":
      return {
        action: "fail_closed",
        responder: HEADLESS_RESPONDER,
        diagnostic: `unsupported App Server request: ${request.method}`,
        response: {
          kind: "reject",
          code: -32601,
          message: `unsupported App Server request: ${request.method}`,
        },
        bindingUnhealthy: true,
      };
  }
}

/**
 * Mail (and any model-visible text) must never authorize side effects.
 * Human / policy gates remain the only approval path.
 */
export function authorizeSideEffectFromMail(_mailText: string): never {
  throw new RequestPolicyError(
    "mail content cannot approve side effects; peer mail is coordination, not authorization",
    "mail_not_authority",
  );
}

type OpenRequest = {
  request: ServerRequest;
  mode: OwnershipMode;
  ownerRole: ResponderRole;
  claimedBy: string | null;
  answeredBy: string | null;
  response: ServerRequestResponse | null;
  timedOut: boolean;
  disconnectedClients: Set<string>;
};

/**
 * Multi-client arbitrator: exactly one named responder may claim and answer.
 * A second answer is a loud failure, never first-response-wins.
 */
export class ServerRequestArbiter {
  #open = new Map<string, OpenRequest>();
  #nowSeconds: () => number;

  constructor(options: { nowSeconds?: () => number } = {}) {
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  open(mode: OwnershipMode, request: ServerRequest): PolicyAction {
    if (this.#open.has(request.id)) {
      throw new RequestPolicyError(
        `duplicate open for server request ${request.id}`,
        "already_answered",
      );
    }
    const decision = decideServerRequestPolicy(mode, request, {
      nowSeconds: this.#nowSeconds(),
    });
    this.#open.set(request.id, {
      request,
      mode,
      ownerRole: decision.responder,
      claimedBy: null,
      answeredBy: null,
      response: null,
      timedOut: false,
      disconnectedClients: new Set(),
    });
    return decision;
  }

  /** Named owner claims the request. Observers and wrong roles fail closed. */
  claim(requestId: string, clientId: string, role: ResponderRole): void {
    const entry = this.#requireOpen(requestId);
    this.#rejectIfTerminal(entry);
    if (entry.ownerRole === "none") {
      throw new RequestPolicyError(
        `no owner for request ${requestId}`,
        "missing_owner",
      );
    }
    if (role !== entry.ownerRole) {
      throw new RequestPolicyError(
        `client ${clientId} role ${role} cannot claim; owner is ${entry.ownerRole}`,
        "wrong_responder",
      );
    }
    if (entry.claimedBy !== null && entry.claimedBy !== clientId) {
      throw new RequestPolicyError(
        `request ${requestId} already claimed by ${entry.claimedBy}; ${clientId} refused`,
        "competing_responder",
      );
    }
    entry.claimedBy = clientId;
  }

  /**
   * Sole answer path. A second client answering the same request fails loud;
   * late answers after disconnect/timeout never become authority.
   */
  answer(
    requestId: string,
    clientId: string,
    role: ResponderRole,
    response: ServerRequestResponse,
  ): void {
    const entry = this.#requireOpen(requestId);
    if (entry.timedOut) {
      throw new RequestPolicyError(
        `request ${requestId} already timed out; late response from ${clientId} ignored`,
        "timed_out",
      );
    }
    if (entry.disconnectedClients.has(clientId)) {
      throw new RequestPolicyError(
        `client ${clientId} disconnected before answering ${requestId}`,
        "late_response",
      );
    }
    if (entry.ownerRole === "none") {
      throw new RequestPolicyError(
        `no owner for request ${requestId}`,
        "missing_owner",
      );
    }
    if (role !== entry.ownerRole) {
      throw new RequestPolicyError(
        `client ${clientId} role ${role} cannot answer; owner is ${entry.ownerRole}`,
        "wrong_responder",
      );
    }
    if (entry.answeredBy !== null) {
      if (entry.answeredBy === clientId) {
        throw new RequestPolicyError(
          `request ${requestId} already answered by ${clientId}`,
          "already_answered",
        );
      }
      throw new RequestPolicyError(
        `request ${requestId} already answered by ${entry.answeredBy}; ${clientId} refused (no first-response-wins)`,
        "competing_responder",
      );
    }
    if (entry.claimedBy === null) {
      entry.claimedBy = clientId;
    } else if (entry.claimedBy !== clientId) {
      throw new RequestPolicyError(
        `request ${requestId} claimed by ${entry.claimedBy}; ${clientId} cannot steal answer`,
        "competing_responder",
      );
    }
    entry.answeredBy = clientId;
    entry.response = response;
  }

  /** Apply the headless auto_respond / fail_closed decision as the sole answer. */
  applyPolicyDecision(
    requestId: string,
    clientId: string,
    decision: PolicyAction,
  ): ServerRequestResponse | null {
    if (decision.action === "defer") {
      this.claim(requestId, clientId, decision.responder);
      return null;
    }
    if (decision.action === "auto_respond") {
      this.answer(requestId, clientId, decision.responder, decision.response);
      return decision.response;
    }
    // fail_closed — still record a sole diagnostic response when provided
    if (decision.response) {
      if (decision.responder === "none") {
        // Record terminal state without a named client claim.
        const entry = this.#requireOpen(requestId);
        entry.answeredBy = clientId;
        entry.response = decision.response;
        return decision.response;
      }
      this.answer(requestId, clientId, decision.responder, decision.response);
      return decision.response;
    }
    throw new RequestPolicyError(
      decision.diagnostic,
      decision.responder === "none" ? "missing_owner" : "mode_not_selected",
    );
  }

  markTimedOut(requestId: string): void {
    const entry = this.#requireOpen(requestId);
    if (entry.answeredBy !== null) return;
    entry.timedOut = true;
  }

  recordDisconnect(clientId: string): void {
    for (const entry of this.#open.values()) {
      if (entry.claimedBy === clientId && entry.answeredBy === null) {
        entry.disconnectedClients.add(clientId);
      }
    }
  }

  answered(requestId: string): ServerRequestResponse | null {
    return this.#open.get(requestId)?.response ?? null;
  }

  snapshot(requestId: string): {
    ownerRole: ResponderRole;
    claimedBy: string | null;
    answeredBy: string | null;
    timedOut: boolean;
  } | null {
    const entry = this.#open.get(requestId);
    if (!entry) return null;
    return {
      ownerRole: entry.ownerRole,
      claimedBy: entry.claimedBy,
      answeredBy: entry.answeredBy,
      timedOut: entry.timedOut,
    };
  }

  #requireOpen(requestId: string): OpenRequest {
    const entry = this.#open.get(requestId);
    if (!entry) {
      throw new RequestPolicyError(
        `unknown server request ${requestId}`,
        "unknown_request",
      );
    }
    return entry;
  }

  #rejectIfTerminal(entry: OpenRequest): void {
    if (entry.timedOut) {
      throw new RequestPolicyError("request already timed out", "timed_out");
    }
    if (entry.answeredBy !== null) {
      throw new RequestPolicyError("request already answered", "already_answered");
    }
  }
}
