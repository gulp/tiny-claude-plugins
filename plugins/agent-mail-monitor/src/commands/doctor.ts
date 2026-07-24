// doctor — minimal read-only preflight (the FULL check set + capabilities/schema
// introspection lands in tcp-6yk.3). For the scaffold it proves the envelope
// plumbing end-to-end: deno present, am present, identity set. Read-only.

import { amPresent } from "../core/am.ts";
import { err, ok, printEnvelope } from "../core/envelope.ts";
import { ExitCode } from "../core/exit.ts";

export interface DoctorOptions {
  json: boolean;
}

interface Check {
  ok: boolean;
  detail: string;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const checks: Record<string, Check> = {
    deno: { ok: true, detail: Deno.version.deno },
    am: { ok: await amPresent(), detail: "am on PATH" },
    identity: { ok: !!Deno.env.get("AGENT_NAME"), detail: Deno.env.get("AGENT_NAME") ?? "(unset)" },
  };

  // am-missing is the only HARD failure at this scaffold stage; an unset
  // identity is a warning (the watch loop handles it loudly at run time).
  const code = checks.am.ok ? ExitCode.OK : ExitCode.AM_MISSING;

  if (opts.json) {
    printEnvelope(
      code === ExitCode.OK
        ? ok("doctor", { checks })
        : err("doctor", code, "am_missing", "the 'am' CLI is not on PATH", { checks }),
    );
  } else {
    console.log("doctor — agent-mail");
    for (const [name, c] of Object.entries(checks)) {
      console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${name} — ${c.detail}`);
    }
  }
  return code;
}
