#!/usr/bin/env python3
"""sweep.py - ACT (batch, one invocation): execute the predetermined plan in ONE command.

THE DIVISION OF LABOR this exists to enforce (owner directive, 2026-08-31):

  CODE decides and executes the mechanical lanes. The gate computes every chat's state
  deterministically; archiving candidates, re-homing crashed-on-the-wall chats, and landing
  console strays are then pure execution - so an AI (or a person) calls THIS script once,
  with flags, and waits for the batch to finish, instead of driving each act by hand.

  THE AI keeps only the judgment lanes. A chat WAITING ON A PERSON (offers to carry on, asks
  a question, recap not done) and an IDLE live chat (answer? nudge? hand off?) need someone
  to read the evidence and compose an answer. This script NEVER acts on those - it lists
  them, with the evidence pointer, as the judgment queue the caller works through.

The intended agent workflow:
  1. python sweep.py --json              # the plan: what WOULD happen, plus the judgment queue
  2. (the AI decides the judgment rows itself - answers, nudges, handoffs)
  3. python sweep.py --all --yes         # one call executes every mechanical act, within caps
Every act still runs the full rails of its own script (gate, breaker, T-0 re-check, verify,
pending-restart honesty) - the sweep adds batching and caps, never shortcuts.

This is a SINGLE PASS by design, not a daemon: v2 died as an unattended loop. Running it is
a deliberate act; scheduling it is a decision a person makes.

Usage: python sweep.py [--archive] [--moves] [--land-console] [--all]
                       [--max N] [--breaker-threshold N] [--allow-pending] [--json]
                       --yes to actually act
  (no act flag, or no --yes) -> plan only: prints the batch that WOULD run, executes nothing
  --archive        archive every ARCHIVE-CANDIDATE chat - a running app is archived through
                   the app's OWN control (immediate + durable), a closed one via disk flags
  --moves          execute the load-balancing moves (crashed-on-the-wall first)
  --land-console   land console-only chats that are waiting on the owner into the desktop
  --deliver        send replies an AI already STAGED (stage_reply.py) into their chats
  --all            all four lanes
  (with --yes, every acting sweep also runs THE DOCTRINE PASS: re-stamps bypassPermissions
   + ultracode across the whole fleet. Conformance decays on its own - a running app can
   re-save over the stamp - so it is re-applied on the clock, not once at landing.)
  --max N          per-lane cap per run (default 5) - a sweep is a batch, not a purge
  --breaker-threshold N  consecutive same-cause failures that halt a lane for this pass
                   (default 3) - see THE SHARED-CAUSE BREAKER below
Exit:  0 all attempted acts verified (or nothing to do) - 2 some acts refused/failed, each
       named with its exit code - 1 daemon failure before acting.
"""

from __future__ import annotations

import json
import sys

import archive_chat
import automation_chat
from lib import armlib, clilib
from lib import clilib
from lib import hydralib
import migrate_chat

DEFAULT_MAX_PER_LANE = 5


def build_batch(allow_pending: bool, max_per_lane: int,
                plan: dict | None = None, bal: dict | None = None) -> dict:
    """The predetermined batch: what one --yes run would execute, and the judgment queue it
    deliberately leaves to the AI.

    `plan`/`bal` let a caller that already built them (orch.py's dry loop) hand them in
    instead of rebuilding - and build_batch itself hands its plan into balance.build() for
    the same reason (efficiency pass, 2026-08-31). Same-invocation reuse only; the act
    scripts' own T-0 rechecks are elsewhere and stay fresh."""
    import balance
    import dashboard

    if plan is None:
        plan = dashboard.build_plan()
    if bal is None:
        bal = balance.build(plan=plan)

    # Held chats never enter a batch at all: the act scripts would refuse them anyway, but a
    # batch that lists them would spend an act call and misreport a person's deliberate hold
    # as a failure. build_plan labels them kind == 'on-hold'; every lane below is filtered on
    # that set explicitly (review 2026-09-01: the land lane took its rows straight from the
    # balancer, which knew nothing about holds, so this comment was true of one lane only).
    on_hold = [{"sessionId": ch["sessionId"], "title": ch["title"], "why": ch["decision"]["detail"]}
               for ch in plan["chats"] if ch["decision"]["kind"] == "on-hold"]
    held_ids = {h["sessionId"] for h in on_hold}

    # Every archive candidate goes in the lane, running app or not: archive_chat drives the
    # app's OWN control when the app is open (the owner never restarts the apps, so waiting
    # for one was never a real plan - removed 2026-08-31 on his order).
    archive_now: list[dict] = []
    for ch in plan["chats"]:
        if ch["decision"]["kind"] != "archive":
            continue
        if ch.get("origin") == "console":
            # A console chat has no desktop record to flip - archiving it is impossible until
            # it is LANDED (and the owner mandates landing anyway). The land lane owns it.
            continue
        archive_now.append({"sessionId": ch["sessionId"], "title": ch["title"],
                            "argv": [ch["sessionId"]]})
    judgment = [
        {"sessionId": ch["sessionId"], "title": ch["title"], "instance": ch["instance"],
         "kind": ch["decision"]["kind"], "action": ch["decision"]["action"],
         "why": ch["decision"]["detail"],
         "evidence": (ch.get("evidence") or "")[-300:]}
        for ch in plan["chats"] if ch["decision"]["kind"] in ("wait-on-person", "judgment")
    ]
    moves = [{"sessionId": m["sessionId"], "title": m["title"], "to": m["to"]["instance"],
              "why": m["why"], "argv": [m["sessionId"], "--to", m["to"]["instance"], "--stop-idle"]}
             for m in bal["moves"] if m["sessionId"] not in held_ids]
    # Owner mandate: EVERY console stray gets landed, whatever its state - then dispositioned
    # in the desktop (archive on a later sweep, resume note, or an answer). A HELD stray is
    # the one exception: the hold is the owner's word too, and it wins.
    lands = [{"sessionId": c["sessionId"], "title": c["title"], "kind": c.get("kind"),
              "to": c["to"]["instance"] if c.get("to") else None,
              "argv": [c["sessionId"], "--to", c["to"]["instance"], "--stop-idle"] if c.get("to") else None}
             for c in bal["consoleStrays"]
             if c["sessionId"] not in held_ids and c.get("kind") != "on-hold"]

    def cap(lane):
        return {"rows": lane[:max_per_lane], "overCap": max(0, len(lane) - max_per_lane)}

    # The delivery lane is planned by the courier itself (it owns the rails that decide
    # whether a staged reply can go right now); the sweep only batches and reports it. The
    # plan already gated every chat, so the machine-wide concurrency count rides along free.
    import courier

    running_now = sum(1 for ch in plan["chats"] if ch.get("state") == "running")
    delivery_plan = courier.run(max_per_lane, None, act=False, running_now=running_now)
    deliveries = [{"id": p["id"], "title": p["title"], "instance": p["instance"],
                   "text": p["text"], "argv": ["--yes", "--only", p["id"]]}
                  for p in delivery_plan["planned"]]

    return {
        "planComplete": plan["complete"] and not bal.get("planIncomplete"),
        "likelihood": bal["likelihood"],
        "lanes": {
            "archive": cap(archive_now),
            "moves": cap(moves),
            "landConsole": cap([l for l in lands if l["argv"]]),
            "deliver": cap(deliveries),
        },
        "deliverySkipped": delivery_plan["skipped"],
        "onHold": on_hold,  # a person's hands-off switch - never in any lane
        "judgmentQueue": judgment,  # THE AI'S - the sweep never touches these
    }


# THE SHARED-CAUSE BREAKER (README rule 3's sibling for a whole PASS, not one chat): the
# per-chat ledger has no notion of one cause hitting many chats in the same run - a single
# daemon blip used to be spent as N separate "deterministic-stop"-looking rows, one per
# unrelated chat, before anyone noticed they were the same thing. When this many CONSECUTIVE
# failures in one lane fingerprint to the same normalized cause (incidentlib.error_fingerprint
# - error text alone, no chat identity in it), the rest of that lane is left untouched for
# this pass rather than burning through every remaining row on a cause retrying will not
# clear. A different signature - or an ok row, including deferred/held, which are not
# failures - resets the streak; the breaker never fires across mixed causes.
DEFAULT_BREAKER_THRESHOLD = 3


def _outcome_word(code: int, deferred: bool, held: bool) -> str:
    # exit meanings come from each act script's own contract
    return ("verified" if code == 0 else
            "preserving-docs-first (or another run holds it) - archives next pass" if deferred else
            "held-by-owner (left alone by design)" if held else
            "refused-by-gate-or-moved" if code == 2 else
            "deterministic-stop" if code == 3 else
            "live-writer" if code == 4 else
            "breaker" if code == 5 else
            "ui-could-not-reach-the-row" if code == 7 else "failed")


def execute(batch: dict, lanes: list[str],
            breaker_threshold: int = DEFAULT_BREAKER_THRESHOLD) -> dict:
    import courier
    from lib import incidentlib

    results = []
    breaker_halts = []
    for lane in lanes:
        rows = batch["lanes"][lane]["rows"]
        fn = (courier.main if lane == "deliver"
              else archive_chat.main if lane == "archive"
              else migrate_chat.main)
        streak_sig: str | None = None
        streak_rows: list[dict] = []
        for idx, row in enumerate(rows):
            code, out = clilib.capture(fn, row["argv"])
            # Exit 8 is DEFERRED, not failed: archive_chat asked the chat to preserve its docs
            # first and will archive it on a later pass. Counts as OK for the run's verdict.
            deferred = code == 8
            # Exit 6 is a HOLD: the act script found a person's hands-off word at T-0 (a hold
            # placed after the batch was built). Left alone by design, so it is not a failure
            # of the lane - and it must never read as one (the whole point of the hold filter).
            held = code == 6
            ok = code == 0 or deferred or held
            results.append({
                "lane": lane, "sessionId": row.get("sessionId") or row.get("id"),
                "title": row["title"], "exit": code, "ok": ok,
                "outcome": _outcome_word(code, deferred, held), "output": out,
            })

            if ok:
                streak_sig, streak_rows = None, []
                continue
            sig = incidentlib.error_fingerprint(out or _outcome_word(code, deferred, held))
            streak_rows = [*streak_rows, row] if sig == streak_sig else [row]
            streak_sig = sig
            if len(streak_rows) < breaker_threshold:
                continue
            remaining = rows[idx + 1:]
            affected = [{"sessionId": r.get("sessionId") or r.get("id"), "title": r["title"]}
                        for r in streak_rows]
            incident_id = incidentlib.record(
                "sweep-breaker", lane,
                f"{len(streak_rows)} consecutive '{lane}' failures shared one cause: {(out or '')[:300]}",
                meta={"chats": affected, "skipped": len(remaining)},
            )
            breaker_halts.append({
                "lane": lane, "count": len(streak_rows), "incident": incident_id,
                "chats": affected, "skipped": len(remaining),
                "why": (f"{len(streak_rows)} consecutive '{lane}' acts failed with the same "
                        f"cause - halting the rest of this lane ({len(remaining)} chat(s) left "
                        "untouched) instead of repeating a cause that will not clear chat by "
                        "chat."),
            })
            break  # halt the REST of this lane for this pass; other lanes are unaffected
    return {"acted": len(results), "verified": sum(1 for r in results if r["ok"]),
            "results": results, "breakerHalts": breaker_halts}


def render(batch: dict, executed: dict | None, acting_lanes: list[str],
           refused: str | None = None) -> str:
    L = []
    lk = batch["likelihood"]
    if not batch["planComplete"]:
        L.append("⚠ the underlying plan is INCOMPLETE (a read failed) - lane contents are lower bounds.")
    for lane, label in (("archive", "ARCHIVE"), ("moves", "MOVE"),
                        ("landConsole", "LAND IN DESKTOP"), ("deliver", "DELIVER REPLY")):
        rows = batch["lanes"][lane]["rows"]
        over = batch["lanes"][lane]["overCap"]
        mode = "will run" if lane in acting_lanes and executed is not None else "would run"
        L.append(f"{label}: {len(rows)} act(s) {mode}" + (f" (+{over} over the per-run cap)" if over else ""))
        for r in rows:
            L.append(f"  - {r['title']}" + (f"  -> {r['to']}" if r.get("to") else ""))
    if batch.get("onHold"):
        L.append(f"{len(batch['onHold'])} chat(s) ON HOLD - untouched by every lane, by your own word:")
        for h in batch["onHold"]:
            L.append(f"  - {h['title']}")
    L.append(f"load balancing: {lk['level'].upper()} - {lk['why']}")
    L.append("")
    jq = batch["judgmentQueue"]
    L.append(f"JUDGMENT QUEUE - {len(jq)} chat(s) the sweep will NEVER act on (an AI or a person "
             "reads the evidence and answers):")
    for j in jq:
        L.append(f"  - [{j['instance'] or 'console'}] {j['title']}  ({j['action']})")
    if executed is None:
        L.append("")
        # Say the REAL reason nothing ran. The old footer told a person who had passed both
        # the lane flag and --yes to "add a lane flag AND --yes" - the switch was what
        # stopped it (live smoke, 2026-09-01).
        L.append(refused if refused else
                 "PLAN ONLY - nothing was executed. Add a lane flag AND --yes to act.")
    else:
        L.append("")
        L.append(f"EXECUTED {executed['acted']} act(s): {executed['verified']} verified.")
        for r in executed["results"]:
            L.append(f"  [{r['outcome']}] ({r['lane']}) {r['title']} (exit {r['exit']})")
            if not r["ok"]:
                for line in r["output"].splitlines()[:3]:
                    L.append(f"      {line}")
        for h in executed.get("breakerHalts") or []:
            L.append("")
            L.append(f"⛔ SHARED-CAUSE BREAKER (incident {h['incident']}): {h['why']}")
            for c in h["chats"]:
                L.append(f"      - {c['title']}")
    return "\n".join(L)


def parse_lanes(argv: list[str]) -> list[str]:
    """Which acting lanes this invocation asked for, in the sweep's fixed order."""
    lanes = []
    if "--archive" in argv or "--all" in argv:
        lanes.append("archive")
    if "--moves" in argv or "--all" in argv:
        lanes.append("moves")
    if "--land-console" in argv or "--all" in argv:
        lanes.append("landConsole")
    if "--deliver" in argv or "--all" in argv:
        lanes.append("deliver")
    return lanes


def resolve_yes_flag(argv: list[str], yes: bool) -> tuple[bool, str | None]:
    """THE ARMED WINDOW (owner order, 2026-09-01): the unattended machinery may not act
    without at least some occasional instruction - a person's open window
    (`python orch.py arm`) or --force. Disarmed: fall back to a plan-only run and say so,
    rather than acting. Returns the (possibly downgraded) yes flag and the refusal text,
    if any, so the caller can print it once and report it in the footer."""
    if not yes:
        return yes, None
    refused = armlib.refuse_unless_armed(argv, "the sweep's act lanes")
    if refused:
        print(refused)
        return False, refused
    return yes, None


def run_naming_pass(batch: dict, executed: dict) -> dict:
    """THE NAMING PASS (owner law): a landing is not finished until the landed chats carry
    real names - fresh imports land nameless and render generic. Run it per target
    instance, seeding each landed chat's intended title from the plan."""
    import name_chats

    landed_ok = {r["sessionId"] for r in executed["results"]
                 if r["lane"] == "landConsole" and r["ok"]}
    by_instance: dict[str, dict[str, str]] = {}
    for row in batch["lanes"]["landConsole"]["rows"]:
        if row["sessionId"] in landed_ok and row.get("to"):
            by_instance.setdefault(row["to"], {})[row["sessionId"]] = row["title"]
    naming = {}
    for inst, titles in by_instance.items():
        try:
            naming[inst] = name_chats.name_pass(inst, extra_titles=titles)
        except Exception as e:  # noqa: BLE001 - a naming failure must not unreport the lands
            naming[inst] = {"named": [], "needsJudgment": [], "flakes": [str(e)],
                            "remaining": None, "why": f"naming pass crashed: {e}"}
    return naming


def run_doctrine_pass() -> dict:
    """THE DOCTRINE PASS (owner law, 2026-09-01: "all chats need to always be set to
    bypass permissions"). Landing already stamps a fresh chat, and that was the whole
    enforcement - which is why 21 chats were found unstamped, 9 of them missing bypass
    itself. A stamp applied once is not a guarantee: under a RUNNING app the in-memory
    record is authoritative and can re-save over the disk stamp, so conformance DECAYS
    on its own with nobody doing anything wrong. The fix for a decaying invariant is
    not a better one-time stamp, it is re-converging on a clock - so every acting sweep
    re-stamps the whole fleet, and the 5-minute cycle makes drift self-correcting.
    It carries its own rails (held chats skipped, archived left alone) and is wrapped
    like the naming pass: a doctrine failure must never unreport the acts above it."""
    try:
        code, out = clilib.capture(automation_chat.main, ["--all", "--yes"])
        return {"exit": code, "output": out}
    except Exception as e:  # noqa: BLE001 - never let enforcement break the sweep
        return {"exit": None, "output": f"doctrine pass crashed: {e}"}


def run_acting_lanes(batch: dict, lanes: list[str],
                     breaker_threshold: int = DEFAULT_BREAKER_THRESHOLD) -> tuple[dict, dict | None, dict]:
    """Executes the requested lanes, then the naming and doctrine passes that always
    follow an acting sweep (naming only when landConsole actually ran)."""
    executed = execute(batch, lanes, breaker_threshold=breaker_threshold)
    naming = run_naming_pass(batch, executed) if "landConsole" in lanes else None
    doctrine = run_doctrine_pass()
    return executed, naming, doctrine


def print_text_report(batch: dict, executed: dict | None, lanes: list[str],
                      refused: str | None, naming: dict | None, doctrine: dict | None) -> None:
    print(render(batch, executed, lanes, refused=refused))
    if naming:
        print()
        for inst, res in naming.items():
            print(f"NAMING PASS ({inst}): {len(res['named'])} named, "
                  f"{len(res['needsJudgment'])} need an AI-written name - {res['why']}")
            for r in res["named"]:
                print(f"  named {r['sid'][:8]} -> '{r['title']}'")
            for r in res["needsJudgment"]:
                print(f"  ⚠ {r['sid'][:8]} quarantined as '{r['quarantineTitle']}'")
    if doctrine:
        print()
        head = (doctrine["output"].splitlines() or ["(no output)"])[0]
        print(f"DOCTRINE PASS (bypassPermissions + ultracode, every chat): {head}")


def emit_report(batch: dict, executed: dict | None, lanes: list[str], refused: str | None,
                naming: dict | None, doctrine: dict | None, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"batch": batch, "executed": executed, "naming": naming,
                          "doctrine": doctrine,
                          "actedLanes": lanes if executed else []}, indent=2))
    else:
        print_text_report(batch, executed, lanes, refused, naming, doctrine)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    yes, refused = resolve_yes_flag(argv, "--yes" in argv)
    allow_pending = "--allow-pending" in argv
    max_per_lane = DEFAULT_MAX_PER_LANE
    if "--max" in argv:
        max_per_lane = int(argv[argv.index("--max") + 1])
    breaker_threshold = DEFAULT_BREAKER_THRESHOLD
    if "--breaker-threshold" in argv:
        breaker_threshold = int(argv[argv.index("--breaker-threshold") + 1])
    lanes = parse_lanes(argv)

    try:
        batch = build_batch(allow_pending, max_per_lane)
    except hydralib.DaemonError as err:
        print(f"sweep FAILED before acting: {err}", file=sys.stderr)
        return 1

    executed = naming = doctrine = None
    if lanes and yes:
        executed, naming, doctrine = run_acting_lanes(batch, lanes, breaker_threshold=breaker_threshold)

    emit_report(batch, executed, lanes, refused, naming, doctrine, as_json)

    if executed is None:
        return 0
    return 0 if executed["verified"] == executed["acted"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
