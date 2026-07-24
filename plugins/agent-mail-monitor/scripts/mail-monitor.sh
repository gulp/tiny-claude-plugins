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
#
# Failures are reported on STDOUT (the only stream a Monitor turns into a
# notification), never silently — an unset identity or corrupt install is loud.
#
# Exit codes:
#   0    --help printed
#   2    MAIL_POLL_INTERVAL is set but not a positive integer
#   3    AGENT_NAME unset — no identity to watch (idle, nothing watched)
#   127  watch-mail.sh is missing / not executable next to this script
#   (otherwise this process is replaced by watch-mail.sh via exec — see its codes)
set -uo pipefail

case "${1:-}" in
	-h|--help)
		cat <<'EOF'
mail-monitor.sh — Monitor entrypoint for the agent-mail-monitor plugin.

Reads AGENT_NAME (required), CLAUDE_PROJECT_DIR (default $PWD), and
MAIL_POLL_INTERVAL (default 30) from the environment, then execs watch-mail.sh.

Exit codes:
  0    help printed
  2    MAIL_POLL_INTERVAL is not a positive integer
  3    AGENT_NAME unset (no identity — idle)
  127  watch-mail.sh missing/not executable
  otherwise: watch-mail.sh's own exit codes
EOF
		exit 0 ;;
esac

here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

agent="${AGENT_NAME:-}"
if [ -z "$agent" ]; then
	# No identity → nothing to watch. Do NOT fail silently: a Monitor only
	# surfaces STDOUT as a notification (stderr is swallowed) and treats exit 0
	# as a clean end — so the old stderr-and-exit-0 path armed a watch that said
	# nothing and did nothing. Emit one loud STDOUT notice and exit non-zero so
	# the misconfiguration is visible, not a silent no-op.
	echo "agent-mail-monitor: AGENT_NAME unset — NOT watching any inbox (idle). No mail will be reported."
	echo "agent-mail-monitor: fix — relaunch with an identity, e.g.  AGENT_NAME=YourName claude  (or run the agent-mail-monitor:doctor skill)."
	exit 3
fi

interval="${MAIL_POLL_INTERVAL:-30}"
case "$interval" in
	''|*[!0-9]*|0)
		echo "agent-mail-monitor: MAIL_POLL_INTERVAL='${MAIL_POLL_INTERVAL:-}' is not a positive integer — cannot start."
		exit 2 ;;
esac

if [ ! -x "$here/watch-mail.sh" ]; then
	echo "agent-mail-monitor: watch-mail.sh not found or not executable in '$here' — the plugin install may be corrupt."
	exit 127
fi

exec "$here/watch-mail.sh" \
	--agent "$agent" \
	--project "${CLAUDE_PROJECT_DIR:-$PWD}" \
	--interval "$interval"
