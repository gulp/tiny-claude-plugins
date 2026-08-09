# agent-mail-codex

Production Codex Agent Mail ingress package.

This is **not** the Claude `agent-mail-monitor` plugin. It does not read `MAIL_WATCH_*`. Delivery
remains gated by `CODEX_INGRESS_ENABLED` (default off).

```bash
cd packages/agent-mail-codex
deno task test
deno task cli -- doctor --config examples/config.example.json --binding example-project
```

## R1 shadow (no Codex delivery)

```bash
# Delivery must stay off. Compares observed IDs to a second mailbox scan.
CODEX_INGRESS_ENABLED=false deno task cli -- run \
  --config examples/config.example.json \
  --binding example-project \
  --shadow
# or: CODEX_INGRESS_SHADOW=1 … run --config … --binding …
```

Gate notes: [`docs/research/codex-r1-shadow-gate.md`](../../docs/research/codex-r1-shadow-gate.md).
Artifact: `<stateParent>/shadow/<binding>.json`.

## Systemd (O3)

See `deploy/` + `docs/ops-runbook.md`. For a 24h shadow unit, set `CODEX_INGRESS_SHADOW=1` in the
per-binding env file (and keep `CODEX_INGRESS_ENABLED` unset/false).

Ownership defaults follow S5: `explicit-handoff` + `headless-app-server-owner`.

Domain types live in `src/schemas/mod.ts`. Durable state: `src/store/`. Burst batcher:
`src/batcher/mod.ts`. Shadow observer: `src/verification/shadow.ts`.

Security review (V3): `docs/v3-security-review.md`. E2E acceptance (V2): `src/verify/acceptance.ts`.
Load harness (V1): `src/verification/load_harness.ts`.
