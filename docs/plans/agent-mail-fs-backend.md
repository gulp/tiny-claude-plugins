# Plan: unified canonical git-mailbox watch backend

**Status:** proposed · **Supersedes beads:** `tcp-p0x.6`, `tcp-p0x.14` · **Epic parent:** `tcp-p0x`

## Destination

The `agent-mail-monitor` watch reads new mail from the **append-only canonical
git-mailbox on disk**, watermarks by message id, and notifies — across **one, all,
or a product-scoped subset** of the identity's projects, tagging each notification
with the source project. `am check-inbox` is removed from the notification path.

One backend swap collapses two separately-filed features (`tcp-p0x.6`
cross-project watch, `tcp-p0x.14` FS backend) and dissolves three separately-filed
bugs (consuming, DB-desync blind spot, transport hole) — because the elegant
insight is that they share a single root cause.

## Background: one root cause

The current watch polls `am check-inbox --agent <A> --project <dir>` (`src/core/am.ts`
`pollInbox`). Two structural problems flow from that one choice:

1. **`check-inbox` consumes.** Source-verified against am v0.3.21: without
   `--direct` the call unconditionally takes the daemon path and invokes the
   server's `fetch_inbox`, whose contract is "retrieve recent messages **and mark
   returned messages read**." A daemon is normally up, so **every poll marks the
   returned mail read** and steals it from a later interactive
   `fetch_inbox(unread_only)`. The genuinely read-only SELECT path needs `--direct`
   AND no daemon — the plugin passes neither. (Full trace:
   `design/agent-mail-watch-canonical-backend.md` in the everything vault.)

2. **`check-inbox` is single-project.** Its only scoping flag is `--project` (one
   key). An identity that receives mail in more than one project is watched in
   exactly one; the rest is a silent blind spot. This bit for real — WindyBarn's
   monitor was pinned to `tiny-claude-plugins` while its coordination thread lived
   in the vault project, and the replies never reached the monitor.

**Both vanish** by reading the append-only canonical store instead:

- Every `send_message` writes the recipient inbox `.md` at delivery time
  (`<ROOT>/projects/<slug>/agents/<Agent>/inbox/YYYY/MM/<ts>__<subject>__<id>.md`),
  independent of SQLite. OS file reads never touch `read_ts` → **genuinely
  read-only**. The `.md` exists the instant the message is delivered →
  **desync-immune**. Append-only, watermark by id → **no unread-only filter, no
  disappearing rows** (kills the `tcp-p0x.12` transport hole too).
- Cross-project falls out of the layout for free: `projects/<slug>/…` already
  partitions by project, so "watch an identity across all its projects" is
  globbing more `<slug>` dirs, not a new am API mode.

## The prototype already exists and was dogfooded

`src/core/mailbox.ts` (`snapshotMailbox`) reads the git-mailbox layout, parses the
id off the filename tail (anchored regex; regression-tested in
`src/core/mailbox_test.ts`, including the `___<id>` edge case), and is read-only at
the OS level. `src/commands/shadow.ts` (Part A) already emitted `MAIL #<id>` off
this store and fired correctly live (msgs 27657/27660/27661). This plan **promotes
Part A from prototype to the production watch backend** and generalizes its scope.

`ROOT` = `$AGENT_MAIL_MAILBOX_ROOT` or `~/.mcp_agent_mail_git_mailbox_repo`; `<slug>`
= the project cwd path with non-alphanumeric runs collapsed to `-`, lowercased
(`slugForProject` in `mailbox.ts`, matches am's dir-mode slugging, unit-tested).

## Design

### Watch loop
Replace `pollInbox` in the notification path (`monitor` / `watch` / `product`
subcommands, wired in `src/cli.ts`) with a `snapshotMailbox`-based poll:
- On arm, seed the watermark from the current max id across the in-scope inbox dirs
  (adopt-without-replay — only mail arriving after launch notifies).
- Each interval, snapshot the in-scope dirs, emit one notification per new file
  whose id exceeds the watermark, advance the watermark.
- Notification line carries the source `<slug>` (delivers `tcp-p0x.6`'s tagging AC).

### Scope config
`MAIL_WATCH_SCOPE = project | all | product` (env), default **`project`**
(back-compat: today's single-project behavior, nothing regresses):
- `project` — the current `CLAUDE_PROJECT_DIR` slug only.
- `all` — every `projects/<slug>` dir that has an inbox for this `$AGENT_NAME`.
- `product` — a configured/linked subset; `MAIL_PRODUCT=<key>` names it. (May
  land after `all` — it is the narrower case.)

### check-inbox retirement
Remove `pollInbox` from the notification path entirely. Do **not** reintroduce it
as a "read" — the only non-consuming shape (`--direct` + no daemon) is not worth
coupling to. Keep the `am.ts` adapter only if the doctor cross-check needs a
verified-non-consuming SQLite read (see below).

### Doctor health check
The git-mailbox layout is am's **private on-disk contract**. Guard the coupling:
a `doctor` check resolves the mailbox root and verifies the layout parses — failing
**loud** if the private layout shifts, never silent. Repurpose shadow Part B (the
divergence detector) as an **optional, on-demand** desync cross-check: canonical
store vs a re-verified-non-consuming SQLite read, flagging when SQLite lags
canonical. Never in the notification path; must not consume.

### Convergence gate (out of scope now, noted for durability)
When upstream ships a non-consuming `since-ts` cursor over delivered mail (the
Product Bus, `am products inbox --since-ts`), swap the FS reader for that committed
API and keep the FS reader as the daemon-agnostic / offline fallback. That is the
graduation from interim coupling to committed contract — **not** this plan's work.

## Decomposition (intended beads under a fresh epic)

New epic **E**: *unified canonical git-mailbox watch backend* (supersedes
`tcp-p0x.6`, `tcp-p0x.14`). Priority P1.

1. **T1 — promote `snapshotMailbox` to the watch loop.** Replace `pollInbox` in the
   single-project `monitor`/`watch` path with an id-watermarked `snapshotMailbox`
   poll; adopt-without-replay on arm. *AC:* arming notifies on a new file in the
   current project's inbox and never marks mail read (verify `read_ts` unchanged);
   empty inbox arms cleanly (no exit 4). *The foundation — everything blocks on T1.*
2. **T2 — scope config `MAIL_WATCH_SCOPE=project|all|product`.** Env parsing + slug
   resolution; `all` globs every inbox dir for `$AGENT_NAME`. *AC:* default
   `project` is byte-identical to T1 behavior; `all` notifies for mail in any of
   the identity's projects. *blocks-on T1.*
3. **T3 — source-project tagging in the notification line.** Emit `<slug>` per
   notification. *AC:* a notification names which project the mail landed in
   (delivers `tcp-p0x.6` AC). *blocks-on T2.*
4. **T4 — retire `check-inbox` from the notification path.** Remove `pollInbox`
   from `watch`/`product`/`monitor`; update `cli.ts` wiring; keep `am.ts` only if
   T5 needs it. *AC:* no notification path shells out to `check-inbox`; grep proves
   it. *blocks-on T1.*
5. **T5 — doctor mailbox-layout health check + desync cross-check.** Resolve root,
   verify layout parses, fail loud on drift; repurpose shadow Part B as on-demand
   desync flag. *AC:* doctor fails loud if the mailbox root is missing/unparseable;
   the cross-check never consumes. *blocks-on T1.*
6. **T6 — retract residual read-only claims; state the backend is now truly
   read-only.** Sweep the last surfaces (`.claude-plugin/plugin.json` self-desc,
   `watch-mail.sh:41` usage string) and, once T4 lands, restate the notification
   path as genuinely non-consuming. *AC:* grep finds no false read-only claim; the
   accurate claim ("FS backend is read-only") is present. *blocks-on T4.*

Starting leaf: **T1**. T2, T4, T5 gate on T1; T3 gates on T2; T6 gates on T4.

## Not yet specified
- `product` mode's exact config surface (link discovery vs explicit `MAIL_PRODUCT`).
  Ticketed as part of T2 but may split if link-discovery is non-trivial.

## Decided
- **`watch-mail.sh` (the bash path): DEPRECATED in place, not ported.** (tcp-ald,
  2026-07-25.) T4 landed without resolving this (correctly parked as its own
  decision); by the time it was picked up, `monitors/monitors.json` already armed
  only the Deno `src/cli.ts monitor` entrypoint and the `toggle` skill (tcp-p0x.3)
  already pointed users at it — nothing live referenced `watch-mail.sh` anymore.
  Porting would mean maintaining a second, hand-rolled FS-mailbox parser in bash
  alongside the tested Deno one for no user-facing benefit. `watch-mail.sh` is
  left on disk (dcg blocks `rm` under `/home`; physical removal is human-only)
  with a strengthened DEPRECATED header/usage notice — it still shells out to
  `am check-inbox` and still consumes if invoked by hand.

## Out of scope
- Upstream am `peek`/`--no-mark` mode (separate am issue).
- Product Bus `since-ts` convergence (future gate, above).
- The exit-4 empty-inbox guard and read-only doc sweep on the *check-inbox* backend
  — already landed (commits `32a4393`, `9544e85`, `806f922`) as interim correctness
  while this backend is built.
