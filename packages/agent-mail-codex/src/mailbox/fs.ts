/**
 * Filesystem MailboxSource — read-only canonical git-mailbox adapter (F6).
 */

import {
  type MailboxCursor,
  MailboxError,
  type MailboxSource,
  parseAckFrontmatter,
  parseMailboxFilename,
  type ReadPage,
  resolveSlugs,
  type SkippedFile,
  type SourceScope,
  SUBJECT_MAX_BYTES,
  toMailEvent,
} from "./types.ts";

export type FsMailboxOptions = {
  /** Absolute mailbox root (…/mcp_agent_mail_git_mailbox_repo). */
  root: string;
};

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}

function inboxDir(root: string, slug: string, agent: string): string {
  return `${root}/projects/${slug}/agents/${agent}/inbox`;
}

async function walkMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let listing: Deno.DirEntry[];
  try {
    listing = [];
    for await (const entry of Deno.readDir(dir)) listing.push(entry);
  } catch {
    return out;
  }
  for (const entry of listing) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...(await walkMdFiles(full)));
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      out.push(full);
    } else if (entry.isSymlink) {
      // Follow only if still collected via isFile after resolve — handled below.
      try {
        const stat = await Deno.stat(full);
        if (stat.isFile && entry.name.endsWith(".md")) out.push(full);
      } catch {
        /* skip broken links */
      }
    }
  }
  return out;
}

type RawEntry = {
  id: number;
  projectSlug: string;
  ts: string;
  subject: string;
  path: string;
  relativePath: string;
};

export class FsMailboxSource implements MailboxSource {
  readonly #root: string;

  constructor(options: FsMailboxOptions) {
    if (!options.root.startsWith("/")) {
      throw new MailboxError("mailbox root must be absolute", "root_invalid");
    }
    this.#root = options.root;
  }

  async baseline(scope: SourceScope): Promise<MailboxCursor> {
    const page = await this.#scan(scope, Number.NEGATIVE_INFINITY);
    let maxId = 0;
    for (const event of page.events) {
      if (event.messageId > maxId) maxId = event.messageId;
    }
    return { lastMessageId: maxId };
  }

  async readAfter(scope: SourceScope, cursor: MailboxCursor): Promise<ReadPage> {
    return await this.#scan(scope, cursor.lastMessageId);
  }

  async #scan(scope: SourceScope, afterId: number): Promise<ReadPage> {
    const slugs = resolveSlugs(scope);
    const agent = scope.agent;
    const events = [];
    const skipped: SkippedFile[] = [];
    const missingInboxes: string[] = [];

    const projectsDir = `${this.#root}/projects`;
    const layoutDrift = !(await dirExists(projectsDir));
    const rootReal = await realPathOrNull(this.#root);

    for (const slug of slugs) {
      const inbox = inboxDir(this.#root, slug, agent);
      if (!(await dirExists(inbox))) {
        missingInboxes.push(`${slug}/agents/${agent}/inbox`);
        continue;
      }
      const inboxReal = await realPathOrNull(inbox);
      for (const path of await walkMdFiles(inbox)) {
        const relativePath = path.startsWith(`${this.#root}/`)
          ? path.slice(this.#root.length + 1)
          : path;
        if (rootReal && inboxReal) {
          const fileReal = await realPathOrNull(path);
          if (
            fileReal &&
            (!fileReal.startsWith(`${inboxReal}/`) && fileReal !== inboxReal)
          ) {
            skipped.push({
              relativePath,
              reason: "symlink_escape",
              detail: fileReal,
            });
            continue;
          }
        }
        const base = path.slice(path.lastIndexOf("/") + 1);
        const parsed = parseMailboxFilename(base);
        if (!parsed) {
          skipped.push({ relativePath, reason: "malformed_filename" });
          continue;
        }
        if (parsed.id <= afterId) continue;

        const subjectBytes = new TextEncoder().encode(parsed.subject).byteLength;
        if (subjectBytes > SUBJECT_MAX_BYTES) {
          skipped.push({
            relativePath,
            reason: "subject_too_long",
            detail: `${subjectBytes}>${SUBJECT_MAX_BYTES}`,
          });
          continue;
        }

        let raw: string;
        try {
          raw = await Deno.readTextFile(path);
        } catch (error) {
          skipped.push({
            relativePath,
            reason: "unreadable",
            detail: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const ack = parseAckFrontmatter(raw);
        // Missing frontmatter is allowed (importance unknown, ack null) —
        // only reject when a ---json block exists but is corrupt.
        if (raw.startsWith("---json") && !ack) {
          skipped.push({ relativePath, reason: "malformed_frontmatter" });
          continue;
        }

        const entry: RawEntry = {
          id: parsed.id,
          projectSlug: slug,
          ts: parsed.ts,
          subject: parsed.subject,
          path,
          relativePath,
        };
        events.push(
          toMailEvent({
            messageId: entry.id,
            recipient: agent,
            projectSlug: entry.projectSlug,
            createdTs: filenameTsToIso(entry.ts) ?? entry.ts,
            subject: entry.subject,
            importance: ack?.importance ?? "unknown",
            ackRequired: ack?.ackRequired ?? null,
          }),
        );
      }
    }

    events.sort((a, b) => a.messageId - b.messageId);
    return { events, skipped, missingInboxes, layoutDrift };
  }
}

/** Convert filename token `2026-07-24T20-15-31Z` → ISO-ish when possible. */
function filenameTsToIso(token: string): string | null {
  const match = token.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/,
  );
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
}
