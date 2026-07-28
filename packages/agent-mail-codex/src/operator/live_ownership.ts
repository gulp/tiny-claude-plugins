/**
 * O5 follow-up: live daemon authority for explicit ownership handoff.
 *
 * The CLI-facing command object never derives authority from owner-state JSON.
 * It persists only a daemon-acknowledged transition and treats the live
 * connection/proof snapshot as authoritative.
 */

import type { PendingDelivery } from "../owner/handoff.ts";
import {
  type AcquireOwnerResult,
  OwnershipCommandError,
  type OwnerStateStore,
  type PersistedOwnerState,
  type ReleaseOwnerResult,
} from "./ownership_commands.ts";

export type LiveOwnerSnapshot = {
  bindingId: string;
  threadId: string;
  owner: "headless" | "human" | "none";
  activeTurnId: string | null;
  unresolvedRequestIds: string[];
  pending: PendingDelivery[];
  connection: "open" | "closed";
  soleOwnershipProven: boolean;
  revision: number;
};

export type LiveReleaseAck = {
  requestId: string;
  operation: "release";
  beforeRevision: number;
  after: LiveOwnerSnapshot;
  connectionClosed: true;
  resumeCommand: string;
};

export type LiveAcquireAck = {
  requestId: string;
  operation: "acquire";
  beforeRevision: number;
  after: LiveOwnerSnapshot;
  soleOwnershipProven: true;
  drainedPending: PendingDelivery[];
};

export interface LiveOwnershipClient {
  snapshot(bindingId: string): Promise<LiveOwnerSnapshot>;
  release(
    bindingId: string,
    requestId: string,
    expectedRevision: number,
  ): Promise<LiveReleaseAck>;
  acquire(
    bindingId: string,
    requestId: string,
    expectedThreadId: string,
    expectedRevision: number,
  ): Promise<LiveAcquireAck>;
}

export type LiveOwnershipHooks = {
  snapshot(): Promise<LiveOwnerSnapshot>;
  releaseOwnership(): Promise<void>;
  closeConnection(): Promise<void>;
  acquireOwnership(expectedThreadId: string): Promise<void>;
  now?: () => string;
};

type CachedAck =
  | { signature: string; ack: LiveReleaseAck }
  | { signature: string; ack: LiveAcquireAck };

/**
 * Daemon-side serialized authority. A repeated request ID with identical
 * arguments returns the original acknowledgement; reuse with different
 * arguments fails loud.
 */
export class InProcessLiveOwnershipAuthority implements LiveOwnershipClient {
  readonly #hooks: LiveOwnershipHooks;
  readonly #cache = new Map<string, CachedAck>();
  #transition: Promise<void> = Promise.resolve();

  constructor(hooks: LiveOwnershipHooks) {
    this.#hooks = hooks;
  }

  snapshot(bindingId: string): Promise<LiveOwnerSnapshot> {
    return this.#checkedSnapshot(bindingId);
  }

  release(
    bindingId: string,
    requestId: string,
    expectedRevision: number,
  ): Promise<LiveReleaseAck> {
    const signature = JSON.stringify([
      "release",
      bindingId,
      expectedRevision,
    ]);
    return this.#serialize(async () => {
      const cached = this.#cached<LiveReleaseAck>(requestId, signature);
      if (cached) return cached;
      const before = await this.#checkedSnapshot(bindingId);
      this.#requireRevision(before, expectedRevision);
      if (before.owner !== "headless") {
        throw new OwnershipCommandError(
          `release requires live headless owner, got ${before.owner}`,
          "wrong_owner",
        );
      }
      if (before.activeTurnId) {
        throw new OwnershipCommandError(
          `cannot release with active turn ${before.activeTurnId}`,
          "active_turn",
        );
      }
      if (before.unresolvedRequestIds.length) {
        throw new OwnershipCommandError(
          `cannot release with unresolved requests: ${before.unresolvedRequestIds.join(",")}`,
          "unresolved_requests",
        );
      }
      await this.#hooks.releaseOwnership();
      await this.#hooks.closeConnection();
      const after = await this.#checkedSnapshot(bindingId);
      if (after.connection !== "closed") {
        throw new OwnershipCommandError(
          "daemon did not prove private App Server connection closed",
          "connection_open",
        );
      }
      if (after.owner !== "human" || after.threadId !== before.threadId) {
        throw new OwnershipCommandError(
          "daemon release acknowledgement failed owner/thread proof",
          "proof_failed",
        );
      }
      const ack: LiveReleaseAck = {
        requestId,
        operation: "release",
        beforeRevision: before.revision,
        after,
        connectionClosed: true,
        resumeCommand: `codex resume ${shellQuote(after.threadId)}`,
      };
      this.#cache.set(requestId, { signature, ack });
      return ack;
    });
  }

  acquire(
    bindingId: string,
    requestId: string,
    expectedThreadId: string,
    expectedRevision: number,
  ): Promise<LiveAcquireAck> {
    const signature = JSON.stringify([
      "acquire",
      bindingId,
      expectedThreadId,
      expectedRevision,
    ]);
    return this.#serialize(async () => {
      const cached = this.#cached<LiveAcquireAck>(requestId, signature);
      if (cached) return cached;
      const before = await this.#checkedSnapshot(bindingId);
      this.#requireRevision(before, expectedRevision);
      if (before.owner !== "human") {
        throw new OwnershipCommandError(
          `acquire requires live human owner, got ${before.owner}`,
          before.owner === "headless" ? "overlap" : "wrong_owner",
        );
      }
      if (before.threadId !== expectedThreadId) {
        throw new OwnershipCommandError(
          `expected thread ${expectedThreadId} != durable ${before.threadId}`,
          "thread_mismatch",
        );
      }
      await this.#hooks.acquireOwnership(expectedThreadId);
      const after = await this.#checkedSnapshot(bindingId);
      if (
        after.owner !== "headless" ||
        after.threadId !== expectedThreadId ||
        after.connection !== "open" ||
        !after.soleOwnershipProven
      ) {
        throw new OwnershipCommandError(
          "daemon reacquire did not prove exact-thread sole ownership",
          "proof_failed",
        );
      }
      const ack: LiveAcquireAck = {
        requestId,
        operation: "acquire",
        beforeRevision: before.revision,
        after,
        soleOwnershipProven: true,
        drainedPending: [...after.pending].sort((a, b) => a.sequence - b.sequence),
      };
      this.#cache.set(requestId, { signature, ack });
      return ack;
    });
  }

  async #checkedSnapshot(bindingId: string): Promise<LiveOwnerSnapshot> {
    let snapshot: LiveOwnerSnapshot;
    try {
      snapshot = await this.#hooks.snapshot();
    } catch (cause) {
      throw new OwnershipCommandError(
        `live ownership daemon unavailable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "daemon_absent",
      );
    }
    if (snapshot.bindingId !== bindingId) {
      throw new OwnershipCommandError(
        `daemon binding ${snapshot.bindingId} != requested ${bindingId}`,
        "daemon_race",
      );
    }
    return structuredClone(snapshot);
  }

  #requireRevision(
    snapshot: LiveOwnerSnapshot,
    expectedRevision: number,
  ): void {
    if (snapshot.revision !== expectedRevision) {
      throw new OwnershipCommandError(
        `daemon revision ${snapshot.revision} != expected ${expectedRevision}`,
        "daemon_race",
      );
    }
  }

  #cached<T extends LiveReleaseAck | LiveAcquireAck>(
    requestId: string,
    signature: string,
  ): T | null {
    const cached = this.#cache.get(requestId);
    if (!cached) return null;
    if (cached.signature !== signature) {
      throw new OwnershipCommandError(
        `request ID ${requestId} reused with different operation arguments`,
        "daemon_race",
      );
    }
    return structuredClone(cached.ack) as T;
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#transition;
    this.#transition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class LiveOwnershipCommands {
  readonly #client: LiveOwnershipClient;
  readonly #store: OwnerStateStore;
  readonly #now: () => string;

  constructor(options: {
    client: LiveOwnershipClient;
    store: OwnerStateStore;
    now?: () => string;
  }) {
    this.#client = options.client;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async releaseOwnerToHuman(
    bindingId: string,
    requestId: string,
  ): Promise<ReleaseOwnerResult> {
    const before = await this.#snapshot(bindingId);
    const ack = await this.#client.release(
      bindingId,
      requestId,
      before.revision,
    );
    await this.#persistAcknowledged(ack.after);
    return {
      ok: true,
      bindingId,
      owner: "human",
      threadId: ack.after.threadId,
      resumeCommand: ack.resumeCommand,
      pendingCount: ack.after.pending.length,
      message: `live daemon released owner and closed connection; resume: ${ack.resumeCommand}`,
    };
  }

  async acquireOwnerHeadless(
    bindingId: string,
    requestId: string,
    expectedThreadId: string,
  ): Promise<AcquireOwnerResult> {
    const before = await this.#snapshot(bindingId);
    const ack = await this.#client.acquire(
      bindingId,
      requestId,
      expectedThreadId,
      before.revision,
    );
    await this.#persistAcknowledged(ack.after);
    return {
      ok: true,
      bindingId,
      owner: "headless",
      threadId: ack.after.threadId,
      drainedPending: ack.drainedPending,
      message:
        `live daemon proved exact-thread sole ownership; ${ack.drainedPending.length} queued deliver(ies) ready`,
    };
  }

  #snapshot(bindingId: string): Promise<LiveOwnerSnapshot> {
    return this.#client.snapshot(bindingId).catch((error) => {
      if (error instanceof OwnershipCommandError) throw error;
      throw new OwnershipCommandError(
        `live ownership daemon unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "daemon_absent",
      );
    });
  }

  async #persistAcknowledged(snapshot: LiveOwnerSnapshot): Promise<void> {
    const state: PersistedOwnerState = {
      schemaVersion: 1,
      bindingId: snapshot.bindingId,
      threadId: snapshot.threadId,
      owner: snapshot.owner,
      activeTurnId: snapshot.activeTurnId,
      unresolvedRequestIds: [...snapshot.unresolvedRequestIds],
      pending: structuredClone(snapshot.pending),
      updatedAt: this.#now(),
    };
    await this.#store.save(state);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
