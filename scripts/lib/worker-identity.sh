#!/usr/bin/env bash
# Shared per-pane mcp-agent-mail worker identity, sourced by the repo-scoped
# worker launcher (`agent` for cursor-agent).
#
# Identity is deterministic per terminal pane: the same tmux/wezterm pane always
# reuses the same adjective+noun agent name across relaunches (cached by pane id),
# while different panes get distinct names. That lets concurrent workers in one
# repo coordinate without clobbering each other's exclusive file reservations
# (the installed pre-commit guard enforces this).
#
# Fails loudly: if no identity can be obtained, it refuses to launch (a worker
# must never run unidentified). Override with AGENT_ALLOW_NO_IDENTITY=1.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/worker-identity.sh"
#   resolve_worker_identity <program> [explicit-name]
#
# On success exports AGENT_NAME (per-pane stable, or the explicit name) and
# returns 0. On failure it prints a diagnostic and `exit 1`s the calling
# launcher, unless AGENT_ALLOW_NO_IDENTITY=1 (then it warns and returns 0 with
# AGENT_NAME as-is).
#
# Inputs (env): AGENT_MODEL (recorded on the identity; default "unknown"),
# AGENT_ALLOW_NO_IDENTITY, TMUX_PANE / WEZTERM_PANE, XDG_CACHE_HOME.
# Optional 2nd arg: force this agent name (register; also write pane cache).

resolve_worker_identity() {
  local program="${1:?resolve_worker_identity requires a program (e.g. cursor-agent)}"
  local explicit_name="${2:-}"

  local repo repo_slug
  repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  repo_slug="$(basename "$repo")"

  # Workers ALWAYS enforce reservations — never inherit a coordinator's bypass.
  unset AGENT_MAIL_BYPASS IS_COORDINATOR

  # Stable pane key: tmux pane id first, wezterm pane id as fallback.
  local pane_key="${TMUX_PANE:-}"
  [[ -z "$pane_key" && -n "${WEZTERM_PANE:-}" ]] && pane_key="wez-${WEZTERM_PANE}"

  local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/agent-mail-identity"
  local name="" cache_file="" safe_key
  if [[ -n "$pane_key" ]]; then
    safe_key="$(printf '%s' "${repo_slug}_${pane_key}" | tr -c 'A-Za-z0-9_.-' '_')"
    cache_file="$cache_dir/$safe_key"
    [[ -f "$cache_file" ]] && name="$(cat "$cache_file" 2>/dev/null)"
  fi

  local create_out=""
  if [[ -n "$explicit_name" ]]; then
    name="$explicit_name"
    am agents register --project "$repo" --program "$program" \
       --model "${AGENT_MODEL:-unknown}" --name "$name" --task "$program session" \
       --json >/dev/null 2>&1 || true
    [[ -n "$cache_file" ]] && { mkdir -p "$cache_dir"; printf '%s' "$name" > "$cache_file"; }
  elif [[ -n "$name" ]]; then
    # Reuse this pane's identity; refresh last_active (idempotent).
    am agents register --project "$repo" --program "$program" \
       --model "${AGENT_MODEL:-unknown}" --name "$name" --task "$program session" \
       --json >/dev/null 2>&1 || true
  else
    # First launch in this pane (or no pane id): mint a fresh unique identity.
    create_out="$(am agents create --project "$repo" --program "$program" \
                    --model "${AGENT_MODEL:-unknown}" --task "$program session" --json 2>&1)"
    name="$(printf '%s' "$create_out" | jq -r '.name // empty' 2>/dev/null)"
    [[ -n "$name" && -n "$cache_file" ]] && { mkdir -p "$cache_dir"; printf '%s' "$name" > "$cache_file"; }
  fi

  if [[ -n "$name" ]]; then
    export AGENT_NAME="$name"
    printf '🪪 agent-mail worker: %s%s\n' "$AGENT_NAME" "${pane_key:+ (pane $pane_key)}" >&2
    return 0
  elif [[ "${AGENT_ALLOW_NO_IDENTITY:-}" == "1" ]]; then
    printf '⚠️  agent-mail: launching WITHOUT an identity (AGENT_ALLOW_NO_IDENTITY=1). AGENT_NAME=%s\n' \
      "${AGENT_NAME:-<unset>}" >&2
    return 0
  else
    {
      echo "✗ agent-mail: could not obtain a worker identity for this pane — refusing to launch."
      echo "  A worker must never run unidentified: it cannot claim beads with"
      echo "  --assignee \"\$AGENT_NAME\", and the pre-commit guard blocks its commits."
      echo
      echo "  Diagnose:"
      echo "    • server up?   systemctl --user status mcp-agent-mail   |   am doctor health"
      echo "    • is 'am' on PATH and is this repo a registered project?"
      if [[ -n "${create_out:-}" ]]; then
        echo "  am agents create said:"
        printf '%s\n' "$create_out" | sed 's/^/    /' | head -6
      fi
      echo
      echo "  Override (not recommended): AGENT_ALLOW_NO_IDENTITY=1 ${program} ..."
    } >&2
    exit 1
  fi
}
