---
name: warn
description: >
  Manage the kittens-saved WARNLIST — the soft tier. Where the denylist catches
  high-confidence punts with a nudge, the warnlist catches lower-confidence
  style/sycophancy tells with a gentle [i] reminder that teaches. Each entry is
  {matcher, reason, escape}. Verbs: ls, add, rm, test. Use when you or the user
  spot a soft tell worth a heads-up but not a hard gate ("I'll…", "you're
  absolutely right", "the sharpest point"), or run warn. Adding
  is HUMAN-GATED.
argument-hint: "[ls | test \"<text>\" | add \"<matcher>\" | rm \"<matcher>\"]"
allowed-tools: Bash(python3:*), AskUserQuestion
disable-model-invocation: true
---

# kittens-saved:warn

The soft tier's front door. The script is the referee; you drive the human gate.
Script: `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" warn …`

## Deny vs. warn — pick the right tier

- **Denylist (`blame`)** — high-confidence **punts**. Fires a
  nudge to *act*. Bare pattern.
- **Warnlist (here)** — lower-confidence **style/sycophancy** tells. Fires a
  gentle `[i]` that *teaches*, never blocks, capped per session. Carries a
  `reason` (why it reads as a tell) and an `escape` (when it's fine).

If a phrase is a coin-flip — it fires on honest behaviour as much as on a tell
(e.g. `deliberately did not`, which also matches an honest scope disclosure) —
it belongs **here**, not in the denylist.

## Grammar

| form | does |
|---|---|
| `warn ls` | list entries — built-in defaults (read-only) + numbered overrides |
| `warn test "<text>"` | dry-run: which warn entries fire on this text, with reason/escape |
| `warn rm "<matcher>"` | remove an override entry |
| `warn add "<matcher>" --reason "…" --escape "…"` | add — **PREVIEW ONLY** unless `--yes` |

`--regex` treats the matcher as a pattern, not a literal. A **bare** arg
(`warn "<text>"`) is `test`, not add — an add needs a reason and an escape, which
can't be inferred from a phrase.

## The gate — adding NEVER writes blind, and always needs reason + escape

`warn add` **previews and writes nothing** without `--yes`, and an entry is
useless without its two fields:

1. Draft the **matcher** (tighten to the shortest reusable form), a one-line
   **reason** (why it reads as a tell), and an **escape** (the honest case where
   it's fine — this is prose the model self-judges, e.g. "if you actually
   verified it, ignore").
2. Run the **preview** and show it.
3. Confirm with **`AskUserQuestion`** (matcher + reason + escape). Only on an
   explicit yes:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" warn add "I'll" \
  --reason "often precedes a deferral" \
  --escape "if you just did it, ignore" --yes
```

## Rules

- **Never `--yes` without an explicit human tick**, and never add a matcher
  without a `reason` and an `escape` — a bare warn is noise.
- **Tighten the matcher.** Shortest phrase that captures the tell.
- Print the script's output verbatim.
