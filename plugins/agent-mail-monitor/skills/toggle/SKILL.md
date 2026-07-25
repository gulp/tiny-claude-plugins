---
name: toggle
description: Turn the Agent Mail background monitor ON or OFF for the current session — arm or silence the watch that notifies on each new Agent Mail message addressed to $AGENT_NAME (the current check-inbox backend consumes — it marks polled mail read). Use when asked to "silence/stop the mail monitor", "stop mail notifications", "start watching my inbox", "arm the agent-mail monitor", or when mail pings are unwanted (or wanted) this session without uninstalling the plugin.
---

# Toggle Agent Mail Monitor

The `agent-mail-inbox` monitor auto-arms at session start (`when: always`) and
emits one notification per new Agent Mail message for `$AGENT_NAME`. This skill
flips it OFF (silence) or back ON within the **current session** — the plugin
stays installed either way, and it re-arms on the next session.

## Turn it OFF (silence this session)

1. List active background tasks and find the one whose label is
   `agent-mail-inbox` (its command runs `src/cli.ts monitor` via `deno`).
2. Stop that task (`TaskStop <id>`). Notifications cease immediately. Nothing is
   uninstalled; the watch re-arms next session.

## Turn it ON (arm now)

Arm the watch as a **persistent** background Monitor, using the same command the
plugin auto-arms at session start (`monitors/monitors.json`):

- **command:** `deno run --allow-run=am --allow-env --allow-read "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" monitor`
- **persistent:** `true`

If you arm it by hand where `${CLAUDE_PLUGIN_ROOT}` isn't set, substitute the
plugin's install directory for it.

The `monitor` entrypoint reads `AGENT_NAME` (the identity to watch) and
`CLAUDE_PROJECT_DIR` from the environment; it needs **`deno`** and **`am`** on
`PATH` (it parses `am`'s JSON with Zod — no `jq`). With no `AGENT_NAME` the watch
does **not** fail silently — it emits one loud notice on stdout and exits (code 3)
rather than watching a nameless inbox. If the very first `am check-inbox` poll
fails (server down, wrong identity, or auth), the watch reports the cause and exits
(code 4) instead of masquerading as a healthy-but-quiet watch; run the
`agent-mail-monitor:doctor` skill to diagnose.

### Arm with an identity mid-session

The auto-arm inherits whatever `AGENT_NAME` was in the environment at session
start — so if you set or changed your identity mid-session, the running watch is
still on the old name (or idle). A `export AGENT_NAME=…` from a later shell does
**not** reach it. Re-arm with the identity baked into the command as a prefix
(this sets it for the watch subprocess directly, regardless of session env):

- **command:** `AGENT_NAME=YourName deno run --allow-run=am --allow-env --allow-read "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" monitor`
- **persistent:** `true`

Stop the existing `agent-mail-inbox` task first (see OFF above) so you don't run
two watches against different identities.

## Notes

- **The current backend CONSUMES.** It polls `am check-inbox`, which — without
  `--direct`, whenever the am daemon is up (the default) — routes through the
  server's `fetch_inbox` and **marks returned messages read** (verified against am
  v0.3.21). So an armed monitor eats mail: a later `fetch_inbox(unread_only)` in
  this or a peer session will not re-surface a message the monitor already reported.
  Treat the notification itself as the delivery. A genuinely non-consuming FS-tail
  backend (reads the append-only canonical git-mailbox on disk) is tracked in the
  plugin beads.
- **Disable everywhere** (all sessions), not just this one:
  `claude plugin uninstall agent-mail-monitor@tiny-claude-plugins`.
