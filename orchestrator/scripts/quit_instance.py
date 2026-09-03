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


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    confirm = "--confirm-external" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        print(f"quit FAILED: {err}", file=sys.stderr)
        return 1
    target = resolve_instance(fleet, args[0])
    if target is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        print(f"REFUSED (deterministic): no instance matches {args[0]!r}. Known: {known}", file=sys.stderr)
        return 3
    if not target.get("isRunning"):
        print(f"nothing to do: {target.get('name')} is not running")
        return 0

    # Never orphan a working chat: any live writer in this instance refuses the quit.
    if not force:
        writers = []
        try:
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
        except hydralib.DaemonError as err:
            print(f"REFUSED: could not check for live writers before quitting ({err}). "
                  "--force overrides if you know the instance is idle.", file=sys.stderr)
            return 2
        if writers:
            names = "; ".join(str(w) for w in writers[:5])
            print(
                f"REFUSED: {target.get('name')} has {len(writers)} chat(s) with LIVE writers "
                f"({names}). Quitting now would orphan them mid-work. --force overrides.",
                file=sys.stderr,
            )
            return 2

    body = {"confirmExternal": True} if confirm else {}
    try:
        result = hydralib.api_post(
            f"/api/instances/{urllib.parse.quote(str(target.get('dir')), safe='')}/quit", body
        )
    except hydralib.DaemonError as err:
        print(f"quit FAILED: {err}", file=sys.stderr)
        return 1
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
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
