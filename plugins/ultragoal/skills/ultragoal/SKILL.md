---
name: ultragoal
description: >
  Turn a written plan into a self-enforcing run. Use when the user invokes
  /ultragoal start @<plan.md> after a planning discussion, says "arm the
  plan", or asks for a run that cannot stop until its acceptance criteria
  hold on disk. Compiles the plan's acceptance criteria into a
  machine-checkable rubric (after Karpathy's autoresearch recipe), arms a
  state file, and the plugin's Stop hook blocks stopping until every check
  passes — feeding failing checks back as the next marching order. Also:
  "status" reports the active goal, "bypass" is the human key around the
  gate.
license: MIT
metadata:
  author: gulp
  version: "0.3.0"
allowed-tools:
  - Bash(python3 *)
  - Bash(sha256sum *)
  - Bash(date *)
  - Read
  - Write
---

# ultragoal

One argument in, one invariant out: `/ultragoal start @<plan.md>` compiles
the plan into a rubric and arms the Stop hook; the session then cannot stop
until the rubric passes on disk (or a bounded verdict fires). State lives in
`$CLAUDE_PROJECT_DIR/.claude/.ultragoal/` (state.json, rubric.json, and the
append-only `attempts.jsonl` blocked-stop ledger) — gitignore it, along with
`.claude/ultra/` (escalation records).

## Inputs

- `start @<plan.md>`: the plan to enforce. Its acceptance criteria must be
  checkable by commands; if some aren't, name the gaps once and ask for one
  round of sharpening. Optional `--iterate N` — see the iterate loop below.
  Optional `--escalate` → `"escalate": true` in state.json: on expiry the
  escalation record is marked for pickup by an installed ultraralph rung
  (default false — the record still gets written, just not auto-consumed).
- `status`: report state.json (status, pass/fail counts via rubric-check).
  **Hook-liveness warning**: armed + `last_fired_at` absent means the guard
  has not fired this session — if the plugin was installed or updated after
  this session started, the hook set predates it; restart the session before
  trusting enforcement. (Empty `attempts.jsonl` beside an armed state is the
  same signal at postmortem time.)
- `bypass`: set `status: bypassed` in state.json — the human key around the
  gate; the guard stands down and the audit trail reads "bypassed".

## Steps

### 1. Compile the rubric

Read the plan. Distill every acceptance criterion into
`.claude/.ultragoal/rubric.json`:
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
`max_stop_attempts` (default 8), `stop_attempts: 0`, `status: armed`, and
`escalate` (true only when `start` was given `--escalate`; default false).
When in doubt the guard is live, run `status` after the first stop attempt —
armed + no `last_fired_at` is the detached-hook warning.

**Success criteria**: state.json valid; hash matches the rubric on disk.

### 4. Work — the hook drives from here

Do the plan. Every stop attempt runs the guard: failing checks come back as
feedback (exit 2) and you continue with exactly that marching order; all-pass
+ hash-ok ends the run with a ✓ table (`status: done`). Never edit
rubric.json after arming — the hash pin turns that into a `TAMPERED` verdict,
not a success.

**Success criteria**: `status` in state.json is `done` — or a loud bounded
verdict (`incomplete`/`bypassed`/`tampered`) the human has seen.

## Verdicts (guard-owned, for reference)

- `done` — all checks pass, hash verified. The only success.
- `incomplete` — deadline or stop-attempt cap hit; failing table printed.
  Degrade to a report, never a hostage. An escalation record (seam schema v1:
  embedded rubric, attempts ledger, spend block) is written to
  `.claude/ultra/escalations/` — the path is printed with the verdict. Note
  the two vocabularies: state.json stays `incomplete`; the record's own
  verdict field is `expired`.
- `tampered` — rubric edited after arming; success cannot be certified.
- `bypassed` — human ran `/ultragoal bypass`.

## start --iterate N — the improvement loop (opt-in)

`/ultragoal start @<plan.md> --iterate N` — normal flow, plus
`"iterate": {"max_iterations": N, "current_iteration": 0, "iterations": []}`
in state.json. Bare `/ultragoal start --iterate N` (no plan): scan
`docs/plans/*.md` for frontmatter `status: proposal` (oldest first), offer the
pick + the next two candidates + "something else?" via one question; accepted
plan flips to `status: active`, done plans to `status: shipped`.

On each DONE verdict with iterations remaining: read
`references/iterate-prompt.md` (after Karpathy's autoresearch recipe) and
follow it exactly — 30 ideas → kill-gate (simplicity criterion) → ONE plan to
`docs/plans/iterate/` → re-run this skill's steps 1-4 on it. Zero surviving
ideas → `status: converged`, the best terminal state; report the iteration
ledger and stop. Every DONE also mints a git tag (guard-owned) — the timeline
of certified states is the scrub track.

## References

`references/autoresearch-pattern.md` — aspirational loop-shaped setups
(karpathy autoresearch program-file pattern, swarm fork protocol). Signpost
only; the core flow above needs none of it.
