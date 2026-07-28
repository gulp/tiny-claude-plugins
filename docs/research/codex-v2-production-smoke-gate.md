# tcp-efp.6.10 — installed-Codex one-message production smoke

**Bead:** `tcp-efp.6.10` (prep only — **do not close** until `5.12` lands)  
**Blocks:** `tcp-efp.6.4` (R1)  
**Prepared by:** OliveCedar (AzureFalcon #28209)  
**Host probe (prep time):** `codex-cli 0.145.0` on PATH (`~/.local/bin/codex`)

## Goal

Cross the **real installed Codex** boundary once: disposable binding, private App
Server, one post-baseline fixture message → exactly one accepted stable batch on
the configured durable thread → clean stop. No lingering unit.

## Hard constraints

- Disposable identity / state / thread only.
- Bounded timeout and model spend (recommend ≤ 1 turn, ≤ 3 min wall, abort hard).
- No fallback, replacement thread, competing owner, body logging, or cursor loss.
- **Do not** leave `agent-mail-codex@*.service` enabled/lingering after the run.
- Evidence must be operator-visible files under a disposable evidence dir.

## Prerequisites (must be true before execute)

| Gate | Status at prep |
|---|---|
| `tcp-efp.5.11` live doctor/status | **Closed** — usable for before/after |
| `tcp-efp.5.12` live ownership handoff | **In progress** — Unix-socket CLI landed; production daemon host still blocks execute |
| `tcp-efp.5.13` least-privilege unit/env | **Closed** |
| `tcp-efp.5.14` deep live probes | **Closed** — Codex drift/config/mailbox checks landed |
| Codex pin vs host | **Contradiction** — acceptance baseline `0.144.6`; host has `0.145.0` (C10 treats newer as drift-only). Resolve before treating smoke as promotion evidence. |

## Versions to record (fill at execute)

```text
codex_cli:            _______________   (`codex --version`)
acceptance_baseline:  0.144.6           (packages/.../protocol_compat.ts)
disposition:          accept | drift-only | reject
plugin_cachebuster:   _______________   (O7 PLUGIN_IDENTITY / manifest)
ingress_schema:       1
store_schema:         _______________   (from doctor version check)
os/arch:              _______________
git_sha:              _______________
operator:             _______________
started_at_utc:       _______________
finished_at_utc:      _______________
```

## Disposable setup

1. **Binding id:** `smoke-<YYYYMMDD>-<short>` (no path separators).
2. **Agent:** fresh AdjectiveNoun registered only for this smoke (or existing disposable).
3. **State root:** `/tmp/amc-smoke-<id>/` — `state.sqlite3`, `runtime/`, `owner-state/`, `evidence/`.
4. **Config:** absolute JSON under that root; `codex.threadId` set to a **pre-created** durable thread the operator owns exclusively for this run.
5. **Flags:** `CODEX_INGRESS_ENABLED=true` only for the smoke window; unset/false immediately after stop.
6. **Mailbox:** real `AGENT_MAIL_MAILBOX_ROOT`; project scope = absolute project path.

## Operator checklist (execute order)

### A. Preflight (no delivery)

- [ ] `5.12` and `5.13` closed (or explicit waiver recorded).
- [ ] Version contradiction resolved or marked `drift-only` with human accept.
- [ ] `deno task cli -- doctor --config <abs> --binding <id>` → record full human output → `evidence/doctor-before.txt`
- [ ] `deno task cli -- status --config <abs> --binding <id> --json` → `evidence/status-before.json`
- [ ] Confirm doctor does **not** create missing SQLite / consume inbox (5.11 invariant).
- [ ] Confirm no other `agent-mail-codex@*` / App Server client on the thread.

### B. Start (bounded)

- [ ] Prefer **foreground** `agent-mail-codex run --config … --binding …` under `timeout` **or** `systemctl --user start` only if immediately followed by disable/stop (no linger enable).
- [ ] Commands + PIDs + timestamps → `evidence/start.log`
- [ ] Re-run `status --json` → `evidence/status-running.json` (lease live, owner headless, thread exact).

### C. Baseline + fixture

- [ ] Capture baseline cursor from status (`cursor` / `CURSOR_OK` detail).
- [ ] Inject **one** post-baseline Agent Mail message to the disposable agent in this project (non-consuming write to canonical mailbox / send_message).
- [ ] Record `message_id`, `created_ts`, subject (no body in logs) → `evidence/fixture.json`

### D. Observe acceptance

- [ ] Wait bounded for exactly **one** accepted batch (`batch:<binding>:<first>-<last>`).
- [ ] Record `batch_id`, `turn_id`, `thread_id`, `event_ids`, timestamps → `evidence/accept.json`
- [ ] Assert: no second batch, no thread id change, no competing owner, cursor advanced to fixture id only.

### E. After + stop

- [ ] `status --json` / doctor → `evidence/status-after.json`, `evidence/doctor-after.txt`
- [ ] Stop process / `systemctl --user stop …`; **disable** if enabled; confirm no linger unit for smoke id.
- [ ] Final status may show `LEASE_MISSING` / owner unknown — expected when daemon stopped; record as stop proof, not as green idle.
- [ ] Confirm SQLite cursor retained (no reset); outbox retained; no body fields in journal/JSONL.

### F. Rollback / cleanup

- [ ] `CODEX_INGRESS_ENABLED=false` (or unset).
- [ ] Delete `/tmp/amc-smoke-<id>/` only after evidence copied to durable location.
- [ ] Optional: unregister disposable agent / leave mailbox artifacts for audit.

## Evidence template (single summary)

Write `evidence/SUMMARY.md`:

```markdown
# 6.10 smoke summary
- ok: yes|no
- codex: …
- baseline_disposition: accept|drift-only|reject
- binding / agent / thread / project:
- fixture message_id:
- accepted batch_id / turn_id:
- cursor before → after:
- status healthy before/running/after:
- fallback_used: no
- competing_owner: no
- lingering_unit: no
- notes:
```

## Artifact paths (canonical)

```text
/tmp/amc-smoke-<id>/evidence/
  SUMMARY.md
  versions.txt
  doctor-before.txt
  doctor-after.txt
  status-before.json
  status-running.json
  status-after.json
  start.log
  fixture.json
  accept.json
  journal-excerpt.txt   # optional, redacted
```

## Read-only runtime preflight — 2026-07-29

This preflight was run together with the operator. It did not start App Server,
enable delivery, create SQLite state, or install/enable a user unit.

### Commands and observations

1. `codex --version` through `/home/gulp/.local/bin/codex` did not return within
   ten seconds and was interrupted. That path is a Bash wrapper which runs:

   ```text
   npx --yes --prefer-online --package @openai/codex -- true
   ```

   Under restricted networking, even a version query can therefore block on
   package resolution. Do not use this wrapper for bounded daemon preflight.

2. The already-installed native binary resolved to:

   ```text
   /home/gulp/.npm/_npx/c8ab89660c602c20/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
   ```

   Direct output:

   ```text
   codex-cli 0.145.0
   ```

3. The first path-scoped Deno run inherited `LD_LIBRARY_PATH`. Deno refused the
   version subprocess rather than weakening `--allow-run`:

   ```text
   VERSION_PROBE_FAILED: Requires --allow-run permissions to spawn subprocess
   with LD_LIBRARY_PATH environment variable.
   ```

   Re-running with `LD_LIBRARY_PATH` unset matched the hardened service policy
   and completed immediately.

4. Successful read-only doctor invocation:

   ```bash
   env -u LD_LIBRARY_PATH \
     CODEX_BIN=/home/gulp/.npm/_npx/c8ab89660c602c20/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
     deno run --allow-read --allow-env \
       --allow-run=/home/gulp/.npm/_npx/c8ab89660c602c20/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
       packages/agent-mail-codex/src/cli.ts doctor \
       --config packages/agent-mail-codex/examples/config.example.json \
       --binding example-project
   ```

### Measured result

- `CONFIG_OK`: example binding parsed; no runtime snapshot existed.
- `MAILBOX_OK`: the canonical CobaltJaguar inbox was readable and passed the
  bounded layout scan (`scanned<=64`).
- `STORE_UNREADABLE`, `LEASE_STATE_UNKNOWN`, `OWNER_STATE_UNKNOWN`,
  `CURSOR_STATE_UNKNOWN`, and `QUEUE_STATE_UNKNOWN`: expected for the disposable
  absent `/tmp/agent-mail-codex-example.sqlite3`.
- `THREAD_OK`: configured thread was `thread-example`.
- `VERSION_DRIFT`: observed `0.145.0`; acceptance baseline `0.144.6`; evidence is
  drift-only.
- `Delivery flag: disabled (safe default)`.
- A final filesystem check confirmed `state file remains absent`.

### Operational conclusion

- Read-only doctor/status works without mutation when `CODEX_BIN` names a
  resolved native binary and loader injection variables are absent.
- The current user-facing `codex` wrapper is unsuitable for bounded service
  startup or diagnostics because it performs online package resolution.
- `CODEX_BIN` must be canonicalized and validated before the real smoke. The
  smoke may characterize `0.145.0`, but it cannot count as `0.144.6` promotion
  evidence.

## Fresh-eyes on `tcp-efp.5.11` (live status) — historical gaps / resolution

Reviewed `src/operator/live_status.ts` + `tests/o1_live_status_test.ts` (read-only).

**Strengths**
- Probes are read-only; missing store does not create SQLite.
- Lease liveness uses SQLite expiry (not stale runtime heartbeat alone).
- Actionable codes for missing inbox, schema mismatch, expired lease, thread mismatch, dead letters.
- Cursor surfaces `CURSOR_NOT_BASELINED` vs `CURSOR_OK`.

**Resolved by `tcp-efp.5.14`**
1. The version probe measures the real/injected Codex CLI and emits `VERSION_OK`, `VERSION_DRIFT`, `VERSION_UNSUPPORTED`, or `VERSION_PROBE_FAILED`.
2. Config/runtime consistency emits explicit mismatch/path/adapter codes.
3. Mailbox probing checks `projects/` layout and bounded non-consuming readability.

**Remaining notes for 6.10**
4. **Stopped daemon looks unhealthy.** `LEASE_MISSING` after clean stop is expected; checklist must not require post-stop `healthy: true`.
5. **Owner `human` from JSON alone can be `OWNER_OK`.** Live daemon authority still depends on `5.12` — do not treat owner-state file as proof App Server closed.
6. **Product scope unsupported** (`TypeError`) — smoke must use project scope.
7. **Runtime snapshot mismatch** only affects owner classification; no dedicated `RUNTIME_STALE` code when lease live but heartbeat old (by design; document in evidence).

## Explicit non-goals for this prep

- Do not execute production delivery or install a lingering unit (AzureFalcon #28209).
- Do not close `tcp-efp.6.10`.
- Do not edit files reserved by BeigeHorizon for `5.12`.
