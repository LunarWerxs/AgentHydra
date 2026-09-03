#!/usr/bin/env python3
"""census.py - OBSERVE ONLY: what does the fleet look like right now?

The Python port of orchestrate.mjs, kept at exact parity (same fields, same exit codes) so the
two can be diffed against each other until the .mjs is retired. Nothing here touches a chat.

The waiting-on-a-person scan here reads TRUNCATED PREVIEWS and is labeled a lower bound, not an
answer. For the real answer over full transcript tails, run waiting_scan.py - that is the whole
reason it exists as its own script.

Usage: python census.py [--json]
Exit:  0 census plausible - 2 sanity rail tripped - 1 the read itself failed.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, gatelib
from lib import hydralib


def offers_to_continue(text: object) -> bool:
    """A chat's last assistant turn OFFERS TO CARRY ON, so it is waiting to be told to - not
    finished. The single rule v2 lacked. ONE definition, in gatelib - a second copy here
    drifted once already in v2's lineage, which is exactly how the Ghost chat got archived."""
    return gatelib.offers_to_continue(str(text if text is not None else ""))


def census() -> dict:
    health = hydralib.health()
    fleet = hydralib.fleet()
    rows = hydralib.sessions()

    visible = [s for s in rows if not s.get("archived")]
    instances = fleet.get("instances", [])
    open_instances = [i for i in instances if i.get("isRunning")]

    # THE SANITY RAIL (owner law): one or zero open instances means detection is broken, not
    # that the fleet is quiet. A census that starts wrong poisons every decision after it.
    plausible = len(open_instances) >= 2

    waiting = [s for s in visible if offers_to_continue(s.get("last_text_preview"))]

    return {
        "daemon": {
            "url": hydralib.BASE,
            "version": health.get("version"),
            "distribution": health.get("distribution"),
        },
        "sanity": {
            "plausible": plausible,
            "why": (
                f"{len(open_instances)} open instances - a plausible fleet"
                if plausible
                else f"{len(open_instances)} open instance(s) - INVESTIGATE instance detection "
                "before trusting anything below"
            ),
        },
        "instances": {
            "total": len(instances),
            "open": [
                {
                    "num": i.get("num"),
                    "name": i.get("name"),
                    "plan": (i.get("account") or {}).get("planLabel"),
                    "weeklyPct": (i.get("usage") or {}).get("weeklyPct"),
                }
                for i in open_instances
            ],
        },
        "chats": {
            "total": len(rows),
            "visible": len(visible),
            "archived": len(rows) - len(visible),
        },
        # ⛔ A LOWER BOUND, NOT AN ANSWER. Previews are truncated (~140 chars) and the offer to
        # carry on is usually the LAST line of a long recap, so it is normally cut off. A zero
        # here means "nothing found in the previews", never "nothing is waiting". waiting_scan.py
        # reads the real transcript tails.
        "waitingScan": {
            "source": "truncated last_text_preview",
            "complete": False,
            "why": "previews are cut short - run waiting_scan.py for the real answer over transcript tails",
        },
        "waitingOnAPerson": [
            {
                "sessionId": s.get("session_id"),
                "title": s.get("title"),
                "instance": s.get("instance"),
                "preview": str(s.get("last_text_preview") or "")[:160],
            }
            for s in waiting
        ],
    }


def render(c: dict) -> str:
    L: list[str] = []
    L.append(f"daemon    {c['daemon']['version']} ({c['daemon']['distribution']}) at {c['daemon']['url']}")
    L.append(f"sanity    {'OK' if c['sanity']['plausible'] else '** NOT PLAUSIBLE **'} - {c['sanity']['why']}")
    L.append(f"instances {len(c['instances']['open'])} open of {c['instances']['total']}")
    for i in c["instances"]["open"]:
        L.append(
            f"            #{i['num']} {i['name']} - {i['plan'] or 'plan unknown'}, weekly {i['weeklyPct'] if i['weeklyPct'] is not None else '-'}%"
        )
    L.append(
        f"chats     {c['chats']['visible']} visible, {c['chats']['archived']} archived, {c['chats']['total']} total"
    )
    L.append("")
    if not c["waitingOnAPerson"]:
        L.append("No chat is waiting-on-a-person IN THE PREVIEWS - a lower bound, not a clean fleet:")
        L.append("previews are truncated and the offer to carry on is usually the last line of a long")
        L.append("recap. Run waiting_scan.py for the real answer over full transcript tails.")
    else:
        L.append(f"{len(c['waitingOnAPerson'])} chat(s) OFFER TO CARRY ON and are waiting to be told to:")
        for w in c["waitingOnAPerson"]:
            L.append(f"  - [{w['instance']}] {w['title']}")
            L.append(f"      {w['preview']}")
        L.append("")
        L.append("These are NOT finished. Nothing here archives them.")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    try:
        c = census()
    except hydralib.DaemonError as err:
        # A failed read must never print as a clean fleet.
        print(f"census FAILED: {err}", file=sys.stderr)
        print(f"Is the AgentHydra daemon running? Try: curl {hydralib.BASE}/api/health", file=sys.stderr)
        return 1
    print(json.dumps(c, indent=2) if as_json else render(c))
    return 0 if c["sanity"]["plausible"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
