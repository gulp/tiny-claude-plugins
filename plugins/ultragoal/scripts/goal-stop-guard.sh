#!/usr/bin/env bash
# goal-stop-guard.sh — Stop-hook enforcement for ultragoal.
# Reads the Stop-hook JSON on stdin (unused fields tolerated). No-op unless a
# goal is armed. Exit 0 = allow stop; exit 2 = block stop, stderr feeds back
# the failing checks as the session's next marching order.
set -u

usage() {
  cat <<'EOF'
Usage: goal-stop-guard.sh [--state-dir DIR] [--help]

Stop-hook entry for ultragoal. Reads hook JSON on stdin.

Flags:
  --state-dir DIR   Directory holding state.json + rubric.json
                    (default: $CLAUDE_PROJECT_DIR/.claude/.ultragoal)
  --help            Show this help.

Behavior (armed goals only; otherwise silent no-op, exit 0):
  all pass + hash ok   -> status=done, allow stop, ✓ table on stderr
  some fail            -> exit 2, failing checks on stderr (session continues)
  rubric hash mismatch -> status=tampered, allow stop, loud verdict
  attempts/deadline up -> status=incomplete, allow stop, loud verdict

Exit codes:
  0  allow stop (no goal, or done/tampered/incomplete/bypassed verdict)
  2  block stop — goal armed and rubric not yet satisfied
EOF
}

STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/.ultragoal"
while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "goal-stop-guard: unknown flag: $1" >&2; exit 0 ;;
  esac
done

STATE="$STATE_DIR/state.json"
RUBRIC="$STATE_DIR/rubric.json"
cat >/dev/null 2>&1 || true   # drain hook stdin

[ -f "$STATE" ] || exit 0

field() { python3 -c "import json,sys;print(json.load(open('$STATE')).get('$1',''))" 2>/dev/null; }
setfield() {
  # Atomic: a mid-write crash must not corrupt state.json — a corrupted state
  # silently disarms the goal (seam design decision 6).
  python3 - "$STATE" "$1" "$2" <<'PYEOF'
import json, os, sys, tempfile
p, k, v = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
d[k] = int(v) if v.lstrip("-").isdigit() else v
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(p)) or ".", prefix=".state-")
with os.fdopen(fd, "w") as fh:
    json.dump(d, fh, indent=2)
os.replace(tmp, p)
PYEOF
}
ledger_append() {
  # One line per blocked stop: {"at", "blocked": rubric|dirty_tree,
  # "failing": [ids], "workspace": sha-or-null}. `>>` append is crash-safe by
  # construction (seam design decision 1); workspace hash is the don't-rerun
  # key — sha256 over `git rev-parse HEAD` + `git status --porcelain`, null
  # outside a git repo, never a made-up value.
  python3 - "$STATE_DIR/attempts.jsonl" "$1" "$2" "${CLAUDE_PROJECT_DIR:-.}" <<'PYEOF'
import datetime, hashlib, json, subprocess, sys
path, cause, failing_json, proj = sys.argv[1:5]
try:
    failing = json.loads(failing_json)
except ValueError:
    failing = []
workspace = None
try:
    head = subprocess.run(["git", "-C", proj, "rev-parse", "HEAD"],
                          capture_output=True, text=True, timeout=10)
    if head.returncode == 0:
        porc = subprocess.run(["git", "-C", proj, "status", "--porcelain"],
                              capture_output=True, text=True, timeout=10)
        workspace = hashlib.sha256((head.stdout + porc.stdout).encode()).hexdigest()
except Exception:
    workspace = None
entry = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
         "blocked": cause, "failing": failing, "workspace": workspace}
with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry) + "\n")
PYEOF
}
write_record() {
  # Expiry only. Writer failure must not change the verdict.
  REC=$(python3 "$(dirname "$0")/write-escalation.py" --state-dir "$STATE_DIR" \
        --cause "$1" --project-dir "${CLAUDE_PROJECT_DIR:-.}") || {
    echo "ultragoal: escalation record could not be written — verdict unaffected" >&2
    return 0
  }
  echo "ultragoal: escalation record written: $REC" >&2
  SUGGESTED=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['handoff']['suggested'])" "$REC" 2>/dev/null)
  [ -n "$SUGGESTED" ] && echo "ultragoal: next rung: $SUGGESTED" >&2
  return 0
}

STATUS=$(field status)
[ "$STATUS" = "armed" ] || exit 0
# Heartbeat (design decision 8): every armed invocation leaves proof the hook
# ran — "armed + never fired" is the detached-hook failure mode made loud.
setfield last_fired_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -f "$RUBRIC" ] || { echo "ultragoal: armed but rubric missing — standing down" >&2; setfield status incomplete; exit 0; }

# Hash pin: the judge must not have been edited since arming.
PINNED=$(field rubric_sha256)
ACTUAL=$(sha256sum "$RUBRIC" | cut -d' ' -f1)
if [ -n "$PINNED" ] && [ "$PINNED" != "$ACTUAL" ]; then
  setfield status tampered
  echo "ultragoal VERDICT: TAMPERED — rubric.json was modified after arming (pinned ${PINNED:0:12}…, found ${ACTUAL:0:12}…). Success cannot be certified." >&2
  exit 0
fi

# Bounded enforcement: never trap a session forever.
ATTEMPTS=$(field stop_attempts); ATTEMPTS=${ATTEMPTS:-0}
MAX=$(field max_stop_attempts); MAX=${MAX:-8}
DEADLINE=$(field deadline_epoch); DEADLINE=${DEADLINE:-0}
NOW=$(date +%s)
expire() { # $1 = deadline|attempt_cap  — capture a fresh judge run as the
  # ledger's final entry (design decision 3), then write the record.
  FINAL=$("$(dirname "$0")/rubric-check.sh" --rubric "$RUBRIC" 2>/dev/null) || true
  FAILING=$(printf '%s' "$FINAL" | python3 -c "import json,sys;print(json.dumps(json.loads(sys.stdin.read().strip().splitlines()[-1]).get('failing',[])))" 2>/dev/null)
  ledger_append rubric "${FAILING:-[]}"
  write_record "$1"
}
if [ "$DEADLINE" -gt 0 ] && [ "$NOW" -gt "$DEADLINE" ]; then
  setfield status incomplete
  echo "ultragoal VERDICT: INCOMPLETE — deadline passed. Failing checks:" >&2
  expire deadline
  exit 0
fi
if [ "$ATTEMPTS" -ge "$MAX" ]; then
  setfield status incomplete
  echo "ultragoal VERDICT: INCOMPLETE — $ATTEMPTS stop attempts reached the cap ($MAX). Failing checks:" >&2
  expire attempt_cap
  exit 0
fi
setfield stop_attempts $((ATTEMPTS+1))

RESULT=$("$(dirname "$0")/rubric-check.sh" --rubric "$RUBRIC" 2>/dev/null)
RC=$?
if [ "$RC" -eq 0 ]; then
  # Commit-before-certify: a certified state must be a committed state —
  # otherwise the tag points at a tree without the certified work.
  if git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --git-dir >/dev/null 2>&1; then
    if [ -n "$(git -C "${CLAUDE_PROJECT_DIR:-.}" status --porcelain 2>/dev/null)" ]; then
      ledger_append dirty_tree '[]'
      echo "ultragoal: rubric passes but the working tree is dirty — commit your work (git add + commit), then stop again to certify. Attempt $((ATTEMPTS+1))/$MAX." >&2
      exit 2
    fi
  fi
  setfield status done
  # Tag on DONE (vanilla ralph instr. 7): patch-increment from latest X.Y.Z tag,
  # 0.0.0 if none. Non-git dir -> skip with a note, never fail the verdict.
  TAG=""
  if git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --git-dir >/dev/null 2>&1; then
    LAST=$(git -C "${CLAUDE_PROJECT_DIR:-.}" tag --list '[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname 2>/dev/null | head -1)
    if [ -z "$LAST" ]; then TAG="0.0.0"; else
      TAG=$(echo "$LAST" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')
    fi
    if git -C "${CLAUDE_PROJECT_DIR:-.}" tag -a "$TAG" -m "ultragoal DONE: $(field plan_path) rubric ${ACTUAL:0:12}" 2>/dev/null; then
      setfield tag "$TAG"
    else
      echo "ultragoal: tag $TAG could not be created (dirty ref or no commits) — verdict unaffected" >&2; TAG=""
    fi
  else
    echo "ultragoal: not a git repo — skip-tag mode, verdict unaffected" >&2
  fi
  echo "ultragoal VERDICT: DONE — all rubric checks pass, hash verified.${TAG:+ tagged $TAG.} $RESULT" >&2
  exit 0
fi
FAILING=$(printf '%s' "$RESULT" | python3 -c "import json,sys;print(json.dumps(json.loads(sys.stdin.read().strip().splitlines()[-1]).get('failing',[])))" 2>/dev/null)
ledger_append rubric "${FAILING:-[]}"
echo "ultragoal: goal not yet met — $RESULT. Run the failing checks' commands (see $RUBRIC), fix what they test, then finish. Attempt $((ATTEMPTS+1))/$MAX." >&2
exit 2
