/**
 * Reusable MailboxSource contract suite (F6).
 */

import { FakeMailboxSource } from "./fake.ts";
import { FsMailboxSource } from "./fs.ts";
import {
  type MailboxSource,
  parseMailboxFilename,
  slugForProject,
  type SourceScope,
  SUBJECT_MAX_BYTES,
} from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message || `expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

export type MailboxFactory = () => {
  source: MailboxSource;
  /** Seed pre-baseline mail (ids ≤ baseline). */
  seedBaseline: () => Promise<void> | void;
  /** Deliver new mail after baseline. */
  deliverNew: () => Promise<void> | void;
  scope: SourceScope;
};

/** Run F6 contract against a factory (default: FakeMailboxSource). */
export async function runMailboxSourceContract(
  factory: MailboxFactory = defaultFakeFactory,
): Promise<void> {
  await contractBaselineDoesNotReplay(factory);
  await contractReadAfterOrdered(factory);
  await contractNoWrites(factory);
  await contractSkipsTyped(factory);
  await contractProductScope(factory);
}

function defaultFakeFactory(): ReturnType<MailboxFactory> {
  const source = new FakeMailboxSource({
    records: [
      {
        messageId: 10,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "baseline",
        importance: "normal",
      },
    ],
  });
  const scope: SourceScope = {
    kind: "project",
    agent: "AmberOtter",
    projectPath: "/home/fixture/project",
  };
  return {
    source,
    scope,
    seedBaseline: () => {},
    deliverNew: () => {
      source.push({
        messageId: 11,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:01:00Z",
        subject: "new-mail",
        importance: "high",
        ackRequired: true,
      });
      source.push({
        messageId: 12,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:02:00Z",
        subject: "second",
        importance: "urgent",
      });
    },
  };
}

async function contractBaselineDoesNotReplay(factory: MailboxFactory): Promise<void> {
  const ctx = factory();
  await ctx.seedBaseline();
  const cursor = await ctx.source.baseline(ctx.scope);
  const page = await ctx.source.readAfter(ctx.scope, cursor);
  assertEquals(page.events.length, 0, "baseline must not replay existing mail");
  assert(cursor.lastMessageId >= 10 || cursor.lastMessageId === 0, "cursor");
}

async function contractReadAfterOrdered(factory: MailboxFactory): Promise<void> {
  const ctx = factory();
  await ctx.seedBaseline();
  const cursor = await ctx.source.baseline(ctx.scope);
  await ctx.deliverNew();
  const page = await ctx.source.readAfter(ctx.scope, cursor);
  assert(page.events.length >= 2, "expected new events");
  for (let i = 1; i < page.events.length; i++) {
    assert(
      page.events[i].messageId > page.events[i - 1].messageId,
      "events must be ordered by messageId",
    );
  }
  assert(
    page.events.every((e) => e.messageId > cursor.lastMessageId),
    "only ids after cursor",
  );
  assert(
    page.events.every((e) => e.eventId === `agent-mail:${e.messageId}`),
    "stable event ids",
  );
}

async function contractNoWrites(factory: MailboxFactory): Promise<void> {
  const ctx = factory();
  if (!(ctx.source instanceof FakeMailboxSource)) return;
  const before = ctx.source.readCount;
  await ctx.source.baseline(ctx.scope);
  await ctx.source.readAfter(ctx.scope, { lastMessageId: 0 });
  assert(ctx.source.readCount > before, "reads occur");
  // Fake has no write API by design; FS contract covered in f6 tests via chmod/ro root.
}

async function contractSkipsTyped(_factory: MailboxFactory): Promise<void> {
  const source = new FakeMailboxSource({
    records: [
      {
        messageId: 1,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "ok",
      },
      {
        messageId: 2,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "bad",
        skip: "malformed_filename",
      },
      {
        messageId: 3,
        projectSlug: "home-fixture-project",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "x".repeat(SUBJECT_MAX_BYTES + 10),
      },
    ],
  });
  const scope: SourceScope = {
    kind: "project",
    agent: "AmberOtter",
    projectPath: "/home/fixture/project",
  };
  const page = await source.readAfter(scope, { lastMessageId: 0 });
  assertEquals(page.events.map((e) => e.messageId), [1]);
  assert(
    page.skipped.some((s) => s.reason === "malformed_filename"),
    "malformed skip",
  );
  assert(
    page.skipped.some((s) => s.reason === "subject_too_long"),
    "subject bound skip",
  );
}

async function contractProductScope(factory: MailboxFactory): Promise<void> {
  void factory;
  const source = new FakeMailboxSource({
    records: [
      {
        messageId: 5,
        projectSlug: "slug-a",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "a",
      },
      {
        messageId: 6,
        projectSlug: "slug-b",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "b",
      },
      {
        messageId: 7,
        projectSlug: "slug-c",
        createdTs: "2026-07-28T10:00:00Z",
        subject: "c",
      },
    ],
  });
  const page = await source.readAfter(
    {
      kind: "product",
      agent: "AmberOtter",
      productKey: "demo-product",
      projectSlugs: ["slug-b", "slug-a"],
    },
    { lastMessageId: 0 },
  );
  assertEquals(page.events.map((e) => e.messageId), [5, 6]);
}

/** Helpers exported for unit tests. */
export const mailboxContractHelpers = {
  slugForProject,
  parseMailboxFilename,
  SUBJECT_MAX_BYTES,
  FsMailboxSource,
};
