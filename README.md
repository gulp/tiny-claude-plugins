# tiny-claude-plugins

A small, curated [Claude Code](https://code.claude.com) plugin marketplace.
Each plugin does one thing well; nothing here is a framework.

## Install the marketplace

```
/plugin marketplace add gulp/tiny-claude-plugins
```

Then install any plugin (persistent — every session):

```
/plugin install agent-mail-monitor@tiny-claude-plugins
```

## Plugins

### `agent-mail-monitor`

Auto-arms a **read-only** background Monitor that fires one notification per new
[Agent Mail](https://github.com/) message addressed to `$AGENT_NAME` in the
current project — so a swarm agent reacts to inbound mail the moment it lands
instead of discovering it on the next manual `fetch_inbox`.

- **Read-only by design.** It polls `am check-inbox` (which, unlike the MCP
  `fetch_inbox` tool, does *not* mark messages read), so watching never consumes
  mail out from under a later `fetch_inbox`/`acknowledge_message`.
- **Zero model action to arm.** The monitor is declared with `when: "always"`,
  so the host arms it at session start with no tool call — the same trust tier as
  a hook (unsandboxed).
- **Identity-scoped.** It watches `$AGENT_NAME`; set that at launch. Without an
  identity the monitor stays idle (it exits cleanly, not as a crash).

Requirements on `PATH`: the `am` (Agent Mail) CLI and `jq`.

## Two ways to run a monitor

| | Persistent (marketplace install) | Sometimes (per-launch) |
|---|---|---|
| How | `/plugin install agent-mail-monitor@tiny-claude-plugins` | `cldy-mon` (see `bin/`) |
| Scope | every session, until you uninstall | the one session you launch |
| Good for | a dedicated coordinator terminal | occasional swarm work |

### `cldy-mon` — the opt-in launcher

`bin/cldy-mon` is a thin shim that execs `claude --plugin-dir <this-plugin>`, so
the mail Monitor arms for **just that session** and disappears when it ends — no
global install to remember to disable. This is the "I want monitor mode
*sometimes*" path.

```bash
# from a clone of this repo:
AGENT_NAME=PlumHare ./bin/cldy-mon              # arm mail-monitor for this session
AGENT_NAME=PlumHare ./bin/cldy-mon --model opus # extra flags pass straight through

# put it on PATH once:
ln -s "$PWD/bin/cldy-mon" ~/.local/bin/cldy-mon
```

The monitor watches `$AGENT_NAME`; launch without it and the shim prints how to
set one (the monitor then stays idle rather than watching a nameless inbox).

## Repository layout

```
.claude-plugin/marketplace.json     # marketplace manifest (what /plugin marketplace add reads)
plugins/<name>/
  .claude-plugin/plugin.json         # plugin manifest
  monitors/monitors.json             # experimental: background monitors (when: always → auto-arm)
  scripts/                           # the actual watch/entry scripts
bin/cldy-mon                         # per-launch opt-in launcher shim
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

`agent-mail-monitor` is the first plugin. The marketplace is built to grow —
each addition is a self-contained `plugins/<name>/` dir plus one entry in
`marketplace.json`. Candidate next plugins:

- **swarm-status** — package `watch-swarm.sh` (bead-close + tagged-commit tail)
  as a companion monitor to mail.
- Further small, single-purpose monitors and commands as they prove out.

## License

MIT — see [LICENSE](./LICENSE).
