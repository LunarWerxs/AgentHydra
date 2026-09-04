#!/usr/bin/env python3
"""mutations.py - OBSERVE the mutation ledger: every before/after record of an act this
orchestrator performed on a Desktop chat, newest first, each marked whether `undo.py` can
reverse it.

This is the read side only - it never acts and never mutates the ledger itself (that is
mutationlib.record(), called by the acting scripts as they run). Pair it with `undo.py <id>`
to reverse one entry.

Usage: python mutations.py [--session ID] [--kind KIND] [--json]
       python mutations.py --get <id> [--json]
Exit:  0 ok - 3 bad usage (unknown --kind, or --get with no id / an id that is not on the ledger).
"""

from __future__ import annotations

import json
import sys

from lib import clilib, mutationlib


def _render_row(r: dict) -> str:
    flag = "undoable" if r.get("undoable") else f"NOT undoable ({r.get('whyNot') or 'no reason recorded'})"
    undone = f"  [undone by {r.get('undoneBy')}]" if r.get("undoneAt") else ""
    return (f"  {r['id']}  {r.get('kind'):<9} {r.get('title') or r.get('session')}"
            f"  ({flag}){undone}")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv

    if "--get" in argv:
        rest = [a for a in argv if not a.startswith("--")]
        if len(rest) != 1:
            print("usage: mutations.py --get <mutation-id>", file=sys.stderr)
            return 3
        row = mutationlib.get(rest[0])
        if row is None:
            print(f"no mutation {rest[0]!r} on the ledger", file=sys.stderr)
            return 3
        print(json.dumps(row, indent=2))
        return 0

    session_id = None
    kind = None
    args = list(argv)
    if "--session" in args:
        i = args.index("--session")
        if i + 1 >= len(args):
            print("usage: mutations.py [--session ID] [--kind KIND] [--json]", file=sys.stderr)
            return 3
        session_id = args[i + 1]
    if "--kind" in args:
        i = args.index("--kind")
        if i + 1 >= len(args):
            print("usage: mutations.py [--session ID] [--kind KIND] [--json]", file=sys.stderr)
            return 3
        kind = args[i + 1]
        if kind not in mutationlib.MUTATION_KINDS:
            print(f"unknown --kind {kind!r}. Known: {', '.join(mutationlib.MUTATION_KINDS)}",
                  file=sys.stderr)
            return 3

    rows = mutationlib.list_mutations(session_id=session_id, kind=kind)
    if as_json:
        print(json.dumps({"mutations": rows}, indent=2))
        return 0
    if not rows:
        print("no mutations on the ledger" + (f" for {session_id}" if session_id else ""))
        return 0
    print(f"{len(rows)} mutation(s), newest first:")
    for r in rows:
        print(_render_row(r))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
