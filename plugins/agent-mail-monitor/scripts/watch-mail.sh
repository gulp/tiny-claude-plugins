#!/usr/bin/env bash
# watch-mail.sh — emit one line per NEW Agent Mail message, read-only.
#
# Polls `am check-inbox --json` and prints a line for every message whose id
# exceeds a running high-water mark. Unlike the MCP fetch_inbox tool,
# check-inbox does NOT mark messages read, so watching never consumes mail out
# from under a later fetch_inbox/acknowledge_message.
#
# Designed to be the `command` of a persistent Monitor: each printed stdout
# line becomes one notification; the process loops until killed (TaskStop /
# session end). Diagnostics go to stderr only, so a transient poll failure
# never masquerades as a mail event.
#
# Output (stdout, one line per new message):
#   MAIL #<id> from <sender> [<importance>]: <subject>
set -uo pipefail

usage() {
	cat <<'EOF'
watch-mail.sh — emit one line per NEW Agent Mail message, read-only.

Polls `am check-inbox --json` (which, unlike the MCP fetch_inbox tool, does
NOT mark messages read) and prints a line for every message whose id exceeds a
running high-water mark. Meant to be the command of a persistent Monitor.

Usage:
  watch-mail.sh --agent <NAME> [--project <PATH>] [--since <ID>] [--interval <SEC>]

Options:
  --agent NAME    Agent Mail identity to watch (required).
  --project PATH  Project key / cwd (default: $PWD).
  --since ID      Only emit messages with id > ID. Default: auto — adopt the
                  current max id at startup, so only mail arriving AFTER launch
                  is reported and existing unread is not replayed.
  --interval SEC  Seconds between polls (default: 30).
  -h, --help      Print this help and exit.
EOF
}

agent=""
project="$PWD"
since=""
interval=30
while [ $# -gt 0 ]; do
	case "$1" in
	--agent) agent="${2:-}"; shift 2 ;;
	--project) project="${2:-}"; shift 2 ;;
	--since) since="${2:-}"; shift 2 ;;
	--interval) interval="${2:-}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "watch-mail: unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

command -v am >/dev/null 2>&1 || { echo "watch-mail: 'am' CLI not found on PATH" >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "watch-mail: 'jq' not found on PATH" >&2; exit 127; }
[ -n "$agent" ] || { echo "watch-mail: --agent is required" >&2; usage >&2; exit 2; }
case "$since" in ''|*[!0-9]*) [ -z "$since" ] || { echo "watch-mail: --since must be a non-negative integer" >&2; exit 2; } ;; esac
case "$interval" in *[!0-9]*|'') echo "watch-mail: --interval must be a positive integer" >&2; exit 2 ;; esac

# last is the high-water mark. Empty means "not yet initialized" — the first
# successful poll adopts the current max WITHOUT replaying existing messages.
last="$since"
while :; do
	if out=$(am check-inbox --agent "$agent" --project "$project" --rate-limit 0 --json 2>/dev/null) && [ -n "$out" ]; then
		curmax=$(printf '%s' "$out" | jq -r '([.messages[]?.id] + [0]) | max' 2>/dev/null)
		case "$curmax" in ''|*[!0-9]*) curmax="" ;; esac
		if [ -z "$last" ]; then
			last="${curmax:-0}"
		elif [ -n "$curmax" ] && [ "$curmax" -gt "$last" ]; then
			printf '%s' "$out" | jq -r --argjson last "$last" \
				'.messages[]? | select(.id > $last)
				 | "MAIL #\(.id) from \(.from) [\(.importance)]: \(.subject)"'
			last="$curmax"
		fi
	else
		echo "watch-mail: check-inbox poll failed (transient); will retry" >&2
	fi
	sleep "$interval"
done
