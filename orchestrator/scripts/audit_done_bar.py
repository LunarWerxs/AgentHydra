#!/usr/bin/env python3
"""audit_done_bar.py - OBSERVE ONLY: which ARCHIVED chats never met the done-bar?

THE ASK (owner, 2026-09-01: "I strongly feel chats are being archived when they are not
completely done... go through old chats looking for undone ones and make sure that's not the
case for any old ones"). It was the case, for 769 of them.

WHY THIS EXISTS BESIDE audit_archived.py, which answers the same question: that one asks the
daemon for a dossier PER CHAT, which is right for its restore path and far too slow for
"check every old one" - one HTTP call each over ~2,700 archived chats, and a 30-day window
had not finished after 25 minutes. This does the reading half entirely from disk in seconds,
so the whole history is checkable. Use this to FIND them; use audit_archived --restore, which
has the rails, to bring any back.

⛔ TWO TRAPS IT AVOIDS, both of which produced a scary and wrong list on the first cut:
  1. A conversation is only ARCHIVED if EVERY copy of it is. Grouping by session id and
     counting "any copy archived" put chats that had just been MOVED (old copy archived, new
     copy live) at the top of the "wrongly archived" list - chats that are running right now.
  2. Drill, probe and one-line smoke chats fail every done-bar and were archived correctly.
     They are counted and set aside, not mixed into the real work.

Usage: python audit_done_bar.py [--all] [--limit N] [--json]
       (--all also lists the drill/probe chats it set aside)
Exit:  0 nothing below the bar - 2 chats found below it - 1 fleet read failed.
"""

from __future__ import annotations

import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

from lib import clilib, gatelib
from lib import hydralib
from lib import stamplib

# Titles that fail every done-bar by design: drills, probes, one-line smoke targets.
JUNK_TITLE = re.compile(
    r"^(say ok|say the word ok|orch courier|reply with exactly|please reply|"
    r"\[agenthydra drill\]|.*\bACK\b.*|untitled|resume (project )?session|"
    r"you are an exacting principal product designer|test |probe|smoke)",
    re.IGNORECASE)
MIN_REAL_TITLE = 12


def _transcripts(fleet: dict) -> dict[str, Path]:
    """One definition, in stamplib beside the meta walk that always accompanies it."""
    return stamplib.transcript_index(fleet)


def _fully_archived(fleet: dict) -> dict[str, dict]:
    seen: dict[str, dict] = {}
    for store in stamplib.store_roots(fleet):
        for path, meta in stamplib.iter_metas(store["root"]):
            cli = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            rec = seen.setdefault(cli, {"title": "", "instances": [], "anyVisible": False})
            if meta.get("isArchived"):
                if store["instance"] not in rec["instances"]:
                    rec["instances"].append(store["instance"])
            else:
                rec["anyVisible"] = True  # trap 1: a live copy means it is NOT archived
            if meta.get("title") and not rec["title"]:
                rec["title"] = meta["title"]
    return {k: v for k, v in seen.items() if v["instances"] and not v["anyVisible"]}


def _why_below_bar(verdict: dict) -> str | None:
    fin = verdict.get("finished") or {}
    if verdict["state"] == "crashed":
        return f"crashed ({(verdict.get('crashed') or {}).get('kind')})"
    if fin.get("interrupted"):
        return "a person pressed stop"
    if fin.get("lane") == "archive-candidate":
        return None
    if fin.get("offers_to_continue"):
        return "offered to carry on"
    if fin.get("ends_with_question"):
        return "ended on a question"
    if fin.get("done_claim") == "no":
        return "its recap says NOT done"
    if fin.get("done_claim") != "yes":
        return "recap does not claim done"
    # Category first, count in the parenthesis: the byReason histogram groups on the text
    # before " (", exactly as it does for "crashed (kind)". With the count leading, every
    # distinct count was its own bucket and the dominant reason ranked below smaller ones.
    return f"open recommendation(s) ({len(fin.get('open_recommendations') or [])})"


def scan() -> dict:
    fleet = hydralib.fleet()
    tpath = _transcripts(fleet)
    archived = _fully_archived(fleet)
    now = time.time()
    real: list[dict] = []
    junk: list[dict] = []
    unreadable = 0
    for cli, rec in archived.items():
        p = tpath.get(cli)
        if not p:
            unreadable += 1
            continue
        verdict = gatelib.gate(cli, str(p), None)
        if not verdict:
            unreadable += 1
            continue
        why = _why_below_bar(verdict)
        if not why:
            continue
        title = (rec["title"] or "").strip()
        try:
            age_days = (now - p.stat().st_mtime) / 86400
        except OSError:
            age_days = 9999.0
        row = {"sessionId": cli, "title": title, "why": why,
               "instances": rec["instances"], "ageDays": round(age_days, 1)}
        (junk if (JUNK_TITLE.match(title) or len(title) < MIN_REAL_TITLE) else real).append(row)
    real.sort(key=lambda r: r["ageDays"])
    junk.sort(key=lambda r: r["ageDays"])
    return {"archivedChats": len(archived), "unreadable": unreadable,
            "real": real, "drills": junk,
            "byReason": Counter(r["why"].split(" (")[0] for r in real).most_common()}


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else 40
    try:
        rep = scan()
    except hydralib.DaemonError as err:
        print(f"audit_done_bar FAILED: {err}", file=sys.stderr)
        return 1
    if "--json" in argv:
        print(json.dumps(rep, indent=2))
        return 2 if rep["real"] else 0

    print(f"{rep['archivedChats']} fully-archived chat(s) on the fleet "
          f"({rep['unreadable']} have no readable transcript and cannot be judged)")
    print(f"  BELOW THE DONE-BAR and real work: {len(rep['real'])}")
    print(f"  drill/probe/one-liners (archived correctly, ignored): {len(rep['drills'])}\n")
    for why, n in rep["byReason"]:
        print(f"  {n:5d}  {why}")
    if rep["real"]:
        print(f"\nnewest {min(limit, len(rep['real']))}:")
        for r in rep["real"][:limit]:
            print(f"  {r['ageDays']:6.1f}d  [{r['why']}]  {r['title'][:60]}  "
                  f"({','.join(r['instances'])})  {r['sessionId'][:8]}")
    if "--all" in argv and rep["drills"]:
        print(f"\nset aside as drills/probes ({len(rep['drills'])}):")
        for r in rep["drills"][:limit]:
            print(f"  {r['ageDays']:6.1f}d  [{r['why']}]  {r['title'][:60]}  {r['sessionId'][:8]}")
    print("\nOBSERVE ONLY. To bring one back, use audit_archived.py --restore (it has the "
          "rails); restoring in bulk would flood the fleet and every account's quota.")
    return 2 if rep["real"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
