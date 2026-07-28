# Codex App Server protocol baseline

Production acceptance is pinned to Codex CLI/App Server `0.144.6`. The runtime
diagnostic records the observed Codex version, App Server protocol version,
daemon version, plugin version, and ingress schema version.

Compatibility policy:

- Exactly `0.144.6`, with every required method and matching component/schema
  versions, is acceptance evidence.
- A newer Codex version is a `drift_probe`. Its results stay separate and do not
  promote the baseline or enable production delivery.
- Older or malformed versions, missing capabilities, daemon/plugin skew, and
  schema skew are unsupported and stop startup with explicit reasons.
- There is no auto-update, implicit version promotion, or fallback transport.
- Unknown server requests are handled by C2: return JSON-RPC `-32601`, then mark
  the binding unhealthy.

The executable policy and compatibility fixtures are
`src/owner/protocol_compat.ts` and `tests/c10_protocol_compat_test.ts`.
