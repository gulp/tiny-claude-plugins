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

// --- product (multi-project) mode -------------------------------------------
//
// A product is a cross-project bus: `am products inbox <key> <agent>` aggregates
// one agent's mail across every linked project. Two differences from single
// check-inbox drive this whole branch:
//   1. Watermark on `created_ts` (ISO string), NOT the numeric id — ids are only
//      monotonic *within* a project, so across a product the max-id trick breaks.
//      am returns messages newest-first, so messages[0].created_ts is the frontier.
//   2. Each message must be LABELLED with its origin project. The payload carries
//      a numeric `project_id`; we resolve it to a slug via `am list-projects`.

const ProductMessageSchema = z
  .object({
    id: z.number(),
    from: z.string().nullish(),
    importance: z.string().nullish(),
    subject: z.string().nullish(),
    created_ts: z.string(), // ISO; the watermark key. Required — a message with
    // no timestamp can't be ordered, so a missing one SHOULD fail the parse loudly.
    project_id: z.number().nullish(),
    project_slug: z.string().nullish(), // tolerate either labelling field
  })
  .passthrough();

const ProductInboxSchema = z
  .object({ messages: z.array(ProductMessageSchema).default([]) })
  .passthrough();

const ProjectSchema = z
  .object({
    id: z.number(),
    slug: z.string().nullish(),
    human_key: z.string().nullish(),
  })
  .passthrough();
const ProjectListSchema = z.array(ProjectSchema);

export type ProductMessage = z.infer<typeof ProductMessageSchema>;

export interface ProductPollResult {
  ok: boolean;
  messages: ProductMessage[];
  /** created_ts of the newest message (messages[0]); undefined if the page is empty. */
  newestTs?: string;
  /** true when the page came back full (>= limit) — a cap we must not hide. */
  fullPage: boolean;
  error?: string;
}

/** Parse an `am` payload that is either `{messages:[...]}` or a bare `[...]`. */
function coerceInboxEnvelope(parsed: unknown): unknown {
  return Array.isArray(parsed) ? { messages: parsed } : parsed;
}

/**
 * One read-only product-inbox poll. `--since-ts` (when provided) asks am for
 * messages strictly newer than the watermark; we still guard by created_ts in
 * the caller. Read-only — like check-inbox it does not mark messages read.
 */
export async function productsInbox(
  productKey: string,
  agent: string,
  sinceTs: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<ProductPollResult> {
  const empty = (error: string): ProductPollResult => ({
    ok: false,
    messages: [],
    fullPage: false,
    error,
  });

  const args = ["products", "inbox", productKey, agent, "--limit", String(limit), "--json"];
  if (sinceTs) args.push("--since-ts", sinceTs);

  let res: AmResult;
  try {
    res = await runAm(args, { signal });
  } catch (e) {
    if (e instanceof AppError) return empty(e.message);
    throw e;
  }
  if (res.code !== 0) return empty(res.stderr.trim() || `am exited ${res.code}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return empty("products inbox did not return JSON");
  }
  const check = ProductInboxSchema.safeParse(coerceInboxEnvelope(parsed));
  if (!check.success) return empty(`unexpected products inbox shape: ${check.error.message}`);

  const messages = check.data.messages;
  return {
    ok: true,
    messages,
    newestTs: messages[0]?.created_ts,
    fullPage: messages.length >= limit,
  };
}

/**
 * project_id -> display label (slug, else human_key, else the numeric id).
 * Returns { ok:false } on any failure so the caller can degrade to a "?" label
 * rather than crash — a missing project map must never take the watch down.
 */
export async function listProjects(
  signal?: AbortSignal,
): Promise<{ ok: boolean; map: Map<number, string>; error?: string }> {
  const map = new Map<number, string>();

  let res: AmResult;
  try {
    res = await runAm(["list-projects", "--json"], { signal });
  } catch (e) {
    if (e instanceof AppError) return { ok: false, map, error: e.message };
    throw e;
  }
  if (res.code !== 0) {
    return { ok: false, map, error: res.stderr.trim() || `am exited ${res.code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, map, error: "list-projects did not return JSON" };
  }
  const check = ProjectListSchema.safeParse(parsed);
  if (!check.success) {
    return { ok: false, map, error: `unexpected list-projects shape: ${check.error.message}` };
  }

  for (const p of check.data) {
    map.set(p.id, p.slug ?? p.human_key ?? String(p.id));
  }
  return { ok: true, map };
}
