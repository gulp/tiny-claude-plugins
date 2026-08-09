/// <reference lib="deno.window" />

/**
 * C4: turn start, urgent steer, event subscription.
 */

import {
  type DeliverySignal,
  TurnSession,
  TurnSessionError,
  type TurnTransport,
} from "../src/owner/turn_session.ts";
import type { ModelInput } from "../src/owner/types.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(
  promise: Promise<unknown>,
  code: TurnSessionError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof TurnSessionError)) throw error;
    assertEquals(error.code, code);
  }
}

class ScriptedTransport implements TurnTransport {
  healthy = true;
  calls: Array<{ method: string; params: unknown }> = [];
  responses: unknown[] = [];

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses.shift();
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }
}

const INPUT: ModelInput = {
  schemaVersion: 1,
  text: "<agent_mail_events>mail</agent_mail_events>",
  byteLength: 40,
};

Deno.test("C4 idle startTurn accepts and emits turnStarted", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ turn: { id: "turn-1" } });
  const session = new TurnSession(transport, {
    threadId: "thread-c4",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  assertEquals(session.signalDelivery("urgent"), { kind: "startTurn" });
  const acceptance = await session.startTurn(INPUT, "batch:c4:1-1#1");
  assertEquals(acceptance, {
    schemaVersion: 1,
    batchId: "batch:c4:1-1",
    threadId: "thread-c4",
    turnId: "turn-1",
    acceptedAt: "2026-07-29T02:00:00.000Z",
    idempotencyKey: "batch:c4:1-1#1",
  });
  assertEquals(session.snapshot(), {
    schemaVersion: 1,
    threadId: "thread-c4",
    activeTurnId: "turn-1",
    idle: false,
    humanGate: null,
    openRequestIds: [],
    ownerMode: "headless",
  });
  assertEquals(transport.calls[0]?.method, "turn/start");
  assertEquals(session.eventHistory()[0]?.kind, "turnStarted");
  assertEquals(await session.startTurn(INPUT, "batch:c4:1-1#1"), acceptance);
});

Deno.test("C4 active urgent steer uses expectedTurnId", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ turn: { id: "turn-9" } }, { turn: { id: "turn-9" } });
  const session = new TurnSession(transport, {
    threadId: "thread-c4",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  await session.startTurn(INPUT, "batch:c4:1-1#1");
  const signal: DeliverySignal = session.signalDelivery("urgent");
  assertEquals(signal, { kind: "steerTurn", turnId: "turn-9" });
  const steered = await session.steerTurn("turn-9", INPUT, "batch:c4:2-2#1");
  assertEquals(steered.turnId, "turn-9");
  assertEquals(transport.calls[1], {
    method: "turn/steer",
    params: {
      threadId: "thread-c4",
      turnId: "turn-9",
      input: [{ type: "text", text: INPUT.text, text_elements: [] }],
    },
  });
  await expectCode(session.steerTurn("wrong", INPUT, "batch:c4:2-2#2"), "turn_mismatch");
});

Deno.test("C4 routine queue signal never steers; completion clears active turn", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ turn: { id: "turn-2" } });
  const session = new TurnSession(transport, {
    threadId: "thread-c4",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  await session.startTurn(INPUT, "batch:a:1-1#1");
  assertEquals(session.signalDelivery("routine"), {
    kind: "queue",
    reason: "routine_during_turn",
  });
  assert(
    session.eventHistory().some((event) => event.kind === "routineQueued"),
    "routineQueued event required",
  );
  session.handleNotification({
    method: "turn/completed",
    params: { turn: { id: "turn-2" } },
  });
  assertEquals(session.snapshot().idle, true);
  assertEquals(session.snapshot().activeTurnId, null);
  assert(
    session.eventHistory().some((event) => event.kind === "turnCompleted"),
    "turnCompleted",
  );
});

Deno.test("C4 refuses steer over human gate and open approval state", async () => {
  const human = new TurnSession(new ScriptedTransport(), {
    threadId: "thread-c4",
    ownershipMode: "human",
    clientId: "human-tui",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  // Seed an active turn via notification (human owns responses; no mail start).
  human.handleNotification({
    method: "turn/started",
    params: { turn: { id: "turn-3" } },
  });
  const opened = human.handleServerRequest({
    id: "approval-1",
    type: "approval",
    method: "item/commandExecution/requestApproval",
  });
  assertEquals(opened.decision.action, "defer");
  assertEquals(human.snapshot().humanGate, "approval");
  assertEquals(human.signalDelivery("urgent"), { kind: "queue", reason: "human_gate" });

  const ht = new ScriptedTransport();
  ht.responses.push({ turn: { id: "turn-h" } });
  const session = new TurnSession(ht, {
    threadId: "thread-c4",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  await session.startTurn(INPUT, "batch:h:1-1#1");
  // Headless auto-declines approval and does not leave a blocking gate.
  const resolved = session.handleServerRequest({
    id: "approval-h",
    type: "approval",
    method: "item/commandExecution/requestApproval",
  });
  assertEquals(resolved.decision.action, "auto_respond");
  assertEquals(resolved.response?.kind, "decline");
  assertEquals(session.snapshot().openRequestIds, []);
  assertEquals(session.snapshot().humanGate, null);
});

Deno.test("C4 non-steerable: second start, disabled steer, owner none", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ turn: { id: "turn-4" } });
  const session = new TurnSession(transport, {
    threadId: "thread-c4",
    urgentSteerEnabled: false,
    now: () => "2026-07-29T02:00:00.000Z",
  });
  await session.startTurn(INPUT, "batch:x:1-1#1");
  await expectCode(session.startTurn(INPUT, "batch:x:1-1#2"), "not_idle");
  assertEquals(session.signalDelivery("urgent"), {
    kind: "queue",
    reason: "routine_during_turn",
  });
  await expectCode(session.steerTurn("turn-4", INPUT, "batch:x:2-2#1"), "non_steerable");

  const none = new TurnSession(new ScriptedTransport(), {
    threadId: "thread-c4",
    ownershipMode: "none",
  });
  assertEquals(none.signalDelivery("urgent"), { kind: "queue", reason: "owner_not_headless" });
  await expectCode(none.startTurn(INPUT, "k"), "owner_not_headless");
});

Deno.test("C4 turn/failed clears active turn; request resolution is observable", async () => {
  const transport = new ScriptedTransport();
  transport.responses.push({ turn: { id: "turn-5" } });
  const session = new TurnSession(transport, {
    threadId: "thread-c4",
    now: () => "2026-07-29T02:00:00.000Z",
  });
  await session.startTurn(INPUT, "batch:f:1-1#1");
  session.handleServerRequest({
    id: "elicit-1",
    type: "elicitation",
    method: "mcpServer/elicitation/request",
  });
  assert(
    session.eventHistory().some((event) =>
      event.kind === "serverRequestResolved" && event.requestId === "elicit-1"
    ),
    "serverRequestResolved",
  );
  session.handleNotification({
    method: "turn/failed",
    params: { turn: { id: "turn-5" }, error: "boom" },
  });
  assertEquals(session.snapshot().idle, true);
  const failed = session.eventHistory().find((event) => event.kind === "turnFailed");
  assert(failed && failed.kind === "turnFailed", "turnFailed");
  assertEquals(failed.detail, "boom");
});

Deno.test("C4 diagnostic event history is bounded", () => {
  const session = new TurnSession(new ScriptedTransport(), {
    threadId: "thread-bounded",
    historyLimit: 3,
  });
  for (let i = 0; i < 8; i++) {
    session.handleNotification({
      method: "turn/started",
      params: { turn: { id: `turn-${i}` } },
    });
    session.handleNotification({
      method: "turn/completed",
      params: { turn: { id: `turn-${i}` } },
    });
  }
  assertEquals(session.eventHistory().length, 3);
  assertEquals(session.eventHistory().map((event) => event.kind), [
    "turnCompleted",
    "turnStarted",
    "turnCompleted",
  ]);
});
