// The durable git-mailbox reader — read-only, SQLite-independent.
//
// Agent Mail persists every delivered message as one markdown file in a real git
// repo, INDEPENDENT of the SQLite read path that `check-inbox` / `robot inbox`
// use. Layout (v0.3.x, derive — do not hardcode a project):
//
//   <ROOT>/projects/<project_slug>/agents/<Agent>/inbox/YYYY/MM/<ts>__<subject>__<id>.md
//
//   ROOT default : $AGENT_MAIL_MAILBOX_ROOT or ~/.mcp_agent_mail_git_mailbox_repo
//   project_slug : the project cwd path, non-alphanumeric runs -> "-", lowercased
//                  (/home/gulp/Vaults/everything -> home-gulp-vaults-everything)
//   filename     : "<ts>__<subject>__<id>.md" — ts is the head, <id> the numeric
//                  tail; the subject middle may itself carry single underscores,
//                  so parse anchors on the id tail (see parseMailboxFilename).
//
// This is why it is the shadow experiment's source of truth: the file appears the
// instant the message is delivered, so it sees mail the SQLite path drops during
// a canonical/DB desync (msg 27651) or a poll-outage-then-read-elsewhere (the
// transport hole). It is READ-ONLY at the OS level — reading inbox files never
// marks anything read. This is the ONE genuinely non-consuming read: `check-inbox`
// is NOT (without `--direct`, daemon up, it routes through fetch_inbox and marks
// read — verified against am v0.3.21), which is exactly why this FS reader should
// become THE watch backend (see ../commands/shadow.ts + the plugin beads).
//
// INTERIM COUPLING (honest): this depends on Agent Mail's PRIVATE on-disk layout.
// It is a shadow/validation substrate, not a committed contract — converge to
// `am products inbox --since-ts` once the Product Bus is enabled upstream.

/** One delivered message as seen on disk. Everything is derived from the path. */
export interface MailboxEntry {
  /** Numeric message id (globally unique) parsed from the filename tail. */
  id: number;
  /** Origin project slug (the <project_slug> path segment). */
  project: string;
  /** Raw timestamp token from the filename (e.g. "2026-07-24T20-15-31Z"). */
  ts: string;
  /** Subject slug from the filename middle (best-effort, hyphenated). */
  subject: string;
  /** Absolute path to the .md file. */
  path: string;
}

export interface SnapshotResult {
  entries: MailboxEntry[];
  /** Inbox dirs that did not exist this snapshot (misconfig vs simply-empty). */
  missingDirs: string[];
  /** .md files whose name did not carry a parseable id (skipped, possibly corrupt). */
  skipped: string[];
}

/**
 * Slugify a project cwd path the way Agent Mail's dir-mode identity does:
 * lowercase, every run of non-[a-z0-9] becomes a single "-", trim edge "-".
 * (/home/gulp/Vaults/everything -> home-gulp-vaults-everything). Existing single
 * "-" separators are preserved (they are already alphanumeric-adjacent).
 */
export function slugForProject(projectPath: string): string {
  return projectPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Default mailbox root: $AGENT_MAIL_MAILBOX_ROOT, else ~/.mcp_agent_mail_git_mailbox_repo. */
export function defaultMailboxRoot(): string {
  const override = Deno.env.get("AGENT_MAIL_MAILBOX_ROOT");
  if (override) return override;
  const home = Deno.env.get("HOME") ?? "";
  return `${home}/.mcp_agent_mail_git_mailbox_repo`;
}

/** The inbox dir for one (root, slug, agent) triple. */
export function inboxDir(root: string, slug: string, agent: string): string {
  return `${root}/projects/${slug}/agents/${agent}/inbox`;
}

// --- MAIL_WATCH_SCOPE (tcp-p0x.16.2) ----------------------------------------
//
// `project` = today's single-project behavior (exactly one slug, the caller's
// own project — resolved by the CLI layer, not here). `all` = every project
// slug under `root/projects/` that has an inbox dir for `agent` (glob below).
// `product` is a recognized value but its slug set is NOT resolved by this
// module — see ../commands/watch.ts `resolveScopeSlugs` for why (deferred,
// tcp-p0x.16.2 non-goal: FS-layout-only product-link discovery is non-trivial).

export type MailWatchScope = "project" | "all" | "product";

const MAIL_WATCH_SCOPES: readonly MailWatchScope[] = ["project", "all", "product"];

/** Type guard: is `v` one of the recognized MAIL_WATCH_SCOPE values? */
export function isMailWatchScope(v: string): v is MailWatchScope {
  return (MAIL_WATCH_SCOPES as readonly string[]).includes(v);
}

/**
 * The "all" scope glob: every `root/projects/<slug>` dir that has an
 * `agents/<agent>/inbox` subdir — i.e. every project this identity has ever
 * received mail in. Read-only, never throws: an unreadable/absent
 * `root/projects` (misconfigured root, or a brand-new mailbox) yields `[]`
 * rather than an error, matching `snapshotMailbox`'s never-throw contract.
 * Sorted for deterministic output.
 */
export async function listInboxSlugs(root: string, agent: string): Promise<string[]> {
  const projectsDir = `${root}/projects`;
  let listing: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(projectsDir)) listing.push(e);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const e of listing) {
    if (!e.isDirectory) continue;
    if (await dirExists(`${projectsDir}/${e.name}/agents/${agent}/inbox`)) {
      slugs.push(e.name);
    }
  }
  slugs.sort();
  return slugs;
}

/**
 * Parse a mailbox filename `<ts>__<subject>__<id>.md` into (ts, subject, id).
 * Returns null when it does not match (not an id-bearing message file) — the
 * caller records it as skipped rather than crashing.
 *
 * ANCHOR ON THE NUMERIC ID TAIL, not `split("__")`: subject slugs legitimately
 * contain SINGLE underscores (e.g. `last_active_ts`), so a subject ending in `_`
 * abuts the `__` separator as `___<id>` and naive splitting mis-reads the id as
 * `_<id>`. This bit on a REAL message (27650) in the live smoke test. The regex
 * is non-greedy for the ts (first `__`) and greedy for the subject so the id is
 * always the final `__<digits>` before `.md`.
 */
export function parseMailboxFilename(
  basename: string,
): { ts: string; subject: string; id: number } | null {
  if (!basename.endsWith(".md")) return null;
  const stem = basename.slice(0, -3);
  const m = stem.match(/^(.+?)__(.+)__(\d+)$/);
  if (!m) return null;
  return { ts: m[1], subject: m[2] || "(no subject)", id: Number(m[3]) };
}

/** Recursively collect *.md file paths under `dir`. Missing dir -> []. Never throws. */
async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let listing: Deno.DirEntry[];
  try {
    listing = [];
    for await (const e of Deno.readDir(dir)) listing.push(e);
  } catch {
    return out; // unreadable/absent — caller distinguishes missing via existence check
  }
  for (const e of listing) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory) {
      out.push(...(await walkMd(full)));
    } else if (e.isFile && e.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await Deno.stat(dir);
    return s.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Snapshot the delivered-mail set for `agent` across every project slug, sorted
 * by (id ascending). Read-only. A missing inbox dir is recorded in `missingDirs`
 * (so the caller can tell "misconfigured/empty root" from "no new mail"); a
 * .md file with no parseable id lands in `skipped`. Never throws.
 */
export async function snapshotMailbox(
  root: string,
  slugs: string[],
  agent: string,
): Promise<SnapshotResult> {
  const entries: MailboxEntry[] = [];
  const missingDirs: string[] = [];
  const skipped: string[] = [];

  for (const slug of slugs) {
    const dir = inboxDir(root, slug, agent);
    if (!(await dirExists(dir))) {
      missingDirs.push(dir);
      continue;
    }
    for (const path of await walkMd(dir)) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      const parsed = parseMailboxFilename(base);
      if (!parsed) {
        skipped.push(path);
        continue;
      }
      entries.push({ id: parsed.id, project: slug, ts: parsed.ts, subject: parsed.subject, path });
    }
  }

  entries.sort((a, b) => a.id - b.id);
  return { entries, missingDirs, skipped };
}
