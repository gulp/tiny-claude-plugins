---
name: doctor
description: >
  Health check for the ultraralph rung: is the ultraloop engine on PATH,
  and is an escalation record going stale in the seam directory? Use for
  /ultraralph:doctor, "can this repo escalate", or "is anything waiting to
  be picked up". Read-only.
license: MIT
metadata:
  author: gulp
  version: "0.1.1"
allowed-tools:
  - Bash(python3 *)
  - Read
---

# ultraralph doctor

Run `"${CLAUDE_PLUGIN_ROOT}/scripts/ultraralph-doctor.sh"` and print its
output verbatim. **Exit 1 means it found issues — that is the finding, not
a broken command.**

What it checks (the suite convention: doctor for presence, files for
seams — never imports):

- **engine** — `ultraloop` on PATH and its version. A bare `ralph` binary
  is a WARN, not a pass: a dozen third-party tools ship that name and the
  rename cascade has landed, so it is presumptively not the engine.
  Missing engine → the expiry path ends at a saved record; the skills
  never fall back to an inline loop.
- **seam** — `.claude/ultra/escalations/` record count and the newest
  record's age. A week-old escalation nobody picked up is the seam's one
  silent failure mode; this is where it becomes loud.

If the doctor flags a stale record, offer the obvious next step:
`/ultraralph:vanilla start @<that record>`.
