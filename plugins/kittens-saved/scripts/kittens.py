#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""kittens-saved — count the kittens you save, and gate your escape hatch.

One kitten dies when the agent leaves the human with "just two more things".
This script is the ledger and the referee:

  * `save`      — the agent did a savable item instead of punting it back.
  * `escape`    — the agent declares its residual (how many are MINE vs YOURS)
                  and asks to stop. GRANTED only when zero are mine.
  * `count`     — the human (or agent) reads the tally.
  * `toggle`    — the human silences/enables the Stop-hook enforcement.
  * `status` / `stats` / `doctor` / `config` — user-ops read/repair surface,
                  fronted by the `/kittens` skill.
  * `hook-stop` / `hook-session-start` — wired from hooks/hooks.json.
  * `statusline` — a compact segment: saved + waiting-on-you.

State splits by true owner (tcp-4zi): the append-only JSONL ledger stays
per-project at `$CLAUDE_PROJECT_DIR/.claude/.kittens-saved/<session-id>.jsonl`;
session mute markers and deny/warn overrides live operator-global under
`~/.claude/.kittens-saved/`. Stdlib only,
so it runs under a bare `python3` (no cold start on the statusline hot path)
as well as `uv run`.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import glob as _glob
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time

REMINDER = (
    "<kitten-reminder>one kitten dies when you leave me with \"just two more "
    "things\" --especially after long hours of discussion on the \"lazy opus\" "
    "behavior</kitten-reminder>"
)

# High-confidence "opus laziness" tells: phrases that almost always mark a
# hand-back the agent could have done itself. Deliberately TIGHT (favour low
# false-positives over recall) — the Stop hook only nudges on a match, so a
# noisy list would reintroduce the every-stop spam we are removing. Users
# extend/override via `~/.claude/.kittens-saved/denylist.txt` (one regex per
# line, operator-global). Matched
# case-insensitively against the last assistant message only.
LAZY_DEFAULTS = [
    r"just (a )?(two|couple( of)?|few) more (things?|steps?|items?|tweaks?)",
    r"(left|leaving) (that|these|it|this|the rest|them) (for|to) you\b",
    r"next steps? for you\b",
    r"i'?ll leave (that|it|this|the rest|the details) (up )?to you",
    r"exercise (is )?(left )?for the reader",
    r"\bfor you to (do|finish|complete|handle|implement|wire|write)\b",
    r"remaining (work|items?|steps?|tasks?)[^.\n]{0,24}(for you|are yours|yours to)",
    r"i'?ll let you (handle|do|take|finish|wire|implement)\b",
]

# Short, Python-Zen-flavoured. Printed at SessionStart and via `kittens.py zen`.
ZEN_OF_KITTENS = [
    "Done beats \"just two more things.\"",
    "If you can do it, you save it.",
    "A hand-back is a punt wearing a tidy list.",
    "\"You should now…\" are a kitten's last words.",
    "Honest residual beats a clean-looking summary.",
    "The work you can describe is the work you could have done.",
    "Scope is a reason, never an excuse.",
    "Two more things are still your things.",
    "A soft nudge is silver; a wall of reminders is a dead kitten.",
    "When the next step is obvious, take it — don't narrate it.",
]

# The SOFT tier. Where the denylist is high-confidence PUNT tells (a nudge to act),
# the warnlist is lower-confidence STYLE/sycophancy tells (a gentle [i] that
# teaches). Each entry carries a `reason` (why it reads as a tell) and an
# `escape` (when it's fine) — that's why it must be structured, not flat text.
# Seeded from the community folk-taxonomy (docs/research/…-telltale-signs). Users
# extend via `warn add` → warnlist.json.
WARN_DEFAULTS = [
    {"matcher": r"\bi'?ll\b",
     "reason": "\"I'll …\" often precedes a deferral — a thing you promise instead of doing now.",
     "escape": "if you genuinely just did it, or it's truly the human's, ignore and stop."},
    {"matcher": r"you'?re absolutely right",
     "reason": "reflexive agreement reads as sycophancy, not analysis.",
     "escape": "if you actually verified the claim, say how; else drop the flourish."},
    {"matcher": r"the sharpest (point|thing|insight|version)",
     "reason": "significance-theater — asserts importance without adding any.",
     "escape": "cut it, or name the specific thing that's sharp."},
    {"matcher": r"let me (pressure|stress)[- ]?test",
     "reason": "narrating rigor instead of doing it.",
     "escape": "if you're about to actually test it, just run the test."},
    {"matcher": r"deliberately did not",
     "reason": "often precedes a punt — a thing you chose not to do and are handing back.",
     "escape": "if it's a genuine scope/safety decision you're disclosing honestly, ignore and stop."},
]

_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


_CWD_FALLBACK_WARNED = False


def _project_dir() -> str:
    """CLAUDE_PROJECT_DIR, else cwd — loudly. The env var does NOT reach
    Bash-tool subprocesses (vault-49q, 2026-08-10): CLI calls then resolve
    state by cwd and scatter per-repo, which is by design for hooks but a
    silent surprise for a human-driven call. One stderr notice per process
    makes the scatter visible at write time without breaking any output
    contract (all machine output is stdout)."""
    d = os.environ.get("CLAUDE_PROJECT_DIR")
    if d:
        return d
    global _CWD_FALLBACK_WARNED
    cwd = os.getcwd()
    if not _CWD_FALLBACK_WARNED:
        _CWD_FALLBACK_WARNED = True
        print(f"kittens: CLAUDE_PROJECT_DIR unset — using cwd {cwd}", file=sys.stderr)
    return cwd


def _state_dir() -> str:
    """Per-PROJECT state home: the ledger (per-project stats are deliberate,
    see cmd_stats) and the project/local statusline ledgers. Session mutes and
    operator config live in _global_dir() instead (tcp-4zi)."""
    d = os.path.join(_project_dir(), ".claude", ".kittens-saved")
    os.makedirs(d, exist_ok=True)
    return d


def _global_dir() -> str:
    """Operator-GLOBAL state home (~/.claude/.kittens-saved), cwd-independent.
    Holds the state whose true owner is not the project (tcp-4zi): session mute
    markers ("quiet this conversation" is a session act, not a repo's) and the
    denylist/warnlist overrides (punt-phrase taste is the operator's, not the
    repo's). Keying these by cwd fragmented them per-repo — a `toggle off` in
    one repo left the SAME session nagged in another."""
    d = os.path.join(os.path.expanduser("~"), ".claude", ".kittens-saved")
    os.makedirs(d, exist_ok=True)
    return d


def _resolve_session(explicit: str | None, stdin_payload: dict | None) -> str:
    """--session wins, then hook stdin, then env, then 'default'. A traversal
    char anywhere in the id collapses it to 'default' rather than escaping the
    state dir (same defense dumbzone applies before interpolating an id)."""
    for cand in (
        explicit,
        (stdin_payload or {}).get("session_id"),
        os.environ.get("CLAUDE_CODE_SESSION_ID"),
    ):
        if cand and _ID_OK.match(str(cand)):
            return str(cand)
    return "default"


HUMAN_PREFIX = "[human] "


def _config_dir() -> str:
    """Claude Code's own config home. CLAUDE_CONFIG_DIR is its documented
    override; honouring it matters here in a way it does not for `_global_dir`,
    because the tasks directory is read by Claude Code rather than by us — write
    to a phantom ~/.claude on a box that moved its config and the tasks are
    created successfully and seen by nobody."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


def _settings_task_list_id() -> str | None:
    """`env.CLAUDE_CODE_TASK_LIST_ID` from the nearest settings layer.

    Walks cwd upward to $HOME (local before committed at each level, matching
    Claude Code's own precedence), then falls back to ~/.claude/settings.json.
    """
    seen = []
    cur = os.path.abspath(os.getcwd())
    home = os.path.abspath(os.path.expanduser("~"))
    while True:
        seen.append(os.path.join(cur, ".claude"))
        if cur == home or os.path.dirname(cur) == cur:
            break
        cur = os.path.dirname(cur)
    seen.append(os.path.join(_config_dir()))
    for base in seen:
        for name in ("settings.local.json", "settings.json"):
            try:
                with open(os.path.join(base, name), encoding="utf-8") as fh:
                    val = (json.load(fh).get("env") or {}).get("CLAUDE_CODE_TASK_LIST_ID")
            except (OSError, json.JSONDecodeError, ValueError, AttributeError):
                continue
            if val and _ID_OK.match(str(val)):
                return str(val)
    return None


def _tasks_dir(session: str, explicit: str | None = None) -> str | None:
    """Claude Code's task list directory — NOT simply <config>/tasks/<session-id>.

    The session UUID is only the DEFAULT. `CLAUDE_CODE_TASK_LIST_ID` (normally
    set in a project's settings `env`) replaces it, and when it is set the
    session UUID directory is never created at all. Resolving to the UUID
    regardless is the failure this ordering exists to prevent: the session id is
    perfectly *known*, so no "unknown session" guard catches it — the write
    simply succeeds into a fresh directory that nothing reads. Caught by the
    cctasks session, 2026-08-13, which had already mapped this.

    A named list is per-PROJECT, not per-session: several sessions share it and
    filed items outlive the session that filed them. That is what makes dedup
    load-bearing rather than merely tidy.

    Deliberately NOT in the chain: "newest-written list dir". cctasks uses it as
    a last resort and is right to, being read-only — a reader that guesses wrong
    shows you the wrong list, while a WRITER that guesses wrong injects the
    human's obligations into an unrelated project's list. For writes, no answer
    beats a wrong one.
    """
    for cand in (explicit, os.environ.get("CLAUDE_CODE_TASK_LIST_ID"), _settings_task_list_id()):
        if cand and _ID_OK.match(str(cand)):
            return os.path.join(_config_dir(), "tasks", str(cand))
    if session == "default" or not _ID_OK.match(session):
        return None
    return os.path.join(_config_dir(), "tasks", session)


@contextlib.contextmanager
def _task_list_lock(d: str, tries: int = 30, wait: float = 0.05, stale: float = 10.0):
    """Take the SAME lock Claude Code and cctasks take on a task list.

    The harness locks via proper-lockfile, which is mkdir-based: locking
    `<listdir>/.lock` creates the DIRECTORY `<listdir>/.lock.lock` and heartbeats
    its mtime. So the thing to create is `.lock.lock`, not `.lock` — a detail
    that is genuinely confusing to discover later (cctasks session, 2026-08-13).
    `os.mkdir` is atomic, which is the whole reason that shape was chosen.

    Retry 30x50ms, then break a lock older than `stale` rather than hang on a
    writer that crashed — matching proper-lockfile's own staleness window. A
    lock we cannot take is not fatal: filing a human item is worth more than
    strict mutual exclusion against a process that may not exist, so we proceed
    unlocked rather than drop the item, and say nothing because the caller has
    no useful response to it.
    """
    path = os.path.join(d, ".lock.lock")
    held = False
    for _ in range(tries):
        try:
            os.mkdir(path)
            held = True
            break
        except FileExistsError:
            try:
                if time.time() - os.stat(path).st_mtime > stale:
                    os.rmdir(path)
                    continue
            except OSError:
                pass
            time.sleep(wait)
        except OSError:
            break
    try:
        yield held
    finally:
        if held:
            try:
                os.rmdir(path)
            except OSError:
                pass


def _write_task_atomically(path: str, payload: dict) -> bool:
    """tmp-plus-rename inside the same directory, so no reader ever sees a
    half-written task. Returns False without touching anything if the target
    already exists — `os.replace` would clobber, and this function must keep the
    never-overwrite property the old exclusive-create gave for free.
    Callers hold the list lock, which is what makes the exists-check race-free."""
    if os.path.exists(path):
        return False
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".kittens-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def _read_tasks(d: str) -> list[dict]:
    out = []
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                out.append(json.load(fh))
        except (OSError, json.JSONDecodeError, ValueError):
            continue  # a task file we cannot parse is Claude Code's, not ours to repair
    return out


# The ownership-marker contract, published by cctasks (#67, 2026-08-13) via
# `cctasks -j --owner-spec`. Implemented here rather than shelled out to, so the
# plugin keeps working on a box without cctasks — but the spec is THEIRS, and
# `test_kittens_tasks.py` asserts this regex still equals the one they publish
# whenever cctasks is on PATH, so the two cannot drift silently.
#
# Anchored to the ends on purpose: a subject that merely CONTAINS the word human
# stays agent-owned. A substring match would silently steal ownership of ordinary
# tasks, which is why their test set keeps a decoy and so does ours.
_HUMAN_MARK = re.compile(r"(?i)(^\s*\[human\]\s*|\s*\[human\]\s*$)")


def _bare_subject(subject: str) -> str:
    """The dedup key: subject with the ownership marker stripped, whitespace
    collapsed, trimmed. Stripping runs TWICE so a subject carrying the marker at
    both ends reduces fully, matching cctasks' own rule."""
    s = _HUMAN_MARK.sub(" ", str(subject))
    s = _HUMAN_MARK.sub(" ", s)
    return " ".join(s.split())


def _is_human_owned(subject: str) -> bool:
    return bool(_HUMAN_MARK.search(str(subject)))


def _item_key(item: str) -> str:
    """Stable id for a declared item: a hash of its whitespace-collapsed text.
    Survives any later edit to the task's subject or description, which plain
    text matching does not."""
    return "sha256:" + hashlib.sha256(" ".join(str(item).split()).encode("utf-8")).hexdigest()[:16]


def _task_subject(item: str, width: int = 96) -> str:
    """`[human] ` + a one-line subject. The full text still goes in the
    description, so truncation loses nothing — it only keeps the list readable."""
    flat = " ".join(item.split())
    if len(flat) > width:
        flat = flat[: width - 1].rstrip() + "…"
    return HUMAN_PREFIX + flat


def write_human_tasks(session: str, items: list[str]) -> tuple[list[str], str | None]:
    """Mirror human-owned residual into Claude Code's task list. CREATE-ONLY.

    Deduped by subject because every escape restates the WHOLE residual — the
    ledger has no identity across declarations, so without dedup a session that
    declares three times files nine tasks.

    Nothing here ever closes or edits an existing task. An item vanishing from a
    later declaration is not evidence the human did it; the agent may simply have
    stopped listing it. The asymmetry is deliberate and runs the cheap way: a
    spurious task costs one dismissal, silently closing a live obligation costs
    the obligation.

    KNOWN LIMIT — this reaches the model's views but not the human's TUI.
    `TaskList` and the injected task reminder re-read this directory per call,
    so a file written here is visible to the agent at once (measured 2026-08-13,
    independently confirmed by the cctasks session). The Ctrl+T overlay refreshes
    on a harness-driven task mutation rather than on open, so a task only this
    function created sits invisible there until some later tool call touches a
    task. Because `escape` runs at the END of a turn, that later call usually
    never comes. Hence the skill instructs `TaskCreate` as the primary path and
    treats this as reconciliation: filing an item the human cannot see is most of
    a no-op, since being seen is the whole purpose.

    Returns (created_subjects, dir) — dir is None when there was nowhere to write.
    """
    d = _tasks_dir(session)
    if d is None:
        return [], None
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        return [], None

    # Everything below — reading the list, allocating ids, writing — happens
    # under the harness's own lock. Scanning outside it lets `cctasks done` or
    # Claude Code land a write between our read and our allocation, which is
    # precisely how two tasks end up sharing an id.
    with _task_list_lock(d):
        return _file_tasks_locked(d, items)


def _file_tasks_locked(d: str, items: list[str]) -> tuple[list[str], str | None]:
    existing = _read_tasks(d)
    # Dedup on cctasks' `bareSubject`, not on the literal subject: the marker
    # exists in the wild as BOTH a prefix and a suffix (#58 predates this code),
    # so exact-string matching files the same obligation twice. Restricted to
    # HUMAN-OWNED tasks — an unrelated agent task that happens to share wording
    # must not suppress filing a human obligation, which a bare-subject match
    # across all tasks would do.
    seen = {_bare_subject(t.get("subject", ""))
            for t in existing if _is_human_owned(t.get("subject", ""))}
    # Stable identity, because TEXT IS NOT ONE. bareSubject fixed the two-marker-
    # shapes problem but not the join problem: the key breaks when EITHER side is
    # edited, and editing is legitimate on both. Observed twice on 2026-08-13 —
    # once re-wording the declared item, once tidying a task's truncated subject
    # via TaskUpdate; each filed a duplicate. `metadata` survives to disk as a
    # first-class key (verified against a tool-created task), so anything we file
    # carries a hash of its item text and is matched on that first. Subject edits
    # then cost nothing.
    keyed = {(t.get("metadata") or {}).get("kittensKey")
             for t in existing if isinstance(t.get("metadata"), dict)}
    keyed.discard(None)
    # Next id is max(highest existing id, .highwatermark) + 1 — BOTH floors.
    # `.highwatermark` is not decoration: clear-all deletes every *.json and
    # writes the highest id into it precisely so numbering does not restart.
    # Allocating from the files alone is correct only until the first clear;
    # after one, the directory is empty, allocation restarts at 1, and the new
    # tasks collide with ids the harness still considers spent. Read it, never
    # write it — the clear path owns it. (cctasks session, 2026-08-13,
    # correcting its own earlier advice that this file was only a prune cursor.)
    next_id = 1
    for t in existing:
        try:
            next_id = max(next_id, int(str(t.get("id", "0"))) + 1)
        except ValueError:
            continue  # non-numeric id: Claude Code's business, just don't collide
    try:
        with open(os.path.join(d, ".highwatermark"), encoding="utf-8") as fh:
            next_id = max(next_id, int(fh.read().strip()) + 1)
    except (OSError, ValueError):
        pass  # absent or unparseable: the file floor stands on its own

    created = []
    for item in items:
        subject = _task_subject(item)
        ident = _item_key(item)
        key = _bare_subject(subject)
        # Identity first, text second. The text fallback still earns its place:
        # an item the AGENT filed through TaskCreate carries no kittensKey, and
        # catching it by text at that moment is right, because nothing has had a
        # chance to drift yet.
        if ident in keyed or key in seen:
            continue
        keyed.add(ident)
        seen.add(key)
        payload = {
            "id": str(next_id),
            "subject": subject,
            "description": item,
            "activeForm": f"Waiting on you — {' '.join(item.split())[:60]}",
            "status": "pending",
            "blocks": [],
            "blockedBy": [],
            "metadata": {"kittensKey": ident, "owner": "human"},
        }
        path = os.path.join(d, f"{next_id}.json")
        if not _write_task_atomically(path, payload):
            continue
        created.append(subject)
        next_id += 1
    return created, d


_CACHE_VER = re.compile(r"/kittens-saved/([^/]+)/scripts/")


def _running_version() -> str | None:
    """The plugin version THIS process was loaded from, read off our own path.

    A plugin-cached copy lives at
    `…/plugins/cache/<mp>/kittens-saved/<version>/scripts/kittens.py`, so the
    version is in the path and needs no manifest read. Returns None when running
    from a repo checkout, which is the normal case for tests and for a developer
    invoking the script directly — that is not a cached install and has no
    version to report.
    """
    m = _CACHE_VER.search(os.path.abspath(__file__))
    return m.group(1) if m else None


def _alive_path(session: str) -> str:
    d = os.path.join(_global_dir(), "alive")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{session}.json")


def stamp_hook_alive(session: str) -> None:
    """Breadcrumb: the Stop hook ran in this session, from this version.

    Written on every stop, overwriting rather than appending, so it cannot grow.
    The point is NOT to prove the code works — the tests do that — but to prove
    the harness is still ROUTING stop events into the copy we think it is. Those
    are different questions, and only this one catches a stale binding.

    A plugin-shipped hook binds at session start and keeps pointing at the cache
    directory it bound to. Every version dir persists (17 of them here), so a
    reinstall or an update leaves a live session executing an old copy forever,
    silently. Idea taken from the cctasks/ultratask session, which found its own
    guard unloaded this way within an hour of shipping the check.
    """
    try:
        with open(_alive_path(session), "w", encoding="utf-8") as fh:
            json.dump({"ts": _now(), "version": _running_version(),
                       "from": os.path.abspath(__file__)}, fh)
    except OSError:
        pass  # a breadcrumb that cannot be written must never break the hook


def read_hook_alive(session: str) -> dict | None:
    try:
        with open(_alive_path(session), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def installed_versions(marketplace: str = "tiny-claude-plugins") -> list[str]:
    base = os.path.join(_config_dir(), "plugins", "cache", marketplace, "kittens-saved")
    try:
        return sorted(n for n in os.listdir(base)
                      if os.path.isdir(os.path.join(base, n)))
    except OSError:
        return []


def _anchor_path(session: str) -> str:
    """Where a session records which project its ledger belongs to."""
    return os.path.join(_global_dir(), "anchors", session)


def _session_project_dir(session: str) -> str:
    """The project dir a SESSION's ledger belongs to — cwd-independent.

    `_project_dir()` answers "where am I standing", which is right for
    project-scoped state (the statusline ledgers) and wrong for the session
    ledger: CLAUDE_PROJECT_DIR does not reach Bash-tool subprocesses
    (vault-49q), so a `save` run from a different cwd than the session started
    in forked a SECOND ledger that the Stop hook — which does get the env var —
    never read. The kitten was recorded and then invisible.

    Resolution order, and why:
      1. `default` session (id unresolvable, or traversal-collapsed) — do NOT
         anchor. An untrustworthy id must not claim a project, and every such
         session would collide on one anchor file.
      2. CLAUDE_PROJECT_DIR — authoritative, because hooks carry it and hooks
         are the consumer. Refresh the anchor from it so later CLI calls in
         this session agree with the hook.
      3. The anchor a previous call wrote — this is what makes a Bash-tool
         `save` land in the hook's ledger instead of cwd's.
      4. cwd, as before — USED but never RECORDED. Only the authoritative
         (env-bearing) path may write an anchor. Caught by dogfooding the first
         cut of this fix: a `config` run from an unrelated repo pinned a live
         session to that repo, while its real ledger sat elsewhere. A guess
         must not capture a session; if no hook ever runs we simply degrade to
         the old cwd behaviour, which is the status quo rather than a
         regression.

    Deliberately NOT a migration: no existing ledger moves. Under a hook (env
    set) this resolves exactly as it did before, so sessions running older code
    are unaffected — the tcp-4zi lesson about migrating state out from under
    live consumers.
    """
    if not session or session == "default":
        return _project_dir()

    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        _write_anchor(session, env)
        return env

    anchored = _read_anchor(session)
    if anchored:
        return anchored

    return _project_dir()


def _read_anchor(session: str) -> str | None:
    """The anchored project dir, or None. A stale anchor pointing at a
    now-missing dir is ignored rather than honoured — the dir may have been
    deleted or renamed, and recreating it there would resurrect a ghost."""
    try:
        with open(_anchor_path(session), encoding="utf-8") as fh:
            d = fh.read().strip()
    except OSError:
        return None
    return d if d and os.path.isdir(d) else None


def _write_anchor(session: str, project_dir: str) -> None:
    """Record the anchor atomically; never let a bookkeeping failure break a
    save. Same-value writes are skipped so the common path does no disk I/O."""
    if _read_anchor(session) == project_dir:
        return
    try:
        path = _anchor_path(session)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(project_dir)
        os.replace(tmp, path)
    except OSError:
        pass


def _ledger_path(session: str) -> str:
    d = os.path.join(_session_project_dir(session), ".claude", ".kittens-saved")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        # Fall back to the cwd-derived dir rather than failing the write.
        d = _state_dir()
    return os.path.join(d, f"{session}.jsonl")


def _off_path(session: str) -> str:
    # Session-global on purpose: the mute keys on the session id in a FIXED
    # dir, so it holds across every cwd the session visits (tcp-4zi).
    return os.path.join(_global_dir(), f"{session}.off")


def _is_off(session: str) -> bool:
    return os.path.exists(_off_path(session))


def _cfg_scope() -> str:
    """Plugin userConfig `scope` (session | all), delivered by the harness as
    CLAUDE_PLUGIN_OPTION_SCOPE. Governs whether the tally spans this session or
    every session. Default: session."""
    v = (os.environ.get("CLAUDE_PLUGIN_OPTION_SCOPE") or "session").strip().lower()
    return "all" if v == "all" else "session"


def _cfg_enabled() -> bool:
    """Plugin userConfig `enabled`. `false` silences the plugin globally (a
    per-session mute is the separate `.off` toggle). Note the explicit compare:
    only the literal string 'false' disables, so an unset var stays enabled."""
    return (os.environ.get("CLAUDE_PLUGIN_OPTION_ENABLED") or "true").strip().lower() != "false"


def _cfg_debug() -> bool:
    """Plugin userConfig `debug`. When true, hooks echo the content they inject
    to stderr, prefixed `[kittens-saved-debug]`, so you can see it in the
    transcript / `claude --debug` without decoding the hook JSON."""
    return (os.environ.get("CLAUDE_PLUGIN_OPTION_DEBUG") or "false").strip().lower() == "true"


def _cfg_strip_quotes() -> bool:
    """Plugin userConfig `strip_quotes` (default true): drop double-quoted spans
    before matching, so a quoted meta-mention of a tell (discussing the phrase)
    doesn't trip the hook — only the model's own un-quoted prose does."""
    return (os.environ.get("CLAUDE_PLUGIN_OPTION_STRIP_QUOTES") or "true").strip().lower() != "false"


def _cfg_warn_repeat() -> int:
    """Plugin userConfig `warn_repeat` (default 2): how many times a single warn
    matcher may fire per session before it goes quiet — 0 disables the warn tier,
    1 is once-only, 2 reinforces once. Keeps the [i] gentle, not naggy."""
    try:
        return max(0, int(os.environ.get("CLAUDE_PLUGIN_OPTION_WARN_REPEAT") or "2"))
    except ValueError:
        return 2


def _dbg(content: str) -> None:
    if _cfg_debug():
        print(f"[kittens-saved-debug] {content}", file=sys.stderr)


def _git_ignored(path: str):
    """True / False if `path` is / isn't gitignored; None when the project is
    not a git repo (or git is absent). Used by `doctor` to flag the ephemeral
    ledger dir as untracked noise, and by `--fix` to confirm the repair."""
    try:
        r = subprocess.run(
            ["git", "-C", _project_dir(), "check-ignore", "-q", path],
            capture_output=True,
        )
    except (FileNotFoundError, OSError):
        return None
    if r.returncode == 0:
        return True
    if r.returncode == 1:
        return False
    return None  # 128 = not a git repository


def _append(session: str, event: dict) -> None:
    event = {"ts": _now(), **event}
    with open(_ledger_path(session), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


def _read(session: str) -> list[dict]:
    path = _ledger_path(session)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # skip a torn write, never crash on the ledger
    return out


def _read_all_sessions() -> list[dict]:
    out = []
    d = _state_dir()
    for name in os.listdir(d):
        if name.endswith(".jsonl"):
            out.extend(_read(name[: -len(".jsonl")]))
    return out


def _tally(events: list[dict]) -> dict:
    saved = sum(int(e.get("n", 1)) for e in events if e.get("kind") == "saved")
    escapes = [e for e in events if e.get("kind") == "escape"]
    last_escape = escapes[-1] if escapes else None
    yours = int(last_escape.get("yours", 0)) if last_escape else 0
    mine = int(last_escape.get("mine", 0)) if last_escape else 0
    return {
        "saved": saved,
        "escapes": len(escapes),
        "granted": sum(1 for e in escapes if e.get("granted")),
        "denied": sum(1 for e in escapes if not e.get("granted")),
        "yours": yours,
        "mine": mine,
        "last_escape": last_escape,
    }


def _read_stdin_json() -> dict:
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return {}


def _denylist_path() -> str:
    # Operator-global: overrides added in any repo apply in every repo (tcp-4zi).
    return os.path.join(_global_dir(), "denylist.txt")


def _gather_local_overrides() -> None:
    """One-time gather (tcp-4zi migration): per-repo override files predating
    the operator-global split are folded into ~/.claude/.kittens-saved/ the
    first time a loader runs in a repo that still has them, then renamed
    `*.migrated` — so an entry the operator later deletes from the global file
    is NOT resurrected on revisiting the old repo (the uninstall-clobber
    lesson, inverted). Content-deduped, never fatal."""
    local_dir = _state_dir()
    global_dir = _global_dir()
    if os.path.realpath(local_dir) == os.path.realpath(global_dir):
        return  # cwd is ~ itself; nothing to gather
    try:
        local_deny = os.path.join(local_dir, "denylist.txt")
        if os.path.exists(local_deny):
            lines = []
            with open(local_deny, encoding="utf-8") as fh:
                for line in fh:
                    s = line.strip()
                    if s and not s.startswith("#"):
                        lines.append(s)
            have = set(_load_overrides())
            fresh = [ln for ln in lines if ln not in have]
            if fresh:
                _write_overrides(list(_load_overrides()) + fresh)
            os.replace(local_deny, local_deny + ".migrated")
        local_warn = os.path.join(local_dir, "warnlist.json")
        if os.path.exists(local_warn):
            try:
                with open(local_warn, encoding="utf-8") as fh:
                    data = json.load(fh)
            except (json.JSONDecodeError, ValueError):
                data = []
            entries = [e for e in data if isinstance(e, dict) and e.get("matcher")] \
                if isinstance(data, list) else []
            current = _load_warn_overrides()
            have = {e["matcher"] for e in current}
            fresh = [e for e in entries if e["matcher"] not in have]
            if fresh:
                _write_warn_overrides(current + fresh)
            os.replace(local_warn, local_warn + ".migrated")
    except OSError:
        pass  # a failed gather must not wedge the Stop hook


def _load_denylist() -> list:
    """Compiled lazy-phrase matchers: built-in `LAZY_DEFAULTS` plus any user
    overrides in the operator-global denylist.txt (one regex per line; blank
    lines and `#` comments skipped). A pattern that fails to compile is
    skipped, never fatal — a bad override must not wedge the Stop hook."""
    _gather_local_overrides()
    pats = list(LAZY_DEFAULTS)
    override = _denylist_path()
    if os.path.exists(override):
        try:
            with open(override, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        pats.append(line)
        except OSError:
            pass
    out = []
    for p in pats:
        try:
            out.append(re.compile(p, re.IGNORECASE))
        except re.error:
            continue
    return out


# Block-structure idioms lifted from marko/block.py (frostming/marko, zero-dep):
# the CommonMark `{,3}` leading-space threshold, `[^\n\S]` horizontal whitespace,
# and the fence-close substring trick (open run `in` close run == same char and
# length >=). Inline code + quotes stay regex — even marko treats them as inline.
_FENCE_OPEN = re.compile(r"( {,3})(`{3,}|~{3,})[^\n\S]*(.*)$")
_FENCE_CLOSE = re.compile(r" {,3}(`+|~+)[^\n\S]*$")
_BLOCKQUOTE = re.compile(r" {,3}>")


def _prose_only(text: str) -> str:
    """Strip mention-not-handoff spans so the denylist fires only on the model's
    own prose. Block structure (fenced code, blockquotes) via a CommonMark-aware
    line scanner; inline code + quotes via regex. Stdlib, bare python3.

    Indented (4-space) code is intentionally NOT stripped: in assistant prose a
    4-space indent is usually a nested list, and marko only classifies it as code
    with full block context we don't cheaply have — over-stripping would hide a
    real punt (a false negative), the worse error for this gate."""
    if not text:
        return ""
    out, fence = [], None  # fence = the open run string, e.g. "```" or "~~~~"
    for raw in text.split("\n"):
        if fence is not None:                      # inside a fenced block
            m = _FENCE_CLOSE.match(raw)
            if m and fence in m.group(1):          # same char & length >= opener
                fence = None
            continue
        m = _FENCE_OPEN.match(raw)
        if m and not (m.group(2)[0] == "`" and "`" in m.group(3)):  # backtick-info guard
            fence = m.group(2)                     # open a fence
            continue
        if _BLOCKQUOTE.match(raw):
            continue
        out.append(raw)
    prose = "\n".join(out)
    prose = re.sub(r"`[^`]*`", " ", prose)         # inline code
    if _cfg_strip_quotes():
        prose = re.sub(r"\"[^\"]*\"", " ", prose)  # "straight"
        prose = re.sub(r"[“”][^“”]*[“”]", " ", prose)  # “curly”
    return prose


def _lazy_hits(text: str) -> list:
    """The distinct denylist phrases that fire on `text`, in first-seen order.
    Runs on prose only — quoted/code/blockquote mentions are stripped first."""
    text = _prose_only(text)
    if not text:
        return []
    seen, out = set(), []
    for rx in _load_denylist():
        m = rx.search(text)
        if m:
            key = m.group(0).strip().lower()
            if key not in seen:
                seen.add(key)
                out.append(m.group(0).strip())
    return out


def _response_after_last_user(transcript_path):
    """(ready, text) for the assistant text of the turn that is ENDING.

    `ready` is True when the last assistant text record sits AFTER the last
    record the agent did NOT write — i.e. it has spoken since the last thing
    that came in. That is what "this turn's response" means, and it is decided
    by POSITION in the transcript, never by wall-clock or by change-detection.

    Position is the whole point (see `_current_response_text`). Within a turn,
    tool results interleave as `user` records and the closing assistant text
    always follows the last of them; across turns, whatever re-invoked the
    agent resets the boundary. So the same rule both finds the ending turn and
    refuses to read one turn behind.

    THE BOUNDARY IS "NOT ASSISTANT", NOT "IS USER". This cost a second bug
    (found live 2026-08-13, one commit after the first): when THIS hook injects
    `additionalContext`, the agent is re-invoked with no `user` record written
    at all — the injection lands as `attachment`/`system` records. Consecutive
    turns therefore look like assistant, assistant, assistant with the last
    `user` record far behind all of them, so a `type == "user"` boundary is
    already satisfied by the PREVIOUS turn's text and the hook reads it the
    moment the current turn has not flushed yet. The plugin's own nudges are
    what produce that shape, so it hit the exact path this code exists to serve.

    Sidechain (subagent) records are skipped on both sides: a subagent's text
    is not this turn's response, and letting it move the boundary would nudge
    on words the main agent never said.
    """
    if not transcript_path or not os.path.exists(transcript_path):
        return (False, "")
    last_other = -1
    last_assistant = -1
    text = ""
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("isSidechain"):
                    continue
                kind = obj.get("type")
                if kind != "assistant":
                    last_other = i
                    continue
                content = (obj.get("message") or {}).get("content")
                parts = []
                if isinstance(content, list):
                    parts = [b.get("text", "") for b in content
                             if isinstance(b, dict) and b.get("type") == "text"]
                elif isinstance(content, str):
                    parts = [content]
                if parts:
                    last_assistant = i
                    text = "\n".join(parts)
    except OSError:
        return (False, "")
    if last_assistant < 0 or last_assistant < last_other:
        return (False, "")
    return (True, text)


def _current_response_text(transcript_path, max_wait: float = 3.0, poll: float = 0.25) -> str:
    """The assistant text of the turn that is ENDING, or '' if it never lands.

    At Stop time the ending turn may or may not be flushed yet, and BOTH
    orderings are ordinary. The previous implementation waited for a message
    NEWER than the one present at entry, which handled the late flush and
    silently broke the early one: when the response had already landed before
    the hook started, nothing newer ever arrived, it burned the full `max_wait`
    and returned ''. Firing became a coin flip on flush timing — long responses
    (which finish writing sooner relative to the hook) were exactly the ones
    that went unnudged. Found live 2026-08-13: a response tripping a built-in
    denylist phrase stopped in silence, transcript written 1.3s before the hook
    stamped.

    Asking "is the last assistant message after the last user message" is
    correct under both orderings, so the wait is now only for the not-yet-
    flushed case and the common case returns immediately.
    """
    # No transcript at all is a settled answer, not a slow one — the harness
    # passes no path on some Stop payloads, and waiting cannot conjure a file.
    # Polling it anyway cost `max_wait` on every such stop.
    if not transcript_path or not os.path.exists(transcript_path):
        return ""
    ready, text = _response_after_last_user(transcript_path)
    if ready:
        return text
    waited = 0.0
    while waited < max_wait:
        time.sleep(poll)
        waited += poll
        ready, text = _response_after_last_user(transcript_path)
        if ready:
            return text
    return ""


def _warnlist_path() -> str:
    # Operator-global, like the denylist (tcp-4zi).
    return os.path.join(_global_dir(), "warnlist.json")


def _load_warn_overrides() -> list:
    """User warn entries from warnlist.json (a JSON array of {matcher, reason,
    escape}); [] on a missing/torn file — never fatal."""
    path = _warnlist_path()
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                return [e for e in data if isinstance(e, dict) and e.get("matcher")]
        except (OSError, json.JSONDecodeError, ValueError):
            pass
    return []


def _write_warn_overrides(entries: list) -> None:
    with open(_warnlist_path(), "w", encoding="utf-8") as fh:
        json.dump(entries, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _load_warnlist() -> list:
    """Compiled warn entries: built-in WARN_DEFAULTS + overrides. Each is a tuple
    (compiled, reason, escape). A pattern that fails to compile is skipped."""
    _gather_local_overrides()
    out = []
    for e in list(WARN_DEFAULTS) + _load_warn_overrides():
        try:
            out.append((re.compile(e["matcher"], re.IGNORECASE),
                        e.get("reason", ""), e.get("escape", "")))
        except (re.error, KeyError, TypeError):
            continue
    return out


def _warn_hits(text: str) -> list:
    """(pattern, reason, escape, matched) for each warn entry firing on prose-only
    text, first-seen, deduped by pattern."""
    text = _prose_only(text)
    if not text:
        return []
    seen, out = set(), []
    for rx, reason, escape in _load_warnlist():
        m = rx.search(text)
        if m and rx.pattern not in seen:
            seen.add(rx.pattern)
            out.append((rx.pattern, reason, escape, m.group(0).strip()))
    return out


def _warn_check(session: str, resp: str) -> str:
    """The gentle [i] warn message for this stop, honouring the per-session repeat
    cap (`warn_repeat`). Records a `warned` ledger event per emitted line so the
    cap is enforced across the session. '' when nothing to say."""
    cap = _cfg_warn_repeat()
    if cap <= 0:
        return ""
    already = {}
    for e in _read(session):
        if e.get("kind") == "warned":
            already[e.get("matcher")] = already.get(e.get("matcher"), 0) + 1
    lines = []
    for pat, reason, escape, matched in _warn_hits(resp):
        if already.get(pat, 0) >= cap:
            continue
        _append(session, {"kind": "warned", "matcher": pat})
        tail = f" {escape}" if escape else ""
        lines.append(f"[i] you used \"{matched}\" — {reason}{tail}")
    return "\n".join(lines)


# ---- subcommands ------------------------------------------------------------

def cmd_save(args) -> int:
    session = _resolve_session(args.session, None)
    n = max(1, int(args.n))
    _append(session, {"kind": "saved", "n": n, "reason": args.reason})
    t = _tally(_read(session))
    kit = "🐈" * min(n, 5)
    print(f"{kit} saved {n} kitten(s) — {args.reason}")
    print(f"   session total: {t['saved']} saved")
    return 0


def cmd_escape(args) -> int:
    """The escape hatch. GRANTED only when zero residual items are the agent's.
    `--mine 0 --yours N` is the honest 'I finished my part; N are deliberately
    yours' declaration. `--mine K` with K>0 is a punt and is DENIED."""
    session = _resolve_session(args.session, None)
    mine = max(0, int(args.mine))
    yours = max(0, int(args.yours))
    granted = mine == 0
    yours_items = [t.strip() for t in getattr(args, "yours_item", []) or [] if t.strip()]
    mine_items = [t.strip() for t in getattr(args, "mine_item", []) or [] if t.strip()]
    # The counts stay authoritative — they are what grants or denies, and older
    # ledger records have no items at all. Itemization is additive: when the
    # caller passed fewer items than it declared, `mine` says so rather than
    # implying the short list is the whole residual.
    _append(
        session,
        {"kind": "escape", "mine": mine, "yours": yours,
         "granted": granted, "reason": args.reason,
         "yours_items": yours_items, "mine_items": mine_items},
    )
    # The backstop half of "both": the skill asks the agent to file these with
    # TaskCreate, and this reconciles whatever it did not. Dedup by subject means
    # a compliant agent costs nothing here — the task already exists, so nothing
    # is written twice.
    created, tdir = ([], None)
    if yours_items and not getattr(args, "no_tasks", False):
        created, tdir = write_human_tasks(session, yours_items)

    if granted:
        msg = "🐈 escape GRANTED — no kittens of yours left unsaved."
        if yours:
            msg += f" {yours} item(s) are deliberately the human's."
        print(msg)
        if created:
            print(f"   ⤷ filed {len(created)} to the task list as {HUMAN_PREFIX.strip()}:")
            for s in created:
                print(f"     · {s[len(HUMAN_PREFIX):]}")
            # Having to CREATE proves TaskCreate was never called for these — a
            # compliant agent's items already exist and dedup to nothing. Say it,
            # because the failure is otherwise invisible: the write succeeded,
            # the agent sees the item in TaskList, and only the human's overlay
            # is stale. Silence here would read as "delivered".
            print(f"   ⚠ you did not call TaskCreate for {'these' if len(created) > 1 else 'this'} —")
            print("     the human's Ctrl+T overlay refreshes on a tool-driven task")
            print("     mutation, not on open, so it will not show them until some")
            print("     later call touches a task.")
            # Do NOT say "file them with TaskCreate" here: they are on disk
            # already, so an obedient agent would create a second copy of each.
            # The remedy is ordering, and after the fact it is a touch, not a
            # create.
            print("     They are on disk now — calling TaskCreate for them would")
            print("     DUPLICATE them. Either touch any task (TaskUpdate) to force")
            print("     the refresh, or call TaskCreate BEFORE escape next time.")
        elif yours_items and tdir is None:
            # Named the silent path rather than swallowing it: an unidentified
            # session is exactly when a human item most needs to not vanish.
            print("   ⤷ (session id unknown — nothing filed to the task list)")
        return 0
    print(
        f"🙀 escape DENIED — you declared {mine} item(s) that are YOURS to save.\n"
        f"   Save them (then `kittens.py save`), or reclassify with `--yours` if\n"
        f"   they are genuinely the human's. Do not leave 'just two more things'.",
        file=sys.stderr,
    )
    return 3


def cmd_count(args) -> int:
    session = _resolve_session(args.session, None)
    # --scope overrides the plugin setting; default falls back to userConfig.
    scope = args.scope or _cfg_scope()
    events = _read_all_sessions() if scope == "all" else _read(session)
    t = _tally(events)
    where = "all sessions" if scope == "all" else f"session {session}"
    print(f"🐈 kittens-saved — {where}")
    print(f"   saved:            {t['saved']}")
    print(f"   escape hatches:   {t['escapes']} ({t['granted']} granted, {t['denied']} denied)")
    if scope != "all":
        print(f"   waiting on you:   {t['yours']}")
        if t["mine"]:
            print(f"   ⚠ still yours to save: {t['mine']}")
        if _is_off(session):
            print("   (enforcement toggled OFF for this session)")
    return 0


def cmd_mine(args) -> int:
    """What is waiting on the HUMAN — the bucket the ledger stores as `yours`.

    Snapshot, not a live obligations list: `_tally` already reads the residual
    off the LAST escape rather than summing them, because each escape restates
    the whole residual from scratch. So this answers "what did the agent last
    say it was leaving you", which is a question the ledger can actually answer.
    It deliberately does NOT try to be a to-do list: nothing here has identity
    across declarations and nothing ever closes an item, so a running list would
    only ever grow and would drift from whatever real tracker the project uses.
    """
    session = _resolve_session(args.session, None)
    t = _tally(_read(session))
    last = t["last_escape"]
    items = list((last or {}).get("yours_items") or [])
    count = t["yours"]

    if args.json:
        print(json.dumps({
            "session": session,
            "waiting_on_you": count,
            "items": items,
            "itemized": len(items) >= count if count else True,
            "reason": (last or {}).get("reason", ""),
            "declared_at": (last or {}).get("ts", ""),
            "still_the_agents": t["mine"],
        }, indent=2))
        return 0

    if last is None:
        print("🐈 nothing declared yet this session — the agent has not taken an escape hatch.")
        return 0
    if not count:
        print("🐈 nothing is waiting on you.")
        return 0

    print(f"🙏 waiting on you ({count}):")
    for i, text in enumerate(items, 1):
        print(f"   {i}. {text}")
    # An older record, or a caller that passed only counts, leaves the list short.
    # Say that outright — a silently truncated list reads as the complete residual.
    if len(items) < count:
        missing = count - len(items)
        if items:
            print(f"   … and {missing} more the agent counted but did not name.")
        else:
            print("   (not itemized — the agent declared a count only)")
        reason = (last or {}).get("reason", "")
        if reason:
            print(f"\n   what it said instead:\n   {reason}")
    if t["mine"]:
        print(f"\n   ⚠ {t['mine']} item(s) are still the AGENT's — its last escape was denied.")
    return 0


def cmd_toggle(args) -> int:
    session = _resolve_session(args.session, None)
    state = args.state
    if state == "status":
        print(f"kittens-saved enforcement: {'off' if _is_off(session) else 'on'} (session {session})")
        return 0
    off = _off_path(session)
    if state == "off":
        open(off, "w").close()
        print("kittens-saved enforcement OFF for this session — the Stop hook goes quiet.")
    else:
        try:
            os.remove(off)
        except FileNotFoundError:
            pass
        print("kittens-saved enforcement ON for this session.")
    return 0


def _nudge(text: str) -> dict:
    """A non-blocking Stop-hook nudge, addressed to BOTH audiences.

    `systemMessage` alone was a silent no-op for its actual target. Claude
    Code's own contract: `systemMessage` — "Display a message to the user (all
    hooks)"; `hookSpecificOutput.additionalContext` — "Context injected back to
    model". So a nudge carried on `systemMessage` only ever reached the human,
    who then had to relay it by hand — observed live, and the reason this
    helper exists. The escape-block tier never had the bug because
    `decision: block` + `reason` does reach the model, which is exactly what
    made the gap hard to see: one tier worked, so the channel looked fine.

    Both fields are sent deliberately, not belt-and-braces. They have different
    audiences and the human seeing what the agent was told is the point of a
    nudge tier that does not block.

    That a NON-blocking Stop hook can inject context at all is the load-bearing
    assumption, so it is quoted rather than assumed — Claude Code 2.1.227's own
    schema description for the Stop event:

        "additionalContext is non-error feedback delivered to the model; the
         conversation continues so the model can act on it."

    `hookEventName` is required alongside it; the harness rejects a bare
    `hookSpecificOutput` and asks for it by name."""
    return {
        "continue": True,
        "systemMessage": text,
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": text,
        },
    }


def cmd_hook_stop(args) -> int:
    """Stop hook — EVIDENCE-GATED. It stays silent unless it has a reason to
    speak, so it never piles up on a clean turn (the every-stop reminder was the
    disruptive, latent-space-drifting behaviour this replaces). Two triggers:

      1. A denied escape declaration (mine>0) — blocks ONCE, then lets the next
         stop through so the agent is never trapped.
      2. The last assistant message trips the lazy-handoff denylist — a soft
         nudge naming the exact phrase that fired.

    No denied escape and no denylist hit => `suppressOutput`, say nothing."""
    payload = _read_stdin_json()
    session = _resolve_session(args.session, payload)
    # Stamped BEFORE the enable/mute gates, and before any early return: the
    # question this answers is "is the harness still routing stops into this
    # copy", which is true even when the plugin is muted and deliberately
    # silent. Gating the breadcrumb on enablement would make a muted session
    # indistinguishable from an unbound one — the exact confusion it exists
    # to remove.
    stamp_hook_alive(session)
    if not _cfg_enabled() or _is_off(session):
        print(json.dumps({"continue": True, "suppressOutput": True}))
        return 0
    events = _read(session)
    t = _tally(events)
    tally_line = f"🐈 {t['saved']} saved this session · 🙏 {t['yours']} waiting on the human"
    last = t["last_escape"]

    # 1. Anti-trap escape block: a denied declaration blocks at most once.
    recent_blocks = 0
    for e in reversed(events):
        if e.get("kind") == "escape" and e.get("granted"):
            break
        if e.get("kind") == "stop-block":
            recent_blocks += 1
    if bool(last) and not last.get("granted") and recent_blocks < 1:
        _append(session, {"kind": "stop-block", "mine": last.get("mine")})
        reason = (
            f"{REMINDER}\n{tally_line}\n"
            f"You declared {last.get('mine')} item(s) that are YOURS to save and "
            f"have not saved them. Save them now, or run /kittens-saved:counting-saved-kittens "
            f"to reclassify them as the human's — then stop."
        )
        _dbg(reason)
        print(json.dumps({"decision": "block", "reason": reason}))
        return 0

    # 2. Evidence gate. Read THIS turn's response ONCE (bounded wait for flush).
    resp = _current_response_text(payload.get("transcript_path"))

    # 2a. Deny tier — nudge on a high-confidence lazy-handoff tell.
    hits = _lazy_hits(resp)
    if hits:
        shown = ", ".join(f'"{h}"' for h in hits[:3])
        system_message = (
            f"{REMINDER}\n{tally_line}\n"
            f"Your last response tripped a lazy-handoff tell: {shown}. If that is a "
            f"punt, do it now and record it (kittens.py save); if the residual is "
            f"honestly the human's, declare it with "
            f"/kittens-saved:counting-saved-kittens (mine=0)."
        )
        _dbg(system_message)
        print(json.dumps(_nudge(system_message)))
        return 0

    # 2b. Warn tier — a gentle [i] on a softer tell, capped per session, never blocks.
    warn = _warn_check(session, resp)
    if warn:
        _dbg(warn)
        print(json.dumps(_nudge(warn)))
        return 0

    # 3. Clean stop — silent. No hit, no nag.
    print(json.dumps({"continue": True, "suppressOutput": True}))
    return 0


def cmd_hook_session_start(args) -> int:
    payload = _read_stdin_json()
    if not _cfg_enabled():
        print(json.dumps({"continue": True, "suppressOutput": True}))
        return 0
    # Only a genuine startup emits the primer. resume / clear / compact stay
    # silent so the context does not pile up across compactions and drift the
    # latent space (the caveman #691 `source`-branch pattern).
    source = (payload.get("source") or "startup").strip().lower()
    if source and source != "startup":
        print(json.dumps({"continue": True, "suppressOutput": True}))
        return 0

    d = _state_dir()  # ensure the dir exists so an early `count` finds it
    n_sessions = sum(1 for name in os.listdir(d) if name.endswith(".jsonl"))
    all_saved = _tally(_read_all_sessions())["saved"]
    zen = "\n".join(f"  · {z}" for z in ZEN_OF_KITTENS)
    ctx = (
        f"{REMINDER}\n"
        f"🐈 kittens-saved armed — {all_saved} saved all-time across {n_sessions} session(s).\n"
        f"Why you see this: to stop the 'lazy opus' hand-back — leaving the human "
        f"'just two more things' you could have done yourself.\n"
        f"Telltale signs of a punt (the Stop hook watches your LAST message for "
        f'these): "just two more things", "left for you", "next steps for you", '
        f'"I\'ll leave that to you", "for you to do", "exercise for the reader".\n'
        f"Zen of Kittens:\n{zen}\n"
        f"The Stop hook now speaks ONLY when it catches one of those tells in your "
        f"last response — silence means you are clean. Save a kitten by doing the "
        f"work; take the escape hatch (/kittens-saved:counting-saved-kittens) only "
        f"when nothing of yours is left unsaved. Grow the net with "
        f"/kittens blame \"<phrase>\" when you catch a new one in the wild."
    )
    _dbg(ctx)
    print(json.dumps({
        "continue": True,
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx},
    }))
    return 0


def cmd_status(args) -> int:
    """This session's snapshot: is enforcement live, and where does the tally
    stand. `count` shows the numbers; `status` adds the enforcement state that
    tells you whether the Stop hook is actually gating you right now."""
    session = _resolve_session(args.session, None)
    t = _tally(_read(session))
    off = _is_off(session)
    enabled = _cfg_enabled()
    enforcing = enabled and not off
    if args.json:
        print(json.dumps({
            "session": session, "enforcing": enforcing, "enabled_global": enabled,
            "session_off": off, "saved": t["saved"], "waiting_on_human": t["yours"],
            "still_mine": t["mine"], "escapes": t["escapes"],
        }))
        return 0
    why = "" if enforcing else (
        " (plugin disabled globally)" if not enabled else " (toggled off this session)")
    print(f"🐈 kittens-saved — session {session}")
    print(f"   enforcement:      {'ON' if enforcing else 'OFF'}{why}")
    print(f"   saved:            {t['saved']}")
    print(f"   waiting on you:   {t['yours']}")
    if t["mine"]:
        print(f"   ⚠ still yours:    {t['mine']}")
    print(f"   escape hatches:   {t['escapes']} ({t['granted']} granted, {t['denied']} denied)")
    return 0


def cmd_stats(args) -> int:
    """Tallies at two honest scopes in one readout: this session, and this
    project (every ledger in the project's state dir). Box-level (all projects
    on the machine) is deliberately NOT tracked — the ledger is per-project by
    design, so a cross-project total would need a registry that does not exist."""
    session = _resolve_session(args.session, None)
    sess_t = _tally(_read(session))
    proj_t = _tally(_read_all_sessions())
    n_sessions = sum(1 for name in os.listdir(_state_dir()) if name.endswith(".jsonl"))
    if args.json:
        print(json.dumps({
            "project_dir": _project_dir(),
            "session": {"id": session, "saved": sess_t["saved"], "escapes": sess_t["escapes"]},
            "project": {"sessions": n_sessions, "saved": proj_t["saved"],
                        "escapes": proj_t["escapes"], "granted": proj_t["granted"],
                        "denied": proj_t["denied"]},
            "box": None,
        }))
        return 0
    print(f"🐈 kittens-saved stats — {_project_dir()}")
    print(f"   this session ({session}): {sess_t['saved']} saved, {sess_t['escapes']} escape(s)")
    print(f"   this project ({n_sessions} session(s)): {proj_t['saved']} saved, "
          f"{proj_t['escapes']} escape(s) — {proj_t['granted']} granted / {proj_t['denied']} denied")
    print("   box (all projects): not tracked — the ledger is per-project by design.")
    return 0


def cmd_config(args) -> int:
    """Show the EFFECTIVE runtime config and where each value came from. This is
    read-only on purpose: the persistent userConfig is owned by Claude Code's
    /plugin configure flow, not by this script — we report, we do not write it."""
    session = _resolve_session(args.session, None)
    def src(var):
        return "env" if os.environ.get(var) is not None else "default"
    rows = {
        "enabled": (_cfg_enabled(), src("CLAUDE_PLUGIN_OPTION_ENABLED"), True),
        "scope":   (_cfg_scope(),   src("CLAUDE_PLUGIN_OPTION_SCOPE"),   "session"),
        "debug":   (_cfg_debug(),   src("CLAUDE_PLUGIN_OPTION_DEBUG"),   False),
    }
    if args.json:
        print(json.dumps({
            **{k: {"value": v, "source": s, "default": d} for k, (v, s, d) in rows.items()},
            "session_enforcement": "off" if _is_off(session) else "on",
            "state_dir": _state_dir(),
            "global_dir": _global_dir(),
            "ledger_dir": os.path.dirname(_ledger_path(session)),
            "anchor": _read_anchor(session),
        }))
        return 0
    print("🐈 kittens-saved effective config")
    for k, (v, s, d) in rows.items():
        print(f"   {k:8} = {str(v):8} (from {s}, default {d!r})")
    print(f"   session enforcement = {'off' if _is_off(session) else 'on'} (this session's .off marker)")
    print(f"   state dir (project) = {_state_dir()}")
    print(f"   state dir (global)  = {_global_dir()}  (mutes + deny/warn overrides)")
    print(f"   ledger dir (session)= {os.path.dirname(_ledger_path(session))}")
    anchor = _read_anchor(session)
    print(f"   session anchor      = {anchor or '(none — resolving by cwd)'}")
    print("   change persistent config: /plugin configure kittens-saved@<marketplace>")
    print("   per-session mute:         /kittens toggle off")
    return 0


def cmd_doctor(args) -> int:
    """Health + config check. Repairs only what the plugin owns (--fix gitignores
    the ephemeral ledger dir); it never edits settings files. Exit 0 clean,
    1 on unresolved findings, 3 on an environment failure (unwritable state)."""
    session = _resolve_session(args.session, None)
    d = _state_dir()
    writable = os.access(d, os.W_OK)
    findings = []  # (severity, message, fixable)
    if not writable:
        findings.append(("error", f"state dir not writable: {d}", False))

    # Is the harness still routing stops into the copy we think it is? A
    # plugin-shipped hook binds at session start and keeps pointing at that
    # cache dir; every version dir persists, so an update or reinstall leaves a
    # live session executing an old copy with nothing announcing it. Neither the
    # tests nor a version bump can see this — only the running session can.
    alive = read_hook_alive(session)
    if alive is None:
        # Absence is only evidence once the session has DONE something. A fresh
        # session has legitimately not ended a turn yet, and reporting that as a
        # finding made `doctor` exit 1 on a clean install — crying wolf on the
        # normal case, which is how a checker gets ignored. A session with
        # ledger activity and no breadcrumb is the genuinely suspicious shape.
        if _read(session):
            findings.append((
                "warn",
                "this session has ledger activity but the Stop hook has never stamped "
                "it — the hook is probably not loaded. Plugin hooks bind at session "
                "start, so a reinstall or an update unbinds them from live sessions "
                "with nothing announcing it. Restart, or /reload-plugins, then re-check.",
                False))
    else:
        seen = alive.get("version")
        newest = (installed_versions() or [None])[-1]
        if seen and newest and seen != newest:
            findings.append((
                "warn",
                f"Stop hook in this session is running v{seen}, but v{newest} is "
                f"installed — this session bound to the older copy and will keep "
                f"using it until it restarts (or /reload-plugins).",
                False))
        elif seen is None:
            # NOT a development-only case, which is what this said first and was
            # wrong about: observed on two real sessions 2026-08-13, whose
            # ${CLAUDE_PLUGIN_ROOT} resolved to the working tree rather than to
            # a cache snapshot. It is reported as info rather than a finding
            # because it is a legitimate and arguably better state — a hook
            # running from the tree picks up edits with no version bump and no
            # re-sync, so the whole staleness class simply does not apply to it.
            print(f"   note: Stop hook runs from a working tree, not a version cache "
                  f"({alive.get('from')}) — edits are live, no bump needed.")

    ignored = _git_ignored(d)
    fixed_ignore = False
    if ignored is False:
        if args.fix:
            gi = os.path.join(_project_dir(), ".gitignore")
            with open(gi, "a", encoding="utf-8") as fh:
                fh.write("\n# kittens-saved ephemeral session ledger\n.claude/.kittens-saved/\n")
            fixed_ignore = True
            ignored = _git_ignored(d)
        else:
            findings.append(("warn", "state dir not gitignored — adds untracked git noise", True))

    if not _cfg_enabled():
        findings.append(("info", "plugin disabled globally (CLAUDE_PLUGIN_OPTION_ENABLED=false)", False))
    if _is_off(session):
        findings.append(("info", f"enforcement toggled OFF for session {session}", False))
    if session == "default":
        # The mute keys on the session id (tcp-4zi); without one, toggle/status
        # act on the shared 'default' bucket instead of this conversation.
        findings.append(("warn", "session id unresolvable (no --session, hook payload, or "
                         "CLAUDE_CODE_SESSION_ID) — the session mute cannot key; "
                         "pass --session or run via a hook", False))

    # Read-only statusline wiring check — repairs flow ONLY through the
    # preview→confirm→--yes path of `statusline install/rm`, never --fix.
    sl_reports = [_sl_scope_report(s) for s in ("user", "project", "local")]
    sl_bad = [r for r in sl_reports if r["state"] in ("MODIFIED", "STALE", "DEGRADED", "ERROR")]
    if sl_bad:
        for r in sl_bad:
            findings.append(("warn", f"statusline {r['scope']}: {r['state']} — {r['detail']}", False))
    elif all(r["state"] == "ABSENT" for r in sl_reports):
        findings.append(("info", "statusline chip not wired — `kittens statusline install` to see it", False))

    t = _tally(_read(session))
    if args.json:
        print(json.dumps({
            "state_dir": d, "writable": writable, "gitignored": ignored,
            "fixed_ignore": fixed_ignore, "enabled": _cfg_enabled(),
            "scope": _cfg_scope(), "debug": _cfg_debug(),
            "session_off": _is_off(session), "saved_session": t["saved"],
            "findings": [{"severity": s, "message": m, "fixable": f} for s, m, f in findings],
        }))
    else:
        print(f"🐈 kittens-saved doctor — session {session}")
        print(f"   state dir:   {d}")
        print(f"   writable:    {'yes' if writable else 'NO'}")
        gi_txt = {True: "yes", False: "no", None: "n/a (not a git repo)"}[ignored]
        print(f"   gitignored:  {gi_txt}" + ("  (fixed)" if fixed_ignore else ""))
        print(f"   enabled: {_cfg_enabled()}   scope: {_cfg_scope()}   debug: {_cfg_debug()}")
        if findings:
            print("   findings:")
            for s, m, f in findings:
                tag = {"error": "✖", "warn": "⚠", "info": "ℹ"}.get(s, "-")
                hint = "  [run: doctor --fix]" if f and not args.fix else ""
                print(f"     {tag} {m}{hint}")
        else:
            print("   ✓ no issues")

    if not writable:
        return 3
    return 1 if any(s in ("error", "warn") for s, _, _ in findings) else 0


def cmd_zen(args) -> int:
    """The Zen of Kittens."""
    print("🐈 The Zen of Kittens")
    for z in ZEN_OF_KITTENS:
        print(f"  · {z}")
    return 0


_OVERRIDE_HEADER = (
    "# kittens-saved denylist overrides — one regex per line; blank lines and "
    "#-comments ignored.\n"
    "# Managed by `kittens.py blame`. Case-insensitive; matched against the "
    "last assistant message only.\n"
)


def _load_overrides() -> list:
    """Raw override pattern lines from denylist.txt (order preserved; comments
    and blanks dropped). These are the removable/editable entries; the baked
    LAZY_DEFAULTS are read-only."""
    path = _denylist_path()
    out = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    s = line.strip()
                    if s and not s.startswith("#"):
                        out.append(s)
        except OSError:
            pass
    return out


def _write_overrides(lines: list) -> None:
    """Rewrite denylist.txt from `lines` (raw patterns) with the standard header."""
    with open(_denylist_path(), "w", encoding="utf-8") as fh:
        fh.write(_OVERRIDE_HEADER)
        for ln in lines:
            fh.write(ln + "\n")


def _blame_ls(as_json: bool) -> int:
    overrides = _load_overrides()
    if as_json:
        print(json.dumps({
            "defaults": LAZY_DEFAULTS, "overrides": overrides,
            "override_file": _denylist_path(),
            "total": len(LAZY_DEFAULTS) + len(overrides),
        }))
        return 0
    print(f"🐈 denylist — {len(LAZY_DEFAULTS)} built-in + {len(overrides)} override(s)")
    print("  built-in (read-only):")
    for p in LAZY_DEFAULTS:
        print(f"    · {p}")
    print(f"  overrides ({_denylist_path()}):")
    if overrides:
        for i, ln in enumerate(overrides, 1):
            print(f"    {i}. {ln}")
    else:
        print("    (none — add with: blame \"<phrase>\" --yes)")
    print("  remove: blame rm \"<phrase>\"   ·   edit: blame edit   ·   check: blame test \"<text>\"")
    return 0


def _blame_add(phrase: str, yes: bool, regex: bool) -> int:
    if not phrase:
        print("kittens: blame needs a phrase, e.g. blame \"both yours\"", file=sys.stderr)
        return 2
    # Literal add: escape regex metachars but keep spaces readable (a space is
    # not special, so `re.escape` needlessly backslashes it — ugly in `ls`).
    pattern = phrase if regex else re.escape(phrase).replace("\\ ", " ")
    if regex:
        try:
            re.compile(pattern)
        except re.error as exc:
            print(f"kittens: invalid regex: {exc}", file=sys.stderr)
            return 2
    if any(rx.search(phrase) for rx in _load_denylist()):
        print(f"🐈 already caught — an existing pattern matches {phrase!r}; nothing to add.")
        return 0
    kind = "regex" if regex else "phrase"
    total = len(LAZY_DEFAULTS) + len(_load_overrides())
    if not yes:
        # PREVIEW — the human gate. Writes nothing without --yes.
        print(f"would add ({kind}): {pattern!r}   — not yet caught")
        print(f"denylist {total} → {total + 1}.  re-run with --yes to write.  (nothing written)")
        return 0
    override = _denylist_path()
    new_file = not os.path.exists(override)
    with open(override, "a", encoding="utf-8") as fh:
        if new_file:
            fh.write(_OVERRIDE_HEADER)
        fh.write(pattern + "\n")
    print(f"✓ blamed ({kind}): {phrase!r}  → {override}  ({len(_load_denylist())} patterns)")
    return 0


def _blame_rm(phrase: str) -> int:
    if not phrase:
        print("kittens: blame rm needs a phrase (see: blame ls)", file=sys.stderr)
        return 2
    overrides = _load_overrides()
    esc = re.escape(phrase).replace("\\ ", " ")
    keep = [ln for ln in overrides if ln != phrase and ln != esc]
    removed = len(overrides) - len(keep)
    if not removed:
        print(f"🐈 no override matched {phrase!r}. See `blame ls` (built-in defaults can't be removed).")
        return 1
    _write_overrides(keep)
    print(f"✓ removed {removed} override(s) matching {phrase!r}  ({len(_load_denylist())} patterns left)")
    return 0


def _blame_test(text: str, as_json: bool) -> int:
    if not text:
        print("kittens: blame test needs text to check", file=sys.stderr)
        return 2
    hits = _lazy_hits(text)
    if as_json:
        print(json.dumps({"hits": hits, "caught": bool(hits)}))
        return 0
    if hits:
        print("🙀 would trip — matched: " + ", ".join(f'"{h}"' for h in hits))
    else:
        print("🐈 clean — no denylist pattern matches this text.")
    return 0


def _blame_edit() -> int:
    path = _denylist_path()
    if not os.path.exists(path):
        _write_overrides([])  # seed with header so there is a file to edit
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "nano"
    try:
        return subprocess.call([editor, path])
    except (FileNotFoundError, OSError) as exc:
        print(f"kittens: could not launch editor {editor!r}: {exc}\n  edit directly: {path}",
              file=sys.stderr)
        return 3


def cmd_blame(args) -> int:
    """Manage the lazy-handoff denylist. Verbs: ls / add / rm / edit / test.
    A bare phrase (no verb) is a gated add — PREVIEW ONLY unless --yes, so the
    denylist is never written blind."""
    tokens = list(args.rest or [])
    verbs = {"ls", "add", "rm", "edit", "test"}
    if tokens and tokens[0] in verbs:
        verb, rest = tokens[0], tokens[1:]
    else:
        verb, rest = "add", tokens  # bare phrase => gated add
    arg = " ".join(rest).strip()
    if verb == "ls":
        return _blame_ls(args.json)
    if verb == "edit":
        return _blame_edit()
    if verb == "test":
        return _blame_test(arg, args.json)
    if verb == "rm":
        return _blame_rm(arg)
    return _blame_add(arg, args.yes, args.regex)


def cmd_denylist(args) -> int:
    """Alias for `blame ls` (kept for the bare dispatcher)."""
    return _blame_ls(args.json)


def _warn_ls(as_json: bool) -> int:
    ov = _load_warn_overrides()
    if as_json:
        print(json.dumps({"defaults": WARN_DEFAULTS, "overrides": ov, "file": _warnlist_path()}))
        return 0
    print(f"🐈 warnlist (soft tier) — {len(WARN_DEFAULTS)} built-in + {len(ov)} override(s)")
    print("  built-in (read-only):")
    for e in WARN_DEFAULTS:
        print(f"    · /{e['matcher']}/  — {e['reason']}")
    print(f"  overrides ({_warnlist_path()}):")
    if ov:
        for i, e in enumerate(ov, 1):
            print(f"    {i}. /{e['matcher']}/  — {e.get('reason', '')}")
    else:
        print("    (none — add with: warn add \"<matcher>\" --reason … --escape … --yes)")
    return 0


def _warn_test(text: str, as_json: bool) -> int:
    if not text:
        print("kittens: warn test needs text to check", file=sys.stderr)
        return 2
    hits = _warn_hits(text)
    if as_json:
        print(json.dumps({"hits": [{"matcher": p, "matched": m} for p, _, _, m in hits]}))
        return 0
    if hits:
        for _, reason, escape, matched in hits:
            tail = f" ({escape})" if escape else ""
            print(f"[i] \"{matched}\" — {reason}{tail}")
    else:
        print("🐈 clean — no warnlist entry matches this text.")
    return 0


def _warn_add(matcher: str, reason: str, escape: str, yes: bool, is_regex: bool) -> int:
    if not matcher:
        print("kittens: warn add needs a matcher", file=sys.stderr)
        return 2
    pattern = matcher if is_regex else re.escape(matcher).replace("\\ ", " ")
    try:
        re.compile(pattern)
    except re.error as exc:
        print(f"kittens: invalid regex: {exc}", file=sys.stderr)
        return 2
    if not yes:
        print(f"would add (warn): /{pattern}/")
        print(f"   reason: {reason or '(none — pass --reason)'}")
        print(f"   escape: {escape or '(none — pass --escape)'}")
        print("   re-run with --yes to write.  (nothing written)")
        return 0
    ov = _load_warn_overrides()
    ov.append({"matcher": pattern, "reason": reason or "", "escape": escape or ""})
    _write_warn_overrides(ov)
    print(f"✓ warned (soft): /{pattern}/  → {_warnlist_path()}")
    return 0


def _warn_rm(matcher: str) -> int:
    if not matcher:
        print("kittens: warn rm needs a matcher (see: warn ls)", file=sys.stderr)
        return 2
    ov = _load_warn_overrides()
    esc = re.escape(matcher).replace("\\ ", " ")
    keep = [e for e in ov if e.get("matcher") not in (matcher, esc)]
    removed = len(ov) - len(keep)
    if not removed:
        print(f"🐈 no warn override matched {matcher!r}. See `warn ls` (built-ins can't be removed).")
        return 1
    _write_warn_overrides(keep)
    print(f"✓ removed {removed} warn override(s)  ({len(WARN_DEFAULTS) + len(keep)} entries left)")
    return 0


def cmd_warn(args) -> int:
    """Manage the soft warnlist tier. Verbs: ls / add / rm / test. A bare arg is
    `test` (add needs --reason/--escape, so it can't be inferred from a phrase)."""
    tokens = list(args.rest or [])
    verbs = {"ls", "add", "rm", "test"}
    if tokens and tokens[0] in verbs:
        verb, rest = tokens[0], tokens[1:]
    else:
        verb, rest = "test", tokens
    arg = " ".join(rest).strip()
    if verb == "ls":
        return _warn_ls(args.json)
    if verb == "rm":
        return _warn_rm(arg)
    if verb == "add":
        return _warn_add(arg, args.reason, args.escape, args.yes, args.regex)
    return _warn_test(arg, args.json)


# ---------------------------------------------------------------------------
# statusline chip installer — routes×states per docs/plans/kittens-statusline-
# installer.md (Rev 2). Invariants: never edit a file the installer did not
# create; preview is the default (--yes writes); displacement is ledgered
# before every settings change; fail open at render time, loud at inspect time.

_SL_FENCE_OPEN_TPL = "# >>> kittens-saved statusline v1 hash={h} >>>"
_SL_FENCE_OPEN_RE = re.compile(r"^# >>> kittens-saved statusline v1 hash=([0-9a-f]{16}) >>>$")
_SL_FENCE_CLOSE = "# <<< kittens-saved statusline <<<"
_SL_SEG_GLOB = ".claude/plugins/cache/*/kittens-saved/*/statusline/kittens-segment.sh"
_SL_RAIL_MARK = "kittens-segment.sh"   # our widget is recognized by this in commandPath
_SL_RAIL_IDS = ("kittens-saved-sep", "kittens-saved-chip")
_SL_SCOPES = ("local", "project", "user")  # precedence order, highest first
_SL_PRE_WRITE_HOOK = None  # test seam: called with the path before each guarded write


class _SLEnv(Exception):
    """Environment failure — exit 3. args: (what, remedy)."""


class _SLRefused(Exception):
    """Refused action — exit 4. args: (what, remedy)."""


def _sl_fail(tag: str, what: str, remedy: str) -> None:
    print(f"[{tag}] {what}")
    print(f"    → {remedy}")


def _sl_home() -> str:
    return os.path.expanduser("~")


def _sl_paths(scope: str) -> dict:
    home, proj = _sl_home(), _project_dir()
    if scope == "user":
        return {"settings": os.path.join(home, ".claude", "settings.json"),
                "wrapper": os.path.join(home, ".claude", "kittens-statusline.sh"),
                "ledger": os.path.join(home, ".claude", ".kittens-saved", "statusline-user.json")}
    if scope == "project":
        return {"settings": os.path.join(proj, ".claude", "settings.json"),
                "wrapper": os.path.join(proj, ".claude", "kittens-statusline.sh"),
                "ledger": os.path.join(_state_dir(), "statusline-project.json")}
    return {"settings": os.path.join(proj, ".claude", "settings.local.json"),
            "wrapper": os.path.join(proj, ".claude", "kittens-statusline.local.sh"),
            "ledger": os.path.join(_state_dir(), "statusline-local.json")}


def _sl_rail_path() -> str:
    return os.path.join(_sl_home(), ".config", "ccstatusline", "settings.json")


def _sl_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def _sl_seg_resolved() -> str | None:
    hits = sorted(_glob.glob(os.path.join(_sl_home(), _SL_SEG_GLOB)))
    return hits[-1] if hits else None


def _sl_block_body(ledger_path: str, delegate: bool) -> str:
    """The fenced chip body. Delegation (route W) executes the ledgered displaced
    command at runtime under a recursion guard; the chip renders on its own line."""
    lines = []
    if delegate:
        lines += [
            'if [ "${KITTENS_SL_CHILD:-}" != "1" ]; then',
            f"""  prev=$(jq -r '.displaced.command // empty' "{ledger_path}" 2>/dev/null)""",
            '  if [ -n "$prev" ]; then',
            """    printf '%s' "$input" | KITTENS_SL_CHILD=1 bash -c "$prev" 2>/dev/null || true""",
            '  fi',
            'fi',
        ]
    lines += [
        f'seg=$(ls -d "$HOME"/{_SL_SEG_GLOB} 2>/dev/null | sort -V | tail -1)',
        """if [ -n "$seg" ]; then printf '%s' "$input" | bash "$seg" 2>/dev/null || true; fi""",
    ]
    return "\n".join(lines)


def _sl_wrapper_text(body: str) -> str:
    return ("#!/usr/bin/env bash\n"
            "# kittens-saved statusline wrapper — managed by `kittens statusline`.\n"
            "# Edit outside the fences only; the fenced body is hash-guarded.\n"
            'input=$(cat 2>/dev/null || true)\n'
            f"{_SL_FENCE_OPEN_TPL.format(h=_sl_hash(body))}\n"
            f"{body}\n"
            f"{_SL_FENCE_CLOSE}\n")


_SL_HUSK = ("#!/usr/bin/env bash\n"
            "# kittens-saved statusline wrapper — removed by `kittens statusline rm`.\n"
            "# Inert husk (agents cannot delete files here); safe to delete by hand.\n")


def _sl_parse_wrapper(text: str):
    """→ (state, body, (open_idx, close_idx)) over splitlines(); state is
    'fresh' (no fences), 'converged' (hash ok) or 'modified'."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = _SL_FENCE_OPEN_RE.match(line)
        if not m:
            continue
        for j in range(i + 1, len(lines)):
            if lines[j] == _SL_FENCE_CLOSE:
                body = "\n".join(lines[i + 1:j])
                state = "converged" if _sl_hash(body) == m.group(1) else "modified"
                return state, body, (i, j)
        return "modified", "\n".join(lines[i + 1:]), (i, len(lines) - 1)
    return "fresh", None, None


def _sl_read_json(path: str):
    """→ (obj, raw). Missing file → ({}, None). Unparseable or non-object top
    level → _SLEnv (corrupt JSON is never treated as empty)."""
    if not os.path.exists(path):
        return {}, None
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    try:
        obj = json.loads(raw)
    except ValueError as exc:
        raise _SLEnv(f"{path} is not valid JSON ({exc})",
                     "fix the file by hand; the installer never repairs JSON") from exc
    if not isinstance(obj, dict):
        raise _SLEnv(f"{path} top level is not an object",
                     "fix the file by hand; the installer never repairs JSON")
    return obj, raw


def _sl_read_text(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _sl_guarded_write(path: str, data: str, snapshot: str | None, mode: int | None = None) -> None:
    """Atomic write refusing to clobber a target that changed since compute time."""
    if _SL_PRE_WRITE_HOOK:
        _SL_PRE_WRITE_HOOK(path)
    current = _sl_read_text(path)
    if current != snapshot:
        raise _SLRefused(f"{path} changed since preview/compute — nothing written",
                         "re-run the command (preview → confirm → --yes)")
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".kittens-sl-")
    try:
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def _sl_dangling_path(cmd: str) -> str | None:
    """First path-looking token that doesn't exist → that token (route D).
    Tokens after -c are inline code, never a script path."""
    try:
        toks = shlex.split(cmd)
    except ValueError:
        return None
    for tok in toks:
        if tok == "-c":
            return None
        if tok.startswith("-"):
            continue
        if "/" in tok or tok.startswith("~"):
            p = os.path.expanduser(tok)
            return None if os.path.exists(p) else tok
    return None


def _sl_route(scope: str, settings_obj: dict):
    """→ (route, detail). Routes: OURS (already our wrapper), R (rail),
    D (dangling), W (wrap occupied), V (vacant)."""
    sl = settings_obj.get("statusLine")
    if sl is None:
        return "V", None
    if not isinstance(sl, dict) or sl.get("type") != "command" or not isinstance(sl.get("command"), str):
        raise _SLEnv(f"statusLine at scope {scope} has an unsupported shape: {sl!r}",
                     "only type=command with a string command is understood; fix by hand")
    cmd = sl["command"]
    if _sl_paths(scope)["wrapper"] in cmd:
        return "OURS", cmd
    if "ccstatusline" in cmd and os.path.exists(_sl_rail_path()):
        try:
            _sl_read_json(_sl_rail_path())
            return "R", cmd
        except _SLEnv:
            raise _SLEnv(f"rail config {_sl_rail_path()} does not parse",
                         "fix ccstatusline's settings.json; the installer never repairs JSON")
    dangling = _sl_dangling_path(cmd)
    if dangling:
        return "D", dangling
    return "W", cmd


def _sl_rail_widget_cmd() -> str:
    inner = (f'seg=$(ls -d "$HOME"/{_SL_SEG_GLOB} 2>/dev/null | sort -V | tail -1); '
             '[ -n "$seg" ] && exec bash "$seg"')
    return f"bash -c '{inner}'"


def _sl_write_ledger(paths: dict, payload: dict) -> None:
    payload = {"version": 1, "written_at": _now(), **payload}
    snapshot = _sl_read_text(paths["ledger"])
    _sl_guarded_write(paths["ledger"], json.dumps(payload, indent=2) + "\n", snapshot)


def _sl_scope_report(scope: str) -> dict:
    """Read-only per-scope state for status/doctor."""
    paths = _sl_paths(scope)
    rep = {"scope": scope, "settings": paths["settings"], "state": "ABSENT",
           "route": None, "target": None, "detail": ""}
    try:
        obj, raw = _sl_read_json(paths["settings"])
    except _SLEnv as exc:
        rep.update(state="ERROR", detail=str(exc.args[0]))
        return rep
    rep["present"] = raw is not None and "statusLine" in obj
    try:
        route, detail = _sl_route(scope, obj)
    except _SLEnv as exc:
        rep.update(state="ERROR", detail=str(exc.args[0]))
        return rep
    rep["route"] = route
    if route == "OURS":
        wtext = _sl_read_text(paths["wrapper"])
        rep["target"] = paths["wrapper"]
        if wtext is None:
            rep.update(state="STALE", detail="settings point at our wrapper but it is missing")
            return rep
        state, _body, _span = _sl_parse_wrapper(wtext)
        if state == "modified":
            rep.update(state="MODIFIED", detail="wrapper fence body no longer matches its hash")
            return rep
        if state == "fresh":
            rep.update(state="ABSENT", detail="wrapper exists but carries no fenced chip (husk)")
            return rep
        if _sl_seg_resolved() is None:
            rep.update(state="STALE", detail="chip installed but no kittens-segment.sh resolvable in the plugin cache")
            return rep
        ledger, _ = ({}, None)
        try:
            ledger, _ = _sl_read_json(paths["ledger"])
        except _SLEnv:
            pass
        displaced = (ledger or {}).get("displaced")
        if displaced and _sl_dangling_path(str(displaced.get("command", ""))):
            rep.update(state="DEGRADED", detail="delegated (displaced) command references a missing path")
            return rep
        rep.update(state="OK")
        return rep
    if route == "R":
        try:
            rail, _ = _sl_read_json(_sl_rail_path())
        except _SLEnv as exc:
            rep.update(state="ERROR", detail=str(exc.args[0]))
            return rep
        ours = [w for line in rail.get("lines", []) for w in line
                if _SL_RAIL_MARK in str(w.get("commandPath", ""))]
        rep["target"] = _sl_rail_path()
        if ours:
            rep.update(state="OK" if _sl_seg_resolved() else "STALE",
                       detail="" if _sl_seg_resolved() else "widget installed but segment unresolvable")
        return rep
    return rep


def _sl_winning_scope() -> str | None:
    for scope in _SL_SCOPES:
        try:
            obj, raw = _sl_read_json(_sl_paths(scope)["settings"])
        except _SLEnv:
            continue
        if raw is not None and "statusLine" in obj:
            return scope
    return None


def _sl_status(as_json: bool) -> int:
    reports = [_sl_scope_report(s) for s in ("user", "project", "local")]
    winning = _sl_winning_scope()
    bad = [r for r in reports if r["state"] in ("MODIFIED", "STALE", "DEGRADED", "ERROR")]
    if as_json:
        print(json.dumps({"scopes": reports, "winning_scope": winning}))
    else:
        print("🐈 statusline wiring")
        for r in reports:
            mark = " ← wins for this cwd" if r["scope"] == winning else ""
            detail = f"  ({r['detail']})" if r["detail"] else ""
            print(f"   {r['scope']:<8} {r['state']:<9} {r['settings']}{detail}{mark}")
        if winning is None:
            print("   (no scope defines statusLine — nothing renders)")
    return 1 if bad else 0


def _sl_render(scope: str | None) -> int:
    scope = scope or _sl_winning_scope()
    if scope is None:
        _sl_fail("FAIL", "no scope defines statusLine — nothing to render",
                 "run `kittens statusline install` first")
        return 1
    obj, _raw = _sl_read_json(_sl_paths(scope)["settings"])
    sl = obj.get("statusLine") or {}
    cmd = sl.get("command")
    if not cmd:
        _sl_fail("FAIL", f"scope {scope} has no statusLine command", "install first")
        return 1
    synthetic = json.dumps({
        "session_id": "statusline-render-probe", "cwd": _project_dir(),
        "model": {"id": "probe", "display_name": "probe"},
        "workspace": {"current_dir": _project_dir(), "project_dir": _project_dir()},
    })
    proc = subprocess.run(["bash", "-c", cmd], input=synthetic, text=True,
                          capture_output=True, timeout=30)
    sys.stdout.write(proc.stdout if proc.stdout else "(statusline rendered no output)\n")
    return 0


def _sl_preview_caveats(scope: str) -> None:
    winning = _sl_winning_scope()
    if scope == "project":
        print("   note: project scope writes a COMMITTED file — every clone of this repo gets it")
    if winning is not None and winning != scope and _SL_SCOPES.index(winning) < _SL_SCOPES.index(scope):
        print(f"   ⚠ scope {winning} currently wins for this cwd — a {scope}-scope install is INVISIBLE here until {winning}'s statusLine is removed")


def _sl_install(scope: str, yes: bool) -> int:
    paths = _sl_paths(scope)
    obj, raw = _sl_read_json(paths["settings"])
    route, detail = _sl_route(scope, obj)

    if route == "OURS":
        wtext = _sl_read_text(paths["wrapper"])
        if wtext is None:
            raise _SLEnv(f"settings point at {paths['wrapper']} but it is missing",
                         "run `kittens statusline rm` then reinstall")
        state, _body, _span = _sl_parse_wrapper(wtext)
        if state == "converged":
            print(f"✓ already installed at scope {scope} — nothing to do")
            return 0
        if state == "modified":
            raise _SLRefused(f"wrapper {paths['wrapper']} fence body was edited (hash mismatch)",
                             "run `kittens statusline rm --force-modified` then reinstall, or hand-repair")
        # fresh husk: fall through and rebuild in place as route V/W below
        route = "V" if (obj.get("statusLine") or {}).get("command", "").find(paths["wrapper"]) >= 0 else route

    if route == "D":
        raise _SLEnv(f"current statusLine references a missing path: {detail}",
                     "fix or remove the dangling statusLine first — installing over it would bury the breakage")

    if route == "R":
        rail_path = _sl_rail_path()
        rail, rail_raw = _sl_read_json(rail_path)
        lines = rail.get("lines") or [[]]
        ours = [w for line in lines for w in line if _SL_RAIL_MARK in str(w.get("commandPath", ""))]
        if ours:
            print(f"✓ already installed on the ccstatusline rail — nothing to do")
            return 0
        sep = {"id": _SL_RAIL_IDS[0], "type": "separator"}
        chip = {"id": _SL_RAIL_IDS[1], "type": "custom-command", "commandPath": _sl_rail_widget_cmd()}
        print(f"route R (rail): inject chip widget into {rail_path} line 1")
        print(f"   + {chip['commandPath']}")
        _sl_preview_caveats(scope)
        if not yes:
            print("preview only — nothing written. Re-run with --yes after confirmation.")
            return 0
        new_lines = [list(lines[0]) + [sep, chip], *lines[1:]]
        _sl_write_ledger(paths, {"scope": scope, "route": "R", "widget_ids": list(_SL_RAIL_IDS)})
        _sl_guarded_write(rail_path, json.dumps({**rail, "lines": new_lines}, indent=2) + "\n", rail_raw)
        print(f"✓ installed (rail) — widget ids {', '.join(_SL_RAIL_IDS)}")
        return 0

    # V (vacant) or W (wrap occupied)
    displaced = obj.get("statusLine") if route == "W" else None
    body = _sl_block_body(paths["ledger"], delegate=route == "W")
    wtext = _sl_wrapper_text(body)
    new_obj = {**obj, "statusLine": {"type": "command", "command": f'bash "{paths["wrapper"]}"'}}
    print(f"route {route} ({'wrap existing statusline via runtime delegation' if route == 'W' else 'vacant slot'}) at scope {scope}:")
    print(f"   write wrapper  {paths['wrapper']}  (fence hash {_sl_hash(body)})")
    print(f"   write ledger   {paths['ledger']}" + ("  (displaced command recorded)" if displaced else "  (created-key marker)"))
    print(f"   set statusLine {paths['settings']}" + (f"  (was: {displaced.get('command')!r})" if displaced else ""))
    _sl_preview_caveats(scope)
    if not yes:
        print("preview only — nothing written. Re-run with --yes after confirmation.")
        return 0
    wrapper_snapshot = _sl_read_text(paths["wrapper"])
    _sl_write_ledger(paths, {"scope": scope, "route": route,
                             "created_key": route == "V", "displaced": displaced,
                             "wrapper": paths["wrapper"]})
    _sl_guarded_write(paths["wrapper"], wtext, wrapper_snapshot, mode=0o755)
    _sl_guarded_write(paths["settings"], json.dumps(new_obj, indent=2) + "\n", raw)
    if scope == "local":
        _sl_gitignore_local_wrapper(paths["wrapper"])
    print(f"✓ installed at scope {scope} — verify with `kittens statusline render --scope {scope}`")
    return 0


def _sl_gitignore_local_wrapper(wrapper: str) -> None:
    gi = os.path.join(_project_dir(), ".gitignore")
    rel = os.path.relpath(wrapper, _project_dir())
    existing = _sl_read_text(gi) or ""
    if rel not in existing:
        _sl_guarded_write(gi, existing + f"\n# kittens-saved local statusline wrapper\n{rel}\n",
                          existing if existing else None)


def _sl_rm(scope: str, yes: bool, force_modified: bool) -> int:
    paths = _sl_paths(scope)
    ledger, ledger_ok = {}, True
    try:
        ledger, _ = _sl_read_json(paths["ledger"])
    except _SLEnv:
        ledger_ok = False

    # Rail removal (route recorded, or detectable by our commandPath mark).
    if (ledger or {}).get("route") == "R" or (not ledger and os.path.exists(_sl_rail_path())):
        try:
            rail, rail_raw = _sl_read_json(_sl_rail_path())
        except _SLEnv:
            rail, rail_raw = None, None
        if rail is not None:
            ours_present = any(_SL_RAIL_MARK in str(w.get("commandPath", ""))
                               for line in rail.get("lines", []) for w in line)
            if ours_present:
                print(f"remove our widget(s) from {_sl_rail_path()} (user widgets untouched)")
                if not yes:
                    print("preview only — nothing written. Re-run with --yes after confirmation.")
                    return 0
                new_lines = [[w for w in line
                              if _SL_RAIL_MARK not in str(w.get("commandPath", ""))
                              and w.get("id") not in _SL_RAIL_IDS]
                             for line in rail.get("lines", [])]
                _sl_guarded_write(_sl_rail_path(), json.dumps({**rail, "lines": new_lines}, indent=2) + "\n", rail_raw)
                print("✓ rail widget removed")
                return 0

    wtext = _sl_read_text(paths["wrapper"])
    obj, raw = _sl_read_json(paths["settings"])
    wired_to_us = paths["wrapper"] in str((obj.get("statusLine") or {}).get("command", ""))
    if wtext is None and not wired_to_us:
        print("nothing to remove — no wrapper and settings do not point at us")
        return 0

    state = "fresh"
    if wtext is not None:
        state, _body, _span = _sl_parse_wrapper(wtext)
        if state == "modified" and not force_modified:
            raise _SLRefused(f"wrapper {paths['wrapper']} fence body was edited (hash mismatch)",
                             "re-run with --force-modified to excise it anyway")

    displaced = (ledger or {}).get("displaced")
    created_key = (ledger or {}).get("created_key", False)
    print(f"excise chip from {paths['wrapper']} (husk retained; delete by hand if wanted)")
    if wired_to_us:
        if displaced:
            print(f"restore settings statusLine → {displaced.get('command')!r}")
        elif created_key:
            print(f"remove statusLine key from {paths['settings']} (we created it)")
        elif not ledger_ok:
            print("⚠ ledger unreadable — settings will NOT be restored (excise only)")
        else:
            print("no displacement ledgered — settings left untouched")
    if not yes:
        print("preview only — nothing written. Re-run with --yes after confirmation.")
        return 0

    if wtext is not None:
        _sl_guarded_write(paths["wrapper"], _SL_HUSK, wtext, mode=0o755)
    if wired_to_us:
        if displaced:
            new_obj = {**obj, "statusLine": displaced}
            _sl_guarded_write(paths["settings"], json.dumps(new_obj, indent=2) + "\n", raw)
        elif created_key:
            new_obj = {k: v for k, v in obj.items() if k != "statusLine"}
            _sl_guarded_write(paths["settings"], json.dumps(new_obj, indent=2) + "\n", raw)
        elif not ledger_ok:
            _sl_fail("REFUSED", f"ledger {paths['ledger']} unreadable — chip excised but settings NOT restored",
                     "restore statusLine by hand (see any backup) or fix the ledger and re-run rm")
            return 4
    print("✓ removed")
    return 0


def cmd_statusline(args) -> int:
    """Dispatch + exit-code contract: 0 ok/no-op, 1 findings, 2 usage,
    3 environment, 4 refused. Owns its errors — the outer never-break-the-
    session swallow must not turn installer failures into silent exit 0."""
    verb = args.verb or "status"
    try:
        if verb == "status":
            return _sl_status(args.json)
        if verb == "render":
            return _sl_render(args.scope)
        scope = args.scope or "user"
        if verb == "install":
            return _sl_install(scope, args.yes)
        if verb == "rm":
            return _sl_rm(scope, args.yes, args.force_modified)
        _sl_fail("FAIL", f"unknown statusline verb {verb!r}", "one of: status render install rm")
        return 2
    except _SLEnv as exc:
        _sl_fail("FAIL", exc.args[0], exc.args[1] if len(exc.args) > 1 else "inspect and re-run")
        return 3
    except _SLRefused as exc:
        _sl_fail("REFUSED", exc.args[0], exc.args[1] if len(exc.args) > 1 else "inspect and re-run")
        return 4
    except Exception as exc:  # noqa: BLE001 — contract: unexpected ⇒ loud exit 3, never silent 0
        _sl_fail("FAIL", f"unexpected error: {exc!r}", "this is a bug in the installer; report it")
        return 3


def main() -> int:
    p = argparse.ArgumentParser(prog="kittens", description=__doc__)
    p.add_argument("--session", help="session id (else CLAUDE_CODE_SESSION_ID / hook stdin)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("save", help="record a kitten saved (work done, not punted)")
    s.add_argument("--reason", required=True)
    s.add_argument("--n", type=int, default=1)
    s.set_defaults(fn=cmd_save)

    s = sub.add_parser("escape", help="declare residual and take the escape hatch")
    s.add_argument("--mine", type=int, default=0, help="residual items that are YOURS (agent's) to save")
    s.add_argument("--yours", type=int, default=0, help="residual items deliberately the human's")
    s.add_argument("--yours-item", action="append", default=[], metavar="TEXT",
                   help="one human-owned residual item, repeatable; what `mine` lists back "
                        "to the human. Without these only a count is stored and `mine` has "
                        "nothing to show.")
    s.add_argument("--mine-item", action="append", default=[], metavar="TEXT",
                   help="one agent-owned residual item, repeatable (shown on a DENIED escape)")
    s.add_argument("--no-tasks", action="store_true",
                   help="do not mirror --yours-item into Claude Code's task list")
    s.add_argument("--reason", default="")
    s.set_defaults(fn=cmd_escape)

    # `mine` is named from the HUMAN's side of the fence: the human typing
    # "/kittens mine" means the bucket this script stores as `yours`. The word is
    # owner-relative and the two speakers mean opposite buckets by it — an agent
    # answered "list mine" from its own perspective once and had to be corrected,
    # which is why the flip is done here, in one place, rather than left to the
    # reader of each call site.
    s = sub.add_parser("mine", help="list what is waiting on YOU (the human)")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_mine)

    s = sub.add_parser("count", help="show the tally")
    s.add_argument("--scope", choices=["session", "all"],
                   help="override the plugin `scope` setting for this call")
    s.set_defaults(fn=cmd_count)

    s = sub.add_parser("toggle", help="on|off|status enforcement for this session")
    s.add_argument("state", choices=["on", "off", "status"])
    s.set_defaults(fn=cmd_toggle)

    s = sub.add_parser("status", help="session snapshot: enforcement state + tally")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_status)

    s = sub.add_parser("stats", help="tallies across this session and this project")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_stats)

    s = sub.add_parser("doctor", help="health + config check (exit 1 findings, 3 env failure)")
    s.add_argument("--fix", action="store_true",
                   help="apply safe repairs the plugin owns (gitignore the ledger dir)")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_doctor)

    s = sub.add_parser("config", help="show effective config and how to change it")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_config)

    s = sub.add_parser("denylist", help="alias for `blame ls`")
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.set_defaults(fn=cmd_denylist)

    s = sub.add_parser("blame", help="manage the denylist: ls/add/rm/edit/test (bare phrase = gated add)")
    s.add_argument("rest", nargs="*", help="a verb (ls/add/rm/edit/test) + args, or a bare phrase to add")
    s.add_argument("--yes", action="store_true", help="actually write; add is PREVIEW-ONLY without it")
    s.add_argument("--regex", action="store_true", help="treat an added phrase as a regex, not a literal")
    s.add_argument("--json", action="store_true", help="machine-readable output (ls/test)")
    s.set_defaults(fn=cmd_blame)

    s = sub.add_parser("warn", help="manage the soft warnlist tier: ls/add/rm/test (bare = test)")
    s.add_argument("rest", nargs="*", help="a verb (ls/add/rm/test) + args, or bare text to test")
    s.add_argument("--reason", default="", help="warn add: why this reads as a tell")
    s.add_argument("--escape", default="", help="warn add: when it's fine (prose the model self-judges)")
    s.add_argument("--yes", action="store_true", help="warn add: actually write; PREVIEW-ONLY without it")
    s.add_argument("--regex", action="store_true", help="warn add: treat matcher as a regex, not a literal")
    s.add_argument("--json", action="store_true", help="machine-readable output (ls/test)")
    s.set_defaults(fn=cmd_warn)

    s = sub.add_parser("statusline",
                       help="statusline chip installer: status/render/install/rm (preview-default; --yes writes)")
    s.add_argument("verb", nargs="?", default="status",
                   choices=["status", "render", "install", "rm"])
    s.add_argument("--scope", choices=["user", "project", "local"],
                   help="settings scope (install/rm default: user; render default: winning scope)")
    s.add_argument("--yes", action="store_true",
                   help="actually write; install/rm are PREVIEW-ONLY without it")
    s.add_argument("--force-modified", action="store_true",
                   help="rm only: excise a hash-mismatched (hand-edited) fence body anyway")
    s.add_argument("--json", action="store_true", help="machine-readable output (status)")
    s.set_defaults(fn=cmd_statusline)

    s = sub.add_parser("zen", help="print the Zen of Kittens")
    s.set_defaults(fn=cmd_zen)

    for name, fn in (
        ("hook-stop", cmd_hook_stop),
        ("hook-session-start", cmd_hook_session_start),
    ):
        s = sub.add_parser(name)
        s.set_defaults(fn=fn)

    args = p.parse_args()
    try:
        return args.fn(args)
    except BrokenPipeError:
        return 0
    except Exception as exc:  # never break a session over the ledger
        print(f"kittens: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
