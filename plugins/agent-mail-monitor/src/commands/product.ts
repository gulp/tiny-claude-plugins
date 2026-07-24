// Product (multi-project) watch loop — emit one stdout line per NEW message for
// an agent across every project linked into a product bus. Read-only.
//
// Differs from the single-project watch loop (watch.ts) in exactly two ways:
//   - watermark is the ISO `created_ts` of the newest message, not a numeric id
//     (ids aren't comparable across projects);
//   - each line is LABELLED with the origin project (project_id -> slug map).
// Everything else — silent baseline (no replay), first-poll-fails-loud, self-heal
// with a single warn — mirrors watch.ts so the two behave identically to a user.
//
// Output (stdout, one HUMAN line per new message — the Monitor turns each into a
// notification):
//   MAIL [<project>] #<id> from <sender> [<importance>]: <subject>

import {
  listProjects,
  type ProductMessage,
  type ProductPollResult,
  productsInbox,
} from "../core/am.ts";
import { AppError, ExitCode } from "../core/exit.ts";
import { sleep } from "../core/sleep.ts";

export interface ProductWatchOptions {
  productKey: string;
  agent: string;
  /** Seconds between polls, >= 1. */
  interval: number;
  /** Page size; a full page triggers a no-silent-cap warning. Default 200. */
  limit?: number;
  signal: AbortSignal;
}

const FAIL_WARN_THRESHOLD = 3; // consecutive transient failures before one warning
const DEFAULT_LIMIT = 200;

function formatLine(m: ProductMessage, label: string): string {
  return `MAIL [${label}] #${m.id} from ${m.from ?? "?"} [${m.importance ?? "?"}]: ${
    m.subject ?? "(no subject)"
  }`;
}

/**
 * Loop until `signal` aborts (SIGINT/SIGTERM -> graceful return 0). Throws
 * AppError(FIRST_POLL_FAILED) if the very first poll fails; self-heals after.
 */
export async function runProductWatch(opts: ProductWatchOptions): Promise<number> {
  const { productKey, agent, interval, signal } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // project_id -> label. Best-effort: a failed/empty map degrades to "?" labels,
  // it never takes the watch down. Refreshed lazily when an id is unknown.
  let projects = (await listProjects(signal)).map;
  const labelFor = async (m: ProductMessage): Promise<string> => {
    if (m.project_id == null) return m.project_slug ?? "?";
    if (!projects.has(m.project_id)) {
      const refreshed = await listProjects(signal); // a new project may have linked mid-run
      if (refreshed.ok) projects = refreshed.map;
    }
    return projects.get(m.project_id) ?? m.project_slug ?? String(m.project_id);
  };

  let lastTs: string | undefined; // high-water created_ts; undefined until first ok poll
  let started = false;
  let consecutiveFail = 0;
  let warned = false;

  while (!signal.aborted) {
    let poll: ProductPollResult;
    try {
      poll = await productsInbox(productKey, agent, lastTs, limit, signal);
    } catch (e) {
      if (signal.aborted) break; // child killed by our own shutdown — graceful
      throw e;
    }
    if (signal.aborted) break;

    if (poll.ok) {
      if (warned) {
        console.log("agent-mail-monitor: products inbox recovered — resuming normal watch.");
        warned = false;
      }
      consecutiveFail = 0;

      if (poll.fullPage) {
        // Never hide a truncated page: a full page means messages beyond `limit`
        // this poll were NOT returned. Surfacing it beats a silent gap.
        console.log(
          `agent-mail-monitor: products inbox returned a full page (${poll.messages.length} >= limit ${limit}) — older messages beyond this page were not fetched this poll.`,
        );
      }

      if (!started) {
        started = true;
        lastTs = poll.newestTs; // baseline: adopt frontier without replay
      } else {
        // am returns newest-first; emit oldest-first so notifications read in order.
        // Guard by created_ts even though --since-ts already filtered server-side.
        const fresh = poll.messages.filter((m) => lastTs === undefined || m.created_ts > lastTs);
        for (const m of [...fresh].reverse()) {
          console.log(formatLine(m, await labelFor(m)));
        }
        if (poll.newestTs && (lastTs === undefined || poll.newestTs > lastTs)) {
          lastTs = poll.newestTs;
        }
      }
    } else {
      consecutiveFail++;
      if (!started) {
        console.log(
          `agent-mail-monitor: initial products-inbox poll FAILED for agent '${agent}' @ product '${productKey}' — NOT watching. Cause: ${
            poll.error ?? "unknown (server down, wrong product/agent, or auth)."
          }`,
        );
        console.log(
          "agent-mail-monitor: verify the product exists ('am products status <key>') and the identity is registered in every linked project; the agent-mail-monitor:doctor skill diagnoses this.",
        );
        throw new AppError(ExitCode.FIRST_POLL_FAILED, "initial products-inbox poll failed");
      } else if (!warned && consecutiveFail >= FAIL_WARN_THRESHOLD) {
        console.log(
          `agent-mail-monitor: products inbox has failed ${consecutiveFail}x (transient?). Cause: ${
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
