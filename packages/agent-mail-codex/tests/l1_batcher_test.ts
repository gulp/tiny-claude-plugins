/**
 * L1: deterministic burst batcher golden tests.
 */
import {
  BurstBatcher,
  collapseTaskStateSequence,
  DEFAULT_BATCH_WINDOW_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENTS,
  parseTaskState,
} from "../src/batcher/mod.ts";
import { type MailEvent, mailEvent } from "../src/schemas/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function ev(id: number, subject: string): MailEvent {
  return mailEvent({
    messageId: id,
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    createdTs: "2026-07-28T22:00:00.000Z",
    subject,
    importance: "normal",
    ackRequired: false,
  });
}

Deno.test("L1: parseTaskState recognizes claimed/completed/closed", () => {
  assertEquals(parseTaskState("claimed ap-2uu.7"), {
    verb: "claimed",
    taskKey: "ap-2uu.7",
  });
  assertEquals(parseTaskState("Task completed tcp-efp.3.1 overnight"), {
    verb: "completed",
    taskKey: "tcp-efp.3.1",
  });
  assertEquals(parseTaskState("closed ap-2uu.6-agent-surface-collapse"), {
    verb: "closed",
    taskKey: "ap-2uu.6-agent-surface-collapse",
  });
  assertEquals(parseTaskState("Monitor wake nudge"), null);
});

Deno.test("L1: 10 events within 500ms form one batch", () => {
  const batcher = new BurstBatcher({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
  });
  const events = Array.from({ length: 10 }, (_, i) => ev(100 + i, `note-${i}`));
  const t0 = 1_000_000;
  const decision = batcher.add(events, t0);
  assertEquals(decision.flushed.length, 0);
  assertEquals(decision.bufferedCount, 10);
  assertEquals(decision.windowEndsAt, t0 + DEFAULT_BATCH_WINDOW_MS);

  const batch = batcher.flush(t0 + DEFAULT_BATCH_WINDOW_MS);
  assert(batch !== null, "batch expected");
  assertEquals(batch.sourceMessageIds.length, 10);
  assertEquals(batch.sourceMessageIds, events.map((e) => e.messageId));
  assertEquals(batch.eventIds[0], "agent-mail:100");
  assertEquals(batch.eventIds[9], "agent-mail:109");
  assertEquals(batch.firstMessageId, 100);
  assertEquals(batch.lastMessageId, 109);
});

Deno.test("L1: maxEvents cap splits deterministically", () => {
  const batcher = new BurstBatcher({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    maxEvents: 3,
  });
  const events = Array.from({ length: 7 }, (_, i) => ev(200 + i, `n-${i}`));
  const decision = batcher.add(events, 0);
  // 7 events, max 3 → two early flushes of 3, one buffered
  assertEquals(decision.flushed.length, 2);
  assertEquals(decision.flushed[0].sourceMessageIds, [200, 201, 202]);
  assertEquals(decision.flushed[1].sourceMessageIds, [203, 204, 205]);
  assertEquals(decision.bufferedCount, 1);
  const last = batcher.flush(10_000);
  assertEquals(last?.sourceMessageIds, [206]);
});

Deno.test("L1: maxBytes cap splits without silent truncation", () => {
  const big = "x".repeat(20_000);
  const batcher = new BurstBatcher({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    maxBytes: DEFAULT_MAX_BYTES,
  });
  // Three large subjects exceed 32KiB together; first two may fit.
  const decision = batcher.add([ev(1, big), ev(2, big), ev(3, big)], 0);
  assert(decision.flushed.length >= 1, "expected early flush from byte cap");
  const allIds = [
    ...decision.flushed.flatMap((b) => b.sourceMessageIds),
    ...(batcher.flush(999_999)?.sourceMessageIds ?? []),
  ];
  assertEquals(allIds, [1, 2, 3]);
  for (const batch of decision.flushed) {
    assert(batch.encodedBytes > 0, "encodedBytes set");
  }
});

Deno.test("L1: collapse golden claimed→completed→closed preserves all ids", () => {
  const events = [
    ev(10, "claimed ap-2uu.7"),
    ev(11, "completed ap-2uu.7"),
    ev(12, "closed ap-2uu.7"),
    ev(13, "unrelated notice"),
  ];
  const { visible, retained } = collapseTaskStateSequence(events);
  assertEquals(retained.map((e) => e.messageId), [10, 11, 12, 13]);
  assertEquals(visible.map((e) => e.messageId), [12, 13]);
  assertEquals(visible[0].subject, "closed ap-2uu.7");
});

Deno.test("L1: batcher with collapse keeps all sourceEventIds", () => {
  const batcher = new BurstBatcher({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    deterministicCollapse: true,
  });
  const events = [
    ev(20, "claimed tcp-efp.3.1"),
    ev(21, "completed tcp-efp.3.1"),
    ev(22, "closed tcp-efp.3.1"),
  ];
  batcher.add(events, 0);
  const batch = batcher.flush(500);
  assert(batch !== null, "batch");
  assertEquals(batch.sourceMessageIds, [20, 21, 22]);
  assertEquals(batch.eventIds, [
    "agent-mail:20",
    "agent-mail:21",
    "agent-mail:22",
  ]);
  // Collapsed byte budget uses only the final subject.
  const noCollapse = new BurstBatcher({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    deterministicCollapse: false,
  });
  noCollapse.add(events, 0);
  const full = noCollapse.flush(500)!;
  assert(
    batch.encodedBytes < full.encodedBytes,
    "collapse should reduce encodedBytes",
  );
});

Deno.test("L1: default max caps match plan", () => {
  assertEquals(DEFAULT_BATCH_WINDOW_MS, 500);
  assertEquals(DEFAULT_MAX_EVENTS, 50);
  assertEquals(DEFAULT_MAX_BYTES, 32 * 1024);
});
