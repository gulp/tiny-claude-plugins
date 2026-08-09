## Verdict

The Gemini answer is **directionally correct but materially incomplete and partly misleading**.

As of **July 28, 2026**, released Codex does not expose a native Claude-style `Monitor` tool that can register a long-lived command, remain locally idle at zero token cost, and wake the same session whenever that command emits a line. However:

1. This is not merely a vague community request. There is a detailed Codex issue cluster identifying the missing core primitive, its token cost, lifecycle semantics, and implementation options.
2. A working Codex fork already implements essentially the Claude `Monitor` behavior.
3. Stock Codex now has enough lower-level machinery—App Server, `turn/start`, `turn/steer`, remote TUI connections, hooks, persistent threads—to build a good supervisor-based approximation.
4. The weak point is not running or displaying background processes. It is **reliably delivering an external event into an already-idle interactive Codex session and causing a new turn**.

That distinction matters.

---

# 1. What your `agent-mail-monitor` requires

Your Claude process does roughly this:

```text
agent starts monitor command
        ↓
monitor process stays alive locally
        ↓
mail bus emits a line
        ↓
harness turns line into inbound session notification
        ↓
idle agent wakes and receives it
        ↓
new model turn begins
```

The important property is not “live terminal output.” It is:

> **An external local event becomes model-visible input and schedules a new turn without the model polling.**

There are several adjacent but insufficient Codex capabilities:

| Capability                                      |        Solves your problem? |
| ----------------------------------------------- | --------------------------: |
| Keep a shell process running                    |                   Partially |
| Display recent background output with `/ps`     |                          No |
| Poll a process through `write_stdin`            | Functionally, but expensive |
| Notify the human when a turn ends               |                          No |
| Hook lifecycle events                           |            No external wake |
| Send input to an active App Server turn         |      Yes, with `turn/steer` |
| Start another turn on an idle App Server thread |      Yes, with `turn/start` |
| Inject into an arbitrary existing TUI session   |                 Not cleanly |
| Native event-driven watcher                     |                Not released |

The Codex tracker describes the exact missing behavior: background subprocesses and subagents can finish, but they do not queue a message or wake their caller. The caller must poll or wait for the human to ask again. ([GitHub][1])

---

# 2. Why ordinary Codex polling is worse than it looks

The current fallback is commonly:

```text
exec_command starts process
write_stdin("", session_id) checks it
write_stdin("", session_id) checks again
...
```

Issue `#13733` traces the implementation-level consequence:

1. A background command returns partial output.
2. Codex marks the interaction as needing follow-up.
3. The entire model-visible history is reconstructed and sent upstream.
4. The model decides to call `write_stdin`.
5. An empty result returns after a local wait.
6. Another full model turn follows.

The reporter observed approximately one poll every 10 seconds and noted that a 60-second build could generate roughly twelve model turns. The cost therefore trends toward:

```text
conversation history size × number of polls
```

rather than the tiny cost of the status response itself. The model also spends output tokens deciding whether to poll again. ([GitHub][2])

This means a prompt instruction such as:

```text
Poll the mail ticker every 15 seconds.
```

is one of the least desirable shims. It functions, but its operating economics deteriorate as the session grows.

There are also reports of Codex “losing patience,” abandoning long processes, spinning indefinitely on nonexistent background terminals, or mishandling process cleanup. The surrounding issue cluster includes missing job control, inaccessible full logs, orphaned processes, and background jobs that do not wake their caller. ([GitHub][3])

---

# 3. The strongest result: a working native-style fork exists

Issue `#29922`, opened June 24, 2026, proposes an agent-callable `monitor` tool with almost exactly the semantics you want:

```text
monitor(
  action="start",
  command="...",
  description="..."
)

monitor(action="list")
monitor(action="stop", id="mon_ab12")
```

Every stdout or stderr line from the command becomes a notification. Nearby lines are batched. Quiet periods make no API calls. The session wakes only when an event arrives. ([GitHub][4])

More importantly, this is accompanied by a **working reference implementation**, reportedly tested in both the CLI and Desktop app:

- Based on the `v0.142.0` release tag.
- Approximately 1,100 lines across 19 files.
- Behind a feature flag.
- No protocol change.
- Reuses `unified_exec` for process execution.
- Reuses the session’s existing idle-turn-start path for wake-up.
- Registers watches per session.
- Aborts and reaps them at stop or session shutdown.
- Applies the existing sandbox, approval, environment, and shell behavior. ([GitHub][4])

For your monitor, its intended invocation would be close to:

```text
monitor(
  action="start",
  description="agent-mail for AmberOtter",
  command="AGENT_NAME=AmberOtter \
CLAUDE_PROJECT_DIR=/home/gulp/projects/apply_patch \
deno run \
  --allow-run=am \
  --allow-env \
  --allow-read \
  /home/gulp/.claude/plugins/cache/tiny-claude-plugins/agent-mail-monitor/0.5.0/src/cli.ts \
  monitor"
)
```

The patch’s documented delivery path is especially important: it does not repeatedly ask the model to inspect the process. A local delivery task consumes output, batches lines, and starts the idle session through Codex’s existing continuation machinery.

### Assessment

This is the closest thing to true Claude parity.

Its liabilities are operational rather than architectural:

- You maintain a Codex fork.
- The patch was built against `v0.142.0`; current Codex has moved beyond that.
- Internal `codex-core` APIs may change.
- Upstream has not accepted or committed to the design.
- You must rebuild or rebase frequently.

For a controlled agent appliance where you already pin versions, this may nevertheless be the best current answer.

---

# 4. Best stock-Codex shim: own the App Server lifecycle

The most robust non-fork design is not to wrap the normal TUI with terminal keystrokes. It is to make your control plane an **App Server client**.

Official Codex App Server exposes:

```text
thread/start
thread/resume
turn/start
turn/steer
turn/interrupt
```

A client starts or resumes a persistent thread, starts turns, and receives streamed lifecycle notifications. `turn/steer` appends user input to the currently active turn; `turn/start` begins a new turn on the thread. ([OpenAI Developers][5])

Codex can expose App Server over:

- stdio
- WebSocket
- Unix socket

The normal TUI can also connect to a remote App Server using `--remote`, including a local Unix socket. These interfaces are currently documented as experimental. ([OpenAI Developers][6])

That permits this topology:

```text
                         ┌──────────────────┐
agent-mail bus ─────────▶│ local supervisor │
                         │                  │
                         │ cursor/dedupe    │
                         │ coalescing       │
                         │ routing          │
                         └────────┬─────────┘
                                  │
                         turn/start or
                         turn/steer
                                  │
                         ┌────────▼─────────┐
                         │ Codex App Server │
                         │ persistent thread│
                         └───────┬──────────┘
                                 │
                         optional remote TUI
```

A useful local state record would be:

```json
{
  "agent": "AmberOtter",
  "project": "/home/gulp/projects/apply_patch",
  "thread_id": "019...",
  "last_mail_id": 27921,
  "turn_state": "idle"
}
```

The supervisor—not the model—polls or tails the mailbox:

```text
am watch --agent AmberOtter --after 27921 --format ndjson
```

For each meaningful batch:

- When the thread is idle: call `turn/start`.
- When a turn is active and the event should influence current work: call `turn/steer`.
- When a turn is active but interruption would be harmful: queue locally and submit after `turn/completed`.
- Persist the cursor only after App Server accepts the delivery.
- Add an event ID to the model-visible envelope for idempotency.

Example model-visible input:

```text
[agent-mail event batch]
recipient: AmberOtter
project: /home/gulp/projects/apply_patch
cursor: 27914..27921

- #27914 claimed ap-2uu.7-readme-undo-headline
- #27915 completed ap-2uu.7-undo-headline
- #27920 closed ap-2uu.5-init-ap-2uu.10
- #27921 closed ap-2uu.6-agent-surface-collapse

Reconcile these events with your current task. Do not repeat actions whose
event IDs have already been processed.
```

### Token behavior

This gives you the important economic property:

- **No event:** no model call, no tokens.
- **One event batch:** one new model turn.
- **Burst of six mail lines:** preferably one coalesced turn, not six.
- **Active turn:** one steer operation rather than blindly starting competing turns.

It is not “zero-token monitoring” in the absolute sense. Claude also needs a model turn once an event is delivered. The zero-token claim applies to the quiet waiting period.

### Major caveat

App Server solves wake-up well only when your supervisor owns or already knows the thread.

Codex still lacks a clean, stable mechanism for an unrelated external process to discover and attach to whichever thread an ordinary TUI user happens to have open. That gap has its own issue, including requests for discovering the active Desktop thread and routing inbound MCP notifications into it. ([GitHub][7])

So the architecture should be:

```text
supervisor creates/records thread
```

rather than:

```text
user starts arbitrary codex TUI
supervisor somehow locates it afterward
```

---

# 5. A practical implementation shape

A robust dispatcher needs a state machine, not merely `tail | codex`.

```text
                 ┌─────────────┐
                 │   IDLE      │
                 └──────┬──────┘
                        │ event batch
                        ▼
                 call turn/start
                        │
                 ┌──────▼──────┐
                 │ TURN_ACTIVE │
                 └───┬─────┬───┘
            urgent event   ordinary event
                 │              │
           turn/steer       enqueue locally
                 │              │
                 └──────┬───────┘
                        │ turn/completed
                        ▼
               drain/coalesce queue
```

Recommended invariants:

```text
I1  At most one active turn per target thread.
I2  A mail ID is never acknowledged before successful Codex acceptance.
I3  Duplicate delivery is safe.
I4  Events are ordered per recipient.
I5  Bursts are coalesced within a short window.
I6  A poisoned event cannot block later events indefinitely.
I7  Human input has priority over routine mailbox updates.
I8  Monitor commands never inherit unrestricted execution by accident.
I9  Thread ID, project bus and agent identity are bound together.
I10 Resume failure does not silently create a new unrelated identity.
```

Suggested batching:

```text
first event arrives
wait 250–750 ms
collect additional lines
cap by count and byte size
deliver one envelope
```

Do not send every bookkeeping transition as its own turn. Your sample has repeated correction messages and several task-state transitions in seconds. Per-line wake would produce unnecessary model churn even with a perfect native monitor.

A deterministic filter can collapse:

```text
claimed → completed → closed
```

into:

```text
Task ap-2uu.7 was claimed and completed.
Tasks ap-2uu.5 and ap-2uu.6 were closed.
Identity correction: PlumTiger and AmberOtter refer to the same agent.
```

Keep the original IDs attached so the agent can inspect raw messages when needed.

---

# 6. `codex exec resume` shim: easier, weaker, still viable

A simpler process supervisor can react to an event by resuming a persistent session:

```bash
codex exec resume "$THREAD_ID" "$EVENT_MESSAGE"
```

Conceptually:

```bash
agent-mail watch --after "$cursor" |
while IFS= read -r event; do
  flock "$lockfile" \
    codex exec resume "$thread_id" \
    "New agent-mail event: $event"
done
```

This works best when:

- There is no concurrent interactive turn.
- The thread is known and durable.
- Events are infrequent.
- You serialize invocations with `flock`.
- You tolerate spawning a Codex process per event.

It is inferior to a long-lived App Server because:

- Startup and session-resume overhead happens repeatedly.
- Concurrent resume operations can race.
- It is harder to distinguish active versus idle.
- It cannot cleanly steer a currently running turn.
- Recovery from missing or invalid rollout state needs explicit handling.
- A separate `exec` session may not appear or behave exactly like the live Desktop/TUI thread.

There are documented App Server reports where `thread/resume` fails because the rollout was not materialized, as well as ambiguous error behavior where “thread missing” and configuration failures can share the same JSON-RPC error code. A supervisor must not blindly interpret every resume failure as permission to start a fresh thread. ([GitHub][8])

Use this as a small deployment shim, not as your ultimate control plane.

---

# 7. `tmux send-keys`: it works, but only as terminal automation

A mux-level shim can inject text into an idle Codex TUI:

```bash
tmux send-keys -t codex:amber \
  "[agent-mail #27921] closed ap-2uu.6-agent-surface-collapse" Enter
```

This may be acceptable for a personal setup where you fully own the pane. It has one attractive property: it targets the exact interactive instance you are looking at.

But it has serious semantic deficiencies:

- It cannot reliably tell whether the composer is ready.
- During an active turn, text may enter the composer, steer, queue, or interfere with another interaction depending on current TUI behavior.
- Modal dialogs, approvals, slash-command menus, and terminal focus break assumptions.
- Terminal escape handling and pasted multiline content require care.
- There is no delivery acknowledgment tied to a Codex thread/turn ID.
- Pane identity is not agent identity unless you maintain that mapping.
- Reconnection or TUI restart can leave the watcher targeting a stale pane.
- Duplicate delivery recovery is awkward.

A less fragile mux approach uses a tiny “inbox indicator” rather than submitting automatically:

```text
mail event → tmux status badge → human/agent drains at safe point
```

But that gives up autonomous wake.

I would rank `send-keys` below App Server and above model-driven polling.

---

# 8. Hooks help with draining, not waking

Codex now has a substantial hook framework, including:

- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SubagentStop`
- `SessionStart`
- `SessionEnd`
- compaction hooks

Hooks can run deterministic scripts and modify behavior at lifecycle boundaries. ([OpenAI Developers][9])

A `UserPromptSubmit` hook can efficiently drain pending agent mail whenever the user next sends a prompt:

```text
human submits prompt
        ↓
hook reads mail after cursor
        ↓
pending events appended as context
        ↓
normal turn starts
```

This is useful as a **reconciliation backstop**. It prevents events from remaining invisible forever.

It does not solve idle wake because hooks run when an existing Codex lifecycle event fires. The mailbox event itself does not trigger `UserPromptSubmit`, `Stop`, or another hook.

Similarly, a `Stop` hook can check whether pending mail exists just as a turn ends and potentially encourage continuation, but it cannot respond to mail that arrives ten minutes later while the session remains idle.

A good design uses hooks for:

- startup catch-up,
- pre-turn drain,
- post-turn queue reconciliation,
- audit logging,

while using App Server or the native fork for wake-up.

---

# 9. MCP does not currently supply the missing inbound channel

MCP creates a tempting design:

```text
mail bus → MCP resource notification → Codex wakes
```

But the requested behavior is still explicitly tracked as missing: inbound MCP notifications are not generally routed into an idle active CLI session as turn-triggering user-equivalent input. The event-driven wake proposal calls out MCP push subscriptions as one of the blocked use cases. ([GitHub][10])

An MCP tool such as:

```text
agent_mail.read_pending()
```

is useful when the model is already running. It does not make the model run.

This is the same distinction as:

```text
pull tool available ≠ push ingress available
```

---

# 10. There are really three separate Codex feature gaps

The discussions often mix three problems:

### A. Human observability

> “Can I see what the background terminal is doing?”

Requests include full logs, `/attach`, `/logs`, and a `/ps`-like process dashboard. The current `/ps` summary is considered insufficient for long ML jobs and other verbose processes. ([GitHub][11])

### B. Model-efficient waiting

> “Can Codex wait without repeatedly spending full turns?”

This is the `write_stdin` polling-cost issue. ([GitHub][2])

### C. Event-driven agent wake

> “Can an external event schedule a new turn in the same session?”

This is the exact `Monitor`, event-source, and subprocess-completion issue. ([GitHub][10])

A live log TUI can solve A without solving B or C. A longer local `write_stdin` timeout can mitigate B without solving C. Your agent-mail use case requires C.

Gemini’s wording around a “dedicated interactive TUI stream-filter/trigger workflow” conflates these layers.

---

# 11. Relevant issue map

The tracker discussion is unusually coherent:

| Issue    | Actual concern                                              |
| -------- | ----------------------------------------------------------- |
| `#29922` | Agent-callable native `monitor` tool; working fork          |
| `#20312` | Durable config-declared external event source               |
| `#13733` | Full-history token cost of `write_stdin` polling            |
| `#15723` | Background process/subagent completion does not wake caller |
| `#17737` | Claude-like monitoring surface                              |
| `#28144` | Goal wait/wake without token expenditure                    |
| `#10685` | Human-facing background-process progress panel              |
| `#16935` | Attach to or view full logs of background terminal          |
| `#4751`  | Stream real-time command output in TUI                      |
| `#25914` | Discover/attach to active app/Desktop thread                |

The most important design distinction raised in `#29922` is between:

- an **ephemeral agent-created monitor**, scoped to one session; and
- a **durable external event source**, configured by the operator with a persistent cursor.

Your `agent-mail-monitor` is arguably closer to the second design because the bus, recipient identity, cursor, and restart behavior should survive a session. But allowing the model to establish temporary filtered watches is also useful. ([GitHub][4])

A mature implementation may want both:

```text
durable ingress:
  all AmberOtter mail enters supervisor

ephemeral subscription:
  model asks to wake only on completion/failure for ap-2uu.7
```

---

# 12. Recommended choice for your environment

## Best immediate engineering answer

Run a dedicated App Server per agent appliance, with your watcher/control plane owning:

```text
agent name
project bus path
Codex thread ID
mail cursor
turn state
delivery queue
```

Use:

```text
turn/start  when idle
turn/steer  when active and urgent
local queue when active and non-urgent
```

Connect the TUI remotely to the same App Server when you want interactive visibility. Keep the App Server behind a Unix socket locally or authenticated secure transport remotely. App Server’s network-facing modes are experimental, and official documentation recommends TLS termination or a secure proxy for secure WebSocket access. ([OpenAI Developers][6])

## Best parity answer

Port or track the `monitor-tool` fork. It provides the cleanest agent ergonomics:

```text
the agent itself can say:
“Watch my mailbox for relevant messages while I continue.”
```

But add durable mailbox cursoring outside the monitor process. The reference patch deliberately treats watches as ephemeral and ends them with the session. ([GitHub][4])

## Best tiny shim

Use serialized `codex exec resume` calls with:

- `flock`,
- a durable cursor,
- event coalescing,
- idempotency IDs,
- active-process detection,
- a dead-letter file,
- a maximum batch size.

## Avoid as the primary mechanism

- Prompting the model to poll.
- One model turn per mailbox line.
- Depending only on Codex hooks.
- Assuming MCP notifications wake Codex.
- Blind `tmux send-keys` without pane/readiness state.
- Starting a new Codex thread whenever resume fails.

---

# Bottom line

A precise replacement for Gemini’s answer would be:

> Released Codex does not yet provide a first-class Claude-style `Monitor` tool or general external-event wake primitive. Its ordinary background-process polling can be token-expensive because checks may cause full model turns with the session history. However, a working native-style Codex fork exists, and stock Codex can support a strong event-driven shim when a supervisor owns an App Server thread and converts ticker events into `turn/start` or `turn/steer` calls. Hooks, `/ps`, MCP tools, notification scripts, and terminal stream views are adjacent features, but none by themselves wake an idle Codex session. Injecting events into an arbitrary already-running TUI remains the awkward part.

For your planned control plane, **App Server ingress is the least brittle stock solution; the `monitor-tool` fork is the closest functional match to Claude.**

[1]: https://github.com/openai/codex/issues/15723 "Background subprocesses/subagents do not wake the calling agent on completion · Issue #15723 · openai/codex · GitHub"
[2]: https://github.com/openai/codex/issues/13733 "Background process polling wastes tokens: each write_stdin poll triggers full API turn with complete history · Issue #13733 · openai/codex · GitHub"
[3]: https://github.com/openai/codex/issues/7932?utm_source=chatgpt.com "Codex CLI: Background Process Leak + Missing Job Control"
[4]: https://github.com/openai/codex/issues/29922 "Feature: an agent-callable `monitor` tool that wakes Codex on background events (logs, files, builds, CI) without polling · Issue #29922 · openai/codex · GitHub"
[5]: https://developers.openai.com/codex/app-server "Codex App Server | ChatGPT Learn"
[6]: https://developers.openai.com/codex/developer-commands "Developer commands | ChatGPT Learn"
[7]: https://github.com/openai/codex/issues/25914?utm_source=chatgpt.com "Document how app-server clients can discover and attach ..."
[8]: https://github.com/openai/codex/issues/16872?utm_source=chatgpt.com "app-server websocket shared-thread turns complete but ..."
[9]: https://developers.openai.com/codex/hooks "Hooks | ChatGPT Learn"
[10]: https://github.com/openai/codex/issues/20312 "Feature request: native event-driven session wake primitive · Issue #20312 · openai/codex · GitHub"
[11]: https://github.com/openai/codex/issues/10685 "Show background process progress (similar to /agents) · Issue #10685 · openai/codex · GitHub"
