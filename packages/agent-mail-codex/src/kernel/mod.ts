/**
 * K1: IngressKernel — compose store, mailbox, batcher, policy, encode, owner.
 * Knows interfaces only (no FS/SQLite/JSON-RPC details).
 */

import { BurstBatcher } from "../batcher/mod.ts";
import { encodeDeliveryBatch } from "../encode/mod.ts";
import type { MailboxSource, SourceScope } from "../mailbox/mod.ts";
import type { ThreadOwnerAdapter } from "../owner/types.ts";
import { OwnershipError } from "../owner/types.ts";
import { DefaultDeliveryPolicy, type DeliveryPolicy, urgencyFromEvents } from "../policy/mod.ts";
import { type Clock, RetryPolicy } from "../retry/mod.ts";
import {
  type DeliveryBatch,
  DOMAIN_SCHEMA_VERSION,
  type MailEvent,
  type ThreadBinding,
} from "../schemas/mod.ts";
import {
  type BindingLease,
  type BindingRef,
  type DurableStateStore,
  type SourceEventRecord,
  STORE_INVARIANTS,
  StoreError,
} from "../store/mod.ts";

export type KernelBinding = {
  bindingId: string;
  agent: string;
  configHash: string;
  adapter: string;
  threadId: string;
  projectSlug: string;
  projectPath: string;
};

export type RunResult = {
  ok: boolean;
  reason:
    | "shutdown"
    | "ownership_lost"
    | "lease_lost"
    | "poison"
    | "error";
  detail?: string;
  acceptedBatchIds: string[];
  queuedBatchIds: string[];
  deadLetterBatchIds: string[];
  baselineCursor: number;
};

export type IngressKernelDeps = {
  store: DurableStateStore;
  mailbox: MailboxSource;
  createOwner: () => ThreadOwnerAdapter;
  clock: Clock;
  ownerId?: string;
  policy?: DeliveryPolicy;
  batchWindowMs?: number;
  pollIntervalMs?: number;
};

function scopeFor(binding: KernelBinding): SourceScope {
  return {
    kind: "project",
    agent: binding.agent,
    projectPath: binding.projectPath,
  };
}

function asThreadBinding(binding: KernelBinding): ThreadBinding {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: binding.bindingId,
    agent: binding.agent,
    projectSlug: binding.projectSlug,
    threadId: binding.threadId,
    ownershipModel: "exclusive-handoff",
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

function fromSourceRecord(binding: KernelBinding, event: SourceEventRecord): MailEvent {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: `agent-mail:${event.messageId}`,
    messageId: event.messageId,
    recipient: binding.agent,
    projectSlug: event.projectSlug,
    createdTs: event.createdTs,
    subject: event.subject,
    importance: event.importance ?? "unknown",
    ackRequired: event.ackRequired,
  };
}

function messageIdsFromBatch(batch: DeliveryBatch): number[] {
  return batch.sourceMessageIds.length
    ? [...batch.sourceMessageIds]
    : batch.eventIds.map((id) => Number(String(id).replace(/^agent-mail:/, "")));
}

export class IngressKernel {
  readonly #deps: IngressKernelDeps;
  readonly #policy: DeliveryPolicy;
  readonly #ownerId: string;
  readonly #pollMs: number;
  readonly #windowMs: number;

  constructor(deps: IngressKernelDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? new DefaultDeliveryPolicy();
    this.#ownerId = deps.ownerId ?? "kernel-owner";
    this.#pollMs = deps.pollIntervalMs ?? 250;
    this.#windowMs = deps.batchWindowMs ?? 500;
  }

  async run(binding: KernelBinding, signal: AbortSignal): Promise<RunResult> {
    const acceptedBatchIds: string[] = [];
    const queuedBatchIds: string[] = [];
    const deadLetterBatchIds: string[] = [];
    let baselineCursor = 0;

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
      lease = await this.#deps.store.open(bindingRef, this.#ownerId);
    } catch (error) {
      return {
        ok: false,
        reason: "lease_lost",
        detail: error instanceof Error ? error.message : String(error),
        acceptedBatchIds,
        queuedBatchIds,
        deadLetterBatchIds,
        baselineCursor,
      };
    }

    const owner = this.#deps.createOwner();
    const batcher = new BurstBatcher({
      bindingId: binding.bindingId,
      recipient: binding.agent,
      projectSlug: binding.projectSlug,
      windowMs: this.#windowMs,
    });
    const eventIndex = new Map<number, MailEvent>();
    const retry = new RetryPolicy({ clock: this.#deps.clock });

    try {
      const startAt = new Date(this.#deps.clock.now()).toISOString();
      await lease.transact({ kind: "upsertBinding", binding: bindingRef, at: startAt });

      await owner.connect(asThreadBinding(binding));
      await owner.acquireOwnership();

      let state = await lease.load();
      if (!state.cursor.initialized) {
        const baseline = await this.#deps.mailbox.baseline(scopeFor(binding));
        state = await lease.transact({
          kind: "setBaseline",
          cursorMessageId: baseline.lastMessageId,
          at: startAt,
        });
      }
      baselineCursor = state.cursor.lastMessageId;
      let cursorId = state.cursor.lastMessageId;
      let nextLeaseRenewAt = this.#deps.clock.now() +
        STORE_INVARIANTS.leaseRenewSeconds * 1000;

      for (const source of state.sourceEvents) {
        eventIndex.set(source.messageId, fromSourceRecord(binding, source));
      }

      // A crash can leave a sent request without a recorded acceptance.
      // Replay the same durable batch ID rather than minting a replacement.
      for (const record of state.batches.filter((batch) => batch.state === "delivering")) {
        await lease.transact({
          kind: "transitionBatch",
          batchId: record.batchId,
          from: "delivering",
          to: "pending",
          at: startAt,
          attemptCount: record.attemptCount,
          nextAttemptAt: null,
          lastErrorCode: "ambiguous_acceptance",
          lastErrorDetail: "stable replay after restart",
          acceptedTurnId: null,
        });
      }

      type TerminalOutcome =
        | { kind: "completed"; turnId: string; at: string }
        | { kind: "failed"; turnId: string; at: string; detail: string };
      const terminals = new Map<string, TerminalOutcome>();
      const turnBatchIds = new Map<string, Set<string>>();
      const batchLastMessageId = new Map<string, number>();
      let ownershipLostDetail: string | null = null;
      let settleWake: (() => void) | null = null;
      const wakeSettle = () => {
        settleWake?.();
        settleWake = null;
      };

      const eventPump = (async () => {
        try {
          for await (const event of owner.events(signal)) {
            if (event.kind === "turnCompleted") {
              terminals.set(event.turnId, {
                kind: "completed",
                turnId: event.turnId,
                at: event.at,
              });
              wakeSettle();
            } else if (event.kind === "turnFailed") {
              terminals.set(event.turnId, {
                kind: "failed",
                turnId: event.turnId,
                at: event.at,
                detail: event.detail,
              });
              wakeSettle();
            } else if (event.kind === "ownershipLost") {
              ownershipLostDetail = event.detail;
              wakeSettle();
              return;
            }
          }
        } catch (error) {
          if (
            error instanceof OwnershipError &&
            (error.code === "ownership_lost" || error.code === "not_acquired")
          ) {
            ownershipLostDetail = error.message;
            wakeSettle();
            return;
          }
          // Abort/close ends the iterator; ignore other pump teardown errors.
        }
      })();

      const settleTerminalOutcomes = async (): Promise<void> => {
        for (const [turnId, terminal] of [...terminals.entries()]) {
          const bound = turnBatchIds.get(turnId);
          if (!bound || bound.size === 0) continue;
          const ordered = [...bound]
            .map((batchId) => ({
              batchId,
              lastMessageId: batchLastMessageId.get(batchId) ?? 0,
            }))
            .sort((a, b) => a.lastMessageId - b.lastMessageId || a.batchId.localeCompare(b.batchId));

          for (const { batchId, lastMessageId } of ordered) {
            const current = await lease.load();
            const record = current.batches.find((batch) => batch.batchId === batchId);
            if (!record || record.state !== "delivering") {
              bound.delete(batchId);
              batchLastMessageId.delete(batchId);
              continue;
            }

            if (terminal.kind === "completed") {
              await lease.transact({
                kind: "acceptBatch",
                batchId,
                turnId,
                cursorMessageId: lastMessageId,
                at: terminal.at,
              });
              cursorId = Math.max(cursorId, lastMessageId);
              retry.reset(batchId);
              if (!acceptedBatchIds.includes(batchId)) acceptedBatchIds.push(batchId);
              for (const messageId of [...eventIndex.keys()]) {
                if (messageId <= cursorId) eventIndex.delete(messageId);
              }
            } else {
              const permanent = /missing event|empty batch|unknown schema|invalid/i
                .test(terminal.detail);
              const retryDecision = retry.decide(
                batchId,
                "delivery",
                permanent ? "permanent" : "transient",
              );
              if (retryDecision.kind === "retry") {
                await lease.transact({
                  kind: "transitionBatch",
                  batchId,
                  from: "delivering",
                  to: "pending",
                  at: terminal.at,
                  attemptCount: retryDecision.attempt,
                  nextAttemptAt: new Date(retryDecision.nextAttemptAt).toISOString(),
                  lastErrorCode: "turn_failed",
                  lastErrorDetail: terminal.detail,
                  acceptedTurnId: null,
                });
              } else {
                await lease.transact({
                  kind: "deadLetter",
                  batchId,
                  code: permanent ? "delivery_permanent" : "delivery_exhausted",
                  detail: terminal.detail,
                  at: terminal.at,
                });
                if (!deadLetterBatchIds.includes(batchId)) {
                  deadLetterBatchIds.push(batchId);
                }
              }
            }
            bound.delete(batchId);
            batchLastMessageId.delete(batchId);
          }
          if (bound.size === 0) turnBatchIds.delete(turnId);
        }
      };

      const bindTurnBatch = (turnId: string, batchId: string, lastMessageId: number) => {
        const set = turnBatchIds.get(turnId) ?? new Set<string>();
        set.add(batchId);
        turnBatchIds.set(turnId, set);
        batchLastMessageId.set(batchId, lastMessageId);
      };

      const coveredIds = new Set(
        state.batches.flatMap((batch) =>
          batch.eventIds.map((id) => Number(String(id).replace(/^agent-mail:/, "")))
        ),
      );
      const unbatched = state.sourceEvents
        .filter((event) => event.messageId > cursorId && !coveredIds.has(event.messageId))
        .map((event) => fromSourceRecord(binding, event));
      if (unbatched.length > 0) {
        batcher.add(unbatched, this.#deps.clock.now());
      }

      while (!signal.aborted) {
        if (ownershipLostDetail) {
          return {
            ok: false,
            reason: "ownership_lost",
            detail: ownershipLostDetail,
            acceptedBatchIds,
            queuedBatchIds,
            deadLetterBatchIds,
            baselineCursor,
          };
        }
        await settleTerminalOutcomes();

        const loopNow = this.#deps.clock.now();
        if (loopNow >= nextLeaseRenewAt) {
          const heartbeatAt = new Date(loopNow).toISOString();
          await lease.transact({
            kind: "renewLease",
            ownerId: this.#ownerId,
            heartbeatAt,
            expiresAt: new Date(
              loopNow + STORE_INVARIANTS.leaseTtlSeconds * 1000,
            ).toISOString(),
          });
          nextLeaseRenewAt = loopNow + STORE_INVARIANTS.leaseRenewSeconds * 1000;
        }

        const page = await this.#deps.mailbox.readAfter(scopeFor(binding), {
          lastMessageId: cursorId,
        });

        for (const skip of page.skipped) {
          if (
            skip.reason === "malformed_frontmatter" ||
            skip.reason === "subject_too_long"
          ) {
            deadLetterBatchIds.push(`skip:${skip.relativePath}`);
          }
        }

        const newEvents = page.events.filter((event) => !eventIndex.has(event.messageId));
        for (const event of newEvents) {
          eventIndex.set(event.messageId, event);
        }

        const now = this.#deps.clock.now();
        const atIso = new Date(now).toISOString();
        if (newEvents.length) {
          await lease.transact({
            kind: "observeSourceEvents",
            events: toSourceRecords(binding.bindingId, newEvents, atIso),
          });
        }

        const decision = batcher.add(newEvents, now);
        const due = [...decision.flushed];
        if (
          decision.bufferedCount > 0 &&
          (decision.windowEndsAt === null || decision.windowEndsAt <= now)
        ) {
          const flushed = batcher.flush(now);
          if (flushed) due.push(flushed);
        }

        for (const flushBatch of due) {
          const events = messageIdsFromBatch(flushBatch)
            .map((id) => eventIndex.get(id))
            .filter((e): e is MailEvent => !!e);
          const current = await lease.load();
          if (!current.batches.some((batch) => batch.batchId === flushBatch.batchId)) {
            await lease.transact({
              kind: "enqueueBatch",
              batch: {
                batchId: flushBatch.batchId,
                bindingId: flushBatch.bindingId,
                firstMessageId: flushBatch.firstMessageId,
                lastMessageId: flushBatch.lastMessageId,
                eventIds: [...flushBatch.eventIds],
                payloadJson: "{}",
                urgency: urgencyFromEvents(events),
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
          }
        }

        state = await lease.load();
        for (const record of state.batches.filter((b) => b.state === "pending")) {
          if (
            record.nextAttemptAt &&
            Date.parse(record.nextAttemptAt) > this.#deps.clock.now()
          ) {
            continue;
          }
          const batch: DeliveryBatch = {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            batchId: record.batchId,
            bindingId: record.bindingId,
            recipient: binding.agent,
            projectSlug: binding.projectSlug,
            eventIds: record.eventIds,
            sourceMessageIds: record.eventIds.map((id) =>
              Number(String(id).replace(/^agent-mail:/, ""))
            ),
            firstMessageId: record.firstMessageId,
            lastMessageId: record.lastMessageId,
            state: record.state,
            encodedBytes: record.payloadJson.length,
          };
          const events = messageIdsFromBatch(batch)
            .map((id) => eventIndex.get(id))
            .filter((e): e is MailEvent => !!e);
          const urgency = urgencyFromEvents(events);
          const snapshot = await owner.snapshot();
          const action = this.#policy.decide(batch, snapshot, urgency);

          if (action.kind === "queue") {
            if (!queuedBatchIds.includes(batch.batchId)) {
              queuedBatchIds.push(batch.batchId);
            }
            continue;
          }

          try {
            const encoded = await encodeDeliveryBatch({
              bindingId: binding.bindingId,
              batch,
              events,
            });
            await lease.transact({
              kind: "transitionBatch",
              batchId: batch.batchId,
              from: "pending",
              to: "delivering",
              at: atIso,
            });

            const acceptance = action.kind === "startTurn"
              ? await owner.startTurn(encoded.input, encoded.idempotencyKey)
              : action.kind === "steerTurn"
              ? await owner.steerTurn(
                action.turnId,
                encoded.input,
                encoded.idempotencyKey,
              )
              : null;
            if (!acceptance) continue;

            // Bind the in-flight turn; durable accept + cursor wait for terminal outcome.
            await lease.transact({
              kind: "transitionBatch",
              batchId: batch.batchId,
              from: "delivering",
              to: "delivering",
              at: new Date(this.#deps.clock.now()).toISOString(),
              acceptedTurnId: acceptance.turnId,
            });
            bindTurnBatch(acceptance.turnId, batch.batchId, batch.lastMessageId);
            await settleTerminalOutcomes();
          } catch (error) {
            if (
              error instanceof OwnershipError &&
              (error.code === "ownership_lost" || error.code === "not_acquired")
            ) {
              return {
                ok: false,
                reason: "ownership_lost",
                detail: error.message,
                acceptedBatchIds,
                queuedBatchIds,
                deadLetterBatchIds,
                baselineCursor,
              };
            }
            const detail = error instanceof Error ? error.message : String(error);
            const permanent = /missing event|empty batch|unknown schema|invalid/i.test(detail);
            const retryDecision = retry.decide(
              batch.batchId,
              "delivery",
              permanent ? "permanent" : "transient",
            );
            if (retryDecision.kind === "retry") {
              await lease.transact({
                kind: "transitionBatch",
                batchId: batch.batchId,
                from: "delivering",
                to: "pending",
                at: new Date(this.#deps.clock.now()).toISOString(),
                attemptCount: retryDecision.attempt,
                nextAttemptAt: new Date(retryDecision.nextAttemptAt).toISOString(),
                lastErrorCode: "delivery_transient",
                lastErrorDetail: detail,
                acceptedTurnId: null,
              });
              continue;
            }
            await lease.transact({
              kind: "deadLetter",
              batchId: batch.batchId,
              code: permanent ? "delivery_permanent" : "delivery_exhausted",
              detail,
              at: new Date(this.#deps.clock.now()).toISOString(),
            });
            deadLetterBatchIds.push(batch.batchId);
            // Poison isolation is per batch; later events must continue.
            continue;
          }
        }

        // If turns are in flight, wait briefly for lifecycle notifications.
        if (turnBatchIds.size > 0 && !signal.aborted) {
          await Promise.race([
            waitAbortable(this.#pollMs, signal),
            new Promise<void>((resolve) => {
              settleWake = resolve;
            }),
          ]);
          await settleTerminalOutcomes();
          continue;
        }

        await waitAbortable(this.#pollMs, signal);
      }

      try {
        await settleTerminalOutcomes();
      } catch {
        // shutdown path — ownership/event pump errors ignored after abort
      }
      await eventPump.catch(() => {});

      if (ownershipLostDetail) {
        return {
          ok: false,
          reason: "ownership_lost",
          detail: ownershipLostDetail,
          acceptedBatchIds,
          queuedBatchIds,
          deadLetterBatchIds,
          baselineCursor,
        };
      }

      return {
        ok: true,
        reason: "shutdown",
        acceptedBatchIds,
        queuedBatchIds,
        deadLetterBatchIds,
        baselineCursor,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof StoreError &&
            (error.code === "lease_lost" || error.code === "lease_mismatch")
          ? "lease_lost"
          : "error",
        detail: error instanceof Error ? error.message : String(error),
        acceptedBatchIds,
        queuedBatchIds,
        deadLetterBatchIds,
        baselineCursor,
      };
    } finally {
      await owner.close().catch(() => {});
      await lease.close().catch(() => {});
    }
  }
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
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
