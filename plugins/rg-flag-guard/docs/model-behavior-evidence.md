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

### Haiku 4.5 (claude-haiku-4-5-20251001)

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

## Summary

Across four models with the neutral prompt (Sonnet 5, Opus 5, Fable 5) plus
one explicit-ripgrep run (Haiku 4.5):

1. **Neutral prompts never produced ripgrep.** All three neutral-prompt
   models defaulted to `grep -rn` / `grep -rhn` — flags that are correct
   for grep. The silent rg trap cannot fire unless something steers the
   model to rg.
2. **That steering is exactly what the user's environment does**: the
   search-tools rule mandates rg, and AGENTS.md's snip convention wraps it.
   The grep-flag habit these runs demonstrate (`-r` for recursion, `-h` for
   no-filename) is precisely the habit that, transplanted onto rg, produces
   the silent `--replace`/`--help` misfires the guard exists for.
3. Haiku 4.5, when explicitly told to use ripgrep, produced a *loud* wrong
   flag (`--recursive`, which rg rejects) and self-recovered — it did not
   hit the silent cluster trap in this run. Per the nondeterminism caveat,
   one clean run is not proof of safety; prior guarded probes (2026-08-04,
   handoff §3) did catch haiku and sonnet generating `-r`/`-rn` shapes
   under rg-flavored bait.

Net: the trap is an interaction between "prefer rg" instructions and
grep-shaped flag habits. Bare models are safe by accident (they pick grep);
rule-following models in this environment are the exposed population, which
is why the guard hooks PreToolUse rather than relying on instructions.
