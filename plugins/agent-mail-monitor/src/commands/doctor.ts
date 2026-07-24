// doctor — read-only preflight. Proves the runtime can watch mail: deno + am
// present, an identity set, and (when AGENT_MAIL_PRODUCT is set) that the
// identity is registered in EVERY project linked into the product bus. All
// checks are read-only; every `am` call is timeout-bounded so a hanging `am`
// (observed: `am products status <bad-key>` hangs) can't wedge the diagnostic.

import { agentsInProject, amPresent, productStatusProjects } from "../core/am.ts";
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

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const agent = Deno.env.get("AGENT_NAME");
  const checks: Record<string, Check> = {
    deno: { ok: true, detail: Deno.version.deno },
    am: { ok: await amPresent(), detail: "am on PATH" },
    identity: { ok: !!agent, detail: agent ?? "(unset)" },
  };

  const product = await productRegistrationCheck(agent);
  if (product) checks.product = product.check;

  // Exit code = the worst failing check. am-missing is the hard env failure; a
  // product registration gap predicts the product watch's first poll will fail,
  // so it maps to FIRST_POLL_FAILED. An unset identity stays a warning (the
  // watch loop handles it loudly at run time), so it does NOT fail doctor here.
  let code: number = ExitCode.OK;
  if (!checks.am.ok) code = ExitCode.AM_MISSING;
  else if (agent && product && !product.check.ok) code = ExitCode.FIRST_POLL_FAILED;

  if (opts.json) {
    const data = {
      checks,
      ...(product
        ? { product: { missing: product.missing, unverifiable: product.unverifiable } }
        : {}),
    };
    printEnvelope(
      code === ExitCode.OK ? ok("doctor", data) : err(
        "doctor",
        code,
        code === ExitCode.AM_MISSING ? "am_missing" : "product_registration_gap",
        code === ExitCode.AM_MISSING
          ? "the 'am' CLI is not on PATH"
          : "identity not registered in every linked project (see data.product.missing)",
        data,
      ),
    );
  } else {
    console.log("doctor — agent-mail");
    for (const [name, c] of Object.entries(checks)) {
      console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${name} — ${c.detail}`);
    }
  }
  return code;
}
