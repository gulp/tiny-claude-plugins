#!/bin/bash
# Block ripgrep invocations that fall into its two silent flag traps.
#
# Root cause: rg's short flags do not mean what the equivalent grep flags mean,
# and both mismatches fail *silently* with plausible-looking output.
#
#   rg -r  is --replace, not --recursive. rg is already recursive.
#   rg -h  is --help, not --no-filename (that is -I).
#
# Both are grep muscle memory (`grep -rn` is the most-typed flag pair in Unix),
# so a prose rule in rules/search-tools.md did not prevent them. A hook does not
# depend on what is still in context when the command is generated.
#
# Decision table (corpus-backed; see evidence note below):
#
#   h in a cluster of length > 1 (-hn)        -> DENY  (prints help, exit 0)
#   -r with an ATTACHED value (-rn)           -> DENY  (replaces with "n")
#   cluster len > 1 ending in r (-nr X)       -> DENY  (was ask; see evidence)
#   standalone -r with no following token     -> DENY  (unambiguously broken)
#   standalone -r X where X contains $ or is  -> ALLOW (the deliberate idiom)
#     the literal '' / ""
#   standalone -r X, X a plain word           -> DENY  (promoted from ask
#     2026-08-04: two live subagent probes hit exactly this shape as the trap,
#     zero deliberate uses anywhere, and "ask" silently degrades to allow for
#     background subagents — the very context where the trap fires)
#   --replace, bare -h, operands after --     -> ALLOW (escape hatch)
#
# Evidence: grep.app corpus survey 2026-08-04 (nixpkgs, rust-lang/rust,
# valeriansaliou/sonic, zegl/kube-score, simonmichael/hledger, pokey/dotfiles,
# ripgrep's own test suite): deliberate --replace use is ALWAYS a standalone -r
# token whose value contains a $ capture reference or is the empty string.
# Clustered -r never appears deliberately — only as the grep trap. Reopen the
# ask bucket only if real corpus counterexamples surface.
#
# Wrapper unwrapping: the command word is found by consuming, repeatedly:
#   VAR=val assignments; sudo/env/nice/ionice/nohup/xargs;
#   timeout (+ its flags and one duration token);
#   snip | */snip (+ optional `run`, its -* flags, and one `--`);
#   rtk | */rtk (+ one `proxy`/`summary` passthrough subcommand, if present).
# So `timeout 20s rg …`, the AGENTS.md-mandated `snip run -- rg …`, and
# `rtk rg …` / `rtk proxy rg …` are inspected instead of waved through.
# rtk evidence (0.42.0, verified live 2026-08-04): `rtk rg -rn PAT .` forwards
# the cluster to rg unchanged — matches silently rewritten, exit 0. The rtk
# develop branch strips -r/-R/--recursive before forwarding, but released
# binaries do not; the guard must not assume the fix. `rtk grep …` is left
# alone: that subcommand's contract is grep semantics, where -r is recursion. A `--` seen AFTER rg still ends rg
# option parsing as before.
#
# Modes:
#   hook (default): PreToolUse JSON on stdin; deny -> hookSpecificOutput JSON +
#     exit 2; ask -> JSON + exit 0; allow -> silent exit 0. Fails OPEN on any
#     parse trouble — never hard-errors the harness.
#   --explain 'CMD': classify CMD, print one-line JSON verdict
#     {"decision","reason","suggestion"}; exit 0 allow / 2 deny / 3 ask.
#   --help: usage.
#
# Upstream will not fix this. BurntSushi/ripgrep#24 ("rename the -r option")
# was closed WONTFIX in 2016. A local guard is the only mitigation.
#
# Kill switch: RG_FLAG_GUARD_DISABLE=1 disables both modes. It must be in the
# environment Claude Code itself was started with (or settings `env`) — hooks
# run as separate processes, so prefixing the blocked command does nothing.

# Short flags that take a VALUE, from `rg --help` on ripgrep 15.1.0:
#   -e -f -E -m -j -g -d -t -T -A -B -C -M -r
# In a cluster the first of these consumes the remainder of the token, so no
# character after it is a flag. Re-derive if the rg major version changes.
VALUE_FLAGS="efEmjgdtTABCMr"

# Corpus-real example invocations, embedded in every non-allow reason.
EXAMPLES="Examples: rg -n 'todo' src/ ; rg '^v(.*)' -r '\$1'"

DECISION="allow"
REASON=""
SUGGESTION=""

# join_tokens_replacing <idx> <replacement> — rebuild the current segment's
# tokens with tokens[idx] replaced (empty replacement drops the token).
# Reads the global TOKENS array set by segment_classify.
join_tokens_replacing() {
  local idx="$1" repl="$2" out="" j
  for ((j = 0; j < ${#TOKENS[@]}; j++)); do
    local tok="${TOKENS[$j]}"
    if [ "$j" -eq "$idx" ]; then
      tok="$repl"
      [ -z "$tok" ] && continue
    fi
    out="${out:+$out }$tok"
  done
  printf '%s' "$out"
}

# segment_classify <segment> — sets DECISION/REASON/SUGGESTION globals.
# Looks at the segment's *command-position* token only. Not a real shell
# parser: word-splitting ignores quoting (deliberately — quote characters
# survive splitting, so '$1' still contains $ and '' stays a literal token).
# Fail-open over false-block, matching bv-timeout-guard.sh precedent.
segment_classify() {
  local seg="$1"
  set -f
  # shellcheck disable=SC2206
  TOKENS=($seg)
  set +f

  local i=0
  local n=${#TOKENS[@]}
  local t

  # Wrapper prologue grammar: consume assignments and known wrappers with
  # their own arguments until the effective command word is reached.
  while [ "$i" -lt "$n" ]; do
    t="${TOKENS[$i]}"
    case "$t" in
      [A-Za-z_]*=*) i=$((i + 1)) ;;
      sudo | env | nice | ionice | nohup | xargs) i=$((i + 1)) ;;
      timeout)
        i=$((i + 1))
        # timeout's own flags; -k/-s/--kill-after/--signal take a value.
        while [ "$i" -lt "$n" ]; do
          case "${TOKENS[$i]}" in
            -k | -s | --kill-after | --signal) i=$((i + 2)) ;;
            -*) i=$((i + 1)) ;;
            *) break ;;
          esac
        done
        # One duration token, if present.
        if [ "$i" -lt "$n" ] && [[ "${TOKENS[$i]}" =~ ^[0-9]+(\.[0-9]+)?[smhd]?$ ]]; then
          i=$((i + 1))
        fi
        ;;
      snip | */snip)
        i=$((i + 1))
        [ "$i" -lt "$n" ] && [ "${TOKENS[$i]}" = "run" ] && i=$((i + 1))
        while [ "$i" -lt "$n" ]; do
          case "${TOKENS[$i]}" in
            --) i=$((i + 1)); break ;;
            -*) i=$((i + 1)) ;;
            *) break ;;
          esac
        done
        ;;
      rtk | */rtk)
        i=$((i + 1))
        # proxy/summary run an arbitrary command verbatim: keep unwrapping.
        # `rtk rg` leaves rg as the command word for the classifier below.
        # Any other subcommand (grep, git, ls, …) is rtk's own parser: stop,
        # and the non-rg command word falls through to allow.
        if [ "$i" -lt "$n" ]; then
          case "${TOKENS[$i]}" in
            proxy | summary) i=$((i + 1)) ;;
          esac
        fi
        ;;
      *) break ;;
    esac
  done

  [ "$i" -ge "$n" ] && return 0 # nothing left to inspect

  case "${TOKENS[$i]}" in
    rg | */rg) ;;
    *) return 0 ;; # rg isn't the command here
  esac

  i=$((i + 1))
  while [ "$i" -lt "$n" ]; do
    local ti=$((i)) # index of the token being inspected (for suggestions)
    t="${TOKENS[$i]}"
    i=$((i + 1))

    # A bare `--` AFTER rg ends option parsing; the rest are operands.
    [ "$t" = "--" ] && return 0

    # Long flags say what they mean (--replace, --help): never obstructed.
    case "$t" in
      --*) continue ;;
      -?*) ;;
      *) continue ;; # operand, not a flag
    esac

    local cluster="${t#-}"
    local len=${#cluster}
    local k=0
    local c rest

    # Walk the cluster left to right honouring getopt: the first value-taking
    # flag swallows the rest of the token as its VALUE, so scanning stops
    # there. This keeps `rg -g'*.rs' foo` and `rg -eh pat` allowed (the r/h
    # are inside a value, verified legitimate on ripgrep 15.1.0).
    while [ "$k" -lt "$len" ]; do
      c="${cluster:$k:1}"
      rest="${cluster:$((k + 1))}"

      # -h is --help. Bare -h is a real help request; h anywhere in a longer
      # cluster prints help instead of searching.
      if [ "$c" = "h" ] && [ "$len" -gt 1 ]; then
        DECISION="deny"
        SUGGESTION=$(join_tokens_replacing "$ti" "-${cluster/h/I}")
        REASON="rg -h is --help, not --no-filename (that is -I): as written it prints ripgrep's help text and exits 0 instead of searching. Expected: rg -In PATTERN PATH. $EXAMPLES (the second is deliberate --replace). Most likely intended: $SUGGESTION. Retry with that."
        return 0
      fi

      case "$VALUE_FLAGS" in
        *"$c"*)
          if [ "$c" = "r" ]; then
            if [ -n "$rest" ] || [ "$len" -gt 1 ] || [ "$i" -ge "$n" ]; then
              # Attached value (-rn), clustered trailing r (-nr X), or a
              # dangling -r: all the grep muscle-memory trap. Corpus shows
              # deliberate --replace is never clustered.
              DECISION="deny"
              local fixed="-${cluster/r/}"
              [ "$fixed" = "-" ] && fixed=""
              SUGGESTION=$(join_tokens_replacing "$ti" "$fixed")
              REASON="rg -r is --replace, not --recursive (rg is already recursive): as written every match is silently rewritten, so the output looks like a successful search. Expected: rg -n PATTERN PATH. $EXAMPLES. Most likely intended: $SUGGESTION. Retry with that, or spell substitution as --replace."
              return 0
            fi
            # Standalone -r: the next token is its replacement value.
            local val="${TOKENS[$i]}"
            case "$val" in
              *'$'* | "''" | '""')
                # The deliberate idiom: $-capture reference or empty strip.
                i=$((i + 1)) # consume the value token
                continue 2
                ;;
            esac
            # Plain-word replacement: statically this could be deliberate, but
            # live probes (2 agents, 2026-08-04) and the corpus both show only
            # the recursion trap here — and "ask" degrades to silent allow for
            # background subagents, exactly where the trap fires. Deny with the
            # correction; deliberate use recovers via --replace.
            DECISION="deny"
            SUGGESTION=$(join_tokens_replacing "$ti" "")
            REASON="rg -r is --replace, not --recursive: standalone -r takes the next token ($val) as its replacement value and silently rewrites matches. If you meant recursion, drop -r (rg is already recursive): $SUGGESTION. Expected: rg -n PATTERN PATH. $EXAMPLES. Retry with that, or spell deliberate substitution as --replace $val."
            return 0
          fi
          # Other value-taking flag: remainder of the token is its value.
          break
          ;;
      esac

      k=$((k + 1))
    done
  done

  return 0
}

# classify <command-string> — sets DECISION/REASON/SUGGESTION for the first
# non-allow segment. Best-effort split on ; & | && || (not a real parser; the
# common case — a single rg call — is exact).
classify() {
  DECISION="allow"
  REASON=""
  SUGGESTION=""
  local cmd="$1"
  # Fast path: bail before parsing when the text cannot contain an rg call.
  case "$cmd" in
    *rg*) ;;
    *) return 0 ;;
  esac
  local seg trimmed
  while IFS= read -r seg; do
    trimmed="${seg#"${seg%%[![:space:]]*}"}"
    [ -z "$trimmed" ] && continue
    segment_classify "$trimmed"
    [ "$DECISION" != "allow" ] && return 0
  done <<< "$(printf '%s' "$cmd" | sed -E 's/(&&|\|\||[;&|])/\n/g')"
  return 0
}

usage() {
  cat <<'EOF'
rg-flag-guard.sh — PreToolUse guard against ripgrep's silent -r/-h flag traps.

Modes:
  (default)         Hook mode: PreToolUse JSON on stdin.
                    Exit 0 = allow (silent) or ask (JSON on stdout);
                    exit 2 = deny (JSON on stdout). Fails open on bad input.
  --explain 'CMD'   Classify CMD without the hook harness. Prints one-line
                    JSON {"decision","reason","suggestion"}.
                    Exit codes: 0 allow, 2 deny, 3 ask.
  --help            This text.

Examples:
  rg-flag-guard.sh --explain 'rg -rn foo src/'      # deny + corrected command
  rg-flag-guard.sh --explain 'rg pat -r "$1" -o'    # allow (deliberate replace)

Kill switch: RG_FLAG_GUARD_DISABLE=1 in Claude Code's own environment.
EOF
}

# Kill switch first — before any work, so disabling is also the fastest path.
if [ -n "$RG_FLAG_GUARD_DISABLE" ]; then
  if [ "$1" = "--explain" ]; then
    printf '{"decision":"allow","reason":"RG_FLAG_GUARD_DISABLE is set","suggestion":""}\n'
  fi
  exit 0
fi

case "$1" in
  --help)
    usage
    exit 0
    ;;
  --explain)
    classify "$2"
    if command -v jq >/dev/null 2>&1; then
      jq -cn --arg d "$DECISION" --arg r "$REASON" --arg s "$SUGGESTION" \
        '{decision: $d, reason: $r, suggestion: $s}'
    else
      printf '{"decision":"%s"}\n' "$DECISION"
    fi
    case "$DECISION" in
      deny) exit 2 ;;
      ask) exit 3 ;;
      *) exit 0 ;;
    esac
    ;;
esac

# --- hook mode ---
input=$(cat)

# No jq -> can't safely inspect the command; fail open.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

# No command text (or jq choked on malformed JSON) -> fail open.
[ -z "$command" ] && exit 0

classify "$command"

case "$DECISION" in
  allow)
    exit 0
    ;;
  ask)
    jq -n --arg reason "$REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
    ;;
  deny)
    jq -n --arg reason "$REASON" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 2
    ;;
esac
