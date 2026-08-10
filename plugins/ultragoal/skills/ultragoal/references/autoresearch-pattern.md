# karpathy/autoresearch — prior art for goal-driven unattended loops

Source: `~/.opensrc/repos/github.com/karpathy/autoresearch/master/` (fetched
2026-08-08; branch `master`, not `main`). Three files matter: `prepare.py`
(fixed, read-only), `train.py` (the ONLY file the agent edits), `program.md`
(the human-edited "research org code" — a lightweight skill). Design analysis
below maps its choices onto ultragoal and the adjudicated-ralph harness.

## The loop (program.md, condensed)

Edit `train.py` → commit → `uv run train.py > run.log 2>&1` (fixed 5-minute
wall-clock budget) → `grep "^val_bpb:" run.log` → improved? advance the
branch : `git reset` back → log a TSV row (`commit  val_bpb  memory_gb
status  description`, deliberately untracked) → repeat forever.

## Load-bearing design choices, and what they map to here

| autoresearch | why it works | ultragoal / adjudicated-ralph analogue |
|---|---|---|
| single mutable file (`train.py`) | scope containment; diffs reviewable | disposable clone / bwrap `/workspace`; one bead per iteration |
| `prepare.py` + eval harness read-only, "ground truth metric" | agent cannot reward-hack the judge | HOST runs `make verify` itself; guest close accepted only on host-verified evidence |
| fixed 5-min budget per experiment | experiments comparable; ~12/hour cadence; platform-optimal | per-iteration timeout in loop.sh; kill at 2× budget "treat as failure (discard and revert)" |
| one scalar metric (`val_bpb`) | keep/discard is mechanical, no judgment needed | binary verify exit code; acceptance criteria per bead |
| keep = advance branch, discard = `git reset` | git IS the experiment ledger; rewind "very very sparingly" | adjudicator merges `--no-ff` on green, drops the clone on red |
| `results.tsv` untracked, tab-separated | history without polluting the branch; commas break descriptions | bead attempt records / comments; LEARNINGS.md harvest |
| redirect run output to log, grep the metric — "do NOT use tee" | protects the agent's context window from output floods | same rule verbatim for any guest loop |
| **NEVER STOP** section in ALL CAPS prose | fights the model's ask-permission reflex by exhortation | `/goal <condition>` — the Stop hook makes continuation STRUCTURAL: the session cannot stop until evidence holds. Prose exhortation → enforced invariant |
| crash policy: dumb fix → retry; fundamental → log `crash`, move on | bounded self-repair, no rabbit holes | strike counter (K failures → mark bead blocked) |
| `program.md` iterated by the human, `train.py` by the agent | two-plane separation of org-code vs work | specs/ + PROMPT owned by human/host; clone owned by guest |

## The one idea worth stealing outright

autoresearch's weakest joint is that its continuation guarantee is
**rhetorical** ("NEVER STOP", "do NOT ask 'should I keep going?'") — it works
until the model's stop-reflex wins once at 3am. Claude Code's `/goal` turns
that same guarantee into a **Stop-hook invariant**: the session is blocked
from stopping until the condition holds on disk. When arming an
autoresearch-style loop via ultragoal, phrase the condition as the
ledger's state, not the work's vibe — e.g.
`/goal results.tsv contains >= 20 data rows and the best val_bpb row beats the baseline row`
— so "never stop" is enforced by the harness and "done" is a grep, not a
feeling.

## How karpathy actually gives the task (thread + program.md)

From the X thread (`raw/x/karpathy-autoresearcher.json`, post 2031137476438548874):
*"you don't 'use it' directly, it's just a recipe/idea — give it to your agent
and apply to what you care about."* The task-giving pattern has four parts:

1. **The task lives in a file, not a prompt.** `program.md` is "research org
   code," human-owned and iterated across runs. The prompt merely points:
   *"Hi have a look at program.md and let's kick off a new experiment! let's
   do the setup first."* One line; all weight in the file.
2. **Setup is collaborative, autonomy is gated.** program.md's Setup section
   says "work with the user to" agree a run tag, branch, verify data, init the
   ledger, "Confirm and go" — *"Once you get confirmation, kick off the
   experimentation."* The HITL gate sits exactly at the autonomy boundary.
3. **The loop section is addressed to an already-running agent** — no
   re-prompting; the file is re-read each iteration for new angles.
4. **Idea-exhaustion has an instruction**: "If you run out of ideas, think
   harder — read papers referenced in the code, re-read the in-scope files,
   combine previous near-misses, try more radical changes."

**Fold into ultragoal**: for loop-shaped work, don't pack the loop into
the `/goal` condition. Seed a program file in the pane's cwd, send the
one-line kickoff pointing at it, participate in (or fast-forward) the setup
gate, and arm `/goal <ledger condition>` at the moment the program says
"kick off" — the goal replaces program.md's NEVER-STOP prose with a Stop-hook
invariant, and the condition doubles as the run's definition of done.

## The swarm fork (mutable-state-inc/autoresearch-at-home)

SETI@home-style fork (fetched: `~/.opensrc/repos/github.com/mutable-state-inc/autoresearch-at-home/master/`,
`collab.md` is the protocol). Its coordination layer independently reinvents
the beads/agent-mail shapes: **experiment claiming** with semantic-similarity
dedup + automatic expiry (≈ `br claim` atomicity + reservation TTL);
**result sharing** publishes full source for reproducibility (≈ commit SHA in
close reason); **global best** guarded by sanity checks + read-compare-write
+ previous-best preservation + only-`keep`-results (≈ host adjudication: a
guest result can't advance shared state without passing gates); **hypothesis
exchange** — "picking up a well-reasoned hypothesis from another agent is
often the highest-value move" (≈ discovered-from beads). Design stance worth
quoting: "Git stays local. The network is additive — if it goes down, agents
continue solo." A swarm layer that degrades to solo is the right failure
polarity for any `--swarm-size N` design.

## Anti-patterns it documents (keep them)

- Letting the agent modify the eval harness = reward hacking; keep the judge
  out of the mutable surface (host-side here).
- `tee`/streaming training output into the agent context = context flood;
  always redirect to a log and grep.
- Frequent rewinds = thrash; the branch advances monotonically, rewind is a
  last resort.
- Complexity without metric gain = net loss; its "simplicity criterion"
  (a win from *deleting* code always keeps) is a good standing rule for any
  guest prompt.
