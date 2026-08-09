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
                  fronted by the `/kittens-saved:kittens-saved` skill.
  * `hook-stop` / `hook-session-start` — wired from hooks/hooks.json.
  * `statusline` — a compact segment: saved + waiting-on-you.

State is an append-only JSONL history per session, at
`$CLAUDE_PROJECT_DIR/.claude/.kittens-saved/<session-id>.jsonl`. Stdlib only,
so it runs under a bare `python3` (no cold start on the statusline hot path)
as well as `uv run`.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
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
# extend/override via `$state_dir/denylist.txt` (one regex per line). Matched
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

_ID_OK = re.compile(r"^[A-Za-z0-9._-]+$")


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _project_dir() -> str:
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def _state_dir() -> str:
    d = os.path.join(_project_dir(), ".claude", ".kittens-saved")
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


def _ledger_path(session: str) -> str:
    return os.path.join(_state_dir(), f"{session}.jsonl")


def _off_path(session: str) -> str:
    return os.path.join(_state_dir(), f"{session}.off")


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
    return os.path.join(_state_dir(), "denylist.txt")


def _load_denylist() -> list:
    """Compiled lazy-phrase matchers: built-in `LAZY_DEFAULTS` plus any user
    overrides in `$state_dir/denylist.txt` (one regex per line; blank lines and
    `#` comments skipped). A pattern that fails to compile is skipped, never
    fatal — a bad override must not wedge the Stop hook."""
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


def _lazy_hits(text: str) -> list:
    """The distinct denylist phrases that fire on `text`, in first-seen order."""
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


def _last_assistant_sig(transcript_path):
    """(signature, text) of the last assistant text message — signature a cheap
    change-detector (its timestamp, else a text prefix); ('', '') if none. Lets
    the Stop hook tell the message that was ALREADY there from the one this turn
    just produced."""
    if not transcript_path or not os.path.exists(transcript_path):
        return ("", "")
    sig, text = "", ""
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "assistant":
                    continue
                content = (obj.get("message") or {}).get("content")
                parts = []
                if isinstance(content, list):
                    parts = [b.get("text", "") for b in content
                             if isinstance(b, dict) and b.get("type") == "text"]
                elif isinstance(content, str):
                    parts = [content]
                if parts:
                    text = "\n".join(parts)
                    sig = str(obj.get("timestamp") or text[:48])
    except OSError:
        return ("", "")
    return (sig, text)


def _current_response_text(transcript_path, max_wait: float = 3.0, poll: float = 0.25) -> str:
    """The assistant text of the turn that is ENDING. At Stop time the current
    message is often NOT flushed to the transcript yet — reading it naively
    returns the PREVIOUS turn (verified 2026-08-09 live: the Stop hook otherwise
    sees one turn behind). So wait, bounded, for a message NEWER than the one
    present at entry. Return '' if nothing newer flushes within `max_wait` — the
    caller then stays silent rather than nudge on the previous turn (no false
    positive on a clean turn that merely followed a punt)."""
    base_sig, _ = _last_assistant_sig(transcript_path)
    waited = 0.0
    while waited < max_wait:
        sig, text = _last_assistant_sig(transcript_path)
        if sig and sig != base_sig:
            return text
        time.sleep(poll)
        waited += poll
    return ""


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
    _append(
        session,
        {"kind": "escape", "mine": mine, "yours": yours,
         "granted": granted, "reason": args.reason},
    )
    if granted:
        msg = "🐈 escape GRANTED — no kittens of yours left unsaved."
        if yours:
            msg += f" {yours} item(s) are deliberately the human's."
        print(msg)
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

    # 2. Evidence gate: only nudge if THIS turn's response shows a tell. Wait
    #    (bounded) for it to flush — a naive read returns the previous turn.
    hits = _lazy_hits(_current_response_text(payload.get("transcript_path")))
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
        print(json.dumps({"continue": True, "systemMessage": system_message}))
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
        f"/kittens-saved:blame \"<phrase>\" when you catch a new one in the wild."
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
        }))
        return 0
    print("🐈 kittens-saved effective config")
    for k, (v, s, d) in rows.items():
        print(f"   {k:8} = {str(v):8} (from {s}, default {d!r})")
    print(f"   session enforcement = {'off' if _is_off(session) else 'on'} (this session's .off marker)")
    print(f"   state dir           = {_state_dir()}")
    print("   change persistent config: /plugin configure kittens-saved@<marketplace>")
    print("   per-session mute:         /kittens-saved:toggle off")
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
    s.add_argument("--reason", default="")
    s.set_defaults(fn=cmd_escape)

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
