#!/usr/bin/env python3
"""rename_chat.py - ACT: rename ONE chat through the running app's own Rename control.

The daemon's rename route drives the app's real UI (not a disk write), so unlike archiving
there is no pending-restart limbo: it either landed on screen or it did not, and the daemon's
actuator verifies its own click. This script still re-verifies through the dossier, because
"never claim an act landed without checking" is a rule, not a mood.

The current on-screen title is always passed (from the dossier), which is what the daemon
needs when a chat's name drifted. A 404 (no desktop instance holds this chat) is deterministic.

⚠ FRESHLY-IMPORTED CHATS: the running app renders an imported chat as 'Untitled' whatever its
disk title says, and the UIA actuator matches rows by RENDERED title - so renaming a batch of
fresh imports hits an ambiguity refusal (N identical 'Untitled' rows) by design. The durable
path for those is a disk title-write while the instance is CLOSED; see the daemon's own rename
route comment and Manage-DesktopChat.ps1's AMBIGUITY IS A REFUSAL block.

Usage: python rename_chat.py <title fragment | session id> --to "New title" [--json]
Exit:  0 renamed and verified - 3 not resolvable / not held by any instance (deterministic)
       5 breaker - 6 the chat is HELD (a person's hands-off switch; --force overrides) -
       1 daemon failure or verify failed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import windowlib

# THE APP'S OWN RENAME CONTROL, driven from THIS repo (owner, 2026-09-01: "relocate it into
# the orchestrator, I own both codebases"). Until the live smoke that evening the rename went
# through the daemon's /rename route, i.e. AgentHydra's copy of the same actuator - which
# counts the open chat's HEADER menu beside its sidebar menu and refuses every chat that is
# currently open as ambiguous (3 of 3 renames failed). The copy here carries the fix.
ACTUATOR = Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def _drive_rename(instance: str, old_title: str, new_title: str) -> tuple[int, str]:
    """Rename through the app's own sidebar control. Exits: 0 renamed and rendered under the
    new name - 1 error or ambiguity - 2 invoked but the new name did not render - 3 the row
    is not rendered in that instance - 7 the window is busy (another lane is driving it)."""
    if not ACTUATOR.exists():
        return 1, f"the UIA actuator is missing at {ACTUATOR}"
    with windowlib.instance_lock(instance, wait_secs=60) as mine:
        if not mine:
            return 7, ("REFUSED: that instance's window is busy - another lane is driving it "
                       "right now; retry next pass")
        with windowlib.keep_placement(instance):
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR),
                 "-Title", str(old_title), "-Instance", str(instance),
                 "-Action", "Rename", "-NewTitle", str(new_title)],
                timeout=240,
            )
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def _parse_args(argv: list[str]) -> tuple[bool, bool, str | None, list[str]]:
    """Parse the CLI args. Returns (as_json, force, new_title, positional args)."""
    as_json = "--json" in argv
    force = "--force" in argv
    new_title = None
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--to" and i + 1 < len(argv):
            new_title = argv[i + 1]
            i += 2
            continue
        if not a.startswith("--"):
            args.append(a)
        i += 1
    return as_json, force, new_title, args


def _resolve_or_report(target: str, as_json: bool) -> tuple[dict | None, int | None]:
    """Resolve the chat. Returns (match, None) on success, or (None, exit code) after
    printing the refusal/failure report."""
    try:
        return hydralib.resolve_one(target), None
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return None, out({"renamed": False, "report": f"REFUSED (deterministic): {err}"}, as_json, 3)
    except hydralib.DaemonError as err:
        return None, out({"renamed": False, "report": f"rename FAILED: {err}"}, as_json, 1)


def _blocked_by_hold_or_breaker(match: dict, chat_id: str, force: bool, as_json: bool) -> int | None:
    """A HOLD is a person's word and outranks every verdict below (rule 5, every act script's
    rule 1): the unattended machinery leaves held chats alone. --force is that person speaking
    again. Closes drill.py's --rename round trip renaming a held chat out from under whoever
    placed the hold (drill.py's --rename goes through this script).

    Returns an exit code (already printed) if the rename is blocked, else None to proceed."""
    session_id = match.get("cliSessionId") or chat_id
    hold_why = holdlib.why_blocked(session_id)
    if hold_why and not force:
        return out({"renamed": False, "held": True, "report": f"REFUSED: {hold_why}"}, as_json, 6)

    brake = ledgerlib.check("rename", chat_id)
    if brake["suppressed"] and not force:
        return out(
            {"renamed": False, "breaker": brake, "report": f"SUPPRESSED by the breaker: {brake['why']}"},
            as_json,
            5,
        )
    return None


def _attempt_rename(instance: str, old_title: str, new_title: str, chat_id: str,
                     as_json: bool) -> tuple[dict | None, int | None]:
    """Drives the actuator and turns its exit code into a report. Returns (result, None) to
    continue to verification, or (None, exit code) if the attempt itself failed or was refused."""
    ledgerlib.note("rename", chat_id, note=f"'{old_title}' -> '{new_title}'")
    code, text = _drive_rename(instance, old_title, new_title)
    if code == 7:
        return None, out({"renamed": False, "report": text}, as_json, 1)
    if code == 3:
        # Not rendered in that instance: the app is closed or the row is virtualized away.
        # Deterministic for this pass; the row renders when the app is open and scrolled.
        ledgerlib.note("rename", chat_id, deterministic=True, note=f"not rendered: {text[:120]}")
        return None, out(
            {"renamed": False, "actuator": text,
             "report": f"REFUSED (deterministic): '{old_title}' is not rendered in {instance}'s "
                       f"window right now ({text[:160]})"},
            as_json, 3,
        )
    if code != 0:
        return None, out(
            {"renamed": False, "actuator": text,
             "report": f"rename did NOT land: {text[:300]}. Attempt recorded."},
            as_json, 1,
        )
    return {"ok": True, "detail": text}, None


def _verify_and_report(match: dict, chat_id: str, old_title: str, new_title: str,
                        result: dict, as_json: bool) -> int:
    """Re-verify through the dossier - the rename actuator checks its own click, we check the
    record. Match on THIS chat's id, not on any row in the lineage: a lineage can hold more
    than one copy, and a coincidental title elsewhere must not vouch for the row we renamed."""
    try:
        after = hydralib.dossier(match.get("cliSessionId") or chat_id)
    except hydralib.DaemonError as err:
        # UNKNOWN, not False: the read-back itself failed, so a title that silently disagrees
        # (verified=False, same as a genuinely stale dossier) would be the wrong verdict - we
        # have no evidence either way. This used to fall through to the "not verified" branch
        # below wearing an empty list, which is exactly the conflation the doctrine forbids.
        ledgerlib.verify("rename", chat_id, None, note=f"verify read-back failed: {err}")
        return out(
            {
                "renamed": True,
                "verified": None,
                "daemon": result,
                "report": (
                    f"the daemon reports the rename landed ('{old_title}' -> '{new_title}') but "
                    f"the verify read-back itself failed ({err}) - outcome is UNKNOWN, not "
                    "claiming success or failure. Attempt kept on the ledger; do not re-run "
                    "blindly."
                ),
            },
            as_json,
            1,
        )
    verified = any(m.get("chatId") == chat_id and m.get("title") == new_title for m in after)
    if not verified:
        ledgerlib.verify(
            "rename", chat_id, False,
            note=f"dossier does not show the title as '{new_title}' yet",
        )
        return out(
            {
                "renamed": True,
                "verified": False,
                "daemon": result,
                "report": (
                    f"the daemon reports the rename landed ('{old_title}' -> '{new_title}') but "
                    "the dossier does not show the new title yet - metadata can lag the click; "
                    "re-run dossier.py in a moment before trusting it. Attempt kept on the ledger."
                ),
            },
            as_json,
            1,
        )

    ledgerlib.verify("rename", chat_id, True)
    ledgerlib.clear("rename", chat_id)
    return out(
        {
            "renamed": True,
            "verified": True,
            "report": f"renamed and VERIFIED: '{old_title}' -> '{new_title}'",
        },
        as_json,
        0,
    )


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json, force, new_title, args = _parse_args(argv)
    if len(args) != 1 or not new_title or not new_title.strip():
        print(__doc__.strip(), file=sys.stderr)
        return 3
    new_title = new_title.strip()

    match, err_code = _resolve_or_report(args[0], as_json)
    if match is None:
        return err_code

    # chatId is the verify key: the dossier record we re-read after the act.
    chat_id = match.get("chatId") or ""
    old_title = str(match.get("title") or "")
    if old_title == new_title:
        return out(
            {"renamed": False, "report": f"nothing to do: the chat is already titled '{new_title}'"},
            as_json,
            0,
        )

    blocked = _blocked_by_hold_or_breaker(match, chat_id, force, as_json)
    if blocked is not None:
        return blocked

    instance = str(match.get("instance") or "")
    if not instance:
        ledgerlib.note("rename", chat_id, deterministic=True, note="no desktop instance holds this chat")
        return out(
            {"renamed": False,
             "report": "REFUSED (deterministic): no desktop instance holds this chat - land it first"},
            as_json, 3,
        )

    result, err_code = _attempt_rename(instance, old_title, new_title, chat_id, as_json)
    if result is None:
        return err_code

    return _verify_and_report(match, chat_id, old_title, new_title, result, as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
