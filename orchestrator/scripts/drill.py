#!/usr/bin/env python3
"""drill.py - ACT (reversible): prove the act chain against the REAL daemon, and leave the
fleet exactly as found.

Unit tests prove the logic against a stub; smoke.py proves the reads against the live daemon;
this drills the WRITES - through the very production scripts, not a copy of their logic - on a
round-trip that ends where it started:

  archive drill (default)  needs a chat that is ALREADY ARCHIVED with NO live writer, in an
                           instance whose app is CLOSED (so the flag is durable, not
                           the disk-flag path). unarchive -> verify -> archive -> verify.
  --rename                 needs the chat's instance app RUNNING (the daemon's rename drives
                           the app's real UI via UI-Automation - programmatic clicks, no
                           cursor, no focus steal). rename to '<title> [drill]' -> verify ->
                           rename back -> verify.

Every step runs the production script's own main() and trusts nothing it does not re-verify.
If a RESTORE step fails, this exits loudly with the exact state the chat was left in and the
one command that puts it back - a drill that can strand a chat silently would be worse than
no drill.

Pick the subject deliberately: a retired/junk chat of your own. The drill refuses anything
with a live writer and anything it cannot restore.

Usage: python drill.py --chat <title fragment | session id> [--rename] [--json]
Exit:  0 round-trip complete, fleet as found - 2 subject refused (unsuitable) -
       1 a step failed (output says what state the chat is in).
"""

from __future__ import annotations

import json
import sys

import archive_chat
from lib import clilib
from lib import hydralib
import rename_chat

# Each drill step runs the production script's own main(), captured (shared mechanism).
run_step = clilib.capture


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    do_rename = "--rename" in argv
    chat = None
    i = 0
    while i < len(argv):
        if argv[i] == "--chat" and i + 1 < len(argv):
            chat = argv[i + 1]
            i += 2
            continue
        i += 1
    if not chat:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    steps: list[dict] = []

    def report(ok: bool, verdict: str, code: int) -> int:
        payload = {"ok": ok, "verdict": verdict, "steps": steps}
        if as_json:
            print(json.dumps(payload, indent=2))
        else:
            for s in steps:
                print(f"[{'ok' if s['ok'] else 'FAILED'}] {s['name']} (exit {s['code']})")
                for line in s["output"].splitlines():
                    print(f"      {line}")
            print()
            print(verdict)
        return code

    def step(name: str, fn, argv_step: list[str], want: tuple[int, ...] = (0,)) -> bool:
        code, out = run_step(fn, argv_step)
        steps.append({"name": name, "code": code, "ok": code in want, "output": out})
        return code in want

    # -- vet the subject before touching anything
    try:
        match = hydralib.resolve_one(chat)
        fleet = hydralib.fleet()
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return report(False, f"subject refused: {err}", 2)
    except hydralib.DaemonError as err:
        return report(False, f"daemon unreachable: {err}", 1)

    sid = match.get("cliSessionId") or ""
    title = str(match.get("title") or "")
    if match.get("live"):
        return report(
            False,
            f"subject refused: '{title}' has a LIVE writer (pid {match['live'].get('pid')}) - "
            "a drill never touches working chats.",
            2,
        )
    inst = next(
        (i for i in fleet.get("instances", []) if str(i.get("name", "")).lower() == str(match.get("instance", "")).lower()),
        None,
    )
    app_running = bool(inst and inst.get("isRunning"))

    if do_rename:
        # -- rename round-trip: programmatic UI clicks through the daemon's UIA actuator.
        if not app_running:
            return report(
                False,
                f"subject refused: rename drives the app's real UI, and '{match.get('instance')}' "
                "is not running. Open it (open_instance.py) or drill an open instance's chat.",
                2,
            )
        if bool(match.get("archived")):
            return report(
                False,
                f"subject refused: '{title}' is archived, so the app renders no sidebar row for "
                "it - and the UI actuator can only click rendered rows. Drill a visible chat.",
                2,
            )
        drill_title = f"{title} [drill]"
        if not step("rename to drill title", rename_chat.main, [sid, "--to", drill_title]):
            return report(
                False,
                f"rename FAILED - '{title}' should still carry its original name (the actuator "
                "verifies its own click); confirm with: python scripts/dossier.py " + sid,
                1,
            )
        if not step("rename back", rename_chat.main, [sid, "--to", title]):
            return report(
                False,
                f"⚠ RESTORE FAILED: the chat is now titled '{drill_title}'. Put it back with:\n"
                f"  python scripts/rename_chat.py {sid} --to \"{title}\"",
                1,
            )
        return report(True, f"rename round-trip complete: '{title}' -> '{drill_title}' -> '{title}'. "
                            "Two real UI clicks landed and verified; the fleet is as found.", 0)

    # -- archive round-trip
    if not bool(match.get("archived")):
        return report(
            False,
            f"subject refused: '{title}' is NOT archived. The archive drill starts from an "
            "archived chat so its resting state is where it ends (and where any failure leaves it "
            "merely visible, never lost). Archive one deliberately first, or pick another.",
            2,
        )
    if app_running:
        return report(
            False,
            f"subject refused: '{match.get('instance')}' has a RUNNING app, so archive flags land "
            "the un-durable disk-flag path (the app holds its chat list in memory). "
            "Drill a chat in a closed instance, or quit the app first (quit_instance.py).",
            2,
        )
    if not step("unarchive", archive_chat.main, [sid, "--unarchive"]):
        return report(
            False,
            f"unarchive FAILED - '{title}' should still be archived; confirm with: "
            f"python scripts/dossier.py {sid}",
            1,
        )
    # --no-preserve: a drill is a reversible round-trip PROOF, not a real retirement - it must
    # not fire the docs-update prompt into the subject chat (owner rule is for genuine archives).
    if not step("re-archive", archive_chat.main, [sid, "--force", "--no-preserve"]):
        # --force: the drill IS a person's deliberate word, and the subject is a retired chat
        # whose gate verdict may predate the recap convention.
        return report(
            False,
            f"⚠ RESTORE FAILED: '{title}' is now VISIBLE (unarchived). Put it back with:\n"
            f"  python scripts/archive_chat.py {sid} --force",
            1,
        )
    return report(True, f"archive round-trip complete: '{title}' unarchived, verified, re-archived, "
                        "verified. The fleet is as found.", 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
