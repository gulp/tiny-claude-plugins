#!/usr/bin/env bash
# goal-doctor.sh — health report for the armed (or last) ultragoal.
# Read-only: never mutates state.json, the rubric, or the ledger.
set -u

usage() {
  cat <<'EOF'
Usage: goal-doctor.sh [--state-dir DIR] [--session-id ID] [--help]

Health report for the goal in the state dir. Checks, in order:
  state        state.json present and parseable; status + plan
  ownership    whose goal it is (state session_id vs this session's)
  judge        rubric.json present; sha256 matches the armed pin
  liveness     armed + last_fired_at absent = guard has not fired —
               if the plugin was installed after this session started,
               the hook set predates it; restart the session
  budget       stop attempts used/max, deadline remaining
  rubric       fresh pass/fail run via rubric-check.sh

Flags:
  --state-dir DIR    default: $CLAUDE_PROJECT_DIR/.claude/.ultragoal
  --session-id ID    default: $CLAUDE_CODE_SESSION_ID

Exit codes: 0 healthy (or no goal); 1 issue(s) found — that is the
finding, not a broken command; 2 usage/unreadable state.
EOF
}

STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/.ultragoal"
SESSION="${CLAUDE_CODE_SESSION_ID:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --session-id) SESSION="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "goal-doctor: unknown flag: $1" >&2; exit 2 ;;
  esac
done

STATE="$STATE_DIR/state.json"
RUBRIC="$STATE_DIR/rubric.json"
ISSUES=0
ok()   { echo "  ok    $1"; }
warn() { echo "  WARN  $1"; ISSUES=1; }

if [ ! -f "$STATE" ]; then
  echo "ultragoal doctor: no goal (no state.json in $STATE_DIR)"
  exit 0
fi
if ! python3 -c "import json;json.load(open('$STATE'))" 2>/dev/null; then
  echo "ultragoal doctor: state.json unparseable — enforcement is silently disarmed" >&2
  exit 2
fi
field() { python3 -c "import json;v=json.load(open('$STATE')).get('$1','');print(v if v is not None else '')" 2>/dev/null; }

STATUS=$(field status)
echo "ultragoal doctor: $STATE_DIR"
echo "  status: ${STATUS:-unset} · plan: $(field plan_path)"

OWNER=$(field session_id)
if [ -z "$OWNER" ]; then
  warn "no session_id in state (armed pre-0.4.0?) — every session in this project dir is conscripted and shares the attempt budget"
elif [ -n "$SESSION" ] && [ "$OWNER" != "$SESSION" ]; then
  ok "owned by session ${OWNER:0:8}… (not this session — its stops are not gated)"
else
  ok "owned by this session (${OWNER:0:8}…)"
fi

if [ ! -f "$RUBRIC" ]; then
  warn "rubric.json missing — the guard will stand down as incomplete on next stop"
else
  PINNED=$(field rubric_sha256)
  ACTUAL=$(sha256sum "$RUBRIC" | cut -d' ' -f1)
  if [ -n "$PINNED" ] && [ "$PINNED" != "$ACTUAL" ]; then
    warn "rubric hash mismatch (pinned ${PINNED:0:12}…, found ${ACTUAL:0:12}…) — next stop verdicts TAMPERED"
  else
    ok "rubric pinned and unmodified (${ACTUAL:0:12}…)"
  fi
fi

if [ "$STATUS" = "armed" ]; then
  if [ -z "$(field last_fired_at)" ]; then
    warn "armed but the guard has never fired (no last_fired_at) — if the plugin was installed after this session started, the hook set predates it; restart the session before trusting enforcement"
  else
    ok "guard live — last fired $(field last_fired_at)"
  fi
  ATTEMPTS=$(field stop_attempts); ATTEMPTS=${ATTEMPTS:-0}
  MAX=$(field max_stop_attempts); MAX=${MAX:-8}
  DEADLINE=$(field deadline_epoch); DEADLINE=${DEADLINE:-0}
  NOW=$(date +%s)
  if [ "$ATTEMPTS" -ge "$MAX" ] 2>/dev/null; then
    warn "attempt budget exhausted ($ATTEMPTS/$MAX) — next stop expires the goal"
  else
    ok "attempts $ATTEMPTS/$MAX"
  fi
  if [ "$DEADLINE" -gt 0 ] 2>/dev/null; then
    if [ "$NOW" -gt "$DEADLINE" ]; then
      warn "deadline passed — next stop expires the goal"
    else
      ok "deadline in $(( (DEADLINE - NOW) / 60 )) min"
    fi
  fi
  if [ -f "$RUBRIC" ]; then
    RESULT=$("$(dirname "$0")/rubric-check.sh" --rubric "$RUBRIC" 2>/dev/null)
    RC=$?
    if [ "$RC" -eq 0 ]; then ok "rubric passes now — a clean stop certifies (commit first)"
    else echo "  info  rubric not yet met — $RESULT"; fi
  fi
fi

[ "$ISSUES" -eq 0 ] && echo "  healthy"
exit "$ISSUES"
