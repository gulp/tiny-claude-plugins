---
name: driving-swarms-with-mail
description: The Agent-Mail reservation-and-messaging seam for working a shared git checkout alongside other agents — reserve your edit surface as an Agent Mail file reservation before touching it, announce in a per-task Agent Mail thread, then release it when your commit lands. The load-bearing content is the Agent Mail flow; the surrounding git/tracker steps are generic swarm hygiene shown only so the loop reads end to end. Use when several agents share ONE working tree and ONE git index (not isolated worktrees) and coordinate through Agent Mail — e.g. "reserve files before editing", "announce my edit surface", "avoid stepping on a peer's edits", "release my file reservation", or "join an Agent Mail swarm on this repo".
metadata:
  disable-model-invocation: "true"
allowed-tools: Bash Read Write
---

# Driving swarms with mail — the Agent Mail seam for a shared checkout

Several agents can share ONE working tree and ONE git index instead of isolated
worktrees. In that mode, filesystem isolation does not exist — the thing that
keeps two agents off each other's files is an **Agent Mail file reservation**
plus a **per-task Agent Mail thread**, backed by social discipline, not git
branches or containers.

That Agent Mail flow — reserve → announce → release — is what this skill owns.
The git-commit and issue-tracker steps woven through the loop below are **generic
swarm hygiene**, not Agent-Mail-specific; they are included only so the cycle
reads end to end. Where your repo already documents its own commit/tracker
conventions, those win — this skill does not restate them authoritatively.

This skill is invoked **only on explicit request** (`disable-model-invocation`)
because it walks through a state-mutating sequence — reservations, commits,
task-tracker transitions — that must not fire automatically mid-conversation.

## When this applies

Use this loop when:
- The task was assigned by a human or agent coordinator inside a shared
  checkout (no `git worktree add`, no per-agent clone).
- Other agents may be editing the same repo concurrently, in parallel panes or
  sessions.
- Work is tracked as discrete units (tickets, tasks, beads — call them
  **tasks** below) that can be claimed, reserved, and closed independently.

Skip it for solo sessions, isolated worktrees, or read-only research — the
loop only pays for itself once a peer could plausibly touch the same files.

## Roles referenced generically

- **Agent Mail MCP tools** — `ensure_project`, `register_agent`,
  `file_reservation_paths`, `release_file_reservations`, `send_message`,
  `fetch_inbox`, `acknowledge_message`, and optionally
  `acquire_build_slot` / `release_build_slot` / `renew_build_slot`. These are
  the canonical tool names; call whichever MCP server in this environment
  exposes them.
- **Your issue tracker** — whatever claims and closes tasks (a CLI, an API, a
  project board). Examples below use a placeholder `tracker` command; swap in
  the real one.

## 1. Identity — register once per session, reuse verbatim

The Agent Mail `project_key` **is the absolute working-directory path** —
never a guessed slug. Two agents in the same directory are automatically the
same project; a sibling repo is automatically a different one.

```
ensure_project(human_key=<absolute cwd>)
register_agent(
  project_key=<absolute cwd>,
  program=<your agent program, e.g. "claude-code">,
  model=<your model id>,
  task_description=<short current-focus string>,
  # name: OMIT — the server auto-generates a valid Adjective+Noun identity
)
```

Record the returned name and **reuse it verbatim** on every later wake in this
session or repo. Omitting the name again mints a *new* identity and silently
orphans every reservation the old one held. Names must be adjective+noun and
non-descriptive (`GoldenCoyote`, not `MigrationWorker`) — role-descriptive
names are rejected by the server.

If your harness exposes the identity to a statusline or pane map via an
environment variable (e.g. `AGENT_NAME`), set it at launch time, not via a
mid-session `export` — a Bash-tool subprocess's environment does not persist
back into the parent session, so a mid-session export is invisible to
anything reading that variable outside the tool call that set it.

## 2. The loop — reserve → announce → work → commit `--only` → release → close

Repeat this once per task claimed.

**Step 1 — Claim.** Use your tracker's ready-queue / claim command as the
authorization to start (`tracker ready`, then `tracker update <task-id> -s
in_progress`). A separate analysis or scoring tool suggesting what to pick is
input, not authorization — only the tracker's claim state is.

**Step 2 — Reserve, narrowly, before editing anything.**

```
file_reservation_paths(
  project_key=<absolute cwd>,
  agent_name=<your name>,
  paths=[<narrowest globs that cover your edit surface>],
  ttl_seconds=<enough for the task, renewable>,
  exclusive=true,
  reason=<task-id>,
)
```

Reserve the tightest globs that cover the work — not the whole repo, not a
top-level `**/*`. Renew before expiry with `renew_file_reservations` rather
than letting it lapse mid-edit.

**Step 3 — Announce in a per-task thread.**

```
send_message(
  project_key=<absolute cwd>,
  sender_name=<your name>,
  to=[<coordinator and/or affected peers>],
  subject="[<task-id>] <what you're about to do>",
  thread_id=<task-id>,
  body_md=<one paragraph: what, which paths, why>,
)
```

Use the **task id as both the reservation `reason` and the message
`thread_id`** — that shared key is what lets anyone reconstruct "who touched
what, why" later by reading Agent Mail and git history side by side. Reuse
the same `thread_id` for every message about that task, including the
landing report in step 6.

**Step 4 — Do the work.** Edit only inside your reserved globs. If the task
turns out to need a peer-owned path, message that peer before touching it —
do not silently expand scope past your reservation.

**Step 5 — Commit only your own paths. Never a bare `git commit`.**

```bash
git commit --only -F <msgfile> -- <your files/dirs>
```

- Flags (`-F`, `-m`, etc.) go **before** the `--`; everything after `--` is a
  pathspec.
- A bare `git commit` (or `git commit -a`) commits the **entire shared
  index** — including a peer's staged, possibly half-written, files. There is
  no "just this once" exception in a shared tree.
- If your environment blocks heredocs or redirects into shared/home paths,
  write the commit message to a file with a file-writing tool first, then
  pass that file to `-F` — do not fight the guard with a heredoc.
- **Commit before releasing your reservation.** Releasing over an uncommitted
  change lets a peer start editing the same paths before your work has
  landed, which reopens the exact race the reservation existed to prevent.
- If closing your task also means updating a tracker file that lives in
  version control (e.g. an issues export), confirm who owns committing that
  file before you sweep it into your commit — a shared tracker file is
  usually owned by whoever syncs it, not by every closer.

**Step 6 — Release, then close, then report.**

```
release_file_reservations(project_key=<absolute cwd>, agent_name=<your name>)
tracker close <task-id> --reason "<what landed + commit sha>"
send_message(..., thread_id=<task-id>, subject="[<task-id>] landed", body_md="<commit sha, what changed, verification result>")
```

Release only after the commit exists. Report the landing on the **same**
`thread_id` you announced on, so the whole task's story reads as one thread.

## Shared-tree gotchas

- **Review or verify *committed* state, not the working tree.** Peers mutate
  the tree continuously — mid-edits, scratch experiments, half-finished
  toggles. When checking "what actually landed" for a peer's path, read
  `git show <ref>:<path>` or `git diff HEAD -- <path>`, never the live file
  on disk. Reading a peer's uncommitted, transient edit and treating it as
  their finished work is a real, previously-observed failure mode, not a
  theoretical one.
- **Reservations are advisory, not enforced locks.** A conflicting edit is
  still *possible*, just against the agreed contract. Keep coordinating over
  Agent Mail even when you hold a clean reservation — a stale or
  force-released reservation does not mean the path is actually safe.
- **Prefer additive changes to any shared type, schema, or config.** Renaming
  or restructuring something a peer also reads is worth an announced message
  *before* the edit, not just a reservation.
- **Build slots may be disabled** in a given deployment
  (`acquire_build_slot` returning a "disabled" status is a valid, expected
  response, not an error). When slots are off, prefer **narrowly-scoped**
  builds/tests (the package or directory you touched) over a whole-repo build
  while peers are mid-edit, and message a peer directly before running a
  whole-repo build or test suite. If a shared build breaks and the failure
  traces to a peer's in-flight change rather than your own diff, say so and
  retry — it is not automatically your bug to fix.

## Inbox discipline (pull-only)

Agent Mail delivery is **pull-only**: a message exists the moment it's sent,
but you only see it once you call `fetch_inbox`. A push notification (if your
harness has one) is what *wakes* you — it is not itself the message contents.
Consequently:

- Call `fetch_inbox` (and `acknowledge_message` for anything requiring an ack)
  at the start of every turn and after every wake, not just at session start.
- Coordinator or peer silence after you've announced usually means they
  haven't polled yet, not that you've been overridden — proceeding on your
  announced, reserved task is expected, not presumptuous.
- Be proactive: claim and announce the next task rather than idling after one
  closes. An agent that goes quiet between tasks reads, to the rest of the
  swarm, as stalled or crashed.

## Fan-out: the `broadcast` flag works (despite one stale doc line)

`send_message` supports project-wide fan-out via a `broadcast` flag — useful
for a coordinator announcement that every current worker should see, without
hand-listing every agent name:

```
send_message(
  project_key=<absolute cwd>,
  sender_name=<your name>,
  broadcast=true,
  to=[],   # must be empty — mutually exclusive with an explicit `to`
  subject="...",
  body_md="...",
)
```

With `broadcast=true` and an empty `to`, the server expands the recipient
list to every agent registered in the project that has been active in the
last 30 days, minus the sender and anyone with `contact_policy=block_all`.
This is real, unit-tested server behavior (`crates/mcp-agent-mail-tools/src/messaging.rs`
in `mcp_agent_mail_rust`), not a client-side convention — it computes the
recipient set fresh on each send rather than reading a stored group.

Two things this is **not**:
- **Not** a pseudo-recipient. Naming an agent `all` / `everyone` / `broadcast`
  / `*` in `to` is explicitly rejected server-side ("Agent Mail doesn't
  support broadcasting to all agents") — that error exists to steer you to
  the flag above, not to deny the capability.
- **Not** documented as working by `am robot-docs guide`, which currently
  states "Broadcast send_message is intentionally unsupported." That line is
  **stale** relative to the implemented, tested flag — a
  documentation-vs-implementation drift, verified against the
  `mcp_agent_mail_rust` source, not a code contradiction. Treat this skill,
  not the CLI guide, as authoritative on broadcast for swarms in this repo
  until the upstream guide is reconciled.

## Boundaries

- **Stay inside your assigned lane.** If a task's acceptance criteria would
  require editing a path a coordinator or peer explicitly owns, or a path
  flagged as human-reviewed/protected in this repo's own conventions, hand
  that edit back to whoever owns it instead of reserving and editing it
  yourself.
- **Never commit on behalf of the whole swarm.** Your commit's pathspec
  should match your reservation's paths, nothing wider — even when it would
  be "more convenient" to fold in an unrelated fix you noticed along the way.
