# O7: Production Codex plugin and skills control surface

**Bead:** `tcp-efp.5.10`  
**Control API:** `packages/agent-mail-codex/src/operator/control.ts`  
**Plugin CLI:** `plugins/agent-mail-monitor/scripts/codex-control.ts`  
**Skill:** `plugins/agent-mail-monitor/skills/agent-mail-codex/`

## What landed

A Codex-native operational surface over the production ingress (O1/O3/O4/O5/O6),
kept thin: skills call one control API; the API emits exact commands and fails
closed on version/cache drift.

| Action | Behavior |
|---|---|
| `doctor` | transport, version, identity, inbox, ownership, daemon, notification |
| `start` / `stop` | systemd user unit commands; identity required; no silent agent pick |
| `status` / `inspect` | runtime snapshot + binding/thread/owner/state paths |
| `handoff` / `acquire` | require `--confirm`; emit O5 binding commands |
| `recovery-preview` | points at O4 confirm-gated mutations |

## Cachebuster

`.codex-plugin/plugin.json` `version` is the cache key segment under
`~/.codex/plugins/cache/tiny-claude-plugins/agent-mail-monitor/<version>/`.

`PLUGIN_IDENTITY.expectedVersion` in the control API **must** match the
manifest. Drift codes:

- `version_drift` — source tree version mismatch
- `stale_cache` — cached install version/root mismatch

Remediation is always: bump cachebuster → reinstall exact version. No scope or
cache-directory fallback.

## Install (local)

```bash
# From repo (Codex personal/project marketplace already lists this plugin)
# After version bump, reinstall so the new cache key is used.
```

Do **not** use `codex://` marketplace URLs for delivery.

## Smoke tests

```bash
cd packages/agent-mail-codex && deno test --allow-read --allow-write --allow-env tests/o7_control_surface_test.ts
cd plugins/agent-mail-monitor && deno test --allow-read --allow-write tests/codex-o7-smoke.test.ts
```

Covers fresh install version match, reinstall cache key, rollback/stale-cache
refusal, and skill/script presence beside the tracer skill.

## Privilege

Control/doctor paths do not request network or `dangerously*` permissions.
Supervisor remains mailbox-read + state-write only (O3).
