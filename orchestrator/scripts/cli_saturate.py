#!/usr/bin/env python3
"""cli_saturate.py - ACT: keep the CONSOLE fleet full, spread evenly across EVERY account.

THE OWNER'S NEW RULE FOR THE CONSOLE SIDE (2026-09-01: "I'll likely switch to having you load
balance across all available accounts, regardless of if they're open"). On the desktop that was
impossible to honour cleanly - an account had to have its app OPEN to take work, opening one was
a last resort, and so five accounts carried everything. A console account has no window: it is a
config directory with a login. Every logged-in account is available every moment, so the spread
is simply an even division and there is no open/closed dance at all.

WAKING IS ALSO SIMPLER, AND STRICTLY SO. On the desktop, waking a dormant chat means delivering
a message into its composer so the app boots its engine - the delivery IS the revive, with all
the aiming that implies. Here it is one command: a terminal running
`claude --resume <id> "<prompt>"`, which starts the process AND hands it the prompt, with the
permission mode and effort set as launch flags so it can never stop to ask.

WHAT IS UNCHANGED, because it was never a transport problem: only chats whose own last words
invite continuation are woken, holds are hands-off, and a chat whose recap says done is an
archive candidate rather than a wake candidate. That judgment lives in gatelib and is shared
with the desktop lanes, so the two fleets can never disagree about what a chat's state is.

Usage: python cli_saturate.py [--json] [--floor N]        # the deficit and the plan
       python cli_saturate.py --yes [--floor N] [--max N] # fill it
Exit:  0 already full or every wake started - 2 some did not start - 1 read failure.
"""

from __future__ import annotations

import json
import sys

import cli_accounts
import cli_sessions
import cli_spawn
from lib import armlib, clilib
from lib import bandlib
from lib import hydralib
from lib import ledgerlib

WAKE_PROMPT = (
    "Proceed with your recommendations - continue the work you proposed at the end of your "
    "last turn. If something in it genuinely needs the owner (spend, live customers, public "
    "exposure, another person's lane), do the rest and name that one thing in your recap."
)


def build_plan(floor: int | None = None, max_wakes: int | None = None) -> dict:
    floor = floor or hydralib.MAX_RUNNING_CHATS
    rows = cli_sessions.chats(recent_days=14)
    running = [r for r in rows if r["running"]]
    per_account: dict[str, int] = {}
    for r in running:
        per_account[r["account"]] = per_account.get(r["account"], 0) + 1

    ready = [a["name"] for a in cli_accounts.accounts() if a["loggedIn"]]
    for name in ready:
        per_account.setdefault(name, 0)

    # The usage bands are the ONE thing that still says "not this account" - and they are the
    # shared door the desktop lanes use, so a cooked account is cooked for both fleets.
    bands = bandlib.snapshot()
    open_bands = {n: bandlib.band_of(n, bands) for n in ready}
    usable = [n for n in ready if open_bands.get(n) not in bandlib.CLOSED_BANDS]

    deficit = max(0, floor - len(running))
    ledger_rows = ledgerlib._load()
    candidates = []
    no_cwd = []
    for r in rows:
        if r["running"] or r["held"]:
            continue
        if ledgerlib.check("deliver", r["sessionId"], _rows=ledger_rows)["suppressed"]:
            continue
        if r["state"] == "finished" and r["lane"] == "needs-input-review":
            why = "its last words offer to carry on"
        elif r["state"] == "crashed":
            why = "it died mid-work - resumable"
        else:
            continue
        # ⛔ NEVER SPAWN INTO A FABRICATED FOLDER (review 2026-09-01). cli_sessions.chats()
        # reports cwd=None for a dormant chat whose real working directory could not be
        # recovered from its own transcript - passing that through as cli_spawn's --folder
        # would open a terminal in a made-up path (the old fallback was the encoded project
        # directory name, which is usually not a real folder at all). Skip it rather than
        # guess; kept visible in no_cwd so a shrinking plan is never a silent one.
        if not r["cwd"]:
            no_cwd.append({**r, "why": f"{why}, but its real cwd could not be recovered from "
                                        "the transcript - refusing to guess a folder"})
            continue
        candidates.append({**r, "why": why})

    # EVEN SPREAD ACROSS EVERY LOGGED-IN ACCOUNT. A resumed console chat can run on ANY account
    # (the transcript is the chat; the account is just whose quota pays), so the target is
    # simply whichever usable account is carrying the least right now.
    planned = []
    would = dict(per_account)
    limit = deficit if max_wakes is None else min(deficit, max_wakes)
    for cand in candidates:
        if len(planned) >= limit or not usable:
            break
        target = min(usable, key=lambda n: (would.get(n, 0), n))
        would[target] = would.get(target, 0) + 1
        planned.append({**cand, "onAccount": target})

    return {"floor": floor, "running": len(running), "deficit": deficit,
            "perAccount": per_account, "readyAccounts": ready, "usableAccounts": usable,
            "candidates": len(candidates), "planned": planned, "noCwd": no_cwd,
            "shortfall": max(0, deficit - len(planned))}


def execute(plan: dict) -> list[dict]:
    out = []
    for row in plan["planned"]:
        # ⛔ ONE CRASHING CANDIDATE MUST NOT STOP THE SWEEP (review 2026-09-01). cli_spawn.spawn
        # can raise (a bad folder, a daemon read that blows up inside hydralib, anything not
        # already turned into a {"ok": False} return) - and an unhandled exception here used to
        # kill the whole loop, leaving every candidate AFTER the bad one un-attempted and
        # un-noted. Record the crash as a failure row and keep going; noting it is what lets the
        # attempt cap (ledgerlib) eventually retire a candidate that only ever crashes.
        try:
            got = cli_spawn.spawn(folder=row["cwd"], prompt=WAKE_PROMPT,
                                  account=row["onAccount"], model=None,
                                  resume=row["sessionId"])
            ok = bool(got.get("ok"))
            outcome = (f"resumed on {row['onAccount']}" if ok
                       else f"did NOT start: {got.get('why')}")
        except Exception as err:
            ok = False
            outcome = f"crashed: {err}"
        # Note every attempt, win or lose - this is the ONLY "deliver" caller for the console
        # lane, so if this doesn't note, build_plan's ATTEMPT_CAP check (line ~70) is decorative
        # and a chat that always fails to resume gets re-picked and retried forever.
        ledgerlib.note("deliver", row["sessionId"], note=f"cli_saturate: {outcome}")
        out.append({**row, "ok": ok, "outcome": outcome})
    return out


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    floor = int(argv[argv.index("--floor") + 1]) if "--floor" in argv else None
    cap = int(argv[argv.index("--max") + 1]) if "--max" in argv else None

    try:
        plan = build_plan(floor, cap)
    except Exception as err:
        print(f"cli_saturate FAILED: {err}", file=sys.stderr)
        return 1
    act = "--yes" in argv
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so.
    if act:
        refusal = armlib.refuse_unless_armed(argv, "starting console chats")
        if refusal:
            print(refusal)
            act = False
    results = execute(plan) if (act and plan["planned"]) else []

    if as_json:
        print(json.dumps({**plan, "results": results}, indent=2))
        return 2 if [r for r in results if not r["ok"]] else 0

    print(f"{plan['running']} running of a floor of {plan['floor']} "
          f"(deficit {plan['deficit']}) across {len(plan['usableAccounts'])} usable "
          f"account(s) - {plan['perAccount']}")
    for r in (results or plan["planned"]):
        mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
        print(f"  {mark}[{r['onAccount']}] {(r.get('name') or r['sessionId'][:8])}: {r['why']}"
              + (f" -> {r['outcome']}" if results else ""))
    if plan["shortfall"]:
        print(f"\n{plan['shortfall']} slot(s) unfilled - no chat's own words invite a wake "
              "(held, genuinely done, or waiting on a person).")
    if plan["noCwd"]:
        print(f"\n{len(plan['noCwd'])} more skipped - real cwd could not be recovered from "
              "the transcript (refusing to guess a folder):")
        for r in plan["noCwd"]:
            print(f"  ?? {(r.get('name') or r['sessionId'][:8])}: {r['why']}")
    if not results and plan["planned"]:
        print("\nPLAN ONLY - add --yes to start them.")
    return 2 if [r for r in results if not r["ok"]] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
