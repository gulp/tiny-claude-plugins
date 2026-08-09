# S3 evidence: `codex exec resume` degraded single-owner baseline (tcp-efp.1.6)

**Agent:** WindyCedar  
**Date:** 2026-07-28  
**Codex CLI examined:** `codex-cli 0.145.0` (`codex exec resume <SESSION_ID> [PROMPT]`)  
**Spike code:** `tests/codex-s3-exec-resume.ts` + `tests/codex-s3-exec-resume.test.ts`  
**Constraint:** exact thread only; never auto-fallback from App Server; no replacement thread on failure

## Verdict for S5

**Go as explicitly degraded comparison contender only. No-go as production default or automatic fallback.**

`exec resume` can wake a known durable session when serialized, but it is strictly weaker than the private-stdio App Server tracer (S1) + exclusive handoff (S2b): process-per-event overhead, no active-turn steer, ambiguous failure codes, and no long-lived request ownership.

## Acceptance checklist

| Criterion | Result |
|---|---|
| Exact-thread targeting | **Pass** — every invocation uses the bound thread id |
| Latency recorded | **Pass** — fake-path p50≈6ms / p95≈7ms (n=11); live model+session cost excluded |
| Thread continuity | **Pass** — same id across sequential resumes |
| Concurrent-turn behavior | **Pass** — owner mutex forces `maxConcurrent === 1`; intervals do not overlap |
| Process lifetime | **Pass** — distinct pid per successful event |
| Ambiguity after failure | **Pass** — missing-thread and forced-fail both surface as `resume_failed`; operator cannot safely distinguish without richer stderr |
| No new thread on failure | **Pass** — failure keeps the recorded id; no `start` path exists on this adapter |
| Limitations explicit | See below |

## Limitations (must stay in ADR)

1. **Not an automatic fallback** when App Server dies (plan no-silent-fallback #1).
2. **Cannot steer** an in-flight interactive turn; only serialized post-hoc resumes.
3. **Process-per-event** — cold start / session load on every mail batch.
4. **Ambiguous failures** — missing rollout vs config can share exit semantics; must fail closed, never `thread/start`.
5. **May not equal live TUI identity** — exec sessions can diverge from Desktop/TUI threads.
6. **No server-request ownership** — elicitation/approvals are not mediated by this shim.

## How to reproduce

```bash
cd plugins/agent-mail-monitor
deno task test:codex
```

Suite at close: **31/31** (prior S0/S1/S2b + 7 S3 tests).

## CLI surface pinned

```text
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
  --last          newest session without an id (FORBIDDEN for this contender)
  --json          JSONL events on stdout
```

Ingress must always pass an explicit durable session/thread id. `--last` is incompatible with binding identity.
