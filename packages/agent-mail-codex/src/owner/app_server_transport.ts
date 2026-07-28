/// <reference lib="deno.window" />

/**
 * C2: newline-delimited JSON-RPC transport for a privately-owned Codex App Server.
 *
 * Policy and thread lifecycle stay above this module. This layer owns framing,
 * request correlation, initialization, typed server requests, and fail-closed
 * transport health.
 */

export type RpcId = string | number;
export type JsonObject = Record<string, unknown>;

export type AppServerRequestKind =
  | "elicitation"
  | "approval"
  | "permissions"
  | "userInput"
  | "currentTime";

export interface AppServerRequest {
  id: RpcId;
  kind: AppServerRequestKind;
  method: string;
  params: unknown;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerTransportOptions {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Resolves when the owned child exits. Omit for in-memory/socket-free tests. */
  processExit?: Promise<{ code: number; success?: boolean }>;
  requestTimeoutMs?: number;
  onServerRequest?: (request: AppServerRequest) => void | Promise<void>;
  onNotification?: (notification: AppServerNotification) => void | Promise<void>;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcMessage = {
  id?: RpcId;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

const SERVER_REQUEST_KINDS: Readonly<Record<string, AppServerRequestKind>> = {
  "mcpServer/elicitation/request": "elicitation",
  "item/commandExecution/requestApproval": "approval",
  "item/fileChange/requestApproval": "approval",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "userInput",
  "currentTime/read": "currentTime",
};

export class AppServerTransportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "closed"
      | "unhealthy"
      | "process_exit"
      | "timeout"
      | "protocol"
      | "remote_error",
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppServerTransportError";
  }
}

export class AppServerTransport {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #pending = new Map<RpcId, Pending>();
  #nextId = 1;
  #requestTimeoutMs: number;
  #onServerRequest?: AppServerTransportOptions["onServerRequest"];
  #onNotification?: AppServerTransportOptions["onNotification"];
  #failure: AppServerTransportError | null = null;
  #closed = false;
  #readTask: Promise<void>;

  constructor(options: AppServerTransportOptions) {
    this.#reader = options.readable.getReader();
    this.#writer = options.writable.getWriter();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive integer");
    }
    this.#onServerRequest = options.onServerRequest;
    this.#onNotification = options.onNotification;
    this.#readTask = this.#readLoop();
    this.#readTask.catch(() => {});
    options.processExit?.then(
      (status) => {
        if (!this.#closed) {
          this.#fail(
            new AppServerTransportError(
              `Codex App Server exited with code ${status.code}`,
              "process_exit",
            ),
          );
        }
      },
      (cause) => {
        if (!this.#closed) {
          this.#fail(
            new AppServerTransportError(
              "failed to observe Codex App Server process",
              "process_exit",
              cause,
            ),
          );
        }
      },
    );
  }

  get healthy(): boolean {
    return !this.#closed && this.#failure === null;
  }

  get failure(): AppServerTransportError | null {
    return this.#failure;
  }

  async initialize(clientInfo: JsonObject, capabilities: unknown = null): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo, capabilities });
    await this.notify("initialized");
    return result;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.#requireHealthy();
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new AppServerTransportError(
            `App Server request timed out: ${method} (${id})`,
            "timeout",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (cause) {
      this.#rejectPending(
        id,
        new AppServerTransportError(
          `failed to write App Server request: ${method}`,
          "unhealthy",
          cause,
        ),
      );
    }
    return await result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#requireHealthy();
    await this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    this.#requireHealthy();
    await this.#write({ id, result });
  }

  async respondError(id: RpcId, code: number, message: string, data?: unknown): Promise<void> {
    this.#requireHealthy();
    await this.#write({
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new AppServerTransportError("App Server transport closed", "closed"));
    await Promise.allSettled([
      this.#reader.cancel(),
      this.#writer.close(),
    ]);
    await this.#readTask.catch(() => {});
  }

  async #readLoop(): Promise<void> {
    let buffer = "";
    try {
      while (!this.#closed) {
        const { value, done } = await this.#reader.read();
        if (done) {
          if (buffer.trim()) {
            throw new AppServerTransportError("truncated JSON-RPC frame", "protocol");
          }
          if (!this.#closed) {
            throw new AppServerTransportError("App Server stdout closed", "process_exit");
          }
          return;
        }
        buffer += this.#decoder.decode(value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          await this.#dispatch(this.#parse(line));
        }
      }
    } catch (cause) {
      if (!this.#closed) {
        this.#fail(
          cause instanceof AppServerTransportError
            ? cause
            : new AppServerTransportError("App Server read failed", "protocol", cause),
        );
      }
    }
  }

  #parse(line: string): RpcMessage {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new AppServerTransportError("invalid JSON-RPC frame", "protocol", cause);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppServerTransportError("JSON-RPC frame must be an object", "protocol");
    }
    return value as RpcMessage;
  }

  async #dispatch(message: RpcMessage): Promise<void> {
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    const hasMethod = typeof message.method === "string";
    if (hasId && !hasMethod) {
      const pending = this.#pending.get(message.id!);
      if (!pending) return;
      this.#pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new AppServerTransportError(
            String(message.error.message ?? "App Server request failed"),
            "remote_error",
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (hasId && hasMethod) {
      const method = message.method as string;
      const kind = SERVER_REQUEST_KINDS[method];
      if (!kind) {
        await this.respondError(message.id!, -32601, `unsupported App Server request: ${method}`);
        throw new AppServerTransportError(
          `unsupported App Server request: ${method}`,
          "protocol",
        );
      }
      await this.#onServerRequest?.({
        id: message.id!,
        kind,
        method,
        params: message.params,
      });
      return;
    }
    if (!hasId && hasMethod) {
      await this.#onNotification?.({
        method: message.method as string,
        params: message.params,
      });
      return;
    }
    throw new AppServerTransportError("unrecognized JSON-RPC frame", "protocol");
  }

  async #write(message: JsonObject): Promise<void> {
    try {
      await this.#writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
    } catch (cause) {
      const error = new AppServerTransportError("App Server write failed", "unhealthy", cause);
      this.#fail(error);
      throw error;
    }
  }

  #rejectPending(id: RpcId, error: AppServerTransportError): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #rejectAll(error: AppServerTransportError): void {
    for (const [id] of this.#pending) this.#rejectPending(id, error);
  }

  #fail(error: AppServerTransportError): void {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    this.#rejectAll(error);
    void this.#reader.cancel(error).catch(() => {});
  }

  #requireHealthy(): void {
    if (this.#closed) throw new AppServerTransportError("transport closed", "closed");
    if (this.#failure) {
      throw new AppServerTransportError(
        `transport unhealthy: ${this.#failure.message}`,
        "unhealthy",
        this.#failure,
      );
    }
  }
}
