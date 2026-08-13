---
author: agent
model: claude-opus-5
type: handoff
vx_review: unreviewed
created: 2026-08-13
updated: 2026-08-13
sessions:
  - 5ad8bfd4-e56d-4276-a8db-6d110a4fb79b
repos:
  - /home/gulp/projects/tiny-claude-plugins
  - /home/gulp/shower-thoughts/claude-artifact-element
  - /home/gulp/shower-thoughts/ultratask
continues: docs/handoffs/2026-08-10T21-25-05Z-ultragoal-consensus-plan-arc.md
---

# HANDOFF SUMMARY

## 1) Mission State

- **Current objective:** arm `/ultragoal` on `docs/plans/2026-08-13-ultragoal-observability.md` in this repo. The user approved the sequence "commit, then `/ultragoal`", then approved writing this handoff first.
- **Current status:** all preconditions met. Working tree clean except one deliberately untracked file (below). Baseline measured. Nothing armed yet.
- **Definition of done:** `state.json` reaches `status: done` — every rubric check passes with the rubric hash intact. Bounded verdicts (`incomplete` / `tampered` / `bypassed`) are honest terminal states, not successes.
- **Immediate next best action:** `/ultragoal start @docs/plans/2026-08-13-ultragoal-observability.md` — **but only from a session whose project dir is `/home/gulp/projects/tiny-claude-plugins`.** See the blocker below. Step 2 of that skill is the single HITL gate; after the user confirms the check table, autonomy begins and the Stop hook will refuse to let the session stop.
- **BLOCKER found at arming time (authoring session was rooted in `/home/gulp/shower-thoughts`, `CLAUDE_PROJECT_DIR` unset).** `goal-stop-guard.sh:31` resolves `STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/.ultragoal"`, so arming from the wrong cwd (a) overwrites `/home/gulp/shower-thoughts/.claude/.ultragoal/rubric.json`, the certified fixture AC1.1 reads by absolute path and Out of scope marks "never modified (C5)"; (b) resolves every `plugins/ultragoal/scripts/…` rubric command against the wrong root, so the vacuity guard passes for wrong reasons; and (c) points `git -C "${CLAUDE_PROJECT_DIR:-.}"` at `:175`/`:186` at a non-repo, silently skipping the commit gate and tag — the exact defect §2 exists to fix. Nothing was armed. Verify `CLAUDE_PROJECT_DIR` before `start`.

## 2) Stable Context (carry forward)

- **Repo:** `/home/gulp/projects/tiny-claude-plugins`, branch `main`. HEAD at handoff time `46374c0`; the session started from `f29e765`.
- **Untracked on purpose:** `plugins/kittens-saved/docs/examples/b.md` is **0 bytes**. Left out of the commit rather than committing an empty file into the examples dir. It is not lost — still on disk, untracked. Decide whether to fill or delete it.
- **Baseline, measured twice:** `bash plugins/ultragoal/scripts/test-guard-verdicts.sh` exits **0**, printing `all verdicts + escalation-record + multi-session + doctor matrix proven`. Measured first against the dirty tree, then re-measured against clean `HEAD` in a detached worktree under `/var/tmp` (removed afterward; `git worktree list` shows only the main checkout). So the baseline is a property of `HEAD`, not of anyone's uncommitted work. AC1.5's PENDING branch in the plan is **not** active.
- **kittens-saved test suites**, all green before the commit: `test_kittens_liveness.py` (13), `test_kittens_mine.py` (12), `test_kittens_tasks.py` (47), `test_kittens_scoping.py` (14), `test_kittens_statusline.py` (25), `test_kittens_nudge_reaches_model.py` (22). Run them individually — see the `dcg` pitfall in §5.
- **Session task list** `5ad8bfd4-…`: #1 closed by the human (git init decision), #3 closed as a duplicate, **#2 still open** — the `/ultragoal` arming decision, now effectively answered in conversation but not closed on the list. Agents cannot close `[human]` tasks; the guard refuses `TaskUpdate → completed/deleted` and blocks `done`/`own`/`disown` through Bash.
- **`/tmp` is a 7.8G tmpfs on this box.** Use `/var/tmp` for worktrees, caches, and scratch of any size. The handoff scripts' documented `UV_CACHE_DIR=/tmp/codex-handoff-uv-cache` was substituted to `/var/tmp/codex-handoff-uv-cache` throughout.
- **Sibling repo state:** `/home/gulp/shower-thoughts/claude-artifact-element` is now a git repo (`main`, `e688842`, clean) — created this session. `/home/gulp/shower-thoughts/ultratask` is `main` at `5330987` with an untracked `docs/` holding one plan.

## 3) Progress So Far (what happened)

- **Verified the search-policy hook against Claude Code 2.1.231.** SessionStart warned it was last validated at 2.1.228 and might be a silent no-op. Ran `EXPLORE_POLICY_CONTRACT=1 bats ~/.claude/hooks/tests/explore-search-policy.bats --filter contract` → passed, `observed agent_type values: Explore`. Stamped `~/.claude/hooks/explore-search-policy.validated` with `2.1.231`. Decision: contract holds, hook is live.
- **Duplicate task #3 filed and cleaned up.** A `kittens.py escape` re-declaration filed a second copy of task #2 as `[human] [human] …`. Tried `TaskUpdate → deleted`; the ownership guard refused, correctly. Did **not** route around it. The user ran `ultratask done 3`.
- **Root-caused the duplicate — it was operator error, not a code defect.** `kittensKey` is `sha256(" ".join(item.split()))[:16]` over the *original item text*, which lives in the task's `description`. Task #2 stores `sha256:9d0c0bcf5cf6e665`; hashing its description reproduces that exactly, hashing its truncated `subject` gives `sha256:c527d9f8ef92261b`. Restating "verbatim" from the *task list* (the marked, truncated subject) rather than from the prior *declaration* defeats both dedup paths at once — wrong hash, and a doubled `[human] ` marker that `_bare_subject` only strips once. Verified the fix by re-declaring with the description text: zero new tasks filed.
- **`git init` on claude-artifact-element.** The human decided yes mid-turn. Ran `git init -b main`, added a one-line `.gitignore` (`node_modules/`), ran `npm test` (8 resolver tests passed) *before* committing, then committed everything including `dist/` — the README's quickstart points a `<script src>` straight at `dist/claude-artifact.js`, so excluding it would break documented usage for anyone cloning. Commit `e688842`. This also completed the commit step an earlier `/handoff-summarizer` run had to abandon because the directory was not a repo.
- **Committed the kittens-saved work.** Ran all six suites first (133 tests, all OK). Bumped `plugins/kittens-saved/.claude-plugin/plugin.json` `0.8.3 → 0.9.0`, matching the repo's `feat(kittens-saved): 0.X.0 — …` convention. Commit `2225955`. Then `46374c0` for the observability plan doc, kept separate as a different concern.

## 4) Effective Strategies (helpful)

- **Strategy:** settle a "is this contaminated by uncommitted work?" question with a detached `git worktree` at `HEAD` under `/var/tmp`, run the check there, remove the worktree. **Why it worked:** it answers the question without touching, stashing, or risking the human's in-flight changes — stash was never on the table. **Where to reuse it:** any baseline measurement taken against a dirty tree.
- **Strategy:** before claiming "editing that file would collide with your work", read `git diff -U0 <file> | rg '^@@'` and locate the target function in the hunk ranges. **Why it worked:** it turned a hand-wave into a fact — the whole task-filing machinery was inside a single `@@ -167,0 +169,371 @@` insert, i.e. net-new uncommitted code that does not exist at `HEAD`. **Where to reuse it:** every time scope is declined on collision grounds.
- **Strategy:** when a dedup mechanism misfires, hash the candidate strings yourself and compare against the stored key. **Why it worked:** it distinguished operator error from a code bug in one command, after a plausible-but-wrong defect story had already been told. **Where to reuse it:** any content-addressed identity (`kittensKey`, cache keys, etag-like schemes).
- **Strategy:** run the target repo's full existing suite before committing someone else's in-flight work, not just the new tests shipped with it. **Why it worked:** a +371-line insert can break tracked suites that its author never re-ran. **Where to reuse it:** committing on someone's behalf, always.

## 5) Pitfalls and Anti-Patterns (harmful)

- **Pitfall:** restating a carried-over `--yours-item` by copying the subject shown in the task list. **Why it failed:** the displayed subject is marker-prefixed and truncated with `…`; it is not the text `kittensKey` was computed over. Both dedup paths miss and a duplicate task is filed. **How to avoid it:** copy from the task's `description` field, or from your own prior declaration. Never from the rendered list.
- **Pitfall:** naming a defect in someone's code from the outside, before reading it. **Why it failed:** I attributed the duplicate to `_task_subject` prefixing unconditionally, published that, and had to retract it — the real cause was my own input. **How to avoid it:** read the function and hash the inputs before assigning blame; a mechanism that *could* explain the symptom is not evidence it *did*.
- **Pitfall:** shell redirects inside a variable-expanding loop. **Why it failed:** `for t in scripts/test_*.py; do … >/var/tmp/kt.log …; done` was blocked by `dcg` (`core.filesystem:redirect-truncate-root-home`) — it cannot prove the target before the file is opened, so the whole loop is refused regardless of destination. **How to avoid it:** write such loops with no redirects at all, or unroll to one command per invocation.
- **Pitfall:** treating the ownership guard's refusal as an obstacle to route around. **Why it failed:** it would have taken the marker-strip-then-delete two-step, which is exactly the bypass `disown` is guarded hardest against. **How to avoid it:** hand the human the one command and let them run it, even when the mess is yours.
- **Pitfall:** offering a formed recommendation as a conditional ("your call whether that's worth it"). **Why it failed:** it avoids commitment while looking deferential; the user has to re-ask for the opinion you already hold. **How to avoid it:** state the recommendation plainly first, and only then note it is theirs to take or leave.

## 6) Open Loops

- **Issue:** `_task_subject` applies `HUMAN_PREFIX` without stripping an existing marker, and `_bare_subject` strips only one, so a double-marked subject is constructible and the bareSubject fallback cannot catch it. **Blocking reason:** none any more — the code is committed at `2225955`. It was deferred only while uncommitted. **Suggested next probe:** strip any leading markers in `_task_subject` before prefixing; make `_bare_subject` strip repeatedly. Recommended, because the skill's own "restate VERBATIM" instruction predictably produces the breaking input — an agent following the documented process generated it on the first attempt.
- **Issue:** the `counting-saved-kittens` skill says "restate a carried-over item VERBATIM" without saying *from what*. **Blocking reason:** none. **Suggested next probe:** amend to "verbatim from your prior declaration" and point at the task's `description` field as where that text is recoverable.
- **Issue:** `plugins/kittens-saved/docs/examples/b.md` is empty and untracked. **Blocking reason:** unknown intent — placeholder or accident. **Suggested next probe:** ask the author.
- **Issue:** task #2 (`/ultragoal` arming decision) is still open on the list although the decision was made in conversation. **Blocking reason:** agents cannot close `[human]` tasks. **Suggested next probe:** the human runs `ultratask done 2`.

## 7) Decision Ledger

- **Decision:** commit the kittens-saved work before arming `/ultragoal`. **Rationale:** the plan's Rollback uses `git checkout --`, and an armed session structurally cannot stop; pointing a destructive verb at 601 uncommitted lines inside a gate that forbids stopping is the bad combination. Committing makes rollback recoverable. **Tradeoff accepted:** the work landed on `main` under my commit message rather than the author's.
- **Decision:** bump to `0.9.0` rather than `0.8.4`. **Rationale:** net-new feature (task-list mirroring), and the repo's history uses minor bumps for features. **Tradeoff accepted:** guessed the author's intent on version semantics.
- **Decision:** commit `dist/` in claude-artifact-element. **Rationale:** the README's quickstart references `dist/claude-artifact.js` directly, so a clone without it is broken on arrival. **Tradeoff accepted:** build output in version control; it must be rebuilt and re-committed on every source change.
- **Decision:** write this handoff before arming, at ~60% context. **Rationale:** auto-compact is off and the gate prevents stopping, so context exhaustion mid-run would strand an armed session with no pickup point. **Tradeoff accepted:** one turn spent before work starts.
- **Decision:** do not fix `_task_subject` in the same breath as committing it. **Rationale:** it is the author's active design area, mid-iteration on this exact dedup problem. **Tradeoff accepted:** a known small gap ships in `0.9.0`.

## 8) Delta Update (for memory/playbook)

### Helpful (+)

- [baseline] : measure against clean HEAD in a detached /var/tmp worktree when the tree is dirty, then remove it (count: 1)
- [scope-claims] : verify a claimed edit collision with `git diff -U0 | rg '^@@'` before declining work on those grounds (count: 1)
- [dedup] : recompute the content hash yourself to tell operator error apart from a code defect (count: 1)
- [committing-for-others] : run the full existing suite, not only the new tests, before committing someone's in-flight work (count: 1)
- [guards] : hand the human the one command when a guard refuses, even when the mess is yours (count: 1)
- [sequencing] : write the handoff before arming a gate that forbids stopping (count: 1)

### Harmful (-)

- [verbatim-restatement] : copying a task's rendered subject instead of its description defeats both hash and bareSubject dedup (count: 2)
- [blame] : naming a defect in code you have not read produces a retraction (count: 1)
- [dcg] : redirects inside variable-expanding shell loops are refused regardless of destination (count: 1)
- [guard-bypass] : marker-strip-then-delete is the two-step the ownership guard exists to stop (count: 1)
- [hedging] : offering an already-formed recommendation as a conditional makes the user re-ask for it (count: 1)
- [tmpfs] : /tmp on this box is a 7.8G tmpfs, so worktrees and caches belong in /var/tmp (count: 1)

## 9) Next-Agent Brief

- **Read first:** `docs/plans/2026-08-13-ultragoal-observability.md` — specifically the *Baseline verified* note, AC1.5, and the Rollback section. Then §2 above for the measured state.
- **Ignore:** the plan's hedging about an unverified baseline. It was written before measurement and has since been superseded twice; the baseline is 0 at clean `HEAD`.
- **Try first:** `/ultragoal start @docs/plans/2026-08-13-ultragoal-observability.md`. Expect the vacuity guard to run `plugins/ultragoal/scripts/rubric-check.sh` — at least one check must fail before arming, or the rubric is vacuous and needs sharpening. The single confirmation gate is step 2; after it, do not ask further questions.
- **Success next turn:** `rubric.json` written with at least one currently-failing check, `state.json` armed with `session_id` set, and the check table shown to the user for one confirmation. Do **not** edit `rubric.json` after arming — the hash pin turns that into a `TAMPERED` verdict rather than a success.
