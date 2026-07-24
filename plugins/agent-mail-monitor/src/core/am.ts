// The `am` adapter — the ONE place the CLI shells out to Agent Mail.
//
// Non-negotiables (see the plan's "Decided stack"):
//   - Deno.Command with an ARGV ARRAY, never `sh -c` — no shell means no
//     word-splitting / glob / injection surface.
//   - An AbortSignal so a caller can kill the child cleanly on SIGINT/SIGTERM
//     (zombie-free child kill).
//   - Zod safeParse on every `am --json` body: am exiting 0 with a non-JSON
//     body (an HTML error page, say) is a FAILURE, not a silent no-op.

import { z } from "zod";
import { AppError, ExitCode } from "./exit.ts";

export interface AmResult {
  code: number;
  stdout: string;
  stderr: string;
}

const decoder = new TextDecoder();

/**
 * The parent environment minus the dynamic-linker escalation vars (LD_*, DYLD_*).
 * Deno refuses to spawn under a SCOPED `--allow-run=am` when these are present
 * (they can redirect am's dynamic linking → privilege escalation) and demands
 * unscoped `--allow-run` instead. am does not need them, so we strip them and
 * keep least-privilege scoping — the fix the NotCapable error itself suggests
 * ("spawn with the environment variable unset").
 */
function childEnv(): Record<string, string> {
  const env = Deno.env.toObject();
  for (const k of Object.keys(env)) {
    if (k.startsWith("LD_") || k.startsWith("DYLD_")) delete env[k];
  }
  return env;
}

/** Run `am` with an explicit argv array. Throws AppError(AM_MISSING) if absent. */
export async function runAm(
  args: string[],
  opts: { signal?: AbortSignal; cwd?: string } = {},
): Promise<AmResult> {
  const cmd = new Deno.Command("am", {
    args,
    clearEnv: true,
    env: childEnv(),
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
    cwd: opts.cwd,
  });
  try {
    const { code, stdout, stderr } = await cmd.output();
    return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new AppError(ExitCode.AM_MISSING, "'am' CLI not found on PATH");
    }
    throw e;
  }
}

/** Is `am` runnable at all? Used by doctor / preflight. Never throws. */
export async function amPresent(): Promise<boolean> {
  try {
    const { code } = await runAm(["--version"]);
    return code === 0;
  } catch (e) {
    if (e instanceof AppError && e.code === ExitCode.AM_MISSING) return false;
    throw e;
  }
}

// --- check-inbox schema (Zod safeParse on the untrusted am --json body) ------
//
// nullish() = the field may be ABSENT or null. This is the classic
// untrusted-JSON footgun the plan calls out: nullable() is present-but-null,
// optional() is may-be-absent; nullish() covers both, which is what a
// best-effort CLI payload actually is. passthrough() keeps unknown keys so a
// future `am` field never makes a valid payload fail to parse.
const MessageSchema = z
  .object({
    id: z.number(),
    from: z.string().nullish(),
    importance: z.string().nullish(),
    subject: z.string().nullish(),
  })
  .passthrough();

const CheckInboxSchema = z
  .object({
    messages: z.array(MessageSchema).default([]),
  })
  .passthrough();

export type InboxMessage = z.infer<typeof MessageSchema>;

export interface PollResult {
  ok: boolean;
  messages: InboxMessage[];
  maxId: number;
  error?: string;
}

/**
 * One read-only check-inbox poll. `am check-inbox` does NOT mark messages read,
 * so watching never consumes mail out from under a later fetch_inbox. A poll is
 * OK only if am exits 0 AND the body parses to the expected shape.
 */
export async function pollInbox(
  agent: string,
  project: string,
  signal?: AbortSignal,
): Promise<PollResult> {
  const empty = (error: string): PollResult => ({ ok: false, messages: [], maxId: 0, error });

  let res: AmResult;
  try {
    res = await runAm(
      ["check-inbox", "--agent", agent, "--project", project, "--rate-limit", "0", "--json"],
      { signal },
    );
  } catch (e) {
    if (e instanceof AppError) return empty(e.message);
    throw e;
  }
  if (res.code !== 0) return empty(res.stderr.trim() || `am exited ${res.code}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return empty("check-inbox did not return JSON");
  }
  const check = CheckInboxSchema.safeParse(parsed);
  if (!check.success) return empty(`unexpected check-inbox shape: ${check.error.message}`);

  const messages = check.data.messages;
  const maxId = messages.reduce((m: number, msg: InboxMessage) => Math.max(m, msg.id), 0);
  return { ok: true, messages, maxId };
}
