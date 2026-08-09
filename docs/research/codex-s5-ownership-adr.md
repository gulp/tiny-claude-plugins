# ADR: Codex Agent Mail ingress ownership (S5 / tcp-efp.1.8)

**Status:** Accepted  
**Date:** 2026-07-28  
**Deciders:** QuietBass (author); Phase-0 spike evidence from QuietBass, WindyCedar, ChartreuseOx, CobaltJaguar  
**Bead:** `tcp-efp.1.8`  
**Plan:** `docs/plans/codex-agent-mail-ingress.md`

## Context

Agent Mail must wake a durable Codex thread without model-driven polling. Stock
Codex App Server provides `turn/start` / `turn/steer` over a private client
connection. Multiple independent clients on one thread are unsafe: server
requests fan out with a single callback (first response wins), and
`currentTime/read` requires exactly one subscribed client. The Phase-0 spikes
measured every contender against the same fixture harness.

## Decision

**Select `exclusive_handoff` as the sole v1 production ownership model.**

Concrete shape:

1. **Headless owner (default delivery authority):** one private stdio (or
   owner-only Unix socket) App Server client owned by the ingress supervisor.
   It is the only controlling client while owner = `headless`.
2. **Explicit human window:** operator commands drain active turns / open
   server requests, release headless ownership, then a human attaches (stock
   TUI/`--remote`/IDE) as the sole client. Mail arriving in this window is
   **queued**, never delivered into the human-owned connection.
3. **Explicit reacquire:** after the human detaches, operator reacquires
   headless ownership on the **exact** thread id and drains the queue once
   with stable batch/event ids.
4. **Headless request policy** (cancel elicitation, decline approvals, reject
   unknown methods, fail on process death) applies **only** while owner =
   `headless`. It must never run beside a human client.

Claude `agent-mail-monitor` remains unchanged and separate.

## Rejected alternatives

| Contender | Verdict | Why |
|---|---|---|
| Independent supervisor + stock remote TUI co-control | **Reject** | S2a: rendering ≠ ownership; source proves first-response-wins and single-subscriber `currentTime/read`; no public observer/controller lease |
| `gateway_owner` (repo gateway as sole client + full interactive UI) | **Reject (v1)** | S2c: stock `app-server proxy` is a byte pipe, not arbitration; complete interactive surface (approvals, elicitation, permissions, user input, render, steer, interrupt, reconnect) is unproven and plan-forbidden as a partial UI |
| Native `monitor` fork (`yaanfpv` / #29922) | **Reject (v1)** | S4: works in design but unmerged; ~0.5–2d rebase per minor on 0.145+; watches ephemeral; plan non-goal forbids shipping the fork in v1 |
| `codex exec resume` as default or auto-fallback | **Reject** | S3: degraded comparison only — process-per-event, no steer, ambiguous failures; plan no-silent-fallback #1 |
| Notification-only / degraded wake without model turn | **Not a ThreadOwner** | May exist as an operator signal; must not claim ingress delivery |

## Evidence index

| Spike | Bead | Artifact | Result feeding this ADR |
|---|---|---|---|
| S0 harness | tcp-efp.1.1 | `tests/codex-ingress-harness.ts` | Shared fixtures / evidence capture |
| S1 headless tracer | tcp-efp.1.2 | `docs/research/codex-s1-headless-tracer-evidence.md` | Mail→`turn/start` oracle; fail-closed; serialized wakes; `#27982` shape |
| S2a remote TUI | tcp-efp.1.3 | `docs/research/codex-remote-tui-characterization.md` | Live render yes; co-control no (0.144.6 baseline) |
| S2b handoff | tcp-efp.1.4 | `docs/research/codex-s2b-ownership-handoff-evidence.md` | Zero overlap; queue across human window; exact reacquire |
| S2c gateway | tcp-efp.1.5 | `docs/research/codex-s2c-gateway-feasibility-evidence.md` | Gateway NO-GO for v1 |
| S3 exec-resume | tcp-efp.1.6 | `docs/research/codex-s3-exec-resume-evidence.md` | Degraded-only |
| S4 native fork | tcp-efp.1.7 | `docs/research/codex-s4-native-monitor-fork-evidence.md` | Native NO-GO for v1 |

Suite at S2c close: `deno task test:codex` → **34/34**.

## Invariants (must be encoded in F2/C1/C6/K*)

1. Exactly one ownership model is active per binding; never blend adapters.
2. Exactly one controlling App Server client while owner ∈ {headless, human}.
3. Owner `none` delivers nothing and does not answer server requests as ingress.
4. Ownership changes only via explicit operator commands (never on disconnect).
5. Resume targets the recorded thread id or fails closed — never `thread/start` replacement.
6. Headless auto-cancel/decline policy is illegal while owner = `human`.
7. App Server failure never invokes `codex exec resume`.
8. Unknown App Server methods → JSON-RPC `-32601` then binding unhealthy.
9. Mailbox reads remain non-consuming (canonical git-mailbox only).
10. Protocol baseline for acceptance is **Codex App Server 0.144.6**; 0.145.0+ fields (`emittedAtMs`, `canAcceptDirectInput`) are skew to track, not silent assumptions.

## Request-response authority

| Owner | Who answers server requests | Who may `turn/start` / `turn/steer` for mail |
|---|---|---|
| `headless` | Ingress supervisor (typed cancel/decline/fail-closed) | Supervisor only |
| `human` | Human client (TUI/IDE) only | Nobody for mail (queue only) |
| `none` | Nobody (ingress silent) | Nobody |

## Human-visible surface

- **Delivery path:** headless durable thread wake (model-visible mail batches).
- **Human inspection:** explicit release → human attaches to the **same** thread → explicit detach → headless reacquire.
- **Not in v1:** simultaneous human TUI + supervisor on one thread; gateway-mediated single connection; native in-TUI monitor without handoff.
- **Optional degraded signal:** OS/desktop notification that mail is queued — must not claim turn ingress.

Operator commands (plan already sketched; land under O5/C6 after this ADR):

```text
binding release-owner <binding> --to human
binding acquire-owner <binding> --owner headless
binding rebind-thread <binding> <thread-id>
```

## Protocol / version policy

| Item | Policy |
|---|---|
| Acceptance baseline | Codex **0.144.6** (`rust-v0.144.6`) |
| Local drift watch | 0.145.0 characterized in S2a; treat new envelope fields as compatibility skew (tcp-efp.4.10) |
| Transport for headless owner | Private stdio preferred; owner-only Unix socket allowed |
| WebSocket | Loopback + capability-token if used; never rely on stock proxy for arbitration |
| Feature flags | `codex_ingress.adapter=headless-owner`; `ownership=explicit-handoff`; `urgent_steer` default false |

## Migration / implementation consequences

**Unblocked by this ADR alone:**

- **F1** production package / config / CLI / error taxonomy  

**Unblocked only after their named foundation/Codex predecessors (ADR selects the path; it does not erase those edges):**

- **C1** `ThreadOwnerAdapter` contract + fake owner — blocked by **F2 + S5** (not S5 alone)  
- **C6** explicit handoff / overlap refusal — blocked by **C3 + S5** (selected implementation)  
- **C8** package ADR-selected ownership — blocked by **C6** (blocking edge required; related-only is not enough)  

**Stay deferred / conditional (do not start; C8 closes them not-selected):**

- **C7** gateway owner — only if a future ADR reverses S2c  
- **C11** native monitor owner — only if a future ADR reverses S4  
- **exec-resume adapter** — never auto; optional explicit degraded mode behind a separate flag if product asks  

**Also gated after foundation (not “immediately unblocked”):** F7 threat model; C9 server-request policy; C10 protocol skew; O6 human-visible surface; O7 production Codex plugin/skills.

**Kernel path remains:** F2 → F3/F4/F5/F6 → L1–L4 → K1–K3 with `ThreadOwner` = exclusive handoff adapter (C6 via C8), never C7/C11 for v1.

## Exact dependency wiring from this decision

```text
S5 (this ADR)
  ├─▶ F1 ─▶ F2 ─▶ … (F3/F6/L*/F7…)
  │            └─▶ C1 ─▶ C2 ─▶ C3 ─▶ C4 ─▶ C5
  │                                 └─▶ C6 (handoff) ─blocks─▶ C8 ─▶ K3
  └─▶ (C7, C11 remain unselected — C8 closes not-selected; do not start)
```

### Correction (2026-07-28)

CobaltJaguar audit (`#28055`): an earlier draft claimed C1 was “immediately unblocked”
by S5. Authoritative `br` DAG and plan task text already required **F2 + S5**. This ADR
and the plan checkpoint now match that graph; C8→C6 is a **blocks** edge, not merely
`related`.

## Consequences summary

**Positive:** smallest safe stock architecture; reuses proven S1 tracer semantics; human visibility without co-control; clear fail-closed rules; Claude monitor untouched.

**Negative:** human cannot stay in an interactive TUI *and* receive automatic mail turns without an ownership flip; Claude-like always-on interactive wake needs native fork (rejected for v1) or a future complete gateway.

**Neutral:** exec-resume and native fork remain documented comparison artifacts for regressions and future ADRs.
