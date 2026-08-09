# S1 evidence: headless App Server tracer (tcp-efp.1.2)

**Agent:** WindyCedar  
**Date:** 2026-07-28  
**Adapter:** private stdio → fake App Server (`tests/codex-fake-app-server.ts`)  
**Constraint:** one private client only; no remote TUI  
**Live field proof (prior):** message `#27982` (Monitor wake nudge) → reply `#27983` on durable thread under CobaltJaguar/PurpleBass (Codex 0.144.6 era)

## Acceptance checklist

| Criterion | Result |
|---|---|
| Existing private-stdio scenarios pass | **Pass** — `deno task test:codex` → **15/15** (8 integration + 3 S1 measurement + 4 S0 harness) |
| Idle `turn/start` | Covered by integration + S1 latency runs |
| Active-turn behavior | **Serialized** — second event waits; **zero** `turn/steer` emitted |
| Exact resume | `--thread thread-durable` resumes exact id (integration + S1 wake-nudge) |
| Elicitation | Init-time and turn-time cancel (integration) |
| Timeout / process death / unknown request | Integration suite (fatal) |
| `#27982/#27983` shape with fixture identity | Fixture id `27982`, agent `CobaltJaguar`, ack-required high wake nudge → `MAIL #27982` + `DELIVERED through #27982`; mailbox file retained (non-consuming) |
| Message-to-turn p50/p95 recorded | See below |

## Latency (fake App Server path)

Measured as wall-clock ms from fixture write to fake `turn/start` acceptance (`TEST_TIMING_PATH`), n=11:

| Metric | Run sample (ms) |
|---|---:|
| samples | 60, 60, 61, 61, 63, 64, 69, 71, 73, 77, 79 |
| **p50** | **64** |
| **p95** | **78** |

**Interpretation:** these numbers bound the tracer + fixture + fake protocol path only. They are **not** live Codex 0.144.6/0.145.0 model latency and must not be compared directly to the production p95 targets in the ingress plan (≤ 1.75 s end-to-end). They do show the headless tracer adds negligible overhead before App Server acceptance on the fake peer.

Plan soft budgets for production remain:

- Idle-thread `turn/start` accepted after observation, p95 ≤ 750 ms
- End-to-end mail-to-turn-start, p95 ≤ 1.75 s

## Active steer finding

The operational tracer **does not** call `turn/steer`. When mail arrives during an in-flight wake turn, delivery is **serialized**: the monitor finishes the current `turn/start` cycle, then starts a new turn for the later event. Urgent `turn/steer` remains a production kernel/adapter concern (plan Phase C4 / feature flag `codex_ingress.urgent_steer`).

## How to reproduce

```bash
cd plugins/agent-mail-monitor
timeout 60s deno task test:codex
```

S1-specific cases live in `tests/codex-s1-measurement.test.ts`. Timing hooks: `TEST_TIMING_PATH`, `TEST_SKIP_AUTO_MAIL`, `TEST_TURN_HOLD_MS`, `TEST_EXIT_AFTER_TURNS` on the fake App Server.

### Hang fix (reopened after independent hangs)

The active-turn serialization case previously ended the long-lived monitor with `SIGTERM`, which raced with piped stdout/`Deno.exit` and hung for other agents under load. It now uses `TEST_EXIT_AFTER_TURNS=2` so the fake peer exits cleanly after two completions; the test awaits that natural process death under a **20s hard deadline** (no SIGTERM happy path).

## Harness note

S0 default clock previously called `Temporal.Now`, which is unavailable in this Deno runtime without flags. Default now uses `Date.now()` nanoseconds so Phase-0 consumers need not inject a clock for wall-time measurement. Deterministic harness tests still inject their own clock.
