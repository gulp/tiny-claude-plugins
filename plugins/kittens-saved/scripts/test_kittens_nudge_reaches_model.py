#!/usr/bin/env python3
"""The Stop-hook nudge must reach the AGENT, not only the human.

Regression test for a silent no-op found live: both non-blocking tiers (deny
and warn) emitted their nudge on `systemMessage` alone. Claude Code's contract
for hook output is explicit that these are different audiences:

    systemMessage          -> "Display a message to the user (all hooks)"
    additionalContext      -> "Context injected back to model"

So the nudge rendered in the human's transcript and never entered the agent's
context. The human had to relay it by hand — which is exactly what happened,
and is how it was found. Note why it stayed hidden: the escape-block tier uses
`decision: block` + `reason`, which DOES reach the model, so one tier worked
and the channel looked healthy.

These tests assert the OUTPUT SHAPE of the hook rather than the wording, so
they survive edits to the nudge text. Every test runs against a throwaway HOME
and a throwaway transcript; none may touch the real ~/.claude.

WHAT THESE TESTS CANNOT REACH, stated because the omission is the same shape as
the bug: they verify what the hook EMITS, not that Claude Code delivers it. No
in-process test can — the consumer is the harness. The delivery guarantee rests
on the documented schema for the Stop event, quoted verbatim from the 2.1.227
binary so a future reader need not re-derive it:

    "Hook-specific output for the Stop event. additionalContext is non-error
     feedback delivered to the model; the conversation continues so the model
     can act on it."

If a future Claude Code drops or renames that field, every test here stays
green and the nudge silently stops arriving again. The check that would catch
it is an integration one — a real session, a real tell, and the agent visibly
responding — and it belongs in a release smoke test, not here.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("kittens_nudge", os.path.join(HERE, "kittens.py"))
# Asserted rather than assumed: spec_from_file_location returns None for a
# missing/unloadable path, and the resulting AttributeError several lines later
# reads as a mystery instead of "kittens.py is not where this test expects".
assert SPEC is not None and SPEC.loader is not None, f"cannot load kittens.py from {HERE}"
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)


SESSION = "sess-nudge-probe"

# A phrase that must trip the deny tier, and a softer one that must trip only
# the warn tier. Both are matched by BUILT-IN defaults on purpose: HOME is a
# throwaway here, so the operator's deny/warn overrides are deliberately not
# loaded and a fixture leaning on one would pass on the author's box and fail
# everywhere else. (Found the hard way — the first fixture phrase came from the
# author's own overrides and matched nothing in the sandbox.)
#
# Each is guarded by a test asserting it still fires, so retiring a default
# fails loudly there instead of silently turning these tests vacuous.
DENY_PHRASE = "I left the rest for you"
WARN_PHRASE = "I deliberately did not touch the second item"


def _msg(uuid: str, text: str) -> str:
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }) + "\n"


def _user(uuid: str, text: str = "go on") -> str:
    """A human turn — one of several record kinds that delimit one turn from
    the next.

    Fixtures here must include a delimiter of some kind. The hook decides which
    assistant message belongs to the ending turn by asking whether it comes
    after the last record the agent did not write, so an assistant-only
    transcript is not a smaller version of a real one; it is a shape the hook
    cannot reason about.
    """
    return json.dumps({
        "type": "user",
        "uuid": uuid,
        "message": {"role": "user", "content": text},
    }) + "\n"


def _hook_injection(uuid: str) -> str:
    """What a Stop-hook `additionalContext` re-invocation actually writes.

    Verified against a live transcript 2026-08-13: NO `user` record is written
    when this hook injects context and the agent speaks again. The injection
    lands as `attachment`/`system` records, so consecutive hook-driven turns
    read as assistant, assistant, assistant with the last `user` record far
    behind all of them. That is the shape that broke a `type == "user"` turn
    boundary, and it is the plugin's own nudges that produce it.
    """
    return (
        json.dumps({"type": "attachment", "uuid": uuid + "-a", "content": "<reminder/>"}) + "\n"
        + json.dumps({"type": "system", "uuid": uuid + "-s", "content": "hook output"}) + "\n"
    )


def _tool_result(uuid: str, tool_use_id: str = "toolu_1") -> str:
    """A tool result — also a user-side record, and the reason the turn
    boundary cannot simply be "the last user record": these land mid-turn."""
    return json.dumps({
        "type": "user",
        "uuid": uuid,
        "message": {"role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": tool_use_id,
                                 "content": "ok"}]},
    }) + "\n"


@contextlib.contextmanager
def _stdin(text: str):
    """Feed the hook its payload. It reads real stdin, and the stdlib has no
    `redirect_stdin` to pair with `redirect_stdout`, so this stands in for one."""
    old = sys.stdin
    sys.stdin = io.StringIO(text)
    try:
        yield
    finally:
        sys.stdin = old


class NudgeBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-nudge-test-")
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "proj")
        for d in (self.home, self.proj):
            os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
        self._env = {k: os.environ.get(k)
                     for k in ("HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID")}
        os.environ["HOME"] = self.home
        os.environ["CLAUDE_PROJECT_DIR"] = self.proj
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        self.transcript = os.path.join(self.tmp, "transcript.jsonl")

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _drive(self) -> dict:
        """Run cmd_hook_stop against the transcript as it currently stands."""
        payload = json.dumps({"session_id": SESSION, "transcript_path": self.transcript})
        args = type("A", (), {"session": SESSION})()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), _stdin(payload):
            ks.cmd_hook_stop(args)
        raw = buf.getvalue().strip()
        # The hook is contractually required to print exactly one JSON object on
        # every path, including the silent one (`suppressOutput`). Saying so here
        # turns "printed nothing" into that sentence rather than a bare
        # JSONDecodeError several frames away from the cause.
        self.assertTrue(raw, "the Stop hook printed nothing; it must always emit a JSON verdict")
        return json.loads(raw)

    def run_stop(self, final_text: str) -> dict:
        """Drive cmd_hook_stop end to end with the ending turn ALREADY flushed.

        This is the ordinary case at real Stop time, and until 2026-08-13 it was
        the case the hook could not see: it waited for a message newer than the
        one present at entry, so a response that had already landed left it
        waiting for something that never came. The old fixture here reproduced
        only the late flush — with a threading.Event to force that interleaving
        — and so stayed green across the entire lifetime of the bug.

        Seeding everything up front is therefore not a simplification; it is the
        regression. `run_stop_late_flush` covers the other ordering.
        """
        with open(self.transcript, "w", encoding="utf-8") as fh:
            fh.write(_user("u-prev-ask"))
            fh.write(_msg("a-prev", "a previous, clean turn"))
            fh.write(_user("u-ask"))
            fh.write(_msg("a-final", final_text))
        return self._drive()

    def run_stop_late_flush(self, final_text: str) -> dict:
        """The other ordering: the ending turn lands while the hook is waiting.

        The writer is gated on an Event rather than a bare sleep so the
        interleaving is forced rather than hoped for.
        """
        with open(self.transcript, "w", encoding="utf-8") as fh:
            fh.write(_user("u-prev-ask"))
            fh.write(_msg("a-prev", "a previous, clean turn"))
            fh.write(_user("u-ask"))

        hook_entered = threading.Event()

        def append_later():
            # Bounded: never wedge the suite if the hook raises before setting.
            if not hook_entered.wait(timeout=5.0):
                return
            time.sleep(0.2)
            with open(self.transcript, "a", encoding="utf-8") as fh:
                fh.write(_msg("a-final", final_text))

        payload = json.dumps({"session_id": SESSION, "transcript_path": self.transcript})
        args = type("A", (), {"session": SESSION})()
        buf = io.StringIO()

        writer = threading.Thread(target=append_later)
        writer.start()
        try:
            with contextlib.redirect_stdout(buf), _stdin(payload):
                hook_entered.set()
                ks.cmd_hook_stop(args)
        finally:
            hook_entered.set()  # release the writer even if the hook raised
            writer.join(timeout=10.0)

        raw = buf.getvalue().strip()
        self.assertTrue(raw, "the Stop hook printed nothing; it must always emit a JSON verdict")
        return json.loads(raw)


class TestTurnBoundary(unittest.TestCase):
    """Which assistant message is "this turn's response".

    Regression for a silent no-op found live 2026-08-13: the hook waited for a
    message NEWER than the one present at entry, so it only ever saw a response
    that flushed AFTER it started. A response already on disk — the ordinary
    outcome for a long one — left it waiting out `max_wait` and returning '',
    and the nudge never fired. Firing was a coin flip on flush timing.

    Position in the transcript decides it: the last assistant text record must
    come after the last user-side record. That is true under both flush
    orderings, which is the property the old change-detector lacked.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-turn-test-")
        self.t = os.path.join(self.tmp, "transcript.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, *records: str):
        with open(self.t, "w", encoding="utf-8") as fh:
            for r in records:
                fh.write(r)

    def test_already_flushed_response_is_seen(self):
        # THE regression. Before the fix this returned '' after a 3s stall.
        self._write(_user("u1"), _msg("a1", "the ending turn"))
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "the ending turn")

    def test_already_flushed_response_returns_without_waiting(self):
        # The stall was not just wrong, it was 3s on every clean stop.
        self._write(_user("u1"), _msg("a1", "done"))
        started = time.monotonic()
        ks._current_response_text(self.t, max_wait=3.0)
        self.assertLess(time.monotonic() - started, 0.5,
                        "an already-flushed response must not wait for a newer one")

    def test_unflushed_turn_reads_silent_not_one_turn_behind(self):
        # The 2026-08-09 failure this must not reintroduce: the previous turn's
        # text is present, the ending turn is not. Nudging here would fire on
        # words from a turn the human has already seen answered.
        self._write(_user("u1"), _msg("a1", "previous turn"), _user("u2"))
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "")

    def test_hook_driven_turn_is_delimited_without_any_user_record(self):
        # THE SECOND BUG (live 2026-08-13, one commit after the first). When
        # this hook injects additionalContext the agent speaks again with NO
        # `user` record between the two turns. Under a `type == "user"`
        # boundary the previous turn's text already satisfies "after the last
        # user record", so an unflushed current turn reads as the previous one
        # — the exact failure the positional rule was written to end, on the
        # exact path the plugin's own nudges create.
        self._write(
            _user("u1"), _msg("a1", "previous turn"), _hook_injection("h1"),
        )
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "")

    def test_hook_driven_turn_is_read_once_it_lands(self):
        # The other half: the same shape, now flushed, must be READ. A boundary
        # so strict it never reports is not a fix.
        self._write(
            _user("u1"), _msg("a1", "previous turn"), _hook_injection("h1"),
            _msg("a2", "this turn"),
        )
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "this turn")

    def test_late_flush_is_still_picked_up(self):
        self._write(_user("u1"), _msg("a1", "previous turn"), _user("u2"))

        def append_later():
            time.sleep(0.3)
            with open(self.t, "a", encoding="utf-8") as fh:
                fh.write(_msg("a2", "the late one"))

        w = threading.Thread(target=append_later)
        w.start()
        try:
            self.assertEqual(ks._current_response_text(self.t, max_wait=3.0), "the late one")
        finally:
            w.join(timeout=5.0)

    def test_mid_turn_tool_results_do_not_hide_the_response(self):
        # Tool results are user-side records that land mid-turn. The closing
        # assistant text follows them, so the boundary still resolves.
        self._write(_user("u1"), _msg("a1", "thinking out loud"),
                    _tool_result("tr1"), _msg("a2", "the closing word"))
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "the closing word")

    def test_a_subagents_words_are_not_this_turns_response(self):
        sidechain = json.loads(_msg("s1", "a subagent said this"))
        sidechain["isSidechain"] = True
        self._write(_user("u1"), _msg("a1", "the real response"),
                    json.dumps(sidechain) + "\n")
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "the real response")

    def test_missing_transcript_returns_immediately(self):
        started = time.monotonic()
        self.assertEqual(ks._current_response_text(None, max_wait=3.0), "")
        self.assertEqual(ks._current_response_text(self.t + ".nope", max_wait=3.0), "")
        self.assertLess(time.monotonic() - started, 0.5,
                        "a missing transcript is known immediately; waiting cannot help")

    def test_torn_line_does_not_abort_the_scan(self):
        with open(self.t, "w", encoding="utf-8") as fh:
            fh.write(_user("u1"))
            fh.write("{ half a line\n")
            fh.write(_msg("a1", "survived"))
        self.assertEqual(ks._current_response_text(self.t, max_wait=0.5), "survived")


class TestNudgeShape(unittest.TestCase):
    """Unit-level: the helper itself addresses both audiences."""

    def test_nudge_carries_additional_context_for_the_model(self):
        out = ks._nudge("some text")
        self.assertEqual(
            out.get("hookSpecificOutput", {}).get("additionalContext"), "some text",
            "the nudge must be injected back to the model; systemMessage alone "
            "renders only to the human and is a no-op for its actual target")

    def test_nudge_still_shows_the_human_what_the_agent_was_told(self):
        out = ks._nudge("some text")
        self.assertEqual(out.get("systemMessage"), "some text",
                         "both audiences, deliberately — a non-blocking tier is "
                         "only auditable if the human sees what the agent saw")

    def test_nudge_names_the_stop_event(self):
        # hookSpecificOutput without a matching hookEventName is rejected;
        # Claude Code's own error text asks "Did you mean
        # hookSpecificOutput.additionalContext (with a hookEventName)?"
        self.assertEqual(ks._nudge("x")["hookSpecificOutput"]["hookEventName"], "Stop")

    def test_nudge_does_not_block(self):
        self.assertTrue(ks._nudge("x")["continue"])
        self.assertNotIn("decision", ks._nudge("x"),
                         "the nudge tiers must never block; blocking is the "
                         "denied-escape path and has its own anti-trap counter")

    def test_nudge_is_json_serialisable(self):
        # The hook's only output channel is json.dumps to stdout. A non-encodable
        # value here would surface as a traceback at Stop time, i.e. a broken
        # hook, not a missing nudge.
        self.assertEqual(json.loads(json.dumps(ks._nudge("x")))["systemMessage"], "x")


class TestBlockingTierIsUnchanged(NudgeBase):
    """The escape-block tier is the one that ALREADY reached the model, via
    `decision: block` + `reason`. It is not a nudge and must not become one —
    a refactor that routed it through `_nudge()` would silently delete the gate
    this plugin exists to enforce, and every nudge test above would still pass.
    """

    def _deny_escape(self, mine: int = 2):
        ks._append(SESSION, {"kind": "escape", "mine": mine, "yours": 0, "granted": False})

    def test_denied_escape_still_blocks(self):
        self._deny_escape()
        out = self.run_stop("Done, but I have unsaved work of my own.")
        self.assertEqual(out.get("decision"), "block",
                         "a denied escape must block the stop, not merely nudge")
        self.assertIn("reason", out, "a block without a reason is unactionable")

    def test_block_releases_on_the_next_stop(self):
        # The anti-trap counter: blocking twice in a row would strand the agent
        # with no way to end its turn. Asserted here because this test file is
        # where someone will come to change stop-hook output shapes.
        self._deny_escape()
        self.run_stop("First stop — expected to be blocked.")
        out = self.run_stop("Second stop — must be allowed through.")
        self.assertNotEqual(out.get("decision"), "block",
                            "the block must fire at most once; a second block "
                            "traps the agent with no exit")


class TestDenyTierReachesModel(NudgeBase):
    def test_the_fixture_phrase_actually_trips(self):
        # Guards every other test in this file: if the denylist stops matching
        # DENY_PHRASE, the deny-tier tests would silently start asserting
        # against a clean-stop response instead of a nudge.
        self.assertTrue(ks._lazy_hits(DENY_PHRASE),
                        f"fixture phrase no longer on the denylist: {DENY_PHRASE!r}")

    def test_deny_tier_injects_context(self):
        out = self.run_stop(f"All done. {DENY_PHRASE}.")
        ctx = out.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("lazy-handoff tell", ctx,
                      "the deny nudge never reached the agent — this is the "
                      "exact regression: user-visible, agent-invisible")

    def test_deny_tier_names_the_phrase_that_fired(self):
        out = self.run_stop(f"All done. {DENY_PHRASE}.")
        ctx = out["hookSpecificOutput"]["additionalContext"]
        hit = ks._lazy_hits(DENY_PHRASE)[0]
        self.assertIn(hit, ctx,
                      "a nudge that will not say which phrase fired cannot be "
                      "acted on, only apologised for")

    def test_warn_tier_also_reaches_the_model(self):
        # The warn tier had the SAME bug and is easy to forget, because it is
        # the quieter of the two and its whole purpose is to teach — a lesson
        # delivered only to the human teaches the wrong party.
        self.assertFalse(ks._lazy_hits(WARN_PHRASE),
                         "WARN_PHRASE must NOT be on the denylist, or this test "
                         "silently re-tests the deny tier")
        out = self.run_stop(f"All done. {WARN_PHRASE}.")
        ctx = out.get("hookSpecificOutput", {}).get("additionalContext", "")
        self.assertIn("[i]", ctx, "the warn nudge never reached the agent")

    def test_clean_turn_stays_silent(self):
        # The other side of the gate. Without this, a hook that nudged on every
        # stop would pass every assertion above.
        out = self.run_stop("Done. Everything landed and the tests are green.")
        self.assertNotIn("hookSpecificOutput", out)
        self.assertTrue(out.get("suppressOutput"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
