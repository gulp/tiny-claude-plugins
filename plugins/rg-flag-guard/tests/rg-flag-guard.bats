#!/usr/bin/env bats
#
# Tests for hooks/rg-flag-guard.sh (v2: wrapper-aware, corpus-backed).
#
# The must-allow set is deliberately larger than the must-block set. A guard
# tested only on what it should block has no evidence for the constraint that
# actually matters: a false positive costs trust in the whole hook layer, while
# a false negative only leaves the pre-existing bug in place.
#
# Every classification case is asserted through BOTH entry modes — the hook's
# stdin JSON path and `--explain` — via check_case, so the suite fails if the
# two ever disagree on a verdict.

setup() {
  HOOK="${BATS_TEST_DIRNAME}/../scripts/rg-flag-guard.sh"
  unset RG_FLAG_GUARD_DISABLE
}

# hook_decision <cmd> -> prints allow|ask|deny for the stdin hook path
hook_decision() {
  local out rc
  out=$(jq -cn --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' | "$HOOK")
  rc=$?
  if [ "$rc" -eq 2 ]; then
    echo deny
  elif [ -n "$out" ]; then
    printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision'
  else
    echo allow
  fi
}

# check_case <cmd> <expected allow|ask|deny>
# Asserts --explain decision + exit code, and that hook mode agrees.
check_case() {
  local cmd="$1" expect="$2"
  run "$HOOK" --explain "$cmd"
  local got
  got=$(printf '%s' "$output" | jq -r '.decision')
  [ "$got" = "$expect" ]
  case "$expect" in
    allow) [ "$status" -eq 0 ] ;;
    deny) [ "$status" -eq 2 ] ;;
    ask) [ "$status" -eq 3 ] ;;
  esac
  [ "$(hook_decision "$cmd")" = "$expect" ]
}

# --------------------------------------------------------------------------
# Decision table, row by row
# --------------------------------------------------------------------------

@test "deny: h in a cluster (rg -hn)" { check_case "rg -hn foo" deny; }

@test "deny: r with attached value (rg -rn, the exact observed failure)" {
  check_case "rg -rn 'foo' src/" deny
}

@test "deny: cluster ending in r (rg -nr X) — was ask in v1" {
  check_case "rg -nr main f" deny
}

@test "deny: cluster ending in r (rg -ir X) — corpus shows never deliberate" {
  check_case "rg -ir X main src/" deny
}

@test "deny: standalone -r with no following token" {
  check_case "rg foo -r" deny
}

@test "allow: standalone -r with \$-capture replacement" {
  check_case "rg '^v(.*)' -r '\$1'" allow
}

@test "allow: standalone -r with \${...} replacement" {
  check_case "rg 'v(?P<x>.*)' -r '\${x}' Cargo.toml" allow
}

@test "allow: standalone -r with empty-string strip replacement" {
  check_case "rg -r '' pat file" allow
}

@test "deny: standalone -r with a plain-word replacement (promoted from ask after live probes)" {
  check_case "rg -r main src/" deny
}

@test "deny: the exact live-probe bait shape (standalone -r before a path)" {
  check_case "rg -n \"permissionDecision\" -r ~/.claude/hooks" deny
}

@test "allow: long-form --replace" { check_case "rg --replace X foo" allow; }

@test "allow: bare -h help request" { check_case "rg -h" allow; }

@test "allow: -In, the real no-filename flag" { check_case "rg -In foo" allow; }

@test "allow: flags after a bare -- terminator" {
  check_case "rg -n -- -rn" allow
}

# --------------------------------------------------------------------------
# Wrapper unwrapping (Section 1 acceptance criteria)
# --------------------------------------------------------------------------

@test "deny: snip run -- rg -nr (the AGENTS.md wrapper no longer bypasses)" {
  check_case "snip run -- rg -nr foo path" deny
}

@test "deny: full-path snip run -- rg -rn" {
  check_case "/usr/local/bin/snip run -- rg -rn foo ." deny
}

@test "deny: timeout 20s rg -rn (pre-existing blindness fixed)" {
  check_case "timeout 20s rg -rn foo ." deny
}

@test "allow: nested wrappers with deliberate replace" {
  check_case "FOO=1 sudo timeout 5s snip run -- rg -r '\$1' 'v(.*)'" allow
}

@test "allow: post-rg -- still respected through snip" {
  check_case "snip run -- rg -n foo -- -weird-file" allow
}

@test "allow: non-rg command through snip untouched" {
  check_case "snip run -- git log" allow
}

@test "deny: xargs rg -rn" { check_case "xargs rg -rn foo" deny; }

# --- rtk (Rust Token Killer proxy; verified 0.42.0 forwards -rn to rg) -------

@test "deny: rtk rg -rn (rtk forwards the cluster to rg unchanged)" {
  check_case "rtk rg -rn foo ." deny
}

@test "deny: rtk proxy rg -rn (raw passthrough subcommand)" {
  check_case "rtk proxy rg -rn foo ." deny
}

@test "deny: rtk summary rg -nr X" {
  check_case "rtk summary rg -nr main f" deny
}

@test "allow: rtk rg with deliberate \$-capture replace" {
  check_case "rtk rg '^v(.*)' -r '\$1'" allow
}

@test "allow: rtk grep -rn (grep semantics are that subcommand's contract)" {
  check_case "rtk grep -rn foo ." allow
}

@test "allow: rtk's own non-search subcommands untouched" {
  check_case "rtk git status" allow
}

@test "allow: full-path rtk rg clean form" {
  check_case "/usr/local/bin/rtk rg -n foo ." allow
}

@test "deny: timeout-wrapped rtk rg -rn composes" {
  check_case "timeout 20s rtk rg -rn foo ." deny
}

# --------------------------------------------------------------------------
# Command-position and segment handling
# --------------------------------------------------------------------------

@test "deny: trap in a later pipeline segment" {
  check_case "rg -n foo | rg -rn bar" deny
}

@test "deny: trap after a list separator" {
  check_case "cd /tmp && rg -rn foo" deny
}

@test "deny: full-path rg invocation" {
  check_case "/usr/bin/rg -rn foo" deny
}

@test "allow: canonical correct form" { check_case "rg -n foo src/" allow; }

@test "allow: grep -rn (not rg; out of scope)" {
  check_case "grep -rn foo ." allow
}

@test "allow: rg as an argument rather than the command" {
  check_case "echo rg -rn foo" allow
}

@test "allow: unrelated tool" { check_case "fd -e ts" allow; }

@test "allow: long-flag-only invocation" {
  check_case "rg --files -g '*.ts'" allow
}

# --- regressions: value-taking flags swallow the rest of the cluster --------

@test "allow: -g with attached glob containing r (rg -g'*.rs')" {
  check_case "rg -g'*.rs' main src/" allow
}

@test "allow: -g with attached glob containing h (rg -g'*.h')" {
  check_case "rg -g'*.h' main src/" allow
}

@test "allow: -e with attached pattern containing h (rg -eh)" {
  check_case "rg -eh src/" allow
}

@test "allow: -tr, a type value beginning with r (rg -trust)" {
  check_case "rg -trust main src/" allow
}

@test "silent allow: canonical form produces no output in hook mode" {
  run bash -c "jq -n '{tool_name:\"Bash\",tool_input:{command:\"rg -n main src/\"}}' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --------------------------------------------------------------------------
# Agent-legible messages (Section 3 acceptance criteria)
# --------------------------------------------------------------------------

@test "deny message carries the mechanically corrected command" {
  run "$HOOK" --explain "rg -rn foo src/"
  [ "$status" -eq 2 ]
  printf '%s' "$output" | jq -e '.suggestion == "rg -n foo src/"'
  printf '%s' "$output" | jq -e '.reason | contains("rg -n foo src/")'
}

@test "h deny message suggests -I substitution" {
  run "$HOOK" --explain "rg -hn foo a b"
  [ "$status" -eq 2 ]
  printf '%s' "$output" | jq -e '.suggestion | contains("-In")'
}

@test "every non-allow reason names the flag, mentions --replace, has examples" {
  local cmd
  for cmd in "rg -rn foo src/" "rg -nr main f" "rg -hn foo" "rg -r main src/"; do
    run "$HOOK" --explain "$cmd"
    printf '%s' "$output" | jq -e '.reason | contains("--replace")'
    printf '%s' "$output" | jq -e '.reason | contains("Examples:")'
    printf '%s' "$output" | jq -e '.reason | test("rg -[rh]")'
    # Bounded: reasons land in the agent's context window.
    [ "$(printf '%s' "$output" | jq -r '.reason | length')" -le 450 ]
  done
}

@test "hook-mode non-allow output parses and carries the reason" {
  run bash -c "jq -n '{tool_name:\"Bash\",tool_input:{command:\"rg -rn foo src/\"}}' | '$HOOK'"
  [ "$status" -eq 2 ]
  printf '%s' "$output" | jq -e '.hookSpecificOutput.permissionDecisionReason | length > 0'
}

# --------------------------------------------------------------------------
# --explain / --help mode (Section 4 acceptance criteria)
# --------------------------------------------------------------------------

@test "--explain deny: exit 2, decision deny, non-empty suggestion" {
  run "$HOOK" --explain "rg -rn foo ."
  [ "$status" -eq 2 ]
  printf '%s' "$output" | jq -e '.decision == "deny" and (.suggestion | length > 0)'
}

@test "--explain allow: exit 0 for a non-rg command" {
  run "$HOOK" --explain "ls -la"
  [ "$status" -eq 0 ]
  printf '%s' "$output" | jq -e '.decision == "allow"'
}

@test "--explain deny for plain-word -r carries drop-r suggestion and --replace recovery" {
  run "$HOOK" --explain "rg -r main src/"
  [ "$status" -eq 2 ]
  printf '%s' "$output" | jq -e '.decision == "deny"'
  printf '%s' "$output" | jq -e '.suggestion == "rg main src/"'
  printf '%s' "$output" | jq -e '.reason | contains("--replace main")'
}

@test "--help: exit 0, short, documents --explain" {
  run "$HOOK" --help
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | wc -l)" -le 20 ]
  printf '%s' "$output" | grep -q -- '--explain'
}

# --------------------------------------------------------------------------
# Fail-open and kill switch
# --------------------------------------------------------------------------

@test "fails open on malformed JSON" {
  run bash -c "printf 'not json at all' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "fails open on an empty JSON object" {
  run bash -c "printf '{}' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "fails open on a payload with no command field" {
  run bash -c "jq -n '{tool_name:\"Read\",tool_input:{file_path:\"/tmp/x\"}}' | '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "fails open when jq is unavailable" {
  run bash -c "printf '{\"tool_input\":{\"command\":\"rg -rn foo\"}}' | env PATH=/nonexistent /bin/bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "kill switch disables hook mode" {
  run bash -c "jq -n '{tool_name:\"Bash\",tool_input:{command:\"rg -rn foo\"}}' | env RG_FLAG_GUARD_DISABLE=1 '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "kill switch disables --explain mode too" {
  run bash -c "RG_FLAG_GUARD_DISABLE=1 '$HOOK' --explain 'rg -rn foo'"
  [ "$status" -eq 0 ]
  printf '%s' "$output" | jq -e '.decision == "allow"'
}
