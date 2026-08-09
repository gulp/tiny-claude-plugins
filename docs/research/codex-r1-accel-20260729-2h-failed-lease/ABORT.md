# R1-accelerated attempt aborted
- failed_at_utc: 2026-07-29T00:54:23Z (tick discovery) / AzureFalcon audit 00:53:29Z
- detail: lease expired (~20s TTL) — shadow loop did not renewLease
- compare at death: ok (1/1), deliveryCursor=0, modelCalls=0
- fix: packages/agent-mail-codex/src/verification/shadow.ts renews lease each leaseRenewSeconds
- preserved: this tree; not a gate pass
