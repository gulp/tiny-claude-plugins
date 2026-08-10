#!/usr/bin/env bash
# test-doctor.sh — prove ultraralph-doctor.sh's engine + seam verdicts against
# a controlled PATH and fixture seam dirs. Exit 0 = all proven.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
DOCTOR="$HERE/ultraralph-doctor.sh"
WORK=$(mktemp -d /tmp/ultraralph-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# Controlled PATH: only the fixture bin dir + enough for bash/python/coreutils.
BIN="$WORK/bin"; mkdir -p "$BIN"
run_doctor() { # $1 = project dir
  PATH="$BIN:/usr/bin:/bin" "$DOCTOR" --project-dir "$1"
}

# 1. Engine missing -> WARN, exit 1, install line present.
D="$WORK/p1"; mkdir -p "$D"
OUT=$(run_doctor "$D"); rc=$?
[ $rc -eq 1 ] || fail "missing: expected exit 1, got $rc"
echo "$OUT" | grep -q 'engine missing' || fail "missing: no engine-missing finding"
echo "$OUT" | grep -q 'src/ultraloop' || fail "missing: no install line"

# 2. Only a `ralph` binary -> WARN (third-party presumption), exit 1.
printf '#!/bin/sh\necho ralph-fixture 9.9.9\n' > "$BIN/ralph"; chmod +x "$BIN/ralph"
OUT=$(run_doctor "$D"); rc=$?
[ $rc -eq 1 ] || fail "ralph-only: expected exit 1, got $rc"
echo "$OUT" | grep -q 'third-party' || fail "ralph-only: no third-party warning"
echo "$OUT" | grep -q 'ralph-fixture 9.9.9' || fail "ralph-only: version not surfaced"

# 3. ultraloop present -> ok, exit 0 (ralph still on PATH must not shadow it).
printf '#!/bin/sh\necho ultraloop-fixture 1.0.0\n' > "$BIN/ultraloop"; chmod +x "$BIN/ultraloop"
OUT=$(run_doctor "$D"); rc=$?
[ $rc -eq 0 ] || fail "ultraloop: expected exit 0, got $rc ($OUT)"
echo "$OUT" | grep -q 'ultraloop on PATH' || fail "ultraloop: no ok line"

# 4. Seam: fresh record -> ok; week-old record -> WARN.
S="$D/.claude/ultra/escalations"; mkdir -p "$S"
echo '{}' > "$S/20990101T000000Z-deadbeef.json"
OUT=$(run_doctor "$D"); rc=$?
[ $rc -eq 0 ] || fail "seam-fresh: expected exit 0, got $rc ($OUT)"
echo "$OUT" | grep -q '1 record' || fail "seam-fresh: record not counted"
touch -d '8 days ago' "$S/20990101T000000Z-deadbeef.json"
OUT=$(run_doctor "$D"); rc=$?
[ $rc -eq 1 ] || fail "seam-stale: expected exit 1, got $rc"
echo "$OUT" | grep -q 'week-old' || fail "seam-stale: no stale finding"

echo "ultraralph doctor matrix proven"
exit 0
