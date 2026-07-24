---
name: agent-mail-monitor-doctor
description: Diagnose why the Agent Mail monitor isn't working and guide the user through fixing it — checks the `am` CLI, `jq`, `curl` server health, the agent-mail MCP declaration, and `AGENT_NAME`. Use when the mail monitor never notifies, when setting the plugin up for the first time, or when asked to "check agent-mail prerequisites", "why is the mail monitor silent", or "is agent-mail healthy".
---

# Agent Mail Monitor — Doctor

Runs a read-only preflight over everything the `agent-mail-monitor` plugin
depends on, then walks the user through any failure. It changes nothing — every
check is a probe.

## Run the checks

```bash
"${CLAUDE_PLUGIN_ROOT}"/skills/agent-mail-monitor-doctor/scripts/doctor.sh
```

Each line is `[PASS] / [WARN] / [FAIL] <check> — <detail>`, and failing checks
print `→ .../resources/<file>`. The final line is
`SUMMARY pass=<n> warn=<n> fail=<n>`. The script exits non-zero only on a **hard**
failure (missing `am`, `jq`, or `curl`); `[WARN]`s exit 0.

## What each check means, and how to guide the fix

| Check | Meaning | If it fails, read |
|---|---|---|
| `am-cli` | the `am` (Agent Mail) CLI the monitor polls | `resources/install-prereqs.md` |
| `jq` | JSON parser the watch script uses | `resources/install-prereqs.md` |
| `server` | the Agent Mail HTTP endpoint answers (a live server returns any code; `000` = down) | `resources/server-down.md` |
| `health` | `am health` verdict — surfaces DB/archive drift even when the port is up | `resources/server-down.md` |
| `mcp-declaration` | agent-mail is registered in `claude mcp list` — needed for the agent's MCP mail tools, **not** for the monitor | `resources/declare-mcp.md` |
| `agent-name` | `AGENT_NAME` is set — the identity the monitor watches; unset ⇒ it idles | `resources/set-agent-name.md` |

**When a check fails:** open the resource file it points to, read the short fix,
and give the user the exact command(s) for their case — don't run installs or
config edits on their behalf without asking. The `mcp-declaration` fix has a
ready-to-adapt server snippet in `assets/mcp-agent-mail.snippet.json`.

## Severity

- **`am-cli` / `jq` fail** → the monitor cannot run at all. Fix first.
- **`server` / `health` warn** → the CLI can often still read state directly, but
  notifications may lag or the DB may need `am doctor`.
- **`mcp-declaration` warn** → the *monitor* is unaffected; only the agent's MCP
  mail tools (`fetch_inbox`, `send_message`) need it.
- **`agent-name` warn** → the monitor arms but stays idle by design until an
  identity exists.
