---
name: relay-to-chatgpt
description: >-
  Package a session's residual unknowns into a copy-pasteable ChatGPT
  deep-research prompt, then verify what comes back before acting on it. Use when
  local ground truth is exhausted and a question is still open — "give me a prompt
  for ChatGPT", "relay this to deep research", "what are the known unknowns here",
  "I'll go ask ChatGPT" — or when research has come back and needs checking against
  live state before you trust it: "--pull", "did my research land", "check the
  inbox", "what came back from ChatGPT".
allowed-tools: Read Write Grep Glob WebFetch Bash(rg:*) Bash(fd:*) Bash(git:*) Bash(vt:*) Bash(uv:*)
argument-hint: "[topic] | --pull (default: this session's open unknowns)"
---

# Relay to ChatGPT

Turn what this session could not settle locally into an external research prompt,
then check the answer when it returns.

## Inputs
- `$topic`: Optional. Narrows or overrides the subject. Bare invocation harvests
  the open unknowns already established in this session.
- `--pull`: Skip the outbound leg. Enter at Step 4 to see what has come back.

## Available scripts
- **`scripts/pull-inbox.py`** (PEP 723 / `uv run`, stdlib only) — list
  `raw/inbox/ChatGPT-*.md` newest-first with title, arrival time, conversation
  URL and prompt excerpt, flagging which the graph has already consumed.
  `--since ISO` filters by arrival, `--match TERMS` by title/prompt text,
  `--all` includes processed ones, `--format table` for reading.
  Exit 0 = matches, 1 = none, 2 = error.

## Steps

### 1. Harvest the unknowns
Collect what this session left open. Prefer unknowns you hit and named yourself
over ones invented now — a question that arose from real work is sharper than one
retrofitted to fill a prompt. With `$topic`, scope to that subject.

**Success criteria**: Each open question traces to a specific moment where
evidence ran out.

### 2. Exhaust local ground truth — HARD GATE
Answer each question locally first: the source, the installed binary, `--help`,
`git log`, the real file. Then **subtract every question local evidence closed**.

This is what makes the prompt worth sending. A question a `rg` closes in ten
seconds costs minutes of research and returns a worse answer than the grep.

Keep the near-misses — residual doubt with a stated limit ("static read of a
minified bundle; a missed call site is possible") is precisely what belongs in
the prompt.

**Rules**: Never send a question you have not tried locally. Never present static
analysis as proof.

**Success criteria**: Every surviving question carries a one-line note on what
local evidence established and why it falls short.

### 3. Write the prompt
Terse and imperative. Six moves, in order:

1. **Pin target and version** — an unversioned question gets an answer about a
   different release, undetectably.
2. **Name primary sources in priority order** (docs, changelog, issue tracker,
   spec repo). Unsaid, the researcher weights SEO content equally.
3. **Install the epistemic guard** — documentation is evidence of *intent* only;
   label each runtime claim doc / maintainer statement / reproduced observation,
   with the version observed.
4. **State the unknowns as one paragraph of direct questions**, not a bulleted
   brief. Staying relayable forces out whatever Step 2 should have cut.
5. **Contract the output** — per-question answer, sources, explicit confidence,
   and a standing instruction to say plainly where no public information exists
   rather than reason from plausibility. Filling a gap with fluent prose is the
   default failure.
6. **Ask the bet-invalidating question last** — the one deciding whether work
   already committed is durable or a temporary patch.

Emit one uninterrupted block with no commentary inside it, so it survives a
copy-paste. Caveats go after the block.

**Success criteria**: A block the user pastes unedited, naming a version, its
sources, its epistemic guard, and its output contract.

### 4. Pull what came back [human relays]
The user runs the prompt; the export lands in `raw/inbox/ChatGPT-<title>.md`.
`--pull` enters here directly.

```bash
uv run scripts/pull-inbox.py --format table              # unprocessed, newest first
uv run scripts/pull-inbox.py --match "yaml frontmatter"  # narrow by subject
uv run scripts/pull-inbox.py --since 2026-07-27T21:00:00 # arrived after a point
```

Match candidates to the outbound prompt by the **prompt excerpt**, not the title —
the exporter titles conversations itself, so the title is ChatGPT's paraphrase
while the excerpt is your own text coming back verbatim. An excerpt opening with
words you wrote is a definite match.

Then **offer the shortlist and let the human pick what to read**. Exports run tens
of KB; reading all of them to find the relevant one spends the context you need
for Step 5. Name each candidate's title, arrival time and what it appears to
answer.

**Two signals, both reported, neither substituting for the other**: arrival time
answers *what landed since I last looked*; graph citation answers *has this been
consumed*. A fresh export may already be processed and an old one may never have
been. (Do not collapse arrival to date granularity — a batch of same-day exports
has distinct, meaningful mtimes, and truncating them manufactures a false tie.)

**Rules**: `raw/` is human canon — read it, never write there.

**Success criteria**: Candidates listed with arrival time and processed state; the
human has chosen which to read; the chosen document is read in full.

### 5. Verify before believing
Re-check every claim against live state. A research doc is built to sound
authoritative; fluency is not evidence. Hunt specifically for:

- **Doc-based reasoning dressed as runtime fact** — a confident behavioral claim
  sourced only to a documentation page.
- **Commands that cannot run here** — heredocs, `>` redirects to `/home` or
  dynamic paths, `rm -rf`/`mv` under `/home`. All blocked by the `dcg` guard;
  research routinely suggests them.
- **Cited issue numbers and URLs** — fetch them. Plausible references are cheap
  to fabricate.
- **Claims contradicting local evidence** — record both sides. The disagreement
  is the finding; do not smooth to consensus.

**Success criteria**: Each claim marked verified / contradicted / unverifiable,
naming the command or file that settled it.

### 6. Offer to compile into the graph [human]
**Offer, don't auto-write** — per MEMORY.md's finalize-time reflex, selection
stays a human bit. Name the route and the granularity you'd use, then wait.

Route by granularity:

- **Atomic, single-claim** → a `nuggets/` note at `lifecycle: raw`. Admit
  generously once accepted; the lifecycle is the selection gate, so this is a
  cheap reversible capture, not a claim on the record.
- **A whole argument** → a `design/` note, `vx_review: unreviewed`, with a seeded
  `## Connections` block of typed links.

On acceptance, carry provenance: the research URL as `source:`, what was verified
locally and how, what stayed unresolved. **Cite the command, not the number** —
frozen versions and counts go stale silently.

**Human checkpoint**: Compiling is the whole point of the round trip, so make the
offer concrete — the route, the note title, the claim it would carry — rather
than a bare "want me to write this up?" A vague offer gets declined by default,
and the finding dies in the transcript.

**Rules**: Never write `raw/` or `journal/`. Never flip `vx_review` past
`unreviewed`. Declining is a valid outcome; say what was dropped so the next
session can find it.

**Success criteria**: A concrete offer was made and answered. If accepted, a
stamped note exists in an agent-owned folder with `vt lint` passing and
unresolved questions recorded as unresolved.

## Failure modes

- **Outsourcing a grep** — sending a question the local source answers, because
  sending is easier than reading. Step 2 exists for this.
- **A prompt that reads as a brief** — bulleted context flatters the reader and
  dilutes the questions.
- **Dropping the unresolved** — "no public information exists" is a durable
  result. Losing it means the next session re-asks the question.
