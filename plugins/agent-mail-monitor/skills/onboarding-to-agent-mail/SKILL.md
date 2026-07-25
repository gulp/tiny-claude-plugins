---
name: onboarding-to-agent-mail
description: Walk a brand-new user or agent from zero to a working Agent Mail setup — declare the MCP connection via `am setup`, verify the wiring with the `am agent` cockpit, register a durable identity with `am agents register`, and arm the background watch. Every step is idempotent and safe to re-run. Use when onboarding to Agent Mail for the first time, when asked to "set up agent mail", "connect agent mail", "register my agent mail identity", "get the agent mail MCP working", "I'm new to agent mail, what do I do", or "am I wired up for agent mail".
---

# Onboarding to Agent Mail

Four commands take a fresh checkout from "nothing configured" to "identity
registered and watch armed." Every command below is native `am` — this skill
sequences them and explains what each answer means; it does not reimplement
any of them.

## 1. Declare the MCP connection — `am setup`

**Never hand-write the MCP server JSON.** `am setup` detects installed coding
agents (Claude Code, Codex CLI, Cursor, Gemini CLI, …) and writes the correct
MCP config for whichever ones are present.

```bash
am setup status                      # read-only: what's detected, what's missing/drifted
am setup run --dry-run --agent claude   # preview the exact write, no side effects
am setup run --yes --agent claude       # apply it
```

- `am setup` with **no subcommand** just prints help — despite `run` being
  labelled "(default subcommand)" in its own `--help` text, it is not invoked
  implicitly; always type `run` explicitly.
- Drop `--agent claude` to target every detected agent at once, or swap in
  `codex` / `cursor` / `gemini` / etc.
- Re-running `am setup run --yes` on an already-configured agent is a no-op —
  `am setup status` will show `DRIFT: ok` / `no action` for anything already
  correct.

## 2. Open the cockpit — `am agent start`

This is the first-turn cockpit: identity, project, runtime hints, and the
exact next-action commands, computed live and side-effect-free.

```bash
am agent start
```

Read the `CHECK` table top to bottom. Right after step 1, expect:
- `project_path` / `project_slug` — **pass** (the cwd resolves fine on its own).
- `mcp_endpoint` — **pass** once `am setup` has wired the connection.
- `agent_identity` — **fail**, with `<missing>` for `Agent` — this is expected
  before step 3; the `COMMAND` column shows a suggested fix.

`am agent start --json` gives the same cockpit as a parseable envelope
(schema `am.agent_start.v1`) if you want to script against it.

## 3. Register a durable identity — `am agents register`

**Check whether you should reuse one first.** A project often already has
identities registered from earlier sessions or other agents — minting a new
one mints a new **empty** mailbox and orphans anything the old identity held.
List the candidates before deciding to mint fresh:

```bash
am agents list --project "$(pwd)"
```

If one of those is *yours* from a prior session, reuse its name verbatim
below instead of generating a new one. Only mint fresh if none fits (a
genuinely new agent, or a genuinely new project). The `agent-mail-monitor:doctor`
skill runs this same lookup automatically whenever `AGENT_NAME` is unset — see
step 5.

```bash
am agents register \
  --project "$(pwd)" \
  --program claude-code \
  --model <your-model-id> \
  --name <AdjectiveNoun>          # omit to auto-generate a valid one
```

- **`--project` is the absolute cwd** — Agent Mail's `project_key` is the
  working-directory path, not a slug you choose. Two agents in the same
  directory are automatically the same project; a sibling repo is a
  different one.
- **Name must be Adjective+Noun and non-descriptive** (`BlueLake`, not
  `MigrationWorker` — `BlueLake` here is just a format example, not a name to
  assume is free or already registered) — the server rejects role-descriptive
  names. If you omit `--name` entirely, one is generated for you.
- **Reuse the returned name verbatim on every later wake**, this session and
  every future one in this repo. Re-omitting `--name` on a later run mints a
  *new* identity and silently orphans anything the old one held (mail,
  reservations). Write it down or export it as `AGENT_NAME` at launch time —
  a mid-session `export` inside a tool call does not persist back to the
  parent session.
- `am agents register --help` documents this command as **idempotent**:
  running it again for a project/name you're already registered in updates
  the record rather than erroring — this is the command to re-run any time
  you're unsure whether registration already happened.

Confirm it landed by re-running `am agent start` — `agent_identity` should
now read `pass` and the `Agent ready` line should flip to `yes`.

## 4. Arm the watch

Registration does not start notifications by itself. To arm the background
inbox watch for this session, use the sibling skill
**`agent-mail-monitor:toggle`** — it owns the mechanics (which Monitor to
start, what `AGENT_NAME`/`MAIL_POLL_INTERVAL` it reads, how to silence it
again); this skill does not restate them.

## 5. Optional preflight

Before or after the flow above, either of these read-only checks can catch
problems early:

- **`agent-mail-monitor:doctor`** — the plugin's own preflight skill: checks
  the `am` CLI, `jq`, server reachability, `am health`, the MCP declaration,
  and `AGENT_NAME`, with a fix guide linked for each failure. When
  `AGENT_NAME` is unset it also lists every identity already registered in
  this project (name, model, last-active) so you can reuse one instead of
  minting a new mailbox — the same check step 3 above points at.
- The plugin's bundled CLI also exposes a narrower `doctor` command, useful
  in **product-bus** setups (`$AGENT_MAIL_PRODUCT` set) to catch a registered
  identity that's missing from a *linked* project — see
  `../../resources/product-registration-gap.md`:

  ```bash
  deno run --allow-run=am --allow-env --allow-read \
    "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" doctor
  ```

## Idempotent by construction — safe to re-run

Nothing in this flow is destructive, and none of it needs a "have I already
done this?" check first:

- `am setup run --yes` only writes what's missing or drifted; already-correct
  agents report `no action`.
- `am agents register` explicitly updates-or-creates rather than erroring on
  an existing identity.
- `am agent start` is read-only and side-effect-free by design.

Run the whole sequence again any time you're unsure of the current state —
worst case it confirms what was already true.
