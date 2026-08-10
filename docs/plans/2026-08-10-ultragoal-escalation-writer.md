# ultragoal 0.3.0 — escalation writer in the Stop guard

Plan, 2026-08-10 (session `fe94f609-9b09-448b-9f14-75cdac58d625`). Status: proposal.

Implements the writer half of `docs/design/escalation-record-seam.md` (the
schema authority — amended this date with the `attempts.jsonl` ledger ruling
and the `attempts[].blocked` field). Reader half (ultraralph) stays unbuilt;
the seam is a file, so nothing here depends on it.

## Why now

The vault dogfood session is about to run ultragoal for real in an
always-dirty tree. If this lands first, their run exercises the writer for
free — including the `dirty_tree` attempt cause their environment is uniquely
suited to produce — and their attempts ledger becomes schema-verification
data instead of a hand-kept substitute.

## Design decisions (settled — do not re-litigate during implementation)

1. **Ledger is `attempts.jsonl` in the state dir**, append-only, one JSON
   object per blocked stop. Never an array in state.json: `setfield`'s
   whole-file rewrite is where corruption risk concentrates, and a `>>`
   append is crash-safe by construction.
2. **Each attempt entry carries `blocked: "rubric" | "dirty_tree"`.** The
   guard has two distinct exit-2 paths (`goal-stop-guard.sh:96` dirty tree,
   `:120` rubric failing); a `dirty_tree` entry has `failing: []` and would
   be unreadable without the cause field.
3. **Expiry captures a fresh judge run.** Both expiry paths already invoke
   `rubric-check.sh` and discard its stdout JSON (`:78`, `:84`); capture it
   and append it as the ledger's final entry before writing the record.
4. **The writer is a standalone script** (`scripts/write-escalation.py`),
   invoked by the guard — one testable home for the schema, reusable by a
   future `march` tier.
5. **`written_by` version is read from `plugin.json` at runtime**, never
   hardcoded (goes stale on every bump).
6. **`setfield` becomes atomic** (temp + `os.replace`) in the same pass —
   same crash-safety principle the seam mandates; a corrupted state.json
   silently disarms the goal.
7. **State status stays `incomplete` on expiry; the record's verdict is
   `expired`.** Two vocabularies by design (SKILL verdicts vs seam), now
   documented rather than implicit.
8. **The guard heartbeats, and silence is made loud.** Dogfood wave 1
   (vault session 613c0127, 2026-08-10) found the worst failure mode is not
   any verdict but *no guard at all*: a plugin update mid-session detached
   the harness's hook snapshot, stop_attempts stayed 0, state stayed armed,
   and the whole loop ran unenforced with no symptom. The guard cannot
   force the harness to invoke it, so the defense is detection: every guard
   invocation stamps `last_fired_at` in state.json, and `status` treats
   "armed + never fired + turns have ended" as a loud warning naming the
   likely cause (hooks registered after this session started — restart the
   session). Empty `attempts.jsonl` alongside an armed state is the same
   signal at postmortem time.

## Steps

### 1. `plugins/ultragoal/scripts/write-escalation.py`

Python 3, stdlib only (the guard already requires python3).

CLI: `write-escalation.py --state-dir DIR --cause deadline|attempt_cap
[--project-dir DIR]`.

Behavior:

- Read `state.json`, `rubric.json`, `attempts.jsonl` (tolerate a torn or
  absent last line: skip unparseable lines, count what was skipped on
  stderr; absent file → `attempts: []`).
- Resolve version from the plugin's `.claude-plugin/plugin.json`
  (`written_by: "ultragoal@<version>"`; fall back to `"ultragoal@unknown"`
  rather than failing the record).
- Build the record exactly per the seam note's schema v1: embedded rubric
  verbatim, `rubric_sha256` from state.json (provenance, not a gate),
  `verdict: "expired"`, `expiry_cause` from `--cause`, `spend` block
  (`tokens: null`, never 0), `handoff.escalate` from state.json's optional
  `escalate` field (default false), `handoff.suggested` string naming this
  record's own path.
- `mkdir -p` `<project>/.claude/ultra/escalations/`; write to a temp file in
  that same directory, `os.replace` to
  `<utc-stamp>-<rubric8>.json`. If the target already exists, refuse and
  exit non-zero with the existing path on stderr — never overwrite.
- Print the final record path on stdout (the guard relays it).

**Deliverable**: the script, executable, `--help` text matching the sibling
scripts' style.

**Acceptance**: running it against a fixture state dir produces a record
that round-trips through `json.load`; rubric block byte-equivalent
(`json.dumps`-normalized) to rubric.json; second run exits non-zero and
leaves the first record untouched; no `*.tmp*` residue in the directory on
success or on the refuse path.

### 2. Guard changes (`plugins/ultragoal/scripts/goal-stop-guard.sh`)

- New helper `ledger_append CAUSE FAILING_JSON` — writes one line to
  `$STATE_DIR/attempts.jsonl`:
  `{"at": "<utc>", "blocked": "<cause>", "failing": <ids>, "workspace": "<sha or null>"}`.
  Workspace hash = sha256 over `git rev-parse HEAD` output + `git status
  --porcelain` output; `null` outside a git repo — never a made-up value.
- Dirty-tree block (`:96`): `ledger_append dirty_tree '[]'` before exit 2.
- Rubric-fail block (`:120`): `ledger_append rubric <failing-from-RESULT>`
  before exit 2 (RESULT already holds the `{"pass","fail","failing"}` JSON).
- Both expiry paths (`:75` deadline, `:81` cap): capture the rubric-check
  stdout instead of `>/dev/null`, `ledger_append rubric <failing>` as the
  final entry, then invoke `write-escalation.py --cause <deadline|attempt_cap>`
  and echo on stderr: the record path, and the `handoff.suggested` command
  verbatim. Writer failure must not change the verdict — `|| true` with a
  loud stderr note (`escalation record could not be written`).
- `setfield`: write to `<state>.tmp.$$` and `os.replace` — atomic.
- Heartbeat (decision 8): the guard stamps `last_fired_at` (UTC) in
  state.json on every invocation that finds an armed goal — first thing
  after the `armed` check, so even a tampered/expiry path leaves proof the
  hook ran.

**Constraint**: no behavior change on any non-expiry verdict — done,
tampered, bypassed, and the no-goal no-op keep byte-identical stderr except
for additions explicitly listed here.

**Acceptance**: step 4's test matrix passes; `bash -n` clean.

### 3. SKILL.md + state additions

- `start` gains optional `--escalate` → `"escalate": true` in state.json
  (one line in Inputs; step 3 Arm mentions the field, default false).
- Verdicts section, `incomplete` line gains: "an escalation record is
  written to `.claude/ultra/escalations/` — the path is printed with the
  verdict."
- State-dir note names `attempts.jsonl` alongside state.json/rubric.json,
  and the gitignore guidance now covers `.claude/ultra/` too.
- `status` gains the hook-liveness warning (decision 8): armed +
  `last_fired_at` absent → loud "the guard has not fired this session —
  if the plugin was installed or updated after this session started, the
  hook set predates it; restart the session before trusting enforcement."
  Arm step 3 tells the model to run `status` after the first stop attempt
  when in doubt.

**Acceptance**: SKILL.md nowhere contradicts the seam note; the verdict
table still lists exactly done/incomplete/tampered/bypassed.

### 4. Tests (`plugins/ultragoal/scripts/test-guard-verdicts.sh`)

Extend the existing harness. New cases:

- Expiry by attempt cap → record exists, `expiry_cause: "attempt_cap"`,
  `stop_attempts_used == max`.
- Expiry by deadline → record exists, `expiry_cause: "deadline"`.
- Record's `attempts` length == number of blocked stops (+1 for the
  expiry-time entry); causes recorded correctly, including one forced
  `dirty_tree` block.
- Embedded rubric matches rubric.json; `rubric_sha256` matches the pin.
- No record on done, tampered, bypassed, or no-goal paths.
- Filename matches `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.json$`.
- Existing-record collision: writer refuses, guard verdict unaffected.
- No temp-file residue after any case.
- `last_fired_at` present and fresh after any armed-goal invocation,
  including tampered and expiry paths; absent when no goal is armed.

**Acceptance**: full suite exits 0; pre-existing cases unmodified except
where stderr additions from step 2 require expectation updates.

### 5. Version + docs + release

- `plugin.json` 0.2.0 → 0.3.0; marketplace description gains "expiry
  leaves a machine-readable escalation record".
- Commit series (conventions as before, one concern per commit):
  1. `feat(ultragoal): attempts.jsonl ledger + atomic setfield`
  2. `feat(ultragoal): write escalation record on expiry (seam schema v1)`
  3. `test(ultragoal): expiry-record verdict matrix`
  4. `chore(ultragoal): 0.3.0 + marketplace description`
  5. `chore(gitignore): own ephemeral state dirs` (`.claude/.dumbzone/`,
     `.claude/.kittens-saved/`, `.claude/.ultragoal/`, `.claude/ultra/`)
- `bash scripts/plugin-version-guard </dev/null` before push (passes by
  construction given the bump); `timeout 90 git push`.

**Acceptance**: guard exit 0; pushed; `git status --short` clean.

## Out of scope (unchanged rulings)

Doctor verbs (meaningful once records exist — natural successor), the
`march`/bare-goal tier, the ultraralph reader, fleetglass telemetry, any
queue semantics or `latest` pointer (explicitly ruled out by the seam note).
