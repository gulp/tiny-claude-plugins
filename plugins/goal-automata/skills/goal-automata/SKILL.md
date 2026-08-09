---
name: goal-automata
description: >
  Turn a written plan into a self-enforcing run. Use when the user invokes
  /goal-automata @<plan.md> after a planning discussion, says "goal-automate
  this plan", "arm the plan", or asks for a run that cannot stop until its
  acceptance criteria hold on disk. Compiles the plan's acceptance criteria
  into a machine-checkable rubric, arms a state file, and the plugin's Stop
  hook blocks stopping until every check passes — feeding failing checks back
  as the next marching order. Also: "status" reports the active goal,
  "stop" aborts it.
license: MIT
metadata:
  author: gulp
  version: "0.1.0"
allowed-tools:
  - Bash(python3 *)
  - Bash(sha256sum *)
  - Bash(date *)
  - Read
  - Write
---

# goal-automata

One argument in, one invariant out: `/goal-automata @<plan.md>` compiles the
plan into a rubric and arms the Stop hook; the session then cannot stop until
the rubric passes on disk (or a bounded verdict fires). State lives in
`$CLAUDE_PROJECT_DIR/.claude/.goal-automata/` — gitignore it.

## Inputs

- `@<plan.md>`: the plan to enforce. Its acceptance criteria must be
  checkable by commands; if some aren't, name the gaps once and ask for one
  round of sharpening.
- `status`: report state.json (status, pass/fail counts via rubric-check).
- `stop`: set `status: aborted` in state.json — the guard stands down.

## Steps

### 1. Compile the rubric

Read the plan. Distill every acceptance criterion into
`.claude/.goal-automata/rubric.json`:
`{"checks":[{"id","description","command","expect_exit":0}]}` — each command
runnable from the project root by the guard, by you, and by the human.
**Vacuity guard**: run
`"${CLAUDE_PLUGIN_ROOT}/scripts/rubric-check.sh"` now — if every check
already passes before any work, the rubric is vacuous; sharpen it.

**Success criteria**: rubric.json exists; at least one check currently fails.

### 2. Confirm and go — the one HITL gate

Show the check table (id + description). One confirmation, then no more
questions: autonomy begins here.

**Success criteria**: user confirmed, or explicitly revised then confirmed.

### 3. Arm

Write `state.json`: `plan_path`, `rubric_sha256` (pin it —
`sha256sum rubric.json`), `armed_at`, `deadline_epoch` (default now+2h),
`max_stop_attempts` (default 8), `stop_attempts: 0`, `status: armed`.

**Success criteria**: state.json valid; hash matches the rubric on disk.

### 4. Work — the hook drives from here

Do the plan. Every stop attempt runs the guard: failing checks come back as
feedback (exit 2) and you continue with exactly that marching order; all-pass
+ hash-ok ends the run with a ✓ table (`status: done`). Never edit
rubric.json after arming — the hash pin turns that into a `TAMPERED` verdict,
not a success.

**Success criteria**: `status` in state.json is `done` — or a loud bounded
verdict (`incomplete`/`aborted`/`tampered`) the human has seen.

## Verdicts (guard-owned, for reference)

- `done` — all checks pass, hash verified. The only success.
- `incomplete` — deadline or stop-attempt cap hit; failing table printed.
  Degrade to a report, never a hostage.
- `tampered` — rubric edited after arming; success cannot be certified.
- `aborted` — human ran `/goal-automata stop`.

## ultraralph — the improvement loop (opt-in verb)

`/goal-automata ultraralph @<plan.md> N` — normal flow, plus
`"ultraralph": {"max_iterations": N, "current_iteration": 0, "iterations": []}`
in state.json. Bare `/goal-automata ultraralph N` (no plan): scan
`docs/plans/*.md` for frontmatter `status: proposal` (oldest first), offer the
pick + the next two candidates + "something else?" via one question; accepted
plan flips to `status: active`, done plans to `status: shipped`.

On each DONE verdict with iterations remaining: read
`references/ultraralph-prompt.md` and follow it exactly — 30 ideas →
kill-gate (simplicity criterion) → ONE plan to `docs/plans/ultraralph/` →
re-run this skill's steps 1-4 on it. Zero surviving ideas → `status:
converged`, the best terminal state; report the iteration ledger and stop.
Every DONE also mints a git tag (guard-owned) — the timeline of certified
states is the scrub track.

## References

`references/autoresearch-pattern.md` — aspirational loop-shaped setups
(karpathy autoresearch program-file pattern, swarm fork protocol). Signpost
only; the core flow above needs none of it.
