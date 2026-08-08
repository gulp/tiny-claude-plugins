---
name: obsidian-cli
description: >-
  Drive the Obsidian CLI (Obsidian ≥1.12) from an agent: search, read/write
  notes, extract frontmatter as JSON, and diagnose the traps that make the CLI
  look broken. Use when the user asks to query or automate their Obsidian vault
  from the terminal — "search my vault", "append to that note", "get the
  frontmatter", "obsidian command not found error", or any obsidian CLI failure.
allowed-tools: Bash(obsidian:*) Bash(jq:*) Bash(rg:*) Bash(fd:*) Read
---

# obsidian-cli

The Obsidian CLI talks to the **running app** — it is not standalone. Every
command is `obsidian <command> key=value…`, optionally `vault=<name>` to
target a specific vault. `obsidian help` lists everything; `obsidian help
<command>` details one.

## Command map (the useful subset)

```bash
obsidian version                                    # app + installer version
obsidian search query="term" format=json            # file list, JSON array
obsidian search:context query="term" format=json    # with matching lines
obsidian properties path="note.md" format=json      # full frontmatter → jq
obsidian property:read name=source path="note.md"   # one value, no jq
obsidian property:set name=status value=done path="note.md"
obsidian read path="note.md"
obsidian append path="note.md" content="line\nline2"   # \n and \t expand
obsidian create name="note" content="..." template="..."
obsidian files folder=sub ext=md                    # vault file listing
obsidian backlinks file="note" format=json
```

## Goal
Answer vault queries and perform note edits with the CLI when the app runs,
falling back to filesystem tools when it does not — without misreading the
CLI's silent failure modes.

## Steps

### 1. Confirm the CLI responds
```bash
obsidian version
```
Errors or hangs → app not running, or flag trap (step 3). Fall back to
`rg`/`fd` on the vault directory for reads; never retry the CLI blindly.

**Success criteria**: version string printed, or explicit fallback chosen.

### 2. Query / edit
Use the command map. Rules learned the hard way:

- **`format=json` everywhere you parse.** Default output is human text.
- **Pin the vault when more than one is open**: `obsidian vault=<name> <command>`.
  Without it the CLI acts on the *active* vault — a search that silently ran
  against the wrong vault looks identical to "no matches here".
- **Multi-word `search:context` can return empty with exit 0.** Never treat an
  empty multi-word result as "no matches" — retry with a single token, or
  cross-check with `rg -l -i` on the vault dir.
- **Quote values with spaces**: `name="My Note"`.
- **File resolution**: `file=` resolves like a wikilink (name only), `path=`
  is exact vault-relative path. Prefer `path=` in scripts.
- Bulk frontmatter = per-file loop (no batch command):
  ```bash
  obsidian search query="term" format=json | jq -r '.[]' |
    while read -r f; do obsidian property:read name=source path="$f"; done
  ```

**Success criteria**: parsed JSON, or values printed verbatim; empty results
cross-checked before reporting "none".

### 3. Diagnose "Command not found" and flag traps
Error `Command "-something" not found. It may require a plugin to be enabled.`
means a **single-dash Electron flag** fell through Chromium into the CLI's
command parser. Chromium only consumes `--double-dash` switches; anything else
in argv is parsed as a CLI command.

Check launcher-injected flags (Arch: `~/.config/obsidian/user-flags.conf`,
injected by `/usr/bin/obsidian` before your args — poisons *every* CLI call):
```bash
grep -v '^#' ~/.config/obsidian/user-flags.conf 2>/dev/null
pgrep -af 'electron.*obsidian|obsidian.*app.asar'   # what the live app actually got
```
Fix the conf (`-flag` → `--flag`). Then note the **restart trap**:
`obsidian restart` relaunches with the **original argv** — the stale flag and
any old `obsidian://` URI survive. A real fix needs kill + fresh launch
through the wrapper.

**Success criteria**: CLI answers `obsidian version`; live process argv shows
only double-dash flags.
