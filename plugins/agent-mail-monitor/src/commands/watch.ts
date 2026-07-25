// The watch loop — emit one stdout line per NEW Agent Mail message, read-only.
//
// tcp-p0x.16.1: promoted off `check-inbox` (SQLite, consumes on every poll) onto
// the durable git-mailbox on disk via `snapshotMailbox` (../core/mailbox.ts).
// OS file reads never mark mail read, so this backend is GENUINELY read-only —
// unlike the check-inbox path it replaces. tcp-p0x.16.4 retired `pollInbox`
// (../core/am.ts) entirely: no notification path shells out to check-inbox
// anymore, including the shadow prototype's cross-check (now a direct
// read-only `node:sqlite` open — see ../commands/shadow.ts).
//
// tcp-p0x.16.2: the loop itself now tails an arbitrary SET of project slugs
// (`WatchOptions.slugs`), not exactly one — `resolveScopeSlugs` below is how a
// caller turns `MAIL_WATCH_SCOPE=project|all|product` into that set. Passing a
// single-element array reproduces T1's single-project behavior byte-for-byte
// (see watch_test.ts) — that is the load-bearing back-compat AC.
//
// Faithful port of the original id-watermark loop: silent baseline (adopt the
// current max id in scope, no replay) unless --since is given (replays existing
// mail with id > since once at startup), self-heal on transient FS errors.
// UNLIKE the check-inbox version, there is no "first poll failed" exit: an
// empty/missing inbox is a legitimate steady state for a fresh identity, so it
// arms cleanly (warned once) and stays live rather than failing loud.
//
// tcp-p0x.12 (recovery is lossless w.r.t. read-state): the transport hole that
// bug describes was a property of the RETIRED check-inbox backend — `check-inbox`
// returns UNREAD messages only, so a message arriving during a poll outage and
// then read elsewhere before recovery had already left the unread set and was
// silently dropped. This FS backend has no such hole BY CONSTRUCTION: the source
// is the on-disk `.md` file (read via `snapshot`), which persists regardless of
// read/ack state, and recovery re-reads that full set gated only by the id
// high-water mark `last`. A message that straddles an outage is therefore still
// emitted on recovery even if another session marked it read in the meantime.
// The regression test injects a throwing `snapshot` to reproduce the outage and
// asserts exactly-one emission on recovery (see watch_test.ts). (The residual
// out-of-order/backfill nuance — a LOWER id landing after a higher id was already
// watermarked — is a distinct id-ordering concern, not this read-state one.)
//
// tcp-p0x.16.3: the source-project `<slug>` tag in the line below is emitted
// in EVERY scope, including single-project "project" — not omitted there.
// This delivers the original tcp-p0x.6 AC (a notification names which
// project the mail landed in) for `all`/`product` scope, where it is load-
// bearing, and formalizes a decision the bead left open for "project": keep
// the tag for consistency (one format, not a scope-conditional one) rather
// than special-case it away — the cost is a few extra bytes per line, and it
// means a human never has to remember "this format means single-project."
// The tag was already free: `MailboxEntry.project` is stamped per-entry by
// `snapshotMailbox` (../core/mailbox.ts) regardless of scope, so this is a
// documentation/decision, not a functional change (see watch_test.ts for the
// format regex asserted across both scopes).
//
// Output (stdout, one line per new message) — HUMAN, not an envelope, because
// the Monitor turns each stdout line into a notification:
//   MAIL #<id> [<project>] <ts>: <subject>

import {
  listInboxSlugs,
  type MailboxEntry,
  type MailWatchScope,
  snapshotMailbox,
  type SnapshotResult,
} from "../core/mailbox.ts";
import { AppError, ExitCode } from "../core/exit.ts";
import { sleep } from "../core/sleep.ts";

export interface WatchOptions {
  agent: string;
  /** Mailbox repo root (already resolved to an absolute path). */
  root: string;
  /** Project slugs to watch, in scope simultaneously (>= 1; see module doc). */
  slugs: string[];
  /** Emit id > since; existing mail above `since` IS replayed once at startup.
   *  Undefined => adopt the current max silently (only post-launch mail shown). */
  since?: number;
  /** Seconds between polls, >= 1. */
  interval: number;
  signal: AbortSignal;
  /** Snapshot source, defaulting to the real `snapshotMailbox`. A seam for
   *  tcp-p0x.12: the ONLY way to reproduce a poll OUTAGE (a snapshot that throws
   *  for a tick or two, then recovers) in a test, so the recovery path can be
   *  asserted lossless. Production never passes this — it always tails the real
   *  on-disk git-mailbox. */
  snapshot?: (root: string, slugs: string[], agent: string) => Promise<SnapshotResult>;
}

export interface ScopeResolveOptions {
  scope: MailWatchScope;
  /** Mailbox repo root (already resolved to an absolute path). */
  root: string;
  agent: string;
  /** The caller's own project slug — the "project" scope target. */
  projectSlug: string;
  /** $AGENT_MAIL_PRODUCT, when scope === "product" (unused by the current stub). */
  productKey?: string;
}

/**
 * Resolve `MAIL_WATCH_SCOPE` into the slug set `runWatch` should poll:
 *   - "project": exactly `[projectSlug]` — byte-identical to T1's
 *     single-project behavior (the load-bearing back-compat AC).
 *   - "all": every `projects/<slug>` dir under `root` with an inbox for
 *     `agent` (mailbox.ts `listInboxSlugs`) — cross-project, FS-only, no
 *     `am`/SQLite involved.
 *   - "product": DEFERRED (tcp-p0x.16.2 non-goal). Resolving a product KEY to
 *     its linked project slugs from the FS layout alone is non-trivial (the
 *     link lives in `am`, not on disk) — rather than silently degrading to
 *     "project" or "all", this throws loud. Cross-project-via-product mail
 *     already has a shipped path today: the `agent-mail product` command /
 *     `$AGENT_MAIL_PRODUCT` in `monitor` (core/am.ts `productsInbox`,
 *     SQLite-backed but verified non-consuming) — use that until FS-backend
 *     product scope lands as its own follow-up.
 */
export async function resolveScopeSlugs(opts: ScopeResolveOptions): Promise<string[]> {
  const { scope, root, agent, projectSlug, productKey } = opts;
  switch (scope) {
    case "project":
      return [projectSlug];
    case "all":
      return await listInboxSlugs(root, agent);
    case "product":
      throw new AppError(
        ExitCode.USAGE,
        "MAIL_WATCH_SCOPE=product is not yet implemented for the FS watch backend " +
          "(tcp-p0x.16.2 non-goal: resolving a product key to linked project slugs " +
          "from the FS mailbox layout alone is non-trivial link discovery). " +
          "Cross-project-via-product mail already has a shipped path today: run the " +
          "'agent-mail product' command, or set $AGENT_MAIL_PRODUCT for the 'monitor' " +
          "entrypoint (uses the SQLite product bus, verified non-consuming) instead." +
          (productKey
            ? ` ($AGENT_MAIL_PRODUCT='${productKey}' was read but is unused by this scope.)`
            : " ($AGENT_MAIL_PRODUCT is also unset.)"),
      );
  }
}

const SKIP_WARN_THRESHOLD = 1; // one skipped(unparseable) file is worth a loud line

/** Formats one notification line — see the module doc's tcp-p0x.16.3 note for
 * why `[${e.project}]` (the source-project slug) is always present, in every
 * scope, not just cross-project ones. */
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
  const { agent, root, slugs, interval, signal } = opts;
  const snapshot = opts.snapshot ?? snapshotMailbox;
  let last: number | undefined = opts.since; // high-water; undefined until baselined
  let warnedMissing = false;
  let warnedSkips = false;

  while (!signal.aborted) {
    let snap: SnapshotResult;
    try {
      snap = await snapshot(root, slugs, agent);
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

    // ALL in-scope inbox dirs absent is the misconfig/empty case — a fresh
    // identity with no mail yet is a legitimate steady state, so warn once and
    // keep polling. This is NOT a first-poll-failed condition (no exit 4
    // here). A PARTIAL miss (some slugs present, some not — routine under
    // scope=all) is not warned: the present slugs are genuinely being tailed.
    // Single-slug wording is byte-identical to T1 (the back-compat AC).
    if (snap.missingDirs.length === slugs.length && !warnedMissing) {
      const slugLabel = slugs.length === 1 ? `'${slugs[0]}'` : `[${slugs.join(", ")}]`;
      console.log(
        `agent-mail-monitor: no mailbox inbox dir found under '${root}' for ${slugLabel}/'${agent}' — no mail yet, or a misconfigured root/agent/project. Staying live.`,
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
