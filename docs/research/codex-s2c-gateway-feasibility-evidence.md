# S2c evidence: single-connection gateway feasibility (tcp-efp.1.5)

**Agent:** QuietBass  
**Date:** 2026-07-28  
**Pinned Codex:** acceptance `0.144.6` (S2a); local `codex-cli 0.145.0`  
**Spike code:** `tests/codex-s2c-gateway-feasibility.ts` + `.test.ts`  
**Depends on:** S2a remote-TUI characterization (`docs/research/codex-remote-tui-characterization.md`)  
**Constraint:** stock `app-server proxy` is byte transport, not arbitration; no undocumented partial UI

## Verdict for S5 — **NO-GO (gateway_owner)**

Do **not** select a repository-owned gateway as the v1 production owner.

A viable gateway must be the *sole* App Server client **and** expose a complete interactive human surface. Stock Codex supplies neither half as a ready product:

1. **`codex app-server proxy`** — help text: *“Proxy stdio bytes to the running app-server control socket.”* Raw pipe to the control socket. No JSON-RPC inspection, no request demultiplexing, no observer/controller roles.
2. **Stock remote TUI (`codex --remote`)** — a full interactive client that *attaches as an App Server client*. S2a proved it can render externally started turns, but that topology is multi-client and unsafe for server-request ownership.
3. **Building our own complete client** (approvals UI, elicitation, permissions, user input, streaming render, steer, interrupt, reconnect) is a multi-month product that duplicates TUI/IDE work. Phase-0 does not prove it; plan forbids accepting a partial UI as production-ready.

Prefer **exclusive headless App Server ownership + explicit handoff** (S1 + S2b). Keep gateway as a rejected alternative unless a future spike ships a *complete* sole-client interactive surface with tests for every row below.

## Acceptance checklist

| Criterion | Result |
|---|---|
| Approvals | **Rejected** — sole client must own `item/commandExecution/requestApproval` + `item/fileChange/requestApproval`; stock proxy cannot |
| Elicitation | **Rejected** — `mcpServer/elicitation/request` needs human UI; headless auto-cancel (S1) must not share the connection |
| Permissions | **Rejected** — `item/permissions/requestApproval` same ownership rule |
| User input | **Rejected** — `tool/requestUserInput` requires interactive prompts |
| Rendering | **Rejected** — live render exists only as a *client* (S2a); gateway would have to *be* that client |
| Steering | **Rejected** — human+mail `turn/steer` merge needs one connection; no stock merger |
| Interrupt | **Rejected** — human cancel must map through gateway-owned input |
| Reconnect | **Rejected** — durable correlation + no implicit handoff not provided by proxy |
| Failure behavior | **Rejected** — extra gateway process without replacing TUI adds failure modes; not proven fail-closed as an owner |
| Stock proxy ≠ arbitration | **Proven** — CLI help + README (`opens exactly one raw stream… proxies bytes`) |

## Stock proxy contract (measured)

```bash
codex app-server proxy --help
# → Proxy stdio bytes to the running app-server control socket
```

From `openai/codex` app-server README (unix transport section):

> `codex app-server proxy` opens exactly one raw stream connection to  
> `$CODEX_HOME/app-server-control/app-server-control.sock` … and proxies bytes  
> between that socket and stdin/stdout.

Plan rule #12 already forbids treating this as an arbitration gateway. S2c confirms that rule with live CLI text.

## Why “gateway in front of remote TUI” fails

```text
Bad topology (looks like a gateway, is not):

  human TUI ──┐
              ├── App Server   ← two clients; S2a: unsafe for server requests
  supervisor ─┘

Stock proxy topology (still not a gateway):

  client stdio ──proxy──▶ control.sock ──▶ App Server
                 (opaque bytes; no demux)

Required gateway topology (unproven / not stock):

  human UI ──┐
             ├── OUR gateway (sole App Server client) ──▶ App Server
  mail wake ─┘
```

S2a already showed notification fan-out and first-response callback consumption in source. Putting a byte proxy between TUI and App Server does not create sole-client ownership if the TUI remains a separate initialized client.

## Server-request surface a complete gateway must implement

From App Server docs (non-exhaustive, must all be human-mediated when a human is present):

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `mcpServer/elicitation/request`
- `tool/requestUserInput` / `item/tool/requestUserInput`
- `currentTime/read` (when enabled; requires exactly one subscribed client — S2a)

Plus client→server: `turn/start`, `turn/steer`, `turn/interrupt`, thread lifecycle, and full event rendering.

## How to reproduce

```bash
cd plugins/agent-mail-monitor
deno test --allow-env --allow-read --allow-run --allow-write \
  tests/codex-s2c-gateway-feasibility.test.ts
# or: deno task test:codex   # once wired
```

## Relation to other spikes

| Spike | Input to S2c |
|---|---|
| S2a | Rendering ≠ ownership; no public observer role |
| S1 | Headless request policy (cancel/decline) must never share a thread with a human |
| S2b | Explicit handoff already covers human visibility without co-control |
| S3 / S4 | Degraded / native alternatives — orthogonal to gateway |

## S5 recommendation seed

**Reject `gateway_owner` for v1.**  
**Select `exclusive_handoff` (headless owner + explicit human window)** unless product requirements change.  
Re-open gateway only with a spike that proves every checklist row as `proven`, not by wrapping `app-server proxy`.
