#!/usr/bin/env python3
"""hold_chat.py - ACT (state only): mark a chat hands-off for the unattended machinery.

A hold is the owner's "I am working this one, leave it alone" switch. It outranks every gate
verdict and the breaker, demands a reason, keeps the chat visible everywhere, and never
blocks a deed a person asks for directly (act scripts still obey --force).

Usage: python hold_chat.py <title fragment | session id> --reason "why" [--hours N] [--json]
       python hold_chat.py <title fragment | session id> --release [--json]
       python hold_chat.py --list [--json]
Exit:  0 done - 3 not resolvable (deterministic) or bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import clilib, holdlib
from lib import hydralib


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    do_list = "--list" in argv
    do_release = "--release" in argv
    reason = None
    hours = None
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--reason" and i + 1 < len(argv):
            reason = argv[i + 1]
            i += 2
            continue
        if a == "--hours" and i + 1 < len(argv):
            hours = float(argv[i + 1])
            i += 2
            continue
        if not a.startswith("--"):
            args.append(a)
        i += 1

    if do_list:
        rows = holdlib.held()
        if as_json:
            print(json.dumps({"holds": rows}, indent=2))
        elif not rows:
            print("no chat is held - the machinery may act on anything its gate allows")
        else:
            print(f"{len(rows)} chat(s) HELD (the unattended machinery leaves these alone):")
            for r in rows:
                print(f"  {r['session']}")
                print(f"    {holdlib.why_blocked(r['session'])}")
        return 0

    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        match = hydralib.resolve_one(args[0])
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"REFUSED (deterministic): {err}", file=sys.stderr)
        return 3
    except hydralib.DaemonError as err:
        print(f"hold FAILED: {err}", file=sys.stderr)
        return 1
    sid = match.get("cliSessionId") or ""
    title = match.get("title")

    if do_release:
        was = holdlib.release(sid)
        msg = (f"released: '{title}' is back under the machinery's care"
               if was else f"nothing to do: '{title}' was not held")
        print(json.dumps({"released": was, "sessionId": sid, "report": msg}, indent=2) if as_json else msg)
        return 0

    if not reason:
        print("a hold DEMANDS a reason: --reason \"why this chat is hands-off\"", file=sys.stderr)
        return 3
    until = int((time.time() + hours * 3600) * 1000) if hours else None
    entry = holdlib.hold(sid, reason, until_ms=until)
    msg = f"HELD: '{title}' - {holdlib.why_blocked(sid)}"
    print(json.dumps({"held": True, "entry": entry, "report": msg}, indent=2) if as_json else msg)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
