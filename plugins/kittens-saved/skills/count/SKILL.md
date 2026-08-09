---
name: count
description: >
  Show the kittens-saved tally — how many kittens were saved (work done instead
  of punted), how many escape hatches were granted vs denied, and how many items
  are waiting on the human. Use when the user asks "how many kittens saved",
  "kitten count", "kittens-saved stats", "show the kitten tally", or runs
  count.
argument-hint: "[--scope session|all]"
allowed-tools: Bash(python3:*)
disable-model-invocation: true
---

# kittens-saved:count

Show the tally. Run the bundled script and print its output verbatim — do not
reinterpret the numbers:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" count $ARGUMENTS
```

`$ARGUMENTS` may be empty (uses the plugin's `scope` setting — session or all),
or `--scope session` / `--scope all` to override for this call. The `session`
scope also shows items still waiting on the human and any the agent still owes.
