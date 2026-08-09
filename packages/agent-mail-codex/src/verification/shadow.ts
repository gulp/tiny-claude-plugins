/**
 * R1: shadow-mode observation and Claude-monitor cursor comparison.
 *
 * Observes and persists source events with durable batching metadata, but
 * never attaches a Codex owner or advances the delivery cursor via accept.
 * Delivery remains gated by `codex_ingress.enabled=false`.
 */

import { BurstBatcher } from "../batcher/mod.ts";
import type { MailboxSource, SourceScope } from "../mailbox/mod.ts";
import { urgencyFromEvents } from "../policy/mod.ts";
import type { Clock } from "../retry/mod.ts";
import type { MailEvent } from "../schemas/mod.ts";
import type {
  BindingLease,
  BindingRef,
  DurableStateStore,
  SourceEventRecord,
} from "../store/mod.ts";
import { STORE_INVARIANTS, StoreError } from "../store/mod.ts";

export const SHADOW_OWNER_ID = "agent-mail-codex-shadow";

export type ShadowBinding = {
  bindingId: string;
  agent: string;
  configHash: string;
  adapter: string;
  /** Expected project slug for wrong-scope detection. */
  projectSlug: string;
  projectPath: string;
  threadId: string | null;
};

export type ShadowCompareInput = {
  /** Message IDs the shadow runner observed (valid events only). */
  shadowIds: ReadonlySet<number>;
  /** Message IDs a parallel Claude-monitor-equivalent scan saw. */
  referenceIds: ReadonlySet<number>;
  /** Events whose projectSlug did not match the binding scope. */
  wrongScopeIds?: readonly number[];
  /**
   * Malformed/skip paths the reference scan reported but shadow did not
   * record as a skip/dead-letter (silent drop).
   */
  malformedSilent?: readonly string[];
};

export type ShadowCompareVerdict = {
  ok: boolean;
  missedIds: number[];
  extraIds: number[];
  wrongScopeIds: number[];
  malformedSilent: string[];
  shadowCount: number;
  referenceCount: number;
};

export type ShadowRunResult = {
  ok: boolean;
  reason: "shutdown" | "lease_lost" | "compare_failed" | "error";
  detail?: string;
  baselineCursor: number;
  /** Highest valid message id observed (does not imply delivery cursor). */
  observedCursor: number;
  observedIds: number[];
  referenceIds: number[];
  batchesEnqueued: string[];
  deadLetterSkips: string[];
  compare: ShadowCompareVerdict;
  /** Delivery cursor must remain untouched in shadow mode. */
  deliveryCursor: number;
  modelCalls: number;
};

export type ShadowRunnerOptions = {
  store: DurableStateStore;
  mailbox: MailboxSource;
  /** Independent scan used as the Claude-monitor oracle (same mailbox). */
  referenceMailbox: MailboxSource;
  clock: Clock;
  binding: ShadowBinding;
  signal: AbortSignal;
  ownerId?: string;
  pollIntervalMs?: number;
  batchWindowMs?: number;
  /**
   * When true, after each poll compare shadow observations to a fresh
   * reference read over the same baseline window.
   */
  compareEachPoll?: boolean;
};

function scopeFor(binding: ShadowBinding): SourceScope {
  return {
    kind: "project",
    agent: binding.agent,
    projectPath: binding.projectPath,
  };
}

function toSourceRecords(
  bindingId: string,
  events: readonly MailEvent[],
  at: string,
): SourceEventRecord[] {
  return events.map((event) => ({
    bindingId,
    messageId: event.messageId,
    projectSlug: event.projectSlug,
    createdTs: event.createdTs,
    subject: event.subject,
    importance: event.importance,
    ackRequired: event.ackRequired,
    sourcePathHash: `hash:${event.messageId}`,
    observedAt: at,
  }));
}

/** Pure set-diff gate used by CI and the 24h operational report. */
export function compareShadowToReference(
  input: ShadowCompareInput,
): ShadowCompareVerdict {
  const missedIds: number[] = [];
  const extraIds: number[] = [];
  for (const id of input.referenceIds) {
    if (!input.shadowIds.has(id)) missedIds.push(id);
  }
  for (const id of input.shadowIds) {
    if (!input.referenceIds.has(id)) extraIds.push(id);
  }
  missedIds.sort((a, b) => a - b);
  extraIds.sort((a, b) => a - b);
  const wrongScopeIds = [...(input.wrongScopeIds ?? [])].sort((a, b) => a - b);
  const malformedSilent = [...(input.malformedSilent ?? [])].sort();
  return {
    ok: missedIds.length === 0 &&
      extraIds.length === 0 &&
      wrongScopeIds.length === 0 &&
      malformedSilent.length === 0,
    missedIds,
    extraIds,
    wrongScopeIds,
    malformedSilent,
    shadowCount: input.shadowIds.size,
    referenceCount: input.referenceIds.size,
  };
}

/**
 * Run shadow observation until aborted. Never constructs a ThreadOwner or
 * calls startTurn/steerTurn. Does not advance the delivery cursor.
 */
export async function runShadowObservation(
  options: ShadowRunnerOptions,
): Promise<ShadowRunResult> {
  const ownerId = options.ownerId ?? SHADOW_OWNER_ID;
  const pollMs = options.pollIntervalMs ?? 250;
  const windowMs = options.batchWindowMs ?? 500;
  const binding = options.binding;
  const observed = new Set<number>();
  const referenceSeen = new Set<number>();
  const wrongScopeIds: number[] = [];
  const deadLetterSkips: string[] = [];
  const batchesEnqueued: string[] = [];
  let baselineCursor = 0;
  let observedCursor = 0;
  const modelCalls = 0;

  const bindingRef: BindingRef = {
    bindingId: binding.bindingId,
    agent: binding.agent,
    configHash: binding.configHash,
    adapter: binding.adapter,
    scopeJson: JSON.stringify({
      kind: "project",
      projectPath: binding.projectPath,
    }),
    threadId: binding.threadId,
  };

  let lease: BindingLease;
  try {
    lease = await options.store.open(bindingRef, ownerId);
  } catch (error) {
    const empty = compareShadowToReference({
      shadowIds: observed,
      referenceIds: referenceSeen,
    });
    return {
      ok: false,
      reason: "lease_lost",
      detail: error instanceof Error ? error.message : String(error),
      baselineCursor: 0,
      observedCursor: 0,
      observedIds: [],
      referenceIds: [],
      batchesEnqueued,
      deadLetterSkips,
      compare: empty,
      deliveryCursor: 0,
      modelCalls: 0,
    };
  }

  const batcher = new BurstBatcher({
    bindingId: binding.bindingId,
    recipient: binding.agent,
    projectSlug: binding.projectSlug,
    windowMs,
  });
  const eventIndex = new Map<number, MailEvent>();

  try {
    const startAt = new Date(options.clock.now()).toISOString();
    await lease.transact({ kind: "upsertBinding", binding: bindingRef, at: startAt });

    const baseline = await options.mailbox.baseline(scopeFor(binding));
    baselineCursor = baseline.lastMessageId;
    observedCursor = baselineCursor;
    let cursorId = baselineCursor;
    let nextLeaseRenewAt = options.clock.now() +
      STORE_INVARIANTS.leaseRenewSeconds * 1000;

    // Reference oracle baselines the same frontier so the window matches.
    const refBaseline = await options.referenceMailbox.baseline(scopeFor(binding));
    let refCursor = refBaseline.lastMessageId;

    while (!options.signal.aborted) {
      const loopNow = options.clock.now();
      if (loopNow >= nextLeaseRenewAt) {
        const heartbeatAt = new Date(loopNow).toISOString();
        await lease.transact({
          kind: "renewLease",
          ownerId,
          heartbeatAt,
          expiresAt: new Date(
            loopNow + STORE_INVARIANTS.leaseTtlSeconds * 1000,
          ).toISOString(),
        });
        nextLeaseRenewAt = loopNow + STORE_INVARIANTS.leaseRenewSeconds * 1000;
      }

      const page = await options.mailbox.readAfter(scopeFor(binding), {
        lastMessageId: cursorId,
      });
      const refPage = await options.referenceMailbox.readAfter(scopeFor(binding), {
        lastMessageId: refCursor,
      });

      for (const event of refPage.events) {
        referenceSeen.add(event.messageId);
        if (event.messageId > refCursor) refCursor = event.messageId;
      }

      for (const skip of page.skipped) {
        if (
          skip.reason === "malformed_frontmatter" ||
          skip.reason === "subject_too_long"
        ) {
          const key = `skip:${skip.relativePath}`;
          if (!deadLetterSkips.includes(key)) deadLetterSkips.push(key);
        }
      }

      const inScope: MailEvent[] = [];
      for (const event of page.events) {
        if (event.projectSlug !== binding.projectSlug) {
          wrongScopeIds.push(event.messageId);
          continue;
        }
        inScope.push(event);
        observed.add(event.messageId);
        eventIndex.set(event.messageId, event);
        if (event.messageId > observedCursor) observedCursor = event.messageId;
        if (event.messageId > cursorId) cursorId = event.messageId;
      }

      const now = options.clock.now();
      const atIso = new Date(now).toISOString();
      if (inScope.length) {
        await lease.transact({
          kind: "observeSourceEvents",
          events: toSourceRecords(binding.bindingId, inScope, atIso),
        });
      }

      const decision = batcher.add(inScope, now);
      const due = [...decision.flushed];
      if (
        decision.bufferedCount > 0 &&
        (decision.windowEndsAt === null || decision.windowEndsAt <= now)
      ) {
        const flushed = batcher.flush(now);
        if (flushed) due.push(flushed);
      }

      for (const flushBatch of due) {
        const events = flushBatch.sourceMessageIds.length
          ? flushBatch.sourceMessageIds.map((id) => eventIndex.get(id))
          : flushBatch.eventIds
            .map((id) => Number(String(id).replace(/^agent-mail:/, "")))
            .map((id) => eventIndex.get(id));
        const resolved = events.filter((e): e is MailEvent => !!e);
        await lease.transact({
          kind: "enqueueBatch",
          batch: {
            batchId: flushBatch.batchId,
            bindingId: flushBatch.bindingId,
            firstMessageId: flushBatch.firstMessageId,
            lastMessageId: flushBatch.lastMessageId,
            eventIds: [...flushBatch.eventIds],
            payloadJson: JSON.stringify({ shadow: true, delivery: false }),
            urgency: urgencyFromEvents(resolved),
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: null,
            acceptedTurnId: null,
            lastErrorCode: null,
            lastErrorDetail: null,
            createdAt: atIso,
            updatedAt: atIso,
          },
        });
        batchesEnqueued.push(flushBatch.batchId);
        // Intentionally no acceptBatch / startTurn — delivery flag off.
      }

      if (options.compareEachPoll) {
        const mid = compareShadowToReference({
          shadowIds: observed,
          referenceIds: referenceSeen,
          wrongScopeIds,
        });
        if (!mid.ok) {
          const state = await lease.load();
          return {
            ok: false,
            reason: "compare_failed",
            detail: `missed=${mid.missedIds.join(",")} extra=${mid.extraIds.join(",")}`,
            baselineCursor,
            observedCursor,
            observedIds: [...observed].sort((a, b) => a - b),
            referenceIds: [...referenceSeen].sort((a, b) => a - b),
            batchesEnqueued,
            deadLetterSkips,
            compare: mid,
            deliveryCursor: state.cursor.lastMessageId,
            modelCalls,
          };
        }
      }

      await sleep(pollMs, options.signal, options.clock);
    }

    // Final reference sweep for the full window.
    const finalRef = await options.referenceMailbox.readAfter(scopeFor(binding), {
      lastMessageId: baselineCursor,
    });
    for (const event of finalRef.events) {
      referenceSeen.add(event.messageId);
    }
    const malformedSilent: string[] = [];
    for (const skip of finalRef.skipped) {
      if (
        skip.reason === "malformed_frontmatter" ||
        skip.reason === "subject_too_long"
      ) {
        const key = `skip:${skip.relativePath}`;
        if (!deadLetterSkips.includes(key)) malformedSilent.push(key);
      }
    }

    const compare = compareShadowToReference({
      shadowIds: observed,
      referenceIds: referenceSeen,
      wrongScopeIds,
      malformedSilent,
    });
    const state = await lease.load();
    return {
      ok: compare.ok,
      reason: compare.ok ? "shutdown" : "compare_failed",
      detail: compare.ok
        ? undefined
        : `missed=${compare.missedIds.join(",")} extra=${compare.extraIds.join(",")}`,
      baselineCursor,
      observedCursor,
      observedIds: [...observed].sort((a, b) => a - b),
      referenceIds: [...referenceSeen].sort((a, b) => a - b),
      batchesEnqueued,
      deadLetterSkips,
      compare,
      deliveryCursor: state.cursor.lastMessageId,
      modelCalls,
    };
  } catch (error) {
    const state = await lease.load().catch(() => null);
    const compare = compareShadowToReference({
      shadowIds: observed,
      referenceIds: referenceSeen,
      wrongScopeIds,
    });
    const leaseLost = error instanceof StoreError &&
      (error.code === "lease_lost" || error.code === "lease_mismatch");
    return {
      ok: false,
      reason: leaseLost ? "lease_lost" : "error",
      detail: error instanceof Error ? error.message : String(error),
      baselineCursor,
      observedCursor,
      observedIds: [...observed].sort((a, b) => a - b),
      referenceIds: [...referenceSeen].sort((a, b) => a - b),
      batchesEnqueued,
      deadLetterSkips,
      compare,
      deliveryCursor: state?.cursor.lastMessageId ?? 0,
      modelCalls,
    };
  } finally {
    await lease.close().catch(() => {});
  }
}

function sleep(
  ms: number,
  signal: AbortSignal,
  clock: Clock,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  // Prefer clock.sleep when present (deterministic tests).
  const withSleep = clock as Clock & { sleep?: (ms: number) => Promise<void> };
  if (typeof withSleep.sleep === "function") {
    return withSleep.sleep(ms).then(() => undefined);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Encode a durable R1 gate artifact for the 24h operational run. */
export function encodeShadowGateArtifact(result: ShadowRunResult): string {
  return `${
    JSON.stringify(
      {
        schemaVersion: 1,
        gate: "r1-shadow",
        deliveryEnabled: false,
        ok: result.ok,
        reason: result.reason,
        detail: result.detail ?? null,
        baselineCursor: result.baselineCursor,
        observedCursor: result.observedCursor,
        deliveryCursor: result.deliveryCursor,
        observedCount: result.observedIds.length,
        referenceCount: result.referenceIds.length,
        batchesEnqueued: result.batchesEnqueued.length,
        deadLetterSkips: result.deadLetterSkips,
        compare: result.compare,
        modelCalls: result.modelCalls,
        constraints: {
          noCodexDelivery: result.modelCalls === 0,
          // Fresh binding cursor starts at 0; shadow must never acceptBatch.
          deliveryCursorUnchanged: result.deliveryCursor === 0,
        },
      },
      null,
      2,
    )
  }\n`;
}
