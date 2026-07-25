# Fix: set `AGENT_NAME` so the monitor has an identity to watch

The monitor watches the inbox for **one agent identity**. With no `AGENT_NAME`
(or `AGENT_MAIL_AGENT`) it won't guess — instead of silently watching a nameless
inbox, it emits one loud notice on stdout and exits (code 3) so the
misconfiguration is visible rather than a quiet no-op.

## Check for an existing identity first — reuse, don't mint

A project often already has one or more registered identities. Minting a new
name mints a new **empty** mailbox and orphans any reservations the old
identity held, so the right move is usually to **reuse** one, not add another.

Running `agent-mail-monitor:doctor` (or `deno task -q doctor` from the plugin
source) surfaces exactly this: when `AGENT_NAME` is unset, its `identity`
check lists every identity currently registered in this project (name, model,
last-active) so you can pick one. You can also ask directly:

```bash
am agents list --project "$(pwd)"
```

If nothing useful comes back (a genuinely fresh project), mint a new one —
see below.

## Set it for the session (the durable way)

`AGENT_NAME` must be in the environment **when `claude` launches** — the monitor
reads it at session start. Exporting it mid-session from inside Claude does not
reach an already-armed monitor.

```bash
AGENT_NAME=YourName claude          # launch with the identity set
```

Use the **same** name every session — Agent Mail identities are durable, and a
new name mints a new (empty) mailbox and orphans prior reservations. Pick a
random adjective+noun style name — e.g. `PlumHare`, `BlueLake`, `CrimsonBear`;
these are **illustrative samples, not real identities to register or assume
exist** — role-descriptive names may be rejected on registration. Run the
doctor check above first to see what's *actually* registered in this project
before minting a fresh adjective+noun.

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
