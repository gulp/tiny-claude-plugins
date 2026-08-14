---
type: Plan
title: cwd-scope-guard — make Bash cwd ephemeral like the rest of shell state
description: A PreToolUse hook that wraps any command containing a top-level cd in a subshell, closing the one piece of shell state that silently persists between Bash calls.
status: draft
execution: not-started
generated: { by: claude-opus-5, at: 2026-08-14T11:48:47Z }
stale_after: 2026-09-14
sources:
  - id: session
    resource: /home/gulp/.claude/projects/-home-gulp-Vaults-everything/f07b7d24-962a-41dc-b5fc-499db1f8b699.jsonl
    session_id: f07b7d24-962a-41dc-b5fc-499db1f8b699
    title: Originating session transcript
extraction: { count: 1, mode: auto }
---

# Implementation Plan — cwd-scope-guard

**Finding:** `cwd` is the only piece of shell state that survives between Bash tool calls — exports and variable assignments do not (probed live: `export CWDPROBE=…` in one call reads `UNSET` in the next, while `cd` persisted three times in this session alone). The drift is a symptom of that one inconsistency, not of agent carelessness.
**Change:** Proposed — a `PreToolUse` Bash hook that wraps any command containing a top-level `cd` in `( )`, making cwd ephemeral like everything else.

Owner: gulp
Repo: /home/gulp/projects/tiny-claude-plugins
Files changed: none yet — plan only, gated on §1

This is the drift-instrument decision tracked as task **#91**. Recommended over the
warn-on-drift design originally sketched there, which is a proxy for the hazard rather
than the hazard itself and fires on legitimate states.

This file is a `clip-this` capture: everything above the horizontal rule below is the
session transcript **verbatim**; everything after it is newly written.

This is the finding that reframes the whole problem:

**Env vars do not persist across Bash calls. `cwd` does.**

`cwd` is the *only* piece of shell state that survives between calls, and it survives silently. Everything else — exports, variables, functions — is correctly ephemeral. So this isn't "an agent keeps making a mistake." It's one inconsistency in the harness's state model, and the drift is its symptom.

That changes what a good fix looks like. Don't instrument the hidden state — **make `cwd` behave like everything else.**

## The design: one transformation

> If a command contains a top-level `cd`, wrap the entire command in `( )`.

`cd X && cmd` → `(cd X && cmd)`. Verified today: a subshell `cd` does not leak, a bare one does.

The reason this is safe rather than clever: a subshell discards cwd changes, env changes, and variable assignments — and **the last two already don't survive a Bash call anyway**. So the wrap is a no-op for everything that persists and eliminates the one thing that shouldn't. It's not suppressing a capability; it's closing an inconsistency.

It also doesn't need to find *where* the `cd` is or reason about what to wrap. Wrapping the whole command preserves all internal structure exactly.

## Decision table

| shape | verdict |
|---|---|
| top-level `cd`/`pushd` anywhere in the command | **rewrite** — wrap whole command in `( )`, disclosed in `permissionDecisionReason` |
| bare `cd X` with no command after it | **deny** — wrapping makes it a silent no-op, which is worse than a refusal; message teaches `(cd X && <cmd>)` |
| `(cd X && …)` already scoped | allow, silent |
| `cd` inside quotes, `$( )`, backticks, `bash -c '…'` | allow, silent |
| command ends in `&`, or anything the parser can't classify | **fail open** — allow unchanged |

## Why rewrite here, when rg-flag-guard denies

Not a style preference — a real discriminator. For `rg -r`, **intent matters**: deliberate `--replace` exists, so only a human or agent can decide, and denial is correct. For `cd`, there is no case where the agent wanted the leak. The correction is mechanical, lossless, and unambiguous, so spending a turn on it buys nothing.

Both patterns already have local precedent: `rg-flag-guard.sh` (deny + printed correction) and `rtk-rewrite.sh` (`updatedInput` + disclosed reason).

Your own corpus supports the disclosure requirement, incidentally — the snip nugget's complaint was that a silent rewrite is indistinguishable from ground truth. So this discloses; it doesn't rewrite silently.

## What I'd want to settle with you

1. **Rewrite or deny?** I favor rewrite on the argument above, but denial *teaches* — and your rules file explicitly credits the guard, not the prose, with fixing the rg traps. Rewrite fixes the machine and leaves the agent's habit intact forever.
2. **Hook composition is unverified.** Six `PreToolUse Bash` hooks already run, one of which (`rtk-rewrite`) also emits `updatedInput`. Whether two rewriting hooks chain, or last-wins, or conflict, I have not tested — and it's a build-blocker, because a cd-wrap that silently loses an rtk rewrite is worse than nothing.
3. **Mention-not-use applies to this guard too** — a commit message containing `cd ` must not trip it. That's the same class as the nugget I filed this morning and the third instance of task #81. Handled structurally here (quote/substitution depth), but it's the part most likely to have a bug.
4. **Is it worth building at all?** The honest case against is unchanged: all six recorded instances failed loudly and immediately. This buys prevention of a hypothetical silent wrong-repo write, plus removal of a recurring papercut.

One live data point from ten minutes ago: the rg guard denied my own `-oh` cluster and handed back the corrected command, which I ran verbatim. That's the shape working on me, first-party, in the same session I tripped `cd` drift three times unaided.

---

## Correction to the extraction above

Open question 2 above says `rtk-rewrite` is one of the running hooks. **It is not.**
Checked after writing it: `~/.claude/settings.json` registers five `PreToolUse` Bash
hooks — `dcg`, `snip-hook-gate claude`, `bv-timeout-guard.sh`,
`git-commit-scope-guard.py`, `explore-search-policy.sh` — plus `rg-flag-guard` via the
user-scope plugin, for six total. `settings.local.json` does not exist.
`~/.claude/hooks/rtk-rewrite.sh` is present on disk but registered nowhere.

This cuts both ways and the second half is the one that matters:

- **Better:** there is no live `updatedInput` emitter, so there is no composition
  conflict to design around today.
- **Worse:** `updatedInput` is therefore **unproven in this harness version**.
  `rtk-rewrite.sh` is a precedent in source, not a working example. The entire
  rewrite design rests on a mechanism nobody here has seen fire.

That inverts the build order. §1 exists because of this.

`rtk-rewrite.sh` was **deleted** 2026-08-14 at the operator's instruction, so its emitter
shape is preserved here rather than by reference — §1 needs it and `~/.claude` is not a git
repo. Only a comment in `bv-timeout-guard.sh` cited it (as a convention example, not a
dependency); that citation now dangles.

```bash
ORIGINAL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
UPDATED_INPUT=$(echo "$ORIGINAL_INPUT" | jq --arg cmd "$REWRITTEN" '.command = $cmd')

jq -n --argjson updated "$UPDATED_INPUT" \
  '{ "hookSpecificOutput": {
       "hookEventName": "PreToolUse",
       "permissionDecision": "allow",
       "permissionDecisionReason": "RTK auto-rewrite",
       "updatedInput": $updated } }'
```

Omitting `permissionDecision` rewrites *and* still prompts; including `"allow"` rewrites and
auto-allows. C2 requires the `permissionDecisionReason` field be populated either way.

## Scope

| unit | path | role | state |
|---|---|---|---|
| classifier | `plugins/cwd-scope-guard/scripts/cwd-scope-guard.sh` | decides rewrite / deny / allow | to build |
| hook registration | `~/.claude/settings.json` → `PreToolUse` / `Bash` | activates it | human-gated |
| bats suite | `plugins/cwd-scope-guard/tests/` | pins the decision table | to build |
| doctor skill | `plugins/cwd-scope-guard/skills/` | explains a surprising verdict | optional, mirrors `rg-doctor` |
| reference impl | `plugins/rg-flag-guard/` | the shape being copied | exists, working |

**Verified this session:** subshell `cd` does not leak and bare `cd` does (direct probe);
env vars do not survive a call boundary (direct probe); the six registered hooks above
(read from `settings.json`); `rg-flag-guard` denying live and printing a usable correction
(it caught this session's `rg -oh`).

**Assumed, not verified:** that `updatedInput` is honoured by this Claude Code build; that
a rewritten command re-enters the *other* five hooks rather than bypassing them; that no
workflow depends on cwd persisting. §1 verifies the first two. The third is an argument,
not a measurement — see C5.

## Global constraints

- **C1.** The guard must **fail open**. Any parse difficulty, unexpected JSON, or internal
  error allows the command through unchanged. A guard that can wedge the harness is worse
  than the drift it prevents. (`rg-flag-guard.sh` already documents this posture; copy it.)
- **C2.** A rewrite must be **disclosed** in `permissionDecisionReason`, never silent. The
  vault's own `snip` nugget records that an undisclosed rewrite is indistinguishable from
  ground truth; do not reproduce that defect in a new tool.
- **C3.** The classifier must distinguish **use from mention** structurally — quote depth,
  `$( )`, backticks, `bash -c '…'` — not by substring. A commit message containing `cd `
  must pass untouched. This is the same class as task #81 and is the most likely source of
  a bug in this design.
- **C4.** Do not rewrite a command whose top-level structure the parser cannot fully
  classify — notably a trailing `&`, where `(cmd &)` and `(cmd) &` differ. Fail open (C1).
- **C5.** Do not extend the wrap to commands with no top-level `cd`. Prefixing every Bash
  call with a project-root `cd` was considered and rejected: it is a larger behavioural
  change than the defect warrants and would surprise in ways the narrow rule does not.
- **C6.** Bare `cd X` with nothing after it must **deny**, not rewrite. `(cd X)` is a no-op,
  and a command that silently does nothing is worse than one that refuses with a reason.

## §1 — Prove `updatedInput` fires in this harness build

**Blocks §2, §3, §4.** Nothing else is worth writing until this is settled.

**Deliverable:** a one-line verdict, recorded in this file, on whether a `PreToolUse` hook
can rewrite a Bash command in this Claude Code version — and whether the rewritten command
still passes through the other registered hooks.

Steps:
1. Write a throwaway hook that rewrites exactly one sentinel command
   (`echo cwd-guard-probe-original`) to `echo cwd-guard-probe-rewritten`, emitting
   `hookSpecificOutput.updatedInput` in the shape `rtk-rewrite.sh` uses.
2. Register it in `settings.json` **last** in the `PreToolUse` / `Bash` list.
3. Restart Claude Code (hook snapshots detach mid-session — see task #45).
4. Run the sentinel command; observe which string comes back.
5. Second probe: have the throwaway hook rewrite a command into one the **rg guard would
   deny** (`rg -rn foo .`). If the denial fires, rewritten commands re-enter the other
   hooks; if it runs, they bypass them.
6. Unregister the throwaway hook.

**Acceptance criteria:**
- AC1.1 — the sentinel command's output is `cwd-guard-probe-rewritten`. If it is
  `cwd-guard-probe-original`, `updatedInput` is inert in this build and the whole rewrite
  design is dead — fall back to deny-with-correction (§5).
- AC1.2 — the outcome of step 5 is recorded here as either `rewrites re-enter hooks` or
  `rewrites bypass hooks`. Bypass is not disqualifying but must be written down: it means a
  cd-wrap could smuggle a command past `dcg`, which is a security-relevant property.
- AC1.3 — `~/.claude/settings.json` at the end of this section is byte-identical to its
  state before it. Verify with a copy taken before step 2, not by inspection.

## §2 — Build the classifier, offline

**Gate: §1 (AC1.1).**

**Deliverable:** `cwd-scope-guard.sh` with an `--explain 'CMD'` mode that classifies a
command string with no harness involved, mirroring `rg-flag-guard.sh --explain`.

Steps:
1. Implement the tokenizer: track single/double quote state, `(` depth, `$(` depth,
   backtick depth, and command position (start, or after `;` `&&` `||` `|` `&` newline
   `(` `{` `then` `do` `else`).
2. Report `cd`/`pushd` only when in command position at quote depth 0 and paren depth 0.
   Note `{ }` is *not* a subshell — a `cd` inside a brace group persists and must be caught.
3. Implement the three verdicts per the decision table, with C4 and C6 as explicit branches.

**Acceptance criteria:**
- AC2.1 — every row of the decision table has at least one `--explain` case whose verdict
  matches, exercised as a bats test.
- AC2.2 — mention-not-use cases pass untouched: `git commit -m "cd into the dir"`,
  `echo "cd /tmp"`, `bash -c 'cd /tmp && ls'`, `rg -n 'cd ' notes.md`.
- AC2.3 — the brace-group case `{ cd /tmp; ls; }` is classified as **rewrite**, not allow.
  This one is easy to get wrong by treating `{` like `(`.
- AC2.4 — `--explain` exit codes match `rg-flag-guard`'s convention (0 allow / 2 deny), with
  rewrite distinguished in the printed JSON rather than by a third exit code.
- AC2.5 — each test was seen to **fail** against a deliberately broken classifier before
  being accepted. A guard's own suite has to be shown red; that is the lesson from this
  session's `folders_test.go` work (everything-tooling `6e9b94a`).

## §3 — Wire it, with the kill switch

**Gate: §2.**

**Deliverable:** the hook registered and demonstrably firing, with an env kill switch.

Steps:
1. Add `CWD_SCOPE_GUARD_DISABLE=1` support, matching `RG_FLAG_GUARD_DISABLE`. Document that
   it must be set in the environment Claude Code itself was launched with — hooks are
   separate processes, so prefixing the blocked command does nothing.
2. Register in `settings.json`.
3. Restart. Run `cd /var/tmp && pwd`, then `pwd` in the next call.

**Acceptance criteria:**
- AC3.1 — the second `pwd` returns the project root, not `/var/tmp`.
- AC3.2 — the transcript shows the disclosure string from C2 on the rewritten call.
- AC3.3 — with the kill switch set at launch, the same two calls reproduce the drift.
  This is the criterion that proves the guard is what changed the behaviour, rather than
  something else in the environment.
- AC3.4 — the five pre-existing hooks still fire: re-run this session's `rg -oh` case and
  confirm the rg guard still denies it.

## §4 — Package as a plugin

**Gate: §3.**

**Deliverable:** `plugins/cwd-scope-guard/` in this repo, matching `rg-flag-guard`'s layout
(vendored script, bats suite, doctor skill, marketplace entry).

**Acceptance criteria:**
- AC4.1 — `bats plugins/cwd-scope-guard/tests/` passes from a clean checkout.
- AC4.2 — the plugin is the sole live registration; any hand-rolled `settings.json` entry
  from §3 is removed, mirroring how `rg-flag-guard`'s manual entry was retired 2026-08-04.
- AC4.3 — the decision table in this file and the one in the script's header comment agree,
  checked by reading both, not assumed.

## §5 — Fallback: deny-with-correction

**Only if AC1.1 fails.**

**Deliverable:** the same classifier, wired as deny + printed correction instead of rewrite.

The classifier from §2 is unchanged — only the emitter differs. The cost is one wasted turn
per occurrence instead of zero, which is exactly `rg-flag-guard`'s existing cost and is
evidently tolerable.

**Acceptance criteria:**
- AC5.1 — the denial message contains the corrected command, copy-pasteable, in the same
  form `rg-flag-guard` prints.

## Rollback

Per section, in reverse order:

- **§4:** `claude plugin uninstall cwd-scope-guard`; `git revert` the plugin commit.
- **§3:** remove the `settings.json` entry and restart. Restore from the copy taken in
  AC1.3, rather than hand-editing the entry back out.
- **§2:** delete the script. Nothing else references it.
- **§1:** unregister the throwaway hook (step 6) and restart. **If §1 is abandoned
  mid-flight, the throwaway hook is still registered** — it rewrites a sentinel string
  nothing uses, so it is harmless but must still be removed; check `settings.json` against
  the AC1.3 copy rather than assuming step 6 ran.

No step here touches a repository other than `tiny-claude-plugins` and
`~/.claude/settings.json`.

## Out of scope

- **Fixing the drift upstream.** A per-call cwd reset in the harness is the real fix; this
  is a local workaround. Not filed as a feature request.
- **`cd` inside scripts the agent invokes.** A shell script that `cd`s internally already
  runs in its own process and never affected the tool shell.
- **The other five hooks' behaviour.** §1 AC1.2 records whether rewrites re-enter them; it
  does not change any of them.
- **Whether this is worth building.** Task #91's counter-argument stands unresolved and is
  deliberately not re-litigated here: all six recorded drift instances failed loudly and
  immediately, so the concrete benefit is removal of a papercut plus prevention of a
  silent wrong-repo write that has not yet occurred. §1 is cheap enough to run before
  settling that; §2 onward is not.
