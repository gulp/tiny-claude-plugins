#!/usr/bin/env python3
"""Sandboxed tests for mirroring human-owned residual into Claude Code's task
list as `[human] …` entries.

Two properties carry this feature and both are load-bearing:

* **Create-only.** An item disappearing from a later declaration is not evidence
  the human did it — the agent may just have stopped listing it. Closing on that
  basis would silently drop a real obligation.
* **Deduped by subject.** Every escape restates the WHOLE residual, so without
  dedup a session declaring three times files nine tasks.

Every test runs against a throwaway HOME + CLAUDE_CONFIG_DIR — no test may read
or write the real ~/.claude/tasks.
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
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("kittens_tasks", os.path.join(HERE, "kittens.py"))
ks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ks)

SESSION = "11111111-2222-3333-4444-555555555555"


class TasksBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kittens-tasks-test-")
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

    def escape(self, yours_items, yours=None, session=SESSION, no_tasks=False):
        args = argparse.Namespace(
            session=session, mine=0, yours=yours if yours is not None else len(yours_items),
            reason="", yours_item=list(yours_items), mine_item=[], no_tasks=no_tasks,
        )
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            ks.cmd_escape(args)
        return buf.getvalue()

    def tasks(self, session=SESSION):
        d = os.path.join(self.cfg, "tasks", session)
        return ks._read_tasks(d)


class TestFiling(TasksBase):
    def test_human_items_land_in_the_task_list_with_the_prefix(self):
        self.escape(["decide whether the repo goes public"])
        got = self.tasks()
        self.assertEqual(len(got), 1)
        self.assertTrue(got[0]["subject"].startswith("[human] "))
        self.assertIn("decide whether the repo goes public", got[0]["subject"])

    def test_full_text_survives_in_the_description(self):
        long_item = ("run the usability probe past someone who has never used the tool, "
                     "record the yes/no verdict, and only then decide whether the renderer "
                     "gets built at all — this is a hard gate on two later sections")
        self.escape([long_item])
        got = self.tasks()[0]
        self.assertEqual(got["description"], long_item)
        self.assertLess(len(got["subject"]), len(long_item))
        self.assertTrue(got["subject"].endswith("…"))

    def test_schema_matches_what_claude_code_writes(self):
        # The seven keys Claude Code always writes, plus `metadata` — which it
        # supports and persists as a first-class key (verified against a task
        # created through the TaskCreate tool), and which we always set so a
        # filed item has an identity that survives subject edits.
        self.escape(["a thing"])
        got = self.tasks()[0]
        self.assertEqual(set(got), {"id", "subject", "description", "activeForm",
                                    "status", "blocks", "blockedBy", "metadata"})
        self.assertEqual(got["status"], "pending")
        self.assertEqual(got["blocks"], [])
        self.assertEqual(got["blockedBy"], [])

    def test_agent_owned_items_are_never_filed(self):
        args = argparse.Namespace(
            session=SESSION, mine=1, yours=0, reason="", yours_item=[],
            mine_item=["finish the migration myself"], no_tasks=False)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            ks.cmd_escape(args)
        self.assertEqual(self.tasks(), [])


class TestDedup(TasksBase):
    """Escapes restate the whole residual; filing must not multiply."""

    def test_redeclaring_the_same_item_files_it_once(self):
        self.escape(["same obligation"])
        self.escape(["same obligation"])
        self.escape(["same obligation"])
        self.assertEqual(len(self.tasks()), 1)

    def test_a_new_item_in_a_later_declaration_is_added(self):
        self.escape(["first"])
        self.escape(["first", "second"])
        subjects = sorted(t["subject"] for t in self.tasks())
        self.assertEqual(len(subjects), 2)
        self.assertTrue(any("second" in s for s in subjects))

    def test_ids_do_not_collide_with_tasks_already_there(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "7.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "7", "subject": "pre-existing agent task",
                       "description": "", "activeForm": "", "status": "completed",
                       "blocks": [], "blockedBy": []}, fh)
        self.escape(["mine now"])
        ids = sorted(int(t["id"]) for t in self.tasks())
        self.assertEqual(ids, [7, 8])

    def test_highwatermark_is_a_floor_after_a_clear(self):
        # The failure this prevents: clear-all deletes every *.json and records
        # the highest id in .highwatermark so numbering does not restart. An
        # allocator reading only the files sees an empty dir, starts at 1, and
        # collides with ids the harness still considers spent.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, ".highwatermark"), "w", encoding="utf-8") as fh:
            fh.write("31\n")
        self.escape(["first after a clear"])
        self.assertEqual([t["id"] for t in self.tasks()], ["32"])

    def test_highwatermark_loses_to_a_higher_live_id(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, ".highwatermark"), "w", encoding="utf-8") as fh:
            fh.write("5\n")
        with open(os.path.join(d, "60.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "60", "subject": "live and higher", "description": "",
                       "activeForm": "", "status": "pending", "blocks": [], "blockedBy": []}, fh)
        self.escape(["next one"])
        self.assertIn("61", [t["id"] for t in self.tasks()])

    def test_highwatermark_is_never_written(self):
        # The clear path owns that file; a creator that bumps it would inflate
        # every later id.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        hw = os.path.join(d, ".highwatermark")
        with open(hw, "w", encoding="utf-8") as fh:
            fh.write("31\n")
        self.escape(["something"])
        with open(hw, encoding="utf-8") as fh:
            self.assertEqual(fh.read().strip(), "31")

    def test_unparseable_highwatermark_falls_back_to_the_file_floor(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, ".highwatermark"), "w", encoding="utf-8") as fh:
            fh.write("not a number")
        self.escape(["still works"])
        self.assertEqual([t["id"] for t in self.tasks()], ["1"])

    def test_a_pre_existing_task_is_never_overwritten(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "1.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": "agent's own work",
                       "description": "do not touch", "activeForm": "", "status": "in_progress",
                       "blocks": [], "blockedBy": []}, fh)
        self.escape(["something of the human's"])
        kept = [t for t in self.tasks() if t["subject"] == "agent's own work"]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["description"], "do not touch")
        self.assertEqual(kept[0]["status"], "in_progress")


class TestOwnerMarkerContract(TasksBase):
    """The marker convention is cctasks' (#67), not ours. We reimplement it so
    the plugin works on a box without cctasks, which means the two can drift —
    so the contract is asserted against the live publisher when it is available,
    and against its documented examples always."""

    def test_regex_still_matches_the_published_spec(self):
        # `cctasks` is being renamed to `ultratask`; try the new name first and
        # keep the old as a fallback. The rename would not FAIL this test — it
        # would make it silently skip, dropping the only cross-tool check that
        # keeps the two owner regexes in agreement. A skip that looks like a
        # pass is the worst outcome available here, so the lookup has to know
        # both names (flagged by the cctasks session, 2026-08-13).
        exe = shutil.which("ultratask") or shutil.which("cctasks")
        if not exe:
            self.skipTest("neither ultratask nor cctasks on PATH — contract asserted by examples only")
        out = subprocess.run([exe, "-j", "--owner-spec"], capture_output=True,
                             text=True, timeout=20)
        spec = json.loads(out.stdout)
        self.assertEqual(spec["match"], ks._HUMAN_MARK.pattern)
        self.assertEqual(spec["canonical"], "[human] Subject")

    def test_both_shapes_reduce_to_the_same_key(self):
        self.assertEqual(ks._bare_subject("[human] Restart the nvims"),
                         ks._bare_subject("Restart the nvims [human]"))
        self.assertEqual(ks._bare_subject("Restart the nvims [human]"), "Restart the nvims")

    def test_sloppy_spacing_and_case_reduce(self):
        self.assertEqual(ks._bare_subject("  [HUMAN]   Sloppy   spacing  "), "Sloppy spacing")

    def test_marker_at_both_ends_reduces_fully(self):
        # Stripping is applied twice on purpose.
        self.assertEqual(ks._bare_subject("[human] Doubly marked [human]"), "Doubly marked")

    def test_the_decoy_stays_agent_owned(self):
        # A subject that merely CONTAINS the word must not be captured — a
        # substring match here would silently steal ownership of ordinary tasks.
        self.assertFalse(ks._is_human_owned("Fix the human-readable output"))
        self.assertFalse(ks._is_human_owned("humanise the error copy"))
        self.assertEqual(ks._bare_subject("Fix the human-readable output"),
                         "Fix the human-readable output")

    def test_a_suffix_marked_task_dedups_against_our_prefix_filing(self):
        # The exact duplication this replaces: #58 in the wild is suffix-marked,
        # and exact-subject matching would have filed a second copy.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "1.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": "Restart the nvims [human]", "description": "",
                       "activeForm": "", "status": "pending", "blocks": [], "blockedBy": []}, fh)
        self.escape(["Restart the nvims"])
        self.assertEqual(len(self.tasks()), 1)

    def test_an_agent_task_with_the_same_wording_does_not_suppress_filing(self):
        # Dedup is scoped to human-owned tasks: an unrelated agent task that
        # happens to share wording must not swallow a human obligation.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "1.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": "Approve the release", "description": "",
                       "activeForm": "", "status": "pending", "blocks": [], "blockedBy": []}, fh)
        self.escape(["Approve the release"])
        self.assertEqual(len(self.tasks()), 2)


class TestStableIdentity(TasksBase):
    """Text is not an identity. bareSubject fixed the marker-shape problem but
    the join still breaks when EITHER side is edited — observed twice for real:
    re-wording a declared item, and tidying a task's subject via TaskUpdate. Both
    filed duplicates. A hash of the item text in `metadata` survives both."""

    def test_filed_tasks_carry_a_stable_key(self):
        self.escape(["approve the release"])
        got = self.tasks()[0]
        self.assertEqual(got["metadata"]["owner"], "human")
        self.assertTrue(got["metadata"]["kittensKey"].startswith("sha256:"))

    def test_editing_the_task_subject_does_not_cause_a_duplicate(self):
        # The exact failure: file an item, then someone tidies the subject.
        self.escape(["approve the release"])
        d = os.path.join(self.cfg, "tasks", SESSION)
        path = os.path.join(d, "1.json")
        with open(path, encoding="utf-8") as fh:
            t = json.load(fh)
        t["subject"] = "[human] Approve the release (tidied wording)"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(t, fh)
        self.escape(["approve the release"])          # same item, drifted task
        self.assertEqual(len(self.tasks()), 1)

    def test_key_ignores_whitespace_noise_in_the_item(self):
        self.escape(["approve   the release"])
        self.escape([" approve the   release "])
        self.assertEqual(len(self.tasks()), 1)

    def test_text_fallback_still_catches_an_agent_filed_task(self):
        # A task the AGENT filed via TaskCreate carries no kittensKey; matching
        # it by text is correct there, because nothing has drifted yet.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "1.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": "[human] approve the release", "description": "",
                       "activeForm": "", "status": "pending", "blocks": [], "blockedBy": []}, fh)
        self.escape(["approve the release"])
        self.assertEqual(len(self.tasks()), 1)


class TestLockingAndAtomicity(TasksBase):
    """Claude Code and cctasks both lock a list via proper-lockfile, which is
    mkdir-based: locking `<listdir>/.lock` creates the DIRECTORY
    `<listdir>/.lock.lock`. We must take the same one, and must never leave a
    half-written task where another reader can see it."""

    def test_the_lock_directory_is_released(self):
        self.escape(["something"])
        d = os.path.join(self.cfg, "tasks", SESSION)
        self.assertFalse(os.path.exists(os.path.join(d, ".lock.lock")))

    def test_a_held_lock_does_not_lose_the_item(self):
        # A lock we cannot take must not cost the human their obligation —
        # filing unlocked beats dropping it. Held lock is fresh, so the stale
        # breaker must not fire within the retry window.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        os.mkdir(os.path.join(d, ".lock.lock"))
        try:
            self.escape(["must not be lost"], )
        finally:
            os.rmdir(os.path.join(d, ".lock.lock"))
        self.assertEqual(len(self.tasks()), 1)

    def test_a_stale_lock_is_broken(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        lock = os.path.join(d, ".lock.lock")
        os.mkdir(lock)
        old = time.time() - 3600
        os.utime(lock, (old, old))
        self.escape(["filed after breaking a dead lock"])
        self.assertEqual(len(self.tasks()), 1)
        self.assertFalse(os.path.exists(lock))

    def test_no_temp_files_are_left_behind(self):
        self.escape(["a", "b", "c"])
        d = os.path.join(self.cfg, "tasks", SESSION)
        leftovers = [n for n in os.listdir(d) if n.endswith(".tmp") or n.startswith(".kittens-")]
        self.assertEqual(leftovers, [])

    def test_an_existing_id_file_is_never_clobbered(self):
        # tmp-plus-rename would overwrite; the exists-check under the lock is
        # what preserves the never-clobber property.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "1.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": "precious agent task", "description": "keep",
                       "activeForm": "", "status": "in_progress", "blocks": [], "blockedBy": []}, fh)
        self.assertFalse(ks._write_task_atomically(path, {"id": "1", "subject": "clobber"}))
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["description"], "keep")


class TestCreateOnly(TasksBase):
    def test_dropping_an_item_does_not_close_its_task(self):
        # The whole asymmetry: the agent no longer listing an item is not
        # evidence the human did it.
        self.escape(["will be dropped next time"])
        self.escape(["something else entirely"])
        subjects = [t["subject"] for t in self.tasks()]
        self.assertTrue(any("will be dropped" in s for s in subjects))
        dropped = [t for t in self.tasks() if "will be dropped" in t["subject"]][0]
        self.assertEqual(dropped["status"], "pending")

    def test_declaring_zero_items_touches_nothing(self):
        self.escape(["keep me"])
        self.escape([], yours=0)
        self.assertEqual(len(self.tasks()), 1)


class TestListIdResolution(TasksBase):
    """`<config>/tasks/<session-id>/` is only the DEFAULT. A project that sets
    CLAUDE_CODE_TASK_LIST_ID never gets a session-UUID dir at all, so resolving
    to the UUID writes into a directory nothing reads — and no "unknown session"
    guard catches it, because the session id is perfectly known."""

    def tearDown(self):
        os.environ.pop("CLAUDE_CODE_TASK_LIST_ID", None)
        super().tearDown()

    def test_env_var_beats_the_session_uuid(self):
        os.environ["CLAUDE_CODE_TASK_LIST_ID"] = "projects-playground"
        self.assertEqual(ks._tasks_dir(SESSION),
                         os.path.join(self.cfg, "tasks", "projects-playground"))

    def test_items_land_in_the_named_list_not_a_phantom_uuid_dir(self):
        os.environ["CLAUDE_CODE_TASK_LIST_ID"] = "projects-playground"
        self.escape(["goes to the named list"])
        named = ks._read_tasks(os.path.join(self.cfg, "tasks", "projects-playground"))
        self.assertEqual(len(named), 1)
        self.assertFalse(os.path.exists(os.path.join(self.cfg, "tasks", SESSION)))

    def test_project_settings_env_is_read_when_the_var_is_unset(self):
        s = os.path.join(self.proj, ".claude", "settings.json")
        with open(s, "w", encoding="utf-8") as fh:
            json.dump({"env": {"CLAUDE_CODE_TASK_LIST_ID": "from-settings"}}, fh)
        cwd = os.getcwd()
        try:
            os.chdir(self.proj)
            self.assertEqual(ks._tasks_dir(SESSION),
                             os.path.join(self.cfg, "tasks", "from-settings"))
        finally:
            os.chdir(cwd)

    def test_settings_local_wins_over_committed_settings(self):
        base = os.path.join(self.proj, ".claude")
        with open(os.path.join(base, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"env": {"CLAUDE_CODE_TASK_LIST_ID": "committed"}}, fh)
        with open(os.path.join(base, "settings.local.json"), "w", encoding="utf-8") as fh:
            json.dump({"env": {"CLAUDE_CODE_TASK_LIST_ID": "local"}}, fh)
        cwd = os.getcwd()
        try:
            os.chdir(self.proj)
            self.assertTrue(ks._tasks_dir(SESSION).endswith("local"))
        finally:
            os.chdir(cwd)

    def test_env_var_beats_settings(self):
        s = os.path.join(self.proj, ".claude", "settings.json")
        with open(s, "w", encoding="utf-8") as fh:
            json.dump({"env": {"CLAUDE_CODE_TASK_LIST_ID": "from-settings"}}, fh)
        os.environ["CLAUDE_CODE_TASK_LIST_ID"] = "from-env"
        cwd = os.getcwd()
        try:
            os.chdir(self.proj)
            self.assertTrue(ks._tasks_dir(SESSION).endswith("from-env"))
        finally:
            os.chdir(cwd)

    def test_empty_string_list_id_is_not_a_list_id(self):
        # Live on this box: ~/.claude/settings.json defines the key as "".
        # Letting it through yields os.path.join(cfg, "tasks", "") == the tasks
        # ROOT, so task files would be written loose among the list directories
        # instead of inside one. Must fall through to the session UUID.
        with open(os.path.join(self.cfg, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"env": {"CLAUDE_CODE_TASK_LIST_ID": ""}}, fh)
        resolved = ks._tasks_dir(SESSION)
        self.assertEqual(resolved, os.path.join(self.cfg, "tasks", SESSION))
        self.assertNotEqual(os.path.normpath(resolved), os.path.normpath(os.path.join(self.cfg, "tasks")))

    def test_empty_env_var_is_not_a_list_id(self):
        os.environ["CLAUDE_CODE_TASK_LIST_ID"] = ""
        try:
            self.assertEqual(ks._tasks_dir(SESSION), os.path.join(self.cfg, "tasks", SESSION))
        finally:
            os.environ.pop("CLAUDE_CODE_TASK_LIST_ID", None)

    def test_unparseable_settings_file_does_not_break_resolution(self):
        with open(os.path.join(self.proj, ".claude", "settings.json"), "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        cwd = os.getcwd()
        try:
            os.chdir(self.proj)
            self.assertEqual(ks._tasks_dir(SESSION), os.path.join(self.cfg, "tasks", SESSION))
        finally:
            os.chdir(cwd)

    def test_a_named_list_is_shared_so_dedup_spans_sessions(self):
        # Per-PROJECT, not per-session: a second session filing the same item
        # must not double it.
        os.environ["CLAUDE_CODE_TASK_LIST_ID"] = "shared"
        self.escape(["one obligation"], session=SESSION)
        self.escape(["one obligation"], session="99999999-8888-7777-6666-555555555555")
        named = ks._read_tasks(os.path.join(self.cfg, "tasks", "shared"))
        self.assertEqual(len(named), 1)


class TestBypassIsNamed(TasksBase):
    """Having to CREATE a task proves TaskCreate was never called for it — a
    compliant agent's item already exists and dedups to nothing. That bypass is
    otherwise invisible (the write succeeds, the agent's own TaskList shows the
    item, only the human's overlay is stale), so it has to be said out loud."""

    def test_creating_warns_that_taskcreate_was_skipped(self):
        out = self.escape(["never filed via the tool"])
        self.assertIn("did not call TaskCreate", out)
        self.assertIn("Ctrl+T", out)

    def test_the_warning_does_not_advise_an_action_that_duplicates(self):
        # The item is already on disk by the time this prints, so telling the
        # agent to "file it with TaskCreate" would produce a second copy. The
        # remedy after the fact is a touch; TaskCreate is a *before* instruction.
        out = self.escape(["would be duplicated"])
        self.assertIn("DUPLICATE", out)
        self.assertIn("BEFORE escape", out)

    def test_no_warning_when_the_agent_already_filed_it(self):
        # Simulate the compliant path: the task is already there, so the
        # backstop creates nothing and must stay quiet.
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        subject = ks._task_subject("already filed by the agent")
        with open(os.path.join(d, "1.json"), "w", encoding="utf-8") as fh:
            json.dump({"id": "1", "subject": subject, "description": "", "activeForm": "",
                       "status": "pending", "blocks": [], "blockedBy": []}, fh)
        out = self.escape(["already filed by the agent"])
        self.assertNotIn("did not call TaskCreate", out)
        self.assertEqual(len(self.tasks()), 1)

    def test_partial_compliance_warns_only_about_the_gap(self):
        self.escape(["first one"])          # creates -> warns
        out = self.escape(["first one", "second one"])
        self.assertIn("did not call TaskCreate", out)
        self.assertIn("second one", out)
        self.assertNotIn("· first one", out)  # already existed, not re-reported


class TestRefusals(TasksBase):
    def test_unknown_session_files_nothing_and_says_so(self):
        out = self.escape(["would be orphaned"], session="default")
        self.assertEqual(ks._tasks_dir("default"), None)
        self.assertIn("session id unknown", out)

    def test_no_tasks_flag_suppresses_filing(self):
        self.escape(["not to be filed"], no_tasks=True)
        self.assertEqual(self.tasks(), [])

    def test_config_dir_override_is_honoured(self):
        # A box that moved its config dir must not get tasks written to a
        # phantom ~/.claude, where they would be created successfully and read
        # by nobody.
        self.assertTrue(ks._tasks_dir(SESSION).startswith(self.cfg))

    def test_unparseable_neighbour_does_not_abort_filing(self):
        d = os.path.join(self.cfg, "tasks", SESSION)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "3.json"), "w", encoding="utf-8") as fh:
            fh.write("{not json at all")
        self.escape(["still gets filed"])
        subjects = [t["subject"] for t in self.tasks()]
        self.assertTrue(any("still gets filed" in s for s in subjects))


if __name__ == "__main__":
    unittest.main(verbosity=2)
