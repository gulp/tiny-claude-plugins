/**
 * O3 follow-up: systemd-facing production run.
 *
 * Spawns a private `codex app-server` (stdio), composes `createProductionKernel`,
 * and drives `IngressKernel.run` under one binding lease. Fail-loud; no exec-resume
 * or gateway fallback. Kernel/store internals stay owned by other agents.
 */

import type { BindingConfig, IngressConfig } from "../config.ts";
import { EXIT, IngressError } from "../errors.ts";
import { createProductionKernel, type ProductionKernel } from "../kernel/production.ts";
import { slugForProject } from "../mailbox/mod.ts";
import {
  ACCEPTANCE_CODEX_VERSION,
  INGRESS_COMPONENT_VERSION,
  INGRESS_PROTOCOL_SCHEMA,
} from "../owner/protocol_compat.ts";
import type { ThreadIdStore } from "../owner/thread_lifecycle.ts";
import { SystemClock } from "../retry/mod.ts";
import {
  InProcessLiveOwnershipAuthority,
  type LiveOwnershipServer,
  type LiveOwnerSnapshot,
  serveUnixLiveOwnership,
} from "./live_ownership.ts";
import type { PersistedOwnerState } from "./ownership_commands.ts";
import { resolveNativeCodexBin } from "./codex_bin.ts";
import { buildAppServerEnv } from "./service_permissions.ts";
import { resolveRuntimePaths, type RuntimeSnapshot, supervisorOwnerId } from "./supervisor.ts";

/** @deprecated Prefer resolveNativeCodexBin — kept as sync path-only helper for tests. */
export function resolveCodexBin(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = Deno.env.get("CODEX_BIN");
  if (fromEnv) return fromEnv;
  return "codex";
}

export { resolveNativeCodexBin } from "./codex_bin.ts";

export type SpawnedAppServer = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  processExit: Promise<{ code: number; success?: boolean }>;
  kill: () => void;
};

export type AppServerSpawner = (options: {
  codexBin: string;
  cwd: string;
}) => SpawnedAppServer | Promise<SpawnedAppServer>;

export type ProductionRunOptions = {
  config: IngressConfig;
  bindingName: string;
  signal: AbortSignal;
  mailboxRoot?: string;
  ownerId?: string;
  codexBin?: string;
  spawnAppServer?: AppServerSpawner;
  writeRuntime?: (path: string, snapshot: RuntimeSnapshot) => Promise<void>;
  now?: () => number;
  /** Cap how long we wait for App Server to accept the first ownership proof. */
  startupTimeoutMs?: number;
};

export type ProductionRunResult = {
  ok: boolean;
  reason: "shutdown" | "error" | "lease_lost" | "ownership_lost" | "poison";
  detail?: string;
  startupReport?: ProductionKernel["startupReport"];
  acceptedBatchIds: string[];
};

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function configHash(binding: BindingConfig): string {
  const material = JSON.stringify(binding);
  let hash = 2166136261;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Default private-stdio App Server spawn — one child per binding process. */
export function spawnPrivateAppServer(options: {
  codexBin: string;
  cwd: string;
}): SpawnedAppServer {
  // tcp-efp.5.13: allowlisted child env only — never inherit the full daemon env.
  const env = buildAppServerEnv(Deno.env.toObject(), { codexBin: options.codexBin });
  const child = new Deno.Command(options.codexBin, {
    args: ["app-server", "--listen", "stdio://"],
    cwd: options.cwd,
    clearEnv: true,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    child.kill("SIGTERM");
    throw new IngressError(
      "path_invalid",
      "codex app-server spawn missing stdio pipes",
      EXIT.DEPENDENCY,
    );
  }

  let stopping = false;
  return {
    readable: stdout,
    writable: stdin,
    processExit: child.status.then((status) => ({
      code: status.code,
      success: status.success,
    })),
    kill: () => {
      if (stopping) return;
      stopping = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
    },
  };
}

class FileThreadIdStore implements ThreadIdStore {
  constructor(
    private readonly path: string,
    private readonly configuredThreadId: string,
  ) {}

  async load(_bindingId: string): Promise<string | null> {
    try {
      const text = await Deno.readTextFile(this.path);
      const parsed = JSON.parse(text) as { threadId?: string };
      return parsed.threadId ?? this.configuredThreadId;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return this.configuredThreadId;
      throw error;
    }
  }

  persistFirst(_bindingId: string, threadId: string): Promise<void> {
    // Production bindings must ship with an explicit thread; refuse silent create.
    return Promise.reject(
      new IngressError(
        "ownership_invalid",
        `refusing to persist replacement thread ${threadId}; configure codex.threadId`,
        EXIT.OWNERSHIP,
      ),
    );
  }

  async ensureRecorded(): Promise<void> {
    await Deno.mkdir(parentDir(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(
        tmp,
        `${JSON.stringify({ threadId: this.configuredThreadId }, null, 2)}\n`,
        { create: true, mode: 0o600 },
      );
      await Deno.chmod(tmp, 0o600);
      await Deno.rename(tmp, this.path);
    } catch (error) {
      await Deno.remove(tmp).catch(() => {});
      throw error;
    }
  }
}

async function defaultWriteRuntime(
  path: string,
  snapshot: RuntimeSnapshot,
): Promise<void> {
  await Deno.mkdir(parentDir(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(
      tmp,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { create: true, mode: 0o600 },
    );
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

function compatibilityFixture() {
  return {
    codexVersion: ACCEPTANCE_CODEX_VERSION,
    capabilities: {
      protocolVersion: "2026-07-28",
      methods: [
        "initialize",
        "thread/start",
        "thread/resume",
        "thread/read",
        "turn/start",
        "turn/steer",
      ],
    },
    daemonVersion: INGRESS_COMPONENT_VERSION,
    pluginVersion: INGRESS_COMPONENT_VERSION,
    schemaVersion: INGRESS_PROTOCOL_SCHEMA,
  };
}

/**
 * Run production ingress until signal abort or kernel exit.
 * Injectable `spawnAppServer` lets tests attach a fake App Server without Codex.
 */
export async function runProductionIngress(
  options: ProductionRunOptions,
): Promise<ProductionRunResult> {
  const binding = options.config.bindings[options.bindingName];
  if (!binding) {
    throw new IngressError(
      "binding_missing",
      `unknown binding ${options.bindingName}`,
      EXIT.CONFIG,
    );
  }
  if (binding.codex.adapter !== "headless-app-server-owner") {
    throw new IngressError(
      "adapter_invalid",
      `production run refuses adapter ${binding.codex.adapter}; no fallback`,
      EXIT.OWNERSHIP,
    );
  }
  if (binding.mailScope.kind !== "project") {
    throw new IngressError(
      "scope_invalid",
      "production run supports project mailScope only",
      EXIT.CONFIG,
    );
  }
  const threadId = binding.codex.threadId;
  if (!threadId) {
    throw new IngressError(
      "ownership_invalid",
      "codex.threadId is required for production run; refuse silent thread create",
      EXIT.OWNERSHIP,
    );
  }

  const paths = resolveRuntimePaths(options.config, options.bindingName, {
    mailboxRoot: options.mailboxRoot,
  });
  const ownerId = options.ownerId ?? supervisorOwnerId();
  const now = options.now ?? Date.now;
  const writeRuntime = options.writeRuntime ?? defaultWriteRuntime;
  const spawn = options.spawnAppServer ?? spawnPrivateAppServer;
  const startedAt = new Date(now()).toISOString();

  await Deno.mkdir(parentDir(paths.statePath), { recursive: true });
  await Deno.mkdir(paths.ownerStateDir, { recursive: true, mode: 0o700 });

  const threadStore = new FileThreadIdStore(
    `${paths.ownerStateDir}/${options.bindingName}.thread.json`,
    threadId,
  );
  await threadStore.ensureRecorded();

  const bindingSpec = {
    bindingId: options.bindingName,
    agent: binding.agent,
    configHash: configHash(binding),
    adapter: binding.codex.adapter,
    threadId,
    projectSlug: slugForProject(binding.mailScope.projectPath),
    projectPath: binding.mailScope.projectPath,
  };
  const controlSocket = `${
    parentDir(options.config.statePath)
  }/runtime/${options.bindingName}.ownership.sock`;
  let persisted: PersistedOwnerState | null = null;
  try {
    persisted = JSON.parse(
      await Deno.readTextFile(`${paths.ownerStateDir}/${options.bindingName}.json`),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  type KernelResult = Awaited<ReturnType<ProductionKernel["kernel"]["run"]>>;
  type Session = {
    child: SpawnedAppServer;
    production: ProductionKernel;
    abort: AbortController;
    task: Promise<KernelResult>;
  };
  let session: Session | null = null;
  let revision = 0;
  let live: LiveOwnerSnapshot = {
    bindingId: options.bindingName,
    threadId,
    owner: persisted?.owner === "human" ? "human" : "none",
    activeTurnId: null,
    unresolvedRequestIds: [],
    pending: persisted?.pending ?? [],
    connection: "closed",
    soleOwnershipProven: false,
    revision,
  };
  const acceptedBatchIds: string[] = [];
  let startupReport: ProductionKernel["startupReport"] | undefined;
  let control: LiveOwnershipServer | null = null;
  let unexpected: { detail: string; reason: ProductionRunResult["reason"] } | null = null;
  let wake!: () => void;
  const stopped = new Promise<void>((resolve) => wake = resolve);

  const stopSession = async (): Promise<void> => {
    const current = session;
    if (!current) return;
    session = null;
    current.abort.abort();
    current.child.kill();
    const result = await current.task.catch((error): KernelResult => ({
      ok: false,
      reason: "error",
      detail: error instanceof Error ? error.message : String(error),
      acceptedBatchIds: [],
      queuedBatchIds: [],
      deadLetterBatchIds: [],
      baselineCursor: 0,
    }));
    acceptedBatchIds.push(...result.acceptedBatchIds);
    await current.production.close().catch(() => {});
  };

  const startSession = async (): Promise<void> => {
    if (session) throw new Error("production owner session already open");
    // Injected spawners (tests/fakes) skip native ELF validation; live spawn does not.
    const codexBin = options.spawnAppServer
      ? resolveCodexBin(options.codexBin)
      : await resolveNativeCodexBin(options.codexBin);
    const child = await spawn({
      codexBin,
      cwd: binding.codex.cwd,
    });
    const production = createProductionKernel({
      binding: bindingSpec,
      statePath: paths.statePath,
      mailboxRoot: paths.mailboxRoot,
      ownerId,
      clock: new SystemClock(),
      pollIntervalMs: 1_000,
      batchWindowMs: binding.delivery.batchWindowMs,
      owner: {
        transport: {
          readable: child.readable,
          writable: child.writable,
          processExit: child.processExit,
          requestTimeoutMs: options.startupTimeoutMs ?? 30_000,
        },
        store: threadStore,
        threadId,
        compatibility: compatibilityFixture(),
        now: () => new Date(now()).toISOString(),
      },
    });
    startupReport ??= production.startupReport;
    const abort = new AbortController();
    const task = production.kernel.run(bindingSpec, abort.signal);
    session = { child, production, abort, task };
    const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const owner = production.owner();
      if (owner) {
        try {
          const snapshot = owner.liveSnapshot();
          live = {
            ...live,
            owner: "headless",
            threadId: snapshot.threadId,
            activeTurnId: snapshot.activeTurnId,
            unresolvedRequestIds: snapshot.unresolvedRequestIds,
            connection: "open",
            soleOwnershipProven: true,
            revision: ++revision,
          };
          task.then((result) => {
            if (session?.task === task && !abort.signal.aborted) {
              unexpected = {
                detail: result.detail ?? `kernel stopped: ${result.reason}`,
                reason: result.reason === "lease_lost" ||
                    result.reason === "ownership_lost" ||
                    result.reason === "poison"
                  ? result.reason
                  : "error",
              };
              wake();
            }
          }, (error) => {
            if (session?.task === task && !abort.signal.aborted) {
              unexpected = {
                detail: error instanceof Error ? error.message : String(error),
                reason: "error",
              };
              wake();
            }
          });
          return;
        } catch {
          // The owner is published just before exact-thread acquisition completes.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stopSession();
    throw new Error("timed out waiting for live exact-thread ownership proof");
  };

  try {
    if (persisted?.owner !== "human") await startSession();
    const authority = new InProcessLiveOwnershipAuthority({
      snapshot: async () => {
        const current = session?.production.owner()?.liveSnapshot();
        if (current) {
          live = {
            ...live,
            owner: current.owner,
            activeTurnId: current.activeTurnId,
            unresolvedRequestIds: current.unresolvedRequestIds,
          };
        }
        return live;
      },
      releaseOwnership: async () => {
        const owner = session?.production.owner();
        if (!owner) throw new Error("live production owner absent");
        await owner.releaseOwnership();
        live = { ...live, owner: "human", soleOwnershipProven: false };
      },
      closeConnection: async () => {
        await stopSession();
        live = { ...live, connection: "closed", revision: ++revision };
      },
      acquireOwnership: async (expectedThreadId) => {
        if (expectedThreadId !== threadId) throw new Error("exact thread mismatch");
        await startSession();
      },
    });
    control = await serveUnixLiveOwnership(controlSocket, authority);

    const snapshot: RuntimeSnapshot = {
      schemaVersion: 1,
      pid: Deno.pid,
      bindingId: options.bindingName,
      agent: binding.agent,
      threadId,
      owner: "headless",
      ownership: binding.codex.ownership,
      adapter: binding.codex.adapter,
      statePath: paths.statePath,
      runtimePath: paths.runtimePath,
      ownerStateDir: paths.ownerStateDir,
      mailboxRoot: paths.mailboxRoot,
      projectPath: binding.mailScope.projectPath,
      leaseOwnerId: ownerId,
      leaseTtlSeconds: 20,
      leaseRenewSeconds: 5,
      heartbeatAt: new Date(now()).toISOString(),
      startedAt,
    };
    await writeRuntime(paths.runtimePath, snapshot);

    console.log(JSON.stringify({
      ok: true,
      event: "production.started",
      ...startupReport,
      statePath: paths.statePath,
      runtimePath: paths.runtimePath,
      mailboxRoot: paths.mailboxRoot,
      controlSocket,
    }));

    if (!options.signal.aborted) {
      options.signal.addEventListener("abort", wake, { once: true });
      await stopped;
      options.signal.removeEventListener("abort", wake);
    }
    await control.close();
    control = null;
    await stopSession();
    const failure = unexpected as {
      detail: string;
      reason: ProductionRunResult["reason"];
    } | null;
    return failure
      ? {
        ok: false,
        reason: failure.reason,
        detail: failure.detail,
        startupReport,
        acceptedBatchIds,
      }
      : { ok: true, reason: "shutdown", startupReport, acceptedBatchIds };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      ok: false,
      event: "production.failed",
      detail,
    }));
    return {
      ok: false,
      reason: detail.includes("lease") ? "lease_lost" : "error",
      detail,
      startupReport,
      acceptedBatchIds,
    };
  } finally {
    await control?.close().catch(() => {});
    await stopSession();
  }
}
