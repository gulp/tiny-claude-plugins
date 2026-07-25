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
 * One product-inbox poll. `--since-ts` (when provided) asks am for messages
 * strictly newer than the watermark; we still guard by created_ts in the caller.
 * Genuinely read-only: the product path (`fetch_inbox_product`, and the offline
 * local-DB fallback) does NOT mark messages read (verified against am v0.3.21) —
 * UNLIKE single-project `check-inbox`, whose daemon path consumes (retired from
 * the notification path entirely; see tcp-p0x.16.4).
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

// --- cross-project message lookup (tcp-p0x.1) -------------------------------
//
// Agent Mail message ids are globally unique, but the read path is project-scoped
// (`am robot message <id>` falls back to CWD and 404s against the wrong project).
// The `message` command wraps a bounded fan-out: enumerate candidate projects,
// then probe each with `am robot message <id> --project <p>` until one resolves.

/** One row of `am robot projects --json` — only slug/path are used to fan out. */
const RobotProjectSchema = z
  .object({ slug: z.string().nullish(), path: z.string().nullish() })
  .passthrough();
// `am robot projects` wraps the array under `projects`; tolerate a bare array too.
const RobotProjectsSchema = z
  .object({ projects: z.array(RobotProjectSchema).default([]) })
  .passthrough();

/**
 * Candidate projects to search, newest-agnostic. `{ ok:false }` (loud) on any am
 * failure or an unrecognized body — never a silent empty success that would read
 * as "no projects, so not found". Never throws except AM_MISSING (am gone
 * entirely is fatal, surfaced by the caller). Each candidate's `key` is the slug
 * (preferred, what `--project` wants) else the path.
 */
export async function robotProjects(
  signal?: AbortSignal,
): Promise<{ ok: boolean; projects: LinkedProject[]; error?: string }> {
  let res: AmResult;
  try {
    res = await runAm(["robot", "projects", "--json"], { signal });
  } catch (e) {
    if (e instanceof AppError && e.code === ExitCode.AM_MISSING) throw e;
    return { ok: false, projects: [], error: amErrorMessage(e) };
  }
  if (res.code !== 0) {
    return { ok: false, projects: [], error: res.stderr.trim() || `am exited ${res.code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, projects: [], error: "robot projects did not return JSON" };
  }
  const check = RobotProjectsSchema.safeParse(
    Array.isArray(parsed) ? { projects: parsed } : parsed,
  );
  if (!check.success) {
    return {
      ok: false,
      projects: [],
      error: `unexpected robot projects shape: ${check.error.message}`,
    };
  }

  const out: LinkedProject[] = [];
  for (const p of check.data.projects) {
    const key = p.slug ?? p.path;
    if (key == null) continue; // no queryable identifier — cannot probe this one
    out.push({ key, label: p.slug ?? p.path ?? key });
  }
  return { ok: true, projects: out };
}

/** Outcome of probing ONE project for a message id. `absent` = a clean 404 in
 *  that project (keep looking); `error` = the project could not be queried at all
 *  (a server/parse failure — surfaced so a miss is never a silent false negative). */
export type MessageProbe =
  | { kind: "hit"; message: unknown }
  | { kind: "absent" }
  | { kind: "error"; error: string };

/**
 * Probe a single project for `id` via `am robot message <id> --project <key>`,
 * read-only. exit 0 + JSON → hit; a non-zero exit whose stderr says "not found"
 * → absent; anything else (non-JSON body, other non-zero exit, timeout) → error.
 * Throws only AM_MISSING (fatal). Never marks the message read (a robot view).
 */
export async function robotMessage(
  id: string,
  projectKey: string,
  signal?: AbortSignal,
): Promise<MessageProbe> {
  let res: AmResult;
  try {
    res = await runAm(["robot", "message", id, "--project", projectKey, "--json"], { signal });
  } catch (e) {
    if (e instanceof AppError && e.code === ExitCode.AM_MISSING) throw e;
    return { kind: "error", error: amErrorMessage(e) };
  }
  if (res.code !== 0) {
    const stderr = res.stderr.trim();
    if (/not found/i.test(stderr)) return { kind: "absent" };
    return { kind: "error", error: stderr || `am exited ${res.code}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { kind: "error", error: "robot message did not return JSON" };
  }
  return { kind: "hit", message: parsed };
}

// --- doctor: product registration-gap introspection -------------------------
//
// The registration-gap check answers: "is my identity registered in EVERY
// project linked into this product?" A missing registration means the product
// watch's first poll would fail for that project. Two am reads drive it:
//   - `am products status <key> --json`  -> the set of linked projects
//   - `am agents list --project <p> --json` -> the identities in one project
//
// SHAPE NOTE (honest): no product exists in this deployment to observe the
// `products status --json` success body live, and `am products status <bogus>`
// HANGS rather than erroring — so both the shape below and every call here are
// defensive: we parse the linked-project list TOLERANTLY (several plausible
// container keys, or a bare array) and, crucially, fail LOUD if we can't find a
// project list at all, rather than silently reporting "no gaps". Every call is
// timeout-bounded by the caller's signal so a hanging `am` can't wedge doctor.

/** A linked project as seen in `products status`; any one identifier may be absent. */
const LinkedProjectSchema = z
  .object({
    id: z.number().nullish(),
    slug: z.string().nullish(),
    human_key: z.string().nullish(),
  })
  .passthrough();

export interface LinkedProject {
  /** Best identifier to pass to `am agents list --project` (slug > human_key > id). */
  key: string;
  /** Human-facing label (same precedence as key). */
  label: string;
}

/**
 * `am agents list` row. `name` alone drives the product-registration-gap
 * check; `model`/`last_active_ts` are carried too so the identity-pick hint
 * (tcp-p0x.4 — "which of these should I reuse?") can show more than a bare
 * name. All optional/nullish: a row missing either just degrades to "unknown"
 * in the hint rather than failing the parse.
 */
const AgentRowSchema = z
  .object({
    name: z.string().nullish(),
    model: z.string().nullish(),
    last_active_ts: z.string().nullish(),
  })
  .passthrough();
const AgentListSchema = z.array(AgentRowSchema);

/** One registered identity, trimmed to what the identity-pick hint shows. */
export interface AgentSummary {
  name: string;
  model: string | null;
  lastActiveTs: string | null;
}

/**
 * Pull the linked-project array out of a tolerant `products status` body: a bare
 * array, or an object carrying one under `projects` / `linked_projects` /
 * `links`. Returns null when no project array is found (→ caller fails loud).
 */
function extractLinkedProjects(parsed: unknown): LinkedProject[] | null {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
    ? ((parsed as Record<string, unknown>).projects ??
      (parsed as Record<string, unknown>).linked_projects ??
      (parsed as Record<string, unknown>).links)
    : undefined;
  if (!Array.isArray(arr)) return null;

  const out: LinkedProject[] = [];
  for (const raw of arr) {
    const p = LinkedProjectSchema.safeParse(raw);
    if (!p.success) continue;
    const key = p.data.slug ?? p.data.human_key ?? (p.data.id != null ? String(p.data.id) : null);
    if (key == null) continue; // no queryable identifier — cannot check this one
    out.push({ key, label: key });
  }
  return out;
}

/**
 * Linked projects for a product. `{ ok:false }` (loud) on any am failure, a
 * non-JSON/unrecognized body, or an empty/unparseable project list — never a
 * silent empty success that would read as "no gaps". Never throws.
 */
export async function productStatusProjects(
  productKey: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; projects: LinkedProject[]; error?: string }> {
  let res: AmResult;
  try {
    res = await runAm(["products", "status", productKey, "--json"], { signal });
  } catch (e) {
    return { ok: false, projects: [], error: amErrorMessage(e) };
  }
  if (res.code !== 0) {
    return { ok: false, projects: [], error: res.stderr.trim() || `am exited ${res.code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, projects: [], error: "products status did not return JSON" };
  }
  const projects = extractLinkedProjects(parsed);
  if (projects === null) {
    return { ok: false, projects: [], error: "products status: no linked-project list in payload" };
  }
  return { ok: true, projects };
}

/**
 * Registered identities in one project. `names` (back-compat, used by the
 * product registration-gap check) plus `agents` (model/last-active included,
 * used by the identity-pick hint — tcp-p0x.4). `{ ok:false }` (loud) on any am
 * failure or a non-JSON/unexpected body. Never throws.
 */
export async function agentsInProject(
  projectKey: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; names: string[]; agents: AgentSummary[]; error?: string }> {
  let res: AmResult;
  try {
    res = await runAm(["agents", "list", "--project", projectKey, "--json"], { signal });
  } catch (e) {
    return { ok: false, names: [], agents: [], error: amErrorMessage(e) };
  }
  if (res.code !== 0) {
    return {
      ok: false,
      names: [],
      agents: [],
      error: res.stderr.trim() || `am exited ${res.code}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, names: [], agents: [], error: "agents list did not return JSON" };
  }
  const check = AgentListSchema.safeParse(parsed);
  if (!check.success) {
    return {
      ok: false,
      names: [],
      agents: [],
      error: `unexpected agents list shape: ${check.error.message}`,
    };
  }
  const agents = check.data
    .filter((a): a is { name: string; model?: string | null; last_active_ts?: string | null } =>
      typeof a.name === "string"
    )
    .map((a) => ({
      name: a.name,
      model: a.model ?? null,
      lastActiveTs: a.last_active_ts ?? null,
    }));
  return { ok: true, names: agents.map((a) => a.name), agents };
}

/** Normalize a caught am error (AppError, abort/timeout, or anything) to a string. */
function amErrorMessage(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof DOMException && e.name === "AbortError") return "am call timed out";
  if (e instanceof Error && e.name === "AbortError") return "am call timed out";
  return e instanceof Error ? e.message : String(e);
}
