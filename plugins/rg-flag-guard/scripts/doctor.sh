#!/bin/bash
# doctor.sh — health check for the rg-flag-guard plugin.
#
# Read-only: probes the environment and the guard script, changes nothing.
# Output: one "STATUS  check  detail" line per check to stdout; summary last.
# Exit codes: 0 all pass · 1 warnings only · 2 at least one failure.
#
# Checks:
#   rg-installed     ripgrep present (the guard is pointless without it)
#   rg-version       major version matches the one VALUE_FLAGS was derived
#                    from (13-15 share the value-flag set; warn outside that)
#   jq-installed     without jq the hook FAILS OPEN silently
#   guard-present    the hook script exists and is executable
#   guard-deny       live probe: deny-shape JSON exits 2 with a suggestion
#   guard-allow      live probe: clean command is silently allowed (exit 0)
#   guard-explain    --explain agrees with hook mode on the deny shape
#   kill-switch      RG_FLAG_GUARD_DISABLE set (guard inert) — warn
#   dup-registration guard also registered in ~/.claude/settings.json
#                    (fires twice alongside the plugin) — warn

set -u

GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rg-flag-guard.sh"
FAIL=0
WARN=0

report() { # report <PASS|WARN|FAIL> <check> <detail>
  case "$1" in
    FAIL) FAIL=$((FAIL + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
  esac
  printf '%-4s  %-16s  %s\n' "$1" "$2" "$3"
}

usage() {
  cat <<'EOF'
doctor.sh — health check for rg-flag-guard. Read-only, no arguments.
Prints one "STATUS  check  detail" line per check.
Exit: 0 all pass · 1 warnings only · 2 at least one failure.
EOF
}

case "${1:-}" in
  --help | -h)
    usage
    exit 0
    ;;
  '') ;;
  *)
    echo "unknown argument: $1 (this script takes none; see --help)" >&2
    exit 2
    ;;
esac

# --- ripgrep ---------------------------------------------------------------
if command -v rg >/dev/null 2>&1; then
  report PASS rg-installed "$(command -v rg)"
  RG_VERSION=$(rg --version 2>/dev/null | head -1 | sed -E 's/^ripgrep ([0-9.]+).*/\1/')
  RG_MAJOR=${RG_VERSION%%.*}
  if [ -n "$RG_MAJOR" ] && [ "$RG_MAJOR" -ge 13 ] 2>/dev/null && [ "$RG_MAJOR" -le 15 ]; then
    report PASS rg-version "ripgrep $RG_VERSION (value-flag set verified for 13-15)"
  elif [ -n "$RG_VERSION" ]; then
    report WARN rg-version "ripgrep $RG_VERSION — outside 13-15; re-derive VALUE_FLAGS from 'rg --help' (short flags taking a value) and update the guard"
  else
    report WARN rg-version "could not parse 'rg --version' output"
  fi
else
  report FAIL rg-installed "ripgrep not on PATH — install it (pacman -S ripgrep / apt install ripgrep / brew install ripgrep)"
fi

# --- jq --------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  report PASS jq-installed "$(command -v jq)"
else
  report FAIL jq-installed "jq not on PATH — the guard FAILS OPEN (allows everything) without it. Install: pacman -S jq / apt install jq / brew install jq"
fi

# --- guard script ----------------------------------------------------------
if [ -x "$GUARD" ]; then
  report PASS guard-present "$GUARD"
else
  report FAIL guard-present "missing or not executable: $GUARD"
fi

# --- live probes (need guard + jq) ----------------------------------------
if [ -x "$GUARD" ] && command -v jq >/dev/null 2>&1; then
  DENY_JSON='{"tool_name":"Bash","tool_input":{"command":"rg -rn foo src/"}}'

  # Probes bypass the kill switch: they test the classifier itself; the
  # kill-switch check below reports the environment state separately.
  OUT=$(printf '%s' "$DENY_JSON" | env -u RG_FLAG_GUARD_DISABLE "$GUARD")
  RC=$?
  if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null 2>&1; then
    report PASS guard-deny "trap shape denied (exit 2, JSON verdict)"
  else
    report FAIL guard-deny "expected exit 2 + deny JSON for 'rg -rn foo src/', got exit $RC"
  fi

  OUT=$(printf '{"tool_name":"Bash","tool_input":{"command":"rg -n foo src/"}}' | env -u RG_FLAG_GUARD_DISABLE "$GUARD")
  RC=$?
  if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then
    report PASS guard-allow "clean command silently allowed"
  else
    report FAIL guard-allow "expected silent exit 0 for 'rg -n foo src/', got exit $RC output '$OUT'"
  fi

  env -u RG_FLAG_GUARD_DISABLE "$GUARD" --explain 'rg -rn foo src/' >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 2 ]; then
    report PASS guard-explain "--explain agrees with hook mode (deny)"
  else
    report FAIL guard-explain "--explain exit $RC for the deny shape (expected 2) — entry modes diverge"
  fi
else
  report WARN guard-deny "skipped (guard or jq unavailable)"
fi

# --- environment -----------------------------------------------------------
if [ -n "${RG_FLAG_GUARD_DISABLE:-}" ]; then
  report WARN kill-switch "RG_FLAG_GUARD_DISABLE is set — the guard is INERT in sessions launched from this environment"
else
  report PASS kill-switch "not set"
fi

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1 \
  && jq -e '[.. | strings | select(test("rg-flag-guard"))] | length > 0' "$SETTINGS" >/dev/null 2>&1; then
  report WARN dup-registration "rg-flag-guard also referenced in $SETTINGS — with the plugin installed it fires twice (harmless but noisy); remove the manual hook entry"
else
  report PASS dup-registration "no duplicate manual registration"
fi

# --- summary ---------------------------------------------------------------
echo
if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: $FAIL failure(s), $WARN warning(s)"
  exit 2
elif [ "$WARN" -gt 0 ]; then
  echo "RESULT: healthy with $WARN warning(s)"
  exit 1
else
  echo "RESULT: all checks passed"
  exit 0
fi
