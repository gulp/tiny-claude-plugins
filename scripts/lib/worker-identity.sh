#!/usr/bin/env bash
# Shared per-pane mcp-agent-mail worker identity — thin wrapper around the
# installed ralph engine's lib/identity.sh.
#
# Identity is deterministic per terminal pane when one exists, and per-repo
# otherwise. Concurrent workers in one repo hold distinct reservations.
#
# Fails loudly: if no identity can be obtained, refuses to launch. Override with
# AGENT_ALLOW_NO_IDENTITY=1.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/worker-identity.sh"
#   resolve_worker_identity <program> [explicit-name]
#
# Inputs (env): RALPH_HOME (optional explicit engine root), AGENT_MODEL (default
# "unknown"), AGENT_ALLOW_NO_IDENTITY, TMUX_PANE / WEZTERM_PANE, XDG_CACHE_HOME.
# When RALPH_HOME is unset, the engine is found via `ralph` on PATH (same
# readlink -f rule as bin/ralph) — never a hardcoded checkout path.

if [ -z "${RALPH_HOME-}" ]; then
  _ralph_bin=""
  if command -v ralph >/dev/null 2>&1; then
    _ralph_bin="$(command -v ralph)"
    _ralph_bin="$(readlink -f "$_ralph_bin" 2>/dev/null || printf '%s' "$_ralph_bin")"
    RALPH_HOME="$(cd "$(dirname "$_ralph_bin")/.." && pwd -P)"
  else
    {
      echo "✗ worker-identity: cannot find the ralph engine."
      echo "  Install ralph onto PATH (run install.sh from the engine checkout)"
      echo "  or set RALPH_HOME to the engine root containing lib/identity.sh."
    } >&2
    exit 1
  fi
fi

if [ ! -f "$RALPH_HOME/lib/identity.sh" ]; then
  {
    echo "✗ worker-identity: ralph engine not at RALPH_HOME=$RALPH_HOME"
    echo "  Missing: $RALPH_HOME/lib/identity.sh"
    echo "  Re-run install.sh or fix RALPH_HOME."
  } >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$RALPH_HOME/lib/identity.sh"

resolve_worker_identity() {
  local program="${1:?resolve_worker_identity requires a program (e.g. cursor-agent|claude-code)}"
  local explicit_name="${2:-}"

  local repo repo_abs pane_key cache_dir cache_file key
  repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  repo_abs="$(cd "$repo" && pwd -P)"

  # Workers ALWAYS enforce reservations — never inherit a coordinator's bypass.
  unset AGENT_MAIL_BYPASS IS_COORDINATOR

  pane_key="${TMUX_PANE:-}"
  [ -z "$pane_key" ] && [ -n "${WEZTERM_PANE:-}" ] && pane_key="wez-${WEZTERM_PANE}"

  RALPH_MODEL="${AGENT_MODEL:-unknown}"

  # --agent-name must register and write the identity cache (pane or bed key).
  # The engine's pre-set AGENT_NAME path skips both, so handle it here.
  if [ -n "$explicit_name" ]; then
    ralph_identity_register worker "$repo_abs" "$program" "${AGENT_MODEL:-unknown}" \
        "$explicit_name" "$program session" || exit 1
    cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/ralph-identity"
    key="$(ralph_identity_cache_key "$repo_abs" "$pane_key")"
    cache_file="$cache_dir/$key"
    ralph_identity_cache_save "$cache_file" "$explicit_name" || exit 1
    AGENT_NAME="$explicit_name"
    export AGENT_NAME
    printf '🪪 agent-mail worker: %s%s\n' "$AGENT_NAME" "${pane_key:+ (pane $pane_key)}" >&2
    return 0
  fi

  # Launchers mint per-pane identities even when .envrc carries a default
  # AGENT_NAME for manual commits. The engine honours a pre-set name; clear it.
  unset AGENT_NAME

  ralph_identity_resolve "$repo_abs" "$program" 0 || exit 1

  printf '🪪 agent-mail worker: %s%s\n' "$AGENT_NAME" "${pane_key:+ (pane $pane_key)}" >&2
}
