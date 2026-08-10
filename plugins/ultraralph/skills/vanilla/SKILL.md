---
name: vanilla
description: >
  Hand a failed ultragoal rubric to the ultraloop engine (a ralph engine,
  after Geoff Huntley's technique) as a bare run — fresh session per
  attempt, rubric as prompt spine. Use when the user invokes
  /ultraralph:vanilla start @<escalation-record.json>, or when an ultragoal
  expiry printed that exact command as its next rung. Zero loop logic
  here: this skill writes a bed mode and execs the engine, never loops
  inline.
license: MIT
metadata:
  author: gulp
  version: "0.1.0"
allowed-tools:
  - Bash(python3 *)
  - Read
  - Write
---

# ultraralph vanilla

`start @<record.json>` — consume one escalation record (seam schema v1,
written by ultragoal on expiry) and hand it to ultraloop. The plugin owns
the ceremony; the engine owns the loop.

## Steps

### 1. Read the record — it is the complete input

Read the `@<record.json>` argument. Require `record_version: 1` and
`verdict: "expired"`; anything else, stop and say what was handed instead.
**Never reach back into `.claude/.ultragoal/`** — the record carries the
rubric verbatim, the spend already burned, and the attempt ledger; that's
the whole seam contract.

Surface the inheritance in one short table before doing anything: plan/goal,
expiry cause, attempts spent (rubric vs dirty_tree blocks), token spend if
recorded, and the final `attempts[]` entry's failing ids.

**Success criteria**: record parsed; user can see what this rung inherits.

### 2. Honor the spend

The record's `spend` is what the *last* rung burned — it travels so this
rung can honor the budget the last one started, not so it can be ignored.
If the record shows the goal was handed over with nothing left AND the
workspace hash of the last `attempts[]` entry matches the current workspace
(sha256 over `git rev-parse HEAD` + `git status --porcelain`), you are
being handed a **report on an unchanged tree**: re-running the judge would
prove what the ledger already proves. Skip straight to the failing checks
as the work list. On a changed workspace, a fresh judge run is warranted.

**Success criteria**: no re-proving what the ledger proves; budget framing
stated before the engine spins.

### 3. Engine presence — doctor, never fallback

Run `"${CLAUDE_PLUGIN_ROOT}/scripts/ultraralph-doctor.sh"`. Engine missing
→ print its install line and **stop**. This skill never falls back to an
inline loop: an unconfined brute-force loop is exactly what the engine's
sandbox exists to prevent.

**Success criteria**: `ultraloop` (or legacy `ralph`) confirmed on PATH, or
the run ended at the doctor's install line.

### 4. Bed adoption — adopt-if-present (destiny ruling 5)

- An existing `.ultraloop/` (or legacy `.ralph/`) bed → **adopt it**.
  Absent → create one with the engine's own init.
- Write the escalation as a named mode, `PROMPT_ultragoal.md`, from the
  record: rubric checks as the prompt spine, last failing ids up top,
  provenance line citing the record path + `rubric_sha256`.
- **The escalation mode is self-contained**: it carries its own limits in
  its mode section, ignores the bed's `hooks/on-stop.sh`, and named-mode
  config overrides bed defaults. `config.toml` is touched only additively.
- Runs interleave into the repo's single `runs/` history.

**Success criteria**: bed exists; `PROMPT_ultragoal.md` present with its
own limits; no non-additive edit to the bed's config.

### 5. Exec the engine, then mark consumption

Run the engine on the mode (fresh session per attempt, rubric as spine —
vanilla means no beads decomposition). Consuming the record does **not**
delete it: the record stays as the seam's audit trail until the human
prunes the directory. Your run artifacts in `runs/` are the consumption
marker.

**Success criteria**: engine invoked; record untouched; run ledger names
the record it consumed.

## Not yet

`/ultraralph:with-beads` (rubric → bead decomposition) and `--swarm N` are
gated on the engine's HIGH-security items (egress tier default,
agent-writable verify.cmd) before unattended runs — see
`docs/design/ultraralph-ultraloop-destiny.md` ruling 3.
