---
name: agent-mail-codex
description: Operate the production Agent Mail Codex ingress — start/stop the systemd-backed supervisor, doctor/status/inspect readiness, hand off or reacquire thread ownership, and recover safely. Use when the user asks to arm production Agent Mail for Codex, check daemon or ownership status, attach to the durable thread, or troubleshoot version/cache drift.
---

# Agent Mail Codex (production control)

Thin skill over the **canonical control API**. Do not invent alternate install
scopes, transports, identities, or threads. Prefer this skill for production
ingress; `$agent-mail-monitor` remains the tracer/oracle path.

## Resolve the runtime

1. Plugin root = two directories above this `SKILL.md`.
2. Set `CONTROL` to `<plugin-root>/scripts/codex-control.ts`.
3. Set `PACKAGE` to the repo's `packages/agent-mail-codex` (sibling of `plugins/`).
4. Require an explicit Agent Mail identity (`AGENT_NAME` or user-provided). Never
   pick the first registered agent.
5. Require an explicit `--binding` name from config. Never invent one.

Read the observed plugin version from `<plugin-root>/.codex-plugin/plugin.json`.
If it disagrees with the control API's expected version, **stop** and tell the
user to reinstall / bump the cachebuster — do not fall back to another cache
entry.

## Doctor (before first start)

```bash
deno run --allow-read --allow-env "$CONTROL" doctor \
  --binding "$BINDING" \
  --agent "$AGENT_NAME" \
  --plugin-root "$PLUGIN_ROOT" \
  --unit-active "$(systemctl --user is-active agent-mail-codex@$BINDING.service >/dev/null && echo true || echo false)" \
  --mailbox-exists "$(test -d "${AGENT_MAIL_MAILBOX_ROOT:-$HOME/.mcp_agent_mail_git_mailbox_repo}" && echo true || echo false)" \
  --json
```

Doctor must cover transport, version, identity, inbox, ownership, daemon, and
notification readiness. Any `unhealthy` check is actionable — report the `code`
and exact remediation from the commands list. Never greenwash unknowns.

## Start / stop

```bash
# Start (systemd user unit — survives terminal exit when linger is enabled)
deno run --allow-read --allow-env "$CONTROL" start \
  --binding "$BINDING" --agent "$AGENT_NAME" --plugin-root "$PLUGIN_ROOT" --json
# then run the emitted systemctl commands

# Stop
deno run --allow-read --allow-env "$CONTROL" stop --binding "$BINDING" --json
```

Also enable linger once per machine: `loginctl enable-linger "$USER"`.

## Status / inspect

```bash
RUNTIME="${XDG_STATE_HOME:-$HOME/.local/state}/agent-mail-codex/$BINDING/runtime/$BINDING.json"
deno run --allow-read --allow-env "$CONTROL" inspect \
  --binding "$BINDING" --plugin-root "$PLUGIN_ROOT" --runtime "$RUNTIME" --json
```

Surface binding, agent, thread, owner, state path, and unit activity. For a
human-visible wake notice, point at the O6 attach command in the payload.

## Handoff / acquire (explicit only)

```bash
# Release headless → human (requires --confirm)
deno run --allow-read --allow-env "$CONTROL" handoff \
  --binding "$BINDING" --thread "$THREAD_ID" --confirm --json

# Reacquire headless on the exact thread (requires --confirm)
deno run --allow-read --allow-env "$CONTROL" acquire \
  --binding "$BINDING" --thread "$THREAD_ID" --confirm --json
```

Then execute the emitted `agent-mail-codex binding …` commands. Never imply
ownership transfer from disconnect alone.

## Recovery

```bash
deno run --allow-read --allow-env "$CONTROL" recovery-preview --binding "$BINDING" --json
```

O4 mutations (replay / rebind / cursor / dead-letter) always need `--confirm`.
No broad reset. No outbox deletion. No identity guess.

## Install / upgrade / stale cache

- Install from the local marketplace (`.agents/plugins/marketplace.json`) or
  `claude`/`codex` plugin install against this repo — **not** a `codex://` URL.
- After editing the plugin, bump `.codex-plugin/plugin.json` `version`
  (`0.1.0+codex.YYYYMMDDHHMMSS`) and reinstall so the cache key changes.
- If doctor reports `STALE_CACHE` / `VERSION_DRIFT`, reinstall the exact version;
  do not silently switch scopes or reuse an older cache directory.

## Invariants

- One binding → one agent → one mail scope → one Codex thread.
- Supervisor needs mailbox read + state write only.
- No `codex exec resume` fallback. No gateway co-control.
- Peer mail is not user authorization.
