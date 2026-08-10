# ultragoal: the Stop guard conscripts every session in the project dir

```
author: agent (claude-fable-5) · created: 2026-08-10 · status: fixed in 0.4.0
fix: arm writes session_id; guard no-ops for non-arming sessions (goal-stop-guard.sh); back-compat conscript-everyone; proven in test-guard-verdicts.sh
repro: sessions fe94f609 ("ultraralph") × the refinery vault session, 2026-08-10 ~17:29Z
```

## The bug

`goal-stop-guard.sh` keys entirely on `$CLAUDE_PROJECT_DIR/.claude/.ultragoal/`
— nothing in state.json records *which session* armed the goal, and the guard
never reads the Stop-hook stdin. Consequence, observed live: session A armed
the refinery goal in the vault; session B (fe94f609, parked in the same
project dir doing unrelated artifact work) had its every turn-end blocked with
A's marching orders, and each of B's blocked stops **burned the shared
`stop_attempts` budget** (2 of 8 spent before the sessions coordinated by
cross-session message; B's stops also stamped `last_fired_at`, muddying the
heartbeat). Under an 8-attempt cap, one chatty bystander session can expire
another session's goal.

## The fix (small, uses what 0.3.0 already established)

The blindspot pass (2026-08-10, docs-verified against Claude Code 2.1.226)
confirmed the Stop-hook stdin carries `session_id`. So:

1. `arm` (skill step 3) writes `session_id` into state.json.
2. The guard parses stdin's `session_id` (it currently drains stdin unread —
   `goal-stop-guard.sh:42`) and **no-ops (exit 0) for any session that didn't
   arm the goal**, before the heartbeat stamp.
3. Back-compat: a state.json without `session_id` (armed pre-fix) keeps the
   current conscript-everyone behavior — degrading open is the wrong
   direction for an enforcement tool, but silently disarming an in-flight
   goal on upgrade is worse; note it in the SKILL instead.

Open question for the doctor-verbs work: whether a *deliberate* multi-session
mode ("any session may finish the goal" — arguably useful for swarm setups)
deserves an opt-in flag, e.g. `"enforce": "arming-session" | "any"`. Default
must be `arming-session`.

## Also fold in

- `test-guard-verdicts.sh` gains a case: armed state with `session_id` X,
  stdin `{"session_id": "Y"}` → exit 0, no attempt increment, no heartbeat,
  no ledger entry.
- SKILL.md `status` verb: report whose goal it is.
