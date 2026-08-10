#!/usr/bin/env bash
# rubric-check.sh — run every check in the ultragoal rubric.
# stdout: one JSON line {"pass":N,"fail":M,"failing":[ids]}
# stderr: human-readable per-check table.
set -u

usage() {
  cat <<'EOF'
Usage: rubric-check.sh [--rubric PATH] [--state-dir DIR] [--help]

Runs every check in the rubric and reports results.

Flags:
  --rubric PATH     Rubric file (default: $CLAUDE_PROJECT_DIR/.claude/.ultragoal/rubric.json,
                    falling back to ./.claude/.ultragoal/rubric.json)
  --state-dir DIR   Directory holding rubric.json (alternative to --rubric)
  --help            Show this help.

Output:
  stdout — one JSON line: {"pass":N,"fail":M,"failing":["id",...]}
  stderr — per-check table (✓/✗ id — description)

Exit codes:
  0  all checks pass
  1  one or more checks fail
  2  usage error (unknown flag) or malformed rubric
  3  rubric file not found
EOF
}

RUBRIC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rubric) RUBRIC="${2:-}"; shift 2 ;;
    --state-dir) RUBRIC="${2:-}/rubric.json"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "rubric-check: unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -z "$RUBRIC" ]; then
  base="${CLAUDE_PROJECT_DIR:-.}"
  RUBRIC="$base/.claude/.ultragoal/rubric.json"
fi
[ -f "$RUBRIC" ] || { echo "rubric-check: rubric not found: $RUBRIC" >&2; exit 3; }

# Extract checks as TAB-separated id<TAB>expect<TAB>command lines via python3.
LINES=$(python3 - "$RUBRIC" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    checks = d["checks"]
    for c in checks:
        cmd = c["command"].replace("\t", " ").replace("\n", " ")
        print(f'{c["id"]}\t{c.get("expect_exit",0)}\t{cmd}')
except Exception as e:
    print(f"MALFORMED: {e}", file=sys.stderr)
    sys.exit(2)
PYEOF
) || exit 2

PASS=0; FAIL=0; FAILING=""
while IFS=$'\t' read -r id expect cmd; do
  [ -n "$id" ] || continue
  bash -c "$cmd" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq "$expect" ]; then
    PASS=$((PASS+1)); echo "  ✓ $id" >&2
  else
    FAIL=$((FAIL+1)); FAILING="$FAILING\"$id\","
    echo "  ✗ $id (exit $rc, expected $expect)" >&2
  fi
done <<< "$LINES"

FAILING="[${FAILING%,}]"
echo "{\"pass\":$PASS,\"fail\":$FAIL,\"failing\":$FAILING}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
