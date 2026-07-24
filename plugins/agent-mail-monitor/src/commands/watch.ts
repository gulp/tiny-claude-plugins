// The watch loop — emit one stdout line per NEW Agent Mail message, read-only.
// Faithful port of watch-mail.sh: id high-water mark, silent baseline (no
// replay) unless --since given, first-poll-fails-loud, self-heal on transient
// mid-run failures with a single warning.
//
// Output (stdout, one line per new message) — HUMAN, not an envelope, because
// the Monitor turns each stdout line into a notification:
//   MAIL #<id> from <sender> [<importance>]: <subject>

import { type InboxMessage, pollInbox, type PollResult } from "../core/am.ts";
import { AppError, ExitCode } from "../core/exit.ts";
import { sleep } from "../core/sleep.ts";

export interface WatchOptions {
  agent: string;
  project: string;
  /** Emit id > since; existing mail above `since` IS replayed once at startup.
   *  Undefined => adopt the current max silently (only post-launch mail shown). */
  since?: number;
  /** Seconds between polls, >= 1. */
  interval: number;
  signal: AbortSignal;
}

const FAIL_WARN_THRESHOLD = 3; // consecutive transient failures before one warning

function formatLine(m: InboxMessage): string {
  return `MAIL #${m.id} from ${m.from ?? "?"} [${m.importance ?? "?"}]: ${
    m.subject ?? "(no subject)"
  }`;
}

/**
 * Loop until `signal` aborts (SIGINT/SIGTERM -> graceful return 0). Throws
 * AppError(FIRST_POLL_FAILED) if the very first poll fails; self-heals after.
 */
export async function runWatch(opts: WatchOptions): Promise<number> {
  const { agent, project, interval, signal } = opts;
  let last: number | undefined = opts.since; // high-water; undefined until first ok poll
  let started = false;
  let consecutiveFail = 0;
  let warned = false;

  while (!signal.aborted) {
    let poll: PollResult;
    try {
      poll = await pollInbox(agent, project, signal);
    } catch (e) {
      if (signal.aborted) break; // child killed by our own shutdown — graceful
      throw e;
    }
    if (signal.aborted) break;

    if (poll.ok) {
      if (warned) {
        console.log("agent-mail-monitor: check-inbox recovered — resuming normal watch.");
        warned = false;
      }
      consecutiveFail = 0;
      started = true;
      if (last === undefined) {
        last = poll.maxId; // baseline: adopt without replay
      } else if (poll.maxId > last) {
        for (const m of poll.messages) {
          if (m.id > last) console.log(formatLine(m));
        }
        last = poll.maxId;
      }
    } else {
      consecutiveFail++;
      if (!started) {
        // First poll failed → almost certainly misconfiguration. Fail loud.
        console.log(
          `agent-mail-monitor: initial check-inbox poll FAILED for agent '${agent}' @ '${project}' — NOT watching. Cause: ${
            poll.error ?? "unknown (server down, wrong --agent, or auth)."
          }`,
        );
        console.log(
          "agent-mail-monitor: verify the server is up ('am status') and --agent is correct; the agent-mail-monitor:doctor skill diagnoses this.",
        );
        throw new AppError(ExitCode.FIRST_POLL_FAILED, "initial check-inbox poll failed");
      } else if (!warned && consecutiveFail >= FAIL_WARN_THRESHOLD) {
        // Mid-run outage → warn ONCE (avoid notification spam), keep retrying.
        console.log(
          `agent-mail-monitor: check-inbox has failed ${consecutiveFail}x (transient?). Cause: ${
            poll.error ?? "unknown"
          }. Still retrying every ${interval}s.`,
        );
        warned = true;
      }
    }

    await sleep(interval * 1000, signal);
  }

  return ExitCode.OK;
}
