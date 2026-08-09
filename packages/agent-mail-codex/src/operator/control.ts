/**
 * O7: canonical control API for the production Codex plugin surface.
 *
 * Skills stay thin: every human-facing start/stop/status/doctor/inspect/handoff/
 * recovery path routes through this module. No silent install-scope, transport,
 * identity, or thread fallbacks.
 */

import { PRODUCTION_OWNER } from "../owner/production_owner.ts";
import { PRODUCTION_RUNTIME } from "../kernel/production.ts";
import type { RuntimeSnapshot } from "./supervisor.ts";
import {
  type AcquireOwnerResult,
  formatOwnershipResult,
  OwnershipCommands,
  type OwnerStateStore,
  type ReleaseOwnerResult,
} from "./ownership_commands.ts";
import type { StatusReport } from "./status.ts";

/** Bump with every O7 packaging change that must bust the Codex plugin cache. */
export const CONTROL_API_VERSION = "0.1.0-o7" as const;

export const PLUGIN_IDENTITY = {
  name: "agent-mail-monitor",
  /** Must match `.codex-plugin/plugin.json` version for drift checks. */
  expectedVersion: "0.1.0+codex.20260728220700",
  marketplace: "tiny-claude-plugins",
  controlApiVersion: CONTROL_API_VERSION,
  runtime: PRODUCTION_RUNTIME,
  owner: PRODUCTION_OWNER,
} as const;

export type ControlAction =
  | "start"
  | "stop"
  | "status"
  | "doctor"
  | "inspect"
  | "handoff"
  | "acquire"
  | "recovery-preview";

export type ControlCode =
  | "ok"
  | "usage"
  | "config_invalid"
  | "daemon_inactive"
  | "daemon_active"
  | "version_drift"
  | "stale_cache"
  | "identity_missing"
  | "thread_missing"
  | "ownership_blocked"
  | "not_found"
  | "confirm_required";

export type DoctorCheck = {
  name:
    | "transport"
    | "version"
    | "identity"
    | "inbox"
    | "ownership"
    | "daemon"
    | "notification";
  state: "healthy" | "unhealthy" | "unknown";
  code: string;
  detail: string;
};

export type ControlRequest = {
  action: ControlAction;
  bindingId: string;
  agent?: string;
  threadId?: string;
  /** Observed plugin.json version from the loaded install/cache. */
  observedPluginVersion?: string;
  /** Observed install root (plugin cache or source path). */
  observedPluginRoot?: string;
  /** Expected source root for local installs (no silent substitution). */
  expectedPluginRoot?: string;
  configPath?: string;
  statePath?: string;
  runtimeSnapshot?: RuntimeSnapshot | null;
  unitActive?: boolean | null;
  mailboxRootExists?: boolean | null;
  owner?: "headless" | "human" | "none" | "unknown";
  statusReport?: StatusReport | null;
  /** Elevated mutations require explicit confirmation. */
  confirm?: boolean;
  to?: "human";
  acquireOwner?: "headless";
};

export type ControlResult = {
  ok: boolean;
  code: ControlCode;
  action: ControlAction;
  bindingId: string;
  message: string;
  plugin: {
    name: string;
    expectedVersion: string;
    observedVersion: string | null;
    controlApiVersion: string;
    cacheKey: string;
  };
  doctor?: DoctorCheck[];
  commands?: string[];
  payload?: Record<string, unknown>;
};

export class ControlError extends Error {
  constructor(
    message: string,
    readonly code: ControlCode,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

function cacheKey(version: string): string {
  return `${PLUGIN_IDENTITY.marketplace}/${PLUGIN_IDENTITY.name}/${version}`;
}

function requireBinding(bindingId: string): string {
  if (!bindingId.trim()) {
    throw new ControlError("--binding is required", "usage");
  }
  return bindingId;
}

/** Detect Codex plugin cache / version drift. Never silently remaps scope. */
export function detectVersionDrift(input: {
  observedPluginVersion?: string;
  observedPluginRoot?: string;
  expectedPluginRoot?: string;
  expectedVersion?: string;
}): { drifted: boolean; code: ControlCode; detail: string } {
  const expected = input.expectedVersion ?? PLUGIN_IDENTITY.expectedVersion;
  if (!input.observedPluginVersion) {
    return {
      drifted: true,
      code: "version_drift",
      detail: "observed plugin version missing; refuse to guess cache entry",
    };
  }
  if (input.observedPluginVersion !== expected) {
    const staleCache = input.observedPluginRoot?.includes("/.codex/plugins/cache/");
    return {
      drifted: true,
      code: staleCache ? "stale_cache" : "version_drift",
      detail: staleCache
        ? `stale cache ${input.observedPluginVersion} != expected ${expected}; reinstall with bumped cachebuster`
        : `plugin version ${input.observedPluginVersion} != expected ${expected}`,
    };
  }
  if (
    input.expectedPluginRoot &&
    input.observedPluginRoot &&
    input.observedPluginRoot !== input.expectedPluginRoot &&
    !input.observedPluginRoot.includes(`/${expected}/`) &&
    !input.observedPluginRoot.includes("/local/")
  ) {
    return {
      drifted: true,
      code: "stale_cache",
      detail:
        `plugin root ${input.observedPluginRoot} does not match expected ${input.expectedPluginRoot}`,
    };
  }
  return { drifted: false, code: "ok", detail: "version matches" };
}

export function buildDoctorChecks(req: ControlRequest): DoctorCheck[] {
  const drift = detectVersionDrift(req);
  const agent = req.agent ?? req.runtimeSnapshot?.agent;
  const threadId = req.threadId ?? req.runtimeSnapshot?.threadId ?? null;
  const owner = req.owner ?? req.runtimeSnapshot?.owner ?? "unknown";
  const mailboxOk = req.mailboxRootExists;
  const unitActive = req.unitActive;
  const adapter = req.runtimeSnapshot?.adapter ?? "headless-app-server-owner";
  const transportOk = adapter === "headless-app-server-owner";

  return [
    {
      name: "transport",
      state: transportOk ? "healthy" : "unhealthy",
      code: transportOk ? "TRANSPORT_OK" : "TRANSPORT_UNSUPPORTED",
      detail: `adapter=${adapter} transport=${PRODUCTION_OWNER.transport}; fallback forbidden`,
    },
    {
      name: "version",
      state: drift.drifted ? "unhealthy" : "healthy",
      code: drift.drifted ? drift.code.toUpperCase() : "VERSION_OK",
      detail: drift.detail,
    },
    {
      name: "identity",
      state: agent ? "healthy" : "unhealthy",
      code: agent ? "IDENTITY_OK" : "IDENTITY_MISSING",
      detail: agent
        ? `agent=${agent}`
        : "Agent Mail identity required; no silent first-agent selection",
    },
    {
      name: "inbox",
      state: mailboxOk === false ? "unhealthy" : mailboxOk === true ? "healthy" : "unknown",
      code: mailboxOk === false
        ? "MAILBOX_MISSING"
        : mailboxOk === true
        ? "MAILBOX_OK"
        : "MAILBOX_UNKNOWN",
      detail: mailboxOk === false
        ? "canonical mailbox root missing"
        : mailboxOk === true
        ? "mailbox root present (non-consuming reads only)"
        : "mailbox existence not probed",
    },
    {
      name: "ownership",
      state: owner === "unknown" ? "unknown" : "healthy",
      code: owner === "unknown" ? "OWNER_UNKNOWN" : `OWNER_${owner.toUpperCase()}`,
      detail: `owner=${owner}; thread=${threadId ?? "none"}`,
    },
    {
      name: "daemon",
      state: unitActive === true
        ? "healthy"
        : unitActive === false
        ? "unhealthy"
        : req.runtimeSnapshot
        ? "healthy"
        : "unknown",
      code: unitActive === true
        ? "DAEMON_ACTIVE"
        : unitActive === false
        ? "DAEMON_INACTIVE"
        : req.runtimeSnapshot
        ? "DAEMON_RUNTIME_PRESENT"
        : "DAEMON_UNKNOWN",
      detail: unitActive === true
        ? `systemd unit agent-mail-codex@${req.bindingId} active`
        : unitActive === false
        ? `systemd unit agent-mail-codex@${req.bindingId} inactive`
        : req.runtimeSnapshot
        ? `runtime snapshot pid=${req.runtimeSnapshot.pid}`
        : "daemon state not probed",
    },
    {
      name: "notification",
      state: "healthy",
      code: "NOTIFICATION_SURFACE_READY",
      detail: "O6 operator notices available; human attach via status --json + resume command",
    },
  ];
}

function baseResult(
  req: ControlRequest,
  code: ControlCode,
  message: string,
  ok = code === "ok",
): ControlResult {
  const observed = req.observedPluginVersion ?? null;
  return {
    ok,
    code,
    action: req.action,
    bindingId: req.bindingId,
    message,
    plugin: {
      name: PLUGIN_IDENTITY.name,
      expectedVersion: PLUGIN_IDENTITY.expectedVersion,
      observedVersion: observed,
      controlApiVersion: CONTROL_API_VERSION,
      cacheKey: cacheKey(observed ?? PLUGIN_IDENTITY.expectedVersion),
    },
  };
}

/** Pure control dispatch — injectable IO stays outside. */
export function dispatchControl(req: ControlRequest): ControlResult {
  requireBinding(req.bindingId);

  if (req.action === "doctor") {
    const checks = buildDoctorChecks(req);
    const unhealthy = checks.filter((c) => c.state === "unhealthy");
    return {
      ...baseResult(
        req,
        unhealthy.length ? "config_invalid" : "ok",
        unhealthy.length
          ? `doctor failed: ${unhealthy.map((c) => c.code).join(",")}`
          : "doctor passed",
        unhealthy.length === 0,
      ),
      doctor: checks,
      commands: [
        `agent-mail-codex doctor --config <path> --binding ${req.bindingId}`,
        `systemctl --user status agent-mail-codex@${req.bindingId}.service`,
      ],
    };
  }

  if (req.action === "status" || req.action === "inspect") {
    const drift = detectVersionDrift(req);
    if (drift.drifted) {
      return baseResult(req, drift.code, drift.detail, false);
    }
    const snapshot = req.runtimeSnapshot;
    return {
      ...baseResult(req, "ok", `${req.action} ok`),
      payload: {
        bindingId: req.bindingId,
        agent: req.agent ?? snapshot?.agent ?? null,
        threadId: req.threadId ?? snapshot?.threadId ?? null,
        owner: req.owner ?? snapshot?.owner ?? "unknown",
        statePath: req.statePath ?? snapshot?.statePath ?? null,
        runtimePath: snapshot?.runtimePath ?? null,
        unitActive: req.unitActive ?? null,
        statusReport: req.statusReport ?? null,
      },
      commands: [
        `agent-mail-codex status --config <path> --binding ${req.bindingId} --json`,
        snapshot?.runtimePath ? `cat ${snapshot.runtimePath}` : undefined,
      ].filter((c): c is string => !!c),
    };
  }

  if (req.action === "start") {
    const drift = detectVersionDrift(req);
    if (drift.drifted) return baseResult(req, drift.code, drift.detail, false);
    if (!req.agent) {
      return baseResult(req, "identity_missing", "start requires --agent", false);
    }
    if (req.unitActive === true) {
      return baseResult(
        req,
        "daemon_active",
        `already active: agent-mail-codex@${req.bindingId}`,
        true,
      );
    }
    return {
      ...baseResult(req, "ok", "start armed"),
      commands: [
        `systemctl --user start agent-mail-codex@${req.bindingId}.service`,
        `loginctl enable-linger "$USER"`,
      ],
      payload: { agent: req.agent, bindingId: req.bindingId },
    };
  }

  if (req.action === "stop") {
    return {
      ...baseResult(req, "ok", "stop requested"),
      commands: [
        `systemctl --user stop agent-mail-codex@${req.bindingId}.service`,
      ],
    };
  }

  if (req.action === "handoff") {
    if (!req.threadId && !req.runtimeSnapshot?.threadId) {
      return baseResult(req, "thread_missing", "handoff requires --thread", false);
    }
    if (!req.confirm) {
      return baseResult(
        req,
        "confirm_required",
        "handoff requires --confirm (explicit release to human)",
        false,
      );
    }
    return {
      ...baseResult(req, "ok", "handoff preview ready"),
      commands: [
        `agent-mail-codex binding release-owner ${req.bindingId} --to human --thread ${
          req.threadId ?? req.runtimeSnapshot?.threadId
        } --config <path>`,
      ],
      payload: { to: "human" },
    };
  }

  if (req.action === "acquire") {
    const threadId = req.threadId ?? req.runtimeSnapshot?.threadId;
    if (!threadId) {
      return baseResult(req, "thread_missing", "acquire requires --thread", false);
    }
    if (!req.confirm) {
      return baseResult(
        req,
        "confirm_required",
        "acquire requires --confirm (explicit headless reacquire)",
        false,
      );
    }
    return {
      ...baseResult(req, "ok", "acquire preview ready"),
      commands: [
        `agent-mail-codex binding acquire-owner ${req.bindingId} --owner headless --thread ${threadId} --config <path>`,
      ],
      payload: { owner: "headless", threadId },
    };
  }

  if (req.action === "recovery-preview") {
    return {
      ...baseResult(req, "ok", "recovery preview — confirm required for mutations"),
      commands: [
        `agent-mail-codex status --config <path> --binding ${req.bindingId} --json`,
        `# O4 mutations require --confirm; see recovery_commands.ts`,
      ],
      payload: { confirmRequired: true },
    };
  }

  throw new ControlError(`unknown action ${req.action}`, "usage");
}

/** Execute ownership mutations when an OwnerStateStore is provided. */
export async function executeHandoff(
  cmds: OwnershipCommands,
  bindingId: string,
  threadId: string,
): Promise<ReleaseOwnerResult> {
  await cmds.ensureHeadless(bindingId, threadId);
  return await cmds.releaseOwnerToHuman(bindingId, "human");
}

export async function executeAcquire(
  cmds: OwnershipCommands,
  bindingId: string,
  threadId: string,
): Promise<AcquireOwnerResult> {
  return await cmds.acquireOwnerHeadless(bindingId, "headless", threadId);
}

export function formatControlResult(result: ControlResult): string {
  const lines = [
    `ok=${result.ok} code=${result.code} action=${result.action} binding=${result.bindingId}`,
    `message=${result.message}`,
    `plugin=${result.plugin.name}@${
      result.plugin.observedVersion ?? "?"
    } expected=${result.plugin.expectedVersion}`,
    `controlApi=${result.plugin.controlApiVersion} cacheKey=${result.plugin.cacheKey}`,
  ];
  if (result.doctor) {
    for (const check of result.doctor) {
      lines.push(
        `doctor.${check.name}=${check.state} code=${check.code} ${check.detail}`,
      );
    }
  }
  if (result.commands?.length) {
    lines.push("commands:");
    for (const command of result.commands) lines.push(`  ${command}`);
  }
  if (result.payload) {
    lines.push(`payload=${JSON.stringify(result.payload)}`);
  }
  return lines.join("\n");
}

export { formatOwnershipResult };
export type { OwnerStateStore };
