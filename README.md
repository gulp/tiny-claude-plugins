# tiny-claude-plugins

A small, curated [Claude Code](https://code.claude.com) plugin marketplace.
Each plugin does one thing well; nothing here is a framework.

## Install the marketplace

Everything installs straight from the public GitHub remote — no clone, no local
path. Two equivalent surfaces: the in-session `/plugin` slash commands, or the
`claude plugin` CLI (which also works from a terminal or a setup script).

```bash
# CLI — works headless, from a terminal or CI
claude plugin marketplace add gulp/tiny-claude-plugins --scope project
claude plugin install agent-mail-monitor@tiny-claude-plugins --scope project
```

```
# or in-session, interactively
/plugin marketplace add gulp/tiny-claude-plugins
/plugin install agent-mail-monitor@tiny-claude-plugins
```

Pick the **scope** that matches how widely you want it (`--scope` on the CLI; the
slash command prompts):

| Scope | Lands in | Active for | Use when |
|---|---|---|---|
| **project** | the repo's `.claude/settings.json` (committed) | everyone who trusts this repo | a repo whose work is swarm/coordinator-y — opt the whole project in |
| **user** | `~/.claude/settings.json` | every session, everywhere | you always want it (a dedicated coordinator machine) |
| **local** | `.claude/settings.local.json` (uncommitted) | just you, this repo | trying it out without committing anything |

Confirm what landed and at which scope with `claude plugin list` (it prints the
resolved version + scope per plugin).

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

- **Read-only by design.** It reads delivered message files from the canonical
  git-mailbox, so watching never consumes mail out from under a later
  `fetch_inbox`/`acknowledge_message`.
- **Zero model action to arm.** The monitor is declared `when: "always"`, so the
  host arms it at session start with no tool call — the same trust tier as a hook
  (unsandboxed).
- **Identity-scoped.** It watches `$AGENT_NAME`; set that at launch. Without an
  identity the monitor does **not** fail silently — it emits one loud notice and
  exits (code 3) rather than watching a nameless inbox. A fresh identity with no
  mailbox directory stays live and says exactly what is missing; malformed
  mailbox entries and transient scan failures are surfaced rather than dropped.
- **Canonical filesystem backend.** Project and all-project watches tail the
  append-only git mailbox with plain OS reads. They do not call the consuming
  `am check-inbox` path, do not mutate `read_ts`, and continue to see mail when
  SQLite is delayed. Notifications include the source project slug.
- **Configurable wake policy.** `MAIL_WATCH_SCOPE=project|all` selects one
  project or every project containing the identity. `MAIL_WATCH_MODE=actionable`
  adds `[ack]`/`[urgent]` markers. `MAIL_WATCH_FILTER=ack|urgent` limits wakeups
  to matching messages and works independently of the display mode.
- **Product mode (cross-project bus).** Set `$AGENT_MAIL_PRODUCT` (or run the
  `agent-mail product` command) and the watch aggregates one identity's mail
  across *every* project linked into that product, labelling each line with its
  origin project and advancing a `created_ts` frontier. `doctor` gains a
  registration-gap check in this mode — it fails loud if your identity is missing
  from any linked project (where its mail would silently never arrive).

Under the monitor sits a small read-only `agent-mail` CLI (Deno, ships as source).
Run it from `plugins/agent-mail-monitor` with
`deno run --allow-run=am --allow-env --allow-read src/cli.ts <command>`:

| Command | Purpose |
|---|---|
| `watch` | Tail one canonical project inbox; supports `--agent`, `--project`, `--root`, `--since`, and `--interval` |
| `product` | Tail a named product bus; supports `--agent`, `--product`, `--limit`, and `--interval` |
| `monitor` | Host entrypoint driven by `AGENT_NAME`, `CLAUDE_PROJECT_DIR`, `MAIL_POLL_INTERVAL`, `MAIL_WATCH_SCOPE`, `MAIL_WATCH_MODE`, and `MAIL_WATCH_FILTER` |
| `doctor` | Run the read-only environment, identity, mailbox-layout, MCP, and product-registration preflight |
| `message <id>` | Resolve a globally unique message ID, optionally within `--product` |
| `shadow` | Compare the canonical mailbox with read-only SQLite visibility and report sustained divergence |
| `capabilities` | Emit the versioned command and exit-code contract |
| `schema <command>` | Emit JSON Schema for a query command's JSON envelope |

Global query options are `--json`, `--output json|human`, and `--cwd <path>`.
Use `<command> --help`, `capabilities`, and `schema` as the authoritative
machine-readable surfaces. Runtime requirements are `deno` and the `am`
([Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)) CLI;
the doctor additionally uses `curl`, and its shell helper uses `jq`.

Bundled skills (model-invoked, on demand — Claude shows them namespaced, e.g.
`agent-mail-monitor:toggle`):

- **`onboarding-to-agent-mail`** — zero-to-productive first run: declare the MCP
  connection via `am setup`, verify with the `am agent` cockpit, register a
  durable identity, then arm the watch. Idempotent and safe to re-run.
- **`wiring-a-product-bus`** — wire N repos into one product bus: `am products
  ensure` + `link` per repo, then register your identity in each (closing the
  silent registration gap by construction). Explains `created_ts` aggregation.
- **`toggle`** — turn the watch OFF (silence this session) or back ON without
  uninstalling. This is the per-session opt-out/opt-in control.
- **`doctor`** — diagnose why the monitor is silent: checks `am`, `jq`, server
  health (`curl` + `am health`), the MCP declaration, `AGENT_NAME`, and (in
  product mode) registration in every linked project.
- **`diagnose-agent-mail-service`** — distinguish daemon health, the raw MCP
  handshake, CLI health, and local SQLite readability with bounded probes and
  explicit recovery guidance.
- **`driving-swarms-with-mail`** — the Agent Mail reservation-and-thread seam for
  a shared checkout: reserve your edit surface, announce in a per-task thread,
  release when your commit lands. Explicit-invocation only.

Bundled agent:

- **`mail-triage`** — a read-only advisor that reads an identity's inbox (single
  project or product bus) and returns a ranked triage digest with routing and
  priority recommendations. It *recommends*, it never acts: its tool allowlist
  grants only read surfaces and excludes every send/reply/ack/mark-read mutator.

## Codex ingress

Codex does not expose Claude's background Monitor surface. The Codex design uses
the same canonical mailbox source behind a durable ingress kernel and an
explicit Codex App Server thread adapter. The binding between Agent Mail
identity, project scope, and Codex thread is immutable; routine mail queues while
a turn is active, urgent or acknowledgement-required mail may steer the expected
active turn, and every adapter or binding failure is loud. There is no automatic
fallback to `codex exec resume`, a different thread, or a new identity.

The repository also ships an operational Codex tracer in the same plugin:
`scripts/codex-monitor.ts` owns one App Server process and one durable thread,
baselines the canonical inbox, starts a serialized wake turn for new mail, and
never consumes inbox state. Its headless request policy cancels MCP elicitation,
declines approvals, rejects unsupported interactive requests, and fails the
binding on unknown protocol methods.

```bash
cd plugins/agent-mail-monitor
deno task codex:doctor --agent CobaltJaguar --project /absolute/project
deno task codex:monitor --agent CobaltJaguar --project /absolute/project
```

Pass `--thread <id>` to resume exactly one durable thread, `--since <id>` for
explicit replay, and `--once` for a one-batch acceptance run. App Server exit or
turn timeout is fatal; the tracer never creates a replacement thread silently.

The tracer proves the human-facing ingress path. The production kernel remains
responsible for durable cursors/outbox state, reconnect, batching, active-turn
queue/steer policy, leases, retries, and metrics.
The operational architecture, schemas, performance targets, rollout gates, and
dependency-ready task graph live in
[the Codex ingress plan](docs/plans/codex-agent-mail-ingress.md); the source
research and contender comparison live in
[the Codex monitor research](docs/research/gpt-codex-monitor-shape.md).

## Repository layout

```
.claude-plugin/marketplace.json      # marketplace manifest (what /plugin marketplace add reads)
plugins/<name>/
  .claude-plugin/plugin.json          # plugin manifest
  monitors/monitors.json              # experimental: background monitors (when: always → auto-arm)
  scripts/                            # the watch/entry scripts a monitor runs
  src/                                # optional: a Deno CLI shipped as source (agent-mail's `agent-mail`)
  skills/<skill>/SKILL.md             # model-invoked skills (+ scripts/, resources/, assets/)
  agents/<agent>.md                   # subagents (frontmatter tool-allowlist + system prompt)
.agents/skills/<skill>/               # project-scoped Codex skills
.agents/plugins/marketplace.json      # project-local Codex marketplace
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
