---
name: status
description: >
  Report the active ultragoal — status, pass/fail counts, ownership, and
  hook health. Use when the user asks /ultragoal:status, "how's the goal",
  "is the guard live", or wants the doctor's health report. Read-only;
  never mutates state, rubric, or ledger.
license: MIT
metadata:
  author: gulp
  version: "0.5.0"
allowed-tools:
  - Bash(python3 *)
  - Bash(sha256sum *)
  - Read
---

# ultragoal status

Read-only reporting on the goal in
`$CLAUDE_PROJECT_DIR/.claude/.ultragoal/`. Two depths:

## `status` — the quick read

Report state.json: `status`, `plan_path`, attempts used/max, and a fresh
pass/fail count via
`"${CLAUDE_PLUGIN_ROOT}/scripts/rubric-check.sh"`. Also say **whose goal it
is**: compare state.json's `session_id` with `$CLAUDE_CODE_SESSION_ID` —
"yours" / "another session's (its stops are gated, yours are not)" /
"unowned (pre-0.4.0 arm: every session here is conscripted)".

**Hook-liveness warning**: armed + `last_fired_at` absent means the guard
has not fired this session — if the plugin was installed after this session
started, the hook set predates it; restart the session before trusting
enforcement. (Empty `attempts.jsonl` beside an armed state is the same
signal at postmortem time.)

## `doctor` — the full health report

Run `"${CLAUDE_PLUGIN_ROOT}/scripts/goal-doctor.sh"` and print its output
verbatim — state, ownership, judge pin, hook liveness, budget, fresh rubric
run. **Exit 1 means it found issues — that is the finding, not a broken
command.** Exit 2 is unreadable state. Read-only; it never repairs.

## Verdict vocabulary (guard-owned, for reference)

`done` (only success) · `incomplete` (bounded expiry; escalation record in
`.claude/ultra/escalations/`, record's own verdict field reads `expired`) ·
`tampered` (rubric edited after arming) · `bypassed` (human key).

Arming and working live in the `ultragoal` skill; the human escape hatch is
the `bypass` skill.
