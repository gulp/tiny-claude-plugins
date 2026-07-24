#!/usr/bin/env bash
# mail-monitor.sh — the Monitor entrypoint declared in monitors/monitors.json.
#
# It reads identity + project from the ENVIRONMENT (a real shell expands them
# here, reliably) rather than from ${VAR} tokens inside the monitor command
# string — the host only guarantees substitution of its own allowlisted vars
# (${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PROJECT_DIR}, …), not arbitrary ones like
# ${AGENT_NAME}. So monitors.json references only ${CLAUDE_PLUGIN_ROOT}, and all
# other resolution happens in this script.
#
#   AGENT_NAME            required — the Agent Mail identity to watch
#   CLAUDE_PROJECT_DIR    project key; falls back to $PWD (the session cwd)
#   MAIL_POLL_INTERVAL    seconds between polls (default 30)
set -uo pipefail

here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

agent="${AGENT_NAME:-}"
if [ -z "$agent" ]; then
	# No identity → nothing to watch. Exit 0 (not a crash) so the host doesn't
	# flag a failed monitor; stderr explains how to arm it.
	echo "agent-mail-monitor: AGENT_NAME is unset — no identity to watch; monitor idle." >&2
	echo "                    relaunch with an identity, e.g.  AGENT_NAME=YourName cldy-mon" >&2
	exit 0
fi

exec "$here/watch-mail.sh" \
	--agent "$agent" \
	--project "${CLAUDE_PROJECT_DIR:-$PWD}" \
	--interval "${MAIL_POLL_INTERVAL:-30}"
