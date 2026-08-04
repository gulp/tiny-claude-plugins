#!/usr/bin/env bash
#
# install-rules.sh — install the bundled rules/search-tools.md deterministically.
#
# Copies the plugin's bundled search-tools rule into a Claude Code rules
# directory. Never prompts; overwrite of a differing file requires --force,
# so the consent conversation stays in the calling skill.
#
# Exit codes: 0 installed / already identical
#             2 usage error
#             3 (--check only) target absent
#             4 target differs (check reports it; install refuses without --force)
#             5 internal failure (bundled rule missing, copy or verify failed)
set -u -o pipefail

usage() {
  cat <<'EOF'
Usage: install-rules.sh (--user | --project [DIR]) [--check] [--force]

Install the plugin's bundled rules/search-tools.md.

Targets:
  --user           ~/.claude/rules/search-tools.md   (all projects)
  --project [DIR]  DIR/.claude/rules/search-tools.md (default DIR: cwd)

Modes:
  --check          Report only, never write. Prints one status line
                   "STATUS  <absent|identical|differs>  <target>" to stdout;
                   on "differs" a unified diff (target vs bundled) follows.
  --force          Allow install to overwrite a target that differs.

Without --check: absent target is created (mkdir -p), identical target is a
no-op, differing target is refused with exit 4 and a diff on stderr unless
--force. Result line: "RESULT  <installed|identical|overwritten>  <target>".

Exit: 0 installed/identical · 2 usage · 3 check:absent · 4 differs ·
5 internal failure
EOF
}

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 5
SOURCE="$SCRIPT_DIR/../rules/search-tools.md"

scope="" project_dir="" check=0 force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) scope=user ;;
    --project)
      scope=project
      if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then
        project_dir=$2
        shift
      fi
      ;;
    --check) check=1 ;;
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'install-rules.sh: unknown argument %s (see --help)\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$scope" ]; then
  printf 'install-rules.sh: pick a target: --user or --project [DIR] (see --help)\n' >&2
  exit 2
fi

if [ ! -f "$SOURCE" ]; then
  printf 'install-rules.sh: bundled rule missing at %s — broken plugin checkout\n' "$SOURCE" >&2
  exit 5
fi

if [ "$scope" = user ]; then
  target="$HOME/.claude/rules/search-tools.md"
else
  target="${project_dir:-$PWD}/.claude/rules/search-tools.md"
fi

status=absent
if [ -f "$target" ]; then
  if cmp -s "$SOURCE" "$target"; then status=identical; else status=differs; fi
fi

if [ "$check" -eq 1 ]; then
  printf 'STATUS  %s  %s\n' "$status" "$target"
  case "$status" in
    absent) exit 3 ;;
    identical) exit 0 ;;
    differs)
      diff -u "$target" "$SOURCE" || true
      exit 4
      ;;
  esac
fi

case "$status" in
  identical)
    printf 'RESULT  identical  %s\n' "$target"
    exit 0
    ;;
  differs)
    if [ "$force" -ne 1 ]; then
      printf 'install-rules.sh: %s differs from the bundled rule; re-run with --force to overwrite\n' "$target" >&2
      diff -u "$target" "$SOURCE" >&2 || true
      exit 4
    fi
    ;;
esac

mkdir -p -- "$(dirname -- "$target")" && cp -- "$SOURCE" "$target" || {
  printf 'install-rules.sh: copy to %s failed\n' "$target" >&2
  exit 5
}

# Verify the file landed with the expected first heading.
first=$(head -n 1 -- "$target")
case "$first" in
  '# '*) : ;;
  *)
    printf 'install-rules.sh: %s landed without a leading heading (%s)\n' "$target" "$first" >&2
    exit 5
    ;;
esac

if [ "$status" = differs ]; then
  printf 'RESULT  overwritten  %s\n' "$target"
else
  printf 'RESULT  installed  %s\n' "$target"
fi
