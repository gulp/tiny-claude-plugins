#!/usr/bin/env bash
# test-guard-verdicts.sh — prove goal-stop-guard.sh produces all four verdicts
# against synthetic Stop-hook stdin and fixture state/rubric dirs.
# Exit 0 = all four verdicts proven; exit 1 = a verdict misbehaved.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/goal-stop-guard.sh"
WORK=$(mktemp -d /tmp/goal-automata-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

mk_state() { # dir status attempts max deadline hash
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" <<'PYEOF'
import json, sys
d, status, att, mx, dl, h = sys.argv[1:7]
json.dump({"plan_path":"p.md","rubric_sha256":h,"armed_at":0,
           "deadline_epoch":int(dl),"max_stop_attempts":int(mx),
           "stop_attempts":int(att),"status":status}, open(d+"/state.json","w"))
PYEOF
}
mk_rubric() { # dir cmd
  python3 - "$1" "$2" <<'PYEOF'
import json, sys
json.dump({"checks":[{"id":"t1","description":"fixture","command":sys.argv[2],"expect_exit":0}]},
          open(sys.argv[1]+"/rubric.json","w"))
PYEOF
}
hash_of() { sha256sum "$1/rubric.json" | cut -d' ' -f1; }

# Verdict 1: PASS -> allow stop, status done
D="$WORK/pass"; mkdir -p "$D"; mk_rubric "$D" "true"; mk_state "$D" armed 0 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "pass: expected exit 0, got $rc"
grep -q '"status": "done"' "$D/state.json" || fail "pass: status not done"

# Verdict 2: FAIL -> block stop (exit 2) with feedback
D="$WORK/failfb"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 2 ] || fail "fail-feedback: expected exit 2, got $rc"
grep -q 'not yet met' "$D/err" || fail "fail-feedback: no marching-order feedback on stderr"

# Verdict 3: TAMPERED -> allow stop, status tampered
D="$WORK/tamper"; mkdir -p "$D"; mk_rubric "$D" "true"; mk_state "$D" armed 0 8 9999999999 "deadbeef"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "tampered: expected exit 0, got $rc"
grep -q '"status": "tampered"' "$D/state.json" || fail "tampered: status not tampered"
grep -q 'TAMPERED' "$D/err" || fail "tampered: no loud verdict"

# Verdict 4: EXHAUSTED -> allow stop, status incomplete
D="$WORK/exhaust"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 8 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "exhausted: expected exit 0, got $rc"
grep -q '"status": "incomplete"' "$D/state.json" || fail "exhausted: status not incomplete"

echo "all four verdicts proven"
exit 0
