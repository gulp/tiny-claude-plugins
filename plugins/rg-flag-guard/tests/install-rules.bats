#!/usr/bin/env bats
#
# Tests for scripts/install-rules.sh — deterministic rules-file installer.

setup() {
  INSTALL="${BATS_TEST_DIRNAME}/../scripts/install-rules.sh"
  SOURCE="${BATS_TEST_DIRNAME}/../rules/search-tools.md"
  WORK="$BATS_TEST_TMPDIR/proj"
  mkdir -p "$WORK"
}

@test "no target scope: usage error, exit 2" {
  run "$INSTALL"
  [ "$status" -eq 2 ]
  echo "$output" | grep -q -- "--help"
}

@test "unknown argument: exit 2" {
  run "$INSTALL" --user --bogus
  [ "$status" -eq 2 ]
}

@test "--help: exit 0, documents exit codes" {
  run "$INSTALL" --help
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "Exit"
}

@test "check on absent target: STATUS absent, exit 3" {
  run "$INSTALL" --project "$WORK" --check
  [ "$status" -eq 3 ]
  echo "$output" | grep -q "^STATUS  absent  "
}

@test "install into empty project: creates file, RESULT installed, exit 0" {
  run "$INSTALL" --project "$WORK"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "^RESULT  installed  "
  cmp -s "$SOURCE" "$WORK/.claude/rules/search-tools.md"
}

@test "reinstall over identical target: RESULT identical, no rewrite needed" {
  "$INSTALL" --project "$WORK" >/dev/null
  run "$INSTALL" --project "$WORK"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "^RESULT  identical  "
}

@test "check on differing target: STATUS differs with diff, exit 4" {
  "$INSTALL" --project "$WORK" >/dev/null
  echo "local edit" >>"$WORK/.claude/rules/search-tools.md"
  run "$INSTALL" --project "$WORK" --check
  [ "$status" -eq 4 ]
  echo "$output" | grep -q "^STATUS  differs  "
  echo "$output" | grep -q "^-local edit"
}

@test "install over differing target without --force: refused, exit 4, file untouched" {
  "$INSTALL" --project "$WORK" >/dev/null
  echo "local edit" >>"$WORK/.claude/rules/search-tools.md"
  run "$INSTALL" --project "$WORK"
  [ "$status" -eq 4 ]
  grep -q "local edit" "$WORK/.claude/rules/search-tools.md"
}

@test "install over differing target with --force: RESULT overwritten" {
  "$INSTALL" --project "$WORK" >/dev/null
  echo "local edit" >>"$WORK/.claude/rules/search-tools.md"
  run "$INSTALL" --project "$WORK" --force
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "^RESULT  overwritten  "
  cmp -s "$SOURCE" "$WORK/.claude/rules/search-tools.md"
}

@test "--user targets ~/.claude/rules under a fake HOME" {
  run env HOME="$WORK" "$INSTALL" --user
  [ "$status" -eq 0 ]
  cmp -s "$SOURCE" "$WORK/.claude/rules/search-tools.md"
}
