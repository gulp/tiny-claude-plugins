#!/usr/bin/env bats
#
# Tests for scripts/doctor.sh — health check for the rg-flag-guard plugin.

setup() {
  DOCTOR="${BATS_TEST_DIRNAME}/../scripts/doctor.sh"
  unset RG_FLAG_GUARD_DISABLE
}

@test "healthy environment: every guard probe passes" {
  run "$DOCTOR"
  # Exit 0 (all pass) or 1 (warnings only, e.g. a dup registration on the
  # host); never 2 in a working checkout.
  [ "$status" -ne 2 ]
  for check in guard-present guard-deny guard-allow guard-explain; do
    echo "$output" | grep -E "^PASS  ${check}" >/dev/null
  done
}

@test "kill switch set: probes still pass, kill-switch check warns" {
  RG_FLAG_GUARD_DISABLE=1 run "$DOCTOR"
  echo "$output" | grep -E "^PASS  guard-deny" >/dev/null
  echo "$output" | grep -E "^WARN  kill-switch" >/dev/null
  [ "$status" -ge 1 ]
}

@test "missing jq: jq-installed fails, probes skipped, exit 2" {
  # Restrict PATH to a stub dir carrying only the tools doctor needs minus jq.
  stub="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$stub"
  for t in bash rg sed head grep printf env dirname; do
    p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$stub/$t" || true
  done
  run env PATH="$stub" "$DOCTOR"
  [ "$status" -eq 2 ]
  echo "$output" | grep -E "^FAIL  jq-installed" >/dev/null
  echo "$output" | grep -E "^WARN  guard-deny +skipped" >/dev/null
}

@test "--help: exit 0, documents exit codes" {
  run "$DOCTOR" --help
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "Exit"
}

@test "unknown argument: exit 2 with guidance" {
  run "$DOCTOR" --bogus
  [ "$status" -eq 2 ]
  echo "$output" | grep -q -- "--help"
}

@test "output is line-oriented STATUS check detail" {
  run "$DOCTOR"
  echo "$output" | grep -cE "^(PASS|WARN|FAIL)  [a-z-]+  " | grep -qE "^[6-9]|^[0-9]{2}"
}
