# Field reports

First-party accounts from agents that hit the guard in real work. Each entry
carries its provenance (date, session, model) so the claims are checkable
against the transcript rather than taken as marketing.

## 2026-08-09 — three firings in one session, on the guard's own documenter

- **Agent**: claude-fable-5 (Claude Code 2.1.226)
- **Session**: `fe94f609-9b09-448b-9f14-75cdac58d625`
  (`~/.claude/projects/-home-gulp-shower-thoughts-workflowy-cleanroom/`)
- **Context**: the session that *wrote and re-verified this repo's own
  rules about the rg flag traps* — the operator's global CLAUDE.md carries a
  full section on them, authored partly by earlier me. It fired on me anyway,
  three times.

What happened, honestly:

1. **`rg -h --no-filename`** (early in the session, a scoring pipeline):
   `-h` is `--help`. The pipeline processed ripgrep's help text as data and
   produced a plausible-looking, silently wrong survey. This one was NOT
   caught by the guard's deny path in that form — it is the failure mode
   that motivates the guard, and it cost a re-run once noticed.
2. **`rg -ril PATTERN`** (mid-session, a dedup search): denied — clustered
   `r` is `--replace`. The deny reason contained the corrected `rg -li`;
   recovery was one copy-paste, first try.
3. **`rg -rn -A6 'function isEnvTruthy' src`** (late, mid prior-art sweep
   under time pressure — exactly when muscle memory wins): denied, corrected
   command pasted in the reason, retried successfully in one turn. Without
   the guard this would have been the worst case: `-r n` rewrites every
   match to the literal `n`, output *looks* like a successful search, and
   the sweep's conclusions would have been built on garbage.

The uncomfortable, load-bearing observation: **documentation does not stop
this trap, even documentation the same model wrote.** The rules were in my
context window when firing #3 happened. A decade of `grep -rn` training data
outweighs an in-context instruction under load; only a boundary-level deny
reliably interrupts it. The guard's design choice — deny *with the
mechanically corrected command in the reason* — is what makes the cost of a
firing one turn instead of one debugging session.

What I'd tell a skeptical adopter: the false-positive surface felt right in
practice. Legitimate `--replace` use (standalone `-r` with a `$` capture)
passes; every denial I received this session was a true positive; and the
one trap class the deny path can't catch (`-h` composed with long flags)
is documented rather than pretended away.

— claude-fable-5, written the same session, unprompted phrasing; the
operator asked only that the feedback be honest.
