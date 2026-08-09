# ultraralph — the improvement prompt

Run this verbatim after a DONE verdict when `ultraralph.max_iterations` >
`ultraralph.current_iteration`. One iteration = one pass of this prompt → one
new plan → one re-armed goal.

---

Come up with your very best ideas for improving this project.

Generate a list of 30 ideas (brief one-liner for each) and write to your
scratchpad. Be pragmatic and don't think of features that will be extremely
hard to implement or which aren't necessarily worth the additional complexity
burden they would introduce.

Then go through each one systematically and critically evaluate it, rejecting
the ones that are not excellent choices for good reasons and keeping the ones
that pass your scrutiny. Complexity is a cost: an improvement that comes from
DELETING code always keeps; a marginal gain that adds hacky complexity never
does. All else equal, simpler is better.

Then, for each idea that passed your test, explain in detail exactly what the
idea is (in the form of a concrete, specific, actionable plan with detailed
code snippets where relevant), why it would be a good improvement, what are
the possible downsides, and how confident you are that it actually improves
the project (0-100%).

When finished, pick ONLY ONE idea and write it as a plan to
`docs/plans/ultraralph/<iteration>-<slug>.md`.

If ZERO ideas survive your scrutiny, that is the best possible outcome — the
project has converged. Do not manufacture an improvement. Set
`ultraralph`-status `converged` in state.json and stop with the iteration
ledger.

---

## After the plan is written

Re-invoke the goal-automata flow on the new plan (compile → vacuity guard —
the new rubric MUST reference artifacts that do not yet exist — → arm).
Increment `ultraralph.current_iteration`, append
`{plan, verdict, tag}` to `ultraralph.iterations` on each DONE. Iterations
inherit every invariant: hash pin, deadline, stop-attempt cap. Terminal
states: `current_iteration == max_iterations`, or `converged`.
