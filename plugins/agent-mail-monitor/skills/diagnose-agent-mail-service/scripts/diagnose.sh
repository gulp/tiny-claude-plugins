#!/usr/bin/env bash
# diagnose-agent-mail-service — decide whether the Agent Mail server is HEALTHY,
# WEDGED (port bound but HTTP unresponsive), DEAD (unit not running), or has an
# ORPHAN port-holder — using probes in the order that CANNOT be fooled by the
# wedge. Read-only: it probes state and changes nothing (no restart, no repair).
#
# Probe ordering (each independent of the next so one hang can't blind the rest):
#   1. systemd      — authoritative: is the unit managed, active, and what is its
#                     Main PID? Beats ss/pgrep, which cannot tell managed-vs-orphan.
#   2. port holder  — ss: who holds :8765, and is it the unit's Main PID?
#   3. HTTP liveness— curl the MCP endpoint with a short cap. ANY HTTP code = the
#                     server answers at the transport level (405 to a bare GET is
#                     normal). 000 / timeout = genuinely WEDGED. This is the fast,
#                     correct wedge detector.
#   4. local-DB read— `am robot inbox --unread`: a local-sqlite read that returns
#                     in ~0.15s even under WAL contention. Confirms the DB is
#                     readable independently of the HTTP path.
#
# NEVER probe liveness with `am status` / `am robot status`: measured 1.3s–15.8s
# on a HEALTHY server (heavy health synthesis), so a short timeout on it
# FALSE-POSITIVES a wedge. It is a dashboard, not a liveness check.
#
# Output: one `[PASS]/[WARN]/[FAIL] <check> — <detail>` line per probe, then a
# `VERDICT <state> — <recovery pointer>` line and a `SUMMARY pass/warn/fail` line.
#
# Exit codes:
#   0    HEALTHY (unit active, port held by Main PID, HTTP answers, DB reads)
#   1    DEGRADED — server answers but something needs attention (e.g. corrupt
#        archive repo firing maintenance warnings). Not a wedge; human follow-up.
#   2    WEDGED / DEAD / ORPHAN — actionable failure; VERDICT names the recovery.
#   64   invalid arguments (usage error)
set -u

UNIT=mcp-agent-mail.service
AGENT=${AGENT_NAME:-${AGENT_MAIL_AGENT:-}}
URL=

usage() {
	cat <<'EOF'
diagnose.sh — read-only wedge diagnosis for the Agent Mail systemd user service.

Probes systemd (authoritative), the :8765 port holder, HTTP liveness (curl —
the correct fast wedge detector), and a local-DB read (`am robot inbox`). Prints
one line per probe, a VERDICT (HEALTHY / WEDGED / DEAD / ORPHAN / DEGRADED) with a
recovery pointer, and a SUMMARY. Changes nothing — never restarts or repairs.

Usage: diagnose.sh [--unit <name>] [--agent <name>] [--url <mcp-url>] [-h|--help]

  --unit   systemd user unit         (default: mcp-agent-mail.service)
  --agent  agent name for the local-DB read (default: $AGENT_NAME / $AGENT_MAIL_AGENT)
  --url    MCP HTTP endpoint to curl (default: derived, else http://127.0.0.1:8765/mcp/)

Exit codes: 0 HEALTHY · 1 DEGRADED · 2 WEDGED/DEAD/ORPHAN · 64 usage.

Never diagnoses with `am status` — it is slow (1.3–15.8s) even when healthy and
would false-positive a wedge.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help) usage; exit 0 ;;
		--unit)  UNIT=${2:?--unit needs a value}; shift 2 ;;
		--agent) AGENT=${2:?--agent needs a value}; shift 2 ;;
		--url)   URL=${2:?--url needs a value}; shift 2 ;;
		*) echo "diagnose.sh: unknown argument: $1" >&2; usage >&2; exit 64 ;;
	esac
done

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
skill_root=$(dirname -- "$here")

pass=0 warn=0 fail=0
ok()  { printf '[PASS] %s — %s\n' "$1" "$2"; pass=$((pass+1)); }
w()   { printf '[WARN] %s — %s\n' "$1" "$2"; warn=$((warn+1)); }
bad() { printf '[FAIL] %s — %s\n' "$1" "$2"; fail=$((fail+1)); }
have(){ command -v "$1" >/dev/null 2>&1; }

# ---- 1. systemd (authoritative) -------------------------------------------
active= mainpid=0
if have systemctl; then
	active=$(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null)
	mainpid=$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null)
	mainpid=${mainpid:-0}
	case "$active" in
		active)
			ok "systemd" "$UNIT is active (running); Main PID=$mainpid" ;;
		activating|reloading)
			w "systemd" "$UNIT is $active (transitional) — re-check in a moment" ;;
		"" )
			bad "systemd" "cannot query $UNIT (no such user unit?) — 'systemctl --user status $UNIT'" ;;
		*)
			bad "systemd" "$UNIT is '$active' (not running) — recover with: systemctl --user start $UNIT" ;;
	esac
else
	w "systemd" "systemctl not on PATH — cannot check the managed unit (falling back to port/HTTP only)"
fi

# ---- 2. port holder --------------------------------------------------------
# Who holds :8765, and is it the unit's Main PID? An orphan (different pid) is a
# different failure from a wedge — restart would EADDRINUSE against the orphan.
portpid=
if have ss; then
	# take the first pid= on a LISTEN row for :8765
	portline=$(ss -ltnp 2>/dev/null | grep -E '127\.0\.0\.1:8765|\*:8765|:::8765' | head -1)
	portpid=$(printf '%s' "$portline" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
	if [ -z "$portline" ]; then
		bad "port" ":8765 is not bound by anyone — the server is down (DEAD), not wedged"
	elif [ -n "$portpid" ] && [ "$portpid" = "$mainpid" ]; then
		ok "port" ":8765 held by the unit's Main PID ($portpid) — no orphan; a restart is clean"
	elif [ -n "$portpid" ] && [ "$mainpid" != 0 ]; then
		bad "port" ":8765 held by pid $portpid but unit Main PID is $mainpid — ORPHAN holder; restart will EADDRINUSE until it is killed"
	else
		w "port" ":8765 held by pid ${portpid:-?} (could not confirm against Main PID)"
	fi
else
	w "port" "ss not on PATH — cannot check the :8765 holder"
fi

# ---- 3. HTTP liveness (the fast, correct wedge detector) -------------------
if [ -z "$URL" ]; then
	# Prefer the server's own advertised url via the local read below; default here.
	URL=http://127.0.0.1:8765/mcp/
fi
if have curl; then
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null)
	if [ -z "$code" ] || [ "$code" = "000" ]; then
		bad "http" "no HTTP response from $URL within 5s — WEDGED (process alive, transport unresponsive)"
	else
		ok "http" "$URL answers (HTTP $code) — transport is live (405 to a bare GET is normal)"
	fi
else
	w "http" "curl not on PATH — cannot run the HTTP wedge probe (the decisive check)"
fi

# ---- 4. local-DB read (independent of the HTTP path) ----------------------
if have am; then
	if [ -n "$AGENT" ]; then
		out=$(timeout 6 am robot inbox --agent "$AGENT" --unread 2>/dev/null)
		if printf '%s' "$out" | grep -q '"command"'; then
			ok "local-db" "am robot inbox returned JSON in <6s — local sqlite is readable (survives WAL contention)"
		else
			bad "local-db" "am robot inbox did not return JSON in 6s — the sqlite DB itself may be locked/contended"
		fi
	else
		w "local-db" "no agent name (\$AGENT_NAME / --agent) — skipped the local-DB read; pass --agent <name> to enable it"
	fi
else
	w "local-db" "am not on PATH — cannot run the local-DB read"
fi

# ---- 5. archive-repo hygiene (DEGRADED signal, separate human repair) ------
arch=${MCP_AGENT_MAIL_ARCHIVE:-$HOME/.mcp_agent_mail_git_mailbox_repo}
if [ -d "$arch/.git/objects" ]; then
	empties=$(find "$arch/.git/objects" -type f -empty 2>/dev/null | wc -l | tr -d ' ')
	if [ "${empties:-0}" -gt 0 ]; then
		w "archive" "$empties empty object(s) in $arch — corrupt archive repo; fires maintenance WARNs every tick. HUMAN-RUN repair (see $skill_root/resources/recovery.md); a restart does NOT fix it"
	else
		ok "archive" "no empty objects in $arch/.git/objects"
	fi
fi

# ---- verdict ---------------------------------------------------------------
# Decide the headline state from the probe outcomes above.
verdict() {
	# DEAD: unit not active or port unbound.
	case "$active" in active|activating|reloading|"") : ;; *) echo "DEAD systemctl --user start $UNIT"; return ;; esac
	if have ss && [ -z "$portpid" ]; then echo "DEAD systemctl --user start $UNIT"; return; fi
	# ORPHAN: port held by a non-Main-PID.
	if [ -n "$portpid" ] && [ "$mainpid" != 0 ] && [ "$portpid" != "$mainpid" ]; then
		echo "ORPHAN kill $portpid, then systemctl --user restart $UNIT"; return
	fi
	# WEDGED: alive but HTTP did not answer.
	if have curl && { [ -z "${code:-}" ] || [ "${code:-000}" = "000" ]; }; then
		echo "WEDGED systemctl --user restart $UNIT (clean — port-holder is the Main PID)"; return
	fi
	# DEGRADED: answers but a warning fired (e.g. corrupt archive).
	if [ "$warn" -gt 0 ]; then echo "DEGRADED server answers; clear the WARN(s) above"; return; fi
	echo "HEALTHY no action needed"
}
read -r vstate vrec <<EOF
$(verdict)
EOF
printf 'VERDICT %s — %s\n' "$vstate" "$vrec"
printf 'SUMMARY pass=%d warn=%d fail=%d\n' "$pass" "$warn" "$fail"

case "$vstate" in
	HEALTHY)              exit 0 ;;
	DEGRADED)             exit 1 ;;
	WEDGED|DEAD|ORPHAN)   exit 2 ;;
	*)                    [ "$fail" -gt 0 ] && exit 2; [ "$warn" -gt 0 ] && exit 1; exit 0 ;;
esac
