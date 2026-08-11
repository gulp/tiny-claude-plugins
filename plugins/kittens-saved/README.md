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
- **Nudges are addressed to the agent, and shown to you.** The two
  non-blocking tiers (deny and warn) emit their text on **both**
  `hookSpecificOutput.additionalContext` — the only field Claude Code injects
  back into the model — and `systemMessage`, which renders to you. This is not
  redundancy. `systemMessage` **alone is a no-op for the tier's actual target**:
  it reaches the human, who then has to relay it by hand. That was a real bug,
  found live when a human relayed one, and it hid behind the blocking tier,
  which uses `decision: block` + `reason` and always did reach the model. Tests:
  `scripts/test_kittens_nudge_reaches_model.py`.
- **Escape hatch (agent-only).** Before ending a turn with leftovers, the agent
  runs `/kittens-saved:counting-saved-kittens` and declares its residual as
  `--mine K --yours M`. Granted only when `K == 0` — i.e. it left nothing of its
  own unsaved; the only leftovers are *deliberately yours* (a credential
  decision, a merge you must approve, a `rm` it cannot run).
- **Ledger.** An append-only JSONL history per session at
  `.claude/.kittens-saved/<session-id>.jsonl` (per-project by design). The
  project is the one the session is **anchored** to, not the cwd of whatever
  call is writing: `CLAUDE_PROJECT_DIR` does not reach Bash-tool subprocesses,
  so a `save` invoked from another directory used to fork a second ledger the
  Stop hook never read. The anchor is recorded at
  `~/.claude/.kittens-saved/anchors/<session-id>`; the env var still wins when
  present (hooks carry it and hooks are the consumer). `config` prints both the
  resolved ledger dir and the anchor.
- Session mutes and deny/warn overrides live operator-global in
  `~/.claude/.kittens-saved/`, so a `toggle off` or a `blame` add holds in
  every repo.
- **Statusline segment.** `🐈 <saved> · 🙏 <waiting-on-you> · 🙀 <still-the-agent's>`.

## Components

| Component | What |
|---|---|
| `skills/counting-saved-kittens` | Self-invokable: the agent logs saves and takes the escape hatch. The discipline. |
| `skills/kittens-saved` (`/kittens <verb>`) | You: the single front door — status, stats, count, doctor, config, zen, toggle on\|off, plus human-gated blame/warn list management. |
| `hooks/hooks.json` | `Stop` (reminder + escape gate) and `SessionStart` (arm). |
| `scripts/kittens.py` | PEP 723, stdlib-only. All JSON/state mutation. |
| `statusline/kittens-segment.sh` | Fast bash statusline reader (no python cold start). |

## Settings (`userConfig`)

| Key | Default | Meaning |
|---|---|---|
| `scope` | `session` | `session` or `all` — statusline / default count over this session or every session. |
| `enabled` | `true` | `false` silences the reminder and statusline everywhere. |
| `debug` | `false` | `true` echoes injected content to stderr as `[kittens-saved-debug] …`. |

Per-session mute (independent of `enabled`): `/kittens toggle off`.

## Statusline wiring

Statuslines are a settings key, not a plugin component — so the plugin ships a
**chip installer**: `/kittens statusline install` (preview first; `--yes`
writes after you confirm). It installs a *chip*, never a takeover:

- **vacant slot** → creates a small wrapper script and points `statusLine` at it;
- **existing statusline** → the wrapper runs *your* command first (runtime
  delegation, recursion-guarded) and adds the 🐈 line after it — your prior
  value is ledgered and `statusline rm` restores it exactly;
- **ccstatusline detected** → injects a `custom-command` widget into its own
  config instead (your widgets are never touched).

`statusline status` shows per-scope wiring and which scope wins for this cwd;
`statusline render` executes the result once so you can see it before trusting
it. Installed bytes resolve the segment at runtime (newest plugin version
wins), so updates never strand the wiring. What it does under the hood is
exactly the manual recipe: point `statusLine.command` at
`statusline/kittens-segment.sh`, composed with whatever you already had.

## Install

Local dev: `claude --plugin-dir /path/to/kittens-saved`, or add the
`tiny-claude-plugins` marketplace and `claude plugin install kittens-saved`.
Hooks load at session start — restart Claude Code after installing.

## The one rule

`--mine` and `--yours` are self-reported; the referee trusts the agent's
classification. Inflating `--yours` to force a grant is lying about who owns the
work — worse than punting openly. Save a kitten only for work actually done.
