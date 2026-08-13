---
name: counting-saved-kittens
description: >
  Records a kitten saved and gates the agent's escape hatch. Invoke this
  BEFORE ending any turn that would leave the human with residual work — to
  honestly declare what is yours to finish versus theirs, and to log the items
  you did instead of punting. Use whenever you catch yourself about to write
  "just two more things", "left for you", "next steps for you", "you should
  now…", or a hand-back list; when the user asks "how many kittens saved",
  "am I punting", "take the escape hatch"; and at the end of substantive turns.
  Self-invoke it proactively — it is the anti-lazy-handoff discipline.
disable-model-invocation: false
---

# counting-saved-kittens

You are being held to one rule: **a kitten dies when you leave the human with
"just two more things."** This skill is the ledger and the referee. The bundled
PEP 723 script owns all state mutation; you just call it.

Script: `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py"` (stdlib-only; `uv
run` also works). State is an append-only JSONL history per session under
`.claude/.kittens-saved/`.

## When you DID work you could have punted — save the kitten

Every time you complete a savable item — something you could have handed back
with "you should do X" but instead did yourself — log it:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" save --reason "<what you did>"
```

Use `--n <N>` if one action cleared several. Keep the reason concrete
("committed the groq model swap", not "made progress").

## Before you end a turn with residual items — take the escape hatch

Do NOT end a turn on a hand-back list without running this. Classify every
residual item into two buckets, honestly:

- **mine** — items that are *yours* to do and you have not done (a punt).
- **yours** — items that are *deliberately the human's* (a credential decision,
  a merge they must approve, a `rm` you cannot run, a judgment only they hold).

Then declare:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" escape \
  --mine <K> --yours <M> --reason "<summary>" \
  --yours-item "<one thing that is theirs>" --yours-item "<the next one>"
```

**File each human item as a task too, prefixed `[human] `.** Before (or right
after) the escape, call `TaskCreate` once per human-owned item with the subject
`[human] <the item>`. The point is that the human sees what they are holding up
in the *same* list as everything else in flight, with ownership legible on the
item — a separate place for their share is a place they have to remember to go
and check.

`escape` is the backstop, not the primary: it mirrors any `--yours-item` you
passed into the task list itself, deduped by subject, so a compliant agent
costs nothing (the task already exists) and a forgetful one still leaves the
human a usable list.

**Do not lean on the backstop — it cannot reach the Ctrl+T overlay.** Measured
2026-08-13: `TaskList` and the injected task reminder re-read the tasks
directory per call, so a file written by the script is visible to *you*
immediately. The TUI overlay does not; it refreshes on a harness-driven task
mutation, not on open. Since `escape` runs at the end of a turn, when no
further tool call is coming, a script-only filing leaves the human's own view
stale until something else touches a task — possibly the next session. The
`TaskCreate` call is what puts the item in front of them, which is the entire
point of filing it. Never file a `--mine-item` as a task — your own residual
is not the human's to see on their list; if it is non-empty you should be doing
it.

**Restate a carried-over item VERBATIM.** Dedup is exact-subject, because the
ledger has no identity across declarations and there is nothing else to match
on. So re-wording an item you already declared — adding a status note, tightening
the phrasing, appending "(in progress)" — files a SECOND task for the same
obligation. Copy the previous wording character-for-character for anything still
outstanding, and put the freshness elsewhere (the `--reason`, or a `TaskUpdate`
on the existing task). Observed 2026-08-13: an agent restated one item with a
parenthetical and immediately duplicated it.

**Name every `--yours` item.** `--yours-item` is repeatable and is what
`/kittens mine` reads back to the human when they ask what is waiting on them.
A bare count is not an answer to that question — it survives no compaction and
no session boundary, so "waiting on you: 2" decays into two things nobody can
name. Pass one `--yours-item` per unit counted in `--yours`; `mine` says
outright when the list is shorter than the count, so under-naming shows up
rather than passing silently.

- **Exit 0 (GRANTED)** — `mine == 0`. You left nothing of yours unsaved; the
  only residual is genuinely the human's. You may stop cleanly.
- **Exit 3 (DENIED)** — `mine > 0`. You are punting. **Go do those items now**,
  `save` each, then re-run `escape`. Do not narrate the denial and stop anyway —
  that is the exact behavior this exists to stop. Reclassify to `--yours` only
  if the item is *honestly* the human's, never to dodge the work.

The Stop hook reads your last declaration: a granted escape lets you stop with a
soft reminder; a denied one blocks the stop once and feeds the reminder back.

## Honesty is the whole mechanism

`--mine` and `--yours` are self-reported. The referee cannot see your todo list;
it trusts your classification. Inflating `--yours` to force a grant is lying to
the human about who owns the work — the one failure mode worse than punting
openly. Count a kitten only for work actually done; declare `mine` truthfully.
