/** Read-only production probes backing CLI `doctor` and `status`. */

import { DatabaseSync } from "node:sqlite";
import type { BindingConfig, IngressConfig } from "../config.ts";
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from "../migrations/mod.ts";
import { slugForProject } from "../mailbox/mod.ts";
import {
  ACCEPTANCE_CODEX_VERSION,
  INGRESS_COMPONENT_VERSION,
  INGRESS_PROTOCOL_SCHEMA,
} from "../owner/protocol_compat.ts";
import {
  CodexBinError,
  CODEX_BIN_CODES,
  defaultProbeCodexVersion,
  resolveNativeCodexBin,
} from "./codex_bin.ts";
import type { PersistedOwnerState } from "./ownership_commands.ts";
import { resolveRuntimePaths, type RuntimeSnapshot } from "./supervisor.ts";
import {
  type CheckName,
  type DiagnosticCheck,
  inspectStatus,
  type StatusContext,
  type StatusReport,
} from "./status.ts";

export {
  CODEX_BIN_CODES,
  defaultProbeCodexVersion,
  resolveNativeCodexBin,
} from "./codex_bin.ts";

type StoreSnapshot = {
  schemaVersion: number;
  cursor: number | null;
  baselineInitialized: boolean;
  queueDepth: number | null;
  oldestPendingAt: string | null;
  deadLetterDepth: number | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
  lastError: StatusReport["lastError"];
  threadId: string | null;
};

/** Injected Codex CLI version probe — tests must inject; never hang on fixtures. */
export type CodexVersionProbe = () => Promise<string> | string;

export type LiveStatusOptions = {
  config: IngressConfig;
  bindingName: string;
  mailboxRoot?: string;
  now?: () => number;
  /** Override installed Codex binary path (default: CODEX_BIN or `codex`). */
  codexBin?: string;
  /**
   * Injected version string source. When omitted, runs a bounded
   * `codex --version` subprocess (no App Server).
   */
  probeCodexVersion?: CodexVersionProbe;
  /** Max wait for default CLI version probe (ms). */
  versionProbeTimeoutMs?: number;
  /** Max inbox entries to stat during mailbox readability scan. */
  mailboxScanLimit?: number;
};

function check(
  name: CheckName,
  state: DiagnosticCheck["state"],
  code: string,
  detail: string,
): DiagnosticCheck {
  return { name, state, code, detail };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function pathIsDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

function readStore(path: string, bindingId: string): StoreSnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schemaVersion = readSchemaVersion(db);
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      return {
        schemaVersion,
        cursor: null,
        baselineInitialized: false,
        queueDepth: null,
        oldestPendingAt: null,
        deadLetterDepth: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
        threadId: null,
      };
    }
    const binding = db.prepare(
      `SELECT thread_id FROM bindings WHERE binding_id = ?`,
    ).get(bindingId) as { thread_id: string | null } | undefined;
    if (!binding) {
      return {
        schemaVersion,
        cursor: null,
        baselineInitialized: false,
        queueDepth: null,
        oldestPendingAt: null,
        deadLetterDepth: null,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        lastError: null,
        threadId: null,
      };
    }
    const cursor = db.prepare(
      `SELECT last_message_id, baseline_initialized
       FROM cursors WHERE binding_id = ?`,
    ).get(bindingId) as
      | { last_message_id: number; baseline_initialized: number }
      | undefined;
    const depths = db.prepare(
      `SELECT
         SUM(CASE WHEN state IN ('pending', 'delivering') THEN 1 ELSE 0 END) AS queued,
         MIN(CASE WHEN state IN ('pending', 'delivering') THEN created_at END) AS oldest_pending_at,
         SUM(CASE WHEN state = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letters
       FROM batches WHERE binding_id = ?`,
    ).get(bindingId) as {
      queued: number | null;
      oldest_pending_at: string | null;
      dead_letters: number | null;
    };
    const lease = db.prepare(
      `SELECT owner_id, expires_at FROM leases WHERE binding_id = ?`,
    ).get(bindingId) as { owner_id: string; expires_at: string } | undefined;
    const failure = db.prepare(
      `SELECT last_error_code, last_error_detail, updated_at
       FROM batches
       WHERE binding_id = ? AND last_error_code IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(bindingId) as
      | { last_error_code: string; last_error_detail: string | null; updated_at: string }
      | undefined;
    return {
      schemaVersion,
      cursor: cursor ? Number(cursor.last_message_id) : null,
      baselineInitialized: Number(cursor?.baseline_initialized ?? 0) === 1,
      queueDepth: Number(depths.queued ?? 0),
      oldestPendingAt: depths.oldest_pending_at,
      deadLetterDepth: Number(depths.dead_letters ?? 0),
      leaseOwnerId: lease?.owner_id ?? null,
      leaseExpiresAt: lease?.expires_at ?? null,
      lastError: failure
        ? {
          code: failure.last_error_code,
          message: failure.last_error_detail ?? "batch failure",
          at: failure.updated_at,
        }
        : null,
      threadId: binding.thread_id,
    };
  } finally {
    db.close();
  }
}

function projectOf(binding: BindingConfig): {
  projectPath: string;
  projectSlug: string;
} {
  if (binding.mailScope.kind !== "project") {
    throw new TypeError("live status supports project mailScope only");
  }
  return {
    projectPath: binding.mailScope.projectPath,
    projectSlug: slugForProject(binding.mailScope.projectPath),
  };
}

/** Extract semver from `codex --version` text (e.g. `codex-cli 0.145.0`). */
export function parseCodexCliVersion(raw: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(raw.trim());
  return match?.[1] ?? null;
}

type CliVersionDisposition = "acceptance" | "drift_probe" | "unsupported";

/** C10 version policy for installed CLI without attaching App Server. */
export function assessCodexCliVersion(observedRaw: string): {
  disposition: CliVersionDisposition;
  baseline: string;
  observed: string;
  reason: string;
} {
  const observed = parseCodexCliVersion(observedRaw) ?? observedRaw.trim();
  const parsedObs = parseSemver(observed);
  const baseline = parseSemver(ACCEPTANCE_CODEX_VERSION)!;
  if (!parsedObs) {
    return {
      disposition: "unsupported",
      baseline: ACCEPTANCE_CODEX_VERSION,
      observed,
      reason: `malformed Codex version: ${observedRaw.trim() || "<empty>"}`,
    };
  }
  const cmp = compareSemver(parsedObs, baseline);
  if (cmp === 0) {
    return {
      disposition: "acceptance",
      baseline: ACCEPTANCE_CODEX_VERSION,
      observed,
      reason: `matches acceptance baseline ${ACCEPTANCE_CODEX_VERSION}`,
    };
  }
  if (cmp > 0) {
    return {
      disposition: "drift_probe",
      baseline: ACCEPTANCE_CODEX_VERSION,
      observed,
      reason:
        `newer than acceptance baseline ${ACCEPTANCE_CODEX_VERSION}; evidence is drift-only`,
    };
  }
  return {
    disposition: "unsupported",
    baseline: ACCEPTANCE_CODEX_VERSION,
    observed,
    reason: `older than acceptance baseline ${ACCEPTANCE_CODEX_VERSION}`,
  };
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const d = left[i] - right[i];
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export async function probeMailboxLayout(options: {
  mailboxRoot: string;
  projectSlug: string;
  agent: string;
  scanLimit?: number;
}): Promise<DiagnosticCheck> {
  const limit = options.scanLimit ?? 64;
  const projectsDir = `${options.mailboxRoot}/projects`;
  if (!(await pathIsDir(projectsDir))) {
    return check(
      "mailbox",
      "unhealthy",
      "MAILBOX_LAYOUT_DRIFT",
      `missing projects/ under ${options.mailboxRoot}`,
    );
  }
  const inboxPath =
    `${options.mailboxRoot}/projects/${options.projectSlug}/agents/${options.agent}/inbox`;
  if (!(await pathIsDir(inboxPath))) {
    return check(
      "mailbox",
      "unhealthy",
      "MAILBOX_INBOX_MISSING",
      `canonical inbox missing: ${inboxPath}`,
    );
  }
  try {
    let scanned = 0;
    for await (const entry of Deno.readDir(inboxPath)) {
      scanned += 1;
      if (scanned > limit) break;
      if (entry.isFile || entry.isSymlink) {
        // Stat only — never read body / never mutate read_ts.
        await Deno.stat(`${inboxPath}/${entry.name}`);
      }
    }
    return check(
      "mailbox",
      "healthy",
      "MAILBOX_OK",
      `canonical inbox readable layout ok inbox=${inboxPath} scanned<=${limit}`,
    );
  } catch (error) {
    return check(
      "mailbox",
      "unhealthy",
      "MAILBOX_UNREADABLE",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function probeConfigConsistency(options: {
  bindingName: string;
  binding: BindingConfig;
  projectPath: string;
  statePath: string;
  mailboxRoot: string;
  runtime: RuntimeSnapshot | null;
}): DiagnosticCheck {
  const { binding, bindingName, projectPath, statePath, mailboxRoot, runtime } = options;
  if (!statePath.startsWith("/") || !mailboxRoot.startsWith("/") || !projectPath.startsWith("/")) {
    return check(
      "config",
      "unhealthy",
      "CONFIG_PATH_INVALID",
      "statePath, mailboxRoot, and projectPath must be absolute",
    );
  }
  if (!binding.codex.cwd.startsWith("/")) {
    return check(
      "config",
      "unhealthy",
      "CONFIG_PATH_INVALID",
      `codex.cwd must be absolute: ${binding.codex.cwd}`,
    );
  }
  if (binding.codex.adapter !== "headless-app-server-owner") {
    return check(
      "config",
      "unhealthy",
      "CONFIG_ADAPTER_UNSUPPORTED",
      `adapter=${binding.codex.adapter}; headless-app-server-owner required`,
    );
  }
  if (!runtime) {
    return check(
      "config",
      "healthy",
      "CONFIG_OK",
      `binding=${bindingName} adapter=${binding.codex.adapter} (no runtime snapshot yet)`,
    );
  }
  const mismatches: string[] = [];
  if (runtime.bindingId !== bindingName) {
    mismatches.push(`bindingId runtime=${runtime.bindingId} config=${bindingName}`);
  }
  if (runtime.agent !== binding.agent) {
    mismatches.push(`agent runtime=${runtime.agent} config=${binding.agent}`);
  }
  if (runtime.adapter !== binding.codex.adapter) {
    mismatches.push(`adapter runtime=${runtime.adapter} config=${binding.codex.adapter}`);
  }
  if (runtime.ownership !== binding.codex.ownership) {
    mismatches.push(
      `ownership runtime=${runtime.ownership} config=${binding.codex.ownership}`,
    );
  }
  if (runtime.statePath !== statePath) {
    mismatches.push(`statePath runtime=${runtime.statePath} config=${statePath}`);
  }
  if (runtime.mailboxRoot !== mailboxRoot) {
    mismatches.push(`mailboxRoot runtime=${runtime.mailboxRoot} config=${mailboxRoot}`);
  }
  if ((runtime.projectPath ?? null) !== projectPath) {
    mismatches.push(
      `projectPath runtime=${runtime.projectPath ?? "<null>"} config=${projectPath}`,
    );
  }
  const configThread = binding.codex.threadId ?? null;
  if (configThread && runtime.threadId && runtime.threadId !== configThread) {
    mismatches.push(`threadId runtime=${runtime.threadId} config=${configThread}`);
  }
  if (mismatches.length) {
    return check(
      "config",
      "unhealthy",
      "CONFIG_RUNTIME_MISMATCH",
      mismatches.join("; "),
    );
  }
  return check(
    "config",
    "healthy",
    "CONFIG_OK",
    `binding=${bindingName} agent=${binding.agent} adapter=${binding.codex.adapter} runtime consistent`,
  );
}

async function probeCodexVersionCheck(options: {
  probe?: CodexVersionProbe;
  codexBin?: string;
  timeoutMs: number;
  storeSchema: number | null;
}): Promise<DiagnosticCheck> {
  let raw: string;
  try {
    if (options.probe) {
      raw = await options.probe();
    } else {
      const nativeBin = await resolveNativeCodexBin(options.codexBin);
      raw = await defaultProbeCodexVersion(nativeBin, options.timeoutMs);
    }
  } catch (error) {
    if (error instanceof CodexBinError) {
      return check("version", "unhealthy", error.binCode, error.message);
    }
    return check(
      "version",
      "unhealthy",
      CODEX_BIN_CODES.PROBE_FAILED,
      error instanceof Error ? error.message : String(error),
    );
  }
  const assessed = assessCodexCliVersion(raw);
  const storePart = options.storeSchema === null
    ? "store=<unreadable>"
    : `store=${options.storeSchema}`;
  const detail =
    `codex=${assessed.observed} baseline=${assessed.baseline} disposition=${assessed.disposition}; ${assessed.reason}; statusSchema=${INGRESS_PROTOCOL_SCHEMA} component=${INGRESS_COMPONENT_VERSION} ${storePart}`;
  if (assessed.disposition === "acceptance") {
    return check("version", "healthy", "VERSION_OK", detail);
  }
  if (assessed.disposition === "drift_probe") {
    return check("version", "unhealthy", "VERSION_DRIFT", detail);
  }
  return check("version", "unhealthy", "VERSION_UNSUPPORTED", detail);
}

export async function inspectLiveStatus(
  options: LiveStatusOptions,
): Promise<StatusReport> {
  const binding = options.config.bindings[options.bindingName];
  if (!binding) throw new TypeError(`unknown binding ${options.bindingName}`);
  const nowMs = (options.now ?? Date.now)();
  const observedAt = new Date(nowMs).toISOString();
  const project = projectOf(binding);
  const paths = resolveRuntimePaths(options.config, options.bindingName, {
    mailboxRoot: options.mailboxRoot,
  });
  const runtime = await readJson<RuntimeSnapshot>(paths.runtimePath);
  const ownerState = await readJson<PersistedOwnerState>(
    `${paths.ownerStateDir}/${options.bindingName}.json`,
  );

  let store: StoreSnapshot | null = null;
  let storeFailure: string | null = null;
  try {
    const stat = await Deno.stat(paths.statePath);
    if (!stat.isFile) throw new TypeError("statePath is not a regular file");
    store = readStore(paths.statePath, options.bindingName);
  } catch (error) {
    storeFailure = error instanceof Error ? error.message : String(error);
  }

  const mailboxCheck = await probeMailboxLayout({
    mailboxRoot: paths.mailboxRoot,
    projectSlug: project.projectSlug,
    agent: binding.agent,
    scanLimit: options.mailboxScanLimit,
  });

  const configCheck = probeConfigConsistency({
    bindingName: options.bindingName,
    binding,
    projectPath: project.projectPath,
    statePath: paths.statePath,
    mailboxRoot: paths.mailboxRoot,
    runtime,
  });

  const versionCheck = await probeCodexVersionCheck({
    probe: options.probeCodexVersion,
    codexBin: options.codexBin,
    timeoutMs: options.versionProbeTimeoutMs ?? 2_000,
    storeSchema: store?.schemaVersion ?? null,
  });

  const leaseLive = store?.leaseExpiresAt ? Date.parse(store.leaseExpiresAt) >= nowMs : false;
  const runtimeMatchesLease = runtime !== null &&
    runtime.bindingId === options.bindingName &&
    runtime.leaseOwnerId === store?.leaseOwnerId;
  const owner = ownerState?.owner === "human"
    ? "human"
    : runtimeMatchesLease && leaseLive && runtime?.owner === "headless"
    ? "headless"
    : ownerState?.owner === "none"
    ? "none"
    : "unknown";
  const threadId = store?.threadId ?? runtime?.threadId ?? binding.codex.threadId ??
    null;

  const values: Record<CheckName, DiagnosticCheck> = {
    config: configCheck,
    mailbox: mailboxCheck,
    store: storeFailure
      ? check("store", "unhealthy", "STORE_UNREADABLE", storeFailure)
      : !store
      ? check("store", "unknown", "STORE_STATE_UNKNOWN", "state unavailable")
      : store.schemaVersion !== CURRENT_SCHEMA_VERSION
      ? check(
        "store",
        "unhealthy",
        "STORE_SCHEMA_MISMATCH",
        `schema=${store.schemaVersion} expected=${CURRENT_SCHEMA_VERSION}`,
      )
      : check("store", "healthy", "STORE_OK", `schema=${store.schemaVersion}`),
    lease: !store
      ? check("lease", "unknown", "LEASE_STATE_UNKNOWN", "store unavailable")
      : !store.leaseOwnerId
      ? check("lease", "unhealthy", "LEASE_MISSING", "binding has no lease")
      : !leaseLive
      ? check(
        "lease",
        "unhealthy",
        "LEASE_EXPIRED",
        `owner=${store.leaseOwnerId} expired=${store.leaseExpiresAt}`,
      )
      : check(
        "lease",
        "healthy",
        "LEASE_OK",
        `owner=${store.leaseOwnerId} expires=${store.leaseExpiresAt}`,
      ),
    owner: owner === "unknown"
      ? check("owner", "unknown", "OWNER_STATE_UNKNOWN", "no fresh authoritative owner")
      : check("owner", "healthy", "OWNER_OK", `owner=${owner}`),
    thread: !threadId
      ? check("thread", "unhealthy", "THREAD_UNBOUND", "no durable thread configured")
      : store?.threadId && binding.codex.threadId &&
          store.threadId !== binding.codex.threadId
      ? check(
        "thread",
        "unhealthy",
        "THREAD_MISMATCH",
        `store=${store.threadId} config=${binding.codex.threadId}`,
      )
      : check("thread", "healthy", "THREAD_OK", `thread=${threadId}`),
    cursor: !store || store.cursor === null
      ? check("cursor", "unknown", "CURSOR_STATE_UNKNOWN", "cursor unavailable")
      : !store.baselineInitialized
      ? check(
        "cursor",
        "unknown",
        "CURSOR_NOT_BASELINED",
        `cursor=${store.cursor} first start incomplete`,
      )
      : check("cursor", "healthy", "CURSOR_OK", `lastMessageId=${store.cursor}`),
    queue: !store || store.queueDepth === null
      ? check("queue", "unknown", "QUEUE_STATE_UNKNOWN", "queue unavailable")
      : store.deadLetterDepth
      ? check(
        "queue",
        "unhealthy",
        "QUEUE_DEAD_LETTERS",
        `pending=${store.queueDepth} deadLetters=${store.deadLetterDepth}`,
      )
      : check(
        "queue",
        "healthy",
        "QUEUE_OK",
        store.oldestPendingAt
          ? `pending=${store.queueDepth} oldestPendingAt=${store.oldestPendingAt}`
          : `pending=${store.queueDepth}`,
      ),
    version: versionCheck,
  };

  const context: StatusContext = {
    bindingId: options.bindingName,
    agent: binding.agent,
    projectSlug: project.projectSlug,
    threadId,
    owner,
    cursor: store?.cursor ?? null,
    queueDepth: store?.queueDepth ?? null,
    lastError: store?.lastError ?? null,
    probes: Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        { snapshot: () => value },
      ]),
    ) as StatusContext["probes"],
  };
  return await inspectStatus(context, () => observedAt);
}
