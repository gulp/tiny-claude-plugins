#!/usr/bin/env python3
"""Sandboxed tests for the tcp-4zi state-scoping split: mute → session-global,
deny/warn overrides → operator-global, ledger → per-project (unchanged).

Every test runs against a throwaway HOME + two project dirs — no test may read
or write the real ~/.claude.
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
SPEC = importlib.util.spec_from_file_location("kittens_scoping", os.path.join(HERE, "kittens.py"))
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)

SESSION = "sess-tcp4zi"


class ScopingBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-scope-test-")
        self.home = os.path.join(self.tmp, "home")
        self.proj_a = os.path.join(self.tmp, "proj-a")
        self.proj_b = os.path.join(self.tmp, "proj-b")
        for d in (self.home, self.proj_a, self.proj_b):
            os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
        self._env = {k: os.environ.get(k)
                     for k in ("HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID")}
        os.environ["HOME"] = self.home
        os.environ["CLAUDE_PROJECT_DIR"] = self.proj_a
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def in_project(self, proj):
        os.environ["CLAUDE_PROJECT_DIR"] = proj

    def global_dir(self):
        return os.path.join(self.home, ".claude", ".kittens-saved")


class TestMuteIsSessionGlobal(ScopingBase):
    def test_toggle_off_in_A_holds_in_B(self):
        self.in_project(self.proj_a)
        with contextlib.redirect_stdout(io.StringIO()):
            code = ks.cmd_toggle(argparse.Namespace(session=SESSION, state="off"))
        self.assertEqual(code, 0)
        # Marker lands in the fixed global dir, not project A's state dir.
        self.assertTrue(os.path.exists(os.path.join(self.global_dir(), f"{SESSION}.off")))
        self.assertFalse(os.path.exists(
            os.path.join(self.proj_a, ".claude", ".kittens-saved", f"{SESSION}.off")))
        # Same session, other cwd: still off, and status agrees.
        self.in_project(self.proj_b)
        self.assertTrue(ks._is_off(SESSION))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ks.cmd_toggle(argparse.Namespace(session=SESSION, state="status"))
        self.assertIn("off", buf.getvalue())
        # toggle on from B clears it everywhere.
        with contextlib.redirect_stdout(io.StringIO()):
            ks.cmd_toggle(argparse.Namespace(session=SESSION, state="on"))
        self.in_project(self.proj_a)
        self.assertFalse(ks._is_off(SESSION))


class TestOverridesAreOperatorGlobal(ScopingBase):
    def test_deny_override_added_in_B_fires_in_A(self):
        self.in_project(self.proj_b)
        ks._write_overrides(["totally custom punt phrase"])
        self.in_project(self.proj_a)
        hits = ks._lazy_hits("This is a totally custom punt phrase, sorry.")
        self.assertEqual(hits, ["totally custom punt phrase"])

    def test_warn_override_added_in_B_fires_in_A(self):
        self.in_project(self.proj_b)
        ks._write_warn_overrides([{"matcher": r"bespoke soft tell", "reason": "r", "escape": "e"}])
        self.in_project(self.proj_a)
        pats = [p for p, _, _, _ in ks._warn_hits("a bespoke soft tell indeed")]
        self.assertIn("bespoke soft tell", pats)


class TestLedgerStaysPerProject(ScopingBase):
    def test_ledger_path_and_stats_are_project_scoped(self):
        self.in_project(self.proj_a)
        ks._append(SESSION, {"kind": "saved", "n": 3, "reason": "t"})
        self.assertTrue(ks._ledger_path(SESSION).startswith(
            os.path.join(self.proj_a, ".claude", ".kittens-saved")))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ks.cmd_stats(argparse.Namespace(session=SESSION, json=True))
        proj = json.loads(buf.getvalue())["project"]
        self.assertEqual((proj["sessions"], proj["saved"]), (1, 3))
        # Project B sees an empty ledger — no cross-project bleed.
        self.in_project(self.proj_b)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ks.cmd_stats(argparse.Namespace(session=SESSION, json=True))
        self.assertEqual(json.loads(buf.getvalue())["project"]["saved"], 0)


class TestLegacyGather(ScopingBase):
    def legacy_dir(self, proj):
        d = os.path.join(proj, ".claude", ".kittens-saved")
        os.makedirs(d, exist_ok=True)
        return d

    def test_local_files_gathered_once_and_not_resurrected(self):
        # Global already has one override; project A holds a legacy pair.
        ks._write_overrides(["already global"])
        d = self.legacy_dir(self.proj_a)
        with open(os.path.join(d, "denylist.txt"), "w") as fh:
            fh.write("# comment\nalready global\nstranded in repo a\n")
        with open(os.path.join(d, "warnlist.json"), "w") as fh:
            json.dump([{"matcher": "legacy warn", "reason": "r", "escape": "e"}], fh)
        self.in_project(self.proj_a)
        ks._load_denylist()
        ks._load_warnlist()
        self.assertEqual(ks._load_overrides(), ["already global", "stranded in repo a"])
        self.assertEqual([e["matcher"] for e in ks._load_warn_overrides()], ["legacy warn"])
        # Consumed: renamed away so a later global delete is not resurrected.
        self.assertFalse(os.path.exists(os.path.join(d, "denylist.txt")))
        self.assertTrue(os.path.exists(os.path.join(d, "denylist.txt.migrated")))
        self.assertFalse(os.path.exists(os.path.join(d, "warnlist.json")))
        ks._write_overrides(["already global"])  # operator deletes the gathered entry
        ks._load_denylist()
        self.assertEqual(ks._load_overrides(), ["already global"])


class TestDoctorSessionAnchor(ScopingBase):
    def doctor(self, session=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = ks.cmd_doctor(argparse.Namespace(session=session, fix=False, json=True))
        return code, json.loads(buf.getvalue())

    def test_unresolvable_session_warns_exit_1(self):
        code, out = self.doctor()
        self.assertEqual(code, 1)
        self.assertTrue(any("session id unresolvable" in f["message"]
                            for f in out["findings"] if f["severity"] == "warn"))

    def test_resolvable_session_no_such_warning(self):
        code, out = self.doctor(session=SESSION)
        self.assertEqual(code, 0)
        self.assertFalse(any("session id unresolvable" in f["message"]
                             for f in out["findings"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
