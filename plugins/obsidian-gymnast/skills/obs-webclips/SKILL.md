---
name: obs-webclips
description: >-
  Find and inspect Obsidian Web Clipper notes by domain, date, or content, and
  extract their frontmatter as JSON. Use when the user asks to find web clips —
  "find si.edu clips", "clips from google searches", "what did I clip about X",
  "get the source URL of that clip" — or wants clip frontmatter for jq
  processing.
allowed-tools: Bash(fd:*) Bash(rg:*) Bash(obsidian:*) Bash(jq:*) Read
argument-hint: "<query>"
arguments: "query"
---

# obs-webclips

Find clips in the web-clips folder (default `~/Vaults/obsidian-web-clips/`;
honor a different location if the user names one). Filenames follow
`YYYY-MM-DD_domain_first-4-title-words.md`: `_` separates the three fields, `-`
lives inside them, `www.` is stripped, subdomains kept (`en.wikipedia.org`),
dots survive only in the domain field — so a domain is uniquely anchorable as
`_<domain>_`.

## Inputs
- `$query`: single token — a domain (`si.edu`), a word, or a date prefix
  (`2026-08`). Multi-word content queries must be quoted by the user.

**Guard**: if no query was provided (the placeholder above is empty), STOP and
ask for one. An empty query is not "search everything" — `query=""` and
`rg ""` both match every file and masquerade as results.

## Goal
Return matching clip paths (and, when asked, frontmatter values) using the
cheapest tool that answers: filename first, live-app search second, rg fallback.

## Steps

### 1. Pick the lane
- Query contains a dot / looks like a domain → filename fast path (step 2)
- Date prefix `YYYY[-MM[-DD]]` → filename fast path, `^` anchored
- Anything else (topic, phrase, URL fragment) → content search (step 3)

**Success criteria**: one lane chosen; no shotgunning all three at once.

### 2. Filename fast path (offline, always works)
```bash
fd -L '_si\.edu_' ~/Vaults/obsidian-web-clips   # domain (escape dots)
fd -L '^2026-08' ~/Vaults/obsidian-web-clips    # date prefix
```

**Rules**:
- `-L` mandatory: vault dirs are often symlinked and fd silently skips them
  without it — empty output masquerades as "no clips".
- Old clips may predate the naming scheme; on zero hits fall through to step 3
  instead of reporting none.

**Success criteria**: hits reported as full paths, or explicit fall-through.

### 3. Content search
Preferred (searches body + frontmatter, JSON out) — needs Obsidian running:
```bash
obsidian search query="$query" format=json
```
With more than one vault open, pin it: `obsidian vault=<clips-vault> search …`
— otherwise the CLI searches the active vault, which may be the wrong one.
Fallback when app closed, or query needs multi-word:
```bash
rg -liF "$query" ~/Vaults/obsidian-web-clips   # -F: literal, so si.edu ≠ siXedu
```
Drop `-F` only when the user explicitly wants regex.

**Rules**:
- `obsidian search:context` with multi-word phrases returns empty with exit 0 —
  never trust an empty multi-word result; retry single-token or use rg.
- CLI error means app not running — state that, switch to rg, don't retry.

**Success criteria**: matches listed; empty result cross-checked with the other
tool before reporting "none".

### 4. Frontmatter extraction (when values asked for)
```bash
obsidian properties path="<file>" format=json | jq .source   # full frontmatter
obsidian property:read name=source path="<file>"             # single value, no jq
```
Bulk (per-file loop; fine for <20 files):
```bash
obsidian search query="$query" format=json | jq -r '.[]' |
  while read -r f; do obsidian property:read name=source path="$f"; done
```
Offline fallback: Read the file, parse YAML between the first two `---` lines.

**Success criteria**: requested values printed; source URLs verbatim.
