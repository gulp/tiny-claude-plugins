// The shadow tail — a PROTOTYPE that tails the durable git-mailbox (canonical,
// SQLite-independent) and cross-checks it against SQLite to answer: does
// SQLite (still) lag canonical, and can that be told apart from a message that
// legitimately never reached this identity?
//
// It plays two roles at once, per poll:
//   (A) FS-backed watch — emit `MAIL #<id> [<proj>] ...` for each NEW canonical
//       message (silent baseline adopt, no replay). This is the candidate
//       REPLACEMENT behavior for the watch loop (promoted to production by T1).
//   (B) Desync cross-check — every new canonical message in the primary project
//       enters a pending set; each tick queries SQLite directly (read-only, see
//       below) for the pending ids. A message SQLite lags on for `confirm`
//       consecutive ticks is emitted as `DIVERGENCE #<id> ...`.
//
// tcp-p0x.16.5: Part B USED TO cross-poll `am check-inbox` (`pollInbox`), which
// consumes — it routes through the daemon's `fetch_inbox` and marks returned
// messages read (verified against am v0.3.21). That was never acceptable for a
// health-check surface (see doctor.ts), so Part B is repurposed here onto a
// re-verified-non-consuming read instead: `node:sqlite`'s `DatabaseSync` opened
// with `{ readOnly: true }` against am's own `storage.sqlite3`. This is a
// STRONGER non-consuming guarantee than any `am` subcommand label — SQLite
// itself rejects writes against a readOnly-opened handle at the driver level
// (empirically confirmed: an `UPDATE` against such a handle throws "attempt to
// write a readonly database"), so no code path here can touch `read_ts`, even
// a buggy one. `am robot inbox` was considered and REJECTED as the read
// mechanism: it is non-consuming only when no daemon is reachable — with a
// daemon up (the normal case) it takes the exact same consuming `fetch_inbox`
// path as `check-inbox` (source-verified, am v0.3.21 `robot.rs`
// `try_build_inbox_via_server`).
//
// `checkDesync()` below is also exported standalone as the ON-DEMAND primitive
// — doctor.ts's optional desync check calls it once, no loop, no daemon (see
// its own doc comment).
//
// Read the (still-running) `runShadow` loop's outcome as the bet's win/kill
// criteria:
//   * A DIVERGENCE line  => the FS store caught something SQLite doesn't have
//     yet. Bet won: the canonical store is the right poll backend.
//   * mailbox-root missing / many skipped(corrupt) files => the interim
//     coupling's failure mode (archive corruption) bit. Bet killed.
//   * No divergence over the window + FS keeps pace with SQLite => the stores
//     agree here; weaker, keep the shadow armed longer.
//
// Honest label: DIVERGENCE means "canonical-only — SQLite had no
// message_recipients row for (project, agent, id) after N ticks." It can also
// fire on a message that reaches SQLite with ordinary replication lag, hence
// the `confirm` debounce rather than flagging on the first miss.
//
// Both the FS snapshot (A) and the SQLite read (B) are genuinely read-only.

import { DatabaseSync } from "node:sqlite";
import {
  type MailboxEntry,
  slugForProject,
  snapshotMailbox,
  type SnapshotResult,
} from "../core/mailbox.ts";
import { ExitCode } from "../core/exit.ts";
import { sleep } from "../core/sleep.ts";

export interface ShadowOptions {
  agent: string;
  /** Mailbox repo root (already resolved to an absolute path). */
  root: string;
  /** Project slugs to tail on the filesystem (>= 1). */
  slugs: string[];
  /** Primary project key — kept for the `shadow` CLI surface and the startup
   *  log line; the desync cross-check itself only needs `primarySlug` (SQLite
   *  rows are keyed by project SLUG, not this raw cwd/key). */
  project: string;
  /** Slug of `project` — the one FS project whose divergence we track. */
  primarySlug: string;
  /** Ticks a pending id may lag in SQLite before it's DIVERGENCE. */
  confirm: number;
  /** Seconds between polls, >= 1. */
  interval: number;
  signal: AbortSignal;
}

/** A canonical message awaiting corroboration from SQLite. */
interface Pending {
  entry: MailboxEntry;
  /** Count of ticks SQLite did not yet have a recipient row for this id. */
  missedOkTicks: number;
}

const SKIP_WARN_THRESHOLD = 1; // one skipped(unparseable) file is worth a loud line

function mailLine(e: MailboxEntry): string {
  return `MAIL #${e.id} [${e.project}] ${e.ts}: ${e.subject}`;
}

function warnMissingRoot(root: string, slugs: string[]): void {
  console.log(
    `agent-mail-shadow: NO mailbox inbox dirs found under '${root}' for the given slugs (${
      slugs.join(", ")
    }). Either the mailbox root/slug is wrong, or the identity has no delivered mail there. NOT tailing anything until files appear.`,
  );
}

/** Default SQLite store path derived from the mailbox root — am colocates
 *  `storage.sqlite3` alongside the `projects/` tree at the same root. */
export function defaultDbPath(root: string): string {
  return `${root}/storage.sqlite3`;
}

type OpenResult = { db: DatabaseSync; error: null } | { db: null; error: string };

/**
 * Open the store read-only. Never throws — a missing/corrupt file yields
 * `error` and the caller degrades (desync checking unavailable this run)
 * rather than crashing a healthy FS tail over a diagnostic side-channel.
 * `readOnly: true` is enforced by the SQLite driver itself (a write attempt
 * against the resulting handle throws "attempt to write a readonly database"
 * — verified empirically), which is why this is safe to open freely: no code
 * path reachable from this handle can mark anything read.
 */
function openReadOnly(dbPath: string): OpenResult {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), error: null };
  } catch (e) {
    return { db: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * For one project slug + agent, which of `ids` does SQLite currently have a
 * `message_recipients` row for? Read-only — issues SELECTs only, never
 * touches `read_ts`/`ack_ts`. `agentKnown: false` means the (slug, agent) pair
 * has no `agents` row at all, so every id is trivially "lagging" — a distinct,
 * coarser signal from a per-message lag (the identity itself hasn't
 * synced/registered into SQLite for this project, not just this message).
 */
function queryKnownIds(
  db: DatabaseSync,
  slug: string,
  agent: string,
  ids: number[],
): { agentKnown: boolean; known: Set<number> } {
  const known = new Set<number>();
  if (ids.length === 0) return { agentKnown: true, known };
  const agentRow = db.prepare(
    `SELECT a.id AS agent_id FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE p.slug = ? AND a.name = ?`,
  ).get(slug, agent) as { agent_id: number } | undefined;
  if (!agentRow) return { agentKnown: false, known };
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT r.message_id AS id FROM message_recipients r
      WHERE r.agent_id = ? AND r.message_id IN (${placeholders})`,
  ).all(agentRow.agent_id, ...ids) as Array<{ id: number }>;
  for (const row of rows) known.add(row.id);
  return { agentKnown: true, known };
}

export interface DesyncCheckOptions {
  /** Mailbox repo root (already resolved to an absolute path). */
  root: string;
  /** Project slugs to check (>= 1). */
  slugs: string[];
  agent: string;
  /** Override the derived `<root>/storage.sqlite3` path (mainly for tests). */
  dbPath?: string;
}

export interface DesyncCheckResult {
  /** Total canonical entries examined across `slugs`. */
  checked: number;
  /** Canonical entries SQLite has no `message_recipients` row for yet. */
  lagging: MailboxEntry[];
  /** Non-null => the SQLite read could not be attempted at all (open
   *  failure). Distinct from `lagging`: this means "unable to verify," not
   *  "verified behind." */
  dbUnavailable: string | null;
}

/**
 * ON-DEMAND desync cross-check (tcp-p0x.16.5's repurposed shadow Part B):
 * snapshot the canonical mailbox for `agent` across `slugs`, then — via a
 * single genuinely-read-only SQLite open (see `openReadOnly`) — ask which of
 * those ids SQLite already has a `message_recipients` row for. Any canonical
 * id absent from that set is "SQLite lags canonical": mail the FS store
 * already has that SQLite (and therefore `check-inbox`/`fetch_inbox`) does
 * not know about yet.
 *
 * Single pass, no loop, no polling, no daemon call — a caller (doctor.ts)
 * invokes this once per run, only when explicitly asked. Never touches
 * `read_ts`/`ack_ts`: only SELECTs are issued, over a handle SQLite itself
 * rejects writes against. MUST NOT be called from the notification/watch path
 * (see module doc) — it belongs to doctor/diagnostics only.
 */
export async function checkDesync(opts: DesyncCheckOptions): Promise<DesyncCheckResult> {
  const { root, slugs, agent } = opts;
  const dbPath = opts.dbPath ?? defaultDbPath(root);
  const snap = await snapshotMailbox(root, slugs, agent);

  const opened = openReadOnly(dbPath);
  if (opened.error !== null) {
    return { checked: snap.entries.length, lagging: [], dbUnavailable: opened.error };
  }
  const { db } = opened;
  try {
    const bySlug = new Map<string, MailboxEntry[]>();
    for (const e of snap.entries) {
      const list = bySlug.get(e.project);
      if (list) list.push(e);
      else bySlug.set(e.project, [e]);
    }
    const lagging: MailboxEntry[] = [];
    for (const [slug, entries] of bySlug) {
      const { agentKnown, known } = queryKnownIds(db, slug, agent, entries.map((e) => e.id));
      for (const e of entries) {
        if (!agentKnown || !known.has(e.id)) lagging.push(e);
      }
    }
    lagging.sort((a, b) => a.id - b.id);
    return { checked: snap.entries.length, lagging, dbUnavailable: null };
  } finally {
    db.close();
  }
}

/**
 * Shadow loop until `signal` aborts. Baseline poll adopts the current canonical
 * set silently (no replay); only post-launch arrivals are emitted and tracked
 * for Part B. Returns OK on graceful shutdown. Never throws for FS conditions —
 * a missing root is a loud warning, not a crash (unlike watch's
 * first-poll-failed, the FS store legitimately may be empty at start).
 */
export async function runShadow(opts: ShadowOptions): Promise<number> {
  const { agent, root, slugs, project, primarySlug, confirm, interval, signal } = opts;
  const fsSeen = new Set<number>();
  const pending = new Map<number, Pending>();
  let baselined = false;
  let warnedMissing = false;
  let warnedSkips = false;
  let warnedDbUnavailable = false;

  const dbPath = defaultDbPath(root);

  console.log(
    `agent-mail-shadow: tailing canonical mailbox for '${agent}' across [${
      slugs.join(", ")
    }]; cross-checking SQLite ('${dbPath}') for project '${project}' (confirm=${confirm} ticks). Read-only.`,
  );

  while (!signal.aborted) {
    // (A) canonical snapshot — the source of truth.
    let snap: SnapshotResult;
    try {
      snap = await snapshotMailbox(root, slugs, agent);
    } catch (e) {
      if (signal.aborted) break;
      // snapshotMailbox is documented never-throw; treat an unexpected throw as a
      // loud degraded tick rather than killing the shadow.
      console.log(
        `agent-mail-shadow: snapshot error (transient?): ${
          e instanceof Error ? e.message : String(e)
        }. Retrying in ${interval}s.`,
      );
      await sleep(interval * 1000, signal);
      continue;
    }
    if (signal.aborted) break;

    // Unparseable .md files in the store. This is a WEAK signal, not proof of
    // corruption: the parser anchors on the `__<id>.md` tail, so a non-message
    // file (index, README) legitimately lands here. Report it factually and let
    // the human judge — do NOT cry "archive corruption" (a false alarm on a
    // healthy store is exactly the bug the smoke test caught on msg 27650).
    if (snap.skipped.length >= SKIP_WARN_THRESHOLD && !warnedSkips) {
      console.log(
        `agent-mail-shadow: ${snap.skipped.length} .md file(s) under the mailbox had no parseable <ts>__<subject>__<id> name (non-message files, or — worth a look — truncated/corrupt entries). First: ${
          snap.skipped[0]
        }`,
      );
      warnedSkips = true;
    }

    // A wholly-absent inbox set is the misconfig/empty case — warn once, keep polling.
    if (snap.entries.length === 0 && snap.missingDirs.length === slugs.length && !warnedMissing) {
      warnMissingRoot(root, slugs);
      warnedMissing = true;
    }

    if (!baselined) {
      for (const e of snap.entries) fsSeen.add(e.id);
      baselined = true;
    } else {
      for (const e of snap.entries) {
        if (fsSeen.has(e.id)) continue;
        fsSeen.add(e.id);
        console.log(mailLine(e)); // (A) FS-backed watch emit
        if (e.project === primarySlug) {
          pending.set(e.id, { entry: e, missedOkTicks: 0 }); // (B) track for divergence
        }
      }
    }

    // (B) SQLite desync cross-check — corroborate or age out the pending set.
    // Opens fresh each tick (cheap; keeps this resilient to the db file being
    // replaced/vacuumed between ticks). Genuinely read-only: SELECTs only,
    // never touching read_ts/ack_ts (see queryKnownIds/openReadOnly).
    if (pending.size > 0) {
      const opened = openReadOnly(dbPath);
      if (opened.error !== null) {
        if (!warnedDbUnavailable) {
          console.log(
            `agent-mail-shadow: SQLite store unreachable for the desync cross-check (${opened.error}). Part B disabled; still tailing canonical mail.`,
          );
          warnedDbUnavailable = true;
        }
      } else {
        try {
          const { agentKnown, known } = queryKnownIds(
            opened.db,
            primarySlug,
            agent,
            [...pending.keys()],
          );
          for (const [id, p] of pending) {
            if (agentKnown && known.has(id)) {
              pending.delete(id); // corroborated — SQLite has caught up
              continue;
            }
            p.missedOkTicks++;
            if (p.missedOkTicks >= confirm) {
              console.log(
                `DIVERGENCE #${id} [${p.entry.project}]: in canonical store, NOT yet in SQLite after ${confirm} tick(s) — ${p.entry.subject}`,
              );
              pending.delete(id);
            }
          }
        } finally {
          opened.db.close();
        }
      }
    }

    await sleep(interval * 1000, signal);
  }

  // On graceful shutdown, surface anything still unresolved — canonical messages
  // SQLite never corroborated and that never reached the confirm threshold.
  if (pending.size > 0) {
    console.log(
      `agent-mail-shadow: ${pending.size} canonical message(s) never corroborated by SQLite at shutdown (below the confirm threshold): ${
        [...pending.keys()].map((id) => `#${id}`).join(", ")
      }`,
    );
  }
  return ExitCode.OK;
}

/** Resolve the slug set: explicit CSV wins; else derive one slug from the project. */
export function resolveSlugs(explicitCsv: string | undefined, project: string): string[] {
  if (explicitCsv) {
    const list = explicitCsv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (list.length > 0) return list;
  }
  return [slugForProject(project)];
}
