#!/usr/bin/env python3
"""Sandboxed tests for the `kittens statusline` installer (plan Rev 2).

Every test runs against a throwaway HOME + project dir — no test may read or
write the real ~/.claude. Routes (V/W/R/D/OURS) × states (fresh/converged/
modified), round-trips, and the adversarial cases (corrupt ledger, STALE,
concurrent change, recursion guard) from the plan's acceptance criteria.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("kittens", os.path.join(HERE, "kittens.py"))
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)


def _ns(verb="status", scope=None, yes=False, force_modified=False, as_json=False):
    return argparse.Namespace(verb=verb, scope=scope, yes=yes,
                              force_modified=force_modified, json=as_json)


class SLBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-sl-test-")
        self.home = os.path.join(self.tmp, "home")
        self.proj = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(self.home, ".claude"))
        os.makedirs(os.path.join(self.proj, ".claude"))
        self._env = {k: os.environ.get(k) for k in ("HOME", "CLAUDE_PROJECT_DIR")}
        os.environ["HOME"] = self.home
        os.environ["CLAUDE_PROJECT_DIR"] = self.proj
        ks._SL_PRE_WRITE_HOOK = None

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        ks._SL_PRE_WRITE_HOOK = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sl(self, **kw):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = ks.cmd_statusline(_ns(**kw))
        return code, buf.getvalue()

    # -- fixture helpers ----------------------------------------------------
    def settings_path(self, scope="user"):
        return ks._sl_paths(scope)["settings"]

    def write_settings(self, obj, scope="user"):
        p = self.settings_path(scope)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as fh:
            json.dump(obj, fh, indent=2)

    def read_settings(self, scope="user"):
        with open(self.settings_path(scope)) as fh:
            return json.load(fh)

    def make_fake_segment(self, version="0.9.9", text="🐈 chip"):
        d = os.path.join(self.home, ".claude", "plugins", "cache", "mkt",
                         "kittens-saved", version, "statusline")
        os.makedirs(d, exist_ok=True)
        seg = os.path.join(d, "kittens-segment.sh")
        with open(seg, "w") as fh:
            fh.write(f"#!/usr/bin/env bash\necho '{text}'\n")
        os.chmod(seg, 0o755)
        return seg

    def make_rail(self, widgets=None):
        d = os.path.join(self.home, ".config", "ccstatusline")
        os.makedirs(d, exist_ok=True)
        cfg = {"version": 3, "lines": [widgets if widgets is not None else
                                       [{"id": "1", "type": "model"}]]}
        with open(os.path.join(d, "settings.json"), "w") as fh:
            json.dump(cfg, fh, indent=2)
        return os.path.join(d, "settings.json")

    def render(self, scope="user"):
        code, out = self.run_sl(verb="render", scope=scope)
        return code, out


class TestRouteV(SLBase):
    def test_fresh_install_and_render(self):
        self.make_fake_segment()
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        sl = self.read_settings()["statusLine"]
        self.assertEqual(sl["type"], "command")
        self.assertIn("kittens-statusline.sh", sl["command"])
        wtext = open(ks._sl_paths("user")["wrapper"]).read()
        state, body, _ = ks._sl_parse_wrapper(wtext)
        self.assertEqual(state, "converged")
        code, out = self.render()
        self.assertEqual(code, 0)
        self.assertIn("🐈 chip", out)

    def test_preview_writes_nothing(self):
        self.make_fake_segment()
        code, out = self.run_sl(verb="install", scope="user", yes=False)
        self.assertEqual(code, 0)
        self.assertIn("preview only", out)
        self.assertFalse(os.path.exists(self.settings_path()))
        self.assertFalse(os.path.exists(ks._sl_paths("user")["wrapper"]))

    def test_converged_noop(self):
        self.make_fake_segment()
        self.run_sl(verb="install", scope="user", yes=True)
        before = open(ks._sl_paths("user")["wrapper"]).read()
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 0)
        self.assertIn("already installed", out)
        self.assertEqual(open(ks._sl_paths("user")["wrapper"]).read(), before)

    def test_modified_refused(self):
        self.make_fake_segment()
        self.run_sl(verb="install", scope="user", yes=True)
        w = ks._sl_paths("user")["wrapper"]
        text = open(w).read().replace("sort -V", "sort -V # edited")
        with open(w, "w") as fh:
            fh.write(text)
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 4, out)
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 4, out)
        code, out = self.run_sl(verb="rm", scope="user", yes=True, force_modified=True)
        self.assertEqual(code, 0, out)

    def test_rm_roundtrip_removes_created_key(self):
        self.make_fake_segment()
        self.run_sl(verb="install", scope="user", yes=True)
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        self.assertNotIn("statusLine", self.read_settings())
        husk = open(ks._sl_paths("user")["wrapper"]).read()
        self.assertIn("husk", husk)

    def test_rm_nothing_is_noop(self):
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 0)
        self.assertIn("nothing to remove", out)


class TestRouteW(SLBase):
    def setUp(self):
        super().setUp()
        self.make_fake_segment()
        self.prior = {"type": "command", "command": "echo prior-line"}
        self.write_settings({"statusLine": dict(self.prior), "other": 1})

    def test_wrap_delegates_and_renders_chip(self):
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        ledger = json.load(open(ks._sl_paths("user")["ledger"]))
        self.assertEqual(ledger["displaced"], self.prior)
        code, out = self.render()
        self.assertEqual(code, 0)
        self.assertIn("prior-line", out)
        self.assertIn("🐈 chip", out)

    def test_recursion_guard_suppresses_delegation(self):
        self.run_sl(verb="install", scope="user", yes=True)
        wrapper = ks._sl_paths("user")["wrapper"]
        proc = subprocess.run(["bash", wrapper], input="{}", text=True,
                              capture_output=True,
                              env={**os.environ, "KITTENS_SL_CHILD": "1"})
        self.assertNotIn("prior-line", proc.stdout)
        self.assertIn("🐈 chip", proc.stdout)

    def test_rm_restores_displaced_exactly(self):
        before = self.read_settings()
        self.run_sl(verb="install", scope="user", yes=True)
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.read_settings()["statusLine"], before["statusLine"])
        self.assertEqual(self.read_settings()["other"], 1)

    def test_corrupt_ledger_excises_but_refuses_restore(self):
        self.run_sl(verb="install", scope="user", yes=True)
        with open(ks._sl_paths("user")["ledger"], "w") as fh:
            fh.write("{not json")
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 4, out)
        husk = open(ks._sl_paths("user")["wrapper"]).read()
        self.assertIn("husk", husk)
        self.assertIn("NOT be restored", out + open(ks._sl_paths("user")["wrapper"]).read())


class TestRouteR(SLBase):
    def setUp(self):
        super().setUp()
        self.make_fake_segment()
        self.rail = self.make_rail()
        self.write_settings({"statusLine": {"type": "command", "command": "bunx -y ccstatusline@latest"}})

    def test_inject_and_converge(self):
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        cfg = json.load(open(self.rail))
        cmds = [w.get("commandPath", "") for w in cfg["lines"][0]]
        self.assertTrue(any("kittens-segment.sh" in c for c in cmds))
        self.assertEqual(cfg["lines"][0][0], {"id": "1", "type": "model"})
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 0)
        self.assertIn("already installed", out)

    def test_rm_spares_user_widgets_added_after(self):
        self.run_sl(verb="install", scope="user", yes=True)
        cfg = json.load(open(self.rail))
        cfg["lines"][0].append({"id": "user-later", "type": "custom-command",
                                "commandPath": "echo user-widget"})
        with open(self.rail, "w") as fh:
            json.dump(cfg, fh, indent=2)
        code, out = self.run_sl(verb="rm", scope="user", yes=True)
        self.assertEqual(code, 0, out)
        cfg = json.load(open(self.rail))
        ids = [w["id"] for w in cfg["lines"][0]]
        self.assertIn("user-later", ids)
        self.assertNotIn("kittens-saved-chip", ids)

    def test_settings_untouched_by_rail_install(self):
        before = self.read_settings()
        self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(self.read_settings(), before)


class TestRouteDAndErrors(SLBase):
    def test_dangling_fails_3(self):
        self.write_settings({"statusLine": {"type": "command",
                                            "command": "bash /nonexistent/statusline.sh"}})
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 3, out)
        self.assertIn("/nonexistent/statusline.sh", out)

    def test_unparseable_settings_fails_3_untouched(self):
        p = self.settings_path()
        with open(p, "w") as fh:
            fh.write("{broken json")
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 3, out)
        self.assertEqual(open(p).read(), "{broken json")

    def test_inline_command_is_W_not_D(self):
        self.make_fake_segment()
        self.write_settings({"statusLine": {"type": "command",
                                            "command": "bash -c 'echo /fake/inline/path'"}})
        code, out = self.run_sl(verb="install", scope="user", yes=False)
        self.assertEqual(code, 0, out)
        self.assertIn("route W", out)

    def test_every_failure_prints_remediation(self):
        self.write_settings({"statusLine": {"type": "command",
                                            "command": "bash /nonexistent/x.sh"}})
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertIn("→", out)


class TestStatusAndStale(SLBase):
    def test_unwired_box_is_exit_0(self):
        code, out = self.run_sl(verb="status")
        self.assertEqual(code, 0, out)

    def test_stale_after_cache_removed(self):
        self.make_fake_segment()
        self.run_sl(verb="install", scope="user", yes=True)
        shutil.rmtree(os.path.join(self.home, ".claude", "plugins"))
        code, out = self.run_sl(verb="status", as_json=True)
        self.assertEqual(code, 1)
        rep = json.loads(out)
        user = next(r for r in rep["scopes"] if r["scope"] == "user")
        self.assertEqual(user["state"], "STALE")

    def test_degraded_when_displaced_dangles(self):
        self.make_fake_segment()
        prior_script = os.path.join(self.tmp, "prior.sh")
        with open(prior_script, "w") as fh:
            fh.write("#!/usr/bin/env bash\necho prior\n")
        os.chmod(prior_script, 0o755)
        self.write_settings({"statusLine": {"type": "command", "command": f"bash {prior_script}"}})
        self.run_sl(verb="install", scope="user", yes=True)
        os.remove(prior_script)
        code, out = self.run_sl(verb="status", as_json=True)
        self.assertEqual(code, 1)
        rep = json.loads(out)
        user = next(r for r in rep["scopes"] if r["scope"] == "user")
        self.assertEqual(user["state"], "DEGRADED")

    def test_winning_scope_reported(self):
        self.make_fake_segment()
        self.write_settings({"statusLine": {"type": "command", "command": "echo local-wins"}},
                            scope="local")
        self.run_sl(verb="install", scope="user", yes=True)
        code, out = self.run_sl(verb="status", as_json=True)
        rep = json.loads(out)
        self.assertEqual(rep["winning_scope"], "local")


class TestCwdFallbackNotice(SLBase):
    def test_unset_project_dir_warns_on_stderr_once(self):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        proc = subprocess.run(
            ["python3", os.path.join(HERE, "kittens.py"), "count"],
            capture_output=True, text=True, env=env, cwd=self.proj)
        self.assertIn("CLAUDE_PROJECT_DIR unset — using cwd", proc.stderr)
        self.assertIn(self.proj, proc.stderr)

    def test_set_project_dir_stays_silent(self):
        proc = subprocess.run(
            ["python3", os.path.join(HERE, "kittens.py"), "count"],
            capture_output=True, text=True, env=dict(os.environ), cwd=self.proj)
        self.assertNotIn("CLAUDE_PROJECT_DIR", proc.stderr)


class TestScopesAndConcurrency(SLBase):
    def test_local_wrapper_distinct_and_gitignored(self):
        self.make_fake_segment()
        subprocess.run(["git", "init", "-q"], cwd=self.proj, check=True)
        code, out = self.run_sl(verb="install", scope="local", yes=True)
        self.assertEqual(code, 0, out)
        wrapper = ks._sl_paths("local")["wrapper"]
        self.assertIn("kittens-statusline.local.sh", wrapper)
        gi = open(os.path.join(self.proj, ".gitignore")).read()
        self.assertIn("kittens-statusline.local.sh", gi)

    def test_concurrent_change_aborts_4(self):
        self.make_fake_segment()
        settings = self.settings_path()

        def mutate(path):
            if path == settings:
                self.write_settings({"statusLine": {"type": "command",
                                                    "command": "echo raced-in"}})
        ks._SL_PRE_WRITE_HOOK = mutate
        code, out = self.run_sl(verb="install", scope="user", yes=True)
        self.assertEqual(code, 4, out)
        self.assertEqual(self.read_settings()["statusLine"]["command"], "echo raced-in")


if __name__ == "__main__":
    unittest.main(verbosity=1)
