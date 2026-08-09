# tiny-claude-plugins — working notes

A [Claude Code](https://code.claude.com) **plugin marketplace**: a git repo whose
root carries `.claude-plugin/marketplace.json` and whose `plugins/<name>/` dirs
are each a self-contained plugin. Nothing here builds — plugins ship as source.

## Layout

```
.claude-plugin/marketplace.json      # marketplace manifest — what `/plugin marketplace add` reads
plugins/<name>/
  .claude-plugin/plugin.json         # plugin manifest (only `name` is required)
  monitors/monitors.json             # experimental background monitors (when:always → auto-arm)
  scripts/                           # the watch/entry scripts a monitor runs
  src/                               # optional Deno CLI shipped as source (deno task / monitor entrypoint)
  skills/<skill>/SKILL.md            # model-invoked skills (auto-discovered)
  agents/<agent>.md                  # subagents, auto-discovered (frontmatter tools allowlist + prompt)
```

`agent-mail-monitor` has grown past a bare monitor: it ships a read-only `agent-mail`
Deno CLI (`watch`/`product`/`monitor`/`doctor`/`message`/`shadow`/`capabilities`/
`schema`), six skills, and a read-only `mail-triage` subagent. Project and
all-project watches use the canonical git-mailbox; product mode uses the
non-consuming product-bus query. The CLI owns its own exit-code contract —
read it from the source of truth rather than freezing it here: `deno task -q doctor`
paths, or `… capabilities` / `… schema <command>` for the machine-readable envelope.

The same plugin directory is also a Codex plugin: `.codex-plugin/plugin.json`,
`scripts/codex-monitor.ts`, and `skills/agent-mail-monitor/` provide the
App Server tracer and human control surface. `deno task test:codex` exercises
the stdio JSON-RPC boundary, including elicitation cancellation, exact-thread
resume, timeout/process failure, and unknown-request failure.

## Conventions

- **Names are kebab-case.** Plugin `name` in `plugin.json` must match its
  `marketplace.json` entry. Don't use a reserved Anthropic marketplace name.
- **Never set `version` in both** `plugin.json` and the marketplace entry —
  `plugin.json` wins and can mask a bump made only in the marketplace entry.
- **Bump `version` on every release** you want users to receive. Claude Code
  treats an unchanged `version` as "already up to date" and won't pull new
  commits. Not theoretical: `scripts/plugin-version-guard`'s **first live run**
  (2026-08-09) caught a docs-only rg-flag-guard commit that had no bump —
  installs would never have received the file. **Do not omit `version` in this
  repo.** The commit-SHA cache fallback
  only applies when the marketplace entry's `source` is `"./"` (the marketplace
  root *is* the plugin). This marketplace uses the subdir shape
  (`"source": "./plugins/<name>"`); omitting `version` there lands the install
  under a single cache dir named `unknown`, which never invalidates — every
  future commit silently reuses the same stale files. Measured 2026-07-27 across
  28 installed plugins (`~/.claude/plugins/cache/<mkt>/<plugin>/<version-dir>/`):

  | marketplace `source` | `version` in plugin.json | cache dir |
  |---|---|---|
  | `"./"` (root IS the plugin) | absent | 12-hex commit SHA |
  | `"./plugins/<name>"` (subdir) | absent | **`unknown`** (permanent) |
  | either | present | the semver string |

  Evidence: SHA rows include `agent-browser/…/d9387aae58fb` and
  `caveman/…/600e8efcd6ac`; `unknown` rows are the five
  `claude-plugins-official/{frontend-design,playground,plugin-dev,pr-review-toolkit,skill-creator}`
  subdir plugins with no version; semver rows include
  `tiny-claude-plugins/agent-mail-monitor/{0.1.0…0.5.0}`. Dropping `version`
  here would make staleness worse, not better.
- **Monitors are experimental.** `monitors/monitors.json` at the plugin root is
  the convention; `claude plugin validate` warns on bare top-level monitor decls
  and future versions want them under `experimental.*`. They run **unsandboxed**
  at hook trust — keep the scripts read-only and boring.
- **Only host-allowlisted vars are substituted** in monitor `command` strings
  (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, …) — NOT arbitrary env vars.
  Resolve anything else (e.g. `$AGENT_NAME`) inside the script, in a real shell.
- **Scripts** are POSIX-ish bash, `chmod +x`, and fail loud (non-zero exit with a
  one-line reason) rather than silently — a monitor that dies quietly reads as
  "nothing to report." A **Monitor turns only STDOUT into notifications** (stderr
  is swallowed, exit 0 = clean end), so a monitor-facing script must print its
  fatal diagnostics to **stdout** and exit non-zero — a stderr-only + exit-0 path
  is a silent no-op the host cannot see.
- **Distinct exit codes per failure class, documented in `--help`.** So an agent
  invoking a script can branch on the cause without scraping text. Convention in
  this repo: `2` = bad arguments, `3` = missing required identity/env, `4` =
  first/initial poll failed (unreachable / wrong identity / auth), `64` = usage
  error (doctor), `127` = a required dependency is missing. Keep the `--help`
  exit-code list in sync with the code.

## Before every push

```
claude plugin validate .
scripts/plugin-drift tiny-claude-plugins
```

`plugin-drift` compares worktree / `origin/main` / the
`~/.claude/plugins/marketplaces/<mkt>` clone / cache versions and fails loud on
staleness (G2 unpushed, marketplace fetch lag, G1 missing cache dir). SessionStart
runs it automatically via `.claude/settings.json`. Enable the matching pre-push
guards once per clone:

```
git config core.hooksPath .githooks
```

`.githooks/pre-push` runs (1) `plugin-drift --skip-g2` so an in-flight push is
not blocked by the unpushed-commits check it is about to clear, then
(2) `plugin-version-guard`, which refuses any push that touches `plugins/<name>/`
without bumping that plugin's `plugin.json` version (G3). Deliberate escape hatch:
`git push --no-verify`.

Run a plugin's script tests (a plugin may ship a `tests/` dir of self-contained
bash tests — they stub externals like `am` on `PATH` and use real `jq`; they SKIP
rather than fail when a tool such as `timeout`/`jq` is absent):

```
plugins/<name>/tests/test-watch-mail.sh
```

Test a plugin locally without installing it (session-only):

```
AGENT_NAME=You claude --plugin-dir plugins/<name>
```

## Install scopes (for users)

- **project** — repo `.claude/settings.json` (committed; everyone who trusts the
  repo gets it). The opt-in-per-repo path.
- **user** — `~/.claude/settings.json` (every session, everywhere).
- **local** — `.claude/settings.local.json` (uncommitted, just you).
