---
name: rg-doctor
description: >-
  Diagnose and repair an rg-flag-guard installation: run the bundled read-only
  doctor.sh (ripgrep/jq presence, version drift, live deny/allow probes,
  kill-switch and duplicate-registration detection), guide dependency
  installation interactively, explain a surprising verdict, or install the
  bundled search-tools rules file. Use when the
  guard seems inactive, a search command was unexpectedly denied or allowed,
  after installing the plugin, or on "rg guard doctor", "is the guard
  working", "why was this rg command blocked".
argument-hint: "[install | explain <cmd> | rules]"
---

# rg-flag-guard doctor

Health check and interactive setup for the rg-flag-guard plugin.

## Inputs
- `$ARGUMENTS` (optional): empty for a full health check; `install` for the
  interactive dependency install guide; `explain <cmd>` to classify a command;
  `rules` to install the bundled search-tools rules file.

## Goal
A verified-working guard: doctor.sh reports no failures, or every failure has
been walked to a fix with the user's consent.

## Available scripts
- **`scripts/doctor.sh`** (bash, read-only) — one "STATUS  check  detail" line
  per check; exit 0 all pass / 1 warnings only / 2 failures. `--help` for the
  check list.
- **`scripts/rg-flag-guard.sh --explain 'CMD'`** — classify CMD without the
  hook harness; JSON verdict `{decision, reason, suggestion}`; exit 0 allow /
  2 deny / 3 ask.

## Steps

### 1. Run the doctor
Run `"${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"` and read the line-oriented
report.

**Success criteria**: report captured; each non-PASS line interpreted for the
user in one sentence — the detail column already carries the fix.

### 2. Route on the argument
- **No argument**: report findings. For a WARN on dup-registration, offer to
  remove the manual settings.json hook entry (show the exact edit first).
  Done.
- **`install`**: go to step 3.
- **`rules`**: go to step 4.
- **`explain <cmd>`**: run
  `"${CLAUDE_PLUGIN_ROOT}/scripts/rg-flag-guard.sh" --explain '<cmd>'` and
  translate the JSON verdict: which flag tripped it, why the corpus says it is
  (or is not) the trap, and the corrected command to retry. Done.

**Success criteria**: exactly one branch taken; the user has a verdict or a
report.

### 3. Interactive install (only for FAIL on rg-installed / jq-installed)
Detect the package manager (`pacman`, `apt`, `dnf`, `brew` — first found on
PATH), present the matching install command, and ask before running anything.
After each install, re-run doctor.sh to verify.

**Human checkpoint**: never run a package install without explicit consent.

**Success criteria**: doctor.sh exits 0 or 1, or the user declined — report
which.

### 4. Install the rules file (`rules` argument)
The plugin bundles `rules/search-tools.md` — a de-personalized "rg and fd,
not grep and find" rule (trap warnings, guard behavior, Claude Code's
grep/find shadowing). Ask where to install it:

- **User-level** (all projects): `~/.claude/rules/search-tools.md`
- **Project-level** (this repo): `.claude/rules/search-tools.md`

If the target file already exists, show a diff against the bundled copy and
ask before overwriting. Copy with `mkdir -p` on the target directory, then
confirm the file landed by reading its first heading.

**Human checkpoint**: never overwrite an existing rules file without showing
the diff and getting consent.

**Success criteria**: the file exists at the chosen path, or the user
declined — report which.

## Rules
- doctor.sh is read-only; every mutation (installs, settings.json edits) goes
  through the user first.
- Never "fix" a FAIL by disabling the guard; `RG_FLAG_GUARD_DISABLE` is the
  user's lever, not a repair.
- An rg-version WARN outside majors 13–15 means the guard's VALUE_FLAGS set
  may be stale — point at the guard header's re-derivation note; don't
  hand-edit blindly.
