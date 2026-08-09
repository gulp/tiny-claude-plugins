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
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" escape --mine <K> --yours <M> --reason "<summary>"
```

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
