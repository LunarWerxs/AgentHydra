#!/usr/bin/env python3
"""waiting_scan.py - OBSERVE ONLY: which chats are waiting on a person, over REAL transcript tails.

census.py scans truncated previews and labels itself a lower bound; this script reads every
visible chat's full transcript tail and gates it, so an offer to carry on buried at the end of
a long recap is actually seen. Still observe-only: it names the waiting chats, it never touches
one.

A chat counts as WAITING when its last completed assistant turn offers to carry on, ends on a
question, or does not claim done - whether the chat is finished (no writer) or live-but-idle.
Live chats mid-turn are working, not waiting. Crashed chats are listed separately: they are
resume candidates, which is a different queue.

Usage: python waiting_scan.py [--json]
Exit:  0 scan completed - 1 daemon failure. (A completed scan with zero waiting chats is a real
answer here, unlike the census preview scan - full tails were read.)
"""

from __future__ import annotations

import json
import sys

from lib import clilib, gatelib
from lib import hydralib


def scan() -> dict:
    rows = [s for s in hydralib.sessions() if not s.get("archived")]
    waiting: list[dict] = []
    crashed: list[dict] = []
    working: list[dict] = []
    ungated: list[dict] = []
    counts = {"finished": 0, "running": 0, "crashed": 0, "no-transcript": 0, "dossier-failed": 0}

    for row in rows:
        sid = row.get("session_id") or ""
        title = row.get("title")
        instance = row.get("instance")
        live = None
        try:
            matches = hydralib.dossier(sid)
        except hydralib.DaemonError as err:
            # Gating without liveness would let an in-flight chat read as a mid-turn crash.
            # A chat whose liveness we could not read is UNGATED, loudly - and the whole scan
            # stops claiming completeness (a false 'complete' was v2's defining failure).
            counts["dossier-failed"] += 1
            ungated.append({"sessionId": sid, "title": title, "instance": instance,
                            "why": f"dossier read failed ({err}) - liveness unknown, so no verdict"})
            continue
        live = hydralib.live_for(sid, matches)
        v = gatelib.gate(sid, row.get("transcript_path") or "", live)
        if v is None:
            counts["no-transcript"] += 1
            _, why = gatelib.gateable(row.get("transcript_path") or "")
            ungated.append({"sessionId": sid, "title": title, "instance": instance,
                            "why": f"{why} - cannot be gated, so cannot be judged"})
            continue
        counts[v["state"]] += 1
        entry = {
            "sessionId": sid,
            "title": title,
            "instance": instance,
            "state": v["state"],
            "cause": v["cause"],
        }
        if v["state"] == "crashed":
            crashed.append({**entry, "kind": v["crashed"]["kind"]})
        elif v["state"] == "finished":
            f = v["finished"]
            if f["lane"] == "needs-input-review" or f["offers_to_continue"] or f["ends_with_question"]:
                waiting.append({
                    **entry,
                    "offersToContinue": f["offers_to_continue"],
                    "endsWithQuestion": f["ends_with_question"],
                    "doneClaim": f["done_claim"],
                    "evidence": f["last_assistant_text"][-300:],
                })
        elif v.get("idle"):
            i = v["idle"]
            waiting.append({
                **entry,
                "offersToContinue": gatelib.offers_to_continue(gatelib.recap_view(i["last_assistant_text"])),
                "endsWithQuestion": i["ends_with_question"],
                "doneClaim": i["done_claim"],
                "evidence": i["last_assistant_text"][-300:],
                "idleSecs": i["quiet_secs"],
            })
        else:
            working.append(entry)

    return {
        "scanned": len(rows),
        "source": "full transcript tails + dossier liveness",
        # Complete only when every chat actually got a verdict or was named as ungateable for
        # a reason on the chat itself (no transcript). A liveness read failing mid-scan means
        # the answer has a hole, and saying so is the point.
        "complete": counts["dossier-failed"] == 0,
        "counts": counts,
        "waitingOnAPerson": waiting,
        "crashed": crashed,
        "working": working,
        "ungated": ungated,
    }


def render(r: dict) -> str:
    L = [
        f"scanned {r['scanned']} visible chats over full transcript tails "
        f"({r['counts']['finished']} finished, {r['counts']['running']} live, "
        f"{r['counts']['crashed']} crashed, {r['counts']['no-transcript']} without a transcript"
        + (f", {r['counts']['dossier-failed']} liveness reads FAILED" if r["counts"].get("dossier-failed") else "")
        + ")",
        "",
    ]
    if not r["complete"]:
        L.append("⚠ INCOMPLETE: some chats' liveness could not be read - they are listed under")
        L.append("  'could not be gated' and this scan's zero-counts are lower bounds, not answers.")
        L.append("")
    if r["waitingOnAPerson"]:
        L.append(f"{len(r['waitingOnAPerson'])} chat(s) WAITING ON A PERSON - answer them, never archive them:")
        for w in r["waitingOnAPerson"]:
            tag = "offers to carry on" if w["offersToContinue"] else (
                "ends on a question" if w["endsWithQuestion"] else f"recap claims {w['doneClaim']}")
            idle = f", idle {w['idleSecs'] // 60}min with a live process" if w.get("idleSecs") else ""
            L.append(f"  - [{w['instance']}] {w['title']}  ({tag}{idle})")
            last = w["evidence"].strip().splitlines()
            if last:
                L.append(f"      ...{last[-1].strip()}")
    elif r["complete"]:
        L.append("No visible chat is waiting on a person - and this time full tails were read, so")
        L.append("that is an answer, not a lower bound.")
    else:
        L.append("No waiting chat FOUND - but the scan is incomplete (see above), so this is a")
        L.append("lower bound, not an answer. Re-run when the daemon reads cleanly.")
    if r["crashed"]:
        L.append("")
        L.append(f"{len(r['crashed'])} crashed chat(s) - resume candidates, a different queue:")
        for c in r["crashed"]:
            L.append(f"  - [{c['instance']}] {c['title']}  ({c['kind']})")
    if r["ungated"]:
        L.append("")
        L.append(f"{len(r['ungated'])} chat(s) could not be gated (no transcript) - saying so beats guessing:")
        for u in r["ungated"]:
            L.append(f"  - [{u['instance']}] {u['title']}")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    try:
        r = scan()
    except hydralib.DaemonError as err:
        print(f"waiting scan FAILED: {err}", file=sys.stderr)
        print(f"Is the AgentHydra daemon running? Try: curl {hydralib.BASE}/api/health", file=sys.stderr)
        return 1
    print(json.dumps(r, indent=2) if as_json else render(r))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
