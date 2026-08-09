/**
 * In-memory MailboxSource for contract tests (F6). Never touches the filesystem.
 */

import type { Importance, MailEvent } from "../schemas/mod.ts";
import {
  type MailboxCursor,
  type MailboxSource,
  type ReadPage,
  resolveSlugs,
  type SkippedFile,
  type SourceScope,
  SUBJECT_MAX_BYTES,
  toMailEvent,
} from "./types.ts";

export type FakeMailRecord = {
  messageId: number;
  projectSlug: string;
  createdTs: string;
  subject: string;
  importance?: Importance;
  ackRequired?: boolean | null;
  /** When set, appears in skipped instead of events. */
  skip?: SkippedFile["reason"];
};

export type FakeMailboxOptions = {
  records?: FakeMailRecord[];
  missingInboxes?: string[];
  layoutDrift?: boolean;
};

export class FakeMailboxSource implements MailboxSource {
  #records: FakeMailRecord[];
  #missingInboxes: string[];
  #layoutDrift: boolean;
  /** Test seam: count reads to prove non-mutating idempotent scans. */
  readCount = 0;

  constructor(options: FakeMailboxOptions = {}) {
    this.#records = [...(options.records ?? [])];
    this.#missingInboxes = [...(options.missingInboxes ?? [])];
    this.#layoutDrift = options.layoutDrift ?? false;
  }

  /** Test seam: append mail after baseline (simulates new delivery). */
  push(record: FakeMailRecord): void {
    this.#records.push(record);
  }

  async baseline(scope: SourceScope): Promise<MailboxCursor> {
    const page = await this.readAfter(scope, { lastMessageId: Number.NEGATIVE_INFINITY });
    let maxId = 0;
    for (const event of page.events) {
      if (event.messageId > maxId) maxId = event.messageId;
    }
    return { lastMessageId: maxId };
  }

  async readAfter(scope: SourceScope, cursor: MailboxCursor): Promise<ReadPage> {
    this.readCount += 1;
    const slugs = new Set(resolveSlugs(scope));
    const agent = scope.agent;
    const events: MailEvent[] = [];
    const skipped: SkippedFile[] = [];

    for (const record of this.#records) {
      if (!slugs.has(record.projectSlug)) continue;
      if (record.messageId <= cursor.lastMessageId) continue;
      if (record.skip) {
        skipped.push({
          relativePath: `fake/${record.projectSlug}/${record.messageId}.md`,
          reason: record.skip,
        });
        continue;
      }
      const subjectBytes = new TextEncoder().encode(record.subject).byteLength;
      if (subjectBytes > SUBJECT_MAX_BYTES) {
        skipped.push({
          relativePath: `fake/${record.projectSlug}/${record.messageId}.md`,
          reason: "subject_too_long",
        });
        continue;
      }
      events.push(
        toMailEvent({
          messageId: record.messageId,
          recipient: agent,
          projectSlug: record.projectSlug,
          createdTs: record.createdTs,
          subject: record.subject,
          importance: record.importance ?? "normal",
          ackRequired: record.ackRequired ?? null,
        }),
      );
    }
    events.sort((a, b) => a.messageId - b.messageId);
    return {
      events,
      skipped,
      missingInboxes: [...this.#missingInboxes],
      layoutDrift: this.#layoutDrift,
    };
  }
}
