---
name: pr-faq
description: >-
  Use when the user invokes /pr-faq, or wants to decide whether to build
  something before building it — "should we build this", "write a working
  backwards doc", "PR/FAQ this", "press release FAQ", "Amazon working
  backwards", "what's the customer benefit here", "sanity check this idea".
  Drafts Amazon's Working Backwards artifact — a future press release plus
  FAQ, written from the customer's point of view, before any implementation
  starts — then applies its actual kill criterion: if the customer benefit
  can't survive being stated plainly on the page, the idea is scrapped before
  capital is spent, not softened into something that still ships. Not a
  generic "write me marketing copy" skill — the FAQ and the kill verdict are
  the point, not the press release alone.
allowed-tools: Write Read AskUserQuestion
argument-hint: "[idea in a sentence] (default: ask what we're building)"
---

# PR/FAQ — Working Backwards

Before any code, write the press release you'd publish *after* this ships,
plus the FAQ that follows it. If the customer benefit can't survive being
stated plainly on that one page, the idea doesn't work yet — not "needs
better marketing," doesn't work. That's Amazon's actual discipline, and it
only functions if the kill outcome is genuinely available at the end, not
theater before a foregone yes.

Primary sources this skill is built from: `workingbackwards.com` (Bryar &
Carr, the book by two people who ran the process at Amazon) and Amazon's own
internal accounts of the PR/FAQ format.

## The two failure modes this skill exists to prevent

1. **Skipping straight to the FAQ, or straight to build.** The press release
   is what forces plain language. A team that jumps to "here's how it'll
   work" is describing the solution to itself, not the benefit to a
   customer — and solution-shaped writing hides a weak benefit better than
   almost anything else.
2. **A verdict that's always yes.** If this skill only ever produces an
   enthusiastic press release, it's not applying Amazon's process, it's
   writing ad copy with extra steps. The kill step at the end is not
   optional and its default is not "ship it."

## Step 1 — Elicit, don't assume

Ask directly, in conversation (not multiple choice — these are open):

- Who is the customer? A specific person or segment, not "users."
- What's actually broken or painful about their status quo today? Concrete,
  not "inefficient."
- What's the one-sentence benefit of what you're proposing to build?
- What would a skeptic say is wrong with this idea?

If the user gave the idea in one sentence as the skill argument, use it to
seed these questions rather than re-asking from zero — but still get an
explicit answer on the customer and the pain point before drafting. A press
release with no named customer is not a press release, it's a mission
statement.

## Step 2 — Draft the press release (one page, max)

Amazon's fixed shape, in this order:

1. **Heading.** Name the product the way a customer would refer to it — not
   an internal codename.
2. **Sub-heading.** One sentence: who the customer is and the benefit they
   get. This sentence is the whole bet. If it's vague here, it stays vague
   everywhere downstream.
3. **Summary paragraph.** Give away the ending — product and benefit
   summarized, dateline-style, as if this already shipped.
4. **Problem paragraph.** The customer's problem, from their side. No
   internal framing ("we needed to reduce churn") — their framing ("I kept
   losing X because Y").
5. **Solution paragraph.** How this solves it, in plain language a customer
   would actually use, not feature-list language.
6. **A quote from someone at the company** — spokesperson-style, explaining
   why this matters. (Keep it short; this is the paragraph most likely to
   turn into filler. If it says nothing the summary didn't already say, cut
   it.)
7. **How to get started.** One or two sentences, concrete.
8. **A customer quote.** Imagined, first-person, specific — what they'd
   actually say, not "This changed everything!" Genericness here is a tell
   that the benefit itself is generic.
9. **Closing / call to action.**

Write it. Don't hedge it with "could" or "might" — a press release is
written as fact. The hedging belongs in Step 4, not here.

## Step 3 — Draft the FAQ

Two sections, kept genuinely separate:

**External FAQ** (customer-facing, same voice as the press release): how do
I use it, what does it cost, how is it different from the obvious
alternative, what happens to my existing setup. Write these as a real
customer would actually ask them — including the unflattering ones.

**Internal FAQ** (the honest one, company-voice, not customer-voice): what
does this cost to build, what's the biggest technical risk, why now and not
before, what happens if a competitor already does this, what's the actual
adoption assumption this bets on and how likely is it. This section is
where the FAQ format earns its keep — it's the place skepticism is supposed
to live, not an afterthought below a triumphant press release.

## Step 4 — The kill test (mandatory, not a formality)

Re-read the sub-heading sentence from Step 2 alone, as if it's the only
thing a customer will ever see. Then answer, in writing, as part of the
output — not privately, not skipped:

- **Does the benefit survive being said plainly?** If the sub-heading needs
  three qualifying clauses to be true, it isn't a benefit yet.
- **Would the imagined customer quote actually get said by a real person?**
  If it reads like every other customer quote ever written, the benefit is
  probably generic or unproven, not just badly phrased.
- **Does the Internal FAQ's adoption assumption survive contact with the
  skeptic's objection from Step 1?** If the skeptic's objection was never
  actually answered — only restated more politely — say so.

Render one of three explicit verdicts, and mean it:

- **Survives** — state why, citing the specific sentence that carries the
  benefit.
- **Survives with a named gap** — the benefit is real but one specific
  thing (name it) has to become true first; this is not a pass with an
  asterisk, it's "don't build yet, resolve this first."
- **Killed** — say plainly that the customer benefit doesn't hold up, and
  name the weakest sentence in the press release as the evidence. This is a
  legitimate, expected outcome, not a failure of the exercise. An idea that
  never gets killed by this process either was already obviously good, or
  the process was performed instead of applied — the second one is a
  reason to check the verdict harder, not to relax it.

## Step 5 — Save it

Ask where the user wants the doc saved (a sensible default is
`docs/pr-faq/<slug>.md` in the current repo). Write the full document —
press release, FAQ, and the kill-test verdict all included — as one
markdown file. The verdict is part of the artifact, not a spoken aside;
someone reading this file in six months should see the same honesty the
live session had.

## Gotchas

- **Solution-first language dressed as benefit.** "A new API for X" is a
  solution description; "you stop having to do Y by hand" is a benefit.
  The sub-heading test in Step 4 catches this if applied honestly — it
  rarely survives a solution-shaped sentence.
- **Internal jargon leaking into the External FAQ.** If a customer would
  have to ask what a term means, it doesn't belong in the customer-facing
  section.
- **Treating the Internal FAQ as a formality.** It's where the actual risk
  and cost live. A one-line internal FAQ is usually a sign the drafting
  session skipped the hard part.
- **This produces a single self-graded draft, not an adversarial review.**
  One pass, one author, no independent skeptic reading it cold — the
  verdict in Step 4 is self-assessment, and self-assessment anchors on its
  own draft. Treat "survives" from this skill as provisional, not as
  Amazon's actual bar, which routinely runs a document through several
  rounds of real stakeholders who didn't write it. If the stakes are high
  enough to want independent pressure-testing before trusting this skill's
  verdict, get someone who didn't write the draft to read only the
  sub-heading and the Internal FAQ, cold, and react.

## Provenance

Built from this vault's own citation-swept research on Amazon's Working
Backwards process (primary source: `workingbackwards.com`), 2026-08-18.
