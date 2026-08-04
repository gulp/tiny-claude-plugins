---
type: Plan
title: Widen rg-flag-guard to catch fd -g glob-mode misuse
description: Extend the plugin's classify core with fd rules after a corpus survey, following the v2 rg process; recommendation accepted by user.
status: draft
execution: not-started
generated: { by: claude-fable-5, at: 2026-08-04T20:10:00Z }
stale_after: 2026-11-04
sources:
  - id: session
    resource: /home/gulp/.claude/projects/-home-gulp-projects---playground--/e30e44bf-bf12-40ae-b8d9-5015e43c55e4.jsonl
    session_id: e30e44bf-bf12-40ae-b8d9-5015e43c55e4
    title: Originating session transcript
extraction: { count: 1, mode: fixed }
---

# Implementation Plan — fd glob-mode rules in the search-tool guard

**Finding:** `fd -a -t f -e md . "$ROOT" -p -g '**/handoffs/*.md'` silently matched 0 of 668 files — fd's `-g` is boolean, the glob became a phantom search path, the pattern operand was literal `.`, and fd exits 0 on no-match. Same silent failure class as rg `-h`.
**Change:** widen plugin scope to rg + fd; corpus survey first, then decision table, then classifier rules. Recommendation taken by user; not yet implemented.

Owner: gulp
Repo: /home/gulp/projects/tiny-claude-plugins
Files changed: none yet (plan only); will touch `plugins/rg-flag-guard/scripts/rg-flag-guard.sh`, its bats suite, and the `~/.claude/hooks/` mirror

<!-- Verbatim transcript extraction below; new material after the closing separator. -->

Worth revisiting — but first, autopsy of what actually fired, because the rule shape depends on it:

**What I ran (failing):** `fd -a -t f -e md . "$ROOT" -p -g '**/handoffs/*.md'`

Several stacked mistakes, worth separating:
1. fd's `-g` is a **boolean** (`--glob` mode switch), not a value flag. The glob string wasn't consumed by `-g` — it became a second positional, i.e. a **second search path** that doesn't exist as a literal directory.
2. The real pattern operand was `.`, interpreted in glob mode as literal filename `.` — matches nothing.
3. And fd **exits 0 with empty output** on zero matches (no-match is not an error to fd). So the whole confusion stack was silent — exactly the rg `-h` failure class: plausible tool, wrong flags, empty-but-clean result.

**Guard-worthiness assessment:**

- Same trap family: habit transfer (here from `fd`'s own `-e`/pattern grammar being muscle-memoried wrong, or from rg's `-g GLOB` which *does* take a value — that's likely the actual transfer: `rg -g '*.md'` is valid, `fd -g '*.md'` means something different).
- Detectable statically, cheap rules:
  - `fd … -g <token-that-looks-like-a-glob>` where the glob token lands as an extra positional beyond pattern+paths — deny with corrected `fd -p 'REGEX'` or `fd -g 'GLOB' <path>` form (fd glob mode wants the glob **as the pattern operand**, first positional).
  - pattern operand `.` in glob mode — nearly always the bug.
  - nonexistent-path positional is tempting but violates the "pure static function of the command string" decision (§7) — skip filesystem checks, keep it lexical.
- Counterargument: fd failures are *empty*, not *corrupt* — downstream usually notices zero results eventually. Weaker harm than rg `-r` rewriting output. But today's case shows "eventually" cost a broken corpus run and a debugging loop; count is now 1 with a live transcript.

**Recommendation:** widen plugin scope from "rg flag guard" to "search-tool flag guard" (rg + fd), same architecture: corpus-check real fd usage first (grep.app sweep for `fd -g` shapes, like the rg `-r` survey), then decision table, then rules in classify core with bats both modes. File as new bead, blocked-on/sibling to `__playground-0n3` since both touch the classifier.

Say go: I'll file the bead now and start with the corpus survey (no implementation until table agreed, matching v2 process).

---

## Scope

| Unit | In/out | Notes |
|------|--------|-------|
| `plugins/rg-flag-guard/scripts/rg-flag-guard.sh` (classify core) | in | new fd rules land here first |
| `plugins/rg-flag-guard/scripts/tests/` bats suite | in | dual-mode (stdin hook + `--explain`) cases per rule |
| `~/.claude/hooks/rg-flag-guard.sh` + its bats suite | in | mirror, synced after plugin |
| Plugin name/README/rules file | in | scope statement widens to "search-tool flag guard"; rename decision deferred |
| fd behavior claims | assumed | `-g` boolean / stdin-independent / exit-0-on-no-match observed once live; verify against fd --help and a version pin before writing rules |

## Global constraints

- C1. Corpus survey before decision table before code — same sequence that made the rg v2 rules deterministic; no rule ships without real-usage evidence for its allow side.
- C2. Classifier stays a pure static function of the command string — no filesystem tie-breakers (existing §7 decision, reaffirmed in extraction).
- C3. Every deny carries a mechanically corrected command (`fd -p 'REGEX' PATH` or glob-as-first-positional form).
- C4. Plugin-first, mirror-second; both bats suites green before commit.
- C5. Sibling bead to `__playground-0n3` (pathless-rg); coordinate since both edit the classify core.

## §1 — Corpus survey (Gate for §2)

**Deliverable:** grep.app sweep results for `fd -g` shapes in real repos, documented like the rg `-r` survey (which repos, which shapes, deliberate vs trap).

**Acceptance criteria:**
- AC1.1 — survey note distinguishes glob-as-pattern (`fd -g '*.md'` first positional — legal, common) from glob-after-path (the trap shape), with example URLs.
- AC1.2 — fd version behavior verified locally: `-g` booleanness, no-match exit code, documented with the tested fd version.

## §2 — Decision table + implementation

**Deliverable:** agreed decision table (user sign-off), then rules in classify core + bats both copies.

**Acceptance criteria:**
- AC2.1 — trap shape `fd … PATH -g 'GLOB'` (glob token as extra positional) denied with corrected command; legal `fd -g 'GLOB' [PATH]` allowed.
- AC2.2 — full suites green in plugin (`just test`) and mirror (`bats ~/.claude/hooks/tests/`).
- AC2.3 — bead filed and closed with reference to this plan.
