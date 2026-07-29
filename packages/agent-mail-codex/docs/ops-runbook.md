# Operations runbook — agent-mail-codex systemd user service (O3)

**Bead:** `tcp-efp.5.6`  
**Unit:** `agent-mail-codex@.service` (instance = binding id)  
**Package:** `packages/agent-mail-codex`

This runbook is the operator surface for process lifetime. The prior Claude
monitor died with its ephemeral tool host; production owns lifetime via a
**systemd user unit**. Kernel durability does **not** depend on an App Server
daemon.

## Paths (inspectable)

| What | Default path |
|---|---|
| Unit template | `~/.config/systemd/user/agent-mail-codex@.service` |
| Per-binding env | `~/.config/agent-mail-codex/<binding>.env` |
| Install manifest | `~/.config/agent-mail-codex/install-<binding>.manifest` |
| This runbook (installed copy) | `~/.config/agent-mail-codex/ops-runbook.md` |
| Package lib (ExecStart root) | `~/.local/lib/agent-mail-codex` |
| SQLite state | value of `statePath` in config (recommend `~/.local/state/agent-mail-codex/<binding>/state.sqlite3`) |
| Runtime snapshot | `<stateParent>/runtime/<binding>.json` |
| Owner-state dir | `<stateParent>/owner-state/` |
| Mailbox (read-only) | `~/.mcp_agent_mail_git_mailbox_repo` (`AGENT_MAIL_MAILBOX_ROOT`) |
| Journal logs | `journalctl --user -u agent-mail-codex@<binding>.service` |

Exact owner / thread / state for a live process:

```bash
systemctl --user status agent-mail-codex@<binding>.service
cat "${XDG_STATE_HOME:-$HOME/.local/state}/agent-mail-codex/<binding>/runtime/<binding>.json"
deno run --allow-read --allow-env packages/agent-mail-codex/src/cli.ts \
  status --config ~/.config/agent-mail-codex/config.json --binding <binding> --json
deno run --allow-read --allow-env packages/agent-mail-codex/src/cli.ts \
  doctor --config ~/.config/agent-mail-codex/config.json --binding <binding>
```

The runtime snapshot fields `threadId`, `owner`, `statePath`, `ownerStateDir`,
and `mailboxRoot` are the authoritative on-disk inspection surface while the
unit is active.

## Install

From the package checkout:

```bash
cd packages/agent-mail-codex
# Write a real config first (see examples/config.systemd.example.json).
./deploy/install-user-unit.sh \
  --binding example-project \
  --config "$HOME/.config/agent-mail-codex/config.json"
```

Survive logout and reboot:

```bash
loginctl enable-linger "$USER"
systemctl --user enable --now agent-mail-codex@example-project.service
```

`--start` on the install script enables and starts in one step after doctor is green.

## Health checks

1. **Unit active:** `systemctl --user is-active agent-mail-codex@<binding>.service`
2. **Doctor (read-only):** `… doctor --config … --binding …` — must PASS config/binding/paths
3. **Status JSON:** `… status --config … --binding … --json` — names binding + flags
4. **Runtime file:** `heartbeatAt` advances roughly every 5s while the lease is held
5. **Lease exclusivity:** starting a second supervisor for the same binding must fail loud

Unhealthy states are never silent green: unit inactive, doctor FAIL, missing
runtime file, or stale `heartbeatAt` (>20s) all require operator action.

## Restart / upgrade

```bash
# Bounce after config edit
systemctl --user restart agent-mail-codex@<binding>.service

# Upgrade package bits then restart (install re-syncs lib)
./deploy/install-user-unit.sh --binding <binding> --config <abs-config>
systemctl --user restart agent-mail-codex@<binding>.service
```

Crash restart is bounded: `Restart=on-failure` with `RestartSec=5`,
`StartLimitBurst=5` / `StartLimitIntervalSec=120`. A crash loop trips the start
limit; clear with `systemctl --user reset-failed agent-mail-codex@<binding>.service`
after fixing the cause.

## Recovery

| Symptom | Action |
|---|---|
| Unit dead / inactive | `systemctl --user start agent-mail-codex@<binding>.service` |
| Crash loop (start limit) | Read journal; fix config/state; `reset-failed`; start |
| Lease held / second instance | Stop the other unit or wait TTL (20s); never force two writers |
| Stale runtime heartbeat | Restart unit; if lease wedged, stop unit, wait 20s, start |
| Wrong thread / owner | Use O5 `binding release-owner` / `acquire-owner`; do not edit SQLite by hand |
| Mailbox missing | Restore `AGENT_MAIL_MAILBOX_ROOT`; unit only needs read access |
| After reboot, unit missing | Confirm `loginctl show-user $USER -p Linger`; re-enable unit |

App Server / Codex being down must **not** be treated as a reason to tear down
state. Stop delivery if needed, keep the unit's state directory intact, and
re-attach ownership explicitly.

## Uninstall (reversible)

```bash
./deploy/uninstall-user-unit.sh --binding <binding>
# Keeps ~/.local/state/agent-mail-codex/<binding> and the env file by default.
```

Destructive options (explicit):

```bash
./deploy/uninstall-user-unit.sh --binding <binding> --purge-config
./deploy/uninstall-user-unit.sh --binding <binding> --purge-state
./deploy/uninstall-user-unit.sh --binding <binding> --purge-lib
```

Re-install with the same `--config` restores the unit without rewriting state
unless you purged it.

## R1 shadow mode (24h observation)

Delivery stays off. The same unit runs observation + Claude-monitor cursor
compare; it does not attach Codex or advance the delivery cursor.

1. In `~/.config/agent-mail-codex/<binding>.env` set:
   - `CODEX_INGRESS_SHADOW=1`
   - leave `CODEX_INGRESS_ENABLED` unset or `false`
2. Keep the Claude monitor armed for the same agent + project.
3. `systemctl --user restart agent-mail-codex@<binding>.service`
4. Gate artifact: `<stateParent>/shadow/<binding>.json` (also see
   `docs/research/codex-r1-shadow-gate.md`).
5. After 24h, confirm artifact `ok: true`, empty missed/extra/wrong-scope/
   malformedSilent, `modelCalls: 0`, `deliveryCursor: 0`.
6. Rollback: unset `CODEX_INGRESS_SHADOW`, restart; Claude monitor unchanged.

## Security / privilege notes (tcp-efp.5.13)

- Supervisor requests **mailbox read** and **state write** only; project trees
  are not in `ReadWritePaths` and are never in Deno `--allow-write`.
- `ProtectSystem=strict` + `ProtectHome=read-only` with explicit binds.
- **No bare `--allow-read` / `--allow-write`.** The ExecStart wrapper
  (`deploy/agent-mail-codex-run.sh`) runs `permissions --shell` to compute
  path-scoped Deno flags from the binding config, then `exec`s with those
  flags only.
- Inspect effective permissions:
  ```bash
  # CODEX_BIN must be a native ELF — never $(command -v codex) when that is an npx wrapper.
  CODEX_BIN=/usr/bin/codex AGENT_MAIL_CODEX_ROOT=~/.local/lib/agent-mail-codex \
    deno run --allow-read --allow-env ~/.local/lib/agent-mail-codex/src/cli.ts \
    permissions --config ~/.config/agent-mail-codex/config.json --binding <binding> --json
  ```
- **tcp-efp.5.15:** `CODEX_BIN` is required and must be a canonical native ELF.
  Package-manager wrappers (`npx --prefer-online`, `npm exec`, …) are rejected
  with `CODEX_BIN_WRAPPER_REJECTED`. Doctor/service share
  `resolveNativeCodexBin` + a hard process-group version-probe deadline that
  clears `LD_*` injection vars.
- Private App Server child env is an **allowlist** (`APP_SERVER_ENV_ALLOWLIST`
  in `src/operator/service_permissions.ts`): HOME/XDG/PATH/locale, Codex auth
  keys, TLS trust vars. Unrelated secrets (`AWS_*`, `GITHUB_TOKEN`,
  `ANTHROPIC_*`, Agent Mail bearer tokens, `LD_*`) are never inherited.
- Permission computation rejects relative paths, `..` segments, and missing
  required paths (config, package, mailbox, project cwd, codex binary).
- Do not widen the unit to write the git checkout.
- Mail content remains untrusted; this unit does not approve side effects.

## Related surfaces

- O1 doctor/status contracts: `src/operator/status.ts`
- O5 ownership commands: `binding release-owner` / `acquire-owner`
- K3 production composition: `src/kernel/production.ts` (delivery attach)
- R1 shadow harness: `src/verification/shadow.ts`
- Threat model: `docs/research/codex-ingress-threat-model.md`
