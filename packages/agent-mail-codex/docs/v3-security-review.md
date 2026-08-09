# V3: Security and threat review (tcp-efp.6.3)

**Status:** Complete for v1 gate  
**Date:** 2026-07-28  
**Reviewer agent:** WindyCedar  
**Threat model:** `docs/research/codex-ingress-threat-model.md` (F7 / tcp-efp.2.7)  
**Integrated system:** K3 production composition (`src/kernel/production.ts`) + C8
`exclusive-handoff` / `private-stdio` owner + L3 encoder + F6 mailbox + F5 store +
O1/O2/O4/O5 operator surface.

> Evidence lives under `packages/agent-mail-codex/docs/` because a peer held an
> exclusive `docs/**` reservation at review time. Canonical F7 threat model remains
> under `docs/research/`; copy or link this file there when the reservation clears.

## Method

1. Re-read F7 T1–T24 and residual risks.
2. Map each threat to a **passing test**, **operational detection**, or **explicit
   residual** (no silent “assumed fine”).
3. Spot-check production composition: no exec-resume fallback, private-stdio only,
   single-responder authority.
4. Run package suite (`deno task test`) as the mechanical gate.

## Production authority snapshot

| Property | Value | Evidence |
|---|---|---|
| Owner name | `exclusive-handoff` | `PRODUCTION_OWNER` / C8 test |
| Transport | `private-stdio` | K3 + C8 tests |
| Authority | `single-responder` | C8 |
| Fallback | `null` (no exec-resume / gateway / native) | C8 exports + reconnect docs |
| State | SQLite WAL | F5 / K3 |
| Mailbox | canonical git-mailbox, non-consuming | F6 / K3 |

## Threat → proof matrix

| ID | Decision | Proof (test / detection / residual) | Verdict |
|---|---|---|---|
| T1 | P | `tests/l3_encoder_test.ts` — delimiters, no bodies, 32KiB, injection strip | **Pass** |
| T2 | P | L3 untrusted warning + `tests/c9_request_policy_test.ts` (side effects via policy, not mail) | **Pass** |
| T3 | P/D | F6 skips malformed/oversize; O2 represents drops | **Pass** |
| T4 | P | `tests/f6_mailbox_test.ts` symlink_escape skip | **Pass** |
| T5 | P | F1 absolute path fail-closed; O1 surfaces config health | **Pass** |
| T6 | P | F3–F5 binding keys; K2 recovery tests | **Pass** |
| T7 | P/D | O4 `--confirm` reset-cursor; stable batch ids (K2/F2) | **Pass** |
| T8 | A/D | L3 stable idempotencyKey; C5 `retry_same_batch`; K2 ambiguous delivering | **Accepted + detected** |
| T9 | P | C9 first-response-wins treated as failure; C6 exclusive handoff | **Pass** |
| T10 | P | C6/C9 headless only when owner=headless; O5 release drains/refuses open request | **Pass** |
| T11 | P | O5 disconnect never auto-transfers; C5 reconnect exact thread only | **Pass** |
| T12 | P | C3/K3 exact-thread mismatch refusal; no replacement thread/start | **Pass** |
| T13 | P | `PRODUCTION_OWNER.fallback === null`; reconnect forbids exec-resume | **Pass** |
| T14 | P | C2 `-32601` then unhealthy | **Pass** |
| T15 | A/P | Prefer private-stdio (production); socket = full same-UID control (documented residual) | **Residual accepted** |
| T16 | P | Production transport is private-stdio; WS not in production owner | **Pass** (N/A to prod path) |
| T17 | P | F5 file-backed state under operator-chosen absolute path; O3 will pin runtime dir | **Pass / O3 follow-up** |
| T18 | P | O2 redacts subject/body/content recursively | **Pass** |
| T19 | P | O7 not yet shipped — tracked; C8/plugin must not add `dangerously*` | **Open until O7** |
| T20 | P | C10/C8 compatibility pin + drift probe | **Pass** |
| T21 | P/D | F5 lease_held; O1 lease dimension | **Pass** |
| T22 | P | O4/O5 confirm tokens; mismatch fails closed | **Pass** |
| T23 | P | F1 scope kind; F6 project/product contracts | **Pass** |
| T24 | P | O2 metrics off by default; non-loopback refused | **Pass** |

## F7 review checklist

- [x] Every T-row has P/D/A and a prove-in bead / test
- [x] C2 cites T13–T16 behavior (`-32601`, no auto transport upgrade, private-stdio default)
- [x] L3 fixtures include injection strings and authority-claim subjects
- [x] F6 tests symlink escape and oversized subject
- [x] C9 tests competing / late responses cannot silently succeed as dual ownership
- [ ] O7 install does not add network/`dangerously*` permissions — **blocked on O7 bead**

## Human-visible failure reporting

Doctor/status (O1) and observability (O2) expose unhealthy ownership, probe failures,
drops, retries, and handoffs without embedding mail bodies. Operator mutations (O4/O5)
preview current→proposed state and require confirm tokens — confirmation bypass is a
typed error, not a silent apply.

## Unsupported protocol / version skew

C8/C10 require acceptance compatibility before constructing the production owner.
Unknown methods return `-32601` and mark the binding unhealthy (C2). No silent
downgrade to exec-resume or a second transport.

## Residual risks (reaffirmed)

Same-UID socket access, at-least-once duplicate turns, peer social-engineering via
mail, and operator mistakes on confirmed commands remain accepted with the
compensating controls listed in F7. V3 does **not** widen sandbox or approval policy.

## Open follow-ups (not V3 blockers)

1. **O7** — verify packaged Codex plugin/skills do not elevate permissions (T19).
2. **O3** — pin state DB to a runtime directory with tight perms (T17 hardening).
3. When `docs/**` reservation clears, symlink or copy this review beside the F7 model
   and tick the F7 checklist box for V3.

## Verification commands

```bash
cd packages/agent-mail-codex
deno task test
# focused:
deno test --allow-read --allow-write --allow-env --allow-ffi tests/v3_security_review_test.ts
```
