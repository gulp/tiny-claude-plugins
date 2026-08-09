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
import sys

REMINDER = (
    "<kitten-reminder>one kitten dies when you leave me with \"just two more "
    "things\" --especially after long hours of discussion on the \"lazy opus\" "
    "behavior</kitten-reminder>"
)

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
    """Stop hook. Injects the reminder via systemMessage, and — for the escape
    hatch — blocks ONCE when the last declaration was a punt (mine>0), then
    lets the next stop through so the agent is never trapped."""
    payload = _read_stdin_json()
    session = _resolve_session(args.session, payload)
    if not _cfg_enabled() or _is_off(session):
        print(json.dumps({"continue": True, "suppressOutput": True}))
        return 0
    events = _read(session)
    t = _tally(events)
    tally_line = f"🐈 {t['saved']} saved this session · 🙏 {t['yours']} waiting on the human"
    last = t["last_escape"]

    # Anti-trap: count how many times we've already blocked since the last
    # granted escape. Block at most once per denied declaration.
    recent_blocks = 0
    for e in reversed(events):
        if e.get("kind") == "escape" and e.get("granted"):
            break
        if e.get("kind") == "stop-block":
            recent_blocks += 1

    should_block = bool(last) and not last.get("granted") and recent_blocks < 1
    if should_block:
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

    # Soft nudge: reminder + tally, never a hard stop.
    system_message = f"{REMINDER}\n{tally_line}"
    if last is None:
        system_message += (
            "\nNo escape hatch taken this session. Before stopping, declare your "
            "residual with /kittens-saved:counting-saved-kittens (mine=0 means you "
            "left nothing of yours unsaved)."
        )
    _dbg(system_message)
    print(json.dumps({"continue": True, "systemMessage": system_message}))
    return 0


def cmd_hook_session_start(args) -> int:
    if not _cfg_enabled():
        print(json.dumps({"continue": True}))
        return 0
    d = _state_dir()  # ensure the dir exists so an early `count` finds it
    n_sessions = sum(1 for name in os.listdir(d) if name.endswith(".jsonl"))
    all_t = _tally(_read_all_sessions())
    ctx = (
        f"{REMINDER}\nkittens-saved is armed. All-time: {all_t['saved']} kittens "
        f"saved across {n_sessions} session(s). Save kittens by doing the work "
        "instead of punting it; take the escape hatch "
        "(/kittens-saved:counting-saved-kittens) only when nothing of yours is "
        "left unsaved."
    )
    _dbg(ctx)
    print(json.dumps({
        "continue": True,
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx},
    }))
    return 0


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
