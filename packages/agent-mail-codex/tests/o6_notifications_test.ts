/// <reference lib="deno.window" />

import {
  createOperatorNotice,
  NoticeCoalescer,
  type NoticeInput,
  notificationLatencyVerdict,
  renderNoticeJson,
  renderNoticeTerminal,
} from "../src/operator/notifications.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function input(overrides: Partial<NoticeInput> = {}): NoticeInput {
  return {
    kind: "wake_started",
    at: "2026-07-29T00:00:00.000Z",
    bindingId: "binding-o6",
    agent: "BeigeHorizon",
    projectSlug: "tiny-claude-plugins",
    messageIds: [42],
    batchId: "batch:42",
    threadId: "thread-o6",
    turnId: null,
    owner: "headless",
    code: "WAKE_STARTED",
    ...overrides,
  };
}

Deno.test("O6 every operator outcome is visibly distinguishable", () => {
  const cases = [
    ["wake_started", "info", "Headless wake started"],
    ["turn_attached", "info", "Mail attached to durable turn"],
    ["turn_completed", "success", "Headless turn completed"],
    ["timeout", "error", "Headless turn timed out"],
    ["dropped", "warning", "Mail delivery dropped"],
    ["wrong_thread", "error", "Wrong-thread delivery refused"],
    ["ownership_conflict", "error", "Thread ownership conflict"],
    ["process_death", "error", "Ingress process stopped"],
  ] as const;
  for (const [kind, severity, summary] of cases) {
    const notice = createOperatorNotice(input({
      kind,
      code: kind.toUpperCase(),
    }));
    assertEquals(notice.severity, severity);
    assertEquals(notice.summary, summary);
    assert(renderNoticeTerminal(notice).includes(`[${notice.code}]`));
  }
});

Deno.test("O6 attach actions name exact durable thread without TUI claims", () => {
  const headless = createOperatorNotice(input());
  assertEquals(headless.action, {
    label: "Inspect exact thread",
    command: "agent-mail-codex status --binding 'binding-o6' --json",
    mode: "inspect",
  });
  const human = createOperatorNotice(input({ owner: "human" }));
  assertEquals(human.action, {
    label: "Resume exact thread",
    command: "codex resume 'thread-o6'",
    mode: "resume",
  });
  assert(!renderNoticeTerminal(headless).toLowerCase().includes("tui"));
});

Deno.test("O6 coalescing prevents storms without losing stable IDs", () => {
  const coalescer = new NoticeCoalescer(1_000);
  assertEquals(
    coalescer.add(createOperatorNotice(input())),
    [],
  );
  assertEquals(
    coalescer.add(createOperatorNotice(input({
      at: "2026-07-29T00:00:00.500Z",
      messageIds: [43, 42],
      batchId: "batch:43",
    }))),
    [],
  );
  const [notice] = coalescer.flush();
  assert(notice);
  assertEquals(notice.count, 2);
  assertEquals(notice.messageIds, [42, 43]);
  assertEquals(notice.batchIds, ["batch:42", "batch:43"]);
});

Deno.test("O6 terminal and JSON surfaces contain correlation, not mail content", () => {
  const notice = createOperatorNotice(input());
  const terminal = renderNoticeTerminal(notice);
  const json = JSON.parse(renderNoticeJson(notice));
  assert(terminal.includes("binding=binding-o6"));
  assert(terminal.includes("messages=42"));
  assertEquals(json.threadId, "thread-o6");
  assertEquals("subject" in json, false);
  assertEquals("body" in json, false);
  assertEquals("text" in json, false);
});

Deno.test("O6 notification latency SLO emits hard verdict", () => {
  assertEquals(
    notificationLatencyVerdict(
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:01.500Z",
      2_000,
    ),
    {
      ok: true,
      latencyMs: 1_500,
      sloMs: 2_000,
      code: "NOTIFICATION_SLO_MET",
    },
  );
  assertEquals(
    notificationLatencyVerdict(
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:02.001Z",
      2_000,
    ).code,
    "NOTIFICATION_SLO_MISSED",
  );
});
