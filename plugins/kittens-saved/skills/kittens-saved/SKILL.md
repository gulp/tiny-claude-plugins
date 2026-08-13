---
name: kittens
description: >
  The single front door to the kittens-saved plugin — bare /kittens with a verb
  argument. Read/inspect verbs: mine (what is waiting on YOU, the human),
  status (is enforcement live + tally), stats, count, doctor (--fix), config,
  zen. Control verb: toggle on|off (silence THIS session's reminder).
  List-management verbs (HUMAN-GATED adds): blame (denylist of high-confidence
  punt phrases) and warn (soft warnlist of style/sycophancy tells with
  reason+escape). Use when the user runs /kittens, asks "what's waiting on me",
  "list mine", "what do I owe", "what's on my plate", "kitten
  status/stats/count/tally", "kittens doctor/config", "kittens on/off",
  "silence the kitten nudges", or wants to add/list/test denylist or warnlist
  phrases ("blame this phrase", "warn on this tell"). For saving a kitten or
  the escape hatch use counting-saved-kittens.
argument-hint: "[mine|status|stats|count|doctor|config|zen|toggle on|off|blame …|warn …] [--json]"
allowed-tools: Bash(python3:*), AskUserQuestion
disable-model-invocation: true
---

# /kittens  (kittens-saved:kittens)

One command, verb-dispatched. Run the bundled script with the requested verb
and **print its output verbatim** — do not reinterpret numbers or findings:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" $ARGUMENTS
```

Default to `status` when no verb is given, and infer from prose — "how are the
kittens" → `status`, "why is the reminder off" → `doctor`, "kitten totals" →
`stats`, "kittens off" → `toggle off`, "blame this phrase" → the blame gate
below, "list mine" / "what's waiting on me" / "what do I owe" → `mine`.

**`mine` is named from the human's side of the fence.** The human saying "mine"
means the bucket the ledger stores as `yours` — the residual the agent declared
was theirs. The word is owner-relative and the two speakers mean opposite
buckets by it, so never answer "list mine" from your own perspective; that
mistake is what the verb exists to prevent. Your own unsaved residual is never
something the human asked to see — if it is non-empty you should be doing it,
not listing it.

## Read / repair verbs

- **`status`** — is enforcement actually live this session (global `enabled` ∧
  not per-session-muted), plus saved / waiting-on-you / still-yours.
- **`stats`** — this session's total and this project's total (every ledger in
  the project). Box-level (all projects) is deliberately not tracked.
- **`count [--scope session|all]`** — the tally; `session` also shows items
  still waiting on the human and any the agent still owes.
- **`doctor [--fix]`** — checks the state dir is writable and gitignored and
  reports the effective config. `--fix` applies only repairs the plugin owns
  (gitignores the ephemeral ledger dir); it never edits settings files.
- **`config`** — effective `enabled` / `scope` / `debug` and where each
  resolved from, plus how to change them (`/plugin configure`).
- **`zen`** — print the Zen of Kittens.

Read verbs take `--json` for machine-readable output; run
`… <verb> --help` for flags rather than restating them here.

**Exit codes** (surface, don't hide): `doctor` returns **1** when it found
issues — that is the finding, not a broken command. **3** is an environment
failure (state dir unwritable). **2** is a usage error.

## `toggle on|off|status` — per-session mute

Silences the Stop-hook reminder and the statusline segment for **this session
only** (a marker file next to the session ledger); the ledger keeps recording.
To disable the plugin everywhere, change the `enabled` plugin setting instead.

## `statusline …` — chip installer (preview-default, HUMAN-GATED writes)

Wire the 🐈 segment into the statusline without taking it over. Verbs:

| form | does |
|---|---|
| `statusline status [--json]` | per-scope wiring table + which scope wins for this cwd (exit 1 on MODIFIED/STALE/DEGRADED) |
| `statusline render [--scope …]` | run the effective statusline once with synthetic stdin; prints what would render |
| `statusline install [--scope user\|project\|local]` | **preview** the route (vacant/wrap/rail) and exact writes; `--yes` applies |
| `statusline rm [--scope …] [--force-modified]` | **preview** the inverse (excise + restore displaced value); `--yes` applies |

**The gate — `install`/`rm` NEVER write blind.** Without `--yes` they compute
everything and write nothing. Run the preview, show its output (route, files,
displaced value, scope caveats), confirm with **`AskUserQuestion`**, then
re-run with `--yes`. On exit 4 (refused/raced) re-run the whole
preview→confirm→`--yes` cycle at most once; exit 3 names a condition a rerun
cannot fix — report it. Never edit the wrapper's fenced body by hand-editing
tools; MODIFIED refusals route through `rm --force-modified`.

## `blame …` — the denylist (high-confidence punt phrases)

| form | does |
|---|---|
| `blame ls` | list entries — built-in defaults (read-only) + numbered overrides |
| `blame test "<text>"` | dry-run the matcher: which patterns fire (writes nothing) |
| `blame rm "<phrase>"` | remove an override entry (defaults can't be removed) |
| `blame edit` | open the override file in `$EDITOR` (human at a terminal only) |
| `blame add "<phrase>"` / bare `blame "<phrase>"` | add — **PREVIEW ONLY** unless `--yes` |

`--regex` treats an added phrase as a pattern, not a literal. `ls`/`test` take
`--json`.

## `warn …` — the warnlist (soft tier)

Lower-confidence **style/sycophancy** tells: a gentle `[i]` that *teaches*,
never blocks, capped per session. Each entry is `{matcher, reason, escape}`.
If a phrase is a coin-flip — it fires on honest behaviour as much as on a tell
— it belongs here, not in the denylist.

| form | does |
|---|---|
| `warn ls` | list entries — defaults (read-only) + numbered overrides |
| `warn test "<text>"` / bare `warn "<text>"` | dry-run with reason/escape shown |
| `warn rm "<matcher>"` | remove an override entry |
| `warn add "<matcher>" --reason "…" --escape "…"` | add — **PREVIEW ONLY** unless `--yes` |

## The gate — adds NEVER write blind

`blame add` and `warn add` **preview and write nothing** without `--yes`, and
**you must not pass `--yes` until the human has confirmed** the exact entry:

1. **Tighten** the matcher to the shortest reusable phrase that captures the
   tell — never a whole message blob (a 200-char pattern never re-matches).
   For `warn`, also draft the one-line **reason** (why it reads as a tell) and
   the **escape** (the honest case where it's fine).
2. Run the **preview** and show its output.
3. Confirm with **`AskUserQuestion`**, then re-run with `--yes`.

For a multi-line blob with several candidate clauses: split into clauses, drop
any that already trip (`blame test` each), tighten the hand-back-ish survivors,
and present them as an `AskUserQuestion` **multi-select checklist** — the human
ticks which to add; write each ticked phrase with `--yes`.

## Boundary

This skill is **read/repair/list-management only** — it never records a kitten
or takes the escape hatch. Those mutate the ledger and live in
`counting-saved-kittens`.
