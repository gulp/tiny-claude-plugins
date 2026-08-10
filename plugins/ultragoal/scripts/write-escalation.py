#!/usr/bin/env python3
"""write-escalation.py — write the ultragoal escalation record on expiry.

Implements the writer half of docs/design/escalation-record-seam.md
(schema v1). Reads state.json + rubric.json + attempts.jsonl from the state
dir, writes one record atomically to
<project>/.claude/ultra/escalations/<utc-stamp>-<rubric8>.json, refuses to
overwrite, and prints the record path on stdout.

Exit codes: 0 written; 1 refused (record exists); 2 bad input/state.
"""
import argparse
import datetime
import json
import os
import sys
import tempfile


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def read_json(path):
    with open(path) as f:
        return json.load(f)


def plugin_version(script_dir):
    # scripts/ -> plugin root -> .claude-plugin/plugin.json
    manifest = os.path.join(script_dir, "..", ".claude-plugin", "plugin.json")
    try:
        return read_json(manifest).get("version", "unknown")
    except Exception:
        return "unknown"


def read_ledger(path):
    """attempts.jsonl -> list of entries. Tolerates a torn/absent last line:
    unparseable lines are skipped and counted, never fatal."""
    entries, skipped = [], 0
    if os.path.isfile(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    skipped += 1
    return entries, skipped


def wall_seconds(armed_at, expired_at):
    # armed_at is an epoch int per the arm step; tolerate the ISO string an
    # older or hand-written state might carry.
    try:
        armed = datetime.datetime.fromtimestamp(int(armed_at), datetime.timezone.utc)
    except (TypeError, ValueError):
        try:
            armed = datetime.datetime.strptime(
                str(armed_at), "%Y-%m-%dT%H:%M:%SZ"
            ).replace(tzinfo=datetime.timezone.utc)
        except (TypeError, ValueError):
            return None
    return int((expired_at - armed).total_seconds())


def sum_tokens(transcript_path):
    """Sum token usage from the session transcript JSONL. None (not 0) when
    the transcript is absent/unreadable or carries no usage records — an
    unknown spend must never read as a zero spend."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return None
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    seen = False
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                usage = (d.get("message") or {}).get("usage")
                if not isinstance(usage, dict):
                    continue
                seen = True
                totals["input"] += usage.get("input_tokens") or 0
                totals["output"] += usage.get("output_tokens") or 0
                totals["cache_read"] += usage.get("cache_read_input_tokens") or 0
                totals["cache_creation"] += usage.get("cache_creation_input_tokens") or 0
    except OSError:
        return None
    return totals if seen else None


def main():
    ap = argparse.ArgumentParser(
        description="Write the ultragoal escalation record on expiry "
        "(seam schema v1). Prints the record path on stdout."
    )
    ap.add_argument("--state-dir", required=True,
                    help="Directory holding state.json, rubric.json, attempts.jsonl")
    ap.add_argument("--cause", required=True, choices=["deadline", "attempt_cap"],
                    help="What expired the goal")
    ap.add_argument("--project-dir", default=os.environ.get("CLAUDE_PROJECT_DIR", "."),
                    help="Project root (default: $CLAUDE_PROJECT_DIR, else .)")
    ap.add_argument("--transcript", default=None,
                    help="Session transcript JSONL (from Stop-hook stdin); "
                    "token usage is summed into spend.tokens")
    ap.add_argument("--stamp", default=None, help=argparse.SUPPRESS)  # tests only
    args = ap.parse_args()

    try:
        state = read_json(os.path.join(args.state_dir, "state.json"))
        rubric = read_json(os.path.join(args.state_dir, "rubric.json"))
    except Exception as e:
        print(f"write-escalation: cannot read state dir: {e}", file=sys.stderr)
        return 2

    rubric_sha = state.get("rubric_sha256", "")
    if len(rubric_sha) < 8:
        print("write-escalation: state.json has no usable rubric_sha256", file=sys.stderr)
        return 2

    attempts, skipped = read_ledger(os.path.join(args.state_dir, "attempts.jsonl"))
    if skipped:
        print(f"write-escalation: skipped {skipped} unparseable ledger line(s)",
              file=sys.stderr)

    now = utcnow()
    stamp = args.stamp or now.strftime("%Y%m%dT%H%M%SZ")
    out_dir = os.path.join(args.project_dir, ".claude", "ultra", "escalations")
    out_path = os.path.join(out_dir, f"{stamp}-{rubric_sha[:8]}.json")
    rel_path = os.path.relpath(out_path, args.project_dir)

    record = {
        "record_version": 1,
        "written_by": f"ultragoal@{plugin_version(os.path.dirname(os.path.abspath(__file__)))}",
        "written_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "plan_path": state.get("plan_path"),
        "goal": state.get("goal"),
        "rubric": rubric,
        "rubric_sha256": rubric_sha,
        "verdict": "expired",
        "expiry_cause": args.cause,
        "attempts": attempts,
        "spend": {
            "armed_at": state.get("armed_at"),
            "expired_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "wall_seconds": wall_seconds(state.get("armed_at"), now),
            "stop_attempts_used": state.get("stop_attempts", 0),
            "stop_attempts_max": state.get("max_stop_attempts"),
            "deadline_epoch": state.get("deadline_epoch"),
            "tokens": sum_tokens(args.transcript),
        },
        "handoff": {
            "escalate": bool(state.get("escalate", False)),
            "suggested": f"/ultraralph:vanilla start @{rel_path}",
        },
    }

    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".escalation-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(record, f, indent=2)
            f.write("\n")
        # link, not replace: atomic no-clobber, so two writers racing on the
        # same stamp cannot silently overwrite the first record.
        os.link(tmp, out_path)
    except FileExistsError:
        print(f"write-escalation: refusing to overwrite existing record: {out_path}",
              file=sys.stderr)
        return 1
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
