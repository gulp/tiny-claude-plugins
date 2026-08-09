/**
 * S3 spike: `codex exec resume` as an explicitly degraded serialized owner
 * (tcp-efp.1.6). Never an automatic fallback from App Server.
 */

export type ExecResumeBatch = {
  id: string;
  eventIds: number[];
  prompt: string;
};

export type ExecResumeResult = {
  batchId: string;
  threadId: string;
  code: number;
  stdout: string;
  stderr: string;
  startedAtMs: number;
  endedAtMs: number;
  pid?: number;
};

export class ExecResumeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ExecResumeError";
  }
}

export type ExecResumeTransport = {
  /** Invoke one `codex exec resume <threadId> <prompt>` process. */
  resume: (threadId: string, prompt: string) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
    pid?: number;
  }>;
};

/**
 * Serialized single-owner adapter. Concurrent deliver calls queue behind a
 * mutex. Resume failure never starts a replacement thread.
 */
export class ExecResumeOwner {
  #threadId: string;
  #transport: ExecResumeTransport;
  #busy: Promise<void> = Promise.resolve();
  #active = 0;
  #delivered = new Set<string>();
  readonly results: ExecResumeResult[] = [];
  readonly transitions: string[] = [];

  constructor(threadId: string, transport: ExecResumeTransport) {
    if (!threadId.trim()) throw new ExecResumeError("thread id required", "no_thread");
    this.#threadId = threadId;
    this.#transport = transport;
  }

  get threadId(): string {
    return this.#threadId;
  }

  get activeCount(): number {
    return this.#active;
  }

  /**
   * Deliver exactly one batch via exec resume. Serialized: at most one
   * underlying process runs at a time for this owner.
   */
  async deliver(batch: ExecResumeBatch): Promise<ExecResumeResult> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#busy;
    this.#busy = previous.then(() => gate);
    await previous;

    this.#active++;
    this.transitions.push(`deliver_start:${batch.id}:active=${this.#active}`);
    const startedAtMs = Date.now();
    try {
      if (this.#delivered.has(batch.id)) {
        const duplicate: ExecResumeResult = {
          batchId: batch.id,
          threadId: this.#threadId,
          code: 0,
          stdout: "duplicate-skip",
          stderr: "",
          startedAtMs,
          endedAtMs: Date.now(),
        };
        this.transitions.push(`deliver_duplicate:${batch.id}`);
        return duplicate;
      }
      const output = await this.#transport.resume(this.#threadId, batch.prompt);
      const endedAtMs = Date.now();
      const result: ExecResumeResult = {
        batchId: batch.id,
        threadId: this.#threadId,
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        startedAtMs,
        endedAtMs,
        pid: output.pid,
      };
      this.results.push(result);
      if (output.code !== 0) {
        this.transitions.push(`deliver_failed:${batch.id}:code=${output.code}`);
        throw new ExecResumeError(
          `exec resume failed for thread ${this.#threadId} (exit ${output.code}): ${
            output.stderr.trim() || output.stdout.trim() || "no output"
          }`,
          "resume_failed",
        );
      }
      this.#delivered.add(batch.id);
      this.transitions.push(`deliver_ok:${batch.id}:ms=${endedAtMs - startedAtMs}`);
      return result;
    } finally {
      this.#active--;
      release();
    }
  }

  /** Fire concurrent delivers; owner must serialize them. */
  async deliverConcurrent(batches: ExecResumeBatch[]): Promise<ExecResumeResult[]> {
    return await Promise.all(batches.map((batch) => this.deliver(batch)));
  }
}

/** Fake transport for deterministic S3 measurements (no live model spend). */
export function fakeExecResumeTransport(options?: {
  holdMs?: number;
  failCodes?: Record<string, number>;
  failMessage?: string;
  /** If set, treat this thread id as missing — fail closed. */
  missingThreadId?: string;
}): ExecResumeTransport & {
  invocations: Array<{ threadId: string; prompt: string; startedAtMs: number; endedAtMs: number }>;
  maxConcurrent: number;
} {
  const invocations: Array<
    { threadId: string; prompt: string; startedAtMs: number; endedAtMs: number }
  > = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  let nextPid = 1000;
  return {
    invocations,
    get maxConcurrent() {
      return maxConcurrent;
    },
    async resume(threadId: string, prompt: string) {
      const startedAtMs = Date.now();
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const pid = nextPid++;
      try {
        if (options?.missingThreadId && threadId === options.missingThreadId) {
          return {
            code: 1,
            stdout: "",
            stderr: options.failMessage ??
              `thread not found: ${threadId} (ambiguous with config failure in real Codex)`,
            pid,
          };
        }
        const failCode = options?.failCodes?.[threadId];
        if (failCode !== undefined) {
          return {
            code: failCode,
            stdout: "",
            stderr: options?.failMessage ?? `forced failure ${failCode}`,
            pid,
          };
        }
        if ((options?.holdMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, options!.holdMs));
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            threadId,
            prompt,
            event: "exec_resume_completed",
          }),
          stderr: "",
          pid,
        };
      } finally {
        inFlight--;
        invocations.push({ threadId, prompt, startedAtMs, endedAtMs: Date.now() });
      }
    },
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) throw new Error("empty sample");
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}
