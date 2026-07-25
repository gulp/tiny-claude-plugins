#!/usr/bin/env bash
# agent-mail-monitor doctor — check the prerequisites the mail monitor depends
# on and point at the fix guide for each failure. Read-only: probes state,
# changes nothing.
#
# Output: one `[PASS]/[WARN]/[FAIL] <check> — <detail>` line per check, with
# `→ .../resources/<file>` where a fix guide exists, then a final
# `SUMMARY pass=<n> warn=<n> fail=<n>` line.
#
# Exit codes:
#   0    all checks passed (no warnings, no failures)
#   1    one or more WARNINGS, but no hard failure
#   2    one or more hard FAILURES (missing am / jq / curl)
#   64   invalid arguments (usage error)
set -u

usage() {
	cat <<'EOF'
doctor.sh — read-only preflight for the agent-mail-monitor plugin.

Probes: am CLI, jq, curl server reachability, `am health` verdict, the
agent-mail MCP declaration, and AGENT_NAME. Prints one status line per check
(→ resources/<file> for fixes) and a SUMMARY line. Changes nothing.

Usage: doctor.sh [-h|--help]

Exit codes:
  0   all checks passed
  1   warnings only (no hard failure)
  2   one or more hard failures (missing am / jq / curl)
  64  invalid arguments
EOF
}

case "${1:-}" in
	'' )        : ;;
	-h|--help)  usage; exit 0 ;;
	* )         echo "doctor.sh: unknown argument: $1" >&2; usage >&2; exit 64 ;;
esac

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_root=$(dirname -- "$here")

pass=0 warn=0 fail=0
ok()   { printf '[PASS] %s — %s\n' "$1" "$2"; pass=$((pass+1)); }
w()    { printf '[WARN] %s — %s\n    → %s/resources/%s\n' "$1" "$2" "$skill_root" "$3"; warn=$((warn+1)); }
bad()  { printf '[FAIL] %s — %s\n    → %s/resources/%s\n' "$1" "$2" "$skill_root" "$3"; fail=$((fail+1)); }
have() { command -v "$1" >/dev/null 2>&1; }

# 1. am CLI — doctor's own health/status probes shell out to it, and your
#    agent's fetch_inbox/send_message MCP tools need it. (The FS watch backend
#    itself does NOT — it reads the git-mailbox on disk directly — but doctor
#    still can't run its server/health checks without am.)
if have am; then
	amver=$(am --version 2>/dev/null | head -1)
	ok "am-cli" "${amver:-am present} ($(command -v am))"
else
	bad "am-cli" "the Agent Mail 'am' CLI is not on PATH" "install-prereqs.md"
fi

# 2. jq — doctor parses am's --json output (status, health) with it.
if have jq; then
	ok "jq" "$(command -v jq)"
else
	bad "jq" "'jq' is not on PATH (doctor parses am --json output with it)" "install-prereqs.md"
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
		w "server" "no HTTP response from $url — server may be stopped, OR busy under a DB-lock (a mutating op holds an exclusive activity lock and can block reads too); verify with the diagnose-agent-mail-service skill before restarting, don't blind-retry" "server-down.md"
	else
		ok "server" "responds at $url (HTTP $code)"
	fi
else
	bad "server" "'curl' not on PATH — cannot probe $url" "install-prereqs.md"
fi

# 4. Native health verdict (am health). PASS only when Agent Mail's own rollup
#    says healthy; surface anything else as a WARN — do not bury a non-healthy
#    'overall' just because 'health_level' happens to be green.
if have am && have jq; then
	# Bound a hanging `am health` (a DB-lock can wedge it) and CAPTURE stderr —
	# when the probe itself breaks, am's own message is the diagnostic.
	hj=$(timeout 10s am health --json 2>&1)
	hj_rc=$?
	# Distinguish "the probe broke" (crash / timeout / unimplemented subcommand /
	# empty or non-JSON output) from "am ran and reported degraded". Without this
	# gate, empty/invalid input makes `jq '.overall // "unknown"'` emit NOTHING
	# (jq errors before the `//` alternative runs), so `overall` ends up "" and
	# the else-branch prints a misleading blank `overall= level=` as if am had
	# answered. `jq -e .` validates that $hj is real JSON first.
	if [ "$hj_rc" -ne 0 ] || ! printf '%s' "$hj" | jq -e . >/dev/null 2>&1; then
		w "health" "am health --json did not return valid JSON (exit=$hj_rc) — the probe itself failed (crash / timeout / unimplemented / DB-lock), not a degraded verdict: $(printf '%s' "$hj" | tr '\n' ' ' | head -c 200)" "server-down.md"
	else
		overall=$(printf '%s' "$hj" | jq -r '.overall // "unknown"')
		level=$(printf '%s' "$hj" | jq -r '.health_level // "unknown"')
		if [ "$overall" = "healthy" ]; then
			ok "health" "am health: overall=$overall level=$level"
		else
			# Name the actual failing probe(s) instead of a bare overall=unhealthy —
			# a single-probe drift (commonly archive_db_parity: archive-vs-DB
			# project/message counts, often just stale sandbox eval dirs, not mail
			# at risk) otherwise reads as a whole-system outage. Falls back to the
			# generic line if `.probes` is absent/the wrong shape (older `am`).
			failing=$(printf '%s' "$hj" | jq -r '[(.probes // [])[] | select(.status=="fail") | .name] | join(", ")' 2>/dev/null)
			if [ -n "$failing" ]; then
				w "health" "am health: unhealthy (probe: $failing) — inspect with 'am health --json' / 'am doctor check'" "server-down.md"
			else
				w "health" "am health: overall=$overall level=$level — inspect with 'am health --json' / 'am doctor check'" "server-down.md"
			fi
		fi
	fi
fi

# 5. Agent Mail MCP server declared for Claude Code, and — if declared —
#    actually usable. The monitor does NOT need this (it uses the am CLI),
#    but your agent's fetch_inbox/send_message MCP tools do. `claude mcp get
#    <name>` names the server's exact state (absent / Rejected / Pending
#    approval / Connected) — checked against the exact server name, not a
#    `claude mcp list | grep` substring match (which over-matched any server
#    whose name merely contained "agent"/"mail").
mcp_name=mcp-agent-mail
if have claude; then
	mcp_out=$(timeout 20s claude mcp get "$mcp_name" 2>&1)
	mcp_rc=$?
	status_line=$(printf '%s\n' "$mcp_out" | grep -m1 '^  Status:')
	if [ "$mcp_rc" -ne 0 ] || [ -z "$status_line" ]; then
		w "mcp-declaration" "'$mcp_name' is not declared — the monitor still works, but MCP mail tools won't" "declare-mcp.md"
	else
		case "$status_line" in
			*'✘ Rejected'*)
				w "mcp-declaration" "'$mcp_name' is declared but REJECTED — remove it from disabledMcpjsonServers in .claude/settings.local.json" "declare-mcp.md" ;;
			*'⏸ Pending approval'*)
				w "mcp-declaration" "'$mcp_name' is declared but PENDING APPROVAL — approve at next 'claude' startup, or run /reload-plugins" "declare-mcp.md" ;;
			*'✔ Connected'*)
				ok "mcp-declaration" "'$mcp_name' is declared and connected" ;;
			*)
				w "mcp-declaration" "'$mcp_name' is declared with an unrecognized status (${status_line# })" "declare-mcp.md" ;;
		esac
	fi
else
	w "mcp-declaration" "'claude' not on PATH — cannot check the '$mcp_name' MCP declaration" "declare-mcp.md"
fi

# 6. AGENT_NAME — the identity the monitor watches. Unset → the monitor emits a
#    loud idle notice and exits (it does not silently watch a nameless inbox).
if [ -n "${AGENT_NAME:-}" ]; then
	ok "agent-name" "AGENT_NAME=$AGENT_NAME"
elif [ -n "${AGENT_MAIL_AGENT:-}" ]; then
	ok "agent-name" "AGENT_MAIL_AGENT=$AGENT_MAIL_AGENT"
else
	w "agent-name" "no AGENT_NAME / AGENT_MAIL_AGENT — the monitor will report idle and not watch until one is set" "set-agent-name.md"
fi

printf 'SUMMARY pass=%d warn=%d fail=%d\n' "$pass" "$warn" "$fail"
if [ "$fail" -gt 0 ]; then
	exit 2
elif [ "$warn" -gt 0 ]; then
	exit 1
fi
exit 0
