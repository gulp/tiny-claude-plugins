---
name: kittens-saved
description: >
  User-ops entry point for the kittens-saved plugin — inspect and repair, don't
  mutate the ledger. Dispatches to status (is enforcement live + this session's
  tally), stats (session vs project totals), doctor (health + config check, with
  --fix), and config (effective settings and how to change them). Use when the
  user runs /kittens-saved:kittens-saved, or asks "kitten status", "kitten
  stats", "kittens doctor", "check the kittens plugin", "is kittens enforcing",
  "kitten config". For saving a kitten or the escape hatch use
  /kittens-saved:counting-saved-kittens; to silence a session use
  /kittens-saved:toggle.
argument-hint: "[status|stats|doctor|config|denylist|zen] [--fix] [--json]"
allowed-tools: Bash(python3:*)
disable-model-invocation: true
---

# kittens-saved:kittens-saved

The read/repair front door for the plugin. Run the bundled script with the
requested action and **print its output verbatim** — do not reinterpret the
numbers or the findings:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" $ARGUMENTS
```

`$ARGUMENTS` is one of the ops subcommands (default to `status` when none is
given, and infer from prose — "how are the kittens" → `status`, "why is the
reminder off" → `doctor`, "kitten totals" → `stats`, "what's the scope set to"
→ `config`):

- **`status`** — is enforcement actually live this session (global `enabled` ∧
  not per-session-muted), plus saved / waiting-on-you / still-yours.
- **`stats`** — this session's total and this project's total (every ledger in
  the project). Box-level (all projects) is deliberately not tracked.
- **`doctor`** — checks the state dir is writable and gitignored and reports the
  effective config. `doctor --fix` applies only repairs the plugin owns (adds
  the ephemeral ledger dir to `.gitignore`); it never edits settings files.
- **`config`** — the effective `enabled` / `scope` / `debug` and where each
  resolved from, plus how to change them (`/plugin configure`).

Each subcommand takes `--json` for machine-readable output; run
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/kittens.py" <action> --help` for its
flags rather than restating them here.

**Exit codes** (surface, don't hide): `doctor` returns **1** when it found
issues — that is the finding, not a broken command; report what it printed.
**3** is an environment failure (state dir unwritable). **2** is a usage error.
All other subcommands return **0**.

This skill is **read/repair only** — it never records a kitten or takes the
escape hatch. Those mutate the ledger and live in
`/kittens-saved:counting-saved-kittens`.
