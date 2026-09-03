#!/usr/bin/env python3
"""reconcile.py - OBSERVE (+`--retry`): did every past archive attempt actually settle?

THE HOLE THIS FILLS: archive_chat.py honestly refuses to claim success when it writes a flag
under a RUNNING app (exit 7) - the app holds its chat list in memory and can re-save the flag
away. But nothing ever went back to check. Rule 4 ("never claim an act landed without
checking") was honoured at write time and then forgotten, so a chat could sit half-archived
forever with the ledger's attempt still counted against it.

This closes that loop. It reads the attempt ledger for archive attempts, re-reads each chat's
CURRENT state from the daemon, and reports:

  landed        disk says what we asked and the app is closed -> clears the ledger,
                because success must clear the breaker's count
  reverted      the flag is gone: the running app re-saved it away - a real, silent failure,
                and exactly the loop the breaker exists to bound
  unconfirmed-on-screen  the app is running, so screen-vs-disk agreement is unknown from
                here; --retry settles it through the app's OWN control (the owner never
                restarts the apps, so nothing here ever waits for one)
  gone          the chat no longer resolves (deleted/merged) -> clears the ledger

With --retry it re-runs archive_chat on the REVERTED and UNCONFIRMED ones (each through the
full rails, so a hold, a live writer or the breaker still stops it).

Usage: python reconcile.py [--retry] [--json]
Exit:  0 everything settled - 2 archives need settling (or a retry did not land) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import armlib, clilib
from lib import clilib
from lib import hydralib
from lib import ledgerlib


def _archive_attempts() -> list[dict]:
    """Every chat with a recorded archive attempt, newest attempt first."""
    seen: dict[str, dict] = {}
    for row in ledgerlib._load():
        if row.get("kind") != "archive":
            continue
        sid = str(row.get("session") or "")
        if not sid:
            continue
        prev = seen.get(sid)
        if prev is None or row.get("at", 0) > prev.get("at", 0):
            seen[sid] = row
    return sorted(seen.values(), key=lambda r: r.get("at", 0), reverse=True)


def reconcile() -> dict:
    instances = {str(i.get("name", "")).lower(): i for i in hydralib.fleet().get("instances", [])}
    rows = []
    for att in _archive_attempts():
        sid = str(att.get("session"))
        note = str(att.get("note") or "")
        wanted_archived = not note.lower().startswith("unarchive")
        try:
            matches = hydralib.dossier(sid)
        except hydralib.DaemonError as err:
            rows.append({"sessionId": sid, "state": "unknown", "title": None,
                         "why": f"dossier read failed ({err}) - no verdict"})
            continue
        if not matches:
            ledgerlib.clear("archive", sid)
            rows.append({"sessionId": sid, "state": "gone", "title": None,
                         "why": "the chat no longer resolves - ledger entry cleared"})
            continue
        m = matches[0]
        inst = instances.get(str(m.get("instance") or "").lower())
        app_running = bool(inst and inst.get("isRunning"))
        is_archived = bool(m.get("archived"))
        entry = {"sessionId": sid, "title": m.get("title"),
                 "instance": m.get("instance"), "attemptAt": att.get("at"),
                 # which DIRECTION the original attempt wanted - --retry must re-run THAT,
                 # not blindly re-archive (a reverted UNARCHIVE re-archived the chat the
                 # owner had just restored; adversarial review, 2026-08-31)
                 "wantedArchived": wanted_archived}
        if is_archived == wanted_archived and not app_running:
            ledgerlib.clear("archive", sid)
            rows.append({**entry, "state": "landed",
                         "why": "the flag stuck and its app is closed - verified, ledger cleared"})
        elif app_running:
            rows.append({**entry, "state": "unconfirmed-on-screen",
                         "why": f"{m.get('instance')}'s app is RUNNING, so whether the screen "
                                "agrees with the disk is unknown from here - run --retry and "
                                "archive_chat settles it through the app's OWN control (nobody "
                                "waits for a restart; the owner never restarts the apps)"})
        else:
            rows.append({**entry, "state": "reverted",
                         "why": "the app was running when the flag was written and re-saved it "
                                "away - the archive silently did NOT stick"})
    order = ["reverted", "unconfirmed-on-screen", "unknown", "landed", "gone"]
    rows.sort(key=lambda r: order.index(r["state"]) if r["state"] in order else 99)
    return {"generatedAt": int(time.time() * 1000), "checked": len(rows), "rows": rows,
            # "unknown" (a failed dossier read) counts as UNSETTLED: it used to be invisible
            # to both the exit code and --retry, so a failed read printed as all-clear
            # (adversarial review, 2026-08-31). archive_chat re-checks at T-0, so retrying
            # an unknown is safe by construction.
            "reverted": [r for r in rows
                         if r["state"] in ("reverted", "unconfirmed-on-screen", "unknown")]}


def retry(reverted: list[dict]) -> list[dict]:
    import archive_chat

    out = []
    for r in reverted:
        # Retry the DIRECTION the original attempt wanted. wantedArchived is absent only on
        # "unknown" rows (the dossier read failed before direction was known) - archive is
        # the right default there and archive_chat's own T-0 recheck keeps it honest.
        unarchive = r.get("wantedArchived") is False
        # --no-preserve: a reverted archive was ALREADY preserved on its first pass; re-doing
        # the docs-update prompt on a re-archive would be redundant (and would defer the fix
        # the retry exists to apply).
        argv = [r["sessionId"]] + (["--unarchive"] if unarchive else ["--no-preserve"])
        code, said = clilib.capture(archive_chat.main, argv)
        done_word = "restored (unarchived) and verified" if unarchive else "re-archived and verified"
        out.append({**r, "retryExit": code, "retried": code == 0,
                    "outcome": (done_word if code == 0 else
                                "ui-could-not-reach-the-row" if code == 7 else
                                "held" if code == 6 else
                                "breaker" if code == 5 else
                                f"not retried (exit {code})"),
                    "output": said})
    return out


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    do_retry = "--retry" in argv
    disarmed = False
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so -
    # nothing acted is not a failure, so the exit code says so too.
    if do_retry:
        refusal = armlib.refuse_unless_armed(argv, "retrying archives")
        if refusal:
            print(refusal)
            do_retry = False
            disarmed = True
    try:
        report = reconcile()
    except hydralib.DaemonError as err:
        print(f"reconcile FAILED: {err}", file=sys.stderr)
        return 1
    retried = retry(report["reverted"]) if do_retry and report["reverted"] else None
    if as_json:
        print(json.dumps({**report, "retried": retried}, indent=2))
    else:
        counts: dict[str, int] = {}
        for r in report["rows"]:
            counts[r["state"]] = counts.get(r["state"], 0) + 1
        print(f"checked {report['checked']} chat(s) with recorded archive attempts: "
              + (", ".join(f"{v} {k}" for k, v in counts.items()) or "none"))
        for r in report["rows"]:
            if r["state"] in ("landed", "gone"):
                continue
            print(f"\n  [{r['state']}] {r.get('title') or r['sessionId']}")
            print(f"    {r['why']}")
        if retried is not None:
            print()
            for r in retried:
                print(f"  retry: {r['outcome']} - {r.get('title') or r['sessionId']}")
        elif report["reverted"]:
            print("\nRerun with --retry to re-archive the reverted ones through the full rails.")
    if retried is not None:
        return 0 if all(r["retried"] for r in retried) else 2
    return 0 if disarmed else (2 if report["reverted"] else 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
