#!/usr/bin/env python3
"""list_instances.py - OBSERVE ONLY: every instance, open or not, with account and usage.

Usage: python list_instances.py [--open] [--json]
Exit:  0 ok - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, hydralib


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    only_open = "--open" in argv
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        print(f"fleet read FAILED: {err}", file=sys.stderr)
        return 1
    rows = fleet.get("instances", [])
    if only_open:
        rows = [i for i in rows if i.get("isRunning")]
    if as_json:
        print(json.dumps(rows, indent=2))
        return 0
    for i in rows:
        acct = i.get("account") or {}
        usage = i.get("usage") or {}
        run = "OPEN  " if i.get("isRunning") else "closed"
        weekly = usage.get("weeklyPct")
        # Every field defaulted: one half-registered row (num/name None) must not crash the
        # listing and take the healthy rows down with it.
        print(
            f"#{str(i.get('num') if i.get('num') is not None else '?'):<3} {run} "
            f"{str(i.get('name') or '(unnamed)'):<16} "
            f"{acct.get('planLabel') or 'plan?':<10} "
            f"weekly {weekly if weekly is not None else '-'}%  "
            f"{'signed-in' if i.get('signedIn') else 'SIGNED OUT'}  {i.get('dir')}"
        )
    print(f"\n{sum(1 for i in rows if i.get('isRunning'))} open of {len(rows)} listed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
