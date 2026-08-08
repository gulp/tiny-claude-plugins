# obsidian-gymnast

Skills that let agents drive the [Obsidian CLI](https://obsidian.md/help)
(Obsidian ≥ 1.12) without faceplanting on its silent failure modes.

## Skills

- **obsidian-cli** — the command map (`search`, `properties … format=json`,
  `property:read`, `append`, …) plus the traps: single-dash Electron flags
  falling through to the CLI command parser ("Command \"-disable-gpu\" not
  found"), `obsidian restart` reusing stale argv, multi-word `search:context`
  returning empty with exit 0, and the app-must-be-running constraint with
  `rg`/`fd` fallbacks.
- **obs-webclips** — find Web Clipper notes by domain, date, or content;
  extract clip frontmatter as JSON for `jq`. Built around the
  `YYYY-MM-DD_domain_slug.md` naming scheme (underscores between fields,
  dashes inside them, dots only in the domain).

## Requirements

- Obsidian ≥ 1.12 with the CLI enabled; the app must be running for
  `obsidian` commands (skills fall back to `rg`/`fd` when it isn't)
- `fd`, `rg`, `jq`

## Canonical copy

This plugin is the only copy of these skills — no mirrors, no sync.
