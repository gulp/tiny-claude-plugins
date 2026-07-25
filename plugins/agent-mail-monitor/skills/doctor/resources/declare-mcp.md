# Fix: declare the Agent Mail MCP server for Claude Code

The monitor itself does **not** need this — it shells out to the `am` CLI. This matters for the
_agent's_ MCP mail tools (`fetch_inbox`, `send_message`, `file_reservation_paths`, …). The doctor's
`mcp-declaration` check names one of four states for the server (canonical name `mcp-agent-mail`)
and each has a different fix — **being "declared" is not the same as being usable**:

| State                | What `claude mcp get mcp-agent-mail` shows                    | Fix                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| absent               | `No MCP server named "mcp-agent-mail"` (nonzero exit)         | declare it — see "Easiest fix" / "Declare it manually" below                                                                                                                                                                                                                                                                                                                                                       |
| `✘ Rejected`         | `Status: ✘ Rejected (see disabledMcpjsonServers in settings)` | it's declared but was rejected at an approval prompt — remove `"mcp-agent-mail"` from the `disabledMcpjsonServers` array in `.claude/settings.local.json` (project) or the user-scope equivalent, then restart `claude` or run `/reload-plugins`. Re-declaring on top of a rejection (running `am` again, `claude mcp add` again) does **not** clear it — the rejection lives in settings, not in the declaration. |
| `⏸ Pending approval` | `Status: ⏸ Pending approval (run 'claude' to approve)`        | declared but not yet approved for this session — no config edit needed; approve it at the next `claude` startup prompt, or run `/reload-plugins`                                                                                                                                                                                                                                                                   |
| `✔ Connected`        | `Status: ✔ Connected`                                         | already working — nothing to do                                                                                                                                                                                                                                                                                                                                                                                    |

## Confirm what's declared

```bash
claude mcp get mcp-agent-mail
```

A nonzero exit / "No MCP server named" → not declared here. (A server can be declared at a scope
this invocation doesn't surface — check user vs project vs local with `claude mcp list`.)

## Easiest fix: just run `am`

Per [the project's README](https://github.com/Dicklesworthstone/mcp_agent_mail_rust), launching the
server auto-detects installed coding agents (Claude Code, Codex, Gemini) and **refreshes their MCP
connections** — so starting it often wires the declaration up for you:

```bash
am                       # starts the HTTP server on 127.0.0.1:8765 + auto-configures agents
am serve-http --port 9000   # non-default port if you need one
```

## Declare it manually

Agent Mail runs as a local HTTP MCP server, **but don't assume the default
`http://127.0.0.1:8765/mcp/` path** — the port and even the path suffix are configurable server-side
(an `/api/` deployment has been seen in the wild). Confirm first:

```bash
am status --json | jq -r '.service.http_url'
```

Use the URL that command prints — not a hardcoded guess — for the scope you want. The server name
must be exactly `mcp-agent-mail` (the name the doctor check and `disabledMcpjsonServers` both key
on):

```bash
url=$(am status --json | jq -r '.service.http_url')
claude mcp add --scope project --transport http mcp-agent-mail "$url"
claude mcp add --scope user    --transport http mcp-agent-mail "$url"
```

Or hand-edit `.mcp.json` / `~/.claude/settings.json` — a ready-to-adapt raw declaration is in
`assets/mcp-agent-mail.snippet.json` next to this file. Swap in the URL from `am status --json`
before pasting; a non-default setup will differ from the file's placeholder.

## Verify

```bash
claude mcp get mcp-agent-mail   # should show Status: ✔ Connected
```
