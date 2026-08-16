---
name: diagnose-agent-mail-service
description: >-
  Diagnose a suspected Agent Mail server wedge — the process is alive and holds
  :8765 but HTTP is unresponsive — using probes in the order a wedge cannot fool,
  then route to recovery. Use when the Agent Mail server seems stuck, `am status`
  hangs or times out, mail stops flowing, an agent reports the inbox is
  unreachable, or you need to tell "wedged" from "dead" from "just slow" — "agent
  mail is hung", "am status hangs", "is the mail server wedged", "diagnose agent
  mail".
allowed-tools: Bash(systemctl:*) Bash(ss:*) Bash(curl:*) Bash(am:*) Bash(journalctl:*) Bash(find:*) Read
metadata:
  argument-hint: "[--unit <name>] [--agent <name>]"
  arguments: "unit, agent"
---

# Diagnose the Agent Mail service

Decide which of four states the `mcp-agent-mail` systemd user service is in, using
probes ordered so **one hang cannot blind the rest**, and route to the right
recovery:

| State | Signature | Recovery |
|---|---|---|
| **HEALTHY** | unit active · port held by Main PID · HTTP answers fast · DB reads | none |
| **WEDGED** | unit active · port held by Main PID · **HTTP unresponsive** (process alive) | `systemctl --user restart` (clean) |
| **DEAD** | unit inactive/failed, or `:8765` unbound | `systemctl --user start` |
| **ORPHAN** | `:8765` held by a pid ≠ the unit's Main PID | kill the orphan, then restart |
| **DEGRADED** | server answers, but the corrupt archive repo WARNs every tick | separate, human-run archive repair |

## The one trap this skill exists to prevent

**Never diagnose liveness with `am status` (or `am robot status`).** Measured on a
*healthy* server, `am status` takes **1.3s–15.8s** (it aliases to `robot status`
and does heavy health synthesis). A short timeout on it therefore **false-positives
a wedge** — this is exactly how the 2026-07-24 incident was first *mis*-diagnosed
("unit inactive, orphan holds the port" — all three claims were wrong). The server
was `active`, the port-holder **was** its Main PID, and `am status` was merely slow.

The correct fast probes:

| Probe | Healthy latency | Role |
|---|---|---|
| `curl --max-time 5 http://127.0.0.1:8765/mcp/` → any code (405 typical) | **~0.3ms** | **HTTP liveness** — the decisive wedge detector; `000`/timeout = truly wedged |
| `am robot inbox --agent <name> --unread` | **~0.15s** | **local-DB read** — returns even under WAL contention |
| `systemctl --user status <unit>` | instant | **authoritative** — managed? active? Main PID? (beats `ss`/`pgrep`, which can't tell managed-from-orphan) |
| `am status` / `am robot status` | **1.3–15.8s** | ❌ dashboard, **not** a liveness probe |
| `curl --max-time 5 http://127.0.0.1:8765/healthz` → header `x-agent-mail-health: 1` | **0.03–0.2s** | **HTTP liveness**, equivalent to `/mcp/` and self-labelling |
| `curl … /health` | 0.14s warm, **8s+ for minutes after contention** | ❌ *readiness* — does full project + message counts |
| `curl … /mail/health` | — | ❌ **always 404**; `/mail/<X>` routes as *project* `X` |

## Before you diagnose: are you the load?

A concurrent per-agent fan-out wedges this daemon. Measured 2026-08-16: a sweep
of 70 agents' inboxes 8-at-a-time drove `/healthz` from 0.03s to 8s timeouts
within seconds, and **stopping the load recovered it in under 30s with no
restart.** So stop your own sweeps and pollers (including any browser tab whose
UI polls a health endpoint), wait passively, and only then run this skill. A
restart of a shared service that was about to recover costs every other session
on the box its in-flight work.

Two corollaries worth carrying: a **404 is not a wedge signal** (a prior session
watched `/mail/health` 404 for ~40 minutes against an already-recovered server —
a wedge is `000`/timeout), and a client that gives `/health` the same timeout
budget as `/healthz` will report `degraded` against a perfectly healthy server.
Longer write-up, with the client-side design consequence:
`~/shower-thoughts/agent-mail-web-ui/CLAUDE.md`.

## Inputs
- `$unit` (optional): systemd user unit — default `mcp-agent-mail.service`.
- `$agent` (optional): agent name for the local-DB read — defaults to
  `$AGENT_NAME` / `$AGENT_MAIL_AGENT`.

## Goal
A correct VERDICT (HEALTHY / WEDGED / DEAD / ORPHAN / DEGRADED) grounded in the
probe outputs, and — when it is not HEALTHY — the specific recovery command, with
mutations (restart, archive repair) flagged for human confirmation.

## Steps

### 1. Run the read-only diagnosis
```bash
"${CLAUDE_PLUGIN_ROOT}"/skills/diagnose-agent-mail-service/scripts/diagnose.sh [--unit <name>] [--agent <name>]
```
It probes systemd → port holder → HTTP (curl) → local-DB read → archive hygiene,
in that order, and prints one `[PASS]/[WARN]/[FAIL]` line per probe, then a
`VERDICT <state> — <recovery>` line and a `SUMMARY`. It is **read-only** — it never
restarts or repairs.

**Success criteria**: the script exits and prints a `VERDICT` line. Exit codes:
`0` HEALTHY · `1` DEGRADED · `2` WEDGED/DEAD/ORPHAN · `64` usage.
**Rules**: read the `VERDICT`, not any single probe — a `[FAIL] http` alone is a
wedge only when `systemd`/`port` show the process is alive and Main-PID-owned. If
`local-db` also warns of a name, pass `--agent <name>`.

### 2. Interpret the verdict against the probe lines
- **HEALTHY** → done. (Confirm you weren't misled by a slow `am status` elsewhere.)
- **WEDGED** → the process is alive and Main-PID-owns the port, but HTTP didn't
  answer in 5s. Restart is clean (no orphan). See Step 3.
- **DEAD** → unit not active or port unbound → `systemctl --user start`.
- **ORPHAN** → a non-managed pid holds `:8765`; a plain restart will `EADDRINUSE`.
  Kill the orphan first (Step 3).
- **DEGRADED** → server answers, but the `archive` probe found empty git objects.
  This is **not** a wedge and a restart does **not** fix it — it is a separate,
  human-run repair (Step 3).

**Success criteria**: you can state the state and cite the two or three probe
lines that justify it (not `am status`).

### 3. Route to recovery — confirm mutations first
The recoveries are in `resources/recovery.md` (Read it for the exact commands).
Every one mutates shared state that other agents depend on — **confirm with the
human before running**, and prefer the server's own managed path:
- WEDGED → `systemctl --user restart mcp-agent-mail.service`, then re-run Step 1
  (expect HEALTHY).
- DEAD → `systemctl --user start …`.
- ORPHAN → `ss -ltnp | grep 8765` to find the pid, `kill <pid>`, then restart.
- DEGRADED (corrupt archive) → **human-run from a plain terminal** (the repair uses
  `find … -delete` under `/home`, which the agent guard blocks): stop the unit,
  `find .git/objects -type f -empty -delete && git fsck --full` in
  `~/.mcp_agent_mail_git_mailbox_repo`, start the unit.

**Success criteria**: after a WEDGED restart, `diagnose.sh` re-reports HEALTHY
(curl answers fast); a DEAD start binds `:8765` to the new Main PID.
**Human checkpoint**: never restart/kill/repair a shared service without the human
saying go — other sessions are on the same server.
**Rules**: the corrupt-archive repair is **separate** from the wedge fix — a
restart clears a wedge but leaves the archive corruption (and its every-tick WARN)
untouched.

## Notes
- **Companion:** the durable auto-recovery for a wedge is a liveness-based systemd
  watchdog (health `.timer` probing the **HTTP** path — curl, never `am status` —
  plus a memory cap). The unit's stock `Restart=on-failure` cannot catch a wedge:
  a hung-but-alive process never exits, so systemd never restarts it. That watchdog
  is tracked separately; this skill is the human-in-the-loop diagnosis half.
- **Why probes are ordered, not parallel:** systemd is authoritative and instant;
  the port check is instant; the HTTP curl is capped at 5s; the DB read at 6s. Each
  is independent, so a wedge (HTTP hang) cannot prevent the systemd/port/DB probes
  from telling you the process is alive and where — the exact information the
  first mis-diagnosis lacked.
