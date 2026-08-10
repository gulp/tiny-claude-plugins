#!/usr/bin/env bash
# test-guard-verdicts.sh — prove goal-stop-guard.sh produces all four verdicts
# against synthetic Stop-hook stdin and fixture state/rubric dirs.
# Exit 0 = all four verdicts proven; exit 1 = a verdict misbehaved.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HERE/goal-stop-guard.sh"
WORK=$(mktemp -d /tmp/ultragoal-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

mk_state() { # dir status attempts max deadline hash [session_id]
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" <<'PYEOF'
import json, sys
d, status, att, mx, dl, h, sid = sys.argv[1:8]
state = {"plan_path":"p.md","rubric_sha256":h,"armed_at":0,
         "deadline_epoch":int(dl),"max_stop_attempts":int(mx),
         "stop_attempts":int(att),"status":status}
if sid:
    state["session_id"] = sid
json.dump(state, open(d+"/state.json","w"))
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

# Verdict 4: EXHAUSTED (attempt cap) -> allow stop, status incomplete + record
D="$WORK/exhaust"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 8 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "exhausted: expected exit 0, got $rc"
grep -q '"status": "incomplete"' "$D/state.json" || fail "exhausted: status not incomplete"

# --- 0.3.0 escalation-writer matrix -----------------------------------------
rec_of() { ls "$1"/.claude/ultra/escalations/*.json 2>/dev/null | head -1; }
jget() { python3 -c "import json,sys;o=json.load(open(sys.argv[1]))
for k in sys.argv[2].split('.'):
    o=o[int(k)] if isinstance(o,list) else o.get(k)
print(json.dumps(o))" "$1" "$2"; }

# Attempt-cap expiry: record exists, cause attempt_cap, spend mirrors state.
REC=$(rec_of "$D"); [ -n "$REC" ] || fail "cap-record: no escalation record written"
[ "$(jget "$REC" expiry_cause)" = '"attempt_cap"' ] || fail "cap-record: expiry_cause wrong"
[ "$(jget "$REC" spend.stop_attempts_used)" = "8" ] || fail "cap-record: stop_attempts_used != 8"
[ "$(jget "$REC" verdict)" = '"expired"' ] || fail "cap-record: verdict not expired"
basename "$REC" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.json$' || fail "cap-record: filename shape wrong"
ls "$D"/.claude/ultra/escalations/.escalation-* 2>/dev/null && fail "cap-record: temp residue left"
grep -q 'escalation record written' "$D/err" || fail "cap-record: guard did not announce the record path"
# Embedded rubric byte-equivalent (json-normalized) + sha pin carried over.
python3 - "$REC" "$D/rubric.json" <<'PYEOF' || fail "cap-record: embedded rubric != rubric.json"
import json, sys
rec, rub = (json.load(open(p)) for p in sys.argv[1:3])
sys.exit(0 if json.dumps(rec["rubric"], sort_keys=True) == json.dumps(rub, sort_keys=True) else 1)
PYEOF
[ "$(jget "$REC" rubric_sha256)" = "\"$(hash_of "$D")\"" ] || fail "cap-record: rubric_sha256 != pin"
grep -q '"last_fired_at"' "$D/state.json" || fail "cap-expiry: no last_fired_at heartbeat"

# Deadline expiry: record with cause deadline; ledger's final entry is the fresh judge run.
D="$WORK/deadline"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 8 1 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "deadline: expected exit 0, got $rc"
REC=$(rec_of "$D"); [ -n "$REC" ] || fail "deadline: no record"
[ "$(jget "$REC" expiry_cause)" = '"deadline"' ] || fail "deadline: expiry_cause wrong"
[ "$(jget "$REC" attempts.0.blocked)" = '"rubric"' ] || fail "deadline: expiry-time ledger entry missing"
[ "$(jget "$REC" attempts.0.failing)" = '["t1"]' ] || fail "deadline: failing ids not captured"

# Ledger accumulation: 2 rubric blocks + 1 dirty_tree block, then cap -> 4 entries (+expiry).
D="$WORK/ledger"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 3 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null   # rubric block 1
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null   # rubric block 2
mk_rubric "$D" "true"   # rubric now passes...
python3 - "$D" <<'PYEOF'
import hashlib, json, sys
d = sys.argv[1]
s = json.load(open(d+"/state.json"))
s["rubric_sha256"] = hashlib.sha256(open(d+"/rubric.json","rb").read()).hexdigest()
json.dump(s, open(d+"/state.json","w"), indent=2)
PYEOF
git -C "$D" init -q && git -C "$D" config user.email t@t && git -C "$D" config user.name t
git -C "$D" commit -q --allow-empty -m init
touch "$D/untracked"                                                        # ...but tree dirty
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null   # dirty_tree block
[ $? -eq 2 ] || fail "ledger: dirty-tree stop should still block (exit 2)"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null   # hits cap -> expiry
REC=$(rec_of "$D"); [ -n "$REC" ] || fail "ledger: no record at cap"
N=$(jget "$REC" attempts | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())))")
[ "$N" = "4" ] || fail "ledger: expected 4 attempts (2 rubric + 1 dirty_tree + expiry), got $N"
CAUSES=$(jget "$REC" attempts | python3 -c "import json,sys;print(' '.join(a['blocked'] for a in json.loads(sys.stdin.read())))")
[ "$CAUSES" = "rubric rubric dirty_tree rubric" ] || fail "ledger: causes wrong: $CAUSES"
[ "$(jget "$REC" attempts.2.failing)" = "[]" ] || fail "ledger: dirty_tree entry should carry failing: []"
[ "$(jget "$REC" attempts.2.workspace)" != "null" ] || fail "ledger: dirty_tree in a git repo should carry a workspace hash"

# Collision: writer refuses a second record with the same stamp, first untouched.
BEFORE=$(cat "$REC")
python3 "$HERE/write-escalation.py" --state-dir "$D" --cause deadline \
  --project-dir "$D" --stamp "$(basename "$REC" | cut -d- -f1)" >/dev/null 2>"$D/collide-err" && \
  fail "collision: second write should refuse"
grep -q 'refusing to overwrite' "$D/collide-err" || fail "collision: no refuse message"
[ "$(cat "$REC")" = "$BEFORE" ] || fail "collision: first record was modified"
ls "$D"/.claude/ultra/escalations/.escalation-* 2>/dev/null && fail "collision: temp residue left"

# No record on done / tampered / no-goal paths; heartbeat only when armed.
[ -z "$(rec_of "$WORK/pass")" ] || fail "no-record: done path wrote a record"
[ -z "$(rec_of "$WORK/tamper")" ] || fail "no-record: tampered path wrote a record"
grep -q '"last_fired_at"' "$WORK/pass/state.json" || fail "heartbeat: done path missing last_fired_at"
grep -q '"last_fired_at"' "$WORK/tamper/state.json" || fail "heartbeat: tampered path missing last_fired_at"
D="$WORK/nogoal"; mkdir -p "$D"; mk_rubric "$D" "true"; mk_state "$D" done 0 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null
grep -q '"last_fired_at"' "$D/state.json" && fail "heartbeat: unarmed state was stamped"
[ -z "$(rec_of "$D")" ] || fail "no-record: unarmed path wrote a record"

# --- 0.4.0 multi-session guard ----------------------------------------------
# Bystander session: armed by X, stop from Y -> exit 0, nothing touched.
D="$WORK/bystander"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 8 9999999999 "$(hash_of "$D")" sessX
echo '{"session_id":"sessY"}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 0 ] || fail "bystander: expected exit 0, got $rc"
grep -q '"stop_attempts": 0' "$D/state.json" || fail "bystander: attempt budget was burned"
grep -q '"last_fired_at"' "$D/state.json" && fail "bystander: heartbeat was stamped"
[ -f "$D/attempts.jsonl" ] && fail "bystander: ledger entry written"
[ -s "$D/err" ] && fail "bystander: guard was not silent"

# Arming session: same state, stop from X -> still enforced (exit 2, increment).
echo '{"session_id":"sessX"}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>"$D/err"; rc=$?
[ $rc -eq 2 ] || fail "owner: expected exit 2, got $rc"
grep -q '"stop_attempts": 1' "$D/state.json" || fail "owner: attempt not counted"

# Back-compat: state without session_id conscripts every caller.
D="$WORK/conscript"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 8 9999999999 "$(hash_of "$D")"
echo '{"session_id":"sessY"}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null; rc=$?
[ $rc -eq 2 ] || fail "conscript: pre-0.4.0 state should still gate everyone, got $rc"

# --- spend.tokens from transcript --------------------------------------------
D="$WORK/tokens"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 8 8 9999999999 "$(hash_of "$D")" sessX
printf '%s\n%s\n%s\n' \
  '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":1000}}}' \
  '{"type":"user"}' \
  '{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":50}}}' \
  > "$D/transcript.jsonl"
echo "{\"session_id\":\"sessX\",\"transcript_path\":\"$D/transcript.jsonl\"}" | \
  CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null
REC=$(rec_of "$D"); [ -n "$REC" ] || fail "tokens: no record at cap"
[ "$(jget "$REC" spend.tokens.output)" = "150" ] || fail "tokens: output sum wrong"
[ "$(jget "$REC" spend.tokens.input)" = "15" ] || fail "tokens: input sum wrong"
[ "$(jget "$REC" spend.tokens.cache_read)" = "1000" ] || fail "tokens: cache_read sum wrong"
# Absent transcript -> tokens stays null, never a fabricated zero.
D="$WORK/notokens"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 8 8 9999999999 "$(hash_of "$D")"
echo '{}' | CLAUDE_PROJECT_DIR="$D" "$GUARD" --state-dir "$D" 2>/dev/null
REC=$(rec_of "$D"); [ -n "$REC" ] || fail "notokens: no record at cap"
[ "$(jget "$REC" spend.tokens)" = "null" ] || fail "notokens: tokens should be null without a transcript"

# --- doctor smoke -------------------------------------------------------------
DOCTOR="$HERE/goal-doctor.sh"
D="$WORK/doc-healthy"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 1 8 9999999999 "$(hash_of "$D")" sessX
python3 - "$D" <<'PYEOF'
import json
d = __import__("sys").argv[1]
s = json.load(open(d+"/state.json")); s["last_fired_at"] = "2026-01-01T00:00:00Z"
json.dump(s, open(d+"/state.json","w"))
PYEOF
"$DOCTOR" --state-dir "$D" --session-id sessX >"$D/out" 2>&1; rc=$?
[ $rc -eq 0 ] || fail "doctor-healthy: expected exit 0, got $rc ($(cat "$D/out"))"
grep -q 'owned by this session' "$D/out" || fail "doctor-healthy: ownership line missing"
D="$WORK/doc-sick"; mkdir -p "$D"; mk_rubric "$D" "false"; mk_state "$D" armed 0 8 9999999999 "deadbeef" sessX
"$DOCTOR" --state-dir "$D" --session-id sessX >"$D/out" 2>&1; rc=$?
[ $rc -eq 1 ] || fail "doctor-sick: expected exit 1 on hash mismatch + dead hook, got $rc"
grep -q 'hash mismatch' "$D/out" || fail "doctor-sick: no hash-mismatch finding"
grep -q 'never fired' "$D/out" || fail "doctor-sick: no liveness finding"
"$DOCTOR" --state-dir "$WORK/does-not-exist" >/dev/null 2>&1 || fail "doctor-nogoal: no goal should be exit 0"

echo "all verdicts + escalation-record + multi-session + doctor matrix proven"
exit 0
