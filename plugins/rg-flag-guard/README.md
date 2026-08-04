# rg-flag-guard

A PreToolUse hook that catches ripgrep's two silent flag traps before they cost
you a wrong answer.

## The trap

Two ripgrep short flags collide head-on with GNU grep muscle memory, and both
fail **silently** — exit 0, plausible-looking output:

- `rg -r` is `--replace`, not `--recursive`. `rg -rn PATTERN` treats `n` as the
  replacement string and rewrites every match in the output. You get results;
  they're wrong. (rg is already recursive — there is nothing to opt into.)
- `rg -h` is `--help`, not `--no-filename` (that's `-I`). A pipeline written
  with `-h` processes ripgrep's help text as data.

Upstream will not change this:
[ripgrep#24](https://github.com/BurntSushi/ripgrep/issues/24) ("rename the `-r`
option") was closed WONTFIX in 2016.

Agents compose search commands from a decade of `grep -rn` training data, and a
PreToolUse hook does not depend on what happens to still be in the model's
context when the command is generated.

## What it does

A PreToolUse hook cannot rewrite a command — only allow or deny. So the guard
**denies and pastes the mechanically corrected command into the deny reason**.
In live adversarial probes, an agent that hit the trap recovered in exactly one
turn by copying the suggestion.

```
$ rg -rn 'permissionDecision' hooks/
✗ DENIED: rg -r is --replace, not --recursive (rg is already recursive) …
  Most likely intended: rg -n 'permissionDecision' hooks/. Retry with that.
```

### Decision table (corpus-backed)

A grep.app survey across nixpkgs, rust-lang/rust, hledger, sonic, kube-score,
and ripgrep's own test suite showed a clean split: **deliberate replacement is
always a standalone `-r` whose value contains a `$` capture reference or is an
empty string; clustered `-r` is never deliberate.**

| Shape | Verdict |
|---|---|
| `rg -rn foo`, `rg -nr foo`, `rg -hn foo` | deny (clustered trap) |
| `rg -r main src/` (plain-word value) | deny (only the trap produces this) |
| `rg '^v(.*)' -r '$1'`, `rg -r '' pat f` | allow (the deliberate idioms) |
| `rg --replace X`, bare `-h`, `rg -In` | allow |
| `rg -g'*.rs'`, `-eh`, `-trust` | allow (value flags swallow the cluster) |
| anything after a bare `--` | allow |

### Sees through wrappers

The command word is found by unwrapping, in a loop so nesting composes:
`VAR=val` assignments; `sudo`/`env`/`nice`/`ionice`/`nohup`/`xargs`;
`timeout` + flags + duration; `snip [run] [flags] --`;
`rtk` + its `proxy`/`summary` passthrough subcommands.

Notably **rtk does not save you from the trap**: the released binary (verified
0.42.0) forwards `rtk rg -rn PAT .` to rg unchanged — matches silently
rewritten, exit 0. The guard classifies `rtk rg …` and `rtk proxy rg …` exactly
like bare rg. `rtk grep …` is exempt: that subcommand's documented contract is
grep semantics, where `-r` legitimately means recursion.

### `ask` is worthless for subagents

For background subagents, the `ask` verdict silently degrades to `allow` —
there is no human attached to prompt. Every trap shape therefore gets `deny`
with a recovery path; that is the only verdict that protects autonomous
contexts, which is exactly where the trap fires.

## Install

```bash
claude plugin marketplace add gulp/tiny-claude-plugins
claude plugin install rg-flag-guard@tiny-claude-plugins --scope user
```

If you previously registered the script manually in `settings.json`, remove
that registration — otherwise the hook fires twice (harmless, but noisy).

## Doctor

`/rg-flag-guard:rg-doctor` runs a full health check via the bundled
`scripts/doctor.sh` (read-only): ripgrep/jq presence, ripgrep version drift
against the guard's value-flag table, live deny/allow/`--explain` probes,
kill-switch state, and duplicate manual registration. Arguments:

- `/rg-flag-guard:rg-doctor install` — interactive dependency install guide
  (detects pacman/apt/dnf/brew; always asks before running anything)
- `/rg-flag-guard:rg-doctor explain <cmd>` — classify a command and translate
  the verdict

```bash
scripts/doctor.sh          # standalone; exit 0 pass / 1 warnings / 2 failures
```

## Debugging a verdict

```bash
scripts/rg-flag-guard.sh --explain 'rg -rn foo src/'
# {"decision":"deny","reason":"…","suggestion":"rg -n foo src/"}
# exit: 0 allow / 2 deny / 3 ask
```

The `--explain` CLI and the hook mode share one classify core, and the test
suite asserts both per case — verdict divergence is structurally unshippable.

## Requirements & limits

- bash + jq. Without jq the hook **fails open** (never blocks the harness).
- Kill switch: `RG_FLAG_GUARD_DISABLE=1` — must be in the environment Claude
  Code itself was launched with (hooks are separate processes; prefixing the
  blocked command does nothing).
- Not a real shell parser: segments split on `;`/`&`/`|`, so `2>&1` in a
  compound command can leave a cosmetic fragment in the suggestion.
- `-r` only ever rewrites *output*; ripgrep never modifies files. The cost is
  silently wrong data, not data loss.

## Tests

```bash
bats tests/rg-flag-guard.bats    # or: just test  (repo root)
```

Every classification case runs through both entry modes. The must-allow set is
deliberately larger than the must-deny set: a false positive costs trust in the
whole hook layer, while a false negative only leaves the pre-existing bug.
