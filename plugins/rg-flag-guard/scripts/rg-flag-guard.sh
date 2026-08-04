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
#   pattern but NO path, stdin not piped/     -> DENY  (pathless trap: rg
#     redirected in                              reads stdin, the Bash tool
#     never delivers stdin, command hangs to timeout. grep -rn defaults to
#     cwd; rg does not. Suggestion appends `.`. Exempt: mid-pipeline rg,
#     `<` redirection, explicit `-` operand, xargs-fed, --files and other
#     non-search modes. NEVER "fix" with </dev/null — that converts the
#     hang into a silent empty result.)
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
EXAMPLES="Examples: rg -n 'todo' src/ ; rg '^v(.*)' -r '\$1' Cargo.toml"

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

# segment_classify <segment> <stdin_fed> — sets DECISION/REASON/SUGGESTION
# globals. stdin_fed=1 means the segment's stdin is real (piped in or `<`
# redirected), so a pathless rg is legitimate there.
# Looks at the segment's *command-position* token only. Not a real shell
# parser: word-splitting ignores quoting (deliberately — quote characters
# survive splitting, so '$1' still contains $ and '' stays a literal token).
# Fail-open over false-block, matching bv-timeout-guard.sh precedent.
segment_classify() {
  local seg="$1"
  local stdin_fed="${2:-0}"
  set -f
  # shellcheck disable=SC2206
  TOKENS=($seg)
  set +f

  local i=0
  local n=${#TOKENS[@]}
  local t
  # Pathless-trap bookkeeping (see decision table). via_xargs: xargs supplies
  # the paths as arguments, so pathless rg under it is the normal shape.
  local via_xargs=0 positionals=0 pattern_from_flag=0 listing_mode=0 dash_operand=0

  # Wrapper prologue grammar: consume assignments and known wrappers with
  # their own arguments until the effective command word is reached.
  while [ "$i" -lt "$n" ]; do
    t="${TOKENS[$i]}"
    case "$t" in
      [A-Za-z_]*=*) i=$((i + 1)) ;;
      sudo | env | nice | ionice | nohup) i=$((i + 1)) ;;
      xargs)
        via_xargs=1
        i=$((i + 1))
        ;;
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

    # A bare `--` AFTER rg ends option parsing; the rest are operands. Count
    # them for the pathless check, but run no further flag inspection.
    if [ "$t" = "--" ]; then
      while [ "$i" -lt "$n" ]; do
        positionals=$((positionals + 1))
        [ "${TOKENS[$i]}" = "-" ] && dash_operand=1
        i=$((i + 1))
      done
      break
    fi

    # Long flags say what they mean (--replace, --help): never obstructed.
    # For the pathless check they still need bookkeeping: non-search modes,
    # pattern-supplying flags, and value-taking flags whose separate value
    # token must not be miscounted as a path. An unknown value-taking long
    # flag merely overcounts positionals — which fails open. Listed from
    # `rg --help`, ripgrep 15.1.0.
    case "$t" in
      --files | --type-list | --help | --version | --pcre2-version | --generate=* | --generate)
        listing_mode=1
        [ "$t" = "--generate" ] && i=$((i + 1))
        continue
        ;;
      --regexp=* | --file=*)
        pattern_from_flag=1
        continue
        ;;
      --regexp | --file)
        pattern_from_flag=1
        i=$((i + 1))
        continue
        ;;
      --glob | --iglob | --type | --type-not | --type-add | --type-clear | \
        --max-count | --max-depth | --max-filesize | --max-columns | --threads | \
        --replace | --color | --colors | --sort | --sortr | \
        --context | --after-context | --before-context | --context-separator | \
        --field-context-separator | --field-match-separator | --path-separator | \
        --pre | --pre-glob | --ignore-file | --engine | --encoding | \
        --dfa-size-limit | --regex-size-limit | --hostname-bin | --hyperlink-format)
        i=$((i + 1))
        continue
        ;;
      --*) continue ;;
      -?*) ;;
      *)
        # Operand: pattern or path.
        positionals=$((positionals + 1))
        [ "$t" = "-" ] && dash_operand=1
        continue
        ;;
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
      # Bare -h is a real help request: a non-search mode.
      if [ "$c" = "h" ] && [ "$len" -eq 1 ]; then
        listing_mode=1
      fi
      # -V is --version.
      if [ "$c" = "V" ] && [ "$len" -eq 1 ]; then
        listing_mode=1
      fi

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
          # Other value-taking flag: remainder of the token is its value; if
          # the token ends here, the NEXT token is — consume it so it is not
          # miscounted as a path operand. -e/-f supply the pattern.
          case "$c" in
            e | f) pattern_from_flag=1 ;;
          esac
          if [ -z "$rest" ] && [ "$i" -lt "$n" ]; then
            i=$((i + 1))
          fi
          break
          ;;
      esac

      k=$((k + 1))
    done
  done

  # Pathless trap: a search invocation with a pattern but no path reads
  # stdin; the Bash tool never delivers stdin, so at pipeline head the
  # command hangs to timeout (grep -rn habit — grep defaults to cwd, rg
  # does not). Only fires when nothing legitimately feeds stdin.
  if [ "$DECISION" = "allow" ] && [ "$stdin_fed" -eq 0 ] && [ "$via_xargs" -eq 0 ] \
    && [ "$listing_mode" -eq 0 ] && [ "$dash_operand" -eq 0 ]; then
    local paths
    if [ "$pattern_from_flag" -eq 1 ]; then
      paths=$positionals
    else
      paths=$((positionals - 1))
    fi
    if [ "$paths" -le 0 ] && { [ "$positionals" -gt 0 ] || [ "$pattern_from_flag" -eq 1 ]; }; then
      DECISION="deny"
      SUGGESTION="$(join_tokens_replacing -1 "") ."
      REASON="rg with a pattern but no path reads stdin (rg does not default to the current directory like grep -r), and this harness never delivers stdin — the command hangs until timeout. Expected: rg -n PATTERN PATH. Most likely intended: $SUGGESTION. Retry with that. Do NOT add </dev/null — that turns the hang into a silent empty result."
      return 0
    fi
  fi

  return 0
}

# mask_quoted <cmd> — replace quoted spans that contain whitespace OR a
# shell separator character (| ; &) with __QSTRn__ placeholders (originals
# kept in MASKS). Word-splitting only mis-tokenizes quoted strings with
# internal whitespace — a pattern like 'rg -r is --replace' would otherwise
# be read as flags (__playground-6wd false positive, where the deny
# suggestion silently CORRUPTED the pattern) — and the pipeline split in
# classify() mis-segments quoted strings with internal | ; & — a pattern
# like 'FOO|BAR' /path was split at the | into a fake pathless segment,
# denied as the stdin trap, and the suggestion truncated the pattern
# (2026-08-05 live false positive). Spans without any of those characters
# ('$1', '', "*.rs") are left alone so the deliberate-replace value
# inspection keeps working. Unbalanced quotes simply stop matching: fail
# open.
MASKS=()
MASKED_CMD=""
mask_quoted() {
  local cmd="$1"
  MASKS=()
  # Anchored to token boundaries so the space BETWEEN two adjacent quoted
  # tokens ('$1' 'v(.*)') is never itself taken as a quoted span.
  local re="(^|[[:space:];&|=])('[^']*[[:space:];&|][^']*'|\"[^\"]*[[:space:];&|][^\"]*\")([[:space:];&|]|$)"
  while [[ "$cmd" =~ $re ]]; do
    MASKS+=("${BASH_REMATCH[2]}")
    cmd="${cmd/"${BASH_REMATCH[0]}"/${BASH_REMATCH[1]}__QSTR$((${#MASKS[@]} - 1))__${BASH_REMATCH[3]}}"
  done
  MASKED_CMD="$cmd"
}

# unmask <text> — restore __QSTRn__ placeholders (for user-facing output).
unmask() {
  local text="$1" j
  for ((j = 0; j < ${#MASKS[@]}; j++)); do
    text="${text//__QSTR${j}__/${MASKS[$j]}}"
  done
  printf '%s' "$text"
}

# classify <command-string> — sets DECISION/REASON/SUGGESTION for the first
# non-allow segment. Best-effort split on ; & | && || (not a real parser; the
# common case — a single rg call — is exact).
classify() {
  DECISION="allow"
  REASON=""
  SUGGESTION=""
  local cmd
  mask_quoted "$1"
  cmd="$MASKED_CMD"
  # Fast path: bail before parsing when the text cannot contain an rg call.
  case "$cmd" in
    *rg*) ;;
    *) return 0 ;;
  esac
  # Two-stage split so pipe position survives: first on the separators that
  # do NOT feed stdin (&& || ; &), then each chunk on single | — segments
  # after a | have their stdin genuinely fed, which the pathless check must
  # know. A `<` redirection inside a segment also counts as fed.
  local chunk trimmed fed pi seg
  local PSEGS
  while IFS= read -r chunk; do
    [ -z "${chunk//[[:space:]]/}" ] && continue
    IFS='|' read -ra PSEGS <<< "$chunk"
    for pi in "${!PSEGS[@]}"; do
      seg="${PSEGS[$pi]}"
      trimmed="${seg#"${seg%%[![:space:]]*}"}"
      [ -z "$trimmed" ] && continue
      fed=0
      [ "$pi" -gt 0 ] && fed=1
      case "$trimmed" in *"<"*) fed=1 ;; esac
      segment_classify "$trimmed" "$fed"
      if [ "$DECISION" != "allow" ]; then
        REASON=$(unmask "$REASON")
        SUGGESTION=$(unmask "$SUGGESTION")
        return 0
      fi
    done
  done <<< "$(printf '%s' "$cmd" | sed -E 's/(&&|\|\||[;&])/\n/g')"
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
  rg-flag-guard.sh --explain 'rg pat -r "$1" -o f'  # allow (deliberate replace)
  rg-flag-guard.sh --explain 'rg -n pat'            # deny (pathless: hangs on stdin)

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
