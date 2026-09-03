#!/usr/bin/env python3
"""quit_instance.py - ACT: stop ONE desktop instance.

The daemon refuses to quit the DEFAULT profile without confirmation, because that one is the
person's own app rather than a fleet worker; --confirm-external passes that confirmation
through deliberately. Quitting an instance whose chats have live writers is refused here
unless --force: stopping the app under a working chat is how work gets orphaned.

Usage: python quit_instance.py <num|name|dir> [--confirm-external] [--force] [--json]
Exit:  0 quit - 2 refused (live writers) - 3 no such instance (deterministic) - 1 failure.
"""

from __future__ import annotations

import json
import sys
import urllib.parse

from lib import clilib, hydralib
from lib.hydralib import resolve_instance


def _parse_flags(argv: list[str]) -> tuple[bool, bool, bool, list[str]]:
    """Split argv into (as_json, force, confirm, positional args)."""
    as_json = "--json" in argv
    force = "--force" in argv
    confirm = "--confirm-external" in argv
    args = [a for a in argv if not a.startswith("--")]
    return as_json, force, confirm, args


def _load_target(arg: str) -> tuple[dict | None, str | None, int]:
    """Load the fleet and resolve `arg` to an instance. Returns (target, error, exit_code)."""
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        return None, f"quit FAILED: {err}", 1
    target = resolve_instance(fleet, arg)
    if target is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        return None, f"REFUSED (deterministic): no instance matches {arg!r}. Known: {known}", 3
    return target, None, 0


def _live_writer_titles(target: dict) -> list[str]:
    """Titles of chats belonging to `target` that have a live writer right now."""
    writers = []
    for row in hydralib.sessions():
        if row.get("archived") or str(row.get("instance", "")).lower() != str(
            target.get("name", "")
        ).lower():
            continue
        # ANY live match for this chat's query counts. The dossier already resolved
        # identity (lineage, prior session ids after a compaction roll); demanding an
        # exact cliSessionId match here silently missed writers whose id had rotated,
        # which is precisely the chat a quit would orphan (review finding, 2026-08-31).
        for m in hydralib.dossier(row.get("session_id") or ""):
            if m.get("live"):
                writers.append(row.get("title"))
                break
    return writers


def _refusal_for_live_writers(target: dict, force: bool) -> str | None:
    """Refusal message if quitting `target` would orphan a live writer, else None.

    Never orphan a working chat: any live writer in this instance refuses the quit,
    unless the caller passed --force.
    """
    if force:
        return None
    try:
        writers = _live_writer_titles(target)
    except hydralib.DaemonError as err:
        return (f"REFUSED: could not check for live writers before quitting ({err}). "
                "--force overrides if you know the instance is idle.")
    if not writers:
        return None
    names = "; ".join(str(w) for w in writers[:5])
    return (
        f"REFUSED: {target.get('name')} has {len(writers)} chat(s) with LIVE writers "
        f"({names}). Quitting now would orphan them mid-work. --force overrides."
    )


def _quit_via_daemon(target: dict, confirm: bool) -> tuple[object, str | None]:
    """POST the quit request to the daemon. Returns (result, error_message)."""
    body = {"confirmExternal": True} if confirm else {}
    try:
        result = hydralib.api_post(
            f"/api/instances/{urllib.parse.quote(str(target.get('dir')), safe='')}/quit", body
        )
    except hydralib.DaemonError as err:
        return None, f"quit FAILED: {err}"
    return result, None


def _report_quit_result(result: object, target: dict, confirm: bool, as_json: bool) -> bool:
    """Print the quit outcome in the requested format. Returns whether it succeeded."""
    ok = isinstance(result, dict) and result.get("ok")
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        msg = result.get("message") if isinstance(result, dict) else result
        print(f"{'quit' if ok else 'quit REFUSED by daemon'}: {target.get('name')} - {msg}")
        if not ok and not confirm:
            # The daemon's refusal wording says 'regular (non-isolated)', not 'default' - so
            # hint whenever a refusal came back without the confirmation flag, rather than
            # string-matching a message that never contains the word we looked for.
            print("(if this is the regular non-isolated profile - the person's own app - the "
                  "daemon requires --confirm-external)")
    return bool(ok)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json, force, confirm, args = _parse_flags(argv)
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    target, err_msg, err_code = _load_target(args[0])
    if err_msg is not None:
        print(err_msg, file=sys.stderr)
        return err_code
    if not target.get("isRunning"):
        print(f"nothing to do: {target.get('name')} is not running")
        return 0

    refusal = _refusal_for_live_writers(target, force)
    if refusal is not None:
        print(refusal, file=sys.stderr)
        return 2

    result, err_msg = _quit_via_daemon(target, confirm)
    if err_msg is not None:
        print(err_msg, file=sys.stderr)
        return 1

    ok = _report_quit_result(result, target, confirm, as_json)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
