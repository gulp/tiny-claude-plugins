---
name: toggle
description: Turn the Agent Mail background monitor ON or OFF for the current session — arm or silence the read-only watch that notifies on each new Agent Mail message addressed to $AGENT_NAME. Use when asked to "silence/stop the mail monitor", "stop mail notifications", "start watching my inbox", "arm the agent-mail monitor", or when mail pings are unwanted (or wanted) this session without uninstalling the plugin.
---

# Toggle Agent Mail Monitor

The `agent-mail-inbox` monitor auto-arms at session start (`when: always`) and
emits one notification per new Agent Mail message for `$AGENT_NAME`. This skill
flips it OFF (silence) or back ON within the **current session** — the plugin
stays installed either way, and it re-arms on the next session.

## Turn it OFF (silence this session)

1. List active background tasks and find the one whose command runs
   `mail-monitor.sh` (or `watch-mail.sh`) — its label is `agent-mail-inbox`.
2. Stop that task (`TaskStop <id>`). Notifications cease immediately. Nothing is
   uninstalled; the watch re-arms next session.

## Turn it ON (arm now)

Arm the watch as a **persistent** background Monitor:

- **command:** `"${CLAUDE_PLUGIN_ROOT}"/scripts/mail-monitor.sh`
- **persistent:** `true`

The entrypoint reads `AGENT_NAME` (the identity to watch) and `CLAUDE_PROJECT_DIR`
from the environment; it needs `am` and `jq` on `PATH`. With no `AGENT_NAME` the
watch does **not** fail silently — it emits one loud notice on stdout and exits
(code 3) rather than watching a nameless inbox. Set one at launch:
`AGENT_NAME=YourName`. If the very first `am check-inbox` poll fails (server down,
wrong identity, or auth), the watch reports the cause and exits (code 4) instead
of masquerading as a healthy-but-quiet watch; run the `agent-mail-monitor:doctor`
skill to diagnose.

## Notes

- **Read-only.** It polls `am check-inbox`, which does not mark messages read, so
  toggling never consumes mail out from under a later `fetch_inbox`.
- **Disable everywhere** (all sessions), not just this one:
  `claude plugin uninstall agent-mail-monitor@tiny-claude-plugins`.
