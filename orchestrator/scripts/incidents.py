#!/usr/bin/env python3
"""incidents.py - OBSERVE (+ --ack/--resolve) the incident ledger: grouped, deduplicated failures.

lib/incidentlib.py groups every failure ledgerlib and sweep.py record by its normalized cause,
so the same daemon blip failing four chats - or one chat failing the same way four times - shows
up as ONE incident here instead of four anonymous rows in the attempt ledger (state/attempts.json).
Loud by default (README rule 6): this is where "what does the machinery keep hitting, and how
many times" gets answered, without opening every act script's own state file by hand.

Usage: python incidents.py [--all] [--json]
       python incidents.py --ack <incident-id>       (seen it: stop it re-alerting on repeats)
       python incidents.py --resolve <incident-id>    (the cause is fixed; a NEW error mints a
                                                        new id - resolving does not silence a
                                                        future DIFFERENT failure on the same chat)
Exit:  0 ok - 3 bad usage or unknown incident id.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, incidentlib

# Incidents in these states are still "live" for the default (non --all) view - a resolved
# incident is done and only shows up when you deliberately ask to see everything.
_LIVE_STATES = ("open", "acked")


def _print_row(r: dict) -> None:
    when = str(r.get("last_seen_at", ""))
    print(f"  {r.get('id'):<28} [{r.get('state'):<8}] x{r.get('count', 1):<3} "
          f"{r.get('failure_type', 'unknown'):<10} {r.get('scope', '')}/{r.get('key', '')}  "
          f"(last seen {when})")
    print(f"      {str(r.get('error', ''))[:160]}")


def _ack_or_resolve(argv: list[str]) -> int:
    flag = "--ack" if "--ack" in argv else "--resolve"
    rest = [a for a in argv if not a.startswith("--")]
    if len(rest) != 1:
        print(f"usage: incidents.py {flag} <incident-id>", file=sys.stderr)
        return 3
    incident_id = rest[0]
    if incidentlib.get_incident(incident_id) is None:
        print(f"no such incident: {incident_id!r}", file=sys.stderr)
        return 3
    verb = "acked" if flag == "--ack" else "resolved"
    ok = incidentlib.ack_incident(incident_id) if flag == "--ack" else incidentlib.resolve_incident(incident_id)
    print(f"{verb}: {incident_id}" if ok else
          f"{incident_id} was already {verb} (or past it) - nothing changed")
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv

    if "--ack" in argv or "--resolve" in argv:
        return _ack_or_resolve(argv)

    rows = incidentlib.list_incidents()  # every state, newest-activity first
    show_all = "--all" in argv
    shown = rows if show_all else [r for r in rows if r.get("state") in _LIVE_STATES]

    if as_json:
        print(json.dumps({"incidents": shown}, indent=2))
        return 0
    if not shown:
        print("no open incidents - nothing the machinery keeps hitting right now"
              if not show_all else "the incident ledger is empty")
        return 0
    print(f"{len(shown)} incident(s){'' if show_all else ' open/acked'} "
          f"(of {len(rows)} total):")
    for r in shown:
        _print_row(r)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
