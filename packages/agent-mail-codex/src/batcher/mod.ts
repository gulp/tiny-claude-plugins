/**
 * L1: deterministic burst batcher — 500ms window, 50-event / 32KiB early flush,
 * optional recognized task-state collapse (no model inference).
 */

import { batchIdFor, type DeliveryBatch, eventIdFor, type MailEvent } from "../schemas/mod.ts";

/** Milliseconds since Unix epoch (injectable fake clock). */
export type Instant = number;

export const DEFAULT_BATCH_WINDOW_MS = 500;
export const DEFAULT_MAX_EVENTS = 50;
export const DEFAULT_MAX_BYTES = 32 * 1024;

/** Fixed per-event overhead in the eventual model envelope (conservative). */
const PER_EVENT_OVERHEAD = 64;

export type TaskStateVerb = "claimed" | "completed" | "closed";

const TASK_STATE_RE = /\b(claimed|completed|closed)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/i;

const VERB_RANK: Record<TaskStateVerb, number> = {
  claimed: 1,
  completed: 2,
  closed: 3,
};

export interface ParsedTaskState {
  verb: TaskStateVerb;
  taskKey: string;
}

/** Extract recognized task-state verb + key from a subject, or null. */
export function parseTaskState(subject: string): ParsedTaskState | null {
  const match = TASK_STATE_RE.exec(subject);
  if (!match) return null;
  const verb = match[1].toLowerCase() as TaskStateVerb;
  return { verb, taskKey: match[2] };
}

export interface BatcherOptions {
  bindingId: string;
  recipient: string;
  projectSlug: string;
  windowMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  /** When true, collapse recognized claimed→completed→closed chains (same task key). */
  deterministicCollapse?: boolean;
}

export interface BatchDecision {
  /** Batches flushed early by caps or closed windows. */
  flushed: DeliveryBatch[];
  /** Events still waiting in the open window (after collapse staging). */
  bufferedCount: number;
  /** When the current window closes; null if idle. */
  windowEndsAt: Instant | null;
}

export interface Batcher {
  add(events: readonly MailEvent[], now: Instant): BatchDecision;
  flush(now: Instant): DeliveryBatch | null;
}

function eventBytes(event: MailEvent): number {
  return PER_EVENT_OVERHEAD + new TextEncoder().encode(event.subject).length;
}

/**
 * Collapse consecutive recognized task-state events sharing a task key when
 * verbs are non-decreasing in claimed→completed→closed order.
 * All original events remain in `retained` for sourceEventIds; only
 * `visible` subjects contribute to the byte budget.
 */
export function collapseTaskStateSequence(
  events: readonly MailEvent[],
): { visible: MailEvent[]; retained: MailEvent[] } {
  const retained = [...events];
  const visible: MailEvent[] = [];
  let i = 0;
  while (i < events.length) {
    const parsed = parseTaskState(events[i].subject);
    if (!parsed) {
      visible.push(events[i]);
      i += 1;
      continue;
    }
    let j = i + 1;
    let lastRank = VERB_RANK[parsed.verb];
    let last = events[i];
    while (j < events.length) {
      const next = parseTaskState(events[j].subject);
      if (!next || next.taskKey !== parsed.taskKey) break;
      const rank = VERB_RANK[next.verb];
      if (rank < lastRank) break;
      lastRank = rank;
      last = events[j];
      j += 1;
    }
    visible.push(last);
    i = j;
  }
  return { visible, retained };
}

function mintBatch(
  opts: Required<
    Pick<BatcherOptions, "bindingId" | "recipient" | "projectSlug">
  >,
  events: MailEvent[],
  visibleForBytes: MailEvent[],
): DeliveryBatch {
  const sourceMessageIds = events.map((e) => e.messageId);
  const encodedBytes = visibleForBytes.reduce((sum, e) => sum + eventBytes(e), 0);
  const firstMessageId = Math.min(...sourceMessageIds);
  const lastMessageId = Math.max(...sourceMessageIds);
  return {
    schemaVersion: 1,
    batchId: batchIdFor(opts.bindingId, firstMessageId, lastMessageId),
    bindingId: opts.bindingId,
    recipient: opts.recipient,
    projectSlug: opts.projectSlug,
    eventIds: sourceMessageIds.map(eventIdFor),
    sourceMessageIds,
    firstMessageId,
    lastMessageId,
    state: "pending",
    encodedBytes,
  };
}

export class BurstBatcher implements Batcher {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly collapse: boolean;
  private readonly meta: Required<
    Pick<BatcherOptions, "bindingId" | "recipient" | "projectSlug">
  >;
  private buffer: MailEvent[] = [];
  private windowEndsAt: Instant | null = null;

  constructor(options: BatcherOptions) {
    this.meta = {
      bindingId: options.bindingId,
      recipient: options.recipient,
      projectSlug: options.projectSlug,
    };
    this.windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.collapse = options.deterministicCollapse ?? false;
  }

  add(events: readonly MailEvent[], now: Instant): BatchDecision {
    const flushed: DeliveryBatch[] = [];

    // Close expired window before accepting new events.
    if (this.windowEndsAt !== null && now >= this.windowEndsAt && this.buffer.length > 0) {
      flushed.push(...this.drainAll());
    }

    for (const event of events) {
      if (this.buffer.length === 0) {
        this.windowEndsAt = now + this.windowMs;
      }
      this.buffer.push(event);

      while (this.bufferExceedsCaps()) {
        const slice = this.takePrefixWithinCaps();
        flushed.push(this.seal(slice));
        if (this.buffer.length > 0 && this.windowEndsAt === null) {
          this.windowEndsAt = now + this.windowMs;
        }
      }
    }

    return {
      flushed,
      bufferedCount: this.buffer.length,
      windowEndsAt: this.windowEndsAt,
    };
  }

  flush(now: Instant): DeliveryBatch | null {
    if (this.buffer.length === 0) return null;
    if (this.windowEndsAt !== null && now < this.windowEndsAt) {
      // Explicit flush before window end is allowed (operator / shutdown).
    }
    const [batch] = this.drainAll();
    return batch ?? null;
  }

  private drainAll(): DeliveryBatch[] {
    if (this.buffer.length === 0) {
      this.windowEndsAt = null;
      return [];
    }
    const out: DeliveryBatch[] = [];
    while (this.buffer.length > 0) {
      const slice = this.takePrefixWithinCaps();
      // If still over caps with a single event, emit it anyway (never truncate).
      if (slice.length === 0) {
        out.push(this.seal([this.buffer.shift()!]));
      } else {
        out.push(this.seal(slice));
      }
    }
    this.windowEndsAt = null;
    return out;
  }

  private visibleBytes(events: MailEvent[]): number {
    const visible = this.collapse ? collapseTaskStateSequence(events).visible : events;
    return visible.reduce((sum, e) => sum + eventBytes(e), 0);
  }

  private bufferExceedsCaps(): boolean {
    if (this.buffer.length > this.maxEvents) return true;
    return this.visibleBytes(this.buffer) > this.maxBytes;
  }

  /** Longest non-empty prefix that still fits under caps (at least one event). */
  private takePrefixWithinCaps(): MailEvent[] {
    if (this.buffer.length === 0) return [];
    let n = 1;
    while (n < this.buffer.length) {
      const candidate = this.buffer.slice(0, n + 1);
      if (candidate.length > this.maxEvents) break;
      if (this.visibleBytes(candidate) > this.maxBytes) break;
      n += 1;
    }
    // If even one event exceeds maxBytes, still take it (never truncate silently).
    return this.buffer.splice(0, n);
  }

  private seal(events: MailEvent[]): DeliveryBatch {
    const visible = this.collapse ? collapseTaskStateSequence(events).visible : events;
    return mintBatch(this.meta, events, visible);
  }
}
