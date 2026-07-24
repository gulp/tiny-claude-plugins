#!/usr/bin/env bash
# agent-mail-monitor-doctor — check the prerequisites the mail monitor depends on
# and point at the fix guide for each failure. Read-only: probes state, changes
# nothing. Emits one `[PASS]/[WARN]/[FAIL] <check> — <detail>` line per check,
# with `→ resources/<file>` where a fix guide exists, then a summary line
# `SUMMARY pass=<n> warn=<n> fail=<n>`. The invoking skill reads the pointed
# resource to walk the user through the fix.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_root=$(dirname -- "$here")

pass=0 warn=0 fail=0
ok()   { printf '[PASS] %s — %s\n' "$1" "$2"; pass=$((pass+1)); }
w()    { printf '[WARN] %s — %s\n    → %s/resources/%s\n' "$1" "$2" "$skill_root" "$3"; warn=$((warn+1)); }
bad()  { printf '[FAIL] %s — %s\n    → %s/resources/%s\n' "$1" "$2" "$skill_root" "$3"; fail=$((fail+1)); }

have() { command -v "$1" >/dev/null 2>&1; }

# 1. am CLI — the monitor polls `am check-inbox`; without it nothing works.
if have am; then
  amver=$(am --version 2>/dev/null | head -1)
  ok "am-cli" "${amver:-am present} ($(command -v am))"
else
  bad "am-cli" "the Agent Mail 'am' CLI is not on PATH" "install-prereqs.md"
fi

# 2. jq — the watch script parses `am check-inbox --json` with jq.
if have jq; then
  ok "jq" "$(command -v jq)"
else
  bad "jq" "'jq' is not on PATH (the watch parses JSON with it)" "install-prereqs.md"
fi

# 3. Agent Mail server reachability (curl). A live MCP endpoint answers any
#    method (often 405/406 to a bare GET); only a dead server gives 000.
url=http://127.0.0.1:8765/mcp/
if have am && have jq; then
  u=$(am status --json 2>/dev/null | jq -r '.service.http_url // empty' 2>/dev/null)
  [ -n "$u" ] && url=$u
fi
if have curl; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)
  if [ "$code" = "000" ] || [ -z "$code" ]; then
    w "server" "no HTTP response from $url (server may be stopped — the CLI can still read SQLite directly)" "server-down.md"
  else
    ok "server" "responds at $url (HTTP $code)"
  fi
else
  w "server" "'curl' not on PATH — cannot probe $url" "install-prereqs.md"
fi

# 4. Native health verdict (am health). Informational; surfaces DB/archive drift.
if have am && have jq; then
  hj=$(am health --json 2>/dev/null)
  overall=$(printf '%s' "$hj" | jq -r '.overall // "unknown"' 2>/dev/null)
  level=$(printf '%s' "$hj" | jq -r '.health_level // "unknown"' 2>/dev/null)
  if [ "$overall" = "healthy" ] || [ "$level" = "green" ]; then
    ok "health" "am health: overall=$overall level=$level"
  else
    w "health" "am health: overall=$overall level=$level — run 'am doctor check'" "server-down.md"
  fi
fi

# 5. Agent Mail MCP server declared for Claude Code. The monitor does NOT need
#    this (it uses the am CLI), but your agent's fetch_inbox/send_message MCP
#    tools do — so a missing declaration is a WARN, not a hard fail.
if have claude; then
  if timeout 20s claude mcp list 2>/dev/null | grep -qiE 'agent.?mail'; then
    ok "mcp-declaration" "an agent-mail MCP server is declared in 'claude mcp list'"
  else
    w "mcp-declaration" "no agent-mail server in 'claude mcp list' — the monitor still works, but MCP mail tools won't" "declare-mcp.md"
  fi
else
  w "mcp-declaration" "'claude' not on PATH — cannot enumerate MCP servers" "declare-mcp.md"
fi

# 6. AGENT_NAME — the identity the monitor watches. Unset → the monitor idles.
if [ -n "${AGENT_NAME:-}" ]; then
  ok "agent-name" "AGENT_NAME=$AGENT_NAME"
elif [ -n "${AGENT_MAIL_AGENT:-}" ]; then
  ok "agent-name" "AGENT_MAIL_AGENT=$AGENT_MAIL_AGENT"
else
  w "agent-name" "no AGENT_NAME / AGENT_MAIL_AGENT — the monitor stays idle until one is set" "set-agent-name.md"
fi

printf 'SUMMARY pass=%d warn=%d fail=%d\n' "$pass" "$warn" "$fail"
# Exit non-zero only on hard failures (missing am/jq/curl); WARNs exit 0.
[ "$fail" -eq 0 ]
