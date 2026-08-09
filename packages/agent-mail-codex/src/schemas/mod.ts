/**
 * F2: schema-versioned domain types for Codex Agent Mail ingress.
 * No SQLite, filesystem paths, or JSON-RPC frames leak here.
 */

export const DOMAIN_SCHEMA_VERSION = 1 as const;

export type DomainSchemaVersion = typeof DOMAIN_SCHEMA_VERSION;

export type Importance = "low" | "normal" | "high" | "urgent" | "unknown";

export type OwnerMode = "headless" | "human" | "none";

export type OwnershipModel = "exclusive-handoff";

export type BatchState =
  | "pending"
  | "delivering"
  | "accepted"
  | "dead_letter";

export class SchemaError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown_schema_version"
      | "invalid_shape"
      | "invalid_id"
      | "empty_batch",
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

/** Stable mail event id — never reuse across messages. */
export type EventId = `agent-mail:${number}`;

/** Opaque batch id — stable across ambiguous retry. */
export type BatchId = string;

export interface MailEvent {
  schemaVersion: DomainSchemaVersion;
  eventId: EventId;
  messageId: number;
  recipient: string;
  projectSlug: string;
  createdTs: string;
  subject: string;
  importance: Importance;
  ackRequired: boolean | null;
}

export interface DeliveryBatch {
  schemaVersion: DomainSchemaVersion;
  batchId: BatchId;
  bindingId: string;
  recipient: string;
  projectSlug: string;
  eventIds: EventId[];
  sourceMessageIds: number[];
  firstMessageId: number;
  lastMessageId: number;
  state: BatchState;
  encodedBytes: number;
}

export interface ThreadBinding {
  schemaVersion: DomainSchemaVersion;
  bindingId: string;
  agent: string;
  projectSlug: string;
  threadId: string;
  ownershipModel: OwnershipModel;
}

export interface OwnershipProof {
  schemaVersion: DomainSchemaVersion;
  mode: OwnershipModel;
  owner: "headless";
  bindingId: string;
  threadId: string;
  subscriberCount: 1;
  competingResponder: false;
  provenAt: string;
}

export interface ThreadSnapshot {
  schemaVersion: DomainSchemaVersion;
  threadId: string;
  activeTurnId: string | null;
  idle: boolean;
  owner: OwnerMode;
}

export interface Acceptance {
  schemaVersion: DomainSchemaVersion;
  batchId: BatchId;
  threadId: string;
  turnId: string;
  acceptedAt: string;
  idempotencyKey: string;
}

export interface DomainError {
  schemaVersion: DomainSchemaVersion;
  code: string;
  message: string;
  retryable: boolean;
  bindingId?: string;
  batchId?: BatchId;
  eventId?: EventId;
}

const IMPORTANCE: Importance[] = ["low", "normal", "high", "urgent", "unknown"];
const BATCH_STATES: BatchState[] = ["pending", "delivering", "accepted", "dead_letter"];
const OWNERS: OwnerMode[] = ["headless", "human", "none"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSchemaVersion(raw: Record<string, unknown>, ctx: string): DomainSchemaVersion {
  const version = raw.schemaVersion;
  if (version !== DOMAIN_SCHEMA_VERSION) {
    throw new SchemaError(
      `${ctx}: unknown schemaVersion ${JSON.stringify(version)}; expected ${DOMAIN_SCHEMA_VERSION}`,
      "unknown_schema_version",
    );
  }
  return DOMAIN_SCHEMA_VERSION;
}

function requireString(raw: Record<string, unknown>, key: string, ctx: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SchemaError(`${ctx}: ${key} must be a non-empty string`, "invalid_shape");
  }
  return value;
}

function requireNumber(raw: Record<string, unknown>, key: string, ctx: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError(`${ctx}: ${key} must be a non-negative safe integer`, "invalid_shape");
  }
  return value;
}

function requireBooleanOrNull(
  raw: Record<string, unknown>,
  key: string,
  ctx: string,
): boolean | null {
  const value = raw[key];
  if (value !== null && typeof value !== "boolean") {
    throw new SchemaError(`${ctx}: ${key} must be boolean or null`, "invalid_shape");
  }
  return value as boolean | null;
}

export function eventIdFor(messageId: number): EventId {
  if (!Number.isSafeInteger(messageId) || messageId < 0) {
    throw new SchemaError(`invalid messageId ${messageId}`, "invalid_id");
  }
  return `agent-mail:${messageId}`;
}

export function parseEventId(eventId: string): number {
  const match = /^agent-mail:(\d+)$/.exec(eventId);
  if (!match) throw new SchemaError(`invalid eventId ${eventId}`, "invalid_id");
  return Number(match[1]);
}

/** Mint a stable batch id from binding + first/last message ids (deterministic). */
export function batchIdFor(
  bindingId: string,
  firstMessageId: number,
  lastMessageId: number,
): BatchId {
  if (!bindingId.trim()) throw new SchemaError("bindingId required", "invalid_id");
  if (firstMessageId > lastMessageId) {
    throw new SchemaError("firstMessageId must be <= lastMessageId", "invalid_id");
  }
  return `batch:${bindingId}:${firstMessageId}-${lastMessageId}`;
}

export function mailEvent(input: Omit<MailEvent, "schemaVersion" | "eventId">): MailEvent {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: eventIdFor(input.messageId),
    ...input,
  };
}

export function deliveryBatch(
  input:
    & Omit<
      DeliveryBatch,
      "schemaVersion" | "batchId" | "eventIds" | "firstMessageId" | "lastMessageId"
    >
    & {
      sourceMessageIds: number[];
      batchId?: BatchId;
    },
): DeliveryBatch {
  if (!input.sourceMessageIds.length) {
    throw new SchemaError("batch requires at least one source message id", "empty_batch");
  }
  const sorted = [...input.sourceMessageIds].sort((a, b) => a - b);
  const firstMessageId = sorted[0];
  const lastMessageId = sorted[sorted.length - 1];
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    batchId: input.batchId ?? batchIdFor(input.bindingId, firstMessageId, lastMessageId),
    bindingId: input.bindingId,
    recipient: input.recipient,
    projectSlug: input.projectSlug,
    eventIds: sorted.map(eventIdFor),
    sourceMessageIds: sorted,
    firstMessageId,
    lastMessageId,
    state: input.state,
    encodedBytes: input.encodedBytes,
  };
}

export function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function decodeMailEvent(raw: unknown): MailEvent {
  if (!isObject(raw)) throw new SchemaError("MailEvent must be an object", "invalid_shape");
  requireSchemaVersion(raw, "MailEvent");
  const messageId = requireNumber(raw, "messageId", "MailEvent");
  const eventId = requireString(raw, "eventId", "MailEvent");
  if (eventId !== eventIdFor(messageId)) {
    throw new SchemaError(`MailEvent.eventId must be agent-mail:${messageId}`, "invalid_id");
  }
  const importance = requireString(raw, "importance", "MailEvent") as Importance;
  if (!IMPORTANCE.includes(importance)) {
    throw new SchemaError(`MailEvent.importance invalid: ${importance}`, "invalid_shape");
  }
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: eventId as EventId,
    messageId,
    recipient: requireString(raw, "recipient", "MailEvent"),
    projectSlug: requireString(raw, "projectSlug", "MailEvent"),
    createdTs: requireString(raw, "createdTs", "MailEvent"),
    subject: requireString(raw, "subject", "MailEvent"),
    importance,
    ackRequired: requireBooleanOrNull(raw, "ackRequired", "MailEvent"),
  };
}

export function decodeDeliveryBatch(raw: unknown): DeliveryBatch {
  if (!isObject(raw)) throw new SchemaError("DeliveryBatch must be an object", "invalid_shape");
  requireSchemaVersion(raw, "DeliveryBatch");
  const state = requireString(raw, "state", "DeliveryBatch") as BatchState;
  if (!BATCH_STATES.includes(state)) {
    throw new SchemaError(`DeliveryBatch.state invalid: ${state}`, "invalid_shape");
  }
  if (!Array.isArray(raw.eventIds) || !Array.isArray(raw.sourceMessageIds)) {
    throw new SchemaError(
      "DeliveryBatch eventIds/sourceMessageIds must be arrays",
      "invalid_shape",
    );
  }
  const sourceMessageIds = raw.sourceMessageIds.map((id, index) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
      throw new SchemaError(`sourceMessageIds[${index}] invalid`, "invalid_shape");
    }
    return id;
  });
  const eventIds = raw.eventIds.map((id, index) => {
    if (typeof id !== "string") {
      throw new SchemaError(`eventIds[${index}] invalid`, "invalid_shape");
    }
    parseEventId(id);
    return id as EventId;
  });
  if (!sourceMessageIds.length) throw new SchemaError("empty batch", "empty_batch");
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    batchId: requireString(raw, "batchId", "DeliveryBatch"),
    bindingId: requireString(raw, "bindingId", "DeliveryBatch"),
    recipient: requireString(raw, "recipient", "DeliveryBatch"),
    projectSlug: requireString(raw, "projectSlug", "DeliveryBatch"),
    eventIds,
    sourceMessageIds,
    firstMessageId: requireNumber(raw, "firstMessageId", "DeliveryBatch"),
    lastMessageId: requireNumber(raw, "lastMessageId", "DeliveryBatch"),
    state,
    encodedBytes: requireNumber(raw, "encodedBytes", "DeliveryBatch"),
  };
}

export function decodeThreadBinding(raw: unknown): ThreadBinding {
  if (!isObject(raw)) throw new SchemaError("ThreadBinding must be an object", "invalid_shape");
  requireSchemaVersion(raw, "ThreadBinding");
  const ownershipModel = requireString(raw, "ownershipModel", "ThreadBinding");
  if (ownershipModel !== "exclusive-handoff") {
    throw new SchemaError(
      `ThreadBinding.ownershipModel must be exclusive-handoff (S5); got ${ownershipModel}`,
      "invalid_shape",
    );
  }
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: requireString(raw, "bindingId", "ThreadBinding"),
    agent: requireString(raw, "agent", "ThreadBinding"),
    projectSlug: requireString(raw, "projectSlug", "ThreadBinding"),
    threadId: requireString(raw, "threadId", "ThreadBinding"),
    ownershipModel: "exclusive-handoff",
  };
}

export function decodeOwnershipProof(raw: unknown): OwnershipProof {
  if (!isObject(raw)) throw new SchemaError("OwnershipProof must be an object", "invalid_shape");
  requireSchemaVersion(raw, "OwnershipProof");
  if (raw.mode !== "exclusive-handoff" || raw.owner !== "headless") {
    throw new SchemaError("OwnershipProof must be exclusive-handoff/headless", "invalid_shape");
  }
  if (raw.subscriberCount !== 1 || raw.competingResponder !== false) {
    throw new SchemaError("OwnershipProof must show sole subscriber", "invalid_shape");
  }
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    mode: "exclusive-handoff",
    owner: "headless",
    bindingId: requireString(raw, "bindingId", "OwnershipProof"),
    threadId: requireString(raw, "threadId", "OwnershipProof"),
    subscriberCount: 1,
    competingResponder: false,
    provenAt: requireString(raw, "provenAt", "OwnershipProof"),
  };
}

export function decodeThreadSnapshot(raw: unknown): ThreadSnapshot {
  if (!isObject(raw)) throw new SchemaError("ThreadSnapshot must be an object", "invalid_shape");
  requireSchemaVersion(raw, "ThreadSnapshot");
  const owner = requireString(raw, "owner", "ThreadSnapshot") as OwnerMode;
  if (!OWNERS.includes(owner)) {
    throw new SchemaError(`ThreadSnapshot.owner invalid: ${owner}`, "invalid_shape");
  }
  if (typeof raw.idle !== "boolean") {
    throw new SchemaError("ThreadSnapshot.idle must be boolean", "invalid_shape");
  }
  const activeTurnId = raw.activeTurnId;
  if (activeTurnId !== null && typeof activeTurnId !== "string") {
    throw new SchemaError("ThreadSnapshot.activeTurnId must be string|null", "invalid_shape");
  }
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    threadId: requireString(raw, "threadId", "ThreadSnapshot"),
    activeTurnId: activeTurnId as string | null,
    idle: raw.idle,
    owner,
  };
}

export function decodeAcceptance(raw: unknown): Acceptance {
  if (!isObject(raw)) throw new SchemaError("Acceptance must be an object", "invalid_shape");
  requireSchemaVersion(raw, "Acceptance");
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    batchId: requireString(raw, "batchId", "Acceptance"),
    threadId: requireString(raw, "threadId", "Acceptance"),
    turnId: requireString(raw, "turnId", "Acceptance"),
    acceptedAt: requireString(raw, "acceptedAt", "Acceptance"),
    idempotencyKey: requireString(raw, "idempotencyKey", "Acceptance"),
  };
}

export function decodeDomainError(raw: unknown): DomainError {
  if (!isObject(raw)) throw new SchemaError("DomainError must be an object", "invalid_shape");
  requireSchemaVersion(raw, "DomainError");
  if (typeof raw.retryable !== "boolean") {
    throw new SchemaError("DomainError.retryable must be boolean", "invalid_shape");
  }
  const out: DomainError = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    code: requireString(raw, "code", "DomainError"),
    message: requireString(raw, "message", "DomainError"),
    retryable: raw.retryable,
  };
  if (typeof raw.bindingId === "string") out.bindingId = raw.bindingId;
  if (typeof raw.batchId === "string") out.batchId = raw.batchId;
  if (typeof raw.eventId === "string") {
    parseEventId(raw.eventId);
    out.eventId = raw.eventId as EventId;
  }
  return out;
}

/** Minimal JSON Schema documents (draft-agnostic) for golden agreement checks. */
export const jsonSchemas = {
  MailEvent: {
    $id: "agent-mail-codex/MailEvent",
    type: "object",
    required: [
      "schemaVersion",
      "eventId",
      "messageId",
      "recipient",
      "projectSlug",
      "createdTs",
      "subject",
      "importance",
      "ackRequired",
    ],
    properties: {
      schemaVersion: { const: 1 },
      eventId: { type: "string", pattern: "^agent-mail:[0-9]+$" },
      messageId: { type: "integer", minimum: 0 },
      recipient: { type: "string", minLength: 1 },
      projectSlug: { type: "string", minLength: 1 },
      createdTs: { type: "string", minLength: 1 },
      subject: { type: "string" },
      importance: { enum: IMPORTANCE },
      ackRequired: { type: ["boolean", "null"] },
    },
    additionalProperties: false,
  },
  DeliveryBatch: {
    $id: "agent-mail-codex/DeliveryBatch",
    type: "object",
    required: [
      "schemaVersion",
      "batchId",
      "bindingId",
      "recipient",
      "projectSlug",
      "eventIds",
      "sourceMessageIds",
      "firstMessageId",
      "lastMessageId",
      "state",
      "encodedBytes",
    ],
    properties: {
      schemaVersion: { const: 1 },
      batchId: { type: "string", minLength: 1 },
      bindingId: { type: "string", minLength: 1 },
      recipient: { type: "string", minLength: 1 },
      projectSlug: { type: "string", minLength: 1 },
      eventIds: { type: "array", items: { type: "string", pattern: "^agent-mail:[0-9]+$" } },
      sourceMessageIds: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1 },
      firstMessageId: { type: "integer", minimum: 0 },
      lastMessageId: { type: "integer", minimum: 0 },
      state: { enum: BATCH_STATES },
      encodedBytes: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
} as const;
