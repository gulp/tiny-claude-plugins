#!/usr/bin/env bash
# agent-mail-codex-run.sh — ExecStart wrapper for the systemd user unit.
# Resolves deno + package sources, computes least-privilege Deno flags
# (tcp-efp.5.13), then execs `agent-mail-codex run` with no bare --allow-read/--allow-write.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_ROOT=${AGENT_MAIL_CODEX_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}
DENO_BIN=${DENO_BIN:-$(command -v deno || true)}
CODEX_BIN=${CODEX_BIN:-}

if [[ -z "$DENO_BIN" ]]; then
  echo "agent-mail-codex-run: deno not on PATH (set DENO_BIN)" >&2
  exit 127
fi

if [[ ! -f "$PKG_ROOT/src/cli.ts" ]]; then
  echo "agent-mail-codex-run: missing $PKG_ROOT/src/cli.ts (set AGENT_MAIL_CODEX_ROOT)" >&2
  exit 4
fi

# tcp-efp.5.15: never fall back to PATH `codex` — it often resolves an
# npx --prefer-online wrapper that hangs bounded version probes.
if [[ -z "$CODEX_BIN" ]]; then
  echo "agent-mail-codex-run: CODEX_BIN is required (absolute native Codex ELF; not a package-manager wrapper)" >&2
  exit 127
fi

# Require absolute CODEX_BIN for allow-run scoping.
if [[ "$CODEX_BIN" != /* ]]; then
  echo "agent-mail-codex-run: CODEX_BIN must be an absolute path (got: $CODEX_BIN)" >&2
  exit 127
fi
if [[ ! -f "$CODEX_BIN" ]]; then
  echo "agent-mail-codex-run: CODEX_BIN missing: $CODEX_BIN" >&2
  exit 127
fi
# Reject common package-manager wrappers before Deno starts.
if head -c 2 "$CODEX_BIN" | grep -q '#!'; then
  if grep -Eq 'npx|--prefer-online|npm[[:space:]]+exec|yarn[[:space:]]+dlx|pnpm[[:space:]]+dlx|@openai/codex' "$CODEX_BIN"; then
    echo "agent-mail-codex-run: CODEX_BIN_WRAPPER_REJECTED: $CODEX_BIN looks like a package-manager wrapper; point CODEX_BIN at the vendor ELF" >&2
    exit 127
  fi
  echo "agent-mail-codex-run: CODEX_BIN_NOT_NATIVE: $CODEX_BIN is a script, not a native ELF" >&2
  exit 127
fi
if [[ "$(head -c 4 "$CODEX_BIN" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]]; then
  echo "agent-mail-codex-run: CODEX_BIN_NOT_NATIVE: $CODEX_BIN is not an ELF executable" >&2
  exit 127
fi

export CODEX_BIN
export AGENT_MAIL_CODEX_ROOT="$PKG_ROOT"

CONFIG=""
BINDING=""
args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    --config)
      i=$((i + 1))
      CONFIG=${args[$i]:-}
      ;;
    --binding)
      i=$((i + 1))
      BINDING=${args[$i]:-}
      ;;
  esac
  i=$((i + 1))
done

if [[ -z "$CONFIG" || "$CONFIG" != /* ]]; then
  echo "agent-mail-codex-run: --config <absolute-path> is required" >&2
  exit 2
fi
if [[ -z "$BINDING" ]]; then
  BINDING=${AGENT_MAIL_CODEX_BINDING:-}
fi
if [[ -z "$BINDING" ]]; then
  echo "agent-mail-codex-run: --binding <name> is required" >&2
  exit 2
fi

# Drop loader-injection vars so path-scoped Deno --allow-run is not refused.
unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH || true

HOME_DIR=${HOME:-}
STATE_ROOT=${XDG_STATE_HOME:-$HOME_DIR/.local/state}/agent-mail-codex
MAILBOX_ROOT=${AGENT_MAIL_MAILBOX_ROOT:-$HOME_DIR/.mcp_agent_mail_git_mailbox_repo}
CODEX_HOME=${CODEX_HOME:-$HOME_DIR/.codex}
TMP_DIR=${TMPDIR:-/tmp}
CONFIG_DIR=$(dirname "$CONFIG")

# Bootstrap read set for the permissions probe only (still bounded — not bare --allow-read).
BOOTSTRAP_READ="$PKG_ROOT,$CONFIG,$CONFIG_DIR,$STATE_ROOT,$MAILBOX_ROOT,$CODEX_BIN,$(dirname "$CODEX_BIN"),$CODEX_HOME,$TMP_DIR,/etc/ssl,/etc/ssl/certs,/etc/pki,/etc/resolv.conf,/etc/hosts,/etc/nsswitch.conf"
if [[ -n "$HOME_DIR" ]]; then
  BOOTSTRAP_READ="$BOOTSTRAP_READ,$HOME_DIR"
fi

mapfile -t DENO_ARGS < <("$DENO_BIN" run \
  --allow-read="$BOOTSTRAP_READ" \
  --allow-env \
  "$PKG_ROOT/src/cli.ts" \
  permissions --config "$CONFIG" --binding "$BINDING" --shell) || {
  echo "agent-mail-codex-run: permissions computation failed" >&2
  exit 4
}

if [[ ${#DENO_ARGS[@]} -eq 0 ]]; then
  echo "agent-mail-codex-run: empty permission args" >&2
  exit 4
fi

for arg in "${DENO_ARGS[@]}"; do
  case "$arg" in
    --allow-read|--allow-write|--allow-env|--allow-run)
      echo "agent-mail-codex-run: bare permission flag rejected: $arg" >&2
      exit 4
      ;;
    --allow-read=*|--allow-write=*|--allow-env=*|--allow-run=*|--allow-ffi) ;;
    *)
      echo "agent-mail-codex-run: unexpected denoArg: $arg" >&2
      exit 4
      ;;
  esac
done

# Final process: bounded read/write/env/run only. No project write capability.
exec "$DENO_BIN" run \
  "${DENO_ARGS[@]}" \
  "$PKG_ROOT/src/cli.ts" \
  run \
  "$@"
