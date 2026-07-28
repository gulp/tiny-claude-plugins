# Codex remote-TUI multi-client characterization

Date: 2026-07-29  
Bead: `tcp-efp.1.3` (S2a)  
Conclusion scope: characterization only; this is not evidence that independent
clients can safely co-control a thread.

## Version provenance

The acceptance baseline remained pinned after explicit coordination with
CobaltJaguar. The installed version was evaluated separately and observations
were not merged.

| Label | Invocation | Native binary SHA-256 | Source |
|---|---|---|---|
| acceptance baseline | `npm exec --yes --package=@openai/codex@0.144.6 -- codex` | `a31ae9450a26216eb1e7c53102fd42123dd675974310b0e2ca3aa4cb622a2c15` | `openai/codex` tag `rust-v0.144.6`, commit `5d1fbf26c43abc65a203928b2e31561cb039e06d` |
| drift comparison | installed `codex-cli 0.145.0` and explicit `@openai/codex@0.145.0` resolution | `a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14` | npm release 0.145.0 |

The observer used
`plugins/agent-mail-monitor/tests/codex-remote-tui-characterization.ts`.
It records monotonic nanosecond timestamps and raw inbound/outbound WebSocket
frames, deliberately answers no server requests, and can either discover a new
TUI thread or target an explicit thread ID.

## 0.144.6 acceptance baseline

### External turns render live

Commands:

```bash
npm exec --yes --package=@openai/codex@0.144.6 -- \
  codex app-server --listen ws://127.0.0.1:45678

deno run --allow-net \
  plugins/agent-mail-monitor/tests/codex-remote-tui-characterization.ts \
  ws://127.0.0.1:45678

npm exec --yes --package=@openai/codex@0.144.6 -- \
  codex --remote ws://127.0.0.1:45678 --no-alt-screen
```

The observer saw the TUI's `thread/started` notification for thread
`019faaba-8779-7190-8841-a94cf1f461ca`. A second observer connection sent:

```json
{"id":2,"method":"turn/start","params":{"threadId":"019faaba-8779-7190-8841-a94cf1f461ca","input":[{"type":"text","text":"Reply exactly S2A_EXTERNAL_RENDER_OK. Do not call tools.","text_elements":[]}]}}
```

App Server accepted turn `019faabb-00e5-7431-ad54-c606ff2dbb0b`.
The already-open stock remote TUI rendered both the externally originated user
input and the assistant response:

```text
› Reply exactly S2A_EXTERNAL_RENDER_OK. Do not call tools.
• S2A_EXTERNAL_RENDER_OK
```

Therefore live notification rendering is proven for 0.144.6. This says nothing
about safe server-request ownership.

### Fan-out is observable

With two initialized WebSocket clients connected before `thread/start`, both
received the same `thread/started` notification for
`019faab8-7572-78d1-a0bb-1f4c7068ecf4`; the requesting client separately
received the response to its request. Thread status notifications were also
visible on both connections. These are broadcast notifications, not an
arbitration contract.

### `currentTime/read`: source boundary proven, public two-subscriber branch unreachable

The server was started with:

```bash
-c features.current_time_reminder.enabled=true \
-c features.current_time_reminder.reminder_interval_seconds=1 \
-c 'features.current_time_reminder.clock_source="external"'
```

A turn produced the experimental request:

```json
{"method":"currentTime/read","id":2,"params":{"threadId":"019faabc-da89-73d2-b65f-6ff519578246"}}
```

The exact 0.144.6 implementation in
`codex-rs/app-server/src/current_time.rs` calls
`require_single_current_time_connection`. Its unit test proves:

```text
0 subscribers -> expected exactly one client subscribed to the thread, found 0
1 subscriber  -> selected
2 subscribers -> expected exactly one client subscribed to the thread, found 2
```

The two-subscriber branch was not reproducible through stock public clients.
Repeated public-protocol attempts showed that `thread/resume` on an already
loaded thread returns successfully without attaching another conversation
listener; the source auto-attaches only on its cold/new resume path. Consequently
the live request continued to target one subscriber.

The exact 0.144.6 source also establishes the response arbitration behavior
behind that unreachable branch. In
`codex-rs/app-server/src/outgoing_message.rs`,
`send_request_to_connections` allocates one request ID and one oneshot callback,
stores a single callback entry for that ID, then clones the same request to
every selected connection. Both successful and error responses call
`take_request_callback`, which atomically removes that sole entry before
delivering the result. Thus the first response consumes the callback; a later
response for the same ID finds no callback and is ignored with a warning. This
is exact-version source evidence, not a live stock-client reproduction.

This is an important negative result:

- the ambiguity rejection is exact-source and unit-proven;
- targeted request fan-out with first-response callback consumption is
  exact-source-proven;
- public stock clients could not create the second subscribed listener in this
  experiment;
- therefore S2a does **not** claim runtime reproduction of multi-client
  server-request routing or first-response-wins;
- a lower-level internal harness was intentionally rejected because it would
  characterize a non-stock seam.

Even with that public unreachability, independent co-control remains unsupported:
there is no public controller lease, observer role, or response arbitration
contract, and notification fan-out is not ownership.

## 0.145.0 drift comparison

The identical remote-TUI experiment was repeated on port 45680 using installed
`codex-cli 0.145.0`.

External rendering still passed. Thread
`019faabf-25b7-73c3-9612-e7186b7b6cef` rendered the externally originated
prompt and `S2A_EXTERNAL_RENDER_OK`.

Observed protocol drift, kept separate from the baseline:

- initialize identified App Server as 0.145.0;
- server notifications carried a new `emittedAtMs` envelope field;
- `thread/started` included `canAcceptDirectInput: true`.

No evidence from 0.145.0 changes the ownership conclusion. The acceptance gate
remains 0.144.6; these fields belong in the later protocol-skew compatibility
contract.

## Decision input

Stock remote TUI can display externally started turns, but rendering is not
control ownership. S2a provides no basis for an independent supervisor and TUI
to answer server requests concurrently. Any production option still needs one
explicit owner: exclusive handoff, a complete sole-client gateway, or native
integration.
