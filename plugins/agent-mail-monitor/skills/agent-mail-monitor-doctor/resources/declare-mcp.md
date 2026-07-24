# Fix: declare the Agent Mail MCP server for Claude Code

The monitor itself does **not** need this — it shells out to the `am` CLI. This
matters for the *agent's* MCP mail tools (`fetch_inbox`, `send_message`,
`file_reservation_paths`, …). If those tools are missing, the server isn't
declared in the scope this session sees.

## Confirm what's declared

```bash
claude mcp list | grep -i agent-mail
```

No line → not declared here. (A server can be declared at a scope a given
`claude mcp list` invocation doesn't surface — check user vs project vs local.)

## Easiest fix: just run `am`

Per [the project's README](https://github.com/Dicklesworthstone/mcp_agent_mail_rust),
launching the server auto-detects installed coding agents (Claude Code, Codex,
Gemini) and **refreshes their MCP connections** — so starting it often wires the
declaration up for you:

```bash
am                       # starts the HTTP server on 127.0.0.1:8765 + auto-configures agents
am serve-http --port 9000   # non-default port if you need one
```

## Declare it manually

Agent Mail runs as a local HTTP MCP server (default `http://127.0.0.1:8765/mcp/`):

```bash
# pick the scope you want:
claude mcp add --scope project --transport http agent-mail http://127.0.0.1:8765/mcp/
claude mcp add --scope user    --transport http agent-mail http://127.0.0.1:8765/mcp/
```

Or hand-edit `.mcp.json` / `~/.claude/settings.json` — a ready-to-adapt raw
declaration is in `assets/mcp-agent-mail.snippet.json` next to this file. Confirm
the host/port against `am status --json` (`.service.http_url`) before pasting; a
non-default setup will differ.

## Verify

```bash
claude mcp list | grep -i agent-mail   # should now show it as connected
```
