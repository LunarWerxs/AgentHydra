#!/usr/bin/env python3
"""attempts.py - OBSERVE the attempt ledger; clear an entry only on a person's say-so.

Every suppression is LOUD: this is where the machinery reports which acts it is holding back,
how many attempts each has seen, and when the window frees up. A silent brake would be the
false quiet this repo treats as its worst failure mode.

Usage: python attempts.py [--all] [--json]
       python attempts.py --clear <kind> <session-or-chat-id>   (a person's word: forget the history)
Exit:  0 ok - 3 bad usage.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, ledgerlib


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    if "--clear" in argv:
        rest = [a for a in argv if not a.startswith("--")]
        if len(rest) != 2:
            print("usage: attempts.py --clear <kind> <session-or-chat-id>", file=sys.stderr)
            return 3
        kind, sid = rest
        ledgerlib.clear(kind, sid)
        print(f"cleared: {kind} attempts for {sid}")
        return 0

    rows = ledgerlib.suppressed()
    if "--all" in argv:
        raw = ledgerlib._load()  # the whole ledger, deliberately - this CLI is its one reader
        if as_json:
            print(json.dumps({"suppressed": rows, "attempts": raw}, indent=2))
            return 0
        print(f"{len(raw)} attempt(s) on the ledger (window {ledgerlib.ATTEMPT_WINDOW_MS // 3600_000}h, cap {ledgerlib.ATTEMPT_CAP}):")
        for r in raw:
            det = " DETERMINISTIC" if r.get("deterministic") else ""
            print(f"  {r.get('kind'):<8} {r.get('session')}  at={r.get('at')}{det}  {r.get('note') or ''}")
        print()
    if as_json and "--all" not in argv:
        print(json.dumps({"suppressed": rows}, indent=2))
        return 0
    if not rows:
        print("nothing is suppressed - no act is being held back by the breaker right now")
        return 0
    print(f"{len(rows)} (kind, chat) pair(s) HELD BACK by the breaker:")
    for r in rows:
        print(f"  {r['kind']:<8} {r['session']}")
        print(f"           {r['why']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
