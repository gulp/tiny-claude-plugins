# R1 gate — 24-hour shadow deployment

**Bead:** `tcp-efp.6.4`  
**Package:** `packages/agent-mail-codex`  
**Harness:** `src/verification/shadow.ts`  
**Tests:** `tests/r1_shadow_test.ts`

## Goal

Run one binding with durable observation and batching but **no Codex
delivery**. Compare the shadow frontier to the existing Claude monitor’s
canonical-mailbox view for 24 hours.

## Constraints (from plan)

- `codex_ingress.enabled=false` (delivery flag off).
- Existing Claude monitor remains authoritative and unchanged.
- Zero missed, extra, malformed-silent, or wrong-scope events.
- State and metrics stay within V1 targets.
- Do not advance the delivery cursor via `acceptBatch` / `startTurn`.

## What “compare with Claude” means

Both surfaces read the same non-consuming git mailbox. The R1 oracle is a
second independent `MailboxSource.readAfter` over the same agent/project
scope (the Claude monitor’s source of truth). Shadow must observe exactly
the same valid message IDs and record the same malformed skips.

| Failure class | Detection |
|---|---|
| Missed | ID in reference set, absent from shadow |
| Extra | ID in shadow set, absent from reference |
| Wrong-scope | Observed event `projectSlug` ≠ binding slug |
| Malformed-silent | Reference reported skip; shadow did not record `skip:…` |

## CI vs operational 24h

- **CI** (`deno test tests/r1_shadow_test.ts`): compressed observation,
  lease refusal, malformed recording, delivery-cursor invariant, artifact
  shape.
- **Operational 24h:** run the shadow observer under the O3 user unit with
  delivery disabled; write `encodeShadowGateArtifact` output once per hour
  and at stop; Claude monitor stays live on the same identity.

## Promotion checklist

- [ ] O3 user unit installed; doctor PASS; runtime heartbeat advancing
- [ ] `CODEX_INGRESS_ENABLED=false` (or unset) confirmed in env / doctor
- [ ] Shadow observer holds the binding lease (or shares the O3 supervisor
      process — never a second exclusive owner beside delivery)
- [ ] Claude monitor watching the same `AGENT_NAME` + project
- [ ] 24h elapsed with every hourly artifact `ok: true`
- [ ] Final artifact: `missedIds=[]`, `extraIds=[]`, `wrongScopeIds=[]`,
      `malformedSilent=[]`, `modelCalls=0`, `deliveryCursor=0`
- [ ] V1 resource/coalescing targets still green on the same binding
- [ ] Rollback drill: stop shadow unit; Claude monitor unaffected; state
      dir retained

## Non-goals

- Idle Codex wake (that is R2).
- Urgent steer, multi-binding expansion, or default-on.
- Consuming `am check-inbox` / mutating `read_ts`.
