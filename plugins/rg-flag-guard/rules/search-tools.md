# Code Search: rg and fd, not grep and find

## `rg` for content, `fd` for filenames

Reach for them by default.

**Content search is `rg -n PATTERN PATH`. Recursion is implicit — never pass
`-r`.** Copy that form rather than deriving one from `grep -rn`.

- Content: `rg PATTERN [PATH]`, plus `-n` (line numbers), `-l` (files only),
  `-w` (word), `-F` (literal)
- Filenames: `fd PATTERN`, `fd -e ts`, or `rg --files -g 'GLOB'`

Never translate GNU flags mechanically. `rg` is already recursive, and `-r`
means `--replace` — so `rg -rn PATTERN` silently rewrites the output instead
of recursing with line numbers. It does not error. Same family: `rg -h` is
`--help`, not `--no-filename` (that is `-I`) — a pipeline written with `-h`
silently processes ripgrep's help text instead of your data.

The `rg-flag-guard` plugin's PreToolUse hook backs this up: it denies the trap
shapes (clustered `-r`/`-h`, standalone `-r <plain-word>`) and pastes the
mechanically corrected command into the deny reason — retry with that.
Deliberate `--replace` idioms (`-r '$1'`, `-r ''`, `--replace X`) pass.
Debug a surprising verdict with `scripts/rg-flag-guard.sh --explain 'CMD'`,
or run `/rg-flag-guard:rg-doctor`.

Upstream will not fix this:
[ripgrep#24](https://github.com/BurntSushi/ripgrep/issues/24) was closed
WONTFIX in 2016. Note `-r` only rewrites *output*; it never modifies files.

## `grep` and `find` are not GNU in a Bash tool call

Claude Code ≥2.1.117 embeds `ugrep` and `bfs` in its own binary and injects
shell **functions** named `grep`/`find` into the sourced snapshot. Functions
beat aliases and PATH. Consequences:

- The corpus is neither GNU's nor `rg`'s: the shim adds `--ignore-files`
  (gitignore-aware, sees *fewer* files than GNU) **and** `--hidden` (sees
  *more* than `rg`). Counts from the three will disagree.
- It falls back to real GNU grep whenever any argument matches its escape
  list (`-z`, `-Z`, `--null`, …), passing `"$@"` through unmodified — an
  unrelated flag can switch corpora mid-task.
- The shadows don't survive a non-sourcing shell — `sh -c 'grep …'` gets GNU.

When stock GNU semantics are required, write `/usr/bin/grep` explicitly.
