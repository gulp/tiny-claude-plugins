#!/usr/bin/env bash
# kittens-saved statusline segment — fast, read-only. Prints:
#     🐈 <saved> · 🙏 <waiting-on-human> · 🙀 <still-yours-to-save>
# and nothing at all when there is nothing to show or enforcement is toggled off.
#
# Wire it into ~/.claude/settings.json:
#   "statusLine": { "type": "command",
#     "command": "bash \"${CLAUDE_PLUGIN_ROOT}/statusline/kittens-segment.sh\"" }
# Statusline hooks receive the same JSON on stdin as other hooks (session_id,
# cwd, …). Kept in bash on purpose: it renders on every prompt, so it must not
# pay a python cold start (the JSON *mutation* lives in scripts/kittens.py).
set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0   # never break the statusline over a dep

input=$(cat 2>/dev/null || printf '')
jf() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

session=$(jf '.session_id')
[ -n "$session" ] && [ -z "${session//[A-Za-z0-9._-]/}" ] || session="${CLAUDE_CODE_SESSION_ID:-}"
[ -n "$session" ] || exit 0

# Global off-switch (plugin userConfig `enabled`, delivered as an env var).
[ "${CLAUDE_PLUGIN_OPTION_ENABLED:-true}" = "false" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-$(jf '.cwd')}"
proj="${proj:-$PWD}"
dir="$proj/.claude/.kittens-saved"
[ -f "$dir/$session.off" ] && exit 0      # per-session mute -> silent
[ -d "$dir" ] || exit 0

# `scope` plugin setting: session (this session's ledger) or all (every ledger).
scope="${CLAUDE_PLUGIN_OPTION_SCOPE:-session}"
if [ "$scope" = all ]; then
  set -- "$dir"/*.jsonl
else
  set -- "$dir/$session.jsonl"
fi
[ -e "$1" ] || exit 0

# saved = sum of n over saved events; yours/mine = the LAST escape declaration
# (in `all` scope, the last across all ledgers concatenated).
read -r saved yours mine < <(
  cat "$@" 2>/dev/null | jq -rs '
    (map(select(.kind=="saved") | (.n // 1)) | add) // 0 as $saved
    | (map(select(.kind=="escape")) | last) as $e
    | "\($saved) \(($e.yours // 0)) \(($e.mine // 0))"
  ' 2>/dev/null
)
saved="${saved:-0}"; yours="${yours:-0}"; mine="${mine:-0}"

[ "$saved" = 0 ] && [ "$yours" = 0 ] && [ "$mine" = 0 ] && exit 0
seg="🐈 $saved"
[ "$yours" != 0 ] && seg="$seg · 🙏 $yours"
[ "$mine" != 0 ] && seg="$seg · 🙀 $mine"
printf '%s\n' "$seg"
