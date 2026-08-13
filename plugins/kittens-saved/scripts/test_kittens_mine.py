#!/usr/bin/env python3
"""Sandboxed tests for `kittens mine` — the human-side view of the residual.

`mine` is named from the HUMAN's perspective and reads the bucket the ledger
stores as `yours`. That flip is the whole point of the verb, so it is the first
thing asserted here: an agent once answered "list mine" from its own side and
had to be corrected, which is the bug this command exists to make impossible.

The second thing asserted is honesty about a short list. The counts remain
authoritative (they are what grants or denies an escape) and older ledger
records carry no items at all, so `mine` must never let a partial or absent
item list read as the complete residual.

Every test runs against a throwaway HOME + project dir — no test may read or
write the real ~/.claude.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("kittens_mine", os.path.join(HERE, "kittens.py"))
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)

SESSION = "sess-mine"


class MineBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-mine-test-")
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "proj")
        for d in (self.home, self.proj):
            os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
        self._env = {k: os.environ.get(k)
                     for k in ("HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID")}
        os.environ["HOME"] = self.home
        os.environ["CLAUDE_PROJECT_DIR"] = self.proj
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers --------------------------------------------------------------

    def escape(self, mine=0, yours=0, reason="", yours_items=None, mine_items=None):
        args = argparse.Namespace(
            session=SESSION, mine=mine, yours=yours, reason=reason,
            yours_item=list(yours_items or []), mine_item=list(mine_items or []),
        )
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return ks.cmd_escape(args)

    def mine(self, as_json=False):
        args = argparse.Namespace(session=SESSION, json=as_json)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ks.cmd_mine(args)
        self.assertEqual(rc, 0)
        return buf.getvalue()


class TestPerspective(MineBase):
    """`mine` (human speaking) must show the `yours` bucket, never `--mine`."""

    def test_lists_the_human_bucket_not_the_agent_bucket(self):
        self.escape(mine=0, yours=2,
                    yours_items=["decide id1: public or private",
                                 "run the fwh probe past a naive reader"])
        out = self.mine()
        self.assertIn("decide id1: public or private", out)
        self.assertIn("run the fwh probe past a naive reader", out)
        self.assertIn("waiting on you (2)", out)

    def test_agent_owned_items_are_not_listed_as_the_humans(self):
        # A denied escape: 1 item is the agent's, 1 is the human's. `mine` must
        # not blend them — the agent's item is the agent's problem.
        self.escape(mine=1, yours=1, reason="denied",
                    yours_items=["yours: approve the release"],
                    mine_items=["mine: finish the migration"])
        out = self.mine()
        self.assertIn("yours: approve the release", out)
        self.assertNotIn("mine: finish the migration", out)

    def test_denied_escape_warns_that_items_are_still_the_agents(self):
        self.escape(mine=2, yours=1, yours_items=["yours: one thing"])
        out = self.mine()
        self.assertIn("still the AGENT's", out)


class TestHonestyAboutShortLists(MineBase):
    def test_count_only_record_says_it_was_not_itemized(self):
        # The pre-existing ledger shape: counts and prose, no items. Must not
        # render as "nothing is waiting on you".
        self.escape(mine=0, yours=3, reason="three things, unnamed")
        out = self.mine()
        self.assertIn("waiting on you (3)", out)
        self.assertIn("not itemized", out)
        self.assertIn("three things, unnamed", out)

    def test_partial_list_declares_the_shortfall(self):
        self.escape(mine=0, yours=3, reason="only one named",
                    yours_items=["the named one"])
        out = self.mine()
        self.assertIn("the named one", out)
        self.assertIn("2 more", out)

    def test_full_list_does_not_claim_a_shortfall(self):
        self.escape(mine=0, yours=2, yours_items=["a", "b"])
        out = self.mine()
        self.assertNotIn("more the agent counted", out)
        self.assertNotIn("not itemized", out)


class TestSnapshotSemantics(MineBase):
    """Each escape restates the whole residual, so `mine` reflects the LAST one
    — matching `_tally`, which reads `yours` off the last escape rather than
    summing. A running total would double-count every redeclaration."""

    def test_later_escape_replaces_the_earlier_list(self):
        self.escape(mine=0, yours=3, yours_items=["old-1", "old-2", "old-3"])
        self.escape(mine=0, yours=1, yours_items=["new-only"])
        out = self.mine()
        self.assertIn("new-only", out)
        self.assertNotIn("old-1", out)
        self.assertIn("waiting on you (1)", out)

    def test_items_do_not_accumulate_across_declarations(self):
        self.escape(mine=0, yours=1, yours_items=["first"])
        self.escape(mine=0, yours=1, yours_items=["second"])
        payload = json.loads(self.mine(as_json=True))
        self.assertEqual(payload["items"], ["second"])
        self.assertEqual(payload["waiting_on_you"], 1)


class TestEmptyStates(MineBase):
    def test_no_escape_yet_is_distinct_from_nothing_waiting(self):
        # These are different answers and only one of them is a number: a
        # session where the agent never declared has NOT told you it owes you
        # nothing. Collapsing them would let silence read as an all-clear.
        never = self.mine()
        self.assertIn("nothing declared yet", never)

        self.escape(mine=0, yours=0, reason="genuinely clear")
        cleared = self.mine()
        self.assertIn("nothing is waiting on you", cleared)
        self.assertNotIn("nothing declared yet", cleared)

    def test_json_flags_itemization_state(self):
        self.escape(mine=0, yours=2, reason="counts only")
        payload = json.loads(self.mine(as_json=True))
        self.assertFalse(payload["itemized"])
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["waiting_on_you"], 2)


class TestLedgerShape(MineBase):
    def test_items_are_persisted_on_the_escape_record(self):
        self.escape(mine=0, yours=1, yours_items=["persisted"])
        events = ks._read(SESSION)
        esc = [e for e in events if e.get("kind") == "escape"][-1]
        self.assertEqual(esc["yours_items"], ["persisted"])

    def test_blank_items_are_dropped_not_counted_as_named(self):
        self.escape(mine=0, yours=2, reason="one blank", yours_items=["real", "   "])
        payload = json.loads(self.mine(as_json=True))
        self.assertEqual(payload["items"], ["real"])
        self.assertFalse(payload["itemized"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
