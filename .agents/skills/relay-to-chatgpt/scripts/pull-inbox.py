#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""List ChatGPT exports in raw/inbox, newest first, flagging which are unconsumed.

Two independent signals, answering different questions -- report both:

  mtime     ARRIVAL. Each export is written when its conversation is exported,
            so mtimes are distinct and meaningful ordering. This is the "what
            landed since I last looked" signal; --since filters on it.
  citation  CONSUMPTION. An export is PROCESSED when some agent-owned note cites
            it by filename or conversation URL, per the vault's convention
            (design/plugin-freshness-three-silent-gaps.md cites its export in
            `source:`). Answers "has this been used", which recency cannot.

A fresh export may already be processed, and an old one may never have been --
neither signal substitutes for the other.

Structured stdout (JSON by default); diagnostics to stderr.
Exit: 0 = matches found, 1 = none found, 2 = error.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from datetime import datetime

# scripts/ -> relay-to-chatgpt/ -> skills/ -> .agents/ -> vault root
DEFAULT_VAULT = pathlib.Path(__file__).resolve().parents[4]
GRAPH_DIRS = ("wiki", "design", "nuggets", "meta", "how-might-we", "invariants")
URL_RE = re.compile(r"https://chatgpt\.com/c/([0-9a-f-]+)")
WS_RE = re.compile(r"\s+")


def flatten(text: str) -> str:
    """Collapse every whitespace run to one space.

    Export filenames contain spaces, and a note cites one inside a long `source:`
    line -- exactly the line an editor or a YAML folded scalar wraps. Matching raw
    text would then miss the citation and report a consumed export as unread, so
    both haystack and needle are flattened before comparison.
    """
    return WS_RE.sub(" ", text)


def parse_export(path: pathlib.Path) -> dict:
    """Pull title, created stamp, conversation URL and the prompt.

    The ChatGPT Exporter format is rigid (line 1 title, line 4 Created, line 7
    Link, line 9 '## Prompt:', prompt body until '## Response:'), but parse by
    content rather than line number so a format tweak degrades to a null field
    instead of a wrong one.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    title = lines[0].lstrip("# ").strip() if lines else path.stem
    created = next(
        (l.split("**Created:**", 1)[1].strip() for l in lines[:20] if "**Created:**" in l),
        None,
    )
    url_match = URL_RE.search(text)

    prompt = ""
    for i, line in enumerate(lines):
        if line.strip() == "## Prompt:":
            body = []
            # Run to the next heading rather than a fixed window: prompts here
            # range from 3 to 24 lines, so any constant truncates the long ones.
            for l in lines[i + 1 :]:
                if l.startswith("## "):
                    break
                # Drop the echoed timestamp and blanks under the heading.
                if l.strip() and not re.match(r"^\d+/\d+/\d{4}", l.strip()):
                    body.append(l.strip())
            prompt = " ".join(body)
            break

    st = path.stat()
    return {
        "path": str(path),
        "title": title,
        "created": created,
        "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        "mtime_epoch": st.st_mtime,
        "url": url_match.group(0) if url_match else None,
        "conversation_id": url_match.group(1) if url_match else None,
        "prompt_excerpt": prompt[:240] or None,
        # Full prompt, kept for --match and dropped before output: searching a
        # 240-char display excerpt would silently miss terms the prompt does
        # contain. The ANSWER text stays out of scope on purpose -- you are
        # matching a candidate to the prompt you sent.
        "_prompt_full": prompt,
        "size_bytes": st.st_size,
    }


def graph_citations(vault: pathlib.Path) -> str:
    """Concatenate agent-owned notes once, so the processed-test is one scan."""
    blobs = []
    for d in GRAPH_DIRS:
        root = vault / d
        if not root.is_dir():
            continue
        for note in root.rglob("*.md"):
            try:
                blobs.append(note.read_text(encoding="utf-8", errors="replace"))
            except OSError as e:
                print(f"warn: unreadable {note}: {e}", file=sys.stderr)
    # A filename cannot straddle the join, so a per-file boundary is not needed.
    return flatten("\n".join(blobs))


def main() -> int:
    ap = argparse.ArgumentParser(
        description="List raw/inbox ChatGPT exports and whether the graph has used them."
    )
    ap.add_argument("--vault", type=pathlib.Path, default=DEFAULT_VAULT,
                    help="vault root (default: the vault this skill lives in)")
    ap.add_argument("--match", metavar="TERMS",
                    help="keep only exports whose title or FULL prompt contains ALL "
                         "whitespace-separated terms (case-insensitive); the "
                         "response body is not searched")
    ap.add_argument("--since", metavar="ISO",
                    help="keep only exports modified at/after this time "
                         "(YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS) -- the arrival signal")
    ap.add_argument("--all", action="store_true",
                    help="include already-processed exports (default: unprocessed only)")
    ap.add_argument("--format", choices=("json", "table"), default="json")
    args = ap.parse_args()

    inbox = args.vault / "raw" / "inbox"
    if not inbox.is_dir():
        print(f"error: no such directory: {inbox}", file=sys.stderr)
        return 2

    exports = sorted(inbox.glob("ChatGPT-*.md"))
    if not exports:
        # Not an error: an empty inbox is the ordinary "nothing has come back
        # yet" state, and is the state a first --pull is in. Exit 2 is reserved
        # for a broken invocation (bad --vault, unparseable --since).
        print(f"note: no ChatGPT-*.md exports under {inbox}", file=sys.stderr)
        if args.format == "json":
            print("[]")
        return 1

    since = None
    if args.since:
        try:
            since = datetime.fromisoformat(args.since).timestamp()
        except ValueError:
            print(f"error: --since must be ISO (YYYY-MM-DD[THH:MM:SS]), got {args.since!r}",
                  file=sys.stderr)
            return 2

    citations = graph_citations(args.vault)
    records = []
    for path in exports:
        rec = parse_export(path)
        cited_by_name = flatten(path.name) in citations
        cited_by_url = bool(rec["conversation_id"] and rec["conversation_id"] in citations)
        rec["processed"] = cited_by_name or cited_by_url
        rec["processed_via"] = (
            "filename" if cited_by_name else "url" if cited_by_url else None
        )
        records.append(rec)

    # Newest arrival first -- the order you actually want to triage in.
    records.sort(key=lambda r: r["mtime_epoch"], reverse=True)
    total, processed = len(records), sum(r["processed"] for r in records)

    if since is not None:
        records = [r for r in records if r["mtime_epoch"] >= since]
    if not args.all:
        records = [r for r in records if not r["processed"]]
    if args.match:
        terms = args.match.lower().split()
        records = [
            r for r in records
            if all(t in f"{r['title']} {r['_prompt_full']}".lower() for t in terms)
        ]

    # Say why a result set is empty -- a silent empty list reads as "nothing to
    # do" when it may mean "your filter matched nothing".
    if not records:
        active = []
        if args.since:
            active.append(f"--since {args.since}")
        if args.match:
            active.append(f"--match {args.match!r}")
        if not args.all:
            active.append("unprocessed-only (default; --all to include cited)")
        filters = "; ".join(active) or "no filters"
        print(f"note: nothing matched [{filters}] among {total} export(s) "
              f"({processed} already cited in the graph)", file=sys.stderr)
        if args.format == "json":
            print("[]")
        return 1

    print(f"note: {len(records)} shown / {total} export(s), {processed} already cited",
          file=sys.stderr)

    if args.format == "json":
        # Underscore-prefixed keys are search-only; emitting full prompts would
        # spend the context the verification step needs.
        print(json.dumps(
            [{k: v for k, v in r.items() if not k.startswith("_")} for r in records],
            indent=2,
        ))
    else:
        for r in records:
            flag = f"processed({r['processed_via']})" if r["processed"] else "UNPROCESSED"
            print(f"{flag:22} {r['mtime']:20} {r['title']}")
            print(f"{'':22} {r['path']}")
            if r["prompt_excerpt"]:
                print(f"{'':22} > {r['prompt_excerpt'][:150]}")
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
