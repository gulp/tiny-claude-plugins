/**
 * C1: ThreadOwnerAdapter — Codex ownership seam (no JSON-RPC frames).
 * Domain types come from F2 schemas; ModelInput/ThreadEvent stay adapter-local.
 */

import type { Acceptance, OwnershipProof, ThreadBinding, ThreadSnapshot } from "../schemas/mod.ts";

/** Opaque model-visible payload; L3 owns encoding. C1 only carries bytes/text. */
export interface ModelInput {
  schemaVersion: 1;
  text: string;
  byteLength: number;
}

export type ThreadEvent =
  | { kind: "turnStarted"; turnId: string; at: string }
  | { kind: "turnCompleted"; turnId: string; at: string }
  | { kind: "turnFailed"; turnId: string; at: string; detail: string }
  | { kind: "ownershipLost"; at: string; detail: string }
  | { kind: "serverRequest"; request: ServerRequest; at: string }
  | { kind: "disconnected"; at: string; detail: string };

/**
 * Server-initiated requests the sole owner must answer.
 * Exact JSON-RPC shapes stay in C2; here we only name the class.
 */
export type ServerRequest =
  | { id: string; type: "elicitation"; method: string }
  | { id: string; type: "approval"; method: string }
  | { id: string; type: "permissions"; method: string }
  | { id: string; type: "userInput"; method: string }
  | { id: string; type: "currentTime"; method: string }
  | { id: string; type: "unknown"; method: string };

export type ServerRequestResponse =
  | { kind: "cancel" }
  | { kind: "decline" }
  | { kind: "reject"; code: number; message: string }
  | { kind: "answered"; body: unknown };

export class OwnershipError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_connected"
      | "not_acquired"
      | "proof_failed"
      | "competing_responder"
      | "thread_mismatch"
      | "turn_mismatch"
      | "ownership_lost"
      | "closed"
      | "duplicate_idempotency",
  ) {
    super(message);
    this.name = "OwnershipError";
  }
}

/**
 * Sole Codex-specific seam. Exactly one responder; fail closed without proof.
 * Release is explicit (S5 exclusive_handoff) — never implied by disconnect.
 */
export interface ThreadOwnerAdapter {
  connect(binding: ThreadBinding): Promise<void>;
  acquireOwnership(): Promise<OwnershipProof>;
  /** Explicit release to operator-controlled human window (owner → none). */
  releaseOwnership(): Promise<void>;
  snapshot(): Promise<ThreadSnapshot>;
  startTurn(input: ModelInput, idempotencyKey: string): Promise<Acceptance>;
  steerTurn(
    expectedTurnId: string,
    input: ModelInput,
    idempotencyKey: string,
  ): Promise<Acceptance>;
  /** Answer a server request while headless; illegal after release/close. */
  respondToServerRequest(
    requestId: string,
    response: ServerRequestResponse,
  ): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<ThreadEvent>;
  close(): Promise<void>;
}
