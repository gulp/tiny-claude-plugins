// The watch loop — emit one stdout line per NEW Agent Mail message, read-only.
//
// tcp-p0x.16.1: promoted off `check-inbox` (SQLite, consumes on every poll) onto
// the durable git-mailbox on disk via `snapshotMailbox` (../core/mailbox.ts).
// OS file reads never mark mail read, so this backend is GENUINELY read-only —
// unlike the check-inbox path it replaces (see ../core/am.ts `pollInbox`, still
// used by the shadow prototype's cross-poll only). Single project only —
// cross-project scope (MAIL_WATCH_SCOPE=all/product) is a later bead
// (tcp-p0x.16.2); this loop tails exactly one project slug.
//
// Faithful port of the original id-watermark loop: silent baseline (adopt the
// current max id in scope, no replay) unless --since is given (replays existing
// mail with id > since once at startup), self-heal on transient FS errors.
// UNLIKE the check-inbox version, there is no "first poll failed" exit: an
// empty/missing inbox is a legitimate steady state for a fresh identity, so it
// arms cleanly (warned once) and stays live rather than failing loud.
//
// Output (stdout, one line per new message) — HUMAN, not an envelope, because
// the Monitor turns each stdout line into a notification:
//   MAIL #<id> [<project>] <ts>: <subject>

import { type MailboxEntry, snapshotMailbox, type SnapshotResult } from "../core/mailbox.ts";
import { ExitCode } from "../core/exit.ts";
import { sleep } from "../core/sleep.ts";

export interface WatchOptions {
  agent: string;
  /** Mailbox repo root (already resolved to an absolute path). */
  root: string;
  /** Project slug to watch — single project only (see module doc). */
  slug: string;
  /** Emit id > since; existing mail above `since` IS replayed once at startup.
   *  Undefined => adopt the current max silently (only post-launch mail shown). */
  since?: number;
  /** Seconds between polls, >= 1. */
  interval: number;
  signal: AbortSignal;
}

const SKIP_WARN_THRESHOLD = 1; // one skipped(unparseable) file is worth a loud line

function formatLine(e: MailboxEntry): string {
  return `MAIL #${e.id} [${e.project}] ${e.ts}: ${e.subject}`;
}

function maxId(entries: MailboxEntry[]): number {
  return entries.reduce((m, e) => Math.max(m, e.id), 0);
}

/**
 * Loop until `signal` aborts (SIGINT/SIGTERM -> graceful return 0). Never
 * throws for FS conditions: `snapshotMailbox` is documented never-throw, and a
 * missing/empty inbox is not a failure — it arms cleanly (warned once) and
 * keeps polling. Always returns ExitCode.OK on graceful shutdown.
 */
export async function runWatch(opts: WatchOptions): Promise<number> {
  const { agent, root, slug, interval, signal } = opts;
  let last: number | undefined = opts.since; // high-water; undefined until baselined
  let warnedMissing = false;
  let warnedSkips = false;

  while (!signal.aborted) {
    let snap: SnapshotResult;
    try {
      snap = await snapshotMailbox(root, [slug], agent);
    } catch (e) {
      if (signal.aborted) break;
      // snapshotMailbox is documented never-throw; treat an unexpected throw as
      // a loud degraded tick rather than killing the watch.
      console.log(
        `agent-mail-monitor: mailbox snapshot error (transient?): ${
          e instanceof Error ? e.message : String(e)
        }. Retrying in ${interval}s.`,
      );
      await sleep(interval * 1000, signal);
      continue;
    }
    if (signal.aborted) break;

    // Unparseable .md files under the mailbox are a WEAK signal, not proof of
    // corruption (a non-message file legitimately lands here) — report
    // factually, once, and let the human judge.
    if (snap.skipped.length >= SKIP_WARN_THRESHOLD && !warnedSkips) {
      console.log(
        `agent-mail-monitor: ${snap.skipped.length} .md file(s) under the mailbox had no parseable <ts>__<subject>__<id> name (non-message files, or — worth a look — truncated/corrupt entries). First: ${
          snap.skipped[0]
        }`,
      );
      warnedSkips = true;
    }

    // A wholly-absent inbox dir is the misconfig/empty case — a fresh identity
    // with no mail yet is a legitimate steady state, so warn once and keep
    // polling. This is NOT a first-poll-failed condition (no exit 4 here).
    if (snap.missingDirs.length > 0 && !warnedMissing) {
      console.log(
        `agent-mail-monitor: no mailbox inbox dir found under '${root}' for '${slug}'/'${agent}' — no mail yet, or a misconfigured root/agent/project. Staying live.`,
      );
      warnedMissing = true;
    }

    const scopeMax = maxId(snap.entries);
    if (last === undefined) {
      last = scopeMax; // baseline: adopt without replay
    } else if (scopeMax > last) {
      for (const e of snap.entries) {
        if (e.id > last) console.log(formatLine(e));
      }
      last = scopeMax;
    }

    await sleep(interval * 1000, signal);
  }

  return ExitCode.OK;
}
