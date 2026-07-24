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
Deno CLI (`watch`/`product`/`monitor`/`doctor`/`capabilities`/`schema`), five skills,
and a read-only `mail-triage` subagent. The CLI owns its own exit-code contract —
read it from the source of truth rather than freezing it here: `deno task -q doctor`
paths, or `… capabilities` / `… schema <command>` for the machine-readable envelope.

## Conventions

- **Names are kebab-case.** Plugin `name` in `plugin.json` must match its
  `marketplace.json` entry. Don't use a reserved Anthropic marketplace name.
- **Never set `version` in both** `plugin.json` and the marketplace entry —
  `plugin.json` wins and can mask a bump made only in the marketplace entry.
- **Bump `version` on every release** you want users to receive. Claude Code
  treats an unchanged `version` as "already up to date" and won't pull new
  commits. Omit `version` entirely and the git SHA is used instead (always fresh,
  but no human-readable release line).
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
```

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
