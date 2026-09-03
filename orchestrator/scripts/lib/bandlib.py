"""bandlib - one answer to "may this account take MORE work right now?", for every lane.

WHY THIS EXISTS (owner, 2026-09-01: "one of my accounts hit 100% on the 5 hour - thought you
had rules against that"). The usage bands were real and correct, and they were consulted in
exactly ONE place: saturate's wake planner. Every other route into an account - the courier's
staged replies, the overlord's re-arm, sweep's batches - delivered without ever asking. So an
account could be fed to 100% by a lane that had never heard of the policy, which is precisely
what happened: six chats woke on one account and burned its 5-hour window flat.

A policy enforced at one door is not enforced. This is the door, and it is shared:

  band_of_instance()   {instance name -> band}, from the same survey balance.py reads
  may_take_work()      the one predicate: bands 'over-soft'/'over-hard' may not take MORE
  per_account_share()  the spread rule as a NUMBER - how many running chats one account may
                       hold before the machine is hogging rather than balancing

⛔ THIS NEVER STOPS A TURN THAT IS ALREADY RUNNING. A chat mid-work on a hot account keeps its
turn (interrupting is forbidden, and a half-finished turn is the most expensive thing on the
machine). What the band gate stops is ADDING - the only lever that is both honest and ours.

THE SNAPSHOT RULE: a survey is the slow read in this toolbox, so every caller takes ONE per
run and passes it down (the same shape holdlib/ledgerlib snapshots use). snapshot() gets it;
the module never caches across runs, because a stale usage number is exactly the thing that
would let a cooked account look fine.
"""

from __future__ import annotations

import math

# The bands that mean "no more work here". 'unknown' is deliberately NOT one of them: an
# unread account is handled by balance's own usable/fresh rules, and refusing every unmeasured
# account would stall the fleet on a survey hiccup.
CLOSED_BANDS = ("over-soft", "over-hard")


def snapshot() -> dict:
    """One usage read, shaped for the lanes. Never raises on a survey failure - an empty
    snapshot means 'no band known', which every caller treats as 'not blocked'."""
    import balance
    from lib import hydralib

    try:
        survey, source = balance.usage_rows_with_fallback()
        accounts = balance.accounts_overview(survey, hydralib.fleet())
    except Exception:  # a usage read is advisory; a broken one must not stop the fleet
        return {"bands": {}, "accounts": [], "source": "unavailable"}
    bands: dict[str, str] = {}
    for a in accounts:
        for i in a.get("instances", []):
            bands[str(i.get("name"))] = a.get("band") or "unknown"
    return {"bands": bands, "accounts": accounts, "source": source}


def band_of(instance: str | None, snap: dict | None) -> str:
    if not instance or not snap:
        return "unknown"
    return snap.get("bands", {}).get(str(instance), "unknown")


def may_take_work(instance: str | None, snap: dict | None) -> tuple[bool, str]:
    """(ok, why_not) - the one predicate every lane calls before ADDING work to an account."""
    band = band_of(instance, snap)
    if band == "over-hard":
        return False, (f"account '{instance}' is past the HARD gate ({band}) - it takes no new "
                       "work at all; its chats belong on another account")
    if band == "over-soft":
        return False, (f"account '{instance}' is over the 85% soft target ({band}) - no new "
                       "work until it cools or the chat moves")
    return True, ""


def per_account_share(open_accounts: int, floor: int) -> int:
    """How many RUNNING chats one account may hold - the spread rule as a number.

    THE HOG THIS PREVENTS (measured 2026-09-01): 11 chats running, SIX on one account, and
    that account then hit 100% on its 5-hour window while four other accounts sat near zero.
    Round-robin fixed the ORDER work is handed out in; it did nothing about an account that
    had already accumulated a pile. This is the ceiling that does.

    An even split of the floor, never below 2 (a 1-chat ceiling would make the machine
    thrash) and never above 5 (past that one account is carrying the room again).
    """
    if open_accounts <= 0:
        return 2
    return max(2, min(5, math.ceil(floor / open_accounts)))
