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

## A mutating `am` op times out (contact approve / mail reply) — DB-lock contention

The Agent Mail server holds an exclusive activity lock while it runs a mutating
op. A second mutating call — or, under load, even a read on the MCP path — can
then time out waiting on that lock. From the outside this looks identical to a
wedged/down server (no timely response), but the fix is different: the server
isn't broken, it's **busy**.

**Verify state, don't blind-retry.** Retrying the same mutating call while the
lock is still held just adds another contender; it doesn't clear the lock, and
a string of retries can make a transient busy period look like a hang. Before
retrying:

```bash
"${CLAUDE_PLUGIN_ROOT}"/skills/diagnose-agent-mail-service/scripts/diagnose.sh
```

Read the `VERDICT`: `HEALTHY` (or `DEGRADED`) with the process active and
Main-PID-owning `:8765` means the server is up, and the timeout is very likely
transient lock contention — wait a beat and retry **once**, don't loop. Only
`WEDGED` / `DEAD` / `ORPHAN` calls for the restart/kill recovery in
`../../diagnose-agent-mail-service/resources/recovery.md`. There's no separate
per-lock owner-pid to report — the unit's Main PID (from the `systemd` probe)
is the server process holding it; if the *same* verdict keeps coming back busy
across several checks spaced a few seconds apart, that's the signal it's a real
hang, not a blip, and worth escalating rather than continuing to retry.
