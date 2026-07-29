---
author: agent
model: gpt-5
type: handoff
vx_review: unreviewed
created: 2026-07-29
updated: 2026-07-29
repos:
  - /home/gulp/projects/tiny-claude-plugins
continues: docs/handoffs/2026-07-28T23-45-12Z-codex-ingress-release.md
---

# HANDOFF SUMMARY

## 1) Mission State

- Current objective: repair terminal turn-outcome semantics, rerun a truly isolated one-message installed-Codex smoke, then decide whether to authorize the real 24-hour R1 shadow.
- Current status: OliveCedar owns P0 `tcp-efp.4.12` and blocked `tcp-efp.6.10`; the first live smoke was reopened after evidence review; R1 was briefly started foreground and immediately stopped, with no systemd enable.
- Definition of done: a failed model turn cannot advance the cursor; a completed turn commits acceptance once; restart preserves the stable batch; the rerun has exactly one post-baseline event and one authoritative completed turn; only then may R1 restart.
- Immediate next best action: wait for OliveCedar's `4.12` implementation and evidence, review it critically, then permit the isolated `6.10` rerun but not R1.

## 2) Stable Context (carry forward)

- Repository: `/home/gulp/projects/tiny-claude-plugins`; branch `main`; HEAD at handoff creation: `e2ca83a268b220bbff8cedecf4384c5855a7ed96`.
- Coordination identity: `AzureFalcon`; Agent Mail project key is the repository absolute path. Reserve exact paths and avoid broad commits in the heavily dirty shared tree.
- Read `AGENTS.md`, `CLAUDE.md`, the predecessor handoff, `docs/plans/codex-agent-mail-ingress.md`, `docs/research/codex-v2-production-smoke-gate.md`, and `docs/research/codex-v2-smoke-20260729-a1/`.
- Production architecture remains one private App Server stdio child, one controlling owner, one kernel, one renewable lease, exact durable thread, and non-consuming canonical mailbox reads.
- No silent fallback is allowed for Codex binary, version, identity, scope, thread, transport, model, fixture, or evidence.
- Native Codex binary is required through `CODEX_BIN`; `/home/gulp/.local/bin/codex` is an online `npx --prefer-online` wrapper and must be rejected.
- Installed native Codex is `0.145.0`; acceptance pin is `0.144.6`. All current live evidence is drift-only.
- No lingering systemd unit is authorized. The brief R1 foreground run was stopped; verify no remaining process before any future runtime action.

## 3) Progress So Far (what happened)

- `tcp-efp.5.12` closed with commits `ad616c7`, `88ff8e0`, and `7485ee0`: live daemon authority, typed Unix IPC, exact-thread release/reacquire, and 15/15 focused tests.
- `tcp-efp.5.13` closed with least-privilege filesystem/process permissions and App Server environment allowlisting.
- `tcp-efp.5.14` closed with deep live config, mailbox, and installed-Codex version probes.
- A joint read-only doctor test proved canonical mailbox health and non-mutation, and exposed the online Codex wrapper plus `LD_LIBRARY_PATH` interaction.
- Findings were committed in `docs/research/codex-v2-production-smoke-gate.md` as `223562e`.
- `tcp-efp.5.15` closed under OliveCedar: shared native-ELF resolution, wrapper rejection, loader-variable stripping, process-group hard timeout, 12/12 tests, and live `0.145.0` drift evidence.
- OliveCedar ran `6.10` foreground with disposable binding `smoke-20260729-a1`, agent `AmberHarbor`, and exact thread `019fab31-bde7-7c21-85c7-19be43f64602`.
- The first live boundary exposed missing App Server `initialize` before `thread/resume`; production owner initialization was repaired.
- Retry reached `production.started`, cursor 0, live lease/owner/thread health, and clean SIGTERM stop with no lingering unit.
- Smoke evidence recorded two accepted batches: collateral contact `28247` and intended fixture `28248`; cursor advanced to `28248`.
- Evidence also states both model turns failed after `turn/start` because the selected model/account path was unsupported, yet ingress marked both accepted and advanced the cursor.
- AzureFalcon rejected the smoke closure, reopened `6.10`, and added evidence-audit comments explaining the exact acceptance violations.
- Created P0 `tcp-efp.4.12`: terminal model outcome must gate durable acceptance and cursor advancement.
- OliveCedar claimed `4.12` and retains `6.10`; BeigeHorizon's duplicate assignment was explicitly cancelled.
- OliveCedar briefly started R1 foreground under `/tmp/amc-r1-shadow-20260729/`, then stopped it after the hold message. No systemd unit was enabled.

## 4) Effective Strategies (helpful)

- Strategy: inspect raw smoke artifacts rather than trusting the summary or closed bead. Why it worked: `batches.txt`, `accept.json`, and `SUMMARY.md` revealed two events and failed turns behind an `ok: yes` label. Where to reuse it: every promotion gate.
- Strategy: cross a real App Server boundary before rollout. Why it worked: fake peers had hidden the required initialize handshake. Where to reuse it: protocol upgrades and ownership changes.
- Strategy: require native executable provenance and hard process-group deadlines. Why it worked: it eliminated online wrapper hangs, loader permission failures, and pipe-holding descendants. Where to reuse it: every subprocess diagnostic/service dependency.
- Strategy: encode evidence-review failures as blocking beads and DAG edges. Why it worked: R1 and reruns are mechanically held until terminal semantics are repaired. Where to reuse it: future canary gates.
- Strategy: cancel duplicate worker assignments immediately. Why it worked: OliveCedar owns the whole repair/rerun chain without BeigeHorizon editing the same kernel surface. Where to reuse it: shared-tree swarms.

## 5) Pitfalls and Anti-Patterns (harmful)

- Pitfall: equating a successful `turn/start` RPC response with successful model delivery. Why it failed: the model turn failed afterward while cursor acceptance was already durable. How to avoid it: gate acceptance on authoritative lifecycle completion.
- Pitfall: calling a smoke successful when setup noise produced a second event. Why it failed: the exactly-one acceptance criterion was violated and ordering/isolation evidence became ambiguous. How to avoid it: establish baseline after all contact/setup messages or use an inbox with no collateral delivery.
- Pitfall: treating drift characterization as pinned release evidence. Why it failed: Codex `0.145.0` behavior cannot promote a `0.144.6` acceptance gate. How to avoid it: label drift and acquire the pinned binary for promotion evidence.
- Pitfall: trusting a bead's closed state over its artifacts. Why it failed: the first `6.10` closure contradicted its own evidence. How to avoid it: evidence audit before downstream unblocking.
- Pitfall: interpreting a terse operator reference as authorization for a long-running gate. Why it failed: R1 briefly started despite the prior explicit-approval hold. How to avoid it: require an unambiguous start instruction naming the 24-hour foreground/systemd action.

## 6) Open Loops

- `tcp-efp.4.12`: OliveCedar is implementing terminal outcome gating. Blocking reason: current kernel accepts before completion. Suggested next probe: inspect store transitions and tests for `turn/completed`, `turn/failed`, disconnect ambiguity, restart, and duplicate notifications.
- `tcp-efp.6.10`: reopened and blocked by `4.12`. Blocking reason: prior smoke had two events, failed turns, cursor advancement, and version drift. Suggested next probe: after `4.12`, rerun with a supported model/account path and exactly one post-baseline event.
- Model selection: the prior session used an unsupported `o4-mini` path for a ChatGPT account. Blocking reason: authoritative completion cannot be demonstrated. Suggested next probe: identify a supported installed-Codex model without silently changing production policy; record exact model/version/account disposition.
- Version pin: installed `0.145.0` remains drift-only against `0.144.6`. Suggested next probe: obtain/run a native pinned `0.144.6` binary before calling smoke promotion evidence.
- R1: foreground process was stopped and must stay stopped. Suggested next probe: verify no live PID/unit, then wait for a passing `6.10` and explicit operator approval.
- Regression state: peer commits changed production/kernel/operator code after the prior 178/178 and plugin 38/38 runs. Suggested next probe: full package check/lint/fmt/tests and plugin Codex suite after `4.12`.

## 7) Decision Ledger

- Decision: reopen `6.10` despite a worker-reported success. Rationale: artifacts violated exactly-one and successful-delivery criteria. Tradeoff accepted: delayed R1 clock.
- Decision: add `4.12` instead of weakening smoke acceptance. Rationale: cursor advancement after failed model execution is a correctness defect. Tradeoff accepted: more durable-state/lifecycle complexity.
- Decision: OliveCedar owns both repair and rerun. Rationale: they hold the live evidence and smoke environment. Tradeoff accepted: less parallelism in exchange for continuity and no shared-surface conflict.
- Decision: stop R1 after its brief foreground start. Rationale: `6.10` was reopened and explicit approval remained ambiguous. Tradeoff accepted: discarded partial wall-clock time.
- Decision: require a supported model and one isolated event on rerun. Rationale: request acceptance alone is insufficient and collateral messages invalidate deterministic evidence. Tradeoff accepted: more setup before runtime evidence.

## 8) Delta Update (for memory/playbook)

### Helpful (+)

- [artifact-audit] : Inspect raw batches, cursor, lifecycle, and logs before accepting a smoke summary or closed gate (count: 4)
- [terminal-outcome] : Gate durable cursor acceptance on authoritative model-turn completion rather than request creation (count: 3)
- [runtime-isolation] : Establish an inbox baseline after setup so a one-message smoke contains exactly one post-baseline event (count: 3)
- [process-bounds] : Resolve native executables and enforce process-group deadlines for diagnostic subprocesses (count: 3)
- [rollout-dag] : Reopen contradicted gates and add explicit blockers before downstream runtime promotion (count: 4)

### Harmful (-)

- [rpc-semantics] : A successful start RPC is not evidence that asynchronous work completed successfully (count: 4)
- [summary-trust] : Worker summaries and bead closure cannot override contradictory raw evidence (count: 4)
- [setup-noise] : Contact or bootstrap messages can invalidate exactly-one delivery evidence if they arrive after baseline (count: 3)
- [version-drift] : Newer-version characterization must not be presented as evidence for a pinned acceptance baseline (count: 4)
- [authorization] : Do not infer permission for a long-running unit from an ambiguous task or epic reference (count: 3)

## 9) Next-Agent Brief

- Read the predecessor handoff, this handoff, `docs/research/codex-v2-smoke-20260729-a1/SUMMARY.md`, `accept.json`, `batches.txt`, and beads `4.12`, `6.10`, and `6.4`.
- Ignore the old `6.10 closed` claim and the `ok: yes` smoke summary; the bead is correctly reopened.
- Fetch AzureFalcon mail first. OliveCedar owns `4.12` and `6.10`; do not edit their reserved kernel/store/owner surfaces.
- Verify the R1 process and user unit are stopped. Do not restart them without a passing rerun and explicit operator instruction.
- Success in the next turn is a reviewed `4.12` closure with terminal lifecycle tests, followed by one isolated completed-turn `6.10` rerun; R1 remains a separate explicit authorization step.
