# Fix: set `AGENT_NAME` so the monitor has an identity to watch

The monitor watches the inbox for **one agent identity**. With no `AGENT_NAME`
(or `AGENT_MAIL_AGENT`) it won't guess — instead of silently watching a nameless
inbox, it emits one loud notice on stdout and exits (code 3) so the
misconfiguration is visible rather than a quiet no-op.

## Set it for the session (the durable way)

`AGENT_NAME` must be in the environment **when `claude` launches** — the monitor
reads it at session start. Exporting it mid-session from inside Claude does not
reach an already-armed monitor.

```bash
AGENT_NAME=YourName claude          # launch with the identity set
```

Use the **same** name every session — Agent Mail identities are durable, and a
new name mints a new (empty) mailbox and orphans prior reservations. Pick a
random adjective+noun style name (e.g. `PlumHare`); role-descriptive names may be
rejected on registration.

## Persist it

Add it to your shell profile or the launcher you use for swarm work:

```bash
export AGENT_NAME=YourName   # in ~/.bashrc / ~/.zshrc, or a wrapper script
```

Under tmux/WezTerm, a pane-map entry (`.claude/agent-panes.json`) can also supply
the identity so each pane shows its own name in the statusline.

## Verify

```bash
echo "$AGENT_NAME"   # non-empty
```

Then relaunch `claude` (or re-arm via the `agent-mail-monitor:toggle` skill).
