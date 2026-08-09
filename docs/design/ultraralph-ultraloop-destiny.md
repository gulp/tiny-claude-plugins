# ultraralph ↔ ultraloop — the destiny rulings

Design note from the 2026-08-09 alignment session (operator gulp ×
claude-fable-5, session `fe94f609-9b09-448b-9f14-75cdac58d625`; session named
"ultraralph"). Companion to `ultragoal-namespace-and-semantics.md` — that note
founded the ultraralph sibling and the suite convention; this one resolves the
overlap between ultraralph and the existing engine at `~/src/ralph-this`, and
names the engine. Every ruling below was made explicitly; the *Rejected*
subsections exist so nothing is re-litigated.

Rendered companions (published artifacts, private):
destiny + both bed scenarios `5a5a1bbf`, engine architecture `f12ad9a1`.

## Ruling 1 — "ralph" is technique vocabulary, never a product name

Verified 2026-08-09 against `snwfdhmp/awesome-ralph`: 13+ projects named
exactly `ralph`, two `ralph-wiggum` variants, `ralph-orchestrator`,
`ralph-tui`, `ralph-loop-agent`, Claude Code plugins. The word has become
vocabulary, like "lint" — every project on that list fights for a share of one
word, and the findable ones are the ones that added a distinguisher.

So: ralph stays lowercase, used in descriptions ("a ralph engine"), with
**Geoff Huntley credited as the technique's creator** — the same rule that put
Karpathy in `:automata`'s description rather than its namespace. We never
ship a product named `ralph`, and the `ralph` binary on PATH must go (it
collides mechanically with any of the list's installables).

## Ruling 2 — the engine is named **ultraloop**

`ralph-this` (the engine: `bin/ralph`, vendor-neutral `lib/loop.sh`,
three-function adapter contract, `.ralph/` bed, rootless-podman confinement
with admission control and egress pod, falsification gate harness) is renamed
**ultraloop**.

Why it wins:

- **Ownable.** Verified 2026-08-09: nothing named ultraloop exists in the
  agent-loop space (the domain is thick with `agent-loop`, `loopy`,
  `loop-engineering`, `ralph-loop-agent`; the only ultraloop anywhere is an
  unrelated indie game).
- **The semantics fit best of the whole suite.** ultra\* means "explicit
  opt-in to spend more"; an unattended loop that burns tokens until green is
  the purest instance of that meaning. The engine deserves the prefix more
  than any plugin does.
- **The family becomes self-describing**: ultragoal (arm a goal) →
  ultraralph (hand the failed rubric over) → ultraloop (the machine that
  grinds it). Three names, one vocabulary, each meaning exactly one thing.

**Recorded reversal** (challenge, not rewrite): the earlier ruling in this
session — "the engine takes no ultra\* vocabulary; it is harness-neutral" —
was aimed at naming the engine *ultraralph*, i.e. taking the plugin's name.
The operator's counter ("maybe simply ultraloop?") dissolved the real
objection: ultra\*'s *meaning* is not harness-bound, only its provenance is.
What was load-bearing survives: the engine does not take the ralph name, and
the technique credit lives in the tagline.

**Rename cascade** (executes in the engine repo, not here):

- repo `~/src/ralph-this` → `ultraloop`
- binary `ralph` → `ultraloop` (PATH collision with the list dissolves)
- bed dir `.ralph/` → `.ultraloop/` (with a dozen ralph tools in the wild,
  `.ralph/` no longer says *which* tool owns it, and the bed is the engine's
  contract surface)
- env/flag prefixes `RALPH_*` follow at the engine's own pace; the
  vendor-neutral sweep gate keeps working unchanged — it never named the
  binary
- tagline: "**ultraloop — a ralph engine, after Geoff Huntley's technique**"

**Rejected names, with reasons:**

- `ralph` (keep) — Ruling 1; also mechanical PATH collision.
- `ultraralph` for the engine — takes the plugin's name; the plugin/engine
  boundary is the load-bearing seam.
- `bedr` (and the bed-cute register) — superseded the same day: the moat is
  the confinement stack (pinned images, admission control, cgroup forensics,
  default-deny egress), so the name belongs to the infrastructure register,
  which ultraloop satisfies while also keeping family coherence.
- `wiggum` — already claimed twice on the awesome list.

## Ruling 3 — ultraralph is a thin plugin, never an implementation

ultraralph (this marketplace) contains **zero loop logic**. Its skills
translate `/ultraralph:vanilla start @<record>` into: write/adopt a bed,
exec `ultraloop`. Coupling follows the suite convention founded in the
ultragoal note verbatim — **doctor for presence** (`ultraloop` on PATH,
engine version, sandbox availability) **and files for seams** (escalation
record in, run ledger out) — never imports.

Namespace mapping:

```
/ultraralph:vanilla              → bare ultraloop run — fresh session per
                                   attempt, rubric as prompt spine
                                   (ghuntley credited in the description)
/ultraralph:with-beads           → ultraloop beads mode (rubric AC → bead
                                   decomposition, adjudicated)
/ultraralph:with-beads --swarm N → gated on the engine's HIGH-sec items
                                   (egress tier default, agent-writable
                                   verify.cmd) before unattended runs
```

If `ultraloop` is absent, doctor says so and the skills print the install
line — they never fall back to an inline loop.

## Ruling 4 — the Karpathy improvement prompt leaves the ralph name

The `ultraralph` **verb** currently inside goal-automata
(`skills/goal-automata/SKILL.md` §ultraralph +
`references/ultraralph-prompt.md`) is not ralph at all: ralph is brute
repetition toward a fixed rubric; the 30-ideas prompt *generates the next
goal after success*. It is goal-side machinery and moves into ultragoal as
**`/ultragoal start --iterate N`** — after `satisfied`, run the improvement
prompt, arm the next rubric, inherit every invariant (hash pin, deadline,
stop-attempt cap; `converged` stays the best terminal). Karpathy credit
travels with the prompt file.

This resolves the name collision by dissolution: after the move,
"ultraralph" means exactly one thing — failure-side escalation — and appears
in exactly one place. **The goal-automata → ultragoal rename MUST remove the
ultraralph verb and relocate the prompt in the same change**, or it ships the
collision into the marketplace.

## Ruling 5 — bed adoption: scenario A, adopt-if-present

When an escalation lands in a repo, the plugin **adopts an existing
`.ultraloop/` bed if one is present, creates one if absent**. The escalation
record becomes a named mode — `PROMPT_ultragoal.md` — which is engine-native;
`config.toml` is touched only additively; runs interleave into the repo's
single `runs/` history.

Hardening rule (the one thing borrowed from scenario B): **the escalation
mode is self-contained** — it carries its own limits in its mode section and
ignores the bed's `hooks/on-stop.sh`; named-mode config overrides bed
defaults. This converts A's two residual risks (bed config winning on
driver/model/limits; bed hooks firing on escalation runs) from coordination
problems into one configuration rule.

**Rejected: scenario B (own bed, always — `.ralph-ultragoal/`).** Its risks
are coordination risks, which rules can't fix: two beds drift over one
working tree — recreating exactly the six-checksums drift the engine was
built to kill — and locks/identity are per-bed, so both beds can loop the
same repo concurrently, which the flock was supposed to prevent. It also
cannot run today: bed location is assumed, not a flag.

## Ownership, one line each

| name | owns |
|---|---|
| **ultragoal** | goals, rubrics, the judge, the gate — and iteration *over* goals (`--iterate`) |
| **ultraralph** | the ceremony of handing a failed rubric to muscle |
| **ultraloop** | the muscle — loops, drivers, confinement, gates, beads, swarm |

## Open (deliberately)

- The escalation-record schema/path itself (carried from the ultragoal note's
  seam section; folds into the ultraralph v0.3 bundle work).
- The rename cascade's execution in the engine repo (its own change, its own
  tests; nothing here blocks on it — the plugin can shim `ralph`→`ultraloop`
  detection in doctor until it lands).
