// The shadow tail — a PROTOTYPE that pits the durable git-mailbox (canonical,
// SQLite-independent) against `check-inbox` (the SQLite read path) to answer one
// question: does the filesystem store surface mail that check-inbox drops?
//
// It plays two roles at once, per poll:
//   (A) FS-backed watch — emit `MAIL #<id> [<proj>] ...` for each NEW canonical
//       message (silent baseline adopt, no replay). This is the candidate
//       REPLACEMENT behavior for the watch loop.
//   (B) Divergence detector — every new canonical message in the primary project
//       enters a pending set; each SUCCESSFUL check-inbox poll whose unread set
//       contains the id confirms it (healthy → dropped). A message the canonical
//       store showed but check-inbox never corroborates within `confirm` ok-polls
//       is emitted as `DIVERGENCE #<id> ...` — the win signal.
//
// Read the outcome as the bet's win/kill criteria:
//   * A DIVERGENCE line  => the FS store caught something SQLite didn't. Bet won:
//     the canonical store is the right poll backend (desync msg 27651 / transport
//     hole are dissolved at the source).
//   * mailbox-root missing / many skipped(corrupt) files => the interim coupling's
//     failure mode (archive corruption) bit. Bet killed; do not couple the plugin.
//   * No divergence over the window + FS keeps pace with check-inbox => the stores
//     agree here; weaker, keep the shadow armed longer.
//
// Honest label: DIVERGENCE means "canonical-only — check-inbox never showed it as
// unread within N polls." That is exactly the completeness gap we care about, but
// it can also fire for a message legitimately read elsewhere before the first
// corroborating poll. The line reports what was OBSERVED, not a root cause.
//
// The FS snapshot is genuinely read-only (OS file reads never mark mail read).
// The check-inbox cross-poll (pollInbox), however, DOES consume: `am check-inbox`
// without `--direct` routes through the daemon's fetch_inbox and marks returned
// messages read (verified against am v0.3.21). That is acceptable here ONLY
// because this is the divergence experiment — and it in fact sharpens the finding:
// the poll marking mail read is itself part of why the SQLite read-state the watch
// used to trust is unreliable. Do NOT reuse this cross-poll in the production
// watch; the canonical FS tail (part A) is the non-consuming backend.

import { pollInbox, type PollResult } from "../core/am.ts";
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
  /** Primary project key for the check-inbox cross-poll (divergence is scoped here). */
  project: string;
  /** Slug of `project` — the one FS project whose divergence we track. */
  primarySlug: string;
  /** Successful check-inbox polls a pending id may miss before it's DIVERGENCE. */
  confirm: number;
  /** Seconds between polls, >= 1. */
  interval: number;
  signal: AbortSignal;
}

/** A canonical message awaiting corroboration from check-inbox's unread set. */
interface Pending {
  entry: MailboxEntry;
  /** Count of SUCCESSFUL check-inbox polls that did not contain this id. */
  missedOkPolls: number;
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

/**
 * Shadow loop until `signal` aborts. Baseline poll adopts the current canonical
 * set silently (no replay); only post-launch arrivals are emitted and tracked.
 * Returns OK on graceful shutdown. Never throws for FS conditions — a missing
 * root is a loud warning, not a crash (unlike watch's first-poll-failed, the FS
 * store legitimately may be empty at start).
 */
export async function runShadow(opts: ShadowOptions): Promise<number> {
  const { agent, root, slugs, project, primarySlug, confirm, interval, signal } = opts;
  const fsSeen = new Set<number>();
  const pending = new Map<number, Pending>();
  let baselined = false;
  let warnedMissing = false;
  let warnedSkips = false;

  console.log(
    `agent-mail-shadow: tailing canonical mailbox for '${agent}' across [${
      slugs.join(", ")
    }]; cross-checking check-inbox on '${project}' (confirm=${confirm} polls). Read-only.`,
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
          pending.set(e.id, { entry: e, missedOkPolls: 0 }); // (B) track for divergence
        }
      }
    }

    // (B) check-inbox cross-poll — corroborate or age out the pending set.
    if (pending.size > 0) {
      let poll: PollResult;
      try {
        poll = await pollInbox(agent, project, signal);
      } catch (e) {
        if (signal.aborted) break;
        throw e;
      }
      if (signal.aborted) break;

      if (poll.ok) {
        const unread = new Set(poll.messages.map((m) => m.id));
        for (const [id, p] of pending) {
          if (unread.has(id)) {
            pending.delete(id); // corroborated — the stores agree on this one
            continue;
          }
          p.missedOkPolls++;
          if (p.missedOkPolls >= confirm) {
            console.log(
              `DIVERGENCE #${id} [${p.entry.project}]: in canonical store, NOT surfaced by check-inbox after ${confirm} ok poll(s) — ${p.entry.subject}`,
            );
            pending.delete(id);
          }
        }
      }
      // A failed check-inbox poll does NOT count against pending ids: an outage is
      // not corroboration OR refutation. The message stays pending; if check-inbox
      // never recovers to show it, it ages out on later ok-polls (the transport
      // hole) — or, if it never recovers at all, on shutdown it simply stays
      // unresolved (reported below), which is itself the "SQLite blind" story.
    }

    await sleep(interval * 1000, signal);
  }

  // On graceful shutdown, surface anything still unresolved — canonical messages
  // check-inbox never corroborated and that never reached the confirm threshold.
  if (pending.size > 0) {
    console.log(
      `agent-mail-shadow: ${pending.size} canonical message(s) never corroborated by check-inbox at shutdown (below the confirm threshold): ${
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
