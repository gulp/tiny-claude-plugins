# tiny-claude-plugins

A small, curated [Claude Code](https://code.claude.com) plugin marketplace.
Each plugin does one thing well; nothing here is a framework.

## Install the marketplace

```
/plugin marketplace add gulp/tiny-claude-plugins
```

Then install a plugin. Pick the **scope** that matches how widely you want it:

```
/plugin install agent-mail-monitor@tiny-claude-plugins
```

| Scope | Lands in | Active for | Use when |
|---|---|---|---|
| **project** | the repo's `.claude/settings.json` (committed) | everyone who trusts this repo | a repo whose work is swarm/coordinator-y — opt the whole project in |
| **user** | `~/.claude/settings.json` | every session, everywhere | you always want it (a dedicated coordinator machine) |
| **local** | `.claude/settings.local.json` (uncommitted) | just you, this repo | trying it out without committing anything |

Pass the scope explicitly on install (`/plugin install <name>@tiny-claude-plugins`
prompts, or use the `claude plugin install --scope <project|user|local>` CLI).

**Just testing, no install?** Point Claude at the plugin dir for a single
session — nothing persists:

```bash
AGENT_NAME=You claude --plugin-dir plugins/agent-mail-monitor
```

## Plugins

### `agent-mail-monitor`

Auto-arms a **read-only** background Monitor that fires one notification per new
[Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) message
addressed to `$AGENT_NAME` in the current project — so a swarm agent reacts to
inbound mail the moment it lands instead of discovering it on the next manual
`fetch_inbox`.

- **Read-only by design.** It polls `am check-inbox` (which, unlike the MCP
  `fetch_inbox` tool, does *not* mark messages read), so watching never consumes
  mail out from under a later `fetch_inbox`/`acknowledge_message`.
- **Zero model action to arm.** The monitor is declared `when: "always"`, so the
  host arms it at session start with no tool call — the same trust tier as a hook
  (unsandboxed).
- **Identity-scoped.** It watches `$AGENT_NAME`; set that at launch. Without an
  identity the monitor does **not** fail silently — it emits one loud notice and
  exits (code 3) rather than watching a nameless inbox. A failed *first* poll
  (server down / wrong identity / auth) likewise reports the cause and exits
  (code 4) instead of masquerading as a healthy-but-quiet watch.

Requirements on `PATH`: the `am`
([Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)) CLI and
`jq`.

Bundled skills (model-invoked, on demand — Claude shows them namespaced, e.g.
`agent-mail-monitor:toggle`):

- **`toggle`** — turn the watch OFF (silence this session) or back ON without
  uninstalling. This is the per-session opt-out/opt-in control.
- **`doctor`** — diagnose why the monitor is silent: checks `am`, `jq`, server
  health (`curl` + `am health`), the MCP declaration, and `AGENT_NAME`, and points
  at a fix guide for each failure.

## Repository layout

```
.claude-plugin/marketplace.json      # marketplace manifest (what /plugin marketplace add reads)
plugins/<name>/
  .claude-plugin/plugin.json          # plugin manifest
  monitors/monitors.json              # experimental: background monitors (when: always → auto-arm)
  scripts/                            # the watch/entry scripts a monitor runs
  skills/<skill>/SKILL.md             # model-invoked skills (+ scripts/, resources/, assets/)
```

## Publishing / release discipline

- Bump `version` in each plugin's `.claude-plugin/plugin.json` on every release.
  Claude Code treats an unchanged `version` as "already up to date" and won't
  pull new commits — so a forgotten bump silently strips updates from users.
- Never set `version` in **both** `plugin.json` and the marketplace entry —
  `plugin.json` wins and can mask a bump made only in `marketplace.json`.
- Renaming or removing a plugin breaks existing installs unless you add a
  top-level `renames` map to `marketplace.json` (`{"old": "new-or-null"}`).
- Validate before every push:

```
claude plugin validate .
```

## Roadmap

`agent-mail-monitor` is the first plugin. The marketplace is built to grow — each
addition is a self-contained `plugins/<name>/` dir plus one entry in
`marketplace.json`. Candidate next plugins:

- **swarm-status** — package `watch-swarm.sh` (bead-close + tagged-commit tail)
  as a companion monitor to mail.
- Further small, single-purpose monitors and commands as they prove out.

## License

MIT — see [LICENSE](./LICENSE).
