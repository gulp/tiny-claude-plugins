---
name: bypass
description: >
  The human key around the ultragoal gate. Use only when the user
  explicitly asks /ultragoal:bypass or "bypass the goal" — sets
  status: bypassed so the Stop guard stands down, with an honest audit
  trail. Never invoke this on your own initiative to escape enforcement.
license: MIT
metadata:
  author: gulp
  version: "0.5.0"
allowed-tools:
  - Bash(python3 *)
  - Read
---

# ultragoal bypass

Set `status: bypassed` in
`$CLAUDE_PROJECT_DIR/.claude/.ultragoal/state.json` — the guard stands down
and the audit trail reads "bypassed".

## Rules

- **Human-initiated only.** This verb exists so the human is never hostage
  to the gate. It is not an agent escape hatch: if you are the one blocked,
  the marching orders are the work — do them. Invoking bypass because the
  checks are hard defeats the plugin's entire contract.
- If the armed goal belongs to a different session (state.json `session_id`
  ≠ `$CLAUDE_CODE_SESSION_ID`), say so before writing — bypassing someone
  else's goal is a cross-session action the human should confirm knowingly.
- Preserve every other field; change only `status`. Atomic write (write a
  temp file in the same directory, then rename) — a corrupted state.json
  silently disarms the goal, which is worse than either verdict.
- Report the bypass loudly: plan path, how many attempts were spent, and
  that the audit trail now reads `bypassed`.
