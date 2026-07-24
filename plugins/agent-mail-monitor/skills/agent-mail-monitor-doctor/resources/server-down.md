# Fix: Agent Mail server not responding / unhealthy

Two distinct situations — the doctor's `server` and `health` checks.

## `server` warns (no HTTP response, `000`)

The Agent Mail HTTP endpoint (default `http://127.0.0.1:8765/mcp/`) isn't
answering. The `am` CLI can often still read the local SQLite DB directly, so the
monitor may keep working — but a running daemon is the healthy state.

```bash
am status --json | jq '{service, runtime}'   # is a server listening? where?
```

Start / manage the server per the mcp-agent-mail project's docs (it may run as a
user service, or be launched on demand by the MCP host). If it's meant to be a
systemd user service:

```bash
systemctl --user status agent-mail-server   # adjust to the real unit name
systemctl --user start  agent-mail-server
```

## `health` warns (`overall` not healthy)

The port is up but `am health` flags DB/archive drift. Run the native repair
path — it is the authority, not this doctor:

```bash
am doctor check            # diagnose
am doctor archive-verify   # verify the git-backed archive vs SQLite
am health --json | jq '{overall, health_level, _alerts, _actions}'
```

Follow the `_actions` list `am health` prints — it names the exact next commands
for the specific drift it found.
