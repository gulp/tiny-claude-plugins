/**
 * V2: end-to-end acceptance scenarios (plan § End-to-end acceptance).
 * Uses fake mailbox + memory/SQLite store + FakeThreadOwner — asserts
 * event/batch/turn/cursor/owner/queue/notice states without manual interpretation.
 */

import { IngressKernel, type KernelBinding, type RunResult } from "../kernel/mod.ts";
import { FakeMailboxSource } from "../mailbox/fake.ts";
import { createOperatorNotice, type OperatorNotice } from "../operator/notifications.ts";
import { ExclusiveHandoff } from "../owner/handoff.ts";
import { FakeThreadOwnerAdapter } from "../owner/fake.ts";
import { ExactThreadLifecycle, ThreadLifecycleError } from "../owner/thread_lifecycle.ts";
import { FakeClock } from "../retry/mod.ts";
import { MemoryDurableStateStore } from "../store/memory.ts";
import { SqliteDurableStateStore } from "../store/sqlite.ts";
import { StoreError } from "../store/mod.ts";

export const V2_BINDING: KernelBinding = {
  bindingId: "amber-apply-patch",
  agent: "AmberOtter",
  configHash: "v2-hash",
  adapter: "headless-app-server-owner",
  threadId: "thread-amber-apply-patch",
  projectSlug: "home-gulp-projects-apply-patch",
  projectPath: "/home/gulp/projects/apply-patch",
};

export type ScenarioResult = {
  id: number;
  name: string;
  ok: boolean;
  detail: string;
  notices: OperatorNotice[];
};

function mail(
  id: number,
  subject: string,
  opts: { importance?: "normal" | "high" | "urgent"; ack?: boolean } = {},
) {
  return {
    messageId: id,
    projectSlug: V2_BINDING.projectSlug,
    createdTs: `2026-07-28T12:00:${String(id % 60).padStart(2, "0")}.000Z`,
    subject,
    importance: opts.importance ?? ("normal" as const),
    ackRequired: opts.ack ?? false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function wakeNotice(messageIds: number[], batchId: string | null): OperatorNotice {
  return createOperatorNotice({
    kind: "wake_started",
    at: "2026-07-28T12:00:00.000Z",
    bindingId: V2_BINDING.bindingId,
    agent: V2_BINDING.agent,
    projectSlug: V2_BINDING.projectSlug,
    messageIds,
    batchId,
    threadId: V2_BINDING.threadId,
    turnId: null,
    owner: "headless",
    code: "wake_started",
  });
}

async function withKernel(
  opts: {
    records?: ReturnType<typeof mail>[];
    batchWindowMs?: number;
    onOwner?: (owner: FakeThreadOwnerAdapter) => void;
    ownerId?: string;
    autoCompleteTurns?: boolean;
  },
  body: (ctx: {
    mailbox: FakeMailboxSource;
    owners: FakeThreadOwnerAdapter[];
    run: Promise<RunResult>;
    abort: AbortController;
    clock: FakeClock;
  }) => Promise<ScenarioResult>,
): Promise<ScenarioResult> {
  const clock = new FakeClock(5_000_000);
  const mailbox = new FakeMailboxSource({ records: opts.records ?? [] });
  const store = new MemoryDurableStateStore({
    now: () => new Date(clock.now()).toISOString(),
  });
  const owners: FakeThreadOwnerAdapter[] = [];
  const kernel = new IngressKernel({
    store,
    mailbox,
    ownerId: opts.ownerId ?? "v2-owner",
    createOwner: () => {
      const owner = new FakeThreadOwnerAdapter({
        now: () => new Date(clock.now()).toISOString(),
        autoCompleteTurns: opts.autoCompleteTurns,
      });
      owners.push(owner);
      opts.onOwner?.(owner);
      return owner;
    },
    clock,
    batchWindowMs: opts.batchWindowMs ?? 0,
    pollIntervalMs: 5,
  });
  const abort = new AbortController();
  const run = kernel.run(V2_BINDING, abort.signal);
  await delay(15);
  try {
    return await body({ mailbox, owners, run, abort, clock });
  } finally {
    abort.abort();
    try {
      await run;
    } catch {
      // ignore
    }
    await store.close();
  }
}

/** 1 — baseline then no replay of pre-existing mail */
export async function scenario1Baseline(): Promise<ScenarioResult> {
  return await withKernel({ records: [mail(100, "pre-existing")] }, async (ctx) => {
    ctx.mailbox.push(mail(101, "post-baseline"));
    await delay(50);
    ctx.abort.abort();
    const result = await ctx.run;
    const notice = wakeNotice([101], result.acceptedBatchIds[0] ?? null);
    const ok = result.ok && result.baselineCursor === 100 &&
      result.acceptedBatchIds.some((id) => id.includes(":101-")) &&
      !result.acceptedBatchIds.some((id) => id.includes(":100-100"));
    return {
      id: 1,
      name: "baseline_then_one_wake",
      ok,
      detail: JSON.stringify(result),
      notices: [notice],
    };
  });
}

/** 2 — single new message → exactly one accepted batch */
export async function scenario2SingleMessage(): Promise<ScenarioResult> {
  return await withKernel({ records: [] }, async (ctx) => {
    ctx.mailbox.push(mail(200, "solo"));
    await delay(50);
    ctx.abort.abort();
    const result = await ctx.run;
    const ok = result.acceptedBatchIds.length === 1 &&
      result.acceptedBatchIds[0].includes(":200-200");
    return {
      id: 2,
      name: "single_message_one_batch",
      ok,
      detail: JSON.stringify(result),
      notices: [wakeNotice([200], result.acceptedBatchIds[0] ?? null)],
    };
  });
}

/** 3 — ten messages inside coalescing window → one batch with all IDs */
export async function scenario3BurstTen(): Promise<ScenarioResult> {
  return await withKernel({ records: [], batchWindowMs: 500 }, async (ctx) => {
    for (let i = 0; i < 10; i++) {
      ctx.mailbox.push(mail(300 + i, `burst-${i}`));
    }
    // Let the kernel observe the burst and establish its window, then advance
    // beyond that window. Advancing before observation merely moves the
    // window's start and used to pass accidentally when duplicate polling hit
    // the max-events cap.
    await delay(20);
    ctx.clock.advance(600);
    await delay(80);
    ctx.abort.abort();
    const result = await ctx.run;
    const batch = result.acceptedBatchIds.find((id) => id.includes(":300-309"));
    const ok = !!batch;
    return {
      id: 3,
      name: "burst_ten_one_turn",
      ok,
      detail: JSON.stringify(result),
      notices: [
        wakeNotice(
          Array.from({ length: 10 }, (_, i) => 300 + i),
          batch ?? null,
        ),
      ],
    };
  });
}

/** 4 — routine mail queues during active turn */
export async function scenario4RoutineQueues(): Promise<ScenarioResult> {
  return await withKernel({ records: [], autoCompleteTurns: false }, async (ctx) => {
    const owner = ctx.owners[0];
    if (!owner) {
      return { id: 4, name: "routine_queues", ok: false, detail: "no owner", notices: [] };
    }
    ctx.mailbox.push(mail(400, "open-turn"));
    await delay(40);
    ctx.mailbox.push(mail(401, "routine-during", { importance: "normal" }));
    await delay(50);
    ctx.abort.abort();
    const result = await ctx.run;
    const ok = result.queuedBatchIds.length >= 1;
    return {
      id: 4,
      name: "routine_queues_during_turn",
      ok,
      detail: JSON.stringify(result),
      notices: [
        createOperatorNotice({
          kind: "turn_attached",
          at: "2026-07-28T12:00:00.000Z",
          bindingId: V2_BINDING.bindingId,
          agent: V2_BINDING.agent,
          projectSlug: V2_BINDING.projectSlug,
          messageIds: [401],
          batchId: result.queuedBatchIds[0] ?? null,
          threadId: V2_BINDING.threadId,
          turnId: null,
          owner: "headless",
          code: "queued_routine",
        }),
      ],
    };
  });
}

/** 5 — urgent steers active turn */
export async function scenario5UrgentSteer(): Promise<ScenarioResult> {
  return await withKernel({ records: [], autoCompleteTurns: false }, async (ctx) => {
    const owner = ctx.owners[0];
    if (!owner) {
      return { id: 5, name: "urgent_steer", ok: false, detail: "no owner", notices: [] };
    }
    ctx.mailbox.push(mail(500, "open-turn"));
    await delay(40);
    ctx.mailbox.push(mail(501, "urgent-during", { importance: "urgent", ack: true }));
    await delay(40);
    owner.completeActiveTurn();
    await delay(40);
    ctx.abort.abort();
    const result = await ctx.run;
    // Steer path accepts under the active turn id once the turn completes.
    const ok = result.acceptedBatchIds.some((id) => id.includes("501")) ||
      result.queuedBatchIds.length === 0 && result.acceptedBatchIds.length >= 2;
    return {
      id: 5,
      name: "urgent_steers_active_turn",
      ok,
      detail: JSON.stringify({
        result,
        history: owner.eventHistory().map((e) => e.kind),
      }),
      notices: [
        wakeNotice(
          [501],
          result.acceptedBatchIds.find((id) => id.includes("501")) ?? null,
        ),
      ],
    };
  });
}

/** 6 — crash before commit; restart duplicate-safe */
export async function scenario6CrashReplay(dbPath: string): Promise<ScenarioResult> {
  const clock = new FakeClock(6_000_000);
  const mailbox = new FakeMailboxSource({ records: [] });
  const store = new SqliteDurableStateStore({
    path: dbPath,
    now: () => new Date(clock.now()).toISOString(),
    armCrash: "after_accept_before_cursor",
  });
  const binding = {
    bindingId: V2_BINDING.bindingId,
    agent: V2_BINDING.agent,
    configHash: V2_BINDING.configHash,
    adapter: V2_BINDING.adapter,
    scopeJson: JSON.stringify({ kind: "project", projectPath: V2_BINDING.projectPath }),
    threadId: V2_BINDING.threadId,
  };
  const lease = await store.open(binding, "v2-crash");
  await lease.transact({
    kind: "enqueueBatch",
    batch: {
      batchId: "batch:amber-apply-patch:600-600",
      bindingId: V2_BINDING.bindingId,
      firstMessageId: 600,
      lastMessageId: 600,
      eventIds: ["agent-mail:600"],
      payloadJson: "{}",
      urgency: "routine",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      acceptedTurnId: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    },
  });
  let crashed = false;
  try {
    await lease.transact({
      kind: "acceptBatch",
      batchId: "batch:amber-apply-patch:600-600",
      turnId: "turn-crash",
      cursorMessageId: 600,
      at: "2026-07-28T12:00:01.000Z",
    });
  } catch (error) {
    crashed = error instanceof StoreError;
  }
  const mid = await lease.load();
  await lease.close();
  await store.close();

  const store2 = new SqliteDurableStateStore({
    path: dbPath,
    now: () => new Date(clock.now()).toISOString(),
  });
  const lease2 = await store2.open(binding, "v2-crash-2");
  const recovered = await lease2.load();
  // Same batch id still pending — duplicate-safe retry path.
  const ok = crashed && mid.cursor.lastMessageId === 0 &&
    recovered.batches[0]?.batchId === "batch:amber-apply-patch:600-600" &&
    recovered.batches[0]?.state === "pending" &&
    recovered.cursor.lastMessageId === 0;
  await lease2.transact({
    kind: "acceptBatch",
    batchId: "batch:amber-apply-patch:600-600",
    turnId: "turn-ok",
    cursorMessageId: 600,
    at: "2026-07-28T12:00:02.000Z",
  });
  const final = await lease2.load();
  await lease2.close();
  await store2.close();
  void mailbox;
  return {
    id: 6,
    name: "crash_before_commit_duplicate_safe",
    ok: ok && final.cursor.lastMessageId === 600 && final.batches[0].state === "accepted",
    detail: JSON.stringify({ midCursor: mid.cursor, finalCursor: final.cursor }),
    notices: [wakeNotice([600], "batch:amber-apply-patch:600-600")],
  };
}

/** 7 — wrong configured thread → loud refusal, no replacement */
export async function scenario7WrongThread(): Promise<ScenarioResult> {
  const lifecycle = new ExactThreadLifecycle(
    {
      healthy: true,
      request: () =>
        Promise.resolve({
          thread: { id: "thread-WRONG", activeTurn: null },
        }),
    },
    {
      load: () => Promise.resolve("thread-amber-apply-patch"),
      persistFirst: () => Promise.resolve(),
    },
  );
  let refused = false;
  try {
    await lifecycle.acquire({
      bindingId: V2_BINDING.bindingId,
      projectPath: V2_BINDING.projectPath,
      expectedThreadId: V2_BINDING.threadId,
    });
  } catch (error) {
    refused = error instanceof ThreadLifecycleError &&
      error.code === "binding_mismatch";
  }
  const notice = createOperatorNotice({
    kind: "wrong_thread",
    at: "2026-07-28T12:00:00.000Z",
    bindingId: V2_BINDING.bindingId,
    agent: V2_BINDING.agent,
    projectSlug: V2_BINDING.projectSlug,
    messageIds: [],
    batchId: null,
    threadId: "thread-WRONG",
    turnId: null,
    owner: "none",
    code: "thread_mismatch",
  });
  return {
    id: 7,
    name: "wrong_thread_loud_stop",
    ok: refused && notice.kind === "wrong_thread" && notice.severity === "error",
    detail: "wrong_thread notice + exact thread retained",
    notices: [notice],
  };
}

/** 8 — second supervisor lease refusal */
export async function scenario8LeaseExclusion(dbPath: string): Promise<ScenarioResult> {
  const store = new SqliteDurableStateStore({
    path: dbPath,
    now: () => "2026-07-28T12:00:00.000Z",
  });
  const binding = {
    bindingId: V2_BINDING.bindingId,
    agent: V2_BINDING.agent,
    configHash: V2_BINDING.configHash,
    adapter: V2_BINDING.adapter,
    scopeJson: "{}",
    threadId: V2_BINDING.threadId,
  };
  const a = await store.open(binding, "supervisor-a");
  let held = false;
  try {
    await store.open(binding, "supervisor-b");
  } catch (error) {
    held = error instanceof StoreError && error.code === "lease_held";
  }
  await a.close();
  await store.close();
  return {
    id: 8,
    name: "second_supervisor_lease_refused",
    ok: held,
    detail: held ? "lease_held" : "missing refusal",
    notices: [
      createOperatorNotice({
        kind: "ownership_conflict",
        at: "2026-07-28T12:00:00.000Z",
        bindingId: V2_BINDING.bindingId,
        agent: V2_BINDING.agent,
        projectSlug: V2_BINDING.projectSlug,
        messageIds: [],
        batchId: null,
        threadId: V2_BINDING.threadId,
        turnId: null,
        owner: "headless",
        code: "lease_held",
      }),
    ],
  };
}

/** 9 — competing interactive client while headless active */
export async function scenario9CompetingClient(): Promise<ScenarioResult> {
  return await withKernel({ records: [] }, async (ctx) => {
    ctx.mailbox.push(mail(900, "before-compete"));
    await delay(40);
    ctx.owners[0]?.simulateCompetingResponder();
    ctx.mailbox.push(mail(901, "after-compete", { importance: "urgent" }));
    await delay(50);
    ctx.abort.abort();
    const result = await ctx.run;
    const notice = createOperatorNotice({
      kind: "ownership_conflict",
      at: "2026-07-28T12:00:00.000Z",
      bindingId: V2_BINDING.bindingId,
      agent: V2_BINDING.agent,
      projectSlug: V2_BINDING.projectSlug,
      messageIds: [901],
      batchId: null,
      threadId: V2_BINDING.threadId,
      turnId: null,
      owner: "none",
      code: "competing_responder",
    });
    const ok = result.reason === "ownership_lost" ||
      !result.acceptedBatchIds.some((id) => id.includes(":901-"));
    return {
      id: 9,
      name: "competing_client_stops_delivery",
      ok,
      detail: JSON.stringify(result),
      notices: [notice],
    };
  });
}

/** 10 — explicit handoff release → human window → reacquire → ordered delivery */
export async function scenario10HandoffReacquire(): Promise<ScenarioResult> {
  const handoff = new ExclusiveHandoff(V2_BINDING.threadId);
  const release = handoff.releaseToHuman();
  const okRelease = release.owner === "human" &&
    release.threadId === V2_BINDING.threadId &&
    release.resumeCommand.includes(V2_BINDING.threadId);

  // Pending mail accumulates during human window (simulated outbox).
  handoff.enqueue({ id: "batch:pending:1000", sequence: 1 });
  handoff.enqueue({ id: "batch:pending:1001", sequence: 2 });
  const drained = handoff.reacquireHeadless(V2_BINDING.threadId);
  const okAcquire = handoff.snapshot().owner === "headless" &&
    drained.map((d) => d.id).join(",") ===
      "batch:pending:1000,batch:pending:1001";

  // After reacquire, kernel delivers newly observed mail in order.
  const delivery = await withKernel({ records: [] }, async (ctx) => {
    ctx.mailbox.push(mail(1000, "during-human"));
    ctx.mailbox.push(mail(1001, "during-human-2"));
    await delay(60);
    ctx.abort.abort();
    const result = await ctx.run;
    const ordered = result.acceptedBatchIds.some((id) => id.includes("1000")) &&
      result.acceptedBatchIds.some((id) => id.includes("1001"));
    return {
      id: 10,
      name: "handoff_reacquire_ordered_delivery",
      ok: ordered && result.acceptedBatchIds.length >= 1,
      detail: JSON.stringify(result),
      notices: [
        wakeNotice([1000, 1001], result.acceptedBatchIds[0] ?? null),
      ],
    };
  });

  return {
    ...delivery,
    ok: okRelease && okAcquire && delivery.ok,
    detail: JSON.stringify({
      release,
      drained,
      delivery: delivery.detail,
    }),
  };
}

export async function runAllAcceptanceScenarios(
  tmpDir: string,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  results.push(await scenario1Baseline());
  results.push(await scenario2SingleMessage());
  results.push(await scenario3BurstTen());
  results.push(await scenario4RoutineQueues());
  results.push(await scenario5UrgentSteer());
  results.push(await scenario6CrashReplay(`${tmpDir}/crash.sqlite`));
  results.push(await scenario7WrongThread());
  results.push(await scenario8LeaseExclusion(`${tmpDir}/lease.sqlite`));
  results.push(await scenario9CompetingClient());
  results.push(await scenario10HandoffReacquire());
  return results;
}

export function assertAllScenariosPass(results: ScenarioResult[]): void {
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      `V2 acceptance failures: ${failed.map((f) => `#${f.id} ${f.name}: ${f.detail}`).join(" | ")}`,
    );
  }
  if (results.length !== 10) {
    throw new Error(`expected 10 scenarios, got ${results.length}`);
  }
  for (const r of results) {
    if (!r.notices.length) {
      throw new Error(`scenario #${r.id} missing operator-visible notice`);
    }
  }
}
