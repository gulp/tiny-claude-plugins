/**
 * F2 golden tests: schema-versioned domain types round-trip and fail closed.
 */
import {
  batchIdFor,
  decodeAcceptance,
  decodeDeliveryBatch,
  decodeDomainError,
  decodeMailEvent,
  decodeOwnershipProof,
  decodeThreadBinding,
  decodeThreadSnapshot,
  deliveryBatch,
  DOMAIN_SCHEMA_VERSION,
  encodeJson,
  eventIdFor,
  jsonSchemas,
  mailEvent,
  parseEventId,
  SchemaError,
} from "../src/schemas/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  const encode = (value: unknown) => JSON.stringify(value);
  if (encode(actual) !== encode(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function assertThrowsCode(fn: () => unknown, code: SchemaError["code"]): void {
  try {
    fn();
    throw new Error(`expected SchemaError ${code}`);
  } catch (error) {
    assert(error instanceof SchemaError, `expected SchemaError, got ${error}`);
    assertEquals(error.code, code);
  }
}

const GOLDEN_EVENT = mailEvent({
  messageId: 27982,
  recipient: "CobaltJaguar",
  projectSlug: "home-gulp-projects-tiny-claude-plugins",
  createdTs: "2026-07-28T21:04:29.583807Z",
  subject: "Monitor wake nudge",
  importance: "high",
  ackRequired: true,
});

Deno.test("F2: MailEvent golden round trip", () => {
  assertEquals(GOLDEN_EVENT.eventId, "agent-mail:27982");
  assertEquals(GOLDEN_EVENT.schemaVersion, DOMAIN_SCHEMA_VERSION);
  const encoded = encodeJson(GOLDEN_EVENT);
  const decoded = decodeMailEvent(JSON.parse(encoded));
  assertEquals(decoded, GOLDEN_EVENT);
  assertEquals(parseEventId(decoded.eventId), 27982);
});

Deno.test("F2: DeliveryBatch mint stable ids and round trip", () => {
  const batch = deliveryBatch({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    sourceMessageIds: [27918, 27915, 27917],
    state: "pending",
    encodedBytes: 512,
  });
  assertEquals(batch.firstMessageId, 27915);
  assertEquals(batch.lastMessageId, 27918);
  assertEquals(batch.batchId, batchIdFor("amber-apply-patch", 27915, 27918));
  assertEquals(batch.eventIds, [
    "agent-mail:27915",
    "agent-mail:27917",
    "agent-mail:27918",
  ]);
  // Retry with same ids must mint the same batch id (ambiguous acceptance).
  const again = deliveryBatch({
    bindingId: "amber-apply-patch",
    recipient: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    sourceMessageIds: [27918, 27915, 27917],
    state: "delivering",
    encodedBytes: 512,
  });
  assertEquals(again.batchId, batch.batchId);
  const decoded = decodeDeliveryBatch(JSON.parse(encodeJson(batch)));
  assertEquals(decoded, batch);
});

Deno.test("F2: ThreadBinding / OwnershipProof / Snapshot / Acceptance round trip", () => {
  const binding = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: "amber-apply-patch",
    agent: "AmberOtter",
    projectSlug: "home-gulp-projects-apply-patch",
    threadId: "thread-durable",
    ownershipModel: "exclusive-handoff" as const,
  };
  assertEquals(decodeThreadBinding(JSON.parse(encodeJson(binding))), binding);

  const proof = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    mode: "exclusive-handoff" as const,
    owner: "headless" as const,
    bindingId: "amber-apply-patch",
    threadId: "thread-durable",
    subscriberCount: 1 as const,
    competingResponder: false as const,
    provenAt: "2026-07-28T22:00:00.000Z",
  };
  assertEquals(decodeOwnershipProof(JSON.parse(encodeJson(proof))), proof);

  const snapshot = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    threadId: "thread-durable",
    activeTurnId: null,
    idle: true,
    owner: "headless" as const,
  };
  assertEquals(decodeThreadSnapshot(JSON.parse(encodeJson(snapshot))), snapshot);

  const acceptance = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    batchId: "batch:amber-apply-patch:27915-27918",
    threadId: "thread-durable",
    turnId: "turn-1",
    acceptedAt: "2026-07-28T22:00:01.000Z",
    idempotencyKey: "batch:amber-apply-patch:27915-27918#1",
  };
  assertEquals(decodeAcceptance(JSON.parse(encodeJson(acceptance))), acceptance);

  const err = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    code: "ownership_lost",
    message: "competing responder detected",
    retryable: false,
    bindingId: "amber-apply-patch",
  };
  assertEquals(decodeDomainError(JSON.parse(encodeJson(err))), err);
});

Deno.test("F2: unknown schemaVersion fails closed", () => {
  assertThrowsCode(
    () => decodeMailEvent({ ...GOLDEN_EVENT, schemaVersion: 2 }),
    "unknown_schema_version",
  );
  assertThrowsCode(
    () => decodeDeliveryBatch({ schemaVersion: 99, batchId: "x" }),
    "unknown_schema_version",
  );
});

Deno.test("F2: mismatched eventId / empty batch / non-S5 ownership fail closed", () => {
  assertThrowsCode(
    () => decodeMailEvent({ ...GOLDEN_EVENT, eventId: "agent-mail:1" }),
    "invalid_id",
  );
  assertThrowsCode(
    () =>
      deliveryBatch({
        bindingId: "b",
        recipient: "A",
        projectSlug: "p",
        sourceMessageIds: [],
        state: "pending",
        encodedBytes: 0,
      }),
    "empty_batch",
  );
  assertThrowsCode(
    () =>
      decodeThreadBinding({
        schemaVersion: 1,
        bindingId: "b",
        agent: "A",
        projectSlug: "p",
        threadId: "t",
        ownershipModel: "gateway-owner",
      }),
    "invalid_shape",
  );
});

Deno.test("F2: JSON Schema documents agree with TypeScript required keys", () => {
  assertEquals(jsonSchemas.MailEvent.properties.schemaVersion.const, 1);
  assertEquals(jsonSchemas.DeliveryBatch.properties.schemaVersion.const, 1);
  for (const key of jsonSchemas.MailEvent.required) {
    assert(key in GOLDEN_EVENT, `MailEvent missing required ${key}`);
  }
  const batch = deliveryBatch({
    bindingId: "b",
    recipient: "A",
    projectSlug: "p",
    sourceMessageIds: [1],
    state: "accepted",
    encodedBytes: 10,
  });
  for (const key of jsonSchemas.DeliveryBatch.required) {
    assert(key in batch, `DeliveryBatch missing required ${key}`);
  }
  assertEquals(eventIdFor(1), "agent-mail:1");
});
