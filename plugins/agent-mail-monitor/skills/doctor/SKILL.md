---
name: doctor
description: Diagnose why the Agent Mail monitor isn't working and guide the user through fixing it — checks the `am` CLI, `jq`, `curl` server health, the agent-mail MCP declaration, and `AGENT_NAME`. Use when the mail monitor never notifies, when setting the plugin up for the first time, or when asked to "check agent-mail prerequisites", "why is the mail monitor silent", or "is agent-mail healthy".
---

# Agent Mail Monitor — Doctor

Runs a read-only preflight over everything the `agent-mail-monitor` plugin depends on, then walks
the user through any failure. It changes nothing — every check is a probe.

## Run the checks

```bash
"${CLAUDE_PLUGIN_ROOT}"/skills/doctor/scripts/doctor.sh
```

Each line is `[PASS] / [WARN] / [FAIL] <check> — <detail>`, and failing checks print
`→ .../resources/<file>`. The final line is `SUMMARY pass=<n> warn=<n> fail=<n>`.

**Exit codes** (so an agent can branch on the result without parsing the summary):

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | all checks passed — no warnings, no failures                                    |
| `1`  | warnings only (e.g. server down but the CLI still reads state; no `AGENT_NAME`) |
| `2`  | a hard failure — `am`, `jq`, or `curl` is missing; the monitor cannot run       |
| `64` | invalid arguments (usage error)                                                 |

## What each check means, and how to guide the fix

| Check             | Meaning                                                                                                                                                                 | If it fails, read              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `am-cli`          | the `am` (Agent Mail) CLI the monitor polls                                                                                                                             | `resources/install-prereqs.md` |
| `jq`              | JSON parser the watch script uses                                                                                                                                       | `resources/install-prereqs.md` |
| `server`          | the Agent Mail HTTP endpoint answers (a live server returns any code; `000` = down)                                                                                     | `resources/server-down.md`     |
| `health`          | `am health` verdict — surfaces DB/archive drift even when the port is up                                                                                                | `resources/server-down.md`     |
| `mcp-declaration` | `claude mcp get mcp-agent-mail`'s exact state — absent / ✘ Rejected / ⏸ Pending approval / ✔ Connected — needed for the agent's MCP mail tools, **not** for the monitor | `resources/declare-mcp.md`     |
| `agent-name`      | `AGENT_NAME` is set — the identity the monitor watches; unset ⇒ it idles                                                                                                | `resources/set-agent-name.md`  |

**When a check fails:** open the resource file it points to, read the short fix, and give the user
the exact command(s) for their case — don't run installs or config edits on their behalf without
asking. The `mcp-declaration` fix has a ready-to-adapt server snippet in
`assets/mcp-agent-mail.snippet.json`.

## Severity

- **`am-cli` / `jq` fail** → the monitor cannot run at all. Fix first.
- **`server` / `health` warn** → the CLI can often still read state directly, but notifications may
  lag or the DB may need `am doctor`.
- **`mcp-declaration` warn** → the _monitor_ is unaffected; only the agent's MCP mail tools
  (`fetch_inbox`, `send_message`) need it. A `✘ Rejected` state needs a settings-file edit
  (`declare-mcp.md`), not a fresh declaration — re-declaring on top of a rejection is a dead end.
- **`agent-name` warn** → with no identity the monitor does not idle silently; it emits a loud
  notice and exits (code 3) until an `AGENT_NAME` exists.
