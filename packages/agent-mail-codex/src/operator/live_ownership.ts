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

type WireRequest =
  | { operation: "snapshot"; bindingId: string }
  | {
    operation: "release";
    bindingId: string;
    requestId: string;
    expectedRevision: number;
  }
  | {
    operation: "acquire";
    bindingId: string;
    requestId: string;
    expectedThreadId: string;
    expectedRevision: number;
  };

type WireResponse =
  | { ok: true; result: LiveOwnerSnapshot | LiveReleaseAck | LiveAcquireAck }
  | { ok: false; code: OwnershipCommandError["code"]; message: string };

export class UnixLiveOwnershipClient implements LiveOwnershipClient {
  readonly #path: string;
  readonly #timeoutMs: number;

  constructor(path: string, timeoutMs = 2_000) {
    if (!path.startsWith("/")) throw new TypeError("control socket path must be absolute");
    this.#path = path;
    this.#timeoutMs = timeoutMs;
  }

  snapshot(bindingId: string): Promise<LiveOwnerSnapshot> {
    return this.#call({ operation: "snapshot", bindingId });
  }

  release(
    bindingId: string,
    requestId: string,
    expectedRevision: number,
  ): Promise<LiveReleaseAck> {
    return this.#call({
      operation: "release",
      bindingId,
      requestId,
      expectedRevision,
    });
  }

  acquire(
    bindingId: string,
    requestId: string,
    expectedThreadId: string,
    expectedRevision: number,
  ): Promise<LiveAcquireAck> {
    return this.#call({
      operation: "acquire",
      bindingId,
      requestId,
      expectedThreadId,
      expectedRevision,
    });
  }

  async #call<T>(request: WireRequest): Promise<T> {
    let conn: Deno.Conn;
    try {
      conn = await withTimeout(
        Deno.connect({ transport: "unix", path: this.#path }),
        this.#timeoutMs,
      );
    } catch (cause) {
      throw new OwnershipCommandError(
        `live ownership daemon absent at ${this.#path}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        "daemon_absent",
      );
    }
    try {
      await conn.write(
        new TextEncoder().encode(`${JSON.stringify(request)}\n`),
      );
      const response = JSON.parse(
        await readLine(conn, this.#timeoutMs),
      ) as WireResponse;
      if (!response.ok) {
        throw new OwnershipCommandError(response.message, response.code);
      }
      return response.result as T;
    } catch (error) {
      if (error instanceof OwnershipCommandError) throw error;
      throw new OwnershipCommandError(
        `live ownership daemon protocol failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "daemon_absent",
      );
    } finally {
      conn.close();
    }
  }
}

export interface LiveOwnershipServer {
  path: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export async function serveUnixLiveOwnership(
  path: string,
  authority: LiveOwnershipClient,
): Promise<LiveOwnershipServer> {
  if (!path.startsWith("/")) throw new TypeError("control socket path must be absolute");
  await Deno.mkdir(parentDir(path), { recursive: true, mode: 0o700 });
  await Deno.remove(path).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const listener = Deno.listen({ transport: "unix", path });
  await Deno.chmod(path, 0o600);
  let stopping = false;
  const closed = (async () => {
    try {
      for await (const conn of listener) {
        void handleConnection(conn, authority);
      }
    } catch (error) {
      if (!stopping && !(error instanceof Deno.errors.BadResource)) throw error;
    } finally {
      await Deno.remove(path).catch(() => {});
    }
  })();
  return {
    path,
    closed,
    close: async () => {
      if (stopping) return await closed;
      stopping = true;
      listener.close();
      await closed;
    },
  };
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
    // Revision is an optimistic precondition, not operation identity. A CLI
    // retry re-snapshots after the first success and must still receive the
    // original acknowledgement for the same request ID.
    const signature = JSON.stringify(["release", bindingId]);
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

async function handleConnection(
  conn: Deno.Conn,
  authority: LiveOwnershipClient,
): Promise<void> {
  let response: WireResponse;
  try {
    const request = JSON.parse(await readLine(conn, 5_000)) as WireRequest;
    const result = request.operation === "snapshot"
      ? await authority.snapshot(request.bindingId)
      : request.operation === "release"
      ? await authority.release(
        request.bindingId,
        request.requestId,
        request.expectedRevision,
      )
      : await authority.acquire(
        request.bindingId,
        request.requestId,
        request.expectedThreadId,
        request.expectedRevision,
      );
    response = { ok: true, result };
  } catch (error) {
    response = {
      ok: false,
      code: error instanceof OwnershipCommandError ? error.code : "daemon_race",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await conn.write(
      new TextEncoder().encode(`${JSON.stringify(response)}\n`),
    );
  } finally {
    conn.close();
  }
}

async function readLine(
  reader: { read(buffer: Uint8Array): Promise<number | null> },
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= 1024 * 1024) {
    const buffer = new Uint8Array(4096);
    const read = await withTimeout(reader.read(buffer), timeoutMs);
    if (read === null) break;
    const chunk = buffer.slice(0, read);
    const newline = chunk.indexOf(10);
    const used = newline >= 0 ? chunk.slice(0, newline) : chunk;
    chunks.push(used);
    size += used.length;
    if (newline >= 0) {
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const item of chunks) {
        merged.set(item, offset);
        offset += item.length;
      }
      return decoder.decode(merged);
    }
  }
  throw new Error("missing or oversized newline-delimited response");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
