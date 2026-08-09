# kittens-saved

> One kitten dies when the agent leaves you with "just two more things."

A Claude Code plugin that counts the kittens the agent **saves** (work it does
instead of punting back to you) and gates its **escape hatch**: the agent may
only stop cleanly when nothing of *its own* is left unsaved.

## What it does

- **Stop-hook reminder.** When the agent goes to stop, a hook injects the
  kitten-reminder and the running tally. If the agent declared residual work
  that was *its own* to finish, the hook blocks the stop once and feeds the
  reminder back.
- **Escape hatch (agent-only).** Before ending a turn with leftovers, the agent
  runs `/kittens-saved:counting-saved-kittens` and declares its residual as
  `--mine K --yours M`. Granted only when `K == 0` — i.e. it left nothing of its
  own unsaved; the only leftovers are *deliberately yours* (a credential
  decision, a merge you must approve, a `rm` it cannot run).
- **Ledger.** An append-only JSONL history per session at
  `.claude/.kittens-saved/<session-id>.jsonl`.
- **Statusline segment.** `🐈 <saved> · 🙏 <waiting-on-you> · 🙀 <still-the-agent's>`.

## Components

| Component | What |
|---|---|
| `skills/counting-saved-kittens` | Self-invokable: the agent logs saves and takes the escape hatch. The discipline. |
| `skills/count` (`/kittens-saved:count`) | You: show the tally (`--scope session\|all`). |
| `skills/toggle` (`/kittens-saved:toggle on\|off`) | You: mute/arm enforcement for this session. |
| `hooks/hooks.json` | `Stop` (reminder + escape gate) and `SessionStart` (arm). |
| `scripts/kittens.py` | PEP 723, stdlib-only. All JSON/state mutation. |
| `statusline/kittens-segment.sh` | Fast bash statusline reader (no python cold start). |

## Settings (`userConfig`)

| Key | Default | Meaning |
|---|---|---|
| `scope` | `session` | `session` or `all` — statusline / default count over this session or every session. |
| `enabled` | `true` | `false` silences the reminder and statusline everywhere. |
| `debug` | `false` | `true` echoes injected content to stderr as `[kittens-saved-debug] …`. |

Per-session mute (independent of `enabled`): `/kittens-saved:toggle off`.

## Statusline wiring

Statuslines are a settings, not a plugin component. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash \"${CLAUDE_PLUGIN_ROOT}/statusline/kittens-segment.sh\""
  }
}
```

(Compose it with your existing statusline command if you already have one.)

## Install

Local dev: `claude --plugin-dir /path/to/kittens-saved`, or add the
`tiny-claude-plugins` marketplace and `claude plugin install kittens-saved`.
Hooks load at session start — restart Claude Code after installing.

## The one rule

`--mine` and `--yours` are self-reported; the referee trusts the agent's
classification. Inflating `--yours` to force a grant is lying about who owns the
work — worse than punting openly. Save a kitten only for work actually done.
