#!/usr/bin/env python3
"""Sandboxed tests for the hook-liveness breadcrumb.

The question this feature answers is NOT "does the hook code work" — the rest of
the suite covers that. It is "is the harness still ROUTING stop events into the
copy we think it is". Those are different questions and only the second one
catches a stale binding.

A plugin-shipped hook binds at session start and keeps pointing at the cache
directory it bound to. Every version directory persists (17 on the box where this
was written), so an update or a reinstall leaves a live session executing an old
copy indefinitely, with nothing announcing it. A test cannot observe that; only
the running session can, which is why the breadcrumb exists.

Every test runs against a throwaway HOME + CLAUDE_CONFIG_DIR.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("kittens_liveness", os.path.join(HERE, "kittens.py"))
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)

SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class LivenessBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-live-test-")
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "proj")
        self.cfg = os.path.join(self.tmp, "cfg")
        for d in (self.home, self.proj, self.cfg):
            os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
        self._env = {k: os.environ.get(k) for k in
                     ("HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR")}
        os.environ["HOME"] = self.home
        os.environ["CLAUDE_PROJECT_DIR"] = self.proj
        os.environ["CLAUDE_CONFIG_DIR"] = self.cfg
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def doctor(self):
        args = argparse.Namespace(session=SESSION, fix=False, json=False)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            with contextlib.suppress(SystemExit):
                ks.cmd_doctor(args)
        return buf.getvalue()

    def install_versions(self, *versions):
        base = os.path.join(self.cfg, "plugins", "cache", "tiny-claude-plugins", "kittens-saved")
        for v in versions:
            os.makedirs(os.path.join(base, v, "scripts"), exist_ok=True)


class TestBreadcrumb(LivenessBase):
    def test_stamp_records_time_path_and_version(self):
        ks.stamp_hook_alive(SESSION)
        got = ks.read_hook_alive(SESSION)
        self.assertIsNotNone(got)
        self.assertIn("ts", got)
        self.assertTrue(got["from"].endswith("kittens.py"))

    def test_stamping_overwrites_rather_than_grows(self):
        for _ in range(5):
            ks.stamp_hook_alive(SESSION)
        d = os.path.join(self.home, ".claude", ".kittens-saved", "alive")
        self.assertEqual(len(os.listdir(d)), 1)

    def test_absent_breadcrumb_is_readable_as_absent(self):
        self.assertIsNone(ks.read_hook_alive(SESSION))

    def test_a_corrupt_breadcrumb_reads_as_absent_not_as_a_crash(self):
        p = ks._alive_path(SESSION)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("{ truncated")
        self.assertIsNone(ks.read_hook_alive(SESSION))


class TestVersionFromPath(LivenessBase):
    def test_a_cached_path_yields_its_version(self):
        self.assertEqual(
            ks._CACHE_VER.search(
                "/h/.claude/plugins/cache/mp/kittens-saved/0.7.8/scripts/kittens.py").group(1),
            "0.7.8")

    def test_a_repo_checkout_has_no_version(self):
        # Running from a working tree is not a cached install and must report
        # None rather than inventing a version.
        self.assertIsNone(
            ks._CACHE_VER.search("/home/u/projects/tcp/plugins/kittens-saved/scripts/kittens.py"))


class TestDoctorFindings(LivenessBase):
    def test_a_fresh_session_with_no_breadcrumb_is_not_a_finding(self):
        # The normal case for a session that has not ended a turn yet. Reporting
        # it made doctor exit 1 on a clean install, which is how a checker earns
        # being ignored.
        out = self.doctor()
        self.assertNotIn("never stamped", out)

    def test_activity_without_a_breadcrumb_is_a_finding(self):
        ks._append(SESSION, {"kind": "saved", "n": 1, "reason": "did a thing"})
        out = self.doctor()
        self.assertIn("never stamped", out)

    def test_stale_binding_is_reported_with_both_versions(self):
        self.install_versions("0.7.2", "0.7.8")
        p = ks._alive_path(SESSION)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"ts": ks._now(), "version": "0.7.2", "from": "/cache/0.7.2/scripts/kittens.py"}, fh)
        out = self.doctor()
        self.assertIn("0.7.2", out)
        self.assertIn("0.7.8", out)
        self.assertIn("restarts", out)

    def test_current_binding_is_not_reported_as_stale(self):
        self.install_versions("0.7.2", "0.7.8")
        with open(ks._alive_path(SESSION), "w", encoding="utf-8") as fh:
            json.dump({"ts": ks._now(), "version": "0.7.8", "from": "/cache/0.7.8/scripts/kittens.py"}, fh)
        out = self.doctor()
        self.assertNotIn("will keep using it", out)

    def test_a_working_tree_run_is_a_note_not_a_finding(self):
        # Observed on two real sessions, not just in development: their
        # ${CLAUDE_PLUGIN_ROOT} resolved to the working tree. That state is
        # legitimate and arguably better (edits are live, no bump), so it must
        # not push doctor to a non-zero exit.
        with open(ks._alive_path(SESSION), "w", encoding="utf-8") as fh:
            json.dump({"ts": ks._now(), "version": None, "from": "/repo/scripts/kittens.py"}, fh)
        out = self.doctor()
        self.assertIn("edits are live", out)
        self.assertNotIn("⚠ Stop hook runs from a working tree", out)


class TestHookStampsUnconditionally(LivenessBase):
    """The breadcrumb answers a routing question, which is true even when the
    plugin is muted and deliberately saying nothing. Gating it on enablement
    would make a muted session look identical to an unbound one."""

    def hook_stop(self):
        # cmd_hook_stop reads the harness payload from stdin. Left alone, a test
        # inherits a pipe that never closes and hangs forever — observed. An
        # empty StringIO gives isatty()==False and read()=="" , which is the
        # "no payload" path the hook already handles.
        args = argparse.Namespace(session=SESSION)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            real, sys.stdin = sys.stdin, io.StringIO("")
            try:
                ks.cmd_hook_stop(args)
            finally:
                sys.stdin = real

    def test_a_muted_session_still_stamps(self):
        off = ks._off_path(SESSION)
        os.makedirs(os.path.dirname(off), exist_ok=True)
        with open(off, "w", encoding="utf-8") as fh:
            fh.write("")
        self.hook_stop()
        self.assertIsNotNone(ks.read_hook_alive(SESSION))

    def test_an_ordinary_stop_stamps(self):
        self.hook_stop()
        self.assertIsNotNone(ks.read_hook_alive(SESSION))


if __name__ == "__main__":
    unittest.main(verbosity=2)
