#!/usr/bin/env python3
"""stage_reply.py - ACT (state only): write down a reply for one chat. SENDS NOTHING.

This is where an AI's judgment becomes a record. The toolbox decides mechanically and hands
the waiting chats to an AI (the judgment queue); the AI reads one, decides what to say, and
stages it here. `courier.py` is what actually types it, later, as a separate deliberate act.

The staged reply carries the EVIDENCE it was based on - the chat's own last words, pulled
from the gate - so the courier can prove at send time that it is looking at the right chat,
and so a person reviewing the queue can see what the AI was answering.

Usage: python stage_reply.py <title fragment | session id> --text "the reply" [--by name] [--json]
       python stage_reply.py --list [--json]
       python stage_reply.py --cancel <delivery id> [--json]
Exit:  0 staged/listed/cancelled - 3 not resolvable or bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from lib import clilib, deliverylib
from lib import gatelib
from lib import hydralib


_TAIL_BYTES = 400_000


def last_rendered_text(sid: str) -> str:
    """The chat's most recent rendered words, read straight from its own transcript.

    ⛔ THE GAP THIS FILLS, and it is the whole reason stalled chats were unrecoverable
    (found live 2026-09-01, on a chat frozen for seven hours): the gate reports
    `last_assistant_text` only for a FINISHED or IDLE chat. One that froze mid-tool is
    NEITHER - it still reads as 'running' - so the gate hands back nothing, the verify
    snippet comes out empty, and the courier refuses to type. The one class of chat that
    most needs waking was therefore the single class that could never be woken, and the
    refusal looked like a working safety rail rather than a dead end.

    This widens where the evidence COMES FROM; it does not weaken what the courier
    demands. The text sitting above a stuck tool call is still the last thing rendered in
    that pane, so it proves identity exactly as well as a finished turn's last line.
    """
    row = hydralib.session_row(sid) or {}
    tp = row.get("transcript_path")
    if not tp:
        # The same disk lookup the GATE got (gatelib.find_transcript_on_disk). Adding it
        # there and not here left the two halves disagreeing: a chat could be gated fine
        # from its on-disk transcript and still produce no verify snippet, so it stayed
        # unwakeable for the very reason that had just been fixed.
        tp = gatelib.find_transcript_on_disk(sid)
    if not tp:
        return ""
    try:
        p = Path(tp)
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > _TAIL_BYTES:
                f.seek(size - _TAIL_BYTES)
                f.readline()
            raw = f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
    for line in reversed(raw.splitlines()):
        if '"text"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "assistant":
            continue
        content = ((rec.get("message") or {}).get("content"))
        if not isinstance(content, list):
            continue
        texts = [b.get("text") for b in content
                 if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
        if texts:
            return "\n".join(texts)
    return ""


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    text = by = cancel_id = None
    do_list = "--list" in argv
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--text" and i + 1 < len(argv):
            text = argv[i + 1]
            i += 2
            continue
        if a == "--by" and i + 1 < len(argv):
            by = argv[i + 1]
            i += 2
            continue
        if a == "--cancel" and i + 1 < len(argv):
            cancel_id = argv[i + 1]
            i += 2
            continue
        if not a.startswith("--"):
            args.append(a)
        i += 1

    if do_list:
        rows = deliverylib.all_rows()
        if as_json:
            print(json.dumps({"deliveries": rows}, indent=2))
        elif not rows:
            print("nothing staged - the courier has nothing to deliver")
        else:
            for r in rows:
                mark = {"staged": "·", "delivered": "✓", "failed": "✗", "cancelled": "-"}.get(r["state"], "?")
                print(f"  {mark} [{r['state']}] {r['id']}  {r.get('title') or r['session']}")
                print(f"      {r['text'][:100]}")
                if r.get("lastError"):
                    print(f"      last error: {r['lastError'][:120]}")
        return 0

    if cancel_id:
        try:
            row = deliverylib.cancel(cancel_id)
        except deliverylib.InFlight as err:
            # Too late, and said so: a courier run has claimed it and may be typing it now.
            msg = f"NOT cancelled: {err}"
            print(json.dumps({"cancelled": False, "report": msg}, indent=2) if as_json else msg)
            return 3
        msg = (f"cancelled {cancel_id}" if row
               else f"nothing to cancel: {cancel_id} is not a staged reply")
        print(json.dumps({"cancelled": bool(row), "report": msg}, indent=2) if as_json else msg)
        return 0 if row else 3

    if len(args) != 1 or not text:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    try:
        match = hydralib.resolve_one(args[0])
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"REFUSED (deterministic): {err}", file=sys.stderr)
        return 3
    except hydralib.DaemonError as err:
        print(f"stage FAILED: {err}", file=sys.stderr)
        return 1

    sid = match.get("cliSessionId") or ""
    # The evidence: what this chat actually last said. Pulled from the gate rather than typed
    # by hand, so the verify snippet provably comes from THIS chat.
    verdict = gatelib.gate_match(match, hydralib.session_row)
    evidence = ""
    if verdict:
        src = verdict.get("finished") or verdict.get("idle") or {}
        evidence = src.get("last_assistant_text") or ""
    if not evidence:
        # The gate had nothing - a chat mid-turn or stalled. Read its own transcript instead
        # of refusing (see last_rendered_text): no snippet means no wake, and a stalled chat
        # is precisely the one that needs one.
        evidence = last_rendered_text(sid)

    entry = deliverylib.stage(
        sid, text, title=match.get("title") or "", instance=match.get("instance") or "",
        evidence=evidence, by=by or "ai",
    )
    msg = (f"staged {entry['id']} for '{entry['title']}' ({entry['instance']}):\n"
           f"  {entry['text'][:160]}\n"
           f"  verify snippet: {entry['verifyText'][:80] or '(none - the courier will refuse)'}\n"
           "  Nothing sent. Deliver with: python scripts/courier.py --yes")
    print(json.dumps({"staged": entry, "report": msg}, indent=2) if as_json else msg)
    if not entry["verifyText"]:
        print("\n⚠ no verify snippet could be derived from this chat's last words - the courier "
              "refuses to type without one, because it is what proves the right chat. Re-run "
              "after the chat has said something, or stage against a chat with a readable tail.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
