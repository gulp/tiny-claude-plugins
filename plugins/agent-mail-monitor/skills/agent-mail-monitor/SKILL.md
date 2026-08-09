---
name: agent-mail-monitor
description: Start, resume, or diagnose a non-consuming Agent Mail monitor that wakes a durable Codex App Server thread. Use when the user asks to monitor Agent Mail in Codex, arm an agent identity, wake Codex on mail, check monitor readiness, or troubleshoot Codex Agent Mail ingress.
---

# Agent Mail Monitor

Operate the plugin's `scripts/codex-monitor.ts`. The watcher reads Agent Mail's canonical
git-mailbox and never calls `fetch_inbox`; a newly awakened Codex turn may use Agent Mail MCP tools
to inspect and act on delivery.

## Resolve the runtime

Derive the plugin root from this loaded `SKILL.md`: it is two directories above this skill
directory. Set `SCRIPT` to `<plugin-root>/scripts/codex-monitor.ts`. Never guess a cache path.

Require an explicit Agent Mail identity from the user, `AGENT_NAME`, or established session context.
Use the repository root as `--project`; do not silently substitute an unrelated working directory.

## Diagnose

Before the first start, or when asked to troubleshoot, run:

```bash
deno run --allow-env --allow-read --allow-run "$SCRIPT" doctor \
  --agent "$AGENT_NAME" --project "$PROJECT_ROOT"
```

Report every error. Do not fall back from a missing canonical inbox to `am inbox` or `fetch_inbox`,
because those paths can consume read state.

## Start

Run the watcher in a user-visible terminal or persistent process host:

```bash
deno run --allow-env --allow-read --allow-run "$SCRIPT" monitor \
  --agent "$AGENT_NAME" --project "$PROJECT_ROOT"
```

The command baselines existing mail, prints the created thread ID, and issues no model turns while
the inbox is quiet. Keep the process attached unless the user explicitly asks for background
operation and provides an approved process host.

To resume an exact durable thread, add `--thread THREAD_ID`. A resume failure is fatal; never create
a replacement thread silently. To replay deliveries after a known message, add `--since ID`.

## Invariants

- Monitoring is read-only and non-consuming.
- One App Server process owns one durable target thread.
- Turns are serialized; mail arriving while busy is delivered after completion.
- Invalid identity, project, inbox, thread, or App Server state fails loudly.
- `am` and Agent Mail MCP remain the action surface; the monitor is only ingress.

## Production control

For the systemd-backed production ingress (start/stop/doctor/inspect/handoff),
use `$agent-mail-codex` and `scripts/codex-control.ts`. This skill stays the
tracer/oracle path and must not be attached beside an interactive client.
