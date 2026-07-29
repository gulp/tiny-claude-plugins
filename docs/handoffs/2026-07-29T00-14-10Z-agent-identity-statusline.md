---
author: agent
model: composer-2.5
type: handoff
vx_review: unreviewed
created: 2026-07-29
updated: 2026-07-29
sessions:
  - ef9bf36f-bbd6-4868-aff0-1124a3846b1e
repos:
  - /home/gulp/projects/tiny-claude-plugins
continues: docs/handoffs/2026-07-28T23-45-12Z-codex-ingress-release.md
---

# HANDOFF SUMMARY

## 1) Mission State

- Current objective: Ship Codex Agent Mail ingress critical path; keep Cursor CLI coordination identity/statusline working for this repo’s workers.
- Current status: **tcp-efp.5.13 closed** (least-privilege FS + App Server env). Repo-scoped `agent` launcher + statusline identity path landed and committed (`9ef18bf`). Critical path now **5.12 (BeigeHorizon)** → **6.10** → R1. This agent (RusticBirch) idle on beads after 5.13; launcher work done.
- Definition of done (if known): 5.12 daemon hosts live ownership IPC; then 6.10 real Codex one-message smoke; R1 shadow. Separately: workers start via repo `agent` so `AGENT_NAME` reaches Cursor statusline.
- Immediate next best action: After BeigeHorizon closes 5.12, claim/execute **tcp-efp.6.10** (checklist already at `docs/research/codex-v2-production-smoke-gate.md`). Or help with read-only review of 5.12 daemon host — do not steal `production_run.ts` while they hold it.

## 2) Stable Context (carry forward)

- Agent Mail identity this session: **RusticBirch** (id was registered earlier as 1211 on `/home/gulp/projects/tiny-claude-plugins`).
- Beads: `br` (not `bd`). Critical path: `5.12` → `6.10` → `6.4` (R1). **5.13** and **5.14** closed.
- Cursor CLI config live path with `XDG_CONFIG_HOME=/home/gulp/.config`: **`~/.config/cursor/cli-config.json`**, not `~/.cursor/cli-config.json`. Bare `~/.cursor/cli-config.json` can have a working `statusLine` that the running `agent` never reads.
- Custom `statusLine` **replaces** the native footer (`Auto · % · files edited`); seeing the native footer means `statusLine` is null/absent in the **active** config. Forum: Kevin Neilson confirms replacement; active sessions can overwrite `cli-config.json` on exit.
- Statusline command: `~/.cursor/statusline.sh` — model/context/cwd/git + agent (magenta) + short bead id (yellow) via `AGENT_NAME` / panes / `br list --assignee … --status in_progress`.
- Repo launcher (committed `9ef18bf`):
  - `.envrc`: `PATH_add scripts`; default **`AGENT_NAME=TinyCedar`** (manual shells); **no** coordinator vars yet.
  - `scripts/agent` → `resolve_worker_identity` → `exec` `~/.local/bin/agent`.
  - `scripts/lib/worker-identity.sh`: pane cache under `~/.cache/agent-mail-identity/`; `am agents create/register`.
  - `agent --agent-name RusticBirch` (or `=`) for standalone TTY (no mux → no pane cache → otherwise mints new name every launch).
- Claude statusline (reference only): `~/.claude/settings.json` → `bash ~/.claude/statusline-command.sh` wrapping Claudia `~/.cargo/bin/statusline` + agent/bead/rate-limit overlay. Not ported wholesale.
- kb-cli convention mirrored: `/home/gulp/projects/kb-cli/scripts/agent` + `worker-identity.sh` + `.envrc`.
- Stay off BeigeHorizon’s 5.12 files while claimed (`production_run.ts`, live ownership host). OliveCedar owns deep probes area (5.14 done).

## 3) Progress So Far (what happened)

- Attempt: Continue Codex ingress after prior handoff; claim work from AzureFalcon orders.
- Result: Implemented and closed **tcp-efp.5.13** — `service_permissions.ts`, wrapper `permissions --shell` exec, `buildAppServerEnv` in `production_run.ts`, CLI `permissions`, ops-runbook, `tests/o3_service_permissions_test.ts`.
- Evidence: deno tests 7/7 on permissions + production_run wrapper assertions; bead closed with reason noting allowlists.
- Decision: Release `cli.ts` / `production_run.ts` for BeigeHorizon 5.12; stay off ownership command files.

- Attempt: Accidentally claimed **tcp-efp.5.14** (assignee was OliveCedar).
- Result: Reverted assignee/status; apologized via mail; OliveCedar closed 5.14 themselves (deep live probes).
- Decision: Never claim ready beads without checking assignee/reservations.

- Attempt: User asked about Cursor CLI statusline; believed custom script broken in “CLI”.
- Result: Diagnosed wrong config file (`~/.cursor` vs XDG `~/.config/cursor`); merged `statusLine` into XDG config; hot-reload worked without restart.
- Evidence: XDG file had `"statusLine": null` and model Auto; legacy file had the script. Live agents had `XDG_CONFIG_HOME=/home/gulp/.config`.

- Attempt: Port Claude agent+bead into `~/.cursor/statusline.sh`.
- Result: Works when `AGENT_NAME` is in **agent parent** env; one-shot `AGENT_NAME=…` in a tool shell does not relay.

- Attempt: Study kb-cli `scripts/agent`; implement same pattern in tiny-claude-plugins.
- Result: `.envrc`, `scripts/agent`, `worker-identity.sh`, AGENTS.md; `--agent-name`; default TinyCedar; no coordinator. Commit `9ef18bf`. Probe bead `tcp-q0h` created then closed after statusline showed `q0h`.

## 4) Effective Strategies (helpful)

- Strategy: Treat “native footer visible” as proof `statusLine` inactive in the config the process actually loads.
  - Why it worked: Bundle renders `customContent` XOR native rows; XDG path explained the mismatch.
  - Where to reuse: Any Cursor CLI config mystery on Linux with XDG set.

- Strategy: Fix identity at **exec** time (`scripts/agent`), not after the TUI is up.
  - Why it worked: Statusline child inherits parent `process.env` only.
  - Where to reuse: Any harness that spawns statusline/hooks from the long-lived agent process.

- Strategy: `--agent-name` for non-mux TTYs; pane cache when mux exists.
  - Why it worked: Same as kb-cli; standalone had no cache_file without pane key.
  - Where to reuse: Workers outside tmux/wezterm.

- Strategy: Focused commits for launcher work; leave huge WIP tree unstaged.
  - Why it worked: Meaningful history without mixing ingress WIP.
  - Where to reuse: Parallel swarm checkouts with dirty trees.

## 5) Pitfalls and Anti-Patterns (harmful)

- Pitfall: Editing/assuming `~/.cursor/cli-config.json` while `XDG_CONFIG_HOME` points elsewhere.
  - Why it failed: Agent never read that file; statusLine looked “broken”.
  - How to avoid: Resolve config via `CURSOR_CONFIG_DIR` / `$XDG_CONFIG_HOME/cursor/cli-config.json` / `~/.cursor/cli-config.json` in that order (as agent binary does).

- Pitfall: Claiming a “ready” bead without checking assignee/exclusive reservations.
  - Why it failed: Stole 5.14 from OliveCedar briefly.
  - How to avoid: `br show` + mail reservations before `br update --assignee`.

- Pitfall: Assuming Cursor custom statusline appends to native footer (Claude Code mental model).
  - Why it failed: Cursor replaces; docs/skill oversold Claude alignment.
  - How to avoid: Expect replacement; rebuild native bits in the script if needed.

- Pitfall: Setting `AGENT_NAME` in a subshell/tool call and expecting the TUI statusline to update.
  - Why it failed: Different process tree from the running `agent`.
  - How to avoid: Restart via `scripts/agent` or `--agent-name`.

## 6) Open Loops

- Question / issue: **tcp-efp.5.12** still in progress (BeigeHorizon) — daemon must host `serveUnixLiveOwnership`.
  - Blocking reason: Sole remaining hard blocker for 6.10.
  - Suggested next probe: Mail/status check; offer read-only review; do not touch their reserved files.

- Question / issue: Host Codex **0.145.0** vs C10 pin **0.144.6** → VERSION_DRIFT (5.14 surfaces this).
  - Blocking reason: Smoke/evidence policy may treat as drift-only until pin decision.
  - Suggested next probe: Read 5.14 / C10 docs before 6.10 execution.

- Question / issue: Concurrent `agent` sessions can rewrite XDG `cli-config.json` and drop `statusLine`.
  - Blocking reason: Known race (forum tip).
  - Suggested next probe: If statusline vanishes, re-check XDG file for `statusLine: null`.

- Question / issue: No coordinator identity in this repo yet.
  - Blocking reason: Explicitly deferred.
  - Suggested next probe: Only if multi-worker orchestration is adopted (kb-cli `cldy`/`COORDINATOR_*` pattern).

## 7) Decision Ledger

- Decision: Close 5.13 with path-scoped Deno flags + App Server env allowlist as source of truth in `service_permissions.ts`.
  - Rationale: Acceptance forbade bare `--allow-read`/`--allow-write` and full env inheritance.
  - Tradeoff accepted: Bootstrap permissions probe still uses a bounded `--allow-read=` list before final exec.

- Decision: Default manual `AGENT_NAME=TinyCedar`; workers override via launcher / `--agent-name`.
  - Rationale: Durable default for commits/guards without inventing a coordinator.
  - Tradeoff accepted: Standalone TTY without `--agent-name` still mints a new name each launch.

- Decision: Commit only launcher files (`9ef18bf`), not full WIP or beads dump.
  - Rationale: Meaningful, reviewable unit.
  - Tradeoff accepted: `.beads/issues.jsonl` (incl. closed probe) remains dirty unstaged.

- Decision: Do not steal 5.12 / 5.14 work after mis-claim incident.
  - Rationale: Swarm reservation discipline.
  - Tradeoff accepted: Idle on critical path until 5.12 lands.

## 8) Delta Update (for memory/playbook)

### Helpful (+)

- [cursor-cli-config] : On Linux with XDG_CONFIG_HOME set, live cli-config is $XDG_CONFIG_HOME/cursor/cli-config.json not ~/.cursor/cli-config.json (count: 2)
- [cursor-statusline] : Configured statusLine replaces native Auto/files-edited footer; native footer means statusLine inactive (count: 2)
- [agent-identity] : Export AGENT_NAME before exec of Cursor agent; statusline cannot see later subshell exports (count: 3)
- [agent-launcher] : Repo-scoped scripts/agent + direnv PATH_add mirrors kb-cli; use --agent-name on non-mux TTYs (count: 2)
- [swarm-beads] : Check assignee and file reservations before claiming a ready bead (count: 1)

### Harmful (-)

- [cursor-cli-config] : Editing ~/.cursor/cli-config.json alone does not affect agent when XDG_CONFIG_HOME is set (count: 2)
- [agent-identity] : AGENT_NAME=foo in a one-shot command does not update a running agent TUI statusline (count: 2)
- [swarm-beads] : Claiming an OPEN/ready bead that already has an assignee steals work (count: 1)

## 9) Next-Agent Brief

- What to read first: This handoff; `AGENTS.md` (launcher section); `br show tcp-efp.5.12` / `tcp-efp.6.10`; prior `docs/handoffs/2026-07-28T23-45-12Z-codex-ingress-release.md` for ingress architecture.
- What to ignore: Assumption that `~/.cursor/cli-config.json` is live; stealing 5.12 files; re-implementing 5.13 permissions.
- What to try first: Inbox + `br ready`; if 5.12 closed, start 6.10 per `docs/research/codex-v2-production-smoke-gate.md` with disposable binding and note C10 drift. Launch workers with `direnv allow` + `agent --agent-name <Name>`.
- What success looks like in the next turn: Either 5.12 closed with clear 6.10 claim, or a concrete smoke/evidence step underway without reservation conflicts; statusline shows name + bead when assignee has `in_progress` work.
