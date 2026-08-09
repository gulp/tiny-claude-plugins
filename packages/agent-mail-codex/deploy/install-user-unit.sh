#!/usr/bin/env bash
# install-user-unit.sh — install agent-mail-codex systemd user unit (reversible).
#
# Usage:
#   ./deploy/install-user-unit.sh --binding <name> --config <absolute-json>
#   ./deploy/install-user-unit.sh --binding <name> --config <path> --enable
#
# Does not start delivery against a live Codex App Server by default; enable
# and start only after doctor passes. State under XDG is preserved on uninstall.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
UNIT_SRC="$SCRIPT_DIR/systemd/agent-mail-codex@.service"
ENV_EXAMPLE="$SCRIPT_DIR/systemd/agent-mail-codex.env.example"
RUNBOOK_SRC="$PKG_ROOT/docs/ops-runbook.md"

BINDING=""
CONFIG=""
ENABLE=0
START=0
LIB_DIR="${AGENT_MAIL_CODEX_LIB_DIR:-$HOME/.local/lib/agent-mail-codex}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-mail-codex"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mail-codex"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binding) BINDING=$2; shift 2 ;;
    --config) CONFIG=$2; shift 2 ;;
    --enable) ENABLE=1; shift ;;
    --start) START=1; ENABLE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$BINDING" || -z "$CONFIG" ]]; then
  echo "usage: install-user-unit.sh --binding <name> --config <absolute-json>" >&2
  exit 2
fi
if [[ "$CONFIG" != /* ]]; then
  echo "config path must be absolute: $CONFIG" >&2
  exit 4
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "config missing: $CONFIG" >&2
  exit 4
fi
if [[ ! -f "$UNIT_SRC" ]]; then
  echo "unit template missing: $UNIT_SRC" >&2
  exit 4
fi

mkdir -p "$LIB_DIR" "$UNIT_DIR" "$CONF_DIR" "$STATE_ROOT/$BINDING" "$STATE_ROOT/$BINDING/runtime" "$STATE_ROOT/$BINDING/owner-state"

# Sync package sources into lib dir so the unit does not depend on a checkout cwd.
# Prefer rsync when present; fall back to cp -a for the thin tree we need.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'tests' \
    "$PKG_ROOT/" "$LIB_DIR/"
else
  rm -rf "$LIB_DIR/src" "$LIB_DIR/deploy" "$LIB_DIR/docs" "$LIB_DIR/examples" "$LIB_DIR/deno.json"
  mkdir -p "$LIB_DIR"
  cp -a "$PKG_ROOT/src" "$PKG_ROOT/deploy" "$PKG_ROOT/docs" "$PKG_ROOT/examples" "$PKG_ROOT/deno.json" "$LIB_DIR/"
fi
chmod +x "$LIB_DIR/deploy/agent-mail-codex-run.sh" \
  "$LIB_DIR/deploy/install-user-unit.sh" \
  "$LIB_DIR/deploy/uninstall-user-unit.sh"

install -m 0644 "$UNIT_SRC" "$UNIT_DIR/agent-mail-codex@.service"
if [[ -f "$RUNBOOK_SRC" ]]; then
  install -m 0644 "$RUNBOOK_SRC" "$CONF_DIR/ops-runbook.md"
fi

ENV_DEST="$CONF_DIR/${BINDING}.env"
if [[ ! -f "$ENV_DEST" ]]; then
  sed \
    -e "s|%h|$HOME|g" \
    -e "s|AGENT_MAIL_CODEX_CONFIG=.*|AGENT_MAIL_CODEX_CONFIG=$CONFIG|" \
    "$ENV_EXAMPLE" > "$ENV_DEST"
  chmod 0600 "$ENV_DEST"
fi

# Record install manifest for reversible uninstall (state dirs are listed, not deleted).
MANIFEST="$CONF_DIR/install-${BINDING}.manifest"
cat > "$MANIFEST" <<EOF
binding=$BINDING
config=$CONFIG
lib_dir=$LIB_DIR
unit=$UNIT_DIR/agent-mail-codex@.service
env=$ENV_DEST
state_dir=$STATE_ROOT/$BINDING
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

systemctl --user daemon-reload

UNIT="agent-mail-codex@${BINDING}.service"
if [[ $ENABLE -eq 1 ]]; then
  systemctl --user enable "$UNIT"
fi
if [[ $START -eq 1 ]]; then
  systemctl --user start "$UNIT"
fi

echo "installed: $UNIT"
echo "  env:      $ENV_DEST"
echo "  state:    $STATE_ROOT/$BINDING"
echo "  lib:      $LIB_DIR"
echo "  runbook:  $CONF_DIR/ops-runbook.md"
echo "  linger:   loginctl enable-linger \$USER   # survive logout/reboot"
echo "  status:   systemctl --user status $UNIT"
echo "  doctor:   $LIB_DIR/deploy/agent-mail-codex-run.sh --config $CONFIG --binding $BINDING"
echo "            (use: deno task cli -- doctor … from the package for the real doctor)"
