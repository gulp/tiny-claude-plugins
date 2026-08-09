/**
 * S2b spike: explicit headless ↔ human ownership handoff (tcp-efp.1.4).
 *
 * Spike-local only — sketches C1/C6 contracts for S5 evidence. Not production
 * ThreadOwnerAdapter / operator CLI / SQLite lease.
 */

export type Owner = "headless" | "human" | "none";

export type PendingBatch = {
  id: string;
  eventIds: number[];
};

export type OwnershipProof = {
  mode: "exclusive-handoff";
  owner: "headless";
  threadId: string;
  subscriberCount: 1;
  competingResponder: false;
};

export type ReleaseResult = {
  owner: "none";
  threadId: string;
  resumeHint: string;
  pendingBatchIds: string[];
};

export type DeliverOutcome = "accepted" | "queued" | "refused";

export class HandoffError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HandoffError";
  }
}

export type SpikeTransport = {
  /** Start a new durable thread; returns its id. */
  startThread: () => Promise<string>;
  /** Resume exact thread; must fail closed (no replacement id). */
  resumeThread: (threadId: string) => Promise<string>;
  /** Deliver a batch on the owned thread; returns when the turn completes. */
  deliver: (threadId: string, batch: PendingBatch) => Promise<void>;
  /** Close the headless controlling connection. */
  disconnect: () => Promise<void>;
  /** Optional: whether a second controlling client is currently attached. */
  competingClientAttached?: () => boolean;
};

export type SpikeHandoffOptions = {
  transport: SpikeTransport;
  /** Seed thread id when replaying an existing binding. */
  threadId?: string;
};

/**
 * Explicit ownership controller. Owner never flips implicitly on disconnect.
 * Delivery is allowed only while owner===headless with a live proof.
 */
export class SpikeHandoffController {
  #owner: Owner = "none";
  #threadId: string | undefined;
  #pending: PendingBatch[] = [];
  #activeTurnId: string | undefined;
  #openServerRequests = new Set<string>();
  #connected = false;
  #deliveredBatchIds = new Set<string>();
  #transport: SpikeTransport;
  readonly transitions: string[] = [];

  constructor(options: SpikeHandoffOptions) {
    this.#transport = options.transport;
    this.#threadId = options.threadId;
  }

  get owner(): Owner {
    return this.#owner;
  }

  get threadId(): string | undefined {
    return this.#threadId;
  }

  get pendingBatches(): readonly PendingBatch[] {
    return this.#pending;
  }

  get deliveredBatchIds(): ReadonlySet<string> {
    return this.#deliveredBatchIds;
  }

  #note(transition: string): void {
    this.transitions.push(`${this.#owner}:${transition}`);
  }

  markTurnActive(turnId: string): void {
    this.#activeTurnId = turnId;
  }

  markTurnCompleted(turnId: string): void {
    if (this.#activeTurnId === turnId) this.#activeTurnId = undefined;
  }

  markServerRequestOpen(id: string): void {
    this.#openServerRequests.add(id);
  }

  markServerRequestClosed(id: string): void {
    this.#openServerRequests.delete(id);
  }

  enqueue(batch: PendingBatch): void {
    if (this.#pending.some((item) => item.id === batch.id)) return;
    this.#pending.push({ id: batch.id, eventIds: [...batch.eventIds] });
    this.#note(`enqueue:${batch.id}`);
  }

  async acquireHeadless(resumeThreadId?: string): Promise<OwnershipProof> {
    if (this.#owner === "headless" && this.#connected) {
      throw new HandoffError("headless owner already active", "already_owned");
    }
    if (this.#owner === "human") {
      throw new HandoffError(
        "cannot acquire headless while human owns the binding",
        "human_owns",
      );
    }
    if (this.#transport.competingClientAttached?.()) {
      throw new HandoffError(
        "competing controlling client attached; refuse headless acquire",
        "overlap",
      );
    }

    const want = resumeThreadId ?? this.#threadId;
    let threadId: string;
    if (want) {
      threadId = await this.#transport.resumeThread(want);
      if (threadId !== want) {
        await this.#transport.disconnect().catch(() => {});
        throw new HandoffError(
          `resume returned replacement thread ${threadId}; refusing`,
          "replacement_thread",
        );
      }
    } else {
      threadId = await this.#transport.startThread();
    }

    this.#threadId = threadId;
    this.#owner = "headless";
    this.#connected = true;
    this.#note(`acquireHeadless:${threadId}`);
    return {
      mode: "exclusive-handoff",
      owner: "headless",
      threadId,
      subscriberCount: 1,
      competingResponder: false,
    };
  }

  async deliverIfOwned(batch: PendingBatch): Promise<DeliverOutcome> {
    if (this.#owner !== "headless" || !this.#connected || !this.#threadId) {
      this.enqueue(batch);
      this.#note(`deliver_refused_queued:${batch.id}:${this.#owner}`);
      return this.#owner === "headless" ? "refused" : "queued";
    }
    if (this.#transport.competingClientAttached?.()) {
      this.#note(`deliver_refused_overlap:${batch.id}`);
      return "refused";
    }
    if (this.#activeTurnId || this.#openServerRequests.size > 0) {
      this.enqueue(batch);
      this.#note(`deliver_deferred:${batch.id}`);
      return "queued";
    }
    if (this.#deliveredBatchIds.has(batch.id)) {
      this.#note(`deliver_duplicate_skip:${batch.id}`);
      return "accepted";
    }

    const turnId = `turn-${batch.id}`;
    this.markTurnActive(turnId);
    try {
      await this.#transport.deliver(this.#threadId, batch);
      this.#deliveredBatchIds.add(batch.id);
      this.#pending = this.#pending.filter((item) => item.id !== batch.id);
      this.#note(`deliver_accepted:${batch.id}`);
      return "accepted";
    } finally {
      this.markTurnCompleted(turnId);
    }
  }

  async drainPending(): Promise<string[]> {
    if (this.#owner !== "headless" || !this.#connected) {
      throw new HandoffError("drain requires active headless owner", "not_headless");
    }
    const drained: string[] = [];
    while (this.#pending.length) {
      const next = this.#pending[0];
      const outcome = await this.deliverIfOwned(next);
      if (outcome !== "accepted") break;
      drained.push(next.id);
    }
    return drained;
  }

  async releaseToHuman(): Promise<ReleaseResult> {
    if (this.#owner !== "headless") {
      throw new HandoffError("release requires headless owner", "not_headless");
    }
    if (this.#activeTurnId) {
      throw new HandoffError(
        `refuse release: active turn ${this.#activeTurnId} not drained`,
        "active_turn",
      );
    }
    if (this.#openServerRequests.size > 0) {
      throw new HandoffError(
        `refuse release: open server requests ${[...this.#openServerRequests].join(",")}`,
        "open_server_request",
      );
    }
    if (!this.#threadId) {
      throw new HandoffError("binding has no thread id", "no_thread");
    }

    const threadId = this.#threadId;
    const pendingBatchIds = this.#pending.map((batch) => batch.id);
    await this.#transport.disconnect();
    this.#connected = false;
    this.#owner = "none";
    this.#note(`releaseToHuman:${threadId}`);
    return {
      owner: "none",
      threadId,
      resumeHint: `codex resume ${threadId}`,
      pendingBatchIds,
    };
  }

  noteHumanAttached(): void {
    if (this.#owner === "headless" && this.#connected) {
      throw new HandoffError(
        "refuse human attach while headless owner is active (overlap)",
        "overlap",
      );
    }
    this.#owner = "human";
    this.#note("noteHumanAttached");
  }

  noteHumanDetached(): void {
    if (this.#owner !== "human") {
      throw new HandoffError("human detach requires human owner", "not_human");
    }
    this.#owner = "none";
    this.#note("noteHumanDetached");
  }

  async reacquireHeadless(): Promise<OwnershipProof> {
    if (this.#owner === "human") {
      throw new HandoffError(
        "human must detach before headless reacquire",
        "human_owns",
      );
    }
    if (!this.#threadId) {
      throw new HandoffError("cannot reacquire without recorded thread id", "no_thread");
    }
    const proof = await this.acquireHeadless(this.#threadId);
    this.#note(`reacquireHeadless:${proof.threadId}`);
    return proof;
  }

  /**
   * Crash/disconnect without explicit release. Owner must NOT become human.
   * Delivery remains forbidden until explicit reacquire.
   */
  forceDisconnectWithoutHandoff(): void {
    this.#connected = false;
    if (this.#owner === "headless") {
      this.#owner = "none";
      this.#note("forceDisconnect:headless→none");
    } else {
      this.#note(`forceDisconnect:${this.#owner}`);
    }
  }

  async close(): Promise<void> {
    if (this.#connected) await this.#transport.disconnect();
    this.#connected = false;
    this.#note("close");
  }
}

/** In-memory transport for pure ownership tests (no Deno child process). */
export function memoryTransport(options?: {
  resumeFails?: boolean;
  competing?: () => boolean;
}): SpikeTransport & {
  started: string[];
  resumed: string[];
  delivered: PendingBatch[];
  disconnected: number;
} {
  const started: string[] = [];
  const resumed: string[] = [];
  const delivered: PendingBatch[] = [];
  let disconnected = 0;
  let nextId = 1;
  const api = {
    started,
    resumed,
    delivered,
    get disconnected() {
      return disconnected;
    },
    competingClientAttached: options?.competing,
    async startThread() {
      const id = `thread-mem-${nextId++}`;
      started.push(id);
      return id;
    },
    async resumeThread(threadId: string) {
      if (options?.resumeFails) {
        throw new HandoffError(`resume failed for ${threadId}`, "resume_failed");
      }
      resumed.push(threadId);
      return threadId;
    },
    async deliver(_threadId: string, batch: PendingBatch) {
      delivered.push(batch);
    },
    async disconnect() {
      disconnected++;
    },
  };
  return api;
}
