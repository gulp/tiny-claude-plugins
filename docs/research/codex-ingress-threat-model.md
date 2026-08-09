# Threat model: Codex Agent Mail ingress (F7 / tcp-efp.2.7)

**Status:** Accepted for implementation constraints (V3 audits)  
**Date:** 2026-07-28  
**Bead:** `tcp-efp.2.7` (closed)  
**Depends on:** F2 domain schemas; S5 ownership ADR (`exclusive_handoff`)  
**Plan:** `docs/plans/codex-agent-mail-ingress.md`  
**Verification bead:** `tcp-efp.6.3` (V3)

## Purpose

Encode trust boundaries and abuse cases **before** C2 transport and F5 persistence
harden. A late security review cannot cheaply repair a wrong authority boundary.

This document is the F7 deliverable. It does not implement mitigations; each
material threat names the bead that must prove the control.

## Assets

| Asset | Why it matters |
|---|---|
| Binding identity (agent + mail scope + thread id) | Wrong binding = wrong agent woken or wrong project context |
| Durable cursor / outbox | Loss or skip = missed or duplicate model turns |
| Ownership proof (sole App Server client) | Two responders = stolen approvals / elicitation |
| State database (SQLite) | Lease, batches, acceptance, dead letters |
| Mailbox filesystem (canonical git-mailbox) | Source of truth for non-consuming reads |
| Model-visible batch prompt | Injection surface into Codex turns |
| Operator commands (release/acquire/rebind/reset) | Can change authority and delivery position |
| Capability tokens / socket paths (if used) | Access to the controlling client |
| Structured logs / metrics | Leakage of subjects, tokens, paths |

## Actors

| Actor | Intent / capability |
|---|---|
| **Human operator** | Intended controller of handoff, config, and elevated commands |
| **Peer coding agent** | Legitimate Agent Mail sender; not an authorization authority |
| **Malicious / compromised peer** | Crafts mail to inject prompts, amplify privileges, or confuse ownership |
| **Local same-UID process** | Can open Unix sockets / read world-readable state if exposed |
| **Codex App Server / model** | Executes tools under its sandbox; must not gain extra authority from mail |
| **Plugin/skill host** | Installs control surface; must not silently widen permissions |
| **Supply-chain / version skew** | Newer CLI claiming old behavior |

## Trust boundaries

```text
┌─────────────────────┐     untrusted      ┌──────────────────────────┐
│ Agent Mail archive  │ ─────────────────▶ │ MailboxSource (F6)       │
│ (git-mailbox files) │   subjects/paths   │ normalize + bound sizes  │
└─────────────────────┘                    └────────────┬─────────────┘
                                                       │ MailEvent (F2)
                                                       ▼
┌─────────────────────┐   operator-only    ┌──────────────────────────┐
│ Human / CLI / O*    │ ─────────────────▶ │ IngressKernel + store    │
│ release/acquire/…   │   confirmed cmds   │ (F3–F5, K*)              │
└─────────────────────┘                    └────────────┬─────────────┘
                                                       │ DeliveryBatch
                       ownership proof                  ▼
┌─────────────────────┐ ◀── sole client ── ┌──────────────────────────┐
│ Codex App Server    │                    │ ThreadOwner (C1–C6/C8)   │
│ (0.144.6 baseline)  │ ── server reqs ──▶ │ headless policy / handoff│
└─────────────────────┘                    └──────────────────────────┘
```

**Rules:**

1. Mail content never crosses into “trusted instruction” space (L3 delimiters).
2. SQLite / JSON-RPC / filesystem details stay behind their adapters (plan boundaries).
3. Headless request auto-cancel/decline is legal **only** while owner = `headless` (S5).
4. A Unix socket is an **access-control boundary**, not proof of benign intent.
5. No silent fallback from private stdio → broader transports or `exec resume`.

## Abuse cases and decisions

Legend: **P** = prevent, **D** = detect, **A** = accept (residual), **V** = verify bead.

| ID | Abuse case | Decision | Control | Prove in |
|---|---|---|---|---|
| T1 | Prompt injection via subject / future body | **P** | Delimit untrusted mail; no bodies in v1; bound subject 512 B / batch 32 KiB | L3, F6, V3 |
| T2 | Mail claims “approve commit” / “you are root” | **P** | Mail never grants authority; side effects need human/policy (C9) | C9, L3, V3 |
| T3 | Malformed / huge / binary frontmatter DoS | **P/D** | Skip typed; hash reject; binding stays healthy unless flood policy trips | F6, O2 |
| T4 | Symlink escape from mailbox root | **P** | Refuse escaping symlinks; absolute path canonicalize | F6, V3 |
| T5 | Wrong `projectPath` / relative path | **P** | Config fail-closed (F1); absolute + resolved canonical | F1, O1 |
| T6 | Cross-binding cursor / batch mix-up | **P** | Binding id in every persist key; lease per binding | F3–F5, K2 |
| T7 | Replay old batches after cursor rewind | **P/D** | Stable event/batch ids; reset-cursor requires `--confirm`; observable | K2, O4 |
| T8 | Ambiguous acceptance → double turn | **A/D** | At-least-once with identical ids; model prompt duplicate-safe | L3, C5, K2 |
| T9 | Two clients answer one server request | **P** | Exclusive ownership; first-response-wins is treated as failure mode not feature | C9, C6, S2a |
| T10 | Headless auto-decline races human approval | **P** | Never attach headless beside human; handoff drains first | C6, C9, S2b |
| T11 | Implicit handoff on disconnect | **P** | Owner stays until explicit command; disconnect → unhealthy/queue | C6, C5 |
| T12 | Resume failure invents new thread | **P** | Fail closed; no replacement `thread/start` | C3, S1 |
| T13 | App Server death → silent `exec resume` | **P** | Forbidden fallback (S5 #7) | C2, K3, V2 |
| T14 | Unknown App Server method ignored | **P** | `-32601` then binding unhealthy | C2, C10 |
| T15 | Same-UID peer opens owner Unix socket | **A/P** | Prefer private stdio; if socket: owner-only perms + treat access as full control | C2, F7 note |
| T16 | Loopback WebSocket without token | **P** | Capability-token required if WS retained | C2, V3 |
| T17 | State DB world-readable / in project tree | **P** | Runtime dir only; supervisor no project write | F5, O3 |
| T18 | Logs leak subjects / tokens | **P** | Default logs exclude content; `--log-content` redacts secrets | O2, V3 |
| T19 | Plugin skill widens sandbox / network | **P** | O7 packaging must not elevate Codex permissions for convenience | O7, V3 |
| T20 | Version skew merges evidence | **P** | Pin 0.144.6 acceptance; newer = drift probe | C10, S5 |
| T21 | Lease stolen by second supervisor | **P/D** | Renewable exclusive lease; second acquire fails loud | F5, O1 |
| T22 | Operator rebind/reset without confirm | **P** | Destructive cmds require explicit confirmation | O4, O5 |
| T23 | Product-bus / project-scope confusion | **P** | Scope kind in binding; MailboxSource contract | F6, F1 |
| T24 | Metrics HTTP binds non-loopback | **P** | Default off; if on, loopback-only | F1 flags, O2 |

## Security requirements (traceability)

These must appear in design/tests for the named areas:

1. **Transport (C2/C10):** private stdio default; socket = full-trust same-UID; no auto transport upgrade; unsupported method fails closed.
2. **Persistence (F3–F5/K2):** transactional cursor+acceptance; lease exclusivity; online backup path before destructive migration.
3. **Ownership (C1/C6/C8/C9):** sole responder; headless policy gated on owner mode; explicit handoff only.
4. **Mailbox (F6):** non-consuming; symlink refuse; size bounds; typed skips.
5. **Model input (L3):** injection delimiters; duplicate-safe event ids; no authority verbs from mail.
6. **Observability (O2):** every drop/skip/dead-letter/duplicate visible; content opt-in.
7. **Operations (O1/O4/O5/O7):** doctor surfaces auth/ownership/version; elevated cmds confirmed; plugin does not widen sandbox.
8. **Verification (V3):** socket auth, path confinement, untrusted input, and authority-separation tests.

## Residual / accepted risks

| Risk | Why accepted for v1 | Compensating control |
|---|---|---|
| Same-UID local attacker with socket access | Stock App Server has no per-client ACL | Prefer stdio; document socket = full control; filesystem perms |
| At-least-once duplicate model turns | Ambiguous acceptance is inherent | Stable ids + duplicate-safe prompts |
| Peer agent social-engineering via mail | Coordination channel by design | Delimiters + human for side effects; never treat peer mail as user auth |
| Operator mistake on rebind/reset | Humans err | `--confirm` + audible doctor/status |

## Non-goals (explicit)

- Not a multi-tenant remote service; local single-operator machine assumed.
- Not a replacement for Codex sandbox / approval policy.
- Not encrypting mailbox content at rest (inherits Agent Mail / git trust model).
- Not building a complete interactive gateway ACL (rejected by S2c/S5).

## Review checklist (for V3)

- [ ] Every T-row has P/D/A and a prove-in bead
- [ ] C2 implementation cites T13–T16 before merge
- [ ] L3 fixtures include injection strings and authority-claim subjects
- [ ] F6 tests symlink escape and oversized subject
- [ ] C9 tests two-client race cannot double-answer
- [ ] O7 install does not add network/`dangerously*` permissions for ingress convenience

## Change log

- 2026-07-28 — Initial F7 draft (QuietBass); aligns with S5 `exclusive_handoff` and plan Security section.
