---
title: Codex same-thread heartbeat reliability boundary
vx_review: unreviewed
source: https://chatgpt.com/c/6a692efb-af50-83ed-8bac-cff3707b055e
---

# Codex same-thread heartbeat reliability boundary

## Decision

ChatGPT web or Desktop scheduled tasks are not the delivery transport for Codex
Agent Mail ingress. The production path remains an event-driven supervisor that
owns a persistent Codex App Server connection and targets one durable thread.

A host-scheduled heartbeat may be offered later as an optional liveness reminder.
It cannot advance the mailbox cursor, acknowledge delivery, recover an App
Server binding, or substitute for the supervisor.

## Verified boundary

- Codex goals provide persisted goal state and automatic continuation when a
  thread becomes idle. They do not provide delayed or periodic scheduling.
  This is visible in the open-source `on_thread_idle` path ending in
  `try_start_turn_if_idle`.
- Codex CLI and IDE do not expose the Scheduled management surface described for
  ChatGPT web and Desktop.
- App Server accepts experimental client-supplied `dynamicTools`.
  `automation_update` is not a built-in App Server scheduling method; its
  occurrence in the open-source tree is a dynamic-tool search test fixture.
- The installed Codex CLI 0.145.0 has no schedule, automation, or heartbeat
  command.
- A report in OpenAI Codex issue
  [#35601](https://github.com/openai/codex/issues/35601#issuecomment-5091382120)
  describes a Desktop UI workaround that produced an automation with
  `kind="heartbeat"` and `target_thread_id`, observed at a 15-minute cadence.
  This is a reproduced reporter observation, not a supported public creation
  contract.

## Unresolved public contract

No public source establishes:

- a supported `automation_update` schema for creating a same-thread heartbeat;
- reliable targeting of a thread created by CLI or App Server;
- a supported seven-minute cadence;
- missed-run, overlap, restart, archival, or host-offline semantics; or
- a CLI-visible lifecycle for inspecting, updating, and deleting the heartbeat.

These unknowns are fail-closed for production architecture. A fluent dynamic
tool description or Desktop artifact is not treated as an API guarantee.

## Operational consequence

```text
canonical Agent Mail inbox
        │
        ▼
durable filesystem watcher
        │
        ▼
persistent ingress supervisor
        │
        ▼
private, sole-owner App Server connection
        │
        ├── idle thread  → turn/start
        └── active turn → deterministic queue or guarded turn/steer
```

The supervisor owns detection, durable cursor/outbox state, retries, request
handling, and visible failures. Scheduled tasks cannot be promoted into this
path without a separately versioned public contract and an acceptance spike
covering exact-thread targeting, offline recovery, overlap, and deletion.

## Local verification

The following checks ground the conclusion:

```bash
codex --version
codex features list
codex --help
rg -n 'on_thread_idle|try_start_turn_if_idle|automatic goal continuation' \
  codex-rs/ext/goal/src codex-rs/features/src
rg -n 'dynamicTools|automation_update' \
  codex-rs/app-server-protocol/src codex-rs/app-server/src codex-rs/core/src/tools
gh api repos/openai/codex/issues/comments/5091382120
```

The Codex source was inspected from the `opensrc fetch openai/codex` checkout.
The local checkout represented current upstream source rather than a
cryptographically pinned 0.145.0 tag, so exact-tag source equivalence remains
unclaimed.

## Connections

- supports: [Event-driven Codex ingress plan](../plans/codex-agent-mail-ingress.md)
- constrains: human-visible notification and plugin surfaces must not advertise
  scheduled heartbeats as durable ingress
- related: [Codex monitor shape research](../research/gpt-codex-monitor-shape.md)

