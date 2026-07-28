/** O6: human-visible, content-safe notification and attachment contract. */

export type NoticeKind =
  | "wake_started"
  | "turn_attached"
  | "turn_completed"
  | "timeout"
  | "dropped"
  | "wrong_thread"
  | "ownership_conflict"
  | "process_death";

export type NoticeSeverity = "info" | "success" | "warning" | "error";

export interface NoticeInput {
  kind: NoticeKind;
  at: string;
  bindingId: string;
  agent: string;
  projectSlug: string;
  messageIds: number[];
  batchId: string | null;
  threadId: string | null;
  turnId: string | null;
  owner: "headless" | "human" | "none" | "unknown";
  code: string;
}

export interface AttachAction {
  label: string;
  command: string;
  mode: "inspect" | "resume";
}

export interface OperatorNotice {
  schemaVersion: 1;
  kind: NoticeKind;
  severity: NoticeSeverity;
  at: string;
  bindingId: string;
  agent: string;
  projectSlug: string;
  messageIds: number[];
  batchIds: string[];
  threadId: string | null;
  turnId: string | null;
  owner: NoticeInput["owner"];
  code: string;
  count: number;
  summary: string;
  action: AttachAction | null;
}

const KIND_VIEW: Record<
  NoticeKind,
  { severity: NoticeSeverity; summary: string }
> = {
  wake_started: { severity: "info", summary: "Headless wake started" },
  turn_attached: { severity: "info", summary: "Mail attached to durable turn" },
  turn_completed: { severity: "success", summary: "Headless turn completed" },
  timeout: { severity: "error", summary: "Headless turn timed out" },
  dropped: { severity: "warning", summary: "Mail delivery dropped" },
  wrong_thread: { severity: "error", summary: "Wrong-thread delivery refused" },
  ownership_conflict: { severity: "error", summary: "Thread ownership conflict" },
  process_death: { severity: "error", summary: "Ingress process stopped" },
};

export function createOperatorNotice(input: NoticeInput): OperatorNotice {
  required(input.bindingId, "bindingId");
  required(input.agent, "agent");
  required(input.projectSlug, "projectSlug");
  required(input.code, "code");
  const view = KIND_VIEW[input.kind];
  const messageIds = uniqueSorted(input.messageIds);
  return {
    schemaVersion: 1,
    kind: input.kind,
    severity: view.severity,
    at: input.at,
    bindingId: input.bindingId,
    agent: input.agent,
    projectSlug: input.projectSlug,
    messageIds,
    batchIds: input.batchId ? [input.batchId] : [],
    threadId: input.threadId,
    turnId: input.turnId,
    owner: input.owner,
    code: input.code,
    count: 1,
    summary: view.summary,
    action: actionFor(input),
  };
}

/**
 * Coalesces like notices within a bounded window. All stable IDs survive, so
 * reducing notification volume never hides which mail was represented.
 */
export class NoticeCoalescer {
  readonly #windowMs: number;
  #pending = new Map<string, OperatorNotice>();

  constructor(windowMs = 1_000) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 0) {
      throw new TypeError("windowMs must be a non-negative integer");
    }
    this.#windowMs = windowMs;
  }

  add(notice: OperatorNotice): OperatorNotice[] {
    const flushed = this.flushBefore(Date.parse(notice.at) - this.#windowMs);
    const key = `${notice.bindingId}\0${notice.kind}\0${notice.code}`;
    const current = this.#pending.get(key);
    if (!current) {
      this.#pending.set(key, structuredClone(notice));
      return flushed;
    }
    const delta = Date.parse(notice.at) - Date.parse(current.at);
    if (!Number.isFinite(delta) || delta < 0 || delta > this.#windowMs) {
      flushed.push(current);
      this.#pending.set(key, structuredClone(notice));
      return flushed;
    }
    current.at = notice.at;
    current.count += notice.count;
    current.messageIds = uniqueSorted([
      ...current.messageIds,
      ...notice.messageIds,
    ]);
    current.batchIds = [
      ...new Set([
        ...current.batchIds,
        ...notice.batchIds,
      ]),
    ].sort();
    current.turnId = notice.turnId ?? current.turnId;
    current.threadId = notice.threadId ?? current.threadId;
    current.action = notice.action ?? current.action;
    return flushed;
  }

  flush(): OperatorNotice[] {
    return this.flushBefore(Number.POSITIVE_INFINITY);
  }

  flushBefore(epochMs: number): OperatorNotice[] {
    const due: OperatorNotice[] = [];
    for (const [key, notice] of this.#pending) {
      if (Date.parse(notice.at) <= epochMs) {
        due.push(notice);
        this.#pending.delete(key);
      }
    }
    return due.sort((left, right) =>
      left.at.localeCompare(right.at) ||
      left.bindingId.localeCompare(right.bindingId)
    );
  }
}

/** Stable JSON is the canonical CLI/status surface. */
export function renderNoticeJson(notice: OperatorNotice): string {
  return JSON.stringify(notice);
}

/** Terminal text is deliberately ID-only: mail subjects/bodies never appear. */
export function renderNoticeTerminal(notice: OperatorNotice): string {
  const ids = notice.messageIds.length ? notice.messageIds.join(",") : "<none>";
  const lines = [
    `[${notice.severity.toUpperCase()}] ${notice.summary} [${notice.code}]`,
    `agent=${notice.agent} project=${notice.projectSlug} binding=${notice.bindingId}`,
    `messages=${ids} count=${notice.count} thread=${notice.threadId ?? "<unbound>"} turn=${
      notice.turnId ?? "<none>"
    } owner=${notice.owner}`,
  ];
  if (notice.action) {
    lines.push(`${notice.action.label}: ${notice.action.command}`);
  }
  return lines.join("\n");
}

export interface NotificationLatencyVerdict {
  ok: boolean;
  latencyMs: number;
  sloMs: number;
  code: "NOTIFICATION_SLO_MET" | "NOTIFICATION_SLO_MISSED";
}

export function notificationLatencyVerdict(
  observedAt: string,
  visibleAt: string,
  sloMs = 2_000,
): NotificationLatencyVerdict {
  const latencyMs = Date.parse(visibleAt) - Date.parse(observedAt);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new TypeError("notification timestamps must be ordered ISO dates");
  }
  if (!Number.isSafeInteger(sloMs) || sloMs < 1) {
    throw new TypeError("sloMs must be positive");
  }
  const ok = latencyMs <= sloMs;
  return {
    ok,
    latencyMs,
    sloMs,
    code: ok ? "NOTIFICATION_SLO_MET" : "NOTIFICATION_SLO_MISSED",
  };
}

function actionFor(input: NoticeInput): AttachAction | null {
  if (!input.threadId) return null;
  const quoted = shellQuote(input.threadId);
  if (input.owner === "human") {
    return {
      label: "Resume exact thread",
      command: `codex resume ${quoted}`,
      mode: "resume",
    };
  }
  return {
    label: "Inspect exact thread",
    command: `agent-mail-codex status --binding ${shellQuote(input.bindingId)} --json`,
    mode: "inspect",
  };
}

function uniqueSorted(values: number[]): number[] {
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`invalid message ID ${value}`);
    }
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function required(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} must be non-empty`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
