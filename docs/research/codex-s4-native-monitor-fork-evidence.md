# S4 evidence: native monitor fork / rebase cost (tcp-efp.1.7)

**Agent:** QuietBass  
**Date:** 2026-07-28  
**Pinned local Codex:** `codex-cli 0.145.0` (`/home/gulp/.local/bin/codex`)  
**Pinned upstream tags:** `rust-v0.142.0` (fork base), `rust-v0.145.0` (current release line)  
**Primary contender:** `yaanfpv/codex` branch `monitor-tool` — compare  
  https://github.com/openai/codex/compare/rust-v0.142.0...yaanfpv:codex:monitor-tool  
**Secondary port:** `hassaans/codex` draft PR #1 (`feat/monitor-tool`) — port notes against later `main`  
**Upstream issue:** openai/codex#29922 (OPEN; not merged)  
**Constraint:** keep fork delta isolated; do not silently ship or install; pin examined commit/version  
**Out of scope:** building/installing a private Codex binary in this repo; App Server adapter work (S1/S2*)

## Verdict — **NO-GO for v1 production owner**

| Question | Answer |
|---|---|
| Claude-like interactive wake possible? | **Yes** — agent-callable `monitor` tool wakes idle session on stdout/stderr lines via `try_start_turn_if_idle` |
| Request ownership inside interactive client? | **Yes** — wake lives in the owning Codex process (solves stock multi-client arbitration differently from a second App Server client) |
| Patch delta | **~1,100 LOC / 19 files** (yaanfpv on `rust-v0.142.0`); **~1,516 LOC / 20 files** (hassaans port) — mostly additive |
| Upstream acceptance | **No** — #29922 open; no stock `Monitor` feature flag at `rust-v0.145.0` |
| Recurring rebase cost | **Medium–high** — ~0.5–2 engineer-days per minor when hotspots move; see below |
| **v1 go/no-go** | **NO-GO** as production ThreadOwner. Prefer stock single-owner App Server (S1 oracle + S2b handoff). Keep fork as **tracked contender** for S5 only if a product requirement demands in-TUI wake *without* ownership handoff. |

This matches the ingress plan non-goal: *“Do not port the unmerged Codex monitor fork in v1.”*

## Acceptance checklist

| Criterion | Result |
|---|---|
| Reproduce / pin native fork contender | **Pass** — yaanfpv `monitor-tool` @ `ae7dbe6aecf1` on `rust-v0.142.0`; hassaans draft port documented |
| Claude-like interactive wake | **Pass (design)** — line-batched wake; quiet = zero API calls; feature-flagged |
| Request ownership model | **Pass (design)** — in-process delivery; not a second App Server client |
| Patch delta recorded | **Pass** — file list + LOC below |
| Upstream drift points | **Pass** — 0.142→0.145 churn + port notes |
| Maintenance / rebase estimate | **Pass** — below |
| Go/no-go | **NO-GO for v1**; contender for S5 if interactive-without-handoff becomes mandatory |

## What the fork does

From #29922 and the yaanfpv commit message:

```text
monitor(action=start|list|stop, command=…, description=…)
        │
        ▼
 unified_exec process manager (shared sandbox / reap-on-shutdown)
        │
        ▼
 delivery task: coalesce lines (~200ms), flood-guard
        │
        ▼
 try_start_turn_if_idle  →  new model turn with monitor notification
```

Intended agent-mail invocation shape (from prior research):

```text
monitor(
  action="start",
  description="agent-mail for <AGENT>",
  command="AGENT_NAME=… CLAUDE_PROJECT_DIR=… deno run … src/cli.ts monitor"
)
```

**Ephemeral by design:** watches die with the session; no durable cursor. Agent Mail’s durable `(agent, project)` cursor must still live outside Codex (our IngressKernel), even if the wake path is native.

## Patch inventory (yaanfpv vs `rust-v0.142.0`)

Compare API: `ahead_by=1`, **+1100 / −0**, **19 files**.

| Path | Role |
|---|---|
| `codex-rs/core/src/unified_exec/monitor.rs` (+466) | Watcher runtime |
| `codex-rs/core/src/tools/handlers/unified_exec/monitor.rs` (+298) | Tool handler |
| `codex-rs/core/tests/suite/monitor.rs` (+251) | E2E suite |
| `codex-rs/core/src/context/monitor_notification.rs` (+36) | Notification payload |
| `codex-rs/features/src/lib.rs` (+9) | Feature flag |
| + small hooks in session / handlers / process_manager / spec_plan / config.schema | Wiring |

hassaans port adds permission inheritance (`apply_granted_turn_permissions`) and `request_permissions` regression coverage (+148).

## Upstream drift (`rust-v0.142.0` → `rust-v0.145.0`)

| Metric | Value |
|---|---|
| Commits ahead (compare) | **700** (`ahead_by`; API also reports 250 listed commits / truncated) |
| Files changed | **~300** |
| Diff volume | **+9691 / −1901** |
| Stock `Monitor` tool at 0.145.0 | **Absent** (`features` has no Monitor; no `unified_exec/monitor.rs`) |
| Wake primitive still present | **`try_start_turn_if_idle`** still in `session/inject.rs` / `codex_thread.rs` |
| Nearby but different | `unified_exec/async_watcher.rs` streams exec **output deltas** — not idle-session wake |

### Integration-point file size drift (proxy for rebase friction)

| File | Δ size 0.142→0.145 |
|---|---:|
| `session/session.rs` | +2176 |
| `state/service.rs` | +1872 |
| `features/src/lib.rs` | +1128 |
| `session/handlers.rs` | +423 |
| `tools/spec_plan.rs` | −460 |
| `unified_exec/process_manager.rs` | −261 |
| `unified_exec/mod.rs` | +134 |
| `tools/handlers/unified_exec.rs` | 0 |

hassaans porting notes (2026-06-29, against then-`main`): only **two** mechanical fixes — feature-flag list conflict, and `resolve_tool_environment(&TurnEnvironmentSnapshot)` vs `&TurnContext`. That port is **~1 month stale** relative to `0.145.0`; expect additional conflicts in `session.rs` / `features` / `state/service.rs` on a fresh rebase.

## Maintenance estimate

| Cadence | Expected cost | Notes |
|---|---|---|
| Initial rebase 0.142 → 0.145 | **1–2 days** | Mostly re-apply additive files; resolve session/features/service conflicts; re-run `core/tests/suite/monitor.rs` |
| Each subsequent minor (observed ~weekly alphas toward 0.146) | **0.5–1 day** | Same hotspots; risk spikes when `unified_exec` or idle-turn injection APIs move |
| Packaging | **Ongoing** | Private `codex` binary + pin policy; CI must build Rust fork; Desktop/app surfaces need the same core patch |
| Product risk | **High** | Upstream may land a different shape (#20312 durable sources, #22003 inject-on-completion) and obsolete the fork |

## Fit vs this project’s ownership decision

| Contender | Interactive wake without handoff? | Safe with stock TUI? | Durable mail cursor? |
|---|---|---|---|
| Headless App Server tracer (S1) | No (headless-only) | Yes if exclusive | Ours |
| Explicit handoff (S2b) | Human window = no headless delivery | Yes with zero overlap | Ours |
| Native `monitor` fork (S4) | **Yes** (in-process) | Yes (single process) | Still ours (watches ephemeral) |
| Independent supervisor + remote TUI | Unsafe on 0.144.6+ | **No** (broadcast / first-wins) | Ours |

**S5 recommendation seed:** reject native fork as v1 owner unless a hard requirement is “human stays in the interactive TUI *and* mail wakes that same process with no ownership handoff.” Stock exclusive handoff already covers human visibility with a proven fail-closed boundary.

## How to reproduce / refresh this assessment

```bash
# Pin local CLI
codex --version   # expect 0.145.0 on this machine at assessment time

# Fork delta vs release base
gh api repos/openai/codex/compare/rust-v0.142.0...yaanfpv:codex:monitor-tool \
  --jq '{ahead_by, files:(.files|length), additions:([.files[].additions]|add)}'

# Upstream movement
gh api repos/openai/codex/compare/rust-v0.142.0...rust-v0.145.0 \
  --jq '{ahead_by, files_changed:(.files|length)}'

# Issue still open?
gh issue view 29922 -R openai/codex --json state,title
```

Do **not** install the fork into the default `codex` on PATH from this marketplace repo.

## Relation to plan gates

- Feeds **S5** as a documented, measured reject (unless requirements change).
- Does not unblock F1/F2 by itself.
- Leaves App Server exclusive-owner path as the default production contender.
