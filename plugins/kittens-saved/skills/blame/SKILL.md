---
name: blame
description: >
  Manage the kittens-saved lazy-handoff denylist — the phrases the Stop hook
  watches for in your last response. Verbs: ls, add, rm, edit, test; a bare
  phrase is a gated add. Use when you or the user catch a new "opus laziness"
  tell ("both yours", "you can take it from here", a handback heading that
  contradicts the tally), want to list/remove/test denylist entries, or run
  blame. Adding is HUMAN-GATED: never write without confirming.
argument-hint: "[ls | add \"<phrase>\" | rm \"<phrase>\" | edit | test \"<text>\"]"
allowed-tools: Bash(python3:*), AskUserQuestion
disable-model-invocation: true
---

# kittens-saved:blame

Front door to the denylist. The bundled script is the referee; you drive the
**human gate**. Script:
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" blame …`

## Grammar (pass-style)

| form | does |
|---|---|
| `blame ls` | list entries — built-in defaults (read-only) + numbered overrides |
| `blame test "<text>"` | dry-run the matcher: which patterns fire on this text (writes nothing) |
| `blame rm "<phrase>"` | remove an override entry (defaults can't be removed) |
| `blame edit` | open the override file in `$EDITOR` (human at a terminal only) |
| `blame add "<phrase>"` / bare `blame "<phrase>"` | add — **PREVIEW ONLY** unless `--yes` |

`--regex` treats an added phrase as a pattern, not a literal. `ls`/`test` take `--json`.

## The gate — adding NEVER writes blind

`blame "<phrase>"` (or `add`) **previews and writes nothing**. Writing needs
`--yes`. **You must not pass `--yes` until the human has confirmed** the exact
phrase. Run the preview, show it, confirm with `AskUserQuestion`, then write:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" blame "still waiting on you"          # preview
# ↑ show output, get a yes via AskUserQuestion, THEN:
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" blame "still waiting on you" --yes     # write
```

## Multiple candidates → checklist

When the text to blame is a multi-line blob or a response with several candidate
hand-back clauses, **do not blame the whole blob** (a 200-char pattern never
re-matches and pollutes the list). Instead:

1. **Split** the text into clauses (newlines, list markers, sentence ends).
2. **Drop already-caught clauses** — run `blame test "<clause>"` on each and
   discard any that already trip (adding them is a no-op).
3. **Flag** the hand-back-ish survivors (contain "you" / "left" / "remaining" /
   "waiting", or a colon-terminated heading) and **tighten** each to a short,
   reusable phrase (e.g. the heading `Still waiting on you:` → `still waiting on you`).
4. Present the survivors as an **`AskUserQuestion` multi-select checklist** —
   the human ticks which to add (and may edit).
5. For each ticked phrase, write it: `blame add "<phrase>" --yes`.

If there is exactly one obvious candidate, still preview + confirm once — just
skip the checklist.

## Rules

- **Never `--yes` without an explicit human tick.** The whole point of this
  redesign is that nothing reaches the denylist blind.
- **Tighten, don't dump.** Add the shortest phrase that captures the tell, not
  the whole message. Specific blobs are dead weight.
- Print the script's output verbatim; report `test` results and `rm` counts as-is.
