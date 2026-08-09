/**
 * F6: MailboxSource — non-consuming Agent Mail filesystem seam.
 * Layout knowledge stays here; callers see cursors, pages, and MailEvents only.
 */

import type { Importance, MailEvent } from "../schemas/mod.ts";
import { DOMAIN_SCHEMA_VERSION, eventIdFor, mailEvent } from "../schemas/mod.ts";

/** Subject bound (plan Security / F7 T1). */
export const SUBJECT_MAX_BYTES = 512;

export type MailboxCursor = {
  /** Inclusive high-water message id; baseline adopts max id without emitting. */
  lastMessageId: number;
};

export type SourceScope =
  | { kind: "project"; agent: string; projectPath: string }
  | {
    kind: "product";
    agent: string;
    productKey: string;
    /** Explicit project slugs linked to the product (layout discovery is out of F6). */
    projectSlugs: string[];
  };

export type SkipReason =
  | "malformed_filename"
  | "malformed_frontmatter"
  | "subject_too_long"
  | "symlink_escape"
  | "unreadable";

export type SkippedFile = {
  /** Relative path under the mailbox root when known; otherwise basename. */
  relativePath: string;
  reason: SkipReason;
  detail?: string;
};

export type ReadPage = {
  events: MailEvent[];
  skipped: SkippedFile[];
  /** Inbox dirs that did not exist this read (empty vs misconfigured). */
  missingInboxes: string[];
  /** True when the configured root/projects layout is absent or unreadable. */
  layoutDrift: boolean;
};

export interface MailboxSource {
  baseline(scope: SourceScope): Promise<MailboxCursor>;
  readAfter(scope: SourceScope, cursor: MailboxCursor): Promise<ReadPage>;
}

export class MailboxError extends Error {
  constructor(
    message: string,
    readonly code: "scope_invalid" | "root_invalid" | "write_forbidden",
  ) {
    super(message);
    this.name = "MailboxError";
  }
}

export function slugForProject(projectPath: string): string {
  return projectPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseMailboxFilename(
  basename: string,
): { ts: string; subject: string; id: number } | null {
  if (!basename.endsWith(".md")) return null;
  const stem = basename.slice(0, -3);
  const match = stem.match(/^(.+?)__(.+)__(\d+)$/);
  if (!match) return null;
  return { ts: match[1], subject: match[2] || "(no subject)", id: Number(match[3]) };
}

export function parseAckFrontmatter(
  raw: string,
): { ackRequired: boolean; importance: Importance } | null {
  const match = raw.match(/^---json\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const ackRequired = record.ack_required;
  const importanceRaw = record.importance;
  if (typeof ackRequired !== "boolean") return null;
  const importance = normalizeImportance(importanceRaw);
  return { ackRequired, importance };
}

function normalizeImportance(value: unknown): Importance {
  if (
    value === "low" || value === "normal" || value === "high" || value === "urgent"
  ) {
    return value;
  }
  return "unknown";
}

export function resolveSlugs(scope: SourceScope): string[] {
  if (scope.kind === "project") {
    const slug = slugForProject(scope.projectPath);
    if (!slug) throw new MailboxError("projectPath produced empty slug", "scope_invalid");
    return [slug];
  }
  if (!scope.projectSlugs.length) {
    throw new MailboxError(
      `product ${scope.productKey} requires at least one projectSlug`,
      "scope_invalid",
    );
  }
  return [...scope.projectSlugs].sort();
}

export function toMailEvent(input: {
  messageId: number;
  recipient: string;
  projectSlug: string;
  createdTs: string;
  subject: string;
  importance: Importance;
  ackRequired: boolean | null;
}): MailEvent {
  const subjectBytes = new TextEncoder().encode(input.subject).byteLength;
  if (subjectBytes > SUBJECT_MAX_BYTES) {
    throw new MailboxError(
      `subject exceeds ${SUBJECT_MAX_BYTES} bytes`,
      "scope_invalid",
    );
  }
  return mailEvent(input);
}

export { DOMAIN_SCHEMA_VERSION, eventIdFor };
