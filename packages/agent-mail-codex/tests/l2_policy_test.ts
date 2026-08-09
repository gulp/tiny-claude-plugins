/**
 * L2: table-driven DeliveryPolicy tests.
 */
import { type DeliveryBatch, deliveryBatch, DOMAIN_SCHEMA_VERSION } from "../src/schemas/mod.ts";
import {
  type BatchUrgency,
  decideAfterRefresh,
  DefaultDeliveryPolicy,
  type DeliveryAction,
  type ThreadDeliveryView,
  urgencyFromEvents,
} from "../src/policy/mod.ts";
import { mailEvent } from "../src/schemas/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

const batch: DeliveryBatch = deliveryBatch({
  bindingId: "amber-apply-patch",
  recipient: "AmberOtter",
  projectSlug: "home-gulp-projects-apply-patch",
  sourceMessageIds: [1],
  state: "pending",
  encodedBytes: 32,
});

function snap(partial: Partial<ThreadDeliveryView>): ThreadDeliveryView {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    threadId: "thread-1",
    activeTurnId: null,
    idle: true,
    owner: "headless",
    ...partial,
  };
}

type Case = {
  name: string;
  thread: ThreadDeliveryView;
  urgency: BatchUrgency;
  expect: DeliveryAction["kind"] | { kind: "steerTurn"; turnId: string } | {
    kind: "queue";
    reason: string;
  };
};

const TABLE: Case[] = [
  {
    name: "idle headless → startTurn",
    thread: snap({ idle: true, activeTurnId: null, owner: "headless" }),
    urgency: "routine",
    expect: "startTurn",
  },
  {
    name: "idle urgent → startTurn (not steer)",
    thread: snap({ idle: true, activeTurnId: null }),
    urgency: "urgent",
    expect: "startTurn",
  },
  {
    name: "active routine → queue",
    thread: snap({ idle: false, activeTurnId: "turn-9" }),
    urgency: "routine",
    expect: { kind: "queue", reason: "routine_during_turn" },
  },
  {
    name: "active urgent → steerTurn",
    thread: snap({ idle: false, activeTurnId: "turn-9" }),
    urgency: "urgent",
    expect: { kind: "steerTurn", turnId: "turn-9" },
  },
  {
    name: "human owner always queues",
    thread: snap({ owner: "human", idle: true }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "human_owner" },
  },
  {
    name: "owner none queues",
    thread: snap({ owner: "none", idle: true }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "owner_none" },
  },
  {
    name: "approval gate queues even when idle headless",
    thread: snap({ humanGate: "approval" }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "human_gate" },
  },
  {
    name: "user_input gate queues",
    thread: snap({ humanGate: "user_input", idle: false, activeTurnId: "t1" }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "human_gate" },
  },
  {
    name: "plan_decision gate queues",
    thread: snap({ humanGate: "plan_decision" }),
    urgency: "routine",
    expect: { kind: "queue", reason: "human_gate" },
  },
  {
    name: "unknown status queues",
    thread: snap({ statusUnknown: true }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "status_unknown" },
  },
  {
    name: "contradictory idle/active queues",
    thread: snap({ idle: true, activeTurnId: "turn-x" }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "status_unknown" },
  },
  {
    name: "active without turn id queues",
    thread: snap({ idle: false, activeTurnId: null }),
    urgency: "urgent",
    expect: { kind: "queue", reason: "status_unknown" },
  },
];

Deno.test("L2: table-driven urgency × thread-state decisions", () => {
  const policy = new DefaultDeliveryPolicy();
  for (const row of TABLE) {
    const action = policy.decide(batch, row.thread, row.urgency);
    if (typeof row.expect === "string") {
      assertEquals(action.kind, row.expect, row.name);
    } else if (row.expect.kind === "steerTurn") {
      assertEquals(action.kind, "steerTurn", row.name);
      if (action.kind === "steerTurn") {
        assertEquals(action.turnId, row.expect.turnId, row.name);
      }
    } else {
      assertEquals(action.kind, "queue", row.name);
      if (action.kind === "queue") {
        assertEquals(action.reason, row.expect.reason, row.name);
      }
    }
  }
});

Deno.test("L2: urgencyFromEvents matches plan definition", () => {
  assertEquals(
    urgencyFromEvents([
      mailEvent({
        messageId: 1,
        recipient: "A",
        projectSlug: "p",
        createdTs: "t",
        subject: "s",
        importance: "normal",
        ackRequired: false,
      }),
    ]),
    "routine",
  );
  assertEquals(
    urgencyFromEvents([
      mailEvent({
        messageId: 1,
        recipient: "A",
        projectSlug: "p",
        createdTs: "t",
        subject: "s",
        importance: "high",
        ackRequired: false,
      }),
    ]),
    "urgent",
  );
  assertEquals(
    urgencyFromEvents([
      mailEvent({
        messageId: 1,
        recipient: "A",
        projectSlug: "p",
        createdTs: "t",
        subject: "s",
        importance: "low",
        ackRequired: true,
      }),
    ]),
    "urgent",
  );
});

Deno.test("L2: expectedTurnId race after refresh queues", () => {
  const policy = new DefaultDeliveryPolicy();
  const previous = snap({ idle: false, activeTurnId: "turn-old" });
  const refreshed = snap({ idle: false, activeTurnId: "turn-new" });
  const action = decideAfterRefresh(policy, batch, previous, refreshed, "urgent");
  assertEquals(action.kind, "queue");
  if (action.kind === "queue") {
    assertEquals(action.reason, "expected_turn_race");
  }

  const completed = snap({ idle: true, activeTurnId: null });
  const afterComplete = decideAfterRefresh(
    policy,
    batch,
    previous,
    completed,
    "urgent",
  );
  assertEquals(afterComplete.kind, "queue");
  if (afterComplete.kind === "queue") {
    assertEquals(afterComplete.reason, "expected_turn_race");
  }

  // Stable turn id → steer still allowed.
  const stable = decideAfterRefresh(policy, batch, previous, previous, "urgent");
  assertEquals(stable.kind, "steerTurn");
});

Deno.test("L2: routine never steers", () => {
  const policy = new DefaultDeliveryPolicy();
  const action = policy.decide(
    batch,
    snap({ idle: false, activeTurnId: "turn-1" }),
    "routine",
  );
  assert(action.kind !== "steerTurn", "routine must not steer");
  assertEquals(action.kind, "queue");
});
