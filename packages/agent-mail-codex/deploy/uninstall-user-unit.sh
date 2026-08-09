#!/usr/bin/env bash
# uninstall-user-unit.sh — reverse install-user-unit.sh without deleting state.
#
# Usage:
#   ./deploy/uninstall-user-unit.sh --binding <name>
#   ./deploy/uninstall-user-unit.sh --binding <name> --purge-config
#   ./deploy/uninstall-user-unit.sh --binding <name> --purge-state   # destructive
set -euo pipefail

BINDING=""
PURGE_CONFIG=0
PURGE_STATE=0
PURGE_LIB=0
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-mail-codex"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mail-codex"
LIB_DIR="${AGENT_MAIL_CODEX_LIB_DIR:-$HOME/.local/lib/agent-mail-codex}"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binding) BINDING=$2; shift 2 ;;
    --purge-config) PURGE_CONFIG=1; shift ;;
    --purge-state) PURGE_STATE=1; shift ;;
    --purge-lib) PURGE_LIB=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$BINDING" ]]; then
  echo "usage: uninstall-user-unit.sh --binding <name>" >&2
  exit 2
fi

UNIT="agent-mail-codex@${BINDING}.service"
if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
fi

# Template unit may still be needed by other bindings — only remove when no
# other agent-mail-codex@ instances remain enabled/static.
OTHER=$(systemctl --user list-unit-files 'agent-mail-codex@*.service' --no-legend 2>/dev/null \
  | awk 'NF{print $1}' | grep -v "^agent-mail-codex@${BINDING}\\.service$" || true)
if [[ -z "$OTHER" && -f "$UNIT_DIR/agent-mail-codex@.service" ]]; then
  rm -f "$UNIT_DIR/agent-mail-codex@.service"
fi

MANIFEST="$CONF_DIR/install-${BINDING}.manifest"
ENV_FILE="$CONF_DIR/${BINDING}.env"
if [[ $PURGE_CONFIG -eq 1 ]]; then
  rm -f "$ENV_FILE" "$MANIFEST"
else
  echo "kept config: $ENV_FILE (pass --purge-config to remove)"
fi

if [[ $PURGE_STATE -eq 1 ]]; then
  echo "purging state: $STATE_ROOT/$BINDING"
  rm -rf "$STATE_ROOT/$BINDING"
else
  echo "kept state: $STATE_ROOT/$BINDING (pass --purge-state to delete)"
fi

if [[ $PURGE_LIB -eq 1 ]]; then
  # Only purge lib if no manifests remain.
  if ! compgen -G "$CONF_DIR/install-*.manifest" >/dev/null; then
    rm -rf "$LIB_DIR"
    echo "purged lib: $LIB_DIR"
  else
    echo "kept lib (other bindings still installed): $LIB_DIR"
  fi
fi

systemctl --user daemon-reload 2>/dev/null || true
echo "uninstalled: $UNIT"
