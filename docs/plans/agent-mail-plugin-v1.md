# agent-mail plugin — v1 implementation plan

> **Status:** planning → execution. Progress is tracked in **beads** (`tcp-6yk`
> epic + children); this doc is the *design rationale + sequencing* those beads
> execute against. When a bead and this doc disagree, the bead is the live state —
> re-verify (`br show tcp-6yk`) before acting.

## Goal

Grow the `agent-mail-monitor` plugin into a full **"Agent Mail"** plugin
(monitors + skills + a read-only agent) that mirrors the `am` CLI seam, so any
agent — or a stranger dropped into a plugin-enabled repo — can use Agent Mail
effectively from built-in plugin features instead of rediscovering the CLI.

**The plugin *id* stays `agent-mail-monitor`** (decision 2026-07-24): consumers
have already installed it, and the id is load-bearing for installs — a consumer's
`enabledPlugins` keys on `<id>@marketplace`, skill namespaces are `<id>:skill`,
and the cache dir is `<id>/<version>/`, so an id rename silently disables the
plugin for existing installs. "Agent Mail" is the **product/displayName**, not a
new id. This buys the fuller product framing at zero install risk.

v1 scope: **rebrand surface → Deno scaffold → product mode → doctor+introspection
→ onboard / product-setup / coordinate skills → read-only mail-triage agent →
ship.** Everything is **read-only**; no mutating command is in v1 (that boundary
is load-bearing — see Deferrals).

## Decided stack

**Deno 2.x + strict TS + Commander + Zod + Agent-Skills SKILL.md.** Shipped as
`.ts` run via `deno run` (NOT `deno compile`d — a plugin ships source, has no
reliable install-time build hook, and committing per-platform binaries to the
plugin repo is wrong). Rationale and the GPT "Pi" blueprint it derives from:
`raw/gpt-pi-skills-cli.md` (vault). Load-bearing specifics from research:

- `npm:commander@^14` (not "15" — the doc's number was wrong). Action-handler
  subcommands only (Deno breaks Commander's executable-file subcommand mode).
  `.exitOverride()` so a parse error throws `CommanderError` instead of calling
  `Deno.exit` out from under us.
- `Deno.Command` with **argv arrays, never `sh -c`** (non-negotiable). Pass an
  `AbortSignal` for zombie-free child kill; SIGTERM is unsupported on Windows —
  handle SIGINT too.
- Zod `safeParse` + `discriminatedUnion("ok", …)` on every `am --json` result.
  Mind `nullable()` (present, may be null) vs `optional()` (may be absent) — the
  classic untrusted-JSON footgun.
- `--allow-run=am` is *least-privilege intent, not a jail* (Deno docs: LD_*/DYLD_*
  bypass, PATH-write neutralizes it). Fine — we're not sandboxing a hostile `am`.
- Shebang `#!/usr/bin/env -S deno run --allow-run=am --allow-env --allow-read ...`
  (`-S` splits args; not POSIX but fine on the Linux/macOS targets).

## Architecture — thin `am`-wrapper, not a re-implementation

`am` **is** the capability CLI (it's already the MCP server too). Our Deno layer
owns only logic that is genuinely ours; skills route to `am` directly for
everything else.

**What the Deno CLI owns:**
- the long-poll → notify **watch loop** (port of `watch-mail.sh` / `mail-monitor.sh`);
- **product-mode** aggregation (`am products inbox <KEY> <AGENT> --since-ts …`,
  `created_ts` watermark, strict `>`) — see `agent-mail-inbox-topology` (vault);
- the `project_id → slug` join;
- `doctor` + the **introspection** trio (`capabilities`, `schema <cmd>`).

**Scope depth = "Wrapper + introspection"** (chosen). Beyond the thin wrapper we
add `doctor` / `capabilities` / `schema <cmd>` emitting **versioned JSON
envelopes** `{schemaVersion, ok, data|error, meta}` plus a global `--json`. This
recovers MCP's real advantage (typed discovery) cheaply, without a codegen
contract layer (deferred — see ledger).

**The one deliberate stdout exception:** the **watch loop prints human
notification lines to stdout** (`MAIL #<id> from <sender> [<importance>]:
<subject>`), because the Monitor turns each stdout line into a notification. That
is NOT the JSON-envelope rule — envelopes are for query/introspection commands
(`doctor`/`capabilities`/`schema`/product dumps under `--json`). Keep the two
surfaces distinct and documented, or a future reader will "fix" the watch loop to
emit JSON and break every notification.

**Exit codes** (carried from bash): `0` clean, `2` server/poll failure, `3`
no identity (loud, not silent), `4` first-poll failure, `127` `am` missing. Codes
are part of the contract skills/agents rely on — keep them stable.

## Workstreams (→ beads)

1. **Rebrand surface** (`tcp-6yk.1`). Keep the plugin **id** `agent-mail-monitor`
   (an id rename silently disables existing installs — see Goal). Change only the
   **presentational** surface: `marketplace.json` `displayName` → "Agent Mail" +
   broadened `description`; matching `plugin.json` `description`; version bump →
   `0.4.0`; README/docs framing to the "Agent Mail" product. **No `renames` map**
   — it exists only to migrate an id rename, which we are deliberately not doing.
   This is a standalone presentational edit: independent of the scaffold, it gates
   only **ship** (`.8`), so it can land any time before ship.

2. **Deno scaffold foundation** (`tcp-6yk.9`). `cli.ts` Commander skeleton,
   `deno.json` + lockfile, the core envelope + exit-code module, the `am` adapter
   (`Deno.Command` argv), shebang entrypoints, SIGTERM/SIGINT graceful shutdown.
   The floor everything else builds on.

3. **Product mode** (`tcp-6yk.2`). Port the watch loop; add product aggregation
   with the `created_ts` watermark. **Preflight the registration-gap footgun**
   (`agent-mail-inbox-topology`: a linked project missing an `agents` row for the
   name contributes zero messages, silently) — warn when the watched name isn't
   registered in every linked project.

4. **Doctor + introspection** (`tcp-6yk.3`). `doctor` (deno present? `am` present?
   server health? identity set? registration gap?), `capabilities`, `schema <cmd>`
   — all emitting the versioned envelope.

5. **Skills** (`tcp-6yk.4/.5/.6`) — *decision procedures, not CLI dumps.* Each is
   short and opinionated (Arize: "a short opinionated skill beats a long
   encyclopedic one"), body **< 500 lines / < 5000 tokens**, gotchas inline in
   `SKILL.md` (not deferred to references the model won't open). `description` is
   imperative and trigger-rich — "Use this skill when… **even if the user doesn't
   say `am`/mailbox**". Directory name = skill name (spec).
   - **`onboard`** (`.4`): a stranger's first-contact — register identity, verify
     health, explain the (agent, project) inbox model, hand off to the monitor.
   - **`product-setup`** (`.5`): wire a cross-project coordinator — `products
     ensure`/`link`, register the name in **every** linked project (the gap
     preflight), then product-mode watch.
   - **`coordinate`** (`.6`): the **fragile** one — it teaches the shared-tree
     reserve → announce → commit-`--only` → release → close loop, which mutates
     shared state. Be **prescriptive**: exact command sequences, not prose.
     Evaluate `disable-model-invocation: true` so it fires only on explicit
     request rather than auto-triggering into a destructive sequence.

6. **mail-triage agent** (`tcp-6yk.7`). Read-only ("read-and-recommend", never
   send/ack — a mutating triage is a v1 non-goal). **Preload conventions via the
   subagent `skills:` frontmatter** (full content injected at startup —
   deterministic, not dependent on the agent self-triggering a skill). Read-only
   tool allowlist (no `send_message`/`acknowledge`/git-write).

7. **Ship** (`tcp-6yk.8`). `claude plugin validate .`; re-arm the monitor (id
   unchanged → no consumer re-enable needed); update README + this plan; commit;
   push. Gated on `.1` so the rebrand lands in the same release.

## Eval strategy (skills are agent-facing — evals are the test suite)

Two distinct, non-jsonl harnesses (research-confirmed shapes):

- **Routing eval** — `eval_queries.json` (**array**). ~20 queries: 8–10
  should-trigger + 8–10 near-miss should-NOT-trigger, run 3× against a **0.5
  trigger-rate** threshold, 60/40 train/val, ≤5 tuning iterations on the
  `description`. This is the guard that `onboard`/`coordinate` fire when they
  should and stay quiet when they shouldn't.
- **Workflow eval** — `evals/evals.json` (**object**), `with_skill` vs
  `without_skill` in clean context, timing + grading.
- **Bare-baseline (4th) arm — the important one for us.** Because `am` is *not* a
  famous pretrained CLI (unlike `gh`), a bare-Claude arm should show a **large**
  skill-vs-baseline delta. That delta is the evidence the skills earn their
  context budget; a small delta means the skill is redundant and should shrink.

Anthropic's own tooling for both halves is the `skill-creator` plugin
(anthropics/claude-plugins-official); the CLI also exposes `claude plugin eval`
(case.yaml/graders, per its `--help`). Prefer the CLI/skill-creator convention
over the third-party `evals/**/case.yaml`+`graders/*.md` shape.

## Testing gates

- **Unit** — watermark math (`created_ts` strict `>`, id high-water), `am --json`
  parse via Zod.
- **Golden process** — the watch loop against a fake `am` (fixture stdout), assert
  the exact notification lines + exit codes.
- **Routing evals** — per skill (above).
- `claude plugin validate .` before every push.

## Sequencing

`.9 scaffold` (root) → { `.2 product`, `.3 doctor+introspection` } (parallel)
→ { `.4 onboard`, `.5 product-setup`, `.6 coordinate`, `.7 triage` } (evals
interleaved) → `.8 ship`. `.1 rebrand` runs **independently** (a standalone
presentational edit, no engineering dependency) and gates only `.8 ship`. Two
ready leaves to start: `.9` (the real foundation) and `.1` (whenever convenient).

## Deferrals

The YAGNI ledger with escalation triggers lives in the vault:
`design/agent-mail-plugin-deferrals.md`. Six items, each with a decidable
build-it trigger: define-once contract→codegen, contract tests, mutation-safety
tests, agent-workflow eval harness, compiled-binary distribution, full MCP
adapter. Consult it before building anything beyond the v1 baseline above.

## Open risks / version notes

- Installed `deno` 2.8.1 vs latest 2.9.4 — pin via `deno.json`, let `doctor` print
  the one-line install hint rather than hard-gating a version.
- `compatibility:` in skill frontmatter is **free-text (1–500 chars), no
  version-range grammar** — do not write `>=1.4.0 <2.0.0`; state the dependency in
  prose ("requires the `am` CLI on PATH").
- Claude Code truncates combined `description` + when-to-use at **1536 chars** —
  keep skill descriptions tight or the tail (often the trigger examples) is lost.
