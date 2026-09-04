#!/usr/bin/env python3
"""saturate.py - ACT: keep the machine FULL. 18 is a FLOOR, not just a ceiling.

THE CORRECTION (owner, 2026-09-01): "I said we can have up to 18 active chats. I kinda meant
- if there are 18 available chats or more, there should ALWAYS be 18 running. Currently the
AI seems entirely stuck managing one account when there's many." Measured that moment: 11
running, SIX of them on one account, seven chats sitting dormant with room for seven more.

So the cap became a target. This lane computes the DEFICIT (the floor minus what is running)
and fills it - fairly:

  ROUND-ROBIN BY ACCOUNT. Candidates are drawn from the account with the FEWEST running
  chats first, one per account before any account gets a second, so a busy account can never
  hog the machine while others idle. Accounts over the usage soft target are skipped (the
  bands still rule; a full machine on a cooked account is not progress).

  ONLY CHATS THAT CAN HONESTLY BE WOKEN. A dormant chat qualifies when it is not held, not
  breaker-suppressed, has no live writer, and its own last words either OFFER TO CARRY ON or
  show it died mid-work. That is the owner's own standing pattern - a chat that offered to
  continue gets told to continue, and recap recommendations are "one of my most productive
  ways to fix things" - so the wake prompt is exactly that word and nothing invented. A chat
  whose recap says DONE is never woken (that one archives); nor is one a person must answer.

  ALREADY-DECIDED WORK GOES FIRST. A dormant chat with a reply already staged is woken by
  DELIVERING that reply through the courier's rails, never by a generic nudge.

Usage: python saturate.py [--json]            # the deficit and the wake plan (acts on nothing)
       python saturate.py --yes [--max N]     # fill the deficit (default: up to the floor)
Exit:  0 already full, or every wake landed - 2 some wakes did not land (each named) -
       1 daemon failure.
"""

from __future__ import annotations

import json
import sys

from lib import armlib, clilib
from lib import bandlib
from lib import clilib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib

# The owner's standing word for a chat that offered to carry on. Never invented work - it is
# the continuation the chat itself proposed.
WAKE_PROMPT = (
    "Proceed with your recommendations - continue the work you proposed at the end of your "
    "last turn. If something in it genuinely needs the owner (spend, live customers, public "
    "exposure, another person's lane), do the rest and name that one thing in your recap."
)


def wake_reason(row: dict, staged_by_session: dict) -> tuple[str | None, dict | None]:
    """Can this DORMANT chat honestly be woken, and why? (reason, staged entry) or (None, None).

    THE ONE DEFINITION, shared. saturate asks it to fill the floor and the groundskeeper asks
    it to decide which stranded chats are worth EVACUATING off a cooked account (moving a chat
    that has nothing to do would just be shuffling). Two copies of this test would drift, and
    the difference between them would be chats that quietly never run again.

    A chat qualifies when a reply is already staged for it, when its own last words offer to
    carry on, or when it died mid-work. A recap that says DONE is an archive candidate, never
    a wake candidate; a chat waiting on a person is neither.
    """
    sid = row.get("session_id") or ""
    staged = staged_by_session.get(sid)
    if staged:
        return "a reply is already staged for it", staged
    verdict = gatelib.gate(sid, row.get("transcript_path") or "", None)
    if not verdict:
        return None, None
    fin = verdict.get("finished") or {}
    if verdict["state"] == "finished" and fin.get("lane") == "needs-input-review":
        return "its last words offer to carry on", None
    if verdict["state"] == "crashed":
        return f"it died mid-work ({(verdict.get('crashed') or {}).get('kind')}) - resumable", None
    return None, None


def build_plan(max_wakes: int | None = None) -> dict:
    """The deficit, and which dormant chats would be woken to fill it - round-robin by
    account, already-staged work first. Touches nothing."""
    from lib import deliverylib

    live, per_instance = hydralib.running_by_instance()
    running = len(live)
    floor = hydralib.MAX_RUNNING_CHATS
    deficit = max(0, floor - running)

    # The usage bands decide which accounts may take MORE work at all - the same shared door
    # the courier now uses, so a chat cannot be waved through by one lane and refused by
    # another (bandlib's docstring: a policy enforced at one door is not enforced).
    bands = bandlib.snapshot()
    open_accounts = len({str(i.get("name")) for i in hydralib.fleet().get("instances", [])
                         if i.get("isRunning")})
    share = bandlib.per_account_share(open_accounts, floor)

    staged_by_session = {e["session"]: e for e in deliverylib.pending()}
    holds = holdlib._load()
    ledger_rows = ledgerlib._load()
    # THE MANAGERS ARE THE WATCHDOG'S TO WAKE (2026-09-04): a spare manager's recap always
    # "offers to carry on", so this lane woke retired managers whenever a slot freed, each ran
    # /orchestrate and armed its own loop, and the owner saw an orchestrator per account.
    # overlord.py wakes the ONE overlord (cap-exempt, whenever work waits); no other manager
    # is ever woken by a lane.
    import overlord

    protected = overlord.protected_session_ids()
    managers_skipped = 0

    candidates: list[dict] = []
    stranded: dict[str, int] = {}  # dormant chats sitting on an account that may take no work
    for row in hydralib.visible_chats():
        sid = row.get("session_id") or ""
        inst = row.get("instance")
        if not sid or not inst or row.get("archived") or sid in live:
            continue
        if sid in protected:
            managers_skipped += 1
            continue
        if holdlib.why_blocked(sid, _holds=holds):
            continue
        if ledgerlib.check("deliver", sid, _rows=ledger_rows)["suppressed"]:
            continue
        band = bandlib.band_of(inst, bands)
        if band in bandlib.CLOSED_BANDS:
            # The bands still rule: never fill a cooked account. But COUNT these rather than
            # dropping them silently - a chat stranded on a hot account is not "nothing to do",
            # it is work that needs MOVING, and the groundskeeper's evacuation lane reads this
            # same shape. Reported in the shortfall line so the floor never lies about why.
            stranded[str(inst)] = stranded.get(str(inst), 0) + 1
            continue
        why, staged = wake_reason(row, staged_by_session)
        if not why:
            continue
        candidates.append({
            "sessionId": sid, "title": row.get("title"), "instance": inst,
            "band": band, "staged": bool(staged),
            "deliveryId": (staged or {}).get("id"),
            "why": why,
            "transcript": row.get("transcript_path") or "",  # execute derives the verify text
            "runningOnThisAccount": per_instance.get(str(inst), 0),
        })

    # ROUND-ROBIN: fewest-running account first, staged work ahead of generic wakes, and one
    # pick per account before any account gets a second (the anti-hog rule).
    by_inst: dict[str, list[dict]] = {}
    for c in sorted(candidates, key=lambda c: (not c["staged"], str(c["title"] or ""))):
        by_inst.setdefault(str(c["instance"]), []).append(c)
    order = sorted(by_inst, key=lambda i: (per_instance.get(i, 0), i))
    planned: list[dict] = []
    # THE PER-ACCOUNT CEILING (bandlib.per_account_share): round-robin fixed the ORDER work is
    # handed out in, but an account that had already piled up six chats kept them. This is the
    # ceiling that stops the pile forming, counted forward as the plan is built.
    would_run = dict(per_instance)
    limit = deficit if max_wakes is None else min(deficit, max_wakes)
    capped: dict[str, int] = {}
    while len(planned) < limit and any(by_inst.values()):
        progressed = False
        for inst in order:
            if len(planned) >= limit:
                break
            pool = by_inst.get(inst) or []
            if not pool:
                continue
            if would_run.get(inst, 0) >= share:
                capped[inst] = len(pool)
                by_inst[inst] = []  # its share is spent this pass; the rest wait
                continue
            planned.append(pool.pop(0))
            would_run[inst] = would_run.get(inst, 0) + 1
            progressed = True
        if not progressed:
            break

    return {
        "running": running, "floor": floor, "deficit": deficit,
        "runningPerInstance": per_instance,
        "perAccountShare": share,
        "candidates": len(candidates),
        "planned": planned,
        "strandedOnHotAccounts": stranded,
        "managersLeftToTheWatchdog": managers_skipped,
        "heldBackByShare": capped,
        "shortfall": max(0, deficit - len(planned)),
    }


def execute(plan: dict) -> list[dict]:
    import courier
    from lib import deliverylib

    results = []
    for row in plan["planned"]:
        sid = row["sessionId"]
        # ⛔ ONE CRASHING CANDIDATE MUST NOT STOP THE SWEEP (review 2026-09-01). Any of the
        # calls below (courier, deliverylib, overlord's recent-delivery read) can raise on a
        # candidate with something wrong with it - a missing delivery id, a daemon hiccup - and
        # an unhandled exception used to kill the whole loop, leaving every candidate AFTER the
        # bad one un-attempted. Record the crash as its own failed row and move on to the rest
        # of the plan.
        try:
            if row["staged"]:
                code, out = clilib.capture(courier.main, ["--yes", "--only", row["deliveryId"]])
            else:
                # NOT TWICE IN ONE WINDOW (review 2026-09-01): the overlord lane stages its own
                # wake from its own read of the fleet on the same tick; a delivery that just
                # landed IS this chat's wake, and a row already staged is reused, never doubled.
                import overlord

                recent = deliverylib.recent_delivery(sid, overlord.RECENT_DELIVERY_SECS)
                if recent:
                    results.append({**row, "exit": 0, "ok": True, "outcome": "already woken",
                                    "detail": (f"delivery {recent['id']} by {recent.get('by')} "
                                               "landed within the last "
                                               f"{overlord.RECENT_DELIVERY_SECS}s - not sending "
                                               "a second wake")})
                    continue
                # THE VERIFY TEXT IS THE CHAT'S OWN LAST WORDS (review 2026-09-01). This shipped
                # "x" - one character - under a comment claiming the daemon derives a
                # render-true snippet; it derives one only when the field is EMPTY, so every
                # saturate wake carried a wrong-chat guard that matched any pane (three such
                # rows found live, one "typed, but the transcript did not grow"). Same
                # derivation the overlord uses: the transcript tail, and a refusal when nothing
                # distinctive is in it - a blind wake into the wrong pane costs more than a chat
                # woken a cycle later.
                tail = deliverylib.transcript_tail_text(row.get("transcript") or "")
                verify = deliverylib._verify_snippet(tail)
                if not verify:
                    results.append({**row, "exit": 4, "ok": False, "outcome": "did NOT wake",
                                    "detail": ("no verify snippet could be derived from the "
                                               "chat's own last words - refusing to stage a "
                                               "blind wake")})
                    continue
                entry = deliverylib.stage(
                    sid, WAKE_PROMPT, title=row.get("title") or "",
                    instance=row.get("instance") or "", by="saturate",
                    evidence=tail[-600:], verify_text=verify, dedupe=True,
                )
                code, out = clilib.capture(courier.main, ["--yes", "--only", entry["id"]])
            results.append({**row, "exit": code, "ok": code == 0,
                            "outcome": "woken" if code == 0 else "did NOT wake",
                            "detail": (out.splitlines()[-1][:160] if out else "")})
        except Exception as err:
            results.append({**row, "exit": 1, "ok": False,
                            "outcome": f"crashed: {err}", "detail": ""})
    return results


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so.
    if act:
        refusal = armlib.refuse_unless_armed(argv, "waking dormant chats")
        if refusal:
            print(refusal)
            act = False
    cap = None
    if "--max" in argv:
        cap = int(argv[argv.index("--max") + 1])

    try:
        plan = build_plan(cap)
    except hydralib.DaemonError as err:
        print(f"saturate FAILED: {err}", file=sys.stderr)
        return 1

    results = execute(plan) if (act and plan["planned"]) else []
    if as_json:
        print(json.dumps({**plan, "results": results}, indent=2))
    else:
        print(f"{plan['running']} running of a floor of {plan['floor']} "
              f"(deficit {plan['deficit']}) - per account: {plan['runningPerInstance']}")
        if not plan["deficit"]:
            print("the machine is FULL - nothing to wake.")
        for r in (results or plan["planned"]):
            mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
            print(f"  {mark}[{r['instance']}] {r['title']}: {r['why']}"
                  + (f" -> {r.get('outcome')}" if results else ""))
        if plan["shortfall"]:
            print(f"\n{plan['shortfall']} slot(s) still unfilled. Why, exactly:")
            if plan["strandedOnHotAccounts"]:
                print(f"  - {sum(plan['strandedOnHotAccounts'].values())} dormant chat(s) sit on "
                      f"an account that may take NO new work {plan['strandedOnHotAccounts']} - "
                      "they need MOVING, not waking (the groundskeeper's evacuation lane).")
            if plan["heldBackByShare"]:
                print(f"  - {sum(plan['heldBackByShare'].values())} more would all land on "
                      f"account(s) already at their share of {plan['perAccountShare']} "
                      f"{plan['heldBackByShare']} - spreading beats filling.")
            print("  - the rest: held, genuinely done, or waiting on a person.")
        if not act and plan["planned"]:
            print("\nPLAN ONLY - nothing woken. Add --yes to fill the floor.")
    failed = [r for r in results if not r["ok"]]
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
