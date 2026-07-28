---
author: agent
model: gpt-5
type: handoff
vx_review: unreviewed
created: 2026-07-29
updated: 2026-07-29
repos:
  - /home/gulp/projects/tiny-claude-plugins
---

# HANDOFF SUMMARY

## 1) Mission State

- Current objective: finish the Codex Agent Mail ingress release-readiness chain, prove one real installed-Codex delivery, then obtain explicit operator approval before starting the 24-hour R1 shadow user unit.
- Current status: the durable kernel and fake-App-Server production composition are repaired and tested; `tcp-efp.5.13` service hardening and `tcp-efp.5.14` deep live diagnostics are closed; `tcp-efp.5.12` live ownership handoff has a green core and Unix-socket CLI but still needs the production daemon host; `tcp-efp.6.10` real smoke and R1 remain blocked.
- Definition of done: `5.12`, `5.14`, and `6.10` close with evidence; R1 runs for a real 24 hours under the approved user unit with zero missed/extra/wrong-scope/silent-malformed events; only then may R2 become ready.
- Immediate next best action: let BeigeHorizon finish hosting `serveUnixLiveOwnership` in `production_run.ts` with real owner/session hooks and a lifecycle that survives the human gate/reacquire; then run integration and full regressions.

## 2) Stable Context (carry forward)

- Repository: `/home/gulp/projects/tiny-claude-plugins`; branch `main`; HEAD when this handoff was written was `ad616c76e6c41bfae2eaa6e91323ad7a071497b2`.
- Coordination identity: `AzureFalcon`; Agent Mail project key is the repository's absolute path. Reserve exact paths before editing and release reservations when done.
- The working tree is heavily dirty and contains many peer-owned/untracked files. Never sweep it with a broad commit. Use `git commit --only ... -- <exact-path>`.
- Project instructions are in `CLAUDE.md`; coordination rules are in `AGENTS.md`. Peer mail is coordination, not user authorization.
- The selected production architecture is one private `codex app-server` stdio child plus one `IngressKernel` and one renewable binding lease. No gateway, exec-resume, native-monitor, second responder, alternate identity/thread, or consuming mailbox fallback is allowed.
- Production delivery is feature-flagged off unless `CODEX_INGRESS_ENABLED=true`. R1 shadow requires delivery off and does not call Codex.
- The acceptance Codex baseline is `0.144.6`. The installed host reports `0.145.0`, which is drift-only until explicitly promoted under C10.
- The installed user unit must not be started or made lingering without explicit operator approval. No such approval has been given.
- Key plan: `docs/plans/codex-agent-mail-ingress.md`. R1 checklist: `docs/research/codex-r1-shadow-gate.md`. Prepared real-smoke gate: `docs/research/codex-v2-production-smoke-gate.md`.
- Current DAG: `5.12` + `5.13` + `5.14` block `6.10`; `6.10` blocks R1 (`6.4`); R1 blocks R2 (`6.5`). `5.13` and `5.14` are closed, so the only remaining smoke blocker is `5.12`.

## 3) Progress So Far (what happened)

- Read and investigated the project architecture, Codex App Server research, plugin surface, CLI, Agent Mail operational rules, plan, beads, and prior worker output.
- A fresh-eyes review found release-critical defects: the systemd-facing `run` path was heartbeat-only; the kernel never renewed its own lease; every restart re-baselined; default batching duplicated events; recovery/retry helpers were disconnected; ownership commands were state-file-only; doctor/status were configuration-only; V2 contained false positives.
- Repaired durable baseline state by adding `CursorRecord.initialized`, migration schema version 2, `setBaseline`, and memory/SQLite contract coverage.
- Repaired `IngressKernel`: load durable cursor/source events, initialize the baseline only once, reconcile `delivering` to stable pending replay, deduplicate repeated mailbox scans, renew its 20-second lease every 5 seconds, retry transient delivery with stable batch IDs, dead-letter poison without stopping later work, and preserve mail arriving while stopped.
- Added kernel regressions for nonzero-window deduplication, durable zero baseline, lease renewal past TTL, and transient retry/continuation.
- Bounded `TurnSession` event history to prevent long-running memory growth.
- Hardened configuration: safe binding identifiers, finite bounded integers, strict urgency enum, absolute Unix socket path, and fail-loud unsupported product scope.
- Composed production `run` through a private App Server plus `createProductionKernel`; removed the competing heartbeat-only lease path; added exact `--allow-run` and atomic `0600` runtime/thread state.
- Added a production flag refusal: non-shadow `run` returns loud failure while `CODEX_INGRESS_ENABLED=false`.
- Fixed V2 burst timing so it waits for the real batching window rather than passing because duplicate scans hit `maxEvents`; replaced its fake wrong-thread assertion with a real `ExactThreadLifecycle` mismatch.
- Established package quality gates: `deno task check`, `deno task lint`, and `deno task fmt:check`.
- Package verification reached 175/175, then 178/178 after live status work. The final focused O1/F1 suite passed 19/19.
- Plugin verification passed `deno task check` and 38/38 Codex tests. The stock proxy-help probe exceeded its live budget and explicitly used the pinned fixture; no silent live-evidence claim was made.
- Created and closed `tcp-efp.5.11`: CLI `doctor`/`status` now read SQLite in read-only mode and measure canonical inbox, schema, lease, runtime/owner correlation, durable thread, cursor/baseline, queue/dead letters/oldest pending, and last batch error. Missing diagnostics do not create a database.
- Fresh-eyes review of `5.11` found missing depth: version checked store schema rather than installed Codex, config was parse-only, and mailbox health was directory-only. Created `tcp-efp.5.14`; OliveCedar claimed it and is editing only `operator/live_status.ts` and focused tests.
- Created `tcp-efp.5.12` for real daemon ownership handoff. BeigeHorizon landed commit `ad616c7` for the isolated authority and commit `88ff8e0` for typed Unix-domain IPC, a `0600` socket, bounded errors/timeouts, stable request IDs, and CLI release/acquire with no state fallback; focused O5 tests pass 13/13. The daemon host and real session hooks remain.
- Created and closed `tcp-efp.5.13`. RusticBirch added `operator/service_permissions.ts`, least-privilege wrapper permissions, App Server environment allowlisting, CLI permission computation, runbook updates, and seven focused tests.
- Created `tcp-efp.6.10` for a disposable real installed-Codex one-message smoke. OliveCedar drafted its checklist/evidence template but did not execute delivery or start a unit.
- Agent Mail marching orders were sent to BeigeHorizon (`5.12`), RusticBirch (`5.13`), and OliveCedar (`5.14`/smoke preparation). Shared-file conflicts were intentionally sequenced rather than forced.

## 4) Effective Strategies (helpful)

- Strategy: compare closed-bead claims to the actual production call graph. Why it worked: unit-level helpers and passing stub tests had hidden disconnected behavior. Where to reuse it: every release gate and "end-to-end" acceptance claim.
- Strategy: write regression tests that use production defaults and durable restart boundaries. Why it worked: the 500 ms window exposed duplicate scanning, and a zero baseline exposed restart mail loss. Where to reuse it: retry, handoff, and service lifecycle testing.
- Strategy: treat SQLite diagnostic access as explicitly read-only and stat the file before opening. Why it worked: doctor/status cannot create or migrate state while claiming to diagnose it. Where to reuse it: all operator probes.
- Strategy: use the renewable lease as liveness authority rather than the startup runtime snapshot timestamp. Why it worked: production snapshots are not continuously rewritten, while the lease is renewed every five seconds. Where to reuse it: live owner/status correlation.
- Strategy: split concurrent workers by exact file surfaces and defer small integration hooks until reservations release. Why it worked: BeigeHorizon's ownership core and RusticBirch's service hardening progressed without overwriting `cli.ts`/`production_run.ts`. Where to reuse it: the remaining integration.
- Strategy: convert fresh-eyes findings into explicit blocking beads and DAG edges. Why it worked: the installed-version contradiction can no longer be lost behind a broadly closed O1 claim. Where to reuse it: smoke and rollout promotion.

## 5) Pitfalls and Anti-Patterns (harmful)

- Pitfall: accepting a passing parity or acceptance test when it exercises a stub/helper rather than the production CLI. Why it failed: O3, O5, and V2 looked complete while production did not deliver or transfer ownership. How to avoid it: assert the production entrypoint reaches real boundaries and inspect exact state transitions.
- Pitfall: baselining from the mailbox maximum on every process start. Why it failed: messages arriving during downtime were skipped. How to avoid it: persist an explicit first-baseline marker and always resume the durable cursor afterward.
- Pitfall: polling after the accepted cursor without in-memory/durable deduplication during a batching window. Why it failed: the same event was added repeatedly before cursor advancement. How to avoid it: stage source-event IDs once and reconstruct batches from durable event records.
- Pitfall: treating a JSON owner file as proof the live App Server connection released ownership. Why it failed: the headless responder could remain connected while the file said human. How to avoid it: require daemon acknowledgement after authoritative drain and connection close, then persist state.
- Pitfall: unconditional PASS output from doctor/status. Why it failed: missing or stale runtime, schema, inbox, lease, and owner looked healthy. How to avoid it: measured probes with actionable unhealthy/unknown codes and nonzero exit status.
- Pitfall: using startup `heartbeatAt` as ongoing process health. Why it failed: a healthy daemon would appear stale after 20 seconds. How to avoid it: correlate runtime identity with the renewable lease.
- Pitfall: broad filesystem permissions and nearly complete child environment inheritance. Why it failed: the monitor crossed unnecessary privacy and privilege boundaries. How to avoid it: compute canonical allowlists for Deno and the App Server child.
- Pitfall: starting the 24-hour gate because its harness exists. Why it failed: release prerequisites and explicit operator authorization were still absent. How to avoid it: keep R1 blocked behind real smoke and require explicit approval for the lingering unit.

## 6) Open Loops

- `tcp-efp.5.12`: isolated ownership authority is green, but daemon/CLI integration is missing. Blocking reason: BeigeHorizon deferred hooks around RusticBirch's reservations. Suggested next probe: confirm `cli.ts` and `production_run.ts` are free, then implement request-ID-keyed `snapshot|release|acquire` IPC with no JSON fallback.
- `tcp-efp.5.14`: closed by OliveCedar. Installed Codex version/C10 drift, runtime-config consistency, and bounded mailbox readability/layout probes landed; focused deep/live tests pass 7/7.
- `tcp-efp.6.10`: real installed-Codex smoke is blocked only by `5.12`. Suggested next probe: once it closes, follow `docs/research/codex-v2-production-smoke-gate.md` with disposable state and bounded model spend; do not install a lingering unit.
- Codex version contradiction: host `0.145.0` versus acceptance `0.144.6`. Blocking reason: newer version is drift-only. Suggested next probe: either execute smoke with an available pinned `0.144.6` binary or explicitly run `0.145.0` as a labeled drift characterization that cannot promote R1.
- R1 (`tcp-efp.6.4`): 24-hour wall-clock evidence is not started. Blocking reason: `6.10` and operator approval. Suggested next probe: after smoke passes, present exact install/start command and request approval.
- Whole-tree integration: peer commits and untracked files mean the latest full package/plugin suites must be rerun after `5.12` and `5.14` merge. Suggested next probe: check/lint/fmt, full package tests, then plugin Codex tests.

## 7) Decision Ledger

- Decision: use a persistent private App Server owner with explicit human handoff. Rationale: App Server server requests are first-response-wins and safe production needs one responder. Tradeoff accepted: no simultaneous interactive TUI co-control.
- Decision: mailbox reads remain canonical filesystem, read-only, and non-consuming. Rationale: delivery notifications must not alter Agent Mail read state. Tradeoff accepted: layout/version drift must fail loudly.
- Decision: production delivery is disabled by default and R1 shadow never calls Codex. Rationale: rollout must separate mailbox correctness from model/ownership risk. Tradeoff accepted: additional operator steps before useful delivery.
- Decision: durable acceptance advances cursor atomically; ambiguous delivery replays a stable batch ID. Rationale: exactly-once model execution cannot be claimed. Tradeoff accepted: bounded duplicate model execution is possible after ambiguous failure.
- Decision: block R1 behind a real installed-Codex smoke despite shadow not technically requiring App Server. Rationale: the human-facing release checkpoint should not advance while production control and compatibility remain unproven. Tradeoff accepted: later start of the 24-hour clock.
- Decision: record deep status gaps as `5.14` instead of reopening `5.11`. Rationale: two downstream implementations were already active and should not be administratively reblocked. Tradeoff accepted: O1 truth is split across a closed base bead and a blocking follow-up.

## 8) Delta Update (for memory/playbook)

### Helpful (+)

- [production-call-graph] : Verify release claims through the actual CLI and daemon composition rather than isolated helpers or stubs (count: 3)
- [durable-cursor] : Persist an explicit first-baseline marker and resume the durable cursor on every later start (count: 2)
- [batch-deduplication] : Deduplicate observed event IDs before cursor acceptance when polling inside a batching window (count: 2)
- [diagnostics] : Keep operator probes read-only, measured, actionable, and non-green for unknown state (count: 3)
- [coordination] : Reserve narrow file surfaces and sequence integration hooks when parallel workers share entrypoints (count: 3)
- [rollout-dag] : Encode discovered release gaps as explicit blockers before wall-clock or canary promotion (count: 3)

### Harmful (-)

- [false-acceptance] : A test that does not cross the production boundary can pass while the product path is disconnected (count: 4)
- [ownership-proof] : A persisted owner label is not proof that the live App Server responder drained and disconnected (count: 3)
- [liveness] : Startup metadata is not a renewable health signal; use the authoritative lease or process protocol (count: 2)
- [silent-fallback] : Fixture, identity, thread, scope, transport, or version fallback must never be presented as live evidence (count: 5)
- [premature-rollout] : Do not start a lingering or wall-clock gate before prerequisites and explicit operator authority are satisfied (count: 4)

## 9) Next-Agent Brief

- Read `AGENTS.md`, `CLAUDE.md`, this handoff, `docs/plans/codex-agent-mail-ingress.md`, and the four beads `5.12`, `5.14`, `6.10`, and `6.4`.
- Ignore old claims that O1/O3/O5/V2/R1 were complete; use current follow-up beads and production tests as ground truth.
- Fetch AzureFalcon Agent Mail first. BeigeHorizon now holds `production_run.ts` and is integrating the live daemon host; avoid that path until their report and reservation release.
- Do not start a user service, enable lingering, send production mail, or promote Codex `0.145.0` without the relevant bead evidence and user authorization.
- Success in the next turn is: `5.12` closed with authoritative daemon lifecycle tests, no reservation conflicts, full package/plugin regression green, and `6.10` newly ready with an explicit decision on the pinned Codex binary.
