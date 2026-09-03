#!/usr/bin/env python3
"""dossier.py - OBSERVE ONLY: everything the daemon knows about ONE chat.

"What happened to chat X" is one query (GET /api/chats/dossier?q=) - instance, archive flag,
done-mark, lineage, live process. This is the look-before-you-act every act script performs;
running it by hand first is how a person checks what automation would see.

Usage: python dossier.py <title fragment | session id> [--json]
Exit:  0 exactly one match - 3 none or many (deterministic - retrying cannot help) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, hydralib


def render(m: dict) -> str:
    live = m.get("live")
    L = [
        f"title      {m.get('title')}",
        f"instance   {m.get('instance')}",
        f"chatId     {m.get('chatId')}",
        f"cliSession {m.get('cliSessionId')}",
        f"archived   {m.get('archived')}",
        f"doneMark   {m.get('doneMark')}",
        f"activity   {m.get('lastActivityAt')}",
        (
            f"live       pid {live.get('pid')} ({live.get('name')}) since {live.get('startedAt')}"
            if live
            else "live       no - no process is writing this chat"
        ),
        f"lineage    {' -> '.join(m.get('lineageIds') or [])}",
    ]
    return "\n".join(L)


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
    query = args[0]
    try:
        matches = hydralib.dossier(query)
    except hydralib.DaemonError as err:
        print(f"dossier FAILED: {err}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps({"query": query, "matches": matches}, indent=2))
    else:
        if not matches:
            print(f"no chat matches {query!r}")
        for i, m in enumerate(matches):
            if i:
                print("-" * 60)
            print(render(m))
    if len(matches) == 1:
        return 0
    # A migration leaves the source row ARCHIVED under the same cli session id: two records,
    # one lineage, one live copy. hydralib.resolve_one picks the un-archived one, so the act
    # scripts do NOT refuse it - the old sentence said they would (live smoke, 2026-09-01).
    live_copies = [m for m in matches if not m.get("archived")]
    one_lineage = len({m.get("cliSessionId") for m in matches}) == 1
    if len(matches) > 1 and one_lineage and len(live_copies) == 1:
        if not as_json:
            print(f"\n{len(matches)} records, one lineage: the archived one is the twin a migration "
                  f"left behind; act scripts resolve this query to {live_copies[0].get('instance')}.")
        return 0
    if not as_json and len(matches) > 1:
        print(f"\n{len(matches)} chats match - act scripts will refuse this query as ambiguous.")
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
