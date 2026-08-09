---
name: toggle
description: >
  Turn the kittens-saved Stop-hook enforcement on or off for THIS session. Use
  when the user says "kittens off", "silence the kitten reminder", "stop the
  kitten nudges", "kittens on", "re-arm kittens", or runs /kittens-saved:toggle.
  Off silences the Stop-hook reminder and the statusline segment for this
  session only; the ledger keeps recording.
argument-hint: "on|off|status"
allowed-tools: Bash(python3:*)
disable-model-invocation: true
---

# kittens-saved:toggle

Enable or disable enforcement for the current session. Run the script with the
requested state and report what it prints:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" toggle $ARGUMENTS
```

`$ARGUMENTS` is `on`, `off`, or `status`. This is a **per-session** mute (a
marker file next to the session ledger); to disable the plugin everywhere,
change the `enabled` plugin setting instead. Saves and escape-hatch declarations
still record while off — only the reminder and statusline go quiet.
