---
type: Plan
title: ultragoal observability — legible failures, loud skips, a front door
description: Print check descriptions and captured output on failure, announce the silently-skipped commit gate, and ship ultragoal's missing README.
status: draft
execution: not-started
generated: { by: claude-opus-5, at: 2026-08-13T16:42:02Z }
stale_after: 2026-10-13
sources:
  - id: session
    resource: /home/gulp/.claude/projects/-home-gulp-shower-thoughts/5ad8bfd4-e56d-4276-a8db-6d110a4fb79b.jsonl
    session_id: 5ad8bfd4-e56d-4276-a8db-6d110a4fb79b
    title: Originating session transcript
extraction: { count: 1, mode: fixed }
---

# Implementation Plan — ultragoal observability: legible failures, loud skips, a front door

**Finding:** A `/spotting-blindspots` hard gate killed 3 of 4 candidate observability gaps as documented design rulings, and surfaced better ones in their place — `rubric-check.sh:65` discards every check's output and `:68` prints only the id, so a failing check reports `✗ R8 (exit 1, expected 0)` while its description (`"§3 AC3.3 — bundled dist is 4096 bytes or smaller"`) sits unused in `rubric.json`; learning the real cause cost a manual re-run of `node build.mjs` to see `4641 bytes`.
**Change:** Make failures self-explaining, make the unannounced commit-gate skip as loud as the tag skip beside it, and give the plugin a README.

Owner: Yekta Gurel
Repo: `/home/gulp/projects/tiny-claude-plugins`
Files changed: `plugins/ultragoal/scripts/rubric-check.sh`, `plugins/ultragoal/scripts/goal-stop-guard.sh`, `plugins/ultragoal/scripts/test-guard-verdicts.sh`, `plugins/ultragoal/README.md` (new), `plugins/ultragoal/.claude-plugin/plugin.json`

---

Local sweep done. The headline is uncomfortable: **three of my four "gaps" don't survive the hard gate.** They're documented rulings, not blindspots — which is exactly what Step 4 exists to catch.

## Step 1 — What local evidence established

| Source | Established |
|---|---|
| `docs/design/escalation-record-seam.md:133-150` | `attempts.jsonl` is **specified** as one object per *blocked* stop; the record "is written **only** on expiry. It is not a checkpoint format, not a status feed" |
| `docs/design/ultragoal-namespace-and-semantics.md:171-177` | "**Telemetry (deferred, tracked)**" — names fleetglass as destination, states the transport lean |
| `/home/gulp/projects/fleetglass` | Real, active: "S2 daemon/ledger shipped, S3 next" |
| `write-escalation.py:70-95` | `sum_tokens()` reads transcript JSONL directly — works any time, needs no new instrumentation |
| `goal-stop-guard.sh:186-198` | Non-git → prints `not a git repo — skip-tag mode, verdict unaffected` |
| `test-guard-verdicts.sh` | All 4 verdicts + escalation matrix + multi-session + spend + null-safety + writer race |
| `plugins/agent-mail-monitor/monitors/monitors.json` | A background-monitor primitive **already exists in this marketplace**, `when: "always"` auto-arms |
| `.beads/issues.jsonl` | 113 issues, **zero** touching ultragoal observability |

## Hard gate on my own four

1. **Ledger is blocked-stops-only** → **killed.** Not an oversight; it's the written contract, and the seam doc explicitly rejects "status feed" as a role.
2. **Spend only on failure** → **demoted.** No capability gap — `sum_tokens()` is transcript-derived and callable anytime. It's expiry-only because `write_record` is called only from `expire()`. But the seam doc's reasoning is sound: a *record* means "escalate," so emitting one on DONE would overload the seam. The real question is whether a different artifact should exist.
3. **Tag silently skipped** → **I was wrong, and it matters.** It is not silent; it prints. The sharp version is narrower: the **commit-before-certify gate** (`:175-181`) is skipped by the *same* conditional and prints **nothing**. So outside git you lose an integrity gate with no notice, while loudly being told about the cosmetic one.
4. **Nothing streams** → **killed as a blindspot.** Deferred, tracked, with a live destination and an in-repo primitive. It's a scheduled feature blocked on one unwritten paragraph.

## What the gate surfaced instead — all better than my originals

- **`rubric-check.sh:65` discards check output** (`>/dev/null 2>&1`). A failure yields only `✗ R8 (exit 1, expected 0)`. I hit this live: I had to re-run `node build.mjs` by hand to learn it said `4641 bytes`.
- **The table omits `description` though the data carries it.** Usage promises `✓/✗ id — description` (`:21`); the impl extracts only id/expect/cmd (`:55`) and prints `✓ $id` (`:68`). My R8 description — `"§3 AC3.3 — bundled dist is 4096 bytes or smaller"` — exists in the rubric and is never shown. **Zero-cost fix, pure legibility gain.**
- **ultragoal ships no README**, unlike 3 of 5 siblings.

## Step 2 — The decision and its axes

> *Invest in ultragoal's observability so it stands as a best-in-class Claude plugin.*

| Axis | Independent failure | Status after gate |
|---|---|---|
| **A · Failure legibility** | A failing check tells you *that*, never *why* | **Live, unowned, cheap** |
| **B · Run trace** | What survives a run — audit, spend, certified timeline | Governed by seam rulings; question is scope, not bug |
| **C · In-flight visibility** | No signal between stop attempts | Deferred w/ destination; primitive exists |
| **D · Adoption surface** | No README; "best plugin" is partly a distribution claim | **Live, unowned** |
| **E · Enforcement integrity** | Observability itself wrong or silently disarmed | Well-tested — except the unannounced commit-gate skip |

## Step 5 — Ranked disposition

1. **A — resolve now.** Print descriptions; capture check output (tail on failure). The data already exists.
2. **E — resolve now.** Make the commit-gate skip say so, matching the tag skip's existing loudness.
3. **D — resolve now.** A README is the cheapest "best plugin" move available.
4. **B — accept as recorded risk.** Trigger: the first time someone asks "what did this certified run cost me" and can't answer.
5. **C — accept as deferred.** Trigger: the first long `--iterate N` run where a human can't tell if it's progressing. Note the repo's own CLAUDE.md calls monitors **experimental**.

## The bet-invalidator, explicitly and last

Ultragoal rests on **Stop-hook exit-2 blocking a stop and feeding stderr back as the next marching order** — plus the hook's stdin JSON shape, `$CLAUDE_CODE_SESSION_ID`, and `message.usage` in the transcript JSONL. None of these are standards; all are one vendor's fast-moving internals, and this session is running 2.1.231 against a search-policy hook last verified at 2.1.228.

**Is the foundation durable? Partly, and asymmetrically.** The hook contract is load-bearing for the whole plugin and would be a loud break. The riskier bet is axis C specifically: it depends on `monitors/`, which the repo itself labels experimental, plus fleetglass, which is mid-arc at S2/S3. Building the streaming layer now stacks an unstable feature on an unfinished dependency — whereas A, D, and E depend on nothing but files already on disk.

## Step 6 — What routes

**Almost nothing, and that's the result.** Every candidate was closed by a design doc, the source, or the test suite. The one question local evidence genuinely cannot settle: *is the Stop-hook feedback contract stable enough to keep betting on, and does Anthropic intend native goal/rubric enforcement that would subsume this?* That's world-state, not repo-state.

Ready to discuss any axis — my recommendation is A + E + D this pass, since all three are file-local and none touch a moving foundation.

---

## Scope

| Unit | Path | Axis | Change | In/Out |
|---|---|---|---|---|
| Rubric runner | `plugins/ultragoal/scripts/rubric-check.sh` | A | print `description`; capture + surface failing check output | **In** |
| Stop guard | `plugins/ultragoal/scripts/goal-stop-guard.sh` | E | announce the non-git commit-gate skip | **In** |
| Verdict tests | `plugins/ultragoal/scripts/test-guard-verdicts.sh` | A, E | cover both new behaviours | **In** |
| Plugin front door | `plugins/ultragoal/README.md` | D | create | **In** |
| Plugin manifest | `plugins/ultragoal/.claude-plugin/plugin.json` | — | version bump from `0.5.1` | **In** |
| Escalation writer | `plugins/ultragoal/scripts/write-escalation.py` | B | none — see Out of scope | **Out** |
| Monitors / telemetry | (would be `plugins/ultragoal/monitors/`) | C | none — see Out of scope | **Out** |

**Verified** across these rows: every line number and behaviour cited above was read from the file in this session, and the `rubric-check.sh` output shape was observed live (`✓ R1 … ✓ R12` with no descriptions, then `{"pass":12,"fail":0,"failing":[]}`). `plugin.json` version `0.5.1` and the absence of a `version` key in the marketplace entry were both read directly.

**Baseline verified** (2026-08-13, after this plan was first written): `bash plugins/ultragoal/scripts/test-guard-verdicts.sh` exits **0** on this checkout, printing `all verdicts + escalation-record + multi-session + doctor matrix proven`. Run from the repo root with the working tree in the state described under Rollback (dirty only under `plugins/kittens-saved/`). AC1.5's PENDING branch is therefore **not** active as of this measurement: any non-zero exit after §1 is a regression introduced by this work, not a pre-existing failure. Re-measure if the tree has moved since.

## Global constraints

- **C1.** The rubric-check stdout contract must not change: exactly one JSON line `{"pass":N,"fail":M,"failing":[ids]}`. All new human output goes to **stderr**, because `goal-stop-guard.sh:152` and `:202` parse stdout's last line.
- **C2.** Exit codes of both scripts must not change (`rubric-check`: 0/1/2/3; guard: 0 allow, 2 block). The guard's own comment at `:54-57` records that an unexpected exit 1 makes the harness read the hook as a non-blocking error and **silently disarms enforcement**.
- **C3.** Must not write an escalation record on any non-expiry path. `escalation-record-seam.md:96-98` reserves records for `deadline` and `attempt_cap` only — `satisfied`, `bypassed`, and `tampered` "are terminal where they stand and escalate nothing."
- **C4.** Must not turn `attempts.jsonl` into a status feed. Same doc, `:148-150`.
- **C5.** Must not edit an armed `rubric.json` to make anything pass — the hash pin converts that into `TAMPERED`, a worse outcome than an honest failure.
- **C6.** Never assert guard behaviour without reading the line that emits it. Recorded because this session claimed the tag skip was "silent" when `goal-stop-guard.sh:197` prints it; the real silent path was the adjacent commit gate.
- **C7.** Set `version` in `plugin.json` only, never also in the marketplace entry — repo `CLAUDE.md` states `plugin.json` wins and can mask a bump made only in the marketplace entry. Current state is correct (`0.5.1` / absent) and must stay that shape.
- **C8.** Captured check output must be bounded before it reaches stderr; an unbounded check could otherwise flood the Stop-hook feedback channel.

## §1 — Make a failing check explain itself

**Blocks:** §4

**Deliverable:** `rubric-check.sh` whose stderr table names each check and, on failure, shows what the check actually printed.

Steps:

1. Re-confirm the baseline before touching anything (measured **0** on 2026-08-13 — see *Baseline verified* above; re-run because the tree may have moved since):
   ```sh
   cd /home/gulp/projects/tiny-claude-plugins && bash plugins/ultragoal/scripts/test-guard-verdicts.sh; echo "baseline=$?"
   ```
2. Extend the python extraction at `rubric-check.sh:48-59` to emit `description` as a fourth TAB field. Descriptions may contain TABs/newlines — apply the same `.replace()` normalisation already used for `command` at `:54`.
3. Replace `bash -c "$cmd" >/dev/null 2>&1` at `:65` with a capture: `out=$(bash -c "$cmd" 2>&1); rc=$?`.
4. On pass, print `  ✓ $id — $description`. On fail, print `  ✗ $id — $description (exit $rc, expected $expect)` followed by the captured output, indented and truncated (last 10 lines, hard-capped at 2000 characters, with an elision marker when trimmed) per **C8**.
5. Leave the stdout `echo` at `:76` byte-identical (**C1**).

**Acceptance criteria:**

- AC1.1 — Descriptions reach stderr. Against the certified rubric at `/home/gulp/shower-thoughts/.claude/.ultragoal/rubric.json`:
  `bash plugins/ultragoal/scripts/rubric-check.sh --rubric /home/gulp/shower-thoughts/.claude/.ultragoal/rubric.json 2>&1 >/dev/null | rg -q 'bundled dist is 4096 bytes or smaller'` → exit 0.
- AC1.2 — A failing check surfaces its output. With a temp rubric whose single check is `echo DIAGNOSTIC_MARKER; exit 1`:
  `... 2>&1 >/dev/null | rg -q 'DIAGNOSTIC_MARKER'` → exit 0.
- AC1.3 — stdout is still exactly one parseable JSON line with the three required keys:
  `test "$(bash plugins/ultragoal/scripts/rubric-check.sh --rubric <fixture> 2>/dev/null | wc -l)" -eq 1` → exit 0, and that line satisfies `python3 -c "import json,sys;d=json.load(sys.stdin);assert set(d)=={'pass','fail','failing'}"` (**C1**).
- AC1.4 — Exit codes unchanged: all-pass → 0; any-fail → 1; unknown flag → 2; absent rubric → 3 (**C2**).
- AC1.5 — `bash plugins/ultragoal/scripts/test-guard-verdicts.sh` exits 0, matching the baseline measured at 0 on 2026-08-13. *If the step-1 re-run comes back non-zero, this criterion is PENDING, not PASS* — record the pre-existing failure rather than absorbing it.
- AC1.6 — Truncation holds. With a check emitting 5000 lines, stderr for that check is ≤ 2000 characters and contains an elision marker (**C8**).

## §2 — Make the skipped commit gate as loud as the skipped tag

**Gate:** §1 (shares the test suite touched in AC1.5)
**Blocks:** §4

**Deliverable:** outside a git repo, the guard states that commit-before-certify was not enforced — not only that tagging was skipped.

Steps:

1. At `goal-stop-guard.sh:175-181`, the `if git … rev-parse --git-dir` wrapper has no `else`. Add one that prints a single stderr line naming the skipped gate and that certification proceeded regardless.
2. Keep the wording distinct from the existing `:197` skip-tag line so the two are separable in a transcript.
3. Emit it only on the passing path where the gate would otherwise have run — never on the blocked path.

**Acceptance criteria:**

- AC2.1 — In a non-git fixture with a passing rubric, guard stderr matches **both** the existing skip-tag notice and the new commit-gate notice.
- AC2.2 — In a git fixture with a clean tree and a passing rubric, the new notice does **not** appear (no spurious firing).
- AC2.3 — Verdict is unchanged in both fixtures: exit 0 and `status` becomes `done` (**C2**).
- AC2.4 — In a git fixture with a **dirty** tree, behaviour is untouched: exit 2, a `dirty_tree` entry appended to `attempts.jsonl`, and the new notice absent.
- AC2.5 — `test-guard-verdicts.sh` gains a case asserting AC2.1 and AC2.2 and exits 0.

## §3 — Ship the README

**Blocks:** §4

**Deliverable:** `plugins/ultragoal/README.md`, matching the shape of the three siblings that already have one.

Steps:

1. Read `plugins/rg-flag-guard/README.md` and `plugins/kittens-saved/README.md` first and follow whichever structure they share; do not invent a third layout.
2. Cover, at minimum: what arming does; the four verdicts; the hash pin; bounded enforcement; the state dir and that it should be gitignored; `status` / `doctor` / `bypass`; and the non-git degradation now made explicit in §2.

**Acceptance criteria:**

- AC3.1 — `test -f plugins/ultragoal/README.md` → exit 0.
- AC3.2 — All four verdicts are named: `rg -q '\bdone\b' && rg -q '\bincomplete\b' && rg -q '\btampered\b' && rg -q '\bbypassed\b'` against the file → exit 0.
- AC3.3 — The hash pin is documented: `rg -qi 'rubric_sha256|hash.pin' plugins/ultragoal/README.md` → exit 0.
- AC3.4 — Bounded enforcement is stated: `rg -qi 'deadline' && rg -qi 'attempt cap'` → exit 0.
- AC3.5 — The state dir is named and its gitignore noted: `rg -q '\.claude/\.ultragoal' && rg -qi 'gitignore'` → exit 0.
- AC3.6 — No trivially-inferable counts (repo owner's standing README rule): `rg -qiE '[0-9]+ (tests|checks|files|lines)\b' plugins/ultragoal/README.md` → **exit 1**.

## §4 — Release

**Gate:** §1, §2, §3

**Deliverable:** a version bump users actually receive.

Steps:

1. Bump `plugins/ultragoal/.claude-plugin/plugin.json` `version` from `0.5.1`.
2. Leave the marketplace entry's version key absent (**C7**).

**Acceptance criteria:**

- AC4.1 — `python3 -c "import json;v=json.load(open('plugins/ultragoal/.claude-plugin/plugin.json'))['version'];assert v!='0.5.1'"` → exit 0.
- AC4.2 — The marketplace entry still declares no version: `python3 -c "import json;m=json.load(open('.claude-plugin/marketplace.json'));assert all('version' not in p for p in m['plugins'] if p['name']=='ultragoal')"` → exit 0 (**C7**).
- AC4.3 — `bash plugins/ultragoal/scripts/test-guard-verdicts.sh` exits 0.

## Rollback

In reverse order. The working tree carried **pre-existing uncommitted changes under `plugins/kittens-saved/` that this plan did not create** — every command below is path-scoped so it cannot sweep them.

```sh
cd /home/gulp/projects/tiny-claude-plugins
git checkout -- plugins/ultragoal/.claude-plugin/plugin.json     # §4
rm -f plugins/ultragoal/README.md                                # §3 (new file — checkout won't remove it)
git checkout -- plugins/ultragoal/scripts/goal-stop-guard.sh     # §2
git checkout -- plugins/ultragoal/scripts/rubric-check.sh \
                plugins/ultragoal/scripts/test-guard-verdicts.sh # §1
```

Nothing here is irreversible: no state dirs are written, no rubric is armed, and no tags are cut. Verify the restore against the §1 baseline (`test-guard-verdicts.sh` exit code), not against this plan's prose.

## Out of scope

- **Axis B — spend accounting for successful runs.** `sum_tokens()` already works anywhere, so this is cheap, but emitting it as an *escalation record* would violate **C3**. Deciding what artifact should carry it is a design question for the seam doc, not an edit to make in passing.
- **Axis C — in-flight progress.** Deferred by `ultragoal-namespace-and-semantics.md:171-177` to fleetglass, which is mid-arc (S2 shipped, S3 next), via a `monitors/` primitive the repo's own `CLAUDE.md` labels **experimental**. Two moving foundations; see the bet-invalidator above.
- **`attempts.jsonl` on clean runs.** Ruled out by **C4**.
- **The armed goal at `/home/gulp/shower-thoughts/.claude/.ultragoal/`.** Already certified `done`; read as a fixture in AC1.1, never modified (**C5**).
- **Committing any of this.** The plan stops at a clean working tree; the repo is on `main` and already dirty from unrelated work.
- **Filing beads.** `.beads/issues.jsonl` has zero ultragoal-observability issues and this plan does not create any — if these sections should be tracked there, that is a separate, deliberate act.
