#!/usr/bin/env bash
# Self-contained tests for watch-mail.sh — argument validation + high-water-mark
# no-replay / new-emission behavior, driven by a fake `am` on PATH (real jq).
# Exit 0 = all pass, 1 = a test failed, 0 with SKIP if a tool is unavailable.
set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
WATCH="$SCRIPT_DIR/../scripts/watch-mail.sh"
fails=0
check() { # desc, actual, expected
	if [ "$2" = "$3" ]; then
		printf 'ok   — %s\n' "$1"
	else
		printf 'FAIL — %s (got [%s] want [%s])\n' "$1" "$2" "$3"
		fails=$((fails + 1))
	fi
}

command -v jq >/dev/null 2>&1      || { echo "SKIP: jq not on PATH"; exit 0; }
command -v timeout >/dev/null 2>&1 || { echo "SKIP: timeout not on PATH"; exit 0; }
command -v mktemp >/dev/null 2>&1  || { echo "SKIP: mktemp not on PATH"; exit 0; }

# --- argument validation (exit codes) ---
"$WATCH" --help >/dev/null 2>&1;                 check "--help exits 0"            "$?" "0"
"$WATCH" >/dev/null 2>&1;                         check "missing --agent exits 2"  "$?" "2"
"$WATCH" --agent A --interval 0 >/dev/null 2>&1;  check "--interval 0 exits 2"     "$?" "2"
"$WATCH" --agent A --interval x >/dev/null 2>&1;  check "--interval non-int exits 2" "$?" "2"
"$WATCH" --agent A --since -1 >/dev/null 2>&1;    check "--since negative exits 2" "$?" "2"
"$WATCH" --bogus >/dev/null 2>&1;                 check "unknown arg exits 2"      "$?" "2"

# --- high-water-mark behavior with a fake `am` (grows 5 → 7 messages) ---
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/am" <<'FAKE'
#!/usr/bin/env bash
# fake am: `check-inbox --json` returns ids 1..5 on poll 1, then 1..7 after.
state="${FAKE_AM_STATE:?}"
n=$(cat "$state" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" >"$state"
if [ "$n" -ge 2 ]; then maxid=7; else maxid=5; fi
printf '{"messages":['
sep=""; i=1
while [ "$i" -le "$maxid" ]; do
	printf '%s{"id":%d,"from":"S%d","importance":"normal","subject":"subj %d"}' "$sep" "$i" "$i" "$i"
	sep=","; i=$((i + 1))
done
printf ']}\n'
FAKE
chmod +x "$tmp/am"
export FAKE_AM_STATE="$tmp/state"

# interval 1, timeout 6 → ~5 polls: baseline adopts 5 (no replay), poll 2 emits 6,7.
out=$(PATH="$tmp:$PATH" timeout 6 "$WATCH" --agent T --project "$tmp" --interval 1 2>/dev/null)

emitted=$(printf '%s\n' "$out" | grep -c '^MAIL #')
check "emits exactly 2 new messages"        "$emitted" "2"
printf '%s\n' "$out" | grep -q '^MAIL #6 from S6 \[normal\]: subj 6$'; check "emits #6" "$?" "0"
printf '%s\n' "$out" | grep -q '^MAIL #7 from S7 \[normal\]: subj 7$'; check "emits #7" "$?" "0"
if printf '%s\n' "$out" | grep -q '^MAIL #5'; then r=present; else r=absent; fi
check "does NOT replay baseline #5"          "$r" "absent"

# --- null JSON fields render as placeholders, not literal "null" ---
cat >"$tmp/am" <<'FAKE'
#!/usr/bin/env bash
state="${FAKE_AM_STATE:?}"
n=$(cat "$state" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" >"$state"
if [ "$n" -ge 2 ]; then
	printf '{"messages":[{"id":9,"from":null,"importance":null,"subject":null}]}\n'
else
	printf '{"messages":[]}\n'
fi
FAKE
chmod +x "$tmp/am"
printf '0' >"$tmp/state"
out=$(PATH="$tmp:$PATH" timeout 6 "$WATCH" --agent T --project "$tmp" --interval 1 2>/dev/null)
printf '%s\n' "$out" | grep -q '^MAIL #9 from ? \[?\]: (no subject)$'; check "null fields → placeholders" "$?" "0"

if [ "$fails" -eq 0 ]; then
	echo "ALL TESTS PASSED"
	exit 0
fi
echo "$fails TEST(S) FAILED"
exit 1
