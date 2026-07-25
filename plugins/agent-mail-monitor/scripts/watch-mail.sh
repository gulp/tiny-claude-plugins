#!/usr/bin/env bash
# watch-mail.sh — emit one line per NEW Agent Mail message.
#
# Polls `am check-inbox --json` and prints a line for every message whose id
# exceeds a running high-water mark. CONSUMPTION WARNING: `am check-inbox`
# without `--direct` is NOT read-only when the am daemon is up (the default) —
# it routes through the server's fetch_inbox, which MARKS RETURNED MESSAGES READ
# (verified against am v0.3.21). So this watch consumes: a message it reports is
# marked read, and a later fetch_inbox(unread_only) will not re-surface it. The
# fix is to poll the append-only canonical git-mailbox on disk instead (see
# src/core/mailbox.ts + the plugin beads); until then, treat the notification as
# the delivery.
#
# Designed to be the `command` of a persistent Monitor: each printed stdout line
# becomes one notification; the process loops until killed (TaskStop / session
# end). Failures are surfaced on STDOUT (the only stream a Monitor turns into a
# notification) — never silently on stderr — so a broken watch cannot masquerade
# as a healthy-but-quiet one.
#
# Output (stdout, one line per new message):
#   MAIL #<id> from <sender> [<importance>]: <subject>
#
# Exit codes:
#   0    --help printed
#   2    invalid arguments (usage error)
#   4    the FIRST check-inbox poll failed — server unreachable, wrong --agent,
#        or auth. Failures AFTER a good first poll are treated as transient: the
#        watch warns once on stdout and keeps retrying (self-healing), so it is
#        not a code-4 case.
#   127  a required dependency (am or jq) is not on PATH, or a temp file for
#        capturing diagnostics could not be created
#
# Absent a fatal condition the process does not exit on its own — it loops until
# the Monitor host signals it (TaskStop / session end).
set -uo pipefail

FAIL_WARN_THRESHOLD=3   # consecutive transient failures before one loud warning

usage() {
	cat <<'EOF'
watch-mail.sh — emit one line per NEW Agent Mail message, read-only.

Polls `am check-inbox --json` (which, unlike the MCP fetch_inbox tool, does NOT
mark messages read) and prints a line for every message whose id exceeds a
running high-water mark. Meant to be the command of a persistent Monitor.

Usage:
  watch-mail.sh --agent <NAME> [--project <PATH>] [--since <ID>] [--interval <SEC>]

Options:
  --agent NAME    Agent Mail identity to watch (required).
  --project PATH  Project key / cwd (default: $PWD).
  --since ID      Only emit messages with id > ID; existing mail above ID IS
                  replayed once at startup. Omit (default) to adopt the current
                  max id silently, so only mail arriving AFTER launch is
                  reported and existing unread is not replayed.
  --interval SEC  Seconds between polls, positive integer >= 1 (default: 30).
  -h, --help      Print this help and exit 0.

Output (stdout, one line per new message):
  MAIL #<id> from <sender> [<importance>]: <subject>

Exit codes:
  0    help printed
  2    invalid arguments
  4    initial poll failed (server unreachable, wrong --agent, or auth)
  127  a dependency (am or jq) is missing, or a temp file could not be created
EOF
}

agent=""
project="$PWD"
since=""
interval=30
while [ $# -gt 0 ]; do
	case "$1" in
	--agent)    agent="${2:-}";    shift 2 ;;
	--project)  project="${2:-}";  shift 2 ;;
	--since)    since="${2:-}";     shift 2 ;;
	--interval) interval="${2:-}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "watch-mail: unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

command -v am >/dev/null 2>&1 || { echo "watch-mail: 'am' CLI not found on PATH" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "watch-mail: 'jq' not found on PATH" >&2; exit 127; }
[ -n "$agent" ] || { echo "watch-mail: --agent is required" >&2; usage >&2; exit 2; }
case "$since" in
	'' )        : ;;                                                  # default: silent baseline
	*[!0-9]* )  echo "watch-mail: --since must be a non-negative integer" >&2; exit 2 ;;
esac
case "$interval" in
	''|*[!0-9]* ) echo "watch-mail: --interval must be a positive integer" >&2; exit 2 ;;
	0 )           echo "watch-mail: --interval must be >= 1" >&2; exit 2 ;;
esac

errfile=$(mktemp "${TMPDIR:-/tmp}/watch-mail.err.XXXXXX") || {
	echo "watch-mail: could not create a temp file for diagnostics" >&2; exit 127; }
cleanup() { rm -f "$errfile"; }
trap cleanup EXIT
trap 'exit 143' TERM   # TaskStop → graceful exit → EXIT trap cleans up
trap 'exit 130' INT

last="$since"          # high-water mark; empty until the first successful poll
started=0              # 1 once at least one poll has succeeded
consecutive_fail=0
warned=0

while :; do
	poll_ok=0
	curmax=""
	# A poll is OK only if `am` exits 0 AND its body parses to a numeric max id.
	# `am` exiting 0 with a non-JSON body (e.g. an HTML error) is a failure, not
	# a silent no-op.
	if out=$(am check-inbox --agent "$agent" --project "$project" --rate-limit 0 --json 2>"$errfile"); then
		# `am check-inbox` prints NOTHING on a zero-unread inbox (it is built for
		# git hooks): empty stdout with exit 0 is a healthy empty inbox — treat it
		# as {"messages":[]} (max id 0), NOT a failed poll. Without this the very
		# first poll of an empty inbox falls through to the else-branch and exits 4.
		if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
			curmax=0
			poll_ok=1
		else
			curmax=$(printf '%s' "$out" | jq -r '([.messages[]?.id] + [0]) | max' 2>/dev/null)
			case "$curmax" in
				''|*[!0-9]* ) curmax="" ;;
				* )           poll_ok=1 ;;
			esac
		fi
	fi

	if [ "$poll_ok" -eq 1 ]; then
		if [ "$warned" -eq 1 ]; then
			echo "agent-mail-monitor: check-inbox recovered — resuming normal watch."
			warned=0
		fi
		consecutive_fail=0
		started=1
		if [ -z "$last" ]; then
			last="$curmax"                      # baseline: adopt without replay
		elif [ "$curmax" -gt "$last" ]; then
			printf '%s' "$out" | jq -r --argjson last "$last" \
				'.messages[]? | select(.id > $last)
				 | "MAIL #\(.id) from \(.from // "?") [\(.importance // "?")]: \(.subject // "(no subject)")"'
			last="$curmax"
		fi
	else
		consecutive_fail=$((consecutive_fail + 1))
		errsnip=$(tr '\n' ' ' <"$errfile" | cut -c1-300)
		if [ "$started" -eq 0 ]; then
			# First poll failed → almost certainly misconfiguration. Fail loud.
			echo "agent-mail-monitor: initial check-inbox poll FAILED for agent '$agent' @ '$project' — NOT watching. Cause: ${errsnip:-unknown (server down, wrong --agent, or auth).}"
			echo "agent-mail-monitor: verify the server is up ('am status') and --agent is correct; the agent-mail-monitor:doctor skill diagnoses this."
			exit 4
		elif [ "$warned" -eq 0 ] && [ "$consecutive_fail" -ge "$FAIL_WARN_THRESHOLD" ]; then
			# Mid-run outage → warn ONCE (avoid notification spam), keep retrying.
			echo "agent-mail-monitor: check-inbox has failed ${consecutive_fail}x (transient?). Cause: ${errsnip:-unknown}. Still retrying every ${interval}s."
			warned=1
		fi
	fi

	sleep "$interval"
done
