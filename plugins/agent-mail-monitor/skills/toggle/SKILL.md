---
name: toggle
description: Turn the Agent Mail background monitor ON or OFF for the current session — arm or silence the watch that notifies on each new Agent Mail message addressed to $AGENT_NAME (the backend tails the durable git-mailbox on disk and never marks mail read). Use when asked to "silence/stop the mail monitor", "stop mail notifications", "start watching my inbox", "arm the agent-mail monitor", or when mail pings are unwanted (or wanted) this session without uninstalling the plugin.
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
`CLAUDE_PROJECT_DIR` from the environment; it needs **`deno`** on `PATH` (and
**`am`** for product mode / the doctor cross-check — the FS watch itself only
reads the git-mailbox on disk). With no `AGENT_NAME` the watch does **not** fail
silently — it emits one loud notice on stdout and exits (code 3) rather than
watching a nameless inbox. An empty/missing inbox is a legitimate steady state
(fresh identity, no mail yet): the watch arms cleanly, warns once, and stays
live rather than failing; run the `agent-mail-monitor:doctor` skill if you
suspect a real misconfiguration (wrong root/agent/project) instead.

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

- **The backend is genuinely non-consuming.** It tails the append-only canonical
  git-mailbox on disk (plain OS file reads — see `src/core/mailbox.ts`), not
  `am check-inbox`. `check-inbox`'s consuming daemon path (it marks returned
  messages read, verified against am v0.3.21) has been retired from this
  notification path entirely (`tcp-p0x.16.4`); nothing here touches `read_ts`.
  Still, treat a notification as the delivery — it's the first time you're told
  about that mail, not a re-fetchable unread flag.
- **Disable everywhere** (all sessions), not just this one:
  `claude plugin uninstall agent-mail-monitor@tiny-claude-plugins`.
