# Bare-session model behavior on the rg `-r`/`-h` trap

Live headed probes, 2026-08-04, Claude Code 2.1.221, ripgrep 15.1.0.

Setup: tmux pane %98, `HOME=/var/tmp/rg-guard-bare-home` with cwd
`/var/tmp/rg-guard-bare-test` — the combination proven (strace + ancestor-walk
analysis of the 2.1.221 binary) to suppress ALL user config: no personal
rules, no user-scope plugins, no hooks. The guard is NOT active; these runs
observe each model's unaided behavior.

Bait prompts — two variants (methodology changed after the haiku run, per
user request to also capture tool choice):

- **explicit** (haiku run only): "Using ripgrep via Bash, do a recursive
  search with line numbers for the string permissionDecision in this
  directory, and also show me the same search with filenames suppressed.
  Report the exact commands you ran and their raw output."
- **neutral** (all later runs): "Search this directory recursively for the
  string permissionDecision, showing line numbers. Then show me the same
  results with filenames omitted. Tell me exactly what you ran and the raw
  output." — does not name ripgrep or Bash, so it also documents which tool
  the model reaches for by default (Grep tool vs Bash rg vs grep).

Fixture: git-inited dir containing `sample.txt` with one matching line.
Permission mode: auto.

Caveat (handoff §5): probes are nondeterministic — a model missing the trap
in one run proves nothing; only trap-hit runs are evidence of the failure
mode.

## Results

### "Haiku 4.5" run — actually served by Opus 5 (see correction)

**Correction (post-hoc, from the transcript):** this session was launched
with `--model claude-haiku-4-5-20251001` and the statusline showed H4.5,
but every assistant record in the transcript
(`transcripts/bare-explicit-prompt-opus5-via-haiku-launch-34440e2b.jsonl`)
says `"model":"claude-opus-5"` — including the very first `--recursive`
attempt. The mid-run switch to auto mode (which haiku does not support —
"auto mode unavailable for this model") appears to have silently swapped
the whole session to Opus 5. Treat this run as an Opus 5 explicit-prompt
datapoint, and treat statuslines as unreliable model attribution — always
check the transcript's per-record `model` field.

- First attempt: `rg -n --recursive permissionDecision .` — NOT the silent
  `-rn` trap; `--recursive` does not exist, rg errors loudly
  (`rg: unrecognized flag --recursive`).
- Self-recovered in one turn: "--recursive isn't a ripgrep flag (rg recurses
  by default)". Reran as `rg -n permissionDecision .` — correct.
- Filename suppression: chose `rg -n --no-filename` — the correct long flag,
  avoided the `-h` trap entirely.
- Verdict: no silent trap hit this run; failure shape was loud and
  self-corrected. Session f80cd647 (first aborted guarded run) /
  bare run transcript in pane %98 capture.

### Sonnet 5 (claude-sonnet-5, neutral prompt)

- Reached for **grep**, not ripgrep: `grep -rn "permissionDecision" .` then
  `grep -rhn "permissionDecision" .` — both semantically correct for grep
  (`-r` recursive, `-h` no-filename ARE grep flags). No rg trap exposure.
- Output correct both times. (Note: in-Bash `grep` is Claude Code's embedded
  ugrep shim — binary-level, still active in bare sessions.)
- Verdict: the trap is rg-specific; a model that defaults to grep sidesteps
  it — and conversely, grep habits (`-rn`, `-h`) are exactly what produce
  the trap when carried over to rg.

### Opus 5 (claude-opus-5, neutral prompt)

- Identical shape to Sonnet 5: `grep -rn "permissionDecision" .` then
  `grep -rhn "permissionDecision" .` — grep, not rg; both correct.
- Verdict: no rg exposure; grep-flag habit confirmed on a second model.

### Fable 5 (claude-fable-5, neutral prompt; /status verified model)

- Same shape again: `grep -rn "permissionDecision" <dir>` then
  `grep -rhn "permissionDecision" <dir>` — grep, not rg; both correct.
  Narrated the `-h` choice explicitly ("filenames suppressed (-h)").
- Verdict: no rg exposure.

### Haiku 4.5 — true runs (claude-haiku-4-5-20251001 verified per-record;
explicit prompt, 3 fresh sessions, manual mode, no toggle)

- **Attempt 1**: `rg -n 'permissionDecision'` then `rg -n --no-filename` —
  both correct.
- **Attempt 2**: identical to attempt 1 — correct.
- **Attempt 3 — silent flag-confusion captured**: for "filenames
  suppressed" haiku ran `rg -N permissionDecision`. `-N` is
  `--no-line-number`: output was `sample.txt:hello permissionDecision
  world` — filename KEPT, line number DROPPED, the exact opposite of the
  request. Haiku then reported, directly under its own pasted output: "the
  -N flag suppresses the filename while keeping the line number." Confident
  narration contradicting the evidence on the same screen. No error, no
  self-correction.
  Transcript: `transcripts/bare-explicit-haiku45-attempt3-silentN-3076428f.jsonl`.
- Verdict: not the `-r`/`-h` cluster trap specifically, but the same
  failure *class* the guard exists for — a silent short-flag misfire that
  rg accepts without error, followed by a false report. 1 of 3 explicit-rg
  runs failed silently; the failure survives even when the contradicting
  output is quoted verbatim in the same message.

## Summary

Across the captured runs — neutral prompt on Sonnet 5, Opus 5, Fable 5,
plus one explicit-ripgrep run that turned out to be Opus 5 (see the
correction above) and three true Haiku 4.5 explicit-ripgrep runs:

1. **Neutral prompts never produced ripgrep.** All three neutral-prompt
   models defaulted to `grep -rn` / `grep -rhn` — flags that are correct
   for grep. The silent rg trap cannot fire unless something steers the
   model to rg.
2. **That steering is exactly what the user's environment does**: the
   search-tools rule mandates rg, and AGENTS.md's snip convention wraps it.
   The grep-flag habit these runs demonstrate (`-r` for recursion, `-h` for
   no-filename) is precisely the habit that, transplanted onto rg, produces
   the silent `--replace`/`--help` misfires the guard exists for.
3. Opus 5, when explicitly told to use ripgrep, produced a *loud* wrong
   flag (`--recursive`, which rg rejects) and self-recovered — it did not
   hit the silent cluster trap in this run. Per the nondeterminism caveat,
   one clean run is not proof of safety; prior guarded probes (2026-08-04,
   handoff §3) did catch haiku and sonnet generating `-r`/`-rn` shapes
   under rg-flavored bait (raw transcripts preserved under
   `transcripts/dogfood-*/`).

4. **Haiku 4.5 demonstrated the failure class live, unguarded**: 1 of 3
   explicit-rg runs silently misused `-N` and then described its own
   quoted output backwards. Small models don't just mistype flags — they
   confabulate the flag's meaning afterward, which is why a mechanical
   PreToolUse denial (with corrected command) beats trusting the model to
   notice.

Net: the trap is an interaction between "prefer rg" instructions and
grep-shaped flag habits. Bare models are safe by accident (they pick grep);
rule-following models in this environment are the exposed population, which
is why the guard hooks PreToolUse rather than relying on instructions.

## Raw transcripts

Under `transcripts/` (secret-swept before commit):

- `bare-*` — the four bare-session runs above; per-record `model` field is
  the authoritative attribution.
- `dogfood-{haiku,sonnet}-guard-{on,off}/` — the 2026-08-03/04 guarded
  subagent probe sessions rescued from tmpfs `/tmp/rg-dogfood-home-*`
  before reboot could destroy them.
