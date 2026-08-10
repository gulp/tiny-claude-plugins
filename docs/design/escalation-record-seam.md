# The escalation record — ultragoal → ultraralph seam

Design note, 2026-08-10 (session `fe94f609-9b09-448b-9f14-75cdac58d625`).
Executes the seam that `ultragoal-namespace-and-semantics.md` ruled ("the
seam is a file, not a call") and the destiny note's Ruling 5 requires
(escalation mode is self-contained in ultraralph). This note pins the file's
path, schema, and writer/reader contract so the two plugins can be built
against it independently.

## What the seam is for

When an ultragoal run **expires** (deadline or stop-attempt cap), the goal
was real, the rubric was real, and the work is unfinished. The expiry path
must not end in a stderr paragraph that scrolls away: it ends in a **record
on disk** that a heavier rung can pick up — or that a human can read, edit,
and re-arm by hand. No import in either direction; presence is discovered by
`doctor`, never assumed.

## Path

```
$CLAUDE_PROJECT_DIR/.claude/ultra/escalations/<utc-stamp>-<rubric8>.json
```

- `<utc-stamp>` = `YYYYMMDDTHHMMSSZ` of the expiry; `<rubric8>` = first 8 hex
  of the pinned rubric sha256. Together they sort chronologically and stay
  unique without a lockfile.
- The directory is `.claude/ultra/`, **not** `.claude/.ultragoal/`: the state
  dir belongs to one plugin and is torn down on its terms; the seam belongs
  to the suite. Any ultra\* plugin may write records here; any may read them.
  This directory is the suite convention's "files" half (the other half is
  `doctor` presence checks).
- Gitignore it (same guidance as the state dir). An escalation record can
  embed failing-check output; it is working state, not history.
- No `latest` symlink or pointer file. The writer prints the exact path; the
  reader that wants "newest" sorts the directory. Two names for one record is
  a staleness bug waiting to happen.

## Schema (v1)

One JSON object per file. Writers write atomically (temp file + `mv` in the
same directory) and never overwrite an existing record. Readers must
tolerate unknown fields — additions bump nothing; only a semantic change to
an existing field bumps `record_version`.

```json
{
  "record_version": 1,
  "written_by": "ultragoal@0.2.0",
  "written_at": "2026-08-10T18:00:00Z",

  "plan_path": "docs/plans/thing.md",
  "goal": "one-sentence goal if set via the bare tier, else null",

  "rubric": { "checks": [ { "id": "…", "description": "…",
                            "command": "…", "expect_exit": 0 } ] },
  "rubric_sha256": "…64 hex…",

  "verdict": "expired",
  "expiry_cause": "deadline" ,

  "attempts": [
    { "at": "2026-08-10T17:10:00Z",
      "blocked": "rubric",
      "failing": ["check-id", "…"],
      "workspace": "sha256 of `git rev-parse HEAD` + `git status --porcelain`" }
  ],

  "spend": {
    "armed_at": "2026-08-10T16:00:00Z",
    "expired_at": "2026-08-10T18:00:00Z",
    "wall_seconds": 7200,
    "stop_attempts_used": 8,
    "stop_attempts_max": 8,
    "deadline_epoch": 1786471200,
    "tokens": null
  },

  "handoff": {
    "escalate": false,
    "suggested": "/ultraralph:vanilla start @.claude/ultra/escalations/<this-file>"
  }
}
```

Field rulings, each load-bearing:

- **The rubric is embedded verbatim, not referenced.** The state dir may be
  gone by the time the record is read, and — the ruled authority checkpoint —
  a human may hand-edit the rubric *in the record* between the plugins.
  `rubric_sha256` is therefore **provenance, not a gate**: it records what
  ultragoal's judge was pinned to. A downstream rung re-pins its own hash
  when it arms; a mismatch between the embedded rubric and `rubric_sha256`
  means "edited in transit", which is legal and worth logging, never a
  TAMPERED verdict.
- **`expiry_cause` is `"deadline"` or `"attempt_cap"`** — the two arrows the
  CLOCK owns. Nothing else may write a record: `satisfied`, `bypassed`, and
  `tampered` are terminal where they stand and escalate nothing.
- **`attempts[].blocked` names which gate consumed the attempt**: `"rubric"`
  (checks failing) or `"dirty_tree"` (rubric passing but commit-before-certify
  refused to certify an uncommitted tree). A `dirty_tree` entry legitimately
  carries `failing: []` — without the field that entry would read as "all
  passed, blocked anyway". The distinction is the postmortem's first question:
  did the cap burn on wrong work or on an unswept tree? (Flagged as the top
  risk by the first dogfood run — an always-dirty vault burns attempts on
  `dirty_tree` alone.)
- **`attempts[].workspace` is the don't-rerun key** (imported from
  prime-agent, read 2026-08-09): a downstream rung facing the same failing
  checks on an unchanged workspace hash skips straight to work — re-running
  the judge would prove what the ledger already proves. Hash = sha256 over
  `git rev-parse HEAD` output concatenated with `git status --porcelain`
  output; outside a git repo the field is `null`, never a made-up value.
- **`spend` externalizes the budget accounting** (the prime-agent lesson:
  their goal state and continuation policy talk in-process; our seam crosses
  a process boundary, so the numbers must travel in the file or the next
  rung cannot honor the budget the last one started). `tokens` is `null`
  until a harness exposes a real number — never 0, which would read as "free
  so far" and license unbounded downstream spend.
- **`handoff.escalate`** records whether `start`/`march` was given
  `--escalate`. True + ultraralph installed → ultraralph picks the record up;
  anything else → ultragoal prints `handoff.suggested` and stops. The
  suggested line is stored, not just printed, so a human returning tomorrow
  finds the next command inside the record itself.
- **`goal` vs `plan_path`**: a `march`-compiled rubric has a goal sentence
  and no plan file; a `start @plan.md` run has the reverse. Both nullable,
  never both null.

## Writer contract (ultragoal)

On the expiry verdict, after setting `status: incomplete` in state.json:

1. Build the record from state.json + rubric.json + the attempt ledger the
   guard appends per blocked stop (this note obliges the guard to keep that
   ledger — today it keeps only a counter). The ledger lives as
   `attempts.jsonl` in the state dir — append-only, one JSON object per
   blocked stop — **not** as an array inside state.json: a `>>` append is
   crash-safe by construction (a torn last line is detectable and
   droppable), while growing an array through a whole-file JSON rewrite puts
   the corruption risk exactly where the goal's arming state lives.
2. Append one final ledger entry at expiry time from a fresh judge run —
   both expiry paths already re-run the rubric for the human table, so the
   machine JSON is free — then the record's last `attempts[]` element
   describes the workspace at expiry, not at the last stop attempt.
3. Write atomically to the seam path; `mkdir -p` the directory.
4. Print one line naming the path and — when not auto-escalating — the
   `handoff.suggested` command verbatim.

The record is written **only** on expiry. It is not a checkpoint format, not
a status feed, and fleetglass telemetry (deferred, tracked in the namespace
note) stays a separate concern.

## Reader contract (ultraralph, or any future rung)

- Treat the record as the *complete* input: rubric, budget already spent,
  and what failed last. Never reach back into `.claude/.ultragoal/`.
- Re-pin your own rubric hash at arm time; carry `rubric_sha256` forward as
  provenance in whatever ledger you keep.
- Honor `spend`: a rung that receives 0 remaining attempts and a passed
  deadline is being handed a *report*, not a mission — surface it, don't
  loop on it.
- Consuming a record does not delete it. Mark consumption by writing your
  own artifacts; the record stays as the seam's audit trail until the human
  prunes the directory.

## doctor lines

- `ultragoal doctor`: "escalation available: ultraralph installed" / "not
  installed — the expiry path ends at a saved record without it", plus a
  count of unconsumed records in the seam directory.
- `ultraralph doctor` (when built): the mirror line, plus the newest record's
  age — a week-old escalation nobody picked up is the seam's one silent
  failure mode, and doctor is where it becomes loud.

## Non-goals

- No queue semantics, no `ready` vocabulary (reserved by the namespace note
  for a real rubric queue if one ever exists).
- No cross-machine transport; the seam is a project-local file.
- No schema registry or validation tooling yet — one writer, one reader,
  `record_version` gating. Revisit when a third party appears.
