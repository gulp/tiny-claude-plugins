/**
 * K3: production composition root.
 *
 * This is the only place where the interface-only kernel is joined to the
 * real SQLite/mailbox adapters and the C8-selected private-stdio owner.
 */

import type { Clock } from "../retry/mod.ts";
import type { Acceptance, OwnershipProof, ThreadBinding, ThreadSnapshot } from "../schemas/mod.ts";
import { FsMailboxSource } from "../mailbox/mod.ts";
import {
  createProductionOwner,
  PRODUCTION_OWNER,
  type ProductionOwnerOptions,
  type ProductionOwnerPackage,
} from "../owner/production_owner.ts";
import { INGRESS_COMPONENT_VERSION } from "../owner/protocol_compat.ts";
import { TurnSession } from "../owner/turn_session.ts";
import {
  type ModelInput,
  OwnershipError,
  type ServerRequest,
  type ServerRequestResponse,
  type ThreadEvent,
  type ThreadOwnerAdapter,
} from "../owner/types.ts";
import { SqliteDurableStateStore } from "../store/sqlite.ts";
import { IngressKernel, type IngressKernelDeps, type KernelBinding } from "./mod.ts";

export const PRODUCTION_RUNTIME = {
  name: "@agent-mail/codex-ingress",
  version: "0.1.0-phase0",
  owner: PRODUCTION_OWNER,
  state: "sqlite-wal",
  mailbox: "canonical-git-mailbox",
} as const;

/**
 * Adapts the selected C8 package to the sole C1 kernel seam. Construction is
 * synchronous, but callbacks are installed before the transport can dispatch.
 */
export class ProductionThreadOwnerAdapter implements ThreadOwnerAdapter {
  readonly #owner: ProductionOwnerPackage;
  readonly #projectPath: string;
  readonly #configuredThreadId: string;
  readonly #now: () => string;
  #binding: ThreadBinding | null = null;
  #session: TurnSession | null = null;
  #acquired = false;
  #closed = false;
  #initialized = false;

  static create(
    options: ProductionOwnerOptions & { projectPath: string },
  ): ProductionThreadOwnerAdapter {
    let adapter: ProductionThreadOwnerAdapter | null = null;
    const owner = createProductionOwner({
      ...options,
      transport: {
        ...options.transport,
        onNotification: async (notification) => {
          await options.transport.onNotification?.(notification);
          adapter?.handleNotification(notification);
        },
        onServerRequest: async (request) => {
          await options.transport.onServerRequest?.(request);
          await adapter?.handleServerRequest({
            id: String(request.id),
            type: request.kind,
            method: request.method,
          });
        },
      },
    });
    adapter = new ProductionThreadOwnerAdapter(
      owner,
      options.projectPath,
      options.threadId,
      options.now,
    );
    return adapter;
  }

  private constructor(
    owner: ProductionOwnerPackage,
    projectPath: string,
    threadId: string,
    now: (() => string) | undefined,
  ) {
    this.#owner = owner;
    this.#projectPath = projectPath;
    this.#configuredThreadId = threadId;
    this.#now = now ?? (() => new Date().toISOString());
  }

  connect(binding: ThreadBinding): Promise<void> {
    this.#requireOpen();
    if (
      binding.threadId !== this.#configuredThreadId ||
      binding.ownershipModel !== "exclusive-handoff"
    ) {
      throw new OwnershipError(
        `binding requires exact production thread ${this.#configuredThreadId}`,
        "thread_mismatch",
      );
    }
    this.#binding = binding;
    return Promise.resolve();
  }

  async acquireOwnership(): Promise<OwnershipProof> {
    this.#requireOpen();
    if (!this.#binding) {
      throw new OwnershipError("connect must precede acquire", "not_connected");
    }
    // Real Codex App Server requires initialize before thread/resume|start.
    // Fake peers tolerate a no-op initialize; production must not skip it.
    if (!this.#initialized) {
      await this.#owner.transport.initialize(
        {
          name: "agent-mail-codex",
          version: INGRESS_COMPONENT_VERSION,
        },
        {},
      );
      this.#initialized = true;
    }
    const proof = await this.#owner.lifecycle.acquire({
      bindingId: this.#binding.bindingId,
      projectPath: this.#projectPath,
      expectedThreadId: this.#binding.threadId,
    });
    if (
      proof.threadId !== this.#binding.threadId ||
      proof.subscriberCount !== 1 ||
      proof.competingResponder
    ) {
      throw new OwnershipError("production ownership proof failed", "proof_failed");
    }
    this.#session = new TurnSession(this.#owner.transport, {
      threadId: proof.threadId,
      ownershipMode: "headless",
      now: this.#now,
    });
    this.#acquired = true;
    return proof;
  }

  releaseOwnership(): Promise<void> {
    const session = this.#requireAcquired();
    const snapshot = session.snapshot();
    this.#owner.handoff.setActiveTurn(snapshot.activeTurnId);
    for (const requestId of snapshot.openRequestIds) {
      this.#owner.handoff.openRequest(requestId);
    }
    this.#owner.handoff.releaseToHuman();
    this.#acquired = false;
    return Promise.resolve();
  }

  snapshot(): Promise<ThreadSnapshot> {
    const session = this.#requireAcquired();
    const snapshot = session.snapshot();
    const handoff = this.#owner.handoff.snapshot();
    return Promise.resolve({
      schemaVersion: 1,
      threadId: snapshot.threadId,
      activeTurnId: snapshot.activeTurnId,
      idle: snapshot.idle,
      owner: handoff.owner,
    });
  }

  /** Full live state used by the daemon's ownership control plane. */
  liveSnapshot(): {
    threadId: string;
    activeTurnId: string | null;
    unresolvedRequestIds: string[];
    owner: "headless" | "human" | "none";
  } {
    const session = this.#requireAcquired().snapshot();
    return {
      threadId: session.threadId,
      activeTurnId: session.activeTurnId,
      unresolvedRequestIds: [...session.openRequestIds],
      owner: this.#owner.handoff.snapshot().owner,
    };
  }

  startTurn(input: ModelInput, idempotencyKey: string): Promise<Acceptance> {
    return this.#requireAcquired().startTurn(input, idempotencyKey);
  }

  steerTurn(
    expectedTurnId: string,
    input: ModelInput,
    idempotencyKey: string,
  ): Promise<Acceptance> {
    return this.#requireAcquired().steerTurn(
      expectedTurnId,
      input,
      idempotencyKey,
    );
  }

  async respondToServerRequest(
    requestId: string,
    response: ServerRequestResponse,
  ): Promise<void> {
    this.#requireAcquired();
    const rpcId = /^\d+$/.test(requestId) ? Number(requestId) : requestId;
    if (response.kind === "reject") {
      await this.#owner.transport.respondError(
        rpcId,
        response.code,
        response.message,
      );
      return;
    }
    await this.#owner.transport.respond(
      rpcId,
      response.kind === "answered" ? response.body : { decision: response.kind },
    );
  }

  async *events(signal: AbortSignal): AsyncIterable<ThreadEvent> {
    const session = this.#requireAcquired();
    for await (const event of session.events(signal)) {
      if (
        event.kind === "turnStarted" ||
        event.kind === "turnCompleted" ||
        event.kind === "turnFailed"
      ) {
        yield event;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#acquired = false;
    await this.#owner.transport.close();
  }

  handleNotification(notification: { method: string; params: unknown }): void {
    this.#session?.handleNotification(notification);
  }

  async handleServerRequest(request: ServerRequest): Promise<void> {
    const session = this.#requireAcquired();
    const { response } = session.handleServerRequest(request);
    if (response) {
      await this.respondToServerRequest(request.id, response);
    }
  }

  #requireAcquired(): TurnSession {
    this.#requireOpen();
    if (!this.#acquired || !this.#session) {
      throw new OwnershipError("headless ownership not acquired", "not_acquired");
    }
    return this.#session;
  }

  #requireOpen(): void {
    if (this.#closed) throw new OwnershipError("owner is closed", "closed");
  }
}

export interface ProductionKernelOptions {
  binding: KernelBinding;
  statePath: string;
  mailboxRoot: string;
  owner: ProductionOwnerOptions;
  clock: Clock;
  ownerId?: string;
  pollIntervalMs?: number;
  batchWindowMs?: number;
}

export interface ProductionKernel {
  descriptor: typeof PRODUCTION_RUNTIME;
  startupReport: {
    bindingId: string;
    threadId: string;
    owner: string;
    ownerVersion: string;
    transport: string;
  };
  kernel: IngressKernel;
  /** Live daemon authority; null until kernel creates its sole owner. */
  owner(): ProductionThreadOwnerAdapter | null;
  close(): Promise<void>;
}

/** Compose exactly one production owner with real durable/source adapters. */
export function createProductionKernel(
  options: ProductionKernelOptions,
): ProductionKernel {
  if (options.binding.adapter !== "headless-app-server-owner") {
    throw new OwnershipError(
      `unsupported production adapter ${options.binding.adapter}; no fallback`,
      "proof_failed",
    );
  }
  if (options.owner.threadId !== options.binding.threadId) {
    throw new OwnershipError(
      `owner thread ${options.owner.threadId} != binding ${options.binding.threadId}`,
      "thread_mismatch",
    );
  }

  const store = new SqliteDurableStateStore({ path: options.statePath });
  const mailbox = new FsMailboxSource({ root: options.mailboxRoot });
  let ownerCreated = false;
  let liveOwner: ProductionThreadOwnerAdapter | null = null;
  const deps: IngressKernelDeps = {
    store,
    mailbox,
    clock: options.clock,
    ownerId: options.ownerId,
    pollIntervalMs: options.pollIntervalMs,
    batchWindowMs: options.batchWindowMs,
    createOwner: () => {
      if (ownerCreated) {
        throw new OwnershipError(
          "production owner factory invoked more than once",
          "competing_responder",
        );
      }
      ownerCreated = true;
      liveOwner = ProductionThreadOwnerAdapter.create({
        ...options.owner,
        projectPath: options.binding.projectPath,
      });
      return liveOwner;
    },
  };
  return {
    descriptor: PRODUCTION_RUNTIME,
    startupReport: {
      bindingId: options.binding.bindingId,
      threadId: options.binding.threadId,
      owner: PRODUCTION_OWNER.name,
      ownerVersion: PRODUCTION_RUNTIME.version,
      transport: PRODUCTION_OWNER.transport,
    },
    kernel: new IngressKernel(deps),
    owner: () => liveOwner,
    close: () => store.close(),
  };
}
