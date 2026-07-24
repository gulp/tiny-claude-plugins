# Agent Mail service — recovery actions

`diagnose.sh` is read-only. These are the **mutations** it points at, run only
after the VERDICT names one. Each changes shared state — confirm with the human
first (other agents share this server).

## WEDGED — restart the unit

VERDICT `WEDGED` means the process is alive and holds `:8765`, but the HTTP
transport did not answer within 5s. Because the port-holder **is** the unit's
Main PID (the `port` probe confirmed this), a restart is clean — no orphan, no
`EADDRINUSE`:

```bash
systemctl --user restart mcp-agent-mail.service
```

Then re-run `diagnose.sh` — VERDICT should be `HEALTHY` (curl answers fast).

> Do **not** decide "wedged" from `am status` timing out. `am status` /
> `am robot status` take 1.3–15.8s on a *healthy* server (heavy synthesis), so a
> short timeout on them is a false wedge. Trust the `http` (curl) probe.

## DEAD — start the unit

VERDICT `DEAD` means the unit is not `active`, or nothing holds `:8765`:

```bash
systemctl --user start mcp-agent-mail.service
```

## ORPHAN — a non-managed process holds the port

VERDICT `ORPHAN` means `:8765` is held by a pid that is **not** the unit's Main
PID (e.g. a hand-launched `mcp-agent-mail serve` left over from a crash). A plain
restart will fail with `EADDRINUSE`. Identify and stop the orphan first, then
restart:

```bash
ss -ltnp | grep 8765          # find the pid holding the port
kill <orphan-pid>             # stop the un-managed holder
systemctl --user restart mcp-agent-mail.service
```

## DEGRADED — corrupt archive git repo (separate, HUMAN-RUN)

The `archive` probe WARNs when `~/.mcp_agent_mail_git_mailbox_repo` has empty git
objects — the server logs an archive-maintenance WARN every tick, but it is **not**
a wedge and a restart does **not** fix it. Repairing it deletes files under
`/home`, which the agent guard blocks; a human runs it from a plain terminal, with
the server stopped so nothing writes mid-repair:

```bash
systemctl --user stop mcp-agent-mail.service
cd ~/.mcp_agent_mail_git_mailbox_repo
find .git/objects -type f -empty -delete   # drop the empty/corrupt loose objects
git fsck --full                            # confirm the object store is consistent
systemctl --user start mcp-agent-mail.service
```

If `git fsck` still reports missing/broken objects after the empty-object sweep,
the archive may need re-initialisation — capture the `fsck` output and decide with
the human; do not force-init blindly (it discards archived mail history).

## Durable fix (companion work)

A wedged-but-alive server never exits, so the unit's `Restart=on-failure` never
fires — which is why a wedge can persist for days. The durable fix is a
liveness-based watchdog (a `mcp-agent-mail-health.timer` probing the **HTTP** path
— curl, never `am status` — plus a `MemoryMax=`/`OOMPolicy=` cap). That is tracked
separately as the systemd-watchdog work; this skill only diagnoses and points at
the manual recovery.
