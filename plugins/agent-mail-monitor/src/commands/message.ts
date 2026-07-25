// `agent-mail message <id>` — resolve a globally-unique Agent Mail message id
// across projects in ONE command, read-only (tcp-p0x.1).
//
// The friction this removes: `am robot message <id>` is project-scoped (falls
// back to CWD, 404s against the wrong project), and `am robot overview` is
// cross-project but returns only per-project counts, never a message. So mapping
// a bare id to its message means guessing the project. This command wraps a
// bounded fan-out: enumerate candidate projects (all, or — with --product /
// $AGENT_MAIL_PRODUCT — only the product-linked ones), then probe each with
// `am robot message <id> --project <p>` until one resolves. Ids are globally
// unique, so at most one project matches; we short-circuit on the first hit.
//
// Two output surfaces (as elsewhere): a human block by default, or — under
// --json — the standard versioned envelope. Genuinely read-only: `am robot
// message` is a view, it never marks the message read.

import { err, ok, printEnvelope } from "../core/envelope.ts";
import { ExitCode } from "../core/exit.ts";
import {
  type LinkedProject,
  type MessageProbe,
  productStatusProjects,
  robotMessage,
  robotProjects,
} from "../core/am.ts";

/** Upper bound on how many projects a single lookup will probe. Well above any
 *  real deployment's project count; a larger set is truncated with a loud note
 *  rather than silently searched-partially-as-if-fully (a silent-failure guard). */
const MAX_FANOUT = 500;

/** Per-`am`-call ceiling. Bounds a hanging `am` (observed, and guarded the same
 *  way in doctor: `am products status <bad-key>` hangs rather than erroring) so a
 *  one-shot lookup always terminates. Applied FRESH per call, so one slow project
 *  can't consume the budget of the rest. */
const AM_TIMEOUT_MS = 8000;

const CMD = "message";

/** A per-call signal: the caller's cancellation (SIGINT/SIGTERM) OR a fresh
 *  timeout, whichever fires first. Without this a bad `--product` key wedges the
 *  whole command forever (the exact footgun doctor bounds). */
function boundedSignal(base?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AM_TIMEOUT_MS);
  return base ? AbortSignal.any([base, timeout]) : timeout;
}

/** Seams so the resolver is testable without a real `am` on PATH. */
export interface MessageDeps {
  listAllProjects: (
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; projects: LinkedProject[]; error?: string }>;
  listProductProjects: (
    productKey: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; projects: LinkedProject[]; error?: string }>;
  probe: (id: string, projectKey: string, signal?: AbortSignal) => Promise<MessageProbe>;
}

// The real, am-backed deps. Each wraps its `am` call in a fresh per-call timeout
// so no single project (a hanging `products status`, a wedged probe) can stall
// the command. Tests inject fakes and never reach these — so no timer is created
// under `deno test` (which would trip the leak sanitizer).
const defaultDeps: MessageDeps = {
  listAllProjects: (signal) => robotProjects(boundedSignal(signal)),
  listProductProjects: (key, signal) => productStatusProjects(key, boundedSignal(signal)),
  probe: (id, key, signal) => robotMessage(id, key, boundedSignal(signal)),
};

export interface MessageOptions {
  id: string;
  /** Scope the search to product-linked projects instead of every project. */
  product?: string;
  json: boolean;
  signal?: AbortSignal;
  /** Test seam; production omits it (defaults to the am-backed deps). */
  deps?: Partial<MessageDeps>;
}

export interface ResolveResult {
  hit?: { projectKey: string; label: string; message: unknown };
  /** Projects actually probed (short-circuits, so ≤ candidates). */
  probed: number;
  /** Projects that could not be queried at all — collapsed for one diagnostic,
   *  never dropped (a miss must not hide "we couldn't look"). */
  errored: string[];
}

/**
 * Probe candidates in order, short-circuiting on the first hit. Pure over the
 * injected `probe` — no `am`, no I/O of its own — so it is directly unit-testable.
 * An `absent` outcome keeps looking; an `error` outcome is recorded (not fatal)
 * so the caller can tell a clean "not found" from "some projects were unreachable".
 */
export async function resolveMessage(
  id: string,
  candidates: LinkedProject[],
  probe: MessageDeps["probe"],
  signal?: AbortSignal,
): Promise<ResolveResult> {
  const errored: string[] = [];
  let probed = 0;
  for (const c of candidates) {
    if (signal?.aborted) break;
    probed++;
    const outcome = await probe(id, c.key, signal);
    if (outcome.kind === "hit") {
      return {
        hit: { projectKey: c.key, label: c.label, message: outcome.message },
        probed,
        errored,
      };
    }
    if (outcome.kind === "error") errored.push(`${c.label}: ${outcome.error}`);
    // "absent" — a clean 404 in this project; keep looking.
  }
  return { probed, errored };
}

function printMessageHuman(id: string, hit: NonNullable<ResolveResult["hit"]>): void {
  const m = (hit.message ?? {}) as Record<string, unknown>;
  const line = (k: string, v: unknown) => {
    if (v != null && v !== "") console.log(`  ${k}: ${v}`);
  };
  console.log(`message #${id}  [project: ${hit.label}]`);
  line("from", m.from);
  line("subject", m.subject);
  line("created", m.created);
  line("importance", m.importance);
  if (m.position != null && m.total_in_thread != null) {
    line("thread", `${m.position}/${m.total_in_thread}`);
  }
  const body = typeof m.body === "string" ? m.body : undefined;
  if (body) {
    console.log("  ---");
    console.log(body.split("\n").map((l) => `  ${l}`).join("\n"));
  }
}

/**
 * Orchestrate the lookup and emit the result. Exit-code contract:
 *   OK                 — resolved; message emitted.
 *   USAGE              — id is not a positive integer.
 *   SERVER_UNREACHABLE — could not enumerate projects, OR every probe failed
 *                        (a server/query error, NOT a clean "not found").
 *   NOT_FOUND          — enumerated and probed cleanly; the id exists nowhere.
 */
export async function runMessage(opts: MessageOptions): Promise<number> {
  const deps = { ...defaultDeps, ...opts.deps };

  if (!/^\d+$/.test(opts.id)) {
    const msg = `message id must be a positive integer, got '${opts.id}'`;
    if (opts.json) printEnvelope(err(CMD, ExitCode.USAGE, "USAGE", msg));
    else console.error(`agent-mail: ${msg}`);
    return ExitCode.USAGE;
  }

  const list = opts.product
    ? await deps.listProductProjects(opts.product, opts.signal)
    : await deps.listAllProjects(opts.signal);
  if (!list.ok) {
    const msg = opts.product
      ? `could not list projects for product '${opts.product}': ${list.error}`
      : `could not list projects: ${list.error}`;
    if (opts.json) printEnvelope(err(CMD, ExitCode.SERVER_UNREACHABLE, "SERVER_UNREACHABLE", msg));
    else console.error(`agent-mail: ${msg}`);
    return ExitCode.SERVER_UNREACHABLE;
  }

  let candidates = list.projects;
  let skipped = 0;
  if (candidates.length > MAX_FANOUT) {
    skipped = candidates.length - MAX_FANOUT;
    candidates = candidates.slice(0, MAX_FANOUT);
    console.error(
      `agent-mail: message: bounding fan-out to ${MAX_FANOUT} project(s); ${skipped} not searched.`,
    );
  }

  const result = await resolveMessage(opts.id, candidates, deps.probe, opts.signal);

  if (result.hit) {
    if (opts.json) {
      printEnvelope(
        ok(CMD, { project: result.hit.projectKey, message: result.hit.message }, {
          probed: result.probed,
        }),
      );
    } else {
      printMessageHuman(opts.id, result.hit);
    }
    return ExitCode.OK;
  }

  // Every probe errored (and none was a clean 404) → we could not actually look.
  // Reporting "not found" here would be a silent false negative; be honest.
  if (result.probed > 0 && result.errored.length === result.probed) {
    const msg =
      `message #${opts.id} could not be resolved: all ${result.probed} project probe(s) failed ` +
      `(server/query error, not a clean 'not found'). First: ${result.errored[0]}`;
    if (opts.json) {
      printEnvelope(
        err(CMD, ExitCode.SERVER_UNREACHABLE, "SERVER_UNREACHABLE", msg, {
          probed: result.probed,
          errored: result.errored,
        }),
      );
    } else console.error(`agent-mail: ${msg}`);
    return ExitCode.SERVER_UNREACHABLE;
  }

  // Clean miss — ONE diagnostic (not N stacked errors). Disclose everything that
  // narrows the search so the "no" is honest, never a silent false negative:
  //  - the product scope, when set (via --product or $AGENT_MAIL_PRODUCT): the
  //    search covered only that bus, so the id may still exist in an unlinked
  //    project. Without this note a user who set $AGENT_MAIL_PRODUCT for watching
  //    would read a scoped miss as a global one.
  //  - projects that could not be queried, and any dropped past the fan-out cap.
  const scopeNote = opts.product ? ` linked to product '${opts.product}'` : "";
  const erroredNote = result.errored.length
    ? ` (${result.errored.length} project(s) could not be queried)`
    : "";
  const skipNote = skipped ? ` (${skipped} beyond the fan-out cap were not searched)` : "";
  const msg = result.probed === 0
    ? `message #${opts.id} not found: no projects${scopeNote} were available to search`
    : `message #${opts.id} not found in any of ${result.probed} project(s)${scopeNote}${erroredNote}${skipNote}`;
  if (opts.json) {
    printEnvelope(
      err(CMD, ExitCode.NOT_FOUND, "NOT_FOUND", msg, {
        probed: result.probed,
        errored: result.errored,
        skipped,
      }),
    );
  } else console.error(`agent-mail: ${msg}`);
  return ExitCode.NOT_FOUND;
}
