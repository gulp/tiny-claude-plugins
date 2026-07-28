/** O1: stable, read-only doctor and status contracts. */

export const STATUS_SCHEMA_VERSION = 1 as const;

export type CheckName =
  | "config"
  | "mailbox"
  | "store"
  | "lease"
  | "owner"
  | "thread"
  | "cursor"
  | "queue"
  | "version";

export type CheckState = "healthy" | "unhealthy" | "unknown";

export interface DiagnosticCheck {
  name: CheckName;
  state: CheckState;
  code: string;
  detail: string;
}

export interface StatusReport {
  schemaVersion: 1;
  healthy: boolean;
  bindingId: string;
  agent: string;
  projectSlug: string;
  threadId: string | null;
  owner: "headless" | "human" | "none" | "unknown";
  cursor: number | null;
  queueDepth: number | null;
  checks: DiagnosticCheck[];
  lastError: {
    code: string;
    message: string;
    at: string;
  } | null;
  observedAt: string;
}

/** Read-only by construction: probes expose only a snapshot method. */
export interface StatusProbe {
  snapshot(): DiagnosticCheck | Promise<DiagnosticCheck>;
}

export interface StatusContext {
  bindingId: string;
  agent: string;
  projectSlug: string;
  threadId: string | null;
  owner: StatusReport["owner"];
  cursor: number | null;
  queueDepth: number | null;
  lastError: StatusReport["lastError"];
  probes: Readonly<Record<CheckName, StatusProbe>>;
}

const CHECK_NAMES: readonly CheckName[] = [
  "config",
  "mailbox",
  "store",
  "lease",
  "owner",
  "thread",
  "cursor",
  "queue",
  "version",
];

export async function inspectStatus(
  context: StatusContext,
  now: () => string = () => new Date().toISOString(),
): Promise<StatusReport> {
  const checks: DiagnosticCheck[] = [];
  for (const name of CHECK_NAMES) {
    try {
      const check = await context.probes[name].snapshot();
      checks.push(normalizeCheck(name, check));
    } catch (cause) {
      checks.push({
        name,
        state: "unhealthy",
        code: `${name.toUpperCase()}_PROBE_FAILED`,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    healthy: checks.every((check) => check.state === "healthy") && context.lastError === null,
    bindingId: required(context.bindingId, "bindingId"),
    agent: required(context.agent, "agent"),
    projectSlug: required(context.projectSlug, "projectSlug"),
    threadId: context.threadId,
    owner: context.owner,
    cursor: context.cursor,
    queueDepth: context.queueDepth,
    checks,
    lastError: context.lastError,
    observedAt: now(),
  };
}

export function renderStatusHuman(report: StatusReport): string {
  const lines = [
    `Binding: ${report.bindingId}`,
    `Agent: ${report.agent}`,
    `Project: ${report.projectSlug}`,
    `Thread: ${report.threadId ?? "<unbound>"}`,
    `Owner: ${report.owner}`,
    `Cursor: ${report.cursor ?? "<unknown>"}`,
    `Queue: ${report.queueDepth ?? "<unknown>"}`,
    `Health: ${report.healthy ? "healthy" : "UNHEALTHY"}`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.name}: ${check.state} [${check.code}] ${check.detail}`);
  }
  if (report.lastError) {
    lines.push(
      `Last error: [${report.lastError.code}] ${report.lastError.message} at ${report.lastError.at}`,
    );
  }
  return lines.join("\n");
}

function normalizeCheck(expectedName: CheckName, check: DiagnosticCheck): DiagnosticCheck {
  if (check.name !== expectedName) {
    return {
      name: expectedName,
      state: "unhealthy",
      code: `${expectedName.toUpperCase()}_PROBE_MISMATCH`,
      detail: `probe returned check for ${check.name}`,
    };
  }
  if (!["healthy", "unhealthy", "unknown"].includes(check.state)) {
    return {
      name: expectedName,
      state: "unhealthy",
      code: `${expectedName.toUpperCase()}_INVALID_STATE`,
      detail: `probe returned invalid state ${String(check.state)}`,
    };
  }
  if (check.state !== "healthy" && !actionable(check.code)) {
    return {
      name: expectedName,
      state: "unhealthy",
      code: `${expectedName.toUpperCase()}_MISSING_ACTION_CODE`,
      detail: check.detail || "non-healthy probe omitted an actionable code",
    };
  }
  return {
    name: expectedName,
    state: check.state,
    code: required(check.code, `${expectedName}.code`),
    detail: required(check.detail, `${expectedName}.detail`),
  };
}

function actionable(code: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(code) && code !== "UNKNOWN";
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} must be non-empty`);
  return value;
}
