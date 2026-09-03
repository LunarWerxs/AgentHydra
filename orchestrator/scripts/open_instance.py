#!/usr/bin/env python3
"""open_instance.py - ACT: start ONE desktop instance (idempotent - 'already running' is fine).

Usage: python open_instance.py <num|name|dir> [--json]
Exit:  0 running (opened now or already) - 3 no such instance (deterministic) - 1 failure.
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
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        print(f"open FAILED: {err}", file=sys.stderr)
        return 1
    target = resolve_instance(fleet, args[0])
    if target is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        print(f"REFUSED (deterministic): no instance matches {args[0]!r}. Known: {known}", file=sys.stderr)
        return 3
    try:
        result = hydralib.api_post(f"/api/instances/{urllib.parse.quote(str(target.get('dir')), safe='')}/open")
    except hydralib.DaemonError as err:
        print(f"open FAILED: {err}", file=sys.stderr)
        return 1
    ok = isinstance(result, dict) and result.get("ok")
    placed = None
    if ok:
        # A profile last closed maximized reopens FULL SCREEN natively; an app the toolbox
        # brought up is put back to normal size (owner, 2026-09-01: "something full screened
        # one of the accounts again"). Only a window that is maximized right now, right after
        # our own open - a window the owner sizes later is never touched.
        import time

        from lib import windowlib

        for _ in range(12):
            if windowlib.capture(target.get("dir") or target.get("name")):
                break
            time.sleep(2)
        placed = windowlib.unmaximize(target.get("dir") or target.get("name"))
    if as_json:
        print(json.dumps({**(result if isinstance(result, dict) else {"result": result}),
                          "placement": placed}, indent=2))
    else:
        msg = result.get("message") if isinstance(result, dict) else result
        print(f"{'opened' if ok else 'open FAILED'}: {target.get('name')} - {msg}"
              + (f" ({placed})" if placed else ""))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
