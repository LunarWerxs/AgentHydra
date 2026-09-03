#!/usr/bin/env python3
"""audit_archived.py - OBSERVE (and, on --restore, ACT): were recently-archived chats really done?

Born as a one-off (owner order, 2026-08-31): v2's archiver filed chats that still had work in
them - offers to carry on, open questions, recaps that said "no", even mid-work crashes. This
audits every chat ARCHIVED with activity in the last N hours, across all accounts, by gating
its REAL transcript tail with the same gate the act scripts use, and names every one where
work remained. With --restore it unarchives those through archive_chat's own rails.

The window is on last_activity_at OR the meta file's mtime: archiving rewrites local_*.json,
so a chat idle for days but filed by the archiver within the window still gets its mtime
bumped - a pure last_activity_at gate would miss exactly the recently-archived chats this
script exists to catch.

Verdicts:
  correct            finished on a clean archive-candidate turn - the archive was right
  wrong-waiting      the last turn offers to carry on or ends on a question - it was WAITING
  wrong-not-done     the recap does not claim done - work remained by its own account
  wrong-interrupted  a person pressed stop - theirs to resume, never automation's to file
  wrong-crashed      it died mid-work (mid-turn / usage wall / error) - a resume candidate
  live-contradiction a LIVE process under an archived flag - the owner untangles, never code
  ungateable         no readable transcript (e.g. opencode) - reported, never guessed about

Usage: python audit_archived.py [--hours 48] [--restore] [--json]
Exit:  0 audit ran and nothing needs restoring (or --restore restored everything it could)
       2 wrongly-archived chats found (observe mode) or some restorations did not land
       1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import clilib
from lib import gatelib
from lib import hydralib

WINDOW_HOURS = 48


def classify(verdict: dict | None, live: dict | None, why_ungated: str = "") -> tuple[str, str]:
    if live:
        return ("live-contradiction",
                f"a LIVE process (pid {live.get('pid')}) is writing a chat the flag calls archived - "
                "a contradiction the owner untangles; automation must not touch it")
    if verdict is None:
        return ("ungateable", why_ungated or "no readable transcript")
    if verdict["state"] == "crashed":
        return ("wrong-crashed",
                f"it died mid-work ({verdict['crashed']['kind']}) - archiving buried a resume candidate")
    fin = verdict["finished"]
    if fin["interrupted"]:
        return ("wrong-interrupted", "a person pressed stop - theirs to resume, not a finished chat")
    if fin["lane"] == "archive-candidate":
        return ("correct", "finished turn, recap says done, nothing asked, no offer to carry on")
    if fin["offers_to_continue"]:
        return ("wrong-waiting", "its last words OFFER TO CARRY ON - it was waiting for a word, not done")
    if fin["ends_with_question"]:
        return ("wrong-waiting", "its last words end on a QUESTION - it was waiting for an answer")
    return ("wrong-not-done",
            f"its own recap does not claim done (claim: {fin['done_claim']}) - work remained")


def _store_sources() -> list[tuple[str, "Path", "Path"]]:
    """(instanceName, chatStoreRoot, cliHome) for every desktop chat store on this machine.

    ⚠ /api/sessions is NOT the surface for this audit - it lists CLI-indexed sessions, while
    the archive flags live in each profile's own chat store (local_*.json metas). The first
    cut of this audit used the sessions table and reported a spotless ZERO over a fleet the
    owner knew held mis-archived chats. Instance profiles keep store and CLI home in the same
    dir; the regular (non-isolated) app stores chats under AppData\\Claude but its CLI home
    is the plain ~/.claude."""
    from pathlib import Path

    home = Path.home()
    out: list[tuple[str, Path, Path]] = []
    try:
        for i in hydralib.fleet().get("instances", []):
            d = i.get("dir")
            if d:
                out.append((str(i.get("name")), Path(d), Path(d)))
    except hydralib.DaemonError:
        for d in (home / ".claude-instances").glob("*"):
            if d.is_dir():
                out.append((d.name, d, d))
    out.append(("default", home / "AppData" / "Roaming" / "Claude", home / ".claude"))
    return out


def _find_transcript(cli_id: str, cli_home: "Path") -> str:
    from pathlib import Path

    for root in (cli_home, Path.home() / ".claude"):
        for hit in root.glob(f"projects/*/{cli_id}.jsonl"):
            return str(hit)
    return ""


def _toolbox_archived(cli_session_id: str) -> bool:
    """Did THIS toolbox file the archive (a ledger row of kind 'archive' for the chat)? The
    ledger prunes ordinary rows after its window, so a deterministic row or any row counts;
    absence within the audit's own window means a person did it."""
    from lib import ledgerlib

    try:
        return any(r.get("kind") == "archive" and r.get("session") == cli_session_id
                   for r in ledgerlib._load())
    except Exception:
        return False


def audit(hours: int) -> dict:
    floor_ms = int((time.time() - hours * 3600) * 1000)
    floor_s = floor_ms / 1000

    # One record per cliSessionId; a chat copied across profiles is one chat.
    seen: dict[str, dict] = {}
    metas_total = 0
    for inst_name, store, cli_home in _store_sources():
        for meta_path in store.glob("claude-code-sessions/*/*/local_*.json"):
            metas_total += 1
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not meta.get("isArchived"):
                continue
            mtime_recent = False
            try:
                mtime_recent = meta_path.stat().st_mtime >= floor_s
            except OSError:
                pass
            if not mtime_recent and (meta.get("lastActivityAt") or 0) < floor_ms:
                continue
            cli = str(meta.get("cliSessionId") or "")
            if not cli:
                continue
            prev = seen.get(cli)
            entry = {
                "cliSessionId": cli,
                "title": meta.get("title"),
                "instances": [inst_name],
                "lastActivityAt": meta.get("lastActivityAt"),
                "cliHome": str(cli_home),
            }
            if prev:
                if inst_name not in prev["instances"]:
                    prev["instances"].append(inst_name)
            else:
                seen[cli] = entry

    out = []
    total = len(seen)
    for n, entry in enumerate(seen.values(), 1):
        # Each entry costs a daemon dossier round trip (~0.9 s measured 2026-09-01), so a
        # 24 h window is a silent minute-plus; say where it is, on stderr, never in the report.
        if total >= 20 and n % 10 == 0:
            print(f"  ... audited {n}/{total}", file=sys.stderr, flush=True)
        cli = entry["cliSessionId"]
        live = None
        note = ""
        verdict = None
        superseded_by = None
        try:
            matches = hydralib.dossier(cli)
            live = hydralib.live_for(cli, matches)
            # A prior HOP of a lineage whose newer hop carries the work is CORRECTLY
            # archived - restoring it would revive a retired lineage. The dossier resolves
            # the lineage head; a head with a different cliSessionId marks this one a hop.
            for m in matches:
                if m.get("cliSessionId") != cli and (
                    cli in (m.get("priorCliSessionIds") or []) or cli in (m.get("lineageIds") or [])
                ):
                    superseded_by = m.get("title")
                    break
        except hydralib.DaemonError as err:
            note = f"liveness read failed ({err})"
        if not note:
            from pathlib import Path

            transcript = _find_transcript(cli, Path(entry["cliHome"]))
            verdict = gatelib.gate(cli, transcript, live)
            if verdict is None:
                _, note = gatelib.gateable(transcript)
        status, why = classify(verdict, live, note)
        # A PERSON'S ARCHIVE IS THEIR WORD (owner, 2026-09-02: "I'm archiving them - they are
        # done"). Only an archive the TOOLBOX filed (a ledger row of kind 'archive') can be
        # wrong by this audit's standard; one with no such row was filed by hand, and the
        # audit's opinion of the chat's last words is not the owner's.
        if status.startswith("wrong-") and not _toolbox_archived(cli):
            status, why = "owner-archived", "archived by hand (no toolbox archive on record) - the owner's word, not audited"
        evidence = ""
        if verdict and verdict.get("finished"):
            evidence = verdict["finished"]["last_assistant_text"][-350:]
        if superseded_by and status.startswith("wrong-") and not live:
            status, why = "superseded-hop", (
                f"an older hop of a lineage whose newer hop ('{superseded_by}') carries the "
                "work - archiving the old hop was right"
            )
        elif status == "wrong-not-done" and len(evidence.strip()) < 60:
            # Recap absent AND a tiny closing line ("Ready.", "... ACK"): the fleet's own
            # drill/smoke targets look exactly like this. Not restored, but LISTED - a real
            # chat that merely signed off tersely deserves an eyeball, not silence.
            status, why = "tiny-no-recap", (
                "no recap and a tiny closing line - drill/smoke chats look like this; "
                "eyeball it before restoring by hand"
            )
        out.append({
            "sessionId": cli,
            "title": entry["title"],
            "instance": "+".join(entry["instances"]),
            "lastActivityAt": entry["lastActivityAt"],
            "status": status,
            "why": why,
            "evidence": evidence,
        })
    rows = out
    order = ["live-contradiction", "wrong-waiting", "wrong-not-done", "wrong-interrupted",
             "wrong-crashed", "tiny-no-recap", "superseded-hop", "ungateable", "correct"]
    out.sort(key=lambda c: order.index(c["status"]) if c["status"] in order else len(order))
    return {
        "windowHours": hours,
        "archivedInWindow": len(rows),
        "wrong": [c for c in out if c["status"].startswith("wrong-")],
        "correct": [c for c in out if c["status"] == "correct"],
        "other": [c for c in out if not c["status"].startswith("wrong-") and c["status"] != "correct"],
    }


def restore(wrong: list[dict]) -> list[dict]:
    import archive_chat

    results = []
    for c in wrong:
        code, said = clilib.capture(archive_chat.main, [c["sessionId"], "--unarchive"])
        results.append({
            **c,
            "restored": code == 0,
            "exit": code,
            "outcome": ("restored-and-verified" if code == 0 else
                        # exit 7 covers 3 distinct archive_chat causes (UI miss, running-app
                        # actuator failure, app-closed write race) - don't claim it was the UI;
                        # tell the operator to re-run rather than read this as a settled no-op.
                        "not-yet-settled (exit 7) - re-run --restore to confirm" if code == 7 else
                        f"NOT restored (exit {code})"),
            "output": said,
        })
    return results


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    do_restore = "--restore" in argv
    hours = WINDOW_HOURS
    if "--hours" in argv:
        hours = int(argv[argv.index("--hours") + 1])
    try:
        report = audit(hours)
    except hydralib.DaemonError as err:
        print(f"audit FAILED: {err}", file=sys.stderr)
        return 1

    restored = restore(report["wrong"]) if do_restore and report["wrong"] else None

    if as_json:
        print(json.dumps({**report, "restored": restored}, indent=2))
    else:
        print(f"{report['archivedInWindow']} chat(s) archived with activity in the last {hours}h - "
              f"{len(report['wrong'])} had WORK REMAINING, {len(report['correct'])} were correct, "
              f"{len(report['other'])} other")
        for c in report["wrong"]:
            print(f"\n  ✗ [{c['instance']}] {c['title']}")
            print(f"    {c['status']}: {c['why']}")
            last = (c["evidence"] or "").strip().splitlines()
            if last:
                print(f"    last words: ...{last[-1].strip()[:140]}")
        for c in report["other"]:
            print(f"\n  ? [{c['instance']}] {c['title']} - {c['status']}: {c['why']}")
        if restored is not None:
            print()
            for r in restored:
                mark = "✓" if r["restored"] else ("⚠" if r["exit"] == 7 else "✗")
                print(f"  {mark} {r['title']}: {r['outcome']}")
        elif report["wrong"]:
            print("\nOBSERVE ONLY - rerun with --restore to unarchive the wrongly-archived ones.")
    if restored is not None:
        return 0 if all(r["restored"] or r["exit"] == 7 for r in restored) else 2
    return 2 if report["wrong"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
