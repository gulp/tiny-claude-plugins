# Fixing a product registration gap

`agent-mail doctor` reports a **registration gap** when you are watching a _product bus_
(`$AGENT_MAIL_PRODUCT` set, or the `product` command) but your identity is **not registered in every
project linked into that product**.

```
[FAIL] product — identity 'BlueLake' NOT registered in: alpha, gamma
```

## Why it matters

A product watch aggregates one identity's mail across _all_ linked projects. Mail is
**project-scoped**: an identity registered in `beta` but not in `alpha` simply does not exist in
`alpha`, so any mail sent to it there is invisible to the watch. The gap is silent at run time — you
just never see those messages. `doctor` surfaces it up front instead.

## How doctor decides

1. `am products status <product-key> --json` → the set of linked projects.
2. For each linked project, `am agents list --project <project> --json` → the identities registered
   there.
3. Any linked project whose identity list does **not** contain your `AGENT_NAME` is reported under
   `data.product.missing`. Projects `doctor` could not read (am error / timeout) are reported under
   `data.product.unverifiable` — treat those as "unknown", not "fine".

## The fix

Register your identity in each missing project. `agents register` is idempotent — running it for a
project you are already in is harmless.

```bash
# For every project named in the FAIL line:
am agents register --project <project-key> --name "$AGENT_NAME" \
  --program claude-code --model <your-model>
```

Then re-run the check:

```bash
AGENT_MAIL_PRODUCT=<product-key> AGENT_NAME=<you> agent-mail doctor
```

A clean run reports `[PASS] product — identity '<you>' registered in all N linked
project(s)`.

## Notes

- **`unverifiable` ≠ registered.** If a project shows up as unverifiable, the `am` call failed or
  timed out (a hung `am products status` on a bad key is a known failure mode). Fix the underlying
  `am` problem, then re-run — do not assume the project is fine.
- The check is a **no-op** outside product mode: with `$AGENT_MAIL_PRODUCT` unset, `doctor` never
  runs it and the `product` check is absent from the output.
- Everything here is **read-only** except the `am agents register` fix you run yourself.
