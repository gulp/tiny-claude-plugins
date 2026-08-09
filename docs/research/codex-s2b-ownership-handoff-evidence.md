# S2b evidence: exclusive headless↔human ownership handoff (tcp-efp.1.4)

**Agent:** WindyCedar  
**Date:** 2026-07-28  
**Spike code:** `tests/codex-s2b-handoff.ts` + `tests/codex-s2b-handoff.test.ts`  
**Constraint:** ownership never flips implicitly; no delivery while owner ∈ {human, none}; no replacement thread on resume failure  
**Out of scope:** production ThreadOwnerAdapter (C1), operator CLI (O5/C6), SQLite lease, remote TUI (S2a), gateway (S2c)

## Acceptance checklist

| Criterion | Result |
|---|---|
| Zero overlap while headless active | **Pass** — `noteHumanAttached()` throws `overlap`; competing-client hook refuses acquire/deliver |
| Pending mail survives human window | **Pass** — enqueue/`deliverIfOwned` while human/none → `queued`; zero transport deliveries until reacquire |
| Active turn / open server request | **Pass** — `releaseToHuman()` refuses with `active_turn` / `open_server_request` until drained |
| Exact-thread reacquire | **Pass** — `reacquireHeadless()` resumes recorded id; `transport.started` stays empty |
| Deliver once with stable IDs | **Pass** — drain delivers each pending batch once; duplicate batch id is a no-op accept |
| No implicit handoff on disconnect | **Pass** — `forceDisconnectWithoutHandoff()` → owner `none`, not `human` |
| Resume failure fails closed | **Pass** — no `thread/start` replacement |
| Fixture identity continuity | **Pass** — harness mail `#27982` queued across human window, drained after reacquire |

## How to reproduce

```bash
cd plugins/agent-mail-monitor
deno task test:codex
```

Suite total at close: **24/24** (8 integration + 3 S1 + 4 S0 harness + 9 S2b).

## State machine (spike)

```text
none ──acquireHeadless──▶ headless
headless ──releaseToHuman (after drain)──▶ none ──noteHumanAttached──▶ human
human ──noteHumanDetached──▶ none ──reacquireHeadless──▶ headless

Illegal: human attach while headless; deliver while not headless;
         release with active turn/open request; resume→replacement id;
         implicit owner flip on disconnect
```

## Implications for S5

`exclusive_handoff` remains the **smallest safe stock contender** under these spike proofs. Live App Server overlap still depends on S2a characterization (ChartreuseOx) for stock multi-client behavior; this spike proves the **repository-owned ownership policy** that must wrap any transport.

Production packaging of this policy is **C6** / **O5** after S5 selects the model — do not treat this spike module as the shipping adapter.
