// doctor — read-only preflight. Proves the runtime can watch mail: deno + am
// present, an identity set, the git-mailbox layout parses (tcp-p0x.16.5), and
// (when AGENT_MAIL_PRODUCT is set) that the identity is registered in EVERY
// project linked into the product bus. All checks are read-only; every `am`
// call is timeout-bounded so a hanging `am` (observed: `am products status
// <bad-key>` hangs) can't wedge the diagnostic.

import { agentsInProject, amPresent, productStatusProjects } from "../core/am.ts";
import type { AgentSummary } from "../core/am.ts";
import { defaultMailboxRoot, slugForProject } from "../core/mailbox.ts";
import { checkDesync } from "./shadow.ts";
import { err, ok, printEnvelope } from "../core/envelope.ts";
import { ExitCode } from "../core/exit.ts";

export interface DoctorOptions {
  json: boolean;
}

interface Check {
  ok: boolean;
  detail: string;
}

// Per-`am`-call ceiling for the product gap check. Bounds a hanging `am` so
// doctor always terminates; each linked project gets its own budget.
const AM_TIMEOUT_MS = 5000;

/** Human-readable "name (model, last active TS)" — degrades gracefully when
 *  `am` didn't report model/last-active for a row. */
function describeAgent(a: AgentSummary): string {
  return `${a.name} (${a.model ?? "model unknown"}, last active ${a.lastActiveTs ?? "unknown"})`;
}

/**
 * When AGENT_NAME is unset, list identities already registered in THIS
 * project so the user/agent can REUSE one instead of minting a new one —
 * minting fresh mints a new EMPTY mailbox and orphans any reservations the
 * old identity held (tcp-p0x.4). Read-only: never registers or picks on the
 * caller's behalf, just surfaces the candidates. Stays a warning, never a
 * doctor failure — `decide()` already treats an unset identity as non-fatal;
 * this only enriches that warning's detail. No-op signal (returns null) when
 * an identity is already set.
 */
async function identityPickHint(
  agent: string | undefined,
  projectKey: string,
): Promise<{ detail: string; candidates: AgentSummary[] } | null> {
  if (agent) return null;

  const result = await agentsInProject(projectKey, AbortSignal.timeout(AM_TIMEOUT_MS));
  if (!result.ok) {
    return {
      detail:
        `AGENT_NAME unset — could not list existing identities in this project (${result.error})`,
      candidates: [],
    };
  }
  if (result.agents.length === 0) {
    return {
      detail:
        "AGENT_NAME unset — no identities registered yet in this project; mint a new adjective+noun",
      candidates: [],
    };
  }
  return {
    detail: `AGENT_NAME unset — reuse one of these, or mint a new adjective+noun: ${
      result.agents.map(describeAgent).join("; ")
    }`,
    candidates: result.agents,
  };
}

/**
 * When AGENT_MAIL_PRODUCT is set, verify `agent` is registered in every linked
 * project. Returns a Check plus the machine-readable detail the envelope needs.
 * No-op signal (returns null) when product mode is off.
 */
async function productRegistrationCheck(
  agent: string | undefined,
): Promise<{ check: Check; missing: string[]; unverifiable: string[] } | null> {
  const productKey = Deno.env.get("AGENT_MAIL_PRODUCT");
  if (!productKey) return null; // single-project mode — nothing to check

  if (!agent) {
    return {
      check: { ok: false, detail: "AGENT_NAME unset — cannot check product registration" },
      missing: [],
      unverifiable: [],
    };
  }

  const status = await productStatusProjects(productKey, AbortSignal.timeout(AM_TIMEOUT_MS));
  if (!status.ok) {
    return {
      check: {
        ok: false,
        detail: `could not read linked projects for product '${productKey}': ${status.error}`,
      },
      missing: [],
      unverifiable: [],
    };
  }
  if (status.projects.length === 0) {
    return {
      check: { ok: true, detail: `product '${productKey}' has no linked projects` },
      missing: [],
      unverifiable: [],
    };
  }

  const missing: string[] = [];
  const unverifiable: string[] = [];
  for (const p of status.projects) {
    const agents = await agentsInProject(p.key, AbortSignal.timeout(AM_TIMEOUT_MS));
    if (!agents.ok) {
      unverifiable.push(`${p.label} (${agents.error})`);
      continue;
    }
    if (!agents.names.includes(agent)) missing.push(p.label);
  }

  if (missing.length > 0) {
    const tail = unverifiable.length > 0 ? `; unverifiable: ${unverifiable.join(", ")}` : "";
    return {
      check: {
        ok: false,
        detail: `identity '${agent}' NOT registered in: ${missing.join(", ")}${tail}`,
      },
      missing,
      unverifiable,
    };
  }
  if (unverifiable.length > 0) {
    return {
      check: {
        ok: false,
        detail: `could not verify registration in: ${unverifiable.join(", ")}`,
      },
      missing,
      unverifiable,
    };
  }
  return {
    check: {
      ok: true,
      detail: `identity '${agent}' registered in all ${status.projects.length} linked project(s)`,
    },
    missing,
    unverifiable,
  };
}

/**
 * Resolve the mailbox root, then verify the git-mailbox layout PARSES (root
 * exists as a directory; its `projects/` subdirectory exists as a directory).
 * This guards am's PRIVATE on-disk contract (../core/mailbox.ts's module doc):
 * if that layout ever shifts shape, the FS watch backend silently sees no
 * mail — a structural check turns that into a loud, diagnosable doctor
 * failure instead of silence. Deliberately NOT sensitive to a merely-empty
 * inbox for THIS identity/project (see mailbox.ts `snapshotMailbox`'s
 * `missingDirs`) — a fresh identity with no mail yet is a legitimate steady
 * state, not a layout break; this check only guards the shape of the store.
 */
async function mailboxLayoutCheck(root: string): Promise<Check> {
  let rootStat: Deno.FileInfo;
  try {
    rootStat = await Deno.stat(root);
  } catch (e) {
    return {
      ok: false,
      detail: `mailbox root '${root}' does not exist or is unreadable (${
        e instanceof Error ? e.message : String(e)
      }) — set AGENT_MAIL_MAILBOX_ROOT, or am's git-mailbox has not been initialized here`,
    };
  }
  if (!rootStat.isDirectory) {
    return { ok: false, detail: `mailbox root '${root}' exists but is not a directory` };
  }

  const projectsDir = `${root}/projects`;
  let projectsStat: Deno.FileInfo;
  try {
    projectsStat = await Deno.stat(projectsDir);
  } catch (e) {
    return {
      ok: false,
      detail: `mailbox root '${root}' has no 'projects/' subdirectory (${
        e instanceof Error ? e.message : String(e)
      }) — am's on-disk layout looks different than expected (private layout shift?)`,
    };
  }
  if (!projectsStat.isDirectory) {
    return {
      ok: false,
      detail:
        `'${projectsDir}' exists but is not a directory — am's on-disk layout looks different than expected (private layout shift?)`,
    };
  }

  return { ok: true, detail: `root '${root}' parses ('projects/' present)` };
}

/**
 * When AGENT_MAIL_DESYNC_CHECK is set (any non-empty value), run the
 * ON-DEMAND desync cross-check (tcp-p0x.16.5's repurposed shadow Part B —
 * see ../commands/shadow.ts `checkDesync`): does SQLite already have a
 * `message_recipients` row for every canonical message this identity has
 * received in its own project? A single genuinely-read-only SQLite open —
 * SELECTs only, never touches `read_ts`/`ack_ts`, never marks anything read
 * (see shadow.ts `openReadOnly`'s doc for how that is enforced). OFF by
 * default: this is a diagnostic, on-demand check, and must NEVER be wired
 * into the watch/monitor notification path — running doctor is always an
 * explicit, human/agent-initiated act. No-op signal (returns null) when unset.
 */
async function desyncCheck(
  agent: string | undefined,
  root: string,
): Promise<{ check: Check; lagging: number[] } | null> {
  if (!Deno.env.get("AGENT_MAIL_DESYNC_CHECK")) return null;

  if (!agent) {
    return {
      check: { ok: false, detail: "AGENT_NAME unset — cannot run the desync cross-check" },
      lagging: [],
    };
  }

  const projectSlug = slugForProject(Deno.env.get("CLAUDE_PROJECT_DIR") ?? Deno.cwd());
  const result = await checkDesync({ root, slugs: [projectSlug], agent });

  if (result.dbUnavailable !== null) {
    return {
      check: {
        ok: false,
        detail:
          `could not open the SQLite store for the desync cross-check: ${result.dbUnavailable}`,
      },
      lagging: [],
    };
  }
  if (result.lagging.length > 0) {
    return {
      check: {
        ok: false,
        detail:
          `SQLite lags canonical: ${result.lagging.length} of ${result.checked} message(s) not yet in SQLite (e.g. #${
            result.lagging[0].id
          })`,
      },
      lagging: result.lagging.map((e) => e.id),
    };
  }
  return {
    check: {
      ok: true,
      detail: `SQLite matches canonical (${result.checked} message(s) checked)`,
    },
    lagging: [],
  };
}

type Decision = { code: number; name: string | null; message: string };

/**
 * Exit code + named failure = the WORST failing check, in priority order:
 * am missing (nothing works) > mailbox layout broken (the watch backend can
 * never see mail regardless of am) > a product registration gap (only
 * affects product-scope watching) > a detected/unverifiable desync (opt-in
 * diagnostic). An unset identity stays a warning here (the watch loop handles
 * it loudly at run time), so it does NOT fail doctor on its own.
 */
function decide(
  checks: Record<string, Check>,
  agent: string | undefined,
  product: { check: Check; missing: string[]; unverifiable: string[] } | null,
  desync: { check: Check; lagging: number[] } | null,
): Decision {
  if (!checks.am.ok) {
    return {
      code: ExitCode.AM_MISSING,
      name: "am_missing",
      message: "the 'am' CLI is not on PATH",
    };
  }
  if (!checks.mailbox.ok) {
    return {
      code: ExitCode.SERVER_UNREACHABLE,
      name: "mailbox_layout_broken",
      message:
        "the git-mailbox layout does not parse (see data.checks.mailbox) — am's private on-disk contract may have shifted",
    };
  }
  if (agent && product && !product.check.ok) {
    return {
      code: ExitCode.FIRST_POLL_FAILED,
      name: "product_registration_gap",
      message: "identity not registered in every linked project (see data.product.missing)",
    };
  }
  if (desync && !desync.check.ok) {
    return {
      code: ExitCode.SERVER_UNREACHABLE,
      name: "desync_detected",
      message:
        "SQLite lags the canonical git-mailbox (see data.desync.lagging), or the SQLite store could not be read (see data.checks.desync)",
    };
  }
  return { code: ExitCode.OK, name: null, message: "" };
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const agent = Deno.env.get("AGENT_NAME");
  const root = defaultMailboxRoot();
  // "This project", for both the identity-pick hint below and desyncCheck's
  // internal slug resolution — same precedence (CLAUDE_PROJECT_DIR, else cwd).
  const projectKey = Deno.env.get("CLAUDE_PROJECT_DIR") ?? Deno.cwd();
  const checks: Record<string, Check> = {
    deno: { ok: true, detail: Deno.version.deno },
    am: { ok: await amPresent(), detail: "am on PATH" },
    identity: { ok: !!agent, detail: agent ?? "(unset)" },
    mailbox: await mailboxLayoutCheck(root),
  };

  const identityPick = await identityPickHint(agent, projectKey);
  if (identityPick) checks.identity = { ok: false, detail: identityPick.detail };

  const product = await productRegistrationCheck(agent);
  if (product) checks.product = product.check;

  const desync = await desyncCheck(agent, root);
  if (desync) checks.desync = desync.check;

  const decision = decide(checks, agent, product, desync);
  const code = decision.code;

  if (opts.json) {
    const data = {
      checks,
      ...(identityPick ? { identityCandidates: identityPick.candidates } : {}),
      ...(product
        ? { product: { missing: product.missing, unverifiable: product.unverifiable } }
        : {}),
      ...(desync ? { desync: { lagging: desync.lagging } } : {}),
    };
    printEnvelope(
      code === ExitCode.OK
        ? ok("doctor", data)
        : err("doctor", code, decision.name!, decision.message, data),
    );
  } else {
    console.log("doctor — agent-mail");
    for (const [name, c] of Object.entries(checks)) {
      console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${name} — ${c.detail}`);
    }
  }
  return code;
}
