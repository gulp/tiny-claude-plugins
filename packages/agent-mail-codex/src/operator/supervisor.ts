/**
 * O3: durable lease helpers + runtime path resolution for systemd/operator surfaces.
 *
 * Production delivery uses `production_run.ts` (private App Server + kernel).
 * This module still publishes inspectable runtime path helpers and a lease
 * heartbeat utility for operator probes.
 */

import type { BindingConfig, IngressConfig } from "../config.ts";
import { EXIT, IngressError } from "../errors.ts";
import {
  type BindingLease,
  type BindingRef,
  SqliteDurableStateStore,
  STORE_INVARIANTS,
  StoreError,
} from "../store/mod.ts";

export const SUPERVISOR_OWNER_PREFIX = "agent-mail-codex-supervisor";

export function supervisorOwnerId(pid: number = Deno.pid): string {
  return `${SUPERVISOR_OWNER_PREFIX}:${pid}`;
}

export type RuntimeSnapshot = {
  schemaVersion: 1;
  pid: number;
  bindingId: string;
  agent: string;
  threadId: string | null;
  owner: "headless" | "none";
  ownership: BindingConfig["codex"]["ownership"];
  adapter: BindingConfig["codex"]["adapter"];
  statePath: string;
  runtimePath: string;
  ownerStateDir: string;
  mailboxRoot: string;
  projectPath: string | null;
  leaseOwnerId: string;
  leaseTtlSeconds: number;
  leaseRenewSeconds: number;
  heartbeatAt: string;
  startedAt: string;
};

export type SupervisorOptions = {
  config: IngressConfig;
  bindingName: string;
  mailboxRoot?: string;
  runtimeDir?: string;
  ownerStateDir?: string;
  ownerId?: string;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  writeRuntime?: (path: string, snapshot: RuntimeSnapshot) => Promise<void>;
};

export type SupervisorResult = {
  ok: boolean;
  reason: "shutdown" | "lease_lost" | "error";
  detail?: string;
  snapshot: RuntimeSnapshot;
};

function defaultMailboxRoot(): string {
  const fromEnv = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT");
  if (fromEnv && fromEnv.startsWith("/")) return fromEnv;
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new IngressError(
      "path_invalid",
      "HOME unset and AGENT_MAIL_MAILBOX_ROOT not set",
      EXIT.CONFIG,
    );
  }
  return `${home}/.mcp_agent_mail_git_mailbox_repo`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function configHash(binding: BindingConfig): string {
  // Deterministic, non-cryptographic fingerprint for lease binding identity.
  const material = JSON.stringify(binding);
  let hash = 2166136261;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function projectPathOf(binding: BindingConfig): string | null {
  return binding.mailScope.kind === "project" ? binding.mailScope.projectPath : null;
}

async function defaultWriteRuntime(path: string, snapshot: RuntimeSnapshot): Promise<void> {
  await Deno.mkdir(parentDir(path), { recursive: true });
  const tmp = `${path}.tmp.${Deno.pid}`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

export async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveRuntimePaths(
  config: IngressConfig,
  bindingName: string,
  options: { runtimeDir?: string; ownerStateDir?: string; mailboxRoot?: string } = {},
): {
  statePath: string;
  runtimePath: string;
  ownerStateDir: string;
  mailboxRoot: string;
} {
  const statePath = config.statePath;
  const stateParent = parentDir(statePath);
  const runtimeDir = options.runtimeDir ?? `${stateParent}/runtime`;
  const ownerStateDir = options.ownerStateDir ?? `${stateParent}/owner-state`;
  return {
    statePath,
    runtimePath: `${runtimeDir}/${bindingName}.json`,
    ownerStateDir,
    mailboxRoot: options.mailboxRoot ?? defaultMailboxRoot(),
  };
}

export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorResult> {
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
      `supervisor refuses adapter ${binding.codex.adapter}; headless-app-server-owner only`,
      EXIT.OWNERSHIP,
    );
  }

  const paths = resolveRuntimePaths(options.config, options.bindingName, options);
  const ownerId = options.ownerId ?? supervisorOwnerId();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const writeRuntime = options.writeRuntime ?? defaultWriteRuntime;
  const startedAt = new Date(now()).toISOString();

  const snapshotBase = (): RuntimeSnapshot => ({
    schemaVersion: 1,
    pid: Deno.pid,
    bindingId: options.bindingName,
    agent: binding.agent,
    threadId: binding.codex.threadId ?? null,
    owner: binding.codex.threadId ? "headless" : "none",
    ownership: binding.codex.ownership,
    adapter: binding.codex.adapter,
    statePath: paths.statePath,
    runtimePath: paths.runtimePath,
    ownerStateDir: paths.ownerStateDir,
    mailboxRoot: paths.mailboxRoot,
    projectPath: projectPathOf(binding),
    leaseOwnerId: ownerId,
    leaseTtlSeconds: STORE_INVARIANTS.leaseTtlSeconds,
    leaseRenewSeconds: STORE_INVARIANTS.leaseRenewSeconds,
    heartbeatAt: new Date(now()).toISOString(),
    startedAt,
  });

  await Deno.mkdir(parentDir(paths.statePath), { recursive: true });
  await Deno.mkdir(paths.ownerStateDir, { recursive: true });

  const store = new SqliteDurableStateStore({ path: paths.statePath });
  let lease: BindingLease | null = null;
  const bindingRef: BindingRef = {
    bindingId: options.bindingName,
    agent: binding.agent,
    configHash: configHash(binding),
    adapter: binding.codex.adapter,
    scopeJson: JSON.stringify(binding.mailScope),
    threadId: binding.codex.threadId ?? null,
  };

  try {
    lease = await store.open(bindingRef, ownerId);
    const at = new Date(now()).toISOString();
    await lease.transact({ kind: "upsertBinding", binding: bindingRef, at });

    let snapshot = snapshotBase();
    await writeRuntime(paths.runtimePath, snapshot);
    console.log(JSON.stringify({ ok: true, event: "supervisor.started", ...snapshot }));

    const renewMs = STORE_INVARIANTS.leaseRenewSeconds * 1000;
    while (!options.signal.aborted) {
      const heartbeatAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + STORE_INVARIANTS.leaseTtlSeconds * 1000).toISOString();
      await lease.transact({
        kind: "renewLease",
        ownerId,
        expiresAt,
        heartbeatAt,
      });
      snapshot = { ...snapshotBase(), heartbeatAt };
      await writeRuntime(paths.runtimePath, snapshot);
      await sleep(renewMs, options.signal);
    }

    console.log(
      JSON.stringify({
        ok: true,
        event: "supervisor.shutdown",
        bindingId: options.bindingName,
        reason: "signal",
      }),
    );
    return { ok: true, reason: "shutdown", snapshot };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const leaseLost = error instanceof StoreError &&
      (error.code === "lease_held" || error.code === "lease_mismatch");
    const snapshot = snapshotBase();
    console.error(JSON.stringify({ ok: false, event: "supervisor.failed", detail, ...snapshot }));
    return {
      ok: false,
      reason: leaseLost ? "lease_lost" : "error",
      detail,
      snapshot,
    };
  } finally {
    await lease?.close().catch(() => {});
    await store.close().catch(() => {});
  }
}
