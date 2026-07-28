/**
 * C3: exact-thread lifecycle over the C2 private transport.
 *
 * This module never discovers arbitrary threads and never replaces a failed
 * resume with a new thread. The binding store is the sole source of thread
 * identity after first creation.
 */

const DOMAIN_SCHEMA_VERSION = 1 as const;

export interface LifecycleOwnershipProof {
  schemaVersion: 1;
  mode: "exclusive-handoff";
  owner: "headless";
  bindingId: string;
  threadId: string;
  subscriberCount: 1;
  competingResponder: false;
  provenAt: string;
}

export interface LifecycleThreadSnapshot {
  schemaVersion: 1;
  threadId: string;
  activeTurnId: string | null;
  idle: boolean;
  owner: "headless";
}

export interface LifecycleTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  readonly healthy: boolean;
}

export interface ThreadIdStore {
  load(bindingId: string): Promise<string | null>;
  /** Must persist durably before acquire returns. */
  persistFirst(bindingId: string, threadId: string): Promise<void>;
}

export interface ThreadLifecycleBinding {
  bindingId: string;
  projectPath: string;
  /** If supplied, it must equal the durable thread ID. */
  expectedThreadId?: string;
}

export class ThreadLifecycleError extends Error {
  constructor(
    message: string,
    readonly code:
      | "transport_unhealthy"
      | "binding_mismatch"
      | "missing_thread"
      | "invalid_response"
      | "not_acquired",
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ThreadLifecycleError";
  }
}

export class ExactThreadLifecycle {
  #transport: LifecycleTransport;
  #store: ThreadIdStore;
  #now: () => string;
  #binding: ThreadLifecycleBinding | null = null;
  #threadId: string | null = null;
  #acquired = false;

  constructor(
    transport: LifecycleTransport,
    store: ThreadIdStore,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#transport = transport;
    this.#store = store;
    this.#now = now;
  }

  /** Private stdio is deliberately not attachable or discoverable. */
  get attachableTransport(): never {
    throw new ThreadLifecycleError(
      "private stdio owner exposes no attachable transport",
      "not_acquired",
    );
  }

  async acquire(binding: ThreadLifecycleBinding): Promise<LifecycleOwnershipProof> {
    if (!this.#transport.healthy) {
      throw new ThreadLifecycleError("transport is unhealthy", "transport_unhealthy");
    }
    const storedThreadId = await this.#store.load(binding.bindingId);
    let threadId: string;
    if (storedThreadId) {
      if (binding.expectedThreadId && binding.expectedThreadId !== storedThreadId) {
        throw new ThreadLifecycleError(
          `expected thread ${binding.expectedThreadId} != stored ${storedThreadId}`,
          "binding_mismatch",
        );
      }
      threadId = await this.#resumeExact(storedThreadId);
    } else {
      if (binding.expectedThreadId) {
        throw new ThreadLifecycleError(
          `expected thread ${binding.expectedThreadId} is not durably bound`,
          "missing_thread",
        );
      }
      threadId = await this.#start(binding.projectPath);
      await this.#store.persistFirst(binding.bindingId, threadId);
    }
    this.#binding = binding;
    this.#threadId = threadId;
    this.#acquired = true;
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      mode: "exclusive-handoff",
      owner: "headless",
      bindingId: binding.bindingId,
      threadId,
      subscriberCount: 1,
      competingResponder: false,
      provenAt: this.#now(),
    };
  }

  async snapshot(): Promise<LifecycleThreadSnapshot> {
    if (!this.#acquired || !this.#threadId) {
      throw new ThreadLifecycleError("ownership not acquired", "not_acquired");
    }
    if (!this.#transport.healthy) {
      this.#acquired = false;
      throw new ThreadLifecycleError("transport is unhealthy", "transport_unhealthy");
    }
    const response = asObject(
      await this.#transport.request("thread/read", { threadId: this.#threadId }),
      "thread/read",
    );
    const thread = asObject(response.thread, "thread/read.thread");
    const actualId = stringField(thread, "id", "thread/read.thread");
    if (actualId !== this.#threadId) {
      this.#acquired = false;
      throw new ThreadLifecycleError(
        `thread/read returned ${actualId}, expected ${this.#threadId}`,
        "binding_mismatch",
      );
    }
    const activeTurn = thread.activeTurn;
    const activeTurnId = activeTurn === null || activeTurn === undefined
      ? null
      : stringField(asObject(activeTurn, "activeTurn"), "id", "activeTurn");
    return {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      threadId: actualId,
      activeTurnId,
      idle: activeTurnId === null,
      owner: "headless",
    };
  }

  async #resumeExact(expected: string): Promise<string> {
    let response: Record<string, unknown>;
    try {
      response = asObject(
        await this.#transport.request("thread/resume", { threadId: expected }),
        "thread/resume",
      );
    } catch (cause) {
      throw new ThreadLifecycleError(
        `exact thread resume failed for ${expected}; replacement forbidden`,
        "missing_thread",
        cause,
      );
    }
    const thread = asObject(response.thread, "thread/resume.thread");
    const actual = stringField(thread, "id", "thread/resume.thread");
    if (actual !== expected) {
      throw new ThreadLifecycleError(
        `thread/resume returned ${actual}, expected ${expected}`,
        "binding_mismatch",
      );
    }
    return actual;
  }

  async #start(projectPath: string): Promise<string> {
    const response = asObject(
      await this.#transport.request("thread/start", {
        cwd: projectPath,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        ephemeral: false,
      }),
      "thread/start",
    );
    return stringField(
      asObject(response.thread, "thread/start.thread"),
      "id",
      "thread/start.thread",
    );
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreadLifecycleError(`${field} must be an object`, "invalid_response");
  }
  return value as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, key: string, field: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ThreadLifecycleError(`${field}.${key} must be a string`, "invalid_response");
  }
  return value;
}
