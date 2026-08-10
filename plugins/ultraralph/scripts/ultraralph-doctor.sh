#!/usr/bin/env bash
# ultraralph-doctor.sh — presence + seam health for the ultraralph rung.
# Read-only. The suite convention: doctor for presence, files for seams.
set -u

usage() {
  cat <<'EOF'
Usage: ultraralph-doctor.sh [--project-dir DIR] [--help]

Checks, in order:
  engine   ultraloop on PATH (legacy shim: a `ralph` binary counts, with a
           rename-pending note) + its version
  seam     .claude/ultra/escalations/ record count + newest record's age —
           a week-old escalation nobody picked up is the seam's one silent
           failure mode; this is where it becomes loud

Exit codes: 0 healthy; 1 finding(s) — engine missing or stale record;
2 usage error.
EOF
}

PROJ="${CLAUDE_PROJECT_DIR:-.}"
while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) PROJ="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "ultraralph-doctor: unknown flag: $1" >&2; exit 2 ;;
  esac
done

ISSUES=0
ok()   { echo "  ok    $1"; }
warn() { echo "  WARN  $1"; ISSUES=1; }
echo "ultraralph doctor"

ENGINE=""
if command -v ultraloop >/dev/null 2>&1; then
  ENGINE=ultraloop
elif command -v ralph >/dev/null 2>&1; then
  ENGINE=ralph
fi
if [ -z "$ENGINE" ]; then
  warn "engine missing — neither ultraloop nor ralph on PATH. Install: clone the engine repo (~/src/ultraloop) and put its bin/ on PATH. Without it the expiry path ends at a saved record."
elif [ "$ENGINE" = "ralph" ]; then
  # A dozen third-party tools ship a `ralph` binary (destiny ruling 1), and
  # the ultraloop rename cascade has landed — a bare `ralph` on PATH is
  # presumptively NOT the engine. Never treat it as one unverified.
  VER=$(ralph --version 2>/dev/null | head -1)
  warn "engine: only a \`ralph\` binary on PATH${VER:+ ($VER)} — likely a third-party ralph tool, not the ultraloop engine (rename cascade landed; docs/design/ultraralph-ultraloop-destiny.md rulings 1-2). Verify its provenance before using it, or install ultraloop (~/src/ultraloop)."
else
  VER=$(ultraloop --version 2>/dev/null | head -1)
  ok "engine: ultraloop on PATH${VER:+ ($VER)}"
fi

SEAM="$PROJ/.claude/ultra/escalations"
if [ -d "$SEAM" ]; then
  COUNT=$(ls "$SEAM"/*.json 2>/dev/null | wc -l)
  if [ "$COUNT" -eq 0 ]; then
    ok "seam: no escalation records"
  else
    NEWEST=$(ls -t "$SEAM"/*.json 2>/dev/null | head -1)
    AGE_S=$(( $(date +%s) - $(stat -c %Y "$NEWEST") ))
    AGE_H=$(( AGE_S / 3600 ))
    if [ "$AGE_S" -gt 604800 ]; then
      warn "seam: $COUNT record(s); newest is $((AGE_H / 24)) day(s) old ($(basename "$NEWEST")) — a week-old escalation nobody picked up"
    else
      ok "seam: $COUNT record(s); newest ${AGE_H}h old ($(basename "$NEWEST"))"
    fi
  fi
else
  ok "seam: no escalation directory (nothing has expired here)"
fi

[ "$ISSUES" -eq 0 ] && echo "  healthy"
exit "$ISSUES"
