---
name: wiring-a-product-bus
description: Wire N repos into ONE Agent Mail "product" bus so a single identity sees its mail merged across every linked project, ordered by created_ts — and register that identity in every linked project up front so no project's mail is silently dropped. Use when asked to "watch mail across multiple repos", "set up a product bus", "link these projects for agent-mail", "one inbox for all my projects", "cross-project mail", "am products ensure/link", or before running `agent-mail product` / `AGENT_MAIL_PRODUCT` for the first time on a new set of repos.
allowed-tools: Bash Read
---

# Wiring a product bus

A **product** is Agent Mail's native primitive for cross-project read
aggregation: it links N projects so that one identity's mail, sent to it in
*any* linked project, shows up in a single merged stream. This is the
`agent-mail product` command's data source (`AGENT_MAIL_PRODUCT` /
`--product`) — see the vault note "Agent Mail inbox topology (ground truth)"
(`design/agent-mail-inbox-topology.md`) for the full ground-truth (SQL join,
source anchors). This skill only covers **wiring**: getting the product, its
linked projects, and your identity's registrations all in place *before* you
point a watch at it.

Do the three wiring steps in order, once per product. All three commands are
idempotent — safe to re-run.

## 1. Ensure the product exists

```bash
am products ensure <PRODUCT_KEY> [--name "<display name>"]
```

`<PRODUCT_KEY>` is a slug you choose (not a path) — it is the value you will
later pass as `--product`/`AGENT_MAIL_PRODUCT`. Running `ensure` again for a
key that already exists is a no-op.

### Naming rule: work-descriptive, never operator-descriptive

A product groups **repos** — the workload — never the human running them. Name
the key for the work it spans (`everything-ecosystem`, `mobbin-frontend-suite`),
and never for the operator (no name, email, or handle: `gulp-repos` and
`yekta-projects` are both wrong for the same reason).

The leak vector is narrow but real: the product itself only ever links
project-keys (repo paths), which is already privacy-safe — the *key's name* is
the one place operator identity can sneak back in. This mirrors the discipline
Agent Mail already enforces on agent names (identity/role-descriptive names are
rejected in favor of a random adjective+noun, see `register_agent`): identity
stays scoped to the workload, not the person operating it.

This isn't a local convention — it's the same shape as two established identity
models:

- **[SPIFFE](https://spiffe.io/)** issues identity to *workloads* (a
  `spiffe://trust-domain/workload` URI), never to the human or team that
  deployed them. An Agent Mail project key is the workload-scoped analogue of a
  SPIFFE trust domain.
- **[W3C `did:wba`](https://www.w3.org/TR/did-wba/)** mints a DID for the
  *web-based agent* itself (anchored to the domain it runs on) — the human
  operating it never becomes a DID subject, stays above the identity graph
  entirely.

Both converge on the same rule this skill enforces: identify the workload, not
the person. **Do not build an operator roster** (a `roster.jsonl` or any file
mapping a human to their N agent identities) to make product-key naming
"friendlier" — that file is exactly the identity-exposure move the naming rule
exists to prevent, out of scope for this skill by design.

## 2. Link every repo into the product — once per repo

```bash
am products link <PRODUCT_KEY> <PROJECT>
```

Run this **once per repo** you want aggregated. `<PROJECT>` is that repo's
Agent Mail project key — the absolute working-directory path used elsewhere
in this plugin (`ensure_project`/`register_agent`'s `project_key`), or the
slug it was registered under. Repeat for every repo; there is no batch form.

Check what's linked at any point with:

```bash
timeout 15s am products status <PRODUCT_KEY> --json
```

**Always wrap `am products status` in `timeout`** — a bad or unresolvable
product key is a known hang, not a fast error.

## 3. Register your identity in EVERY linked project — closes the gap by construction

```bash
am agents register --project <PROJECT> --name "<YourName>" \
  --program <your-program> --model <your-model>
```

Run this **once per linked repo**, with the **same name** each time. This is
the step that matters most and is easiest to skip.

**Why it's mandatory, not optional.** Per the topology design note, the
product-inbox query joins `product_project_links → agents → messages`,
filtering `agents.name = ?` per linked project. A project that's linked into
the product but has no `agents` row for your name contributes **zero**
messages to the aggregated stream — silently, with no error. Doing step 3 for
every repo *as part of wiring* — rather than after noticing missing mail —
closes that gap by construction instead of leaving it for
`agent-mail-monitor:doctor` to catch later. Doctor's `product` check (see
`resources/product-registration-gap.md` and the `agent-mail-monitor:doctor`
skill) exists precisely to catch this when wiring skipped it — treat a
doctor `FAIL` on registration as "step 3 was missed for some project," not a
new problem to diagnose from scratch.

## Verify before watching

```bash
timeout 15s am products status <PRODUCT_KEY> --json   # confirms every repo is linked
timeout 15s am agents list --project <PROJECT> --json # per repo: confirms your name is present
```

Once every linked project's agent list contains your name, point a watch at
it:

```bash
AGENT_MAIL_PRODUCT=<PRODUCT_KEY> AGENT_NAME=<YourName> "${CLAUDE_PLUGIN_ROOT}"/agent-mail product --agent <YourName>
```

(or use the `agent-mail-monitor:toggle` skill / `agent-mail-monitor:doctor`
skill, which both understand product mode via `$AGENT_MAIL_PRODUCT`.)

## How ordering works: `created_ts` aggregation

The product inbox does not merge by per-project message id — ids are only
locally monotonic within one project's `messages` table, so they are not
comparable across projects. Instead the merged stream is ordered by
`created_ts` (`ORDER BY created_ts DESC, id DESC`), and the watch frontier
(`--since-ts`, an ISO-8601 string, compared strictly `>`) is the newest
`created_ts` seen so far across *all* linked projects — not a per-project
watermark. Practically: a message created a moment earlier in repo A can
appear before a message created a moment later in repo B, but the overall
order across the whole bus is by creation time, not by which repo it came
from or its per-repo id. See the topology design note's "Two facts that
change any watcher's design" section for the full detail, including the
microsecond-tie edge case.

## Common mistakes

- **Linking a repo but skipping step 3 for it.** The repo shows up in
  `products status`, so it *looks* wired, but your identity silently gets no
  mail from it. Always pair `products link` with `agents register` for the
  same repo in the same pass.
- **Registering under a different name in different repos.** The join is on
  exact name (`COLLATE NOCASE`) — a typo'd or role-varying name in one repo
  is functionally the same as never registering there.
- **Treating `am products status` as instant.** A bad key can hang; always
  `timeout 15s` it.
- **Naming the product key after the operator.** `gulp-repos` or an email/handle
  re-introduces the exposure the workload-scoping is meant to prevent — name the
  key for the work (see "Naming rule" under step 1), and never reach for a
  roster file to compensate.
