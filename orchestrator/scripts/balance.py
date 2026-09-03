#!/usr/bin/env python3
"""balance.py - OBSERVE/PLAN ONLY: account load balancing, as a plan a person can read.

Answers, from the daemon's own whole-fleet usage survey (/api/usage/survey) joined with the
fleet and the chat plan:

  - every ACCOUNT with its 5-hour and weekly percentages (and how fresh the reading is),
  - which account to USE NEXT (lowest binding %, biggest plan, desktop only - the owner
    works in the desktop app),
  - which CHATS would MOVE to which account (crashed-on-usage-wall chats first - moving
    re-homes them where they can actually resume), each with the exact migrate command,
  - and HOW LIKELY balancing is right now, as a verdict with a reason.

Nothing here acts. The commands in the output are handed to a person or an agent to run
deliberately, one at a time, through migrate_chat.py's own rails.

Rules this planner obeys (owner doctrine):
  - DESKTOP STAYS DESKTOP: every move lands in a desktop instance (import-desktop can land
    nowhere else). Nothing is ever moved out of the desktop.
  - CONSOLE STRAYS ARE A MANDATE (owner, 2026-08-31): every console-only chat must be landed
    in a desktop instance, then dispositioned there (archive / resume note / answer) - the
    owner reads chats only in the desktop, so a console chat is invisible to him.
  - HANDOFFS USE OPEN ACCOUNTS: targets are open instances with headroom first; a closed
    account is the last resort, explicitly marked as needing to be opened.
  - PRESSURE ON A CLOSED ACCOUNT IS A SELF-NOTE, never a notification for the owner: it only
    means "do not open that one". Only open-account pressure drives balancing.
  - LIVE chats never move (the import rewrites the transcript; the daemon refuses too).
  - An unknown reading is never 'plenty left': accounts without a fresh, successful reading
    are listed but excluded from targeting.

Usage: python balance.py [--json]
Exit:  0 plan produced - 1 daemon failure.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone

from lib import clilib, hydralib

# THE USAGE BANDS (owner, 2026-08-31): keep every account AT OR UNDER 85% on BOTH windows
# (5-hour and weekly); 90% is the HARD GATE - an account caught past it gets its movable
# chats evacuated, mandatory. UNDER the target there is deliberate FILL: accounts with room
# take migrations and simpler new work so paid capacity is not wasted - with plan-sized
# leeway on how close to the target to fill, because 1% of a Max 20x is far more tokens
# than 1% of Pro. The daemon's own shouldOffload still outranks a raw number.
SOFT_TARGET_PCT = 85
HARD_GATE_PCT = 90
# A usage reading older than this is STALE: shown, never planned on.
FRESH_HOURS = 48

_PLAN_WEIGHT = [("max 20", 3), ("max 5", 2), ("pro", 1)]
# fill ceiling = SOFT_TARGET_PCT minus this per-plan leeway: how much margin to keep under
# the target when deliberately loading an account up.
_FILL_LEEWAY = [("max 20", 2), ("max 5", 5), ("pro", 10)]
DEFAULT_FILL_LEEWAY = 10


def _plan_weight(plan: str | None) -> int:
    p = (plan or "").lower()
    for needle, w in _PLAN_WEIGHT:
        if needle in p:
            return w
    return 0


def fill_ceiling(plan: str | None) -> int:
    p = (plan or "").lower()
    for needle, leeway in _FILL_LEEWAY:
        if needle in p:
            return SOFT_TARGET_PCT - leeway
    return SOFT_TARGET_PCT - DEFAULT_FILL_LEEWAY


def peak_pct(row: dict) -> float | None:
    """The account's worst number across the windows the owner gates on (5-hour, weekly)
    plus the daemon's own binding verdict - never understates. None = unknown, and unknown
    never reads as room."""
    vals = [v for v in (row.get("fiveHourPct"), row.get("weeklyAllPct"), row.get("bindingPct"))
            if v is not None]
    return max(vals) if vals else None


def band_of(peak: float | None) -> str:
    if peak is None:
        return "unknown"
    if peak >= HARD_GATE_PCT:
        return "over-hard"
    if peak >= SOFT_TARGET_PCT:
        return "over-soft"
    return "ok"


def _parse_account_string(s: str) -> tuple[str | None, str | None]:
    """'someone <someone@example.com> · Max 20×' -> (email, plan)."""
    email = None
    m = re.search(r"<([^<>@\s]+@[^<>\s]+)>", s or "")
    if m:
        email = m.group(1)
    plan = None
    if "·" in (s or ""):
        plan = s.split("·")[-1].strip() or None
    return email, plan


def _age_hours(captured_at: str | None) -> float | None:
    if not captured_at:
        return None
    try:
        dt = datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600)
    except ValueError:
        return None


def accounts_overview(survey: dict, fleet: dict) -> list[dict]:
    """One row per ACCOUNT (deduped by email; freshest reading wins), fleet-joined so desktop
    rows carry real instance names, running state and sign-in."""
    fleet_by_dir = {str(i.get("dir") or "").lower(): i for i in fleet.get("instances", [])}
    out: dict[str, dict] = {}
    for row in survey.get("rows", []):
        snap = (row.get("result") or {}).get("snapshot") or {}
        reason = (row.get("result") or {}).get("reason")
        advice = row.get("advice") or {}
        email, plan = _parse_account_string(str(snap.get("account") or ""))
        finst = fleet_by_dir.get(str(row.get("id") or "").lower()) if row.get("kind") == "desktop" else None
        if finst:
            acct = finst.get("account") or {}
            email = acct.get("email") or email
            plan = acct.get("planLabel") or plan
        email = email.strip().lower() if email else email
        identity = email or f"{row.get('kind')}:{row.get('label') or row.get('id')}"
        age = _age_hours(snap.get("capturedAt"))
        entry = {
            "email": email,
            "identity": identity,
            "plan": plan,
            "kind": row.get("kind"),
            "instances": [],
            "fiveHourPct": (snap.get("session") or {}).get("pct"),
            "fiveHourResets": (snap.get("session") or {}).get("resets"),
            "weeklyAllPct": (snap.get("weekAll") or {}).get("pct"),
            "weeklyModelPct": (snap.get("weekModel") or {}).get("pct"),
            "weeklyModelLabel": (snap.get("weekModel") or {}).get("label"),
            "weeklyResets": (snap.get("weekAll") or {}).get("resets"),
            "capturedAt": snap.get("capturedAt"),
            "ageHours": age,
            "severity": advice.get("severity"),
            "bindingPct": advice.get("bindingPct"),
            "shouldOffload": bool(advice.get("shouldOffload")),
            "adviceText": advice.get("advice"),
            "readingOk": reason == "ok" and (snap.get("weekAll") or {}).get("pct") is not None,
            "fresh": age is not None and age <= FRESH_HOURS,
        }
        inst_entry = None
        if finst:
            inst_entry = {
                "num": finst.get("num"),
                "name": finst.get("name"),
                "isRunning": bool(finst.get("isRunning")),
                "signedIn": bool(finst.get("signedIn")),
            }
        prev = out.get(identity)
        if prev is None:
            if inst_entry:
                entry["instances"].append(inst_entry)
            out[identity] = entry
        else:
            if inst_entry and inst_entry not in prev["instances"]:
                prev["instances"].append(inst_entry)
            # freshest reading wins the numbers
            if (age is not None) and (prev["ageHours"] is None or age < prev["ageHours"]):
                for k in ("fiveHourPct", "fiveHourResets", "weeklyAllPct", "weeklyModelPct",
                          "weeklyModelLabel", "weeklyResets", "capturedAt", "ageHours",
                          "severity", "bindingPct", "shouldOffload", "adviceText",
                          "readingOk", "fresh"):
                    prev[k] = entry[k]
    rows = list(out.values())
    # usable for planning: a fresh, successful reading, on a desktop account with a signed-in instance
    for r in rows:
        r["usable"] = bool(
            r["readingOk"] and r["fresh"] and r["kind"] == "desktop"
            and any(i["signedIn"] for i in r["instances"])
        )
        r["open"] = any(i["isRunning"] for i in r["instances"])
        # THE BANDS (constants above): peak across 5-hour/weekly/binding, the band verdict,
        # and how much deliberate-fill room remains under this plan's ceiling.
        r["peakPct"] = peak_pct(r) if r["readingOk"] else None
        r["band"] = band_of(r["peakPct"]) if r["readingOk"] else "unknown"
        r["fillCeiling"] = fill_ceiling(r["plan"])
        r["roomPct"] = (max(0, r["fillCeiling"] - r["peakPct"])
                        if r["peakPct"] is not None else None)
        # Pressure on a CLOSED account is a SELF-NOTE for the orchestrator (do not OPEN that
        # one), never a notification for the owner - a closed app burns nothing. Pressure on
        # an OPEN account is the actionable kind (owner directive, 2026-08-31).
        r["underPressure"] = bool(
            r["readingOk"] and (r["shouldOffload"] or r["band"] in ("over-soft", "over-hard"))
        )
    rows.sort(key=lambda r: (r["peakPct"] if r["peakPct"] is not None else 999,
                             -_plan_weight(r["plan"])))
    return rows


def rank_next(accounts: list[dict]) -> list[dict]:
    """Which account to hand work to next. OWNER RULE: always use OPEN accounts; open a fresh
    one only when you absolutely must. Eligibility is the BAND policy: an account takes new
    work only while its peak stays under its plan's fill ceiling (soft target minus plan
    leeway) - and the most ROOM wins, because deliberately filling under-used accounts is
    the point (owner, 2026-08-31: "so we don't have wasted potential")."""
    usable = [a for a in accounts if a["usable"]]
    open_ok = [a for a in usable
               if a["open"] and a["roomPct"] is not None and a["roomPct"] > 0]
    closed_ok = [a for a in usable
                 if not a["open"] and a["roomPct"] is not None and a["roomPct"] > 0]
    key = lambda a: (-(a["roomPct"] or 0), -_plan_weight(a["plan"]))
    ranked = sorted(open_ok, key=key) + sorted(closed_ok, key=key)
    for a in ranked:
        a["mustOpen"] = not a["open"]
    return ranked


def _target_instance(account: dict) -> dict | None:
    insts = [i for i in account["instances"] if i["signedIn"]]
    if not insts:
        return None
    running = [i for i in insts if i["isRunning"]]
    return (running or insts)[0]


def plan_moves(accounts: list[dict], plan_chats: list[dict],
               protected: set[str] | None = None) -> dict:
    """Which chats move where. Movable: no live writer (kinds 'resume' and 'wait-on-person').
    Crashed-on-the-usage-wall chats move first - a move is what lets them resume at all.

    CONSOLE STRAYS ARE A MANDATE, not a suggestion (owner directive, 2026-08-31): every
    console-only chat the fleet can see gets landed in a desktop instance, then dispositioned
    there - archived if done, noted for resume if crashed, answered if waiting.

    `protected` is overlord.protected_session_ids() (the way groundskeeper.py:199-203 uses
    it), handed in by the caller rather than read here - this function stays a pure planner
    over the rows it is given, with no daemon call of its own. Defaults to empty."""
    protected = protected or set()
    by_email = {a["email"]: a for a in accounts if a["email"]}
    targets = [a for a in rank_next(accounts) if _target_instance(a)]
    moves: list[dict] = []
    console_strays: list[dict] = []

    # SPREAD, NEVER DUMP (owner, 2026-08-31: "load balancing does not mean dump everything
    # in one account" - the first cut aimed every move at the single best target, which
    # would have parked 11 chats on one account and murdered its 5-hour window). Targets
    # ROTATE: open accounts first, round-robin within the tier, and each assignment debits
    # virtual room so a small account stops taking work before it is overfilled.
    ROOM_DEBIT_PER_MOVE = 4
    vroom = {t["email"]: float(t["roomPct"] or 0) for t in targets}
    _rr = {"i": 0}

    def next_target(exclude_email):
        for tier in ([t for t in targets if not t["mustOpen"]],
                     [t for t in targets if t["mustOpen"]]):
            pool = [t for t in tier
                    if t["email"] != exclude_email and vroom.get(t["email"], 0) > 0]
            if not pool:
                continue
            pick = pool[_rr["i"] % len(pool)]
            _rr["i"] += 1
            vroom[pick["email"]] -= ROOM_DEBIT_PER_MOVE
            return pick
        return None
    for ch in plan_chats:
        kind = (ch.get("decision") or {}).get("kind")
        email = (ch.get("account") or {}).get("email")
        if ch.get("instance") is None:
            if str(ch.get("sourceTool") or "") == "opencode":
                # An opencode session is not a Claude session - the desktop app's import
                # (claude://resume) structurally cannot land it. Say so instead of queueing
                # a migrate that would fail deterministically.
                console_strays.append({
                    "sessionId": ch["sessionId"], "title": ch["title"], "kind": kind,
                    "why": "opencode session - it CANNOT land in the Claude desktop app; it lives in opencode only",
                    "to": None, "command": None,
                })
                continue
            if kind == "on-hold":
                # A HOLD is a person's hands-off word and outranks the landing mandate, exactly
                # as it does for chats that already have an instance (the skip below). Listed,
                # never targeted: a targeted row would debit a room the other moves need and
                # queue a migrate that migrate_chat refuses anyway (exit 6), which the sweep
                # then reported as a failure of a chat nobody was allowed to touch.
                console_strays.append({
                    "sessionId": ch["sessionId"], "title": ch["title"], "kind": kind,
                    "why": "console-only but ON HOLD - it lands when the hold lifts; "
                           + str((ch.get("decision") or {}).get("detail") or ""),
                    "to": None, "command": None,
                })
                continue
            # ⛔ NEVER TARGET A LIVE CONSOLE CHAT (mirrors the running-skip for desktop moves
            # below, owner 2026-09-01: never move active chats). migrate_chat refuses a live
            # session every single pass, which would otherwise burn a landConsole slot forever
            # and hand the sweep a permanent exit 2 for a chat nobody was allowed to touch.
            if str(ch.get("state") or "") == "running":
                console_strays.append({
                    "sessionId": ch["sessionId"], "title": ch["title"], "kind": kind,
                    "why": "live - it lands once it stops",
                    "to": None, "command": None,
                })
                continue
            # THE STANDING MANAGER CHAT IS THE OVERLORD'S OWN (overlord.protected_session_ids,
            # the way groundskeeper.py:199-203 uses it) - it relocates itself on its own tick,
            # so a console-landing move here would fight that and, if it ever succeeded,
            # darken the watchdog exactly as archiving it once did.
            if ch.get("sessionId") in protected:
                console_strays.append({
                    "sessionId": ch["sessionId"], "title": ch["title"], "kind": kind,
                    "why": "the standing manager chat - the overlord owns it",
                    "to": None, "command": None,
                })
                continue
            target = next_target(None)
            disposition = {
                "archive": "once landed, it archives on the next sweep (cleanly when its new instance is closed)",
                "resume": "once landed, it is a visible resume candidate",
                "wait-on-person": "once landed, it is visibly waiting for your answer",
                "judgment": "once landed, its next step is decided in the app",
            }.get(kind, "once landed, it gets dispositioned in the app")
            console_strays.append({
                "sessionId": ch["sessionId"],
                "title": ch["title"],
                "kind": kind,
                "why": f"console-only - the owner reads chats in the desktop, so it MUST be landed; {disposition}",
                "to": target and {"email": target["email"],
                                  "instance": _target_instance(target)["name"],
                                  "mustOpen": target["mustOpen"]},
                "command": target and
                    f"python scripts/migrate_chat.py {ch['sessionId']} --to {_target_instance(target)['name']}",
            })
            continue
        if kind not in ("resume", "wait-on-person"):
            continue  # settled chats never move
        # ⛔ NEVER MOVE AN ACTIVE CHAT (owner, 2026-09-01: "Never... move active chats. Only
        # chats that are stopped, waiting, chilling."). A chat with a live engine - mid-turn
        # OR idle between turns - stays where it is; a move kills its process. It moves once
        # it has stopped. `state` is the gate's verdict for this chat.
        if str(ch.get("state") or "") == "running":
            continue
        src = by_email.get(email)
        crashed_on_wall = kind == "resume" and "usage-limit" in str((ch.get("decision") or {}).get("action", ""))
        # A hot CLOSED account is only a self-note (nothing burns there); moving work off an
        # account for pressure only makes sense when that account is OPEN and working.
        # THE BANDS: past the HARD GATE (90%) evacuation is MANDATORY; over the soft target
        # (85%) it is advised; the daemon's shouldOffload counts as hot at any number.
        src_hard = bool(src and src["open"] and src["band"] == "over-hard")
        src_hot = bool(src and src["open"]
                       and (src["band"] in ("over-soft", "over-hard") or src["shouldOffload"]))
        if not crashed_on_wall and not src_hot:
            continue
        target = next_target(email)
        if not target:
            continue
        ti = _target_instance(target)
        why = ("crashed on its account's usage wall - moving it is what lets it resume"
               if crashed_on_wall else
               f"HARD GATE: its account is at {src['peakPct']}%, past the {HARD_GATE_PCT}% gate - "
               "evacuation is mandatory, not advice"
               if src_hard else
               f"its account is at {src['peakPct']}%, over the {SOFT_TARGET_PCT}% target - "
               "its future turns should burn a fresher account")
        if target["mustOpen"]:
            # Doctrine: a closed target is never proposed silently - say opening is required.
            why += f"; NOTE: {ti['name']} is CLOSED and would need opening first"
        moves.append({
            "sessionId": ch["sessionId"],
            "title": ch["title"],
            "from": {"instance": ch.get("instance"), "email": email,
                     "bindingPct": src and src["bindingPct"]},
            "to": {"instance": ti["name"], "email": target["email"],
                   "bindingPct": target["bindingPct"], "mustOpen": target["mustOpen"]},
            "why": why,
            "command": f"python scripts/migrate_chat.py {ch['sessionId']} --to {ti['name']}",
        })
    # Order: crashed-on-the-wall first (a move is what revives them), then hard-gate
    # evacuations, then soft-target advice.
    moves.sort(key=lambda m: 0 if "lets it resume" in m["why"] else 1 if "HARD GATE" in m["why"] else 2)

    # Only OPEN accounts under pressure drive the balancing verdict; a hot CLOSED account is
    # the orchestrator's own do-not-open note and no reason to move anything.
    open_pressured = [a for a in accounts if a["underPressure"] and a["open"]]
    if moves and targets:
        likelihood = {"level": "likely", "why":
                      f"{len(moves)} chat(s) have a concrete better home"
                      + (f" and {len(open_pressured)} OPEN account(s) are under pressure" if open_pressured else "")
                      + " - the moves below are ready to run"}
    elif open_pressured and not targets:
        likelihood = {"level": "blocked", "why":
                      f"{len(open_pressured)} OPEN account(s) over the {SOFT_TARGET_PCT}% target but NO "
                      "account is under its fill ceiling - nothing to move onto; wait for a reset"}
    elif open_pressured:
        likelihood = {"level": "unlikely", "why":
                      f"{len(open_pressured)} OPEN account(s) under pressure but no movable chat "
                      "sits on them (live chats never move)"}
    else:
        likelihood = {"level": "unlikely", "why":
                      f"no OPEN account is under pressure (hot closed accounts are only the "
                      "orchestrator's own do-not-open notes)"}
    # DELIBERATE FILL (owner, 2026-08-31): open accounts with real room under their ceiling
    # are where migrations and simpler NEW chats should go - unused paid capacity is waste.
    fill = [{"email": a["email"], "instance": (_target_instance(a) or {}).get("name"),
             "plan": a["plan"], "peakPct": a["peakPct"], "fillCeiling": a["fillCeiling"],
             "roomPct": a["roomPct"],
             "note": f"room for ~{a['roomPct']}% more before its {a['fillCeiling']}% ceiling - "
                     "migrate chats here or start simpler chats here"}
            for a in accounts
            if a["usable"] and a["open"] and (a["roomPct"] or 0) >= 5]
    fill.sort(key=lambda f: -(f["roomPct"] or 0))
    return {"moves": moves, "consoleStrays": console_strays, "likelihood": likelihood,
            "fill": fill,
            "targets": [{"email": t["email"], "peakPct": t["peakPct"], "roomPct": t["roomPct"],
                         "mustOpen": t["mustOpen"],
                         "instance": (_target_instance(t) or {}).get("name")} for t in targets[:3]]}


def usage_rows_with_fallback() -> tuple[dict, str]:
    """The live survey, or - when it fails (cold daemon, restart window) - the daemon's
    CACHED snapshots reshaped into survey rows and labeled as such. A degraded strip that
    says 'cached' beats a red 'usage read failed' the owner has to wonder about; staleness
    is already first-class downstream (fresh/ageHours flags).

    When BOTH fail, return no rows tagged 'unavailable' rather than raising: usage is only
    needed by the balancing lanes, and a usage outage must not take down archiving, landing
    or the naming pass with it. Downstream says UNKNOWN, never 'no pressure'.
    """
    try:
        return hydralib.usage_survey(), "survey"
    except hydralib.DaemonError:
        pass
    try:
        cache = hydralib.usage_cache().get("cache", {})
        rows = []
        for key, snap in cache.items():
            if not isinstance(snap, dict):
                continue
            kind, _, ident = str(key).partition(":")
            week = snap.get("weekAll") or {}
            rows.append({
                "kind": kind, "num": None, "id": ident, "label": ident,
                "result": {"snapshot": snap, "cached": True, "key": key,
                           "reason": "ok" if week.get("pct") is not None else "check_failed"},
                "advice": {"severity": week.get("severity"), "bindingPct": week.get("pct"),
                           "shouldOffload": False, "safeToFanOut": True,
                           "advice": "from the daemon's cached snapshot - live survey unavailable"},
            })
        return {"rows": rows}, "cache-fallback"
    except hydralib.DaemonError:
        return {"rows": []}, "unavailable"


def build(plan: dict | None = None) -> dict:
    """`plan` lets a caller that JUST built dashboard.build_plan() hand it in instead of
    paying the whole sessions+per-chat-dossier+gate pass a second time (efficiency pass,
    2026-08-31: sweep and orch were rebuilding the identical plan up to 4x per run). Scoped
    reuse only - same process, same invocation, seconds apart; never a cross-run cache, and
    nothing on any act script's T-0 path (those never call this)."""
    import dashboard  # late import: dashboard also serves this module's answers

    survey, usage_source = usage_rows_with_fallback()
    fleet = hydralib.fleet()
    accounts = accounts_overview(survey, fleet)
    if plan is None:
        plan = dashboard.build_plan()
    import overlord  # late import: same lazy pattern as dashboard, above

    try:
        protected = overlord.protected_session_ids()
    except hydralib.DaemonError:
        protected = set()  # best-effort: a failed read never blocks the rest of the plan
    move_plan = plan_moves(accounts, plan["chats"], protected=protected)
    ranked = rank_next(accounts)
    if usage_source == "unavailable":
        # Never let "we could not read usage" read as "nothing is under pressure".
        move_plan["likelihood"] = {
            "level": "unknown",
            "why": "usage could not be read from AgentHydra at all (survey AND cache failed) - "
                   "no account state is known, so no balancing verdict is possible; the other "
                   "lanes are unaffected",
        }
    return {
        "usageSource": usage_source,
        "activeAccounts": sum(1 for a in accounts if a["usable"]),
        "measuredAccounts": sum(1 for a in accounts if a["readingOk"]),
        "totalLogins": len(accounts),
        "accounts": accounts,
        "useNext": [{"email": a["email"], "plan": a["plan"], "bindingPct": a["bindingPct"],
                     "fiveHourPct": a["fiveHourPct"], "weeklyAllPct": a["weeklyAllPct"],
                     "peakPct": a["peakPct"], "roomPct": a["roomPct"], "band": a["band"],
                     "open": a["open"], "mustOpen": a["mustOpen"],
                     "instance": (_target_instance(a) or {}).get("name")}
                    for a in ranked[:3]],
        **move_plan,
        "planIncomplete": not plan["complete"],
    }


def render(b: dict) -> str:
    L = [
        f"{b['activeAccounts']} usable desktop account(s) of {b['totalLogins']} logins "
        f"({b['measuredAccounts']} with a real reading)",
        "",
        "ACCOUNTS (freshest reading; '-' = never measured, which is NOT 'plenty left'):",
    ]
    for a in b["accounts"]:
        pct = lambda v: "-" if v is None else f"{v}%"
        stale = "" if a["fresh"] else ("  ⚠ STALE reading" if a["readingOk"] else "  ⚠ no reading")
        # Pressure on an OPEN account is actionable; on a closed one it is only the
        # orchestrator's own reminder not to open it (owner: "never notify me about those").
        press = ""
        if a["underPressure"]:
            what = ("HARD GATE (>=90%) - EVACUATE" if a.get("band") == "over-hard"
                    else f"over the {SOFT_TARGET_PCT}% target")
            press = (f"  ⛔ {what}" if a["open"]
                     else "  🤖 self-note: do NOT open this one")
        insts = ",".join(i["name"] + ("*" if i["isRunning"] else "") for i in a["instances"]) or a["kind"]
        L.append(f"  {a['identity']:<34} {a['plan'] or '?':<8} 5h {pct(a['fiveHourPct']):>4}  "
                 f"weekly {pct(a['weeklyAllPct']):>4}  model {pct(a['weeklyModelPct']):>4}  "
                 f"[{insts}]{press}{stale}")
    L.append("")
    if b["useNext"]:
        L.append("HAND OFF TO NEXT (open accounts first, most fill-room wins - open a fresh one only when you must):")
        for i, a in enumerate(b["useNext"]):
            tag = "OPEN" if a["open"] else "closed - would need OPENING"
            L.append(f"  {i + 1}. {a['email']} ({a['plan']}, {tag}) - peak {a['peakPct']}%, "
                     f"~{a['roomPct']}% room under its ceiling, 5h {a['fiveHourPct']}%, "
                     f"weekly {a['weeklyAllPct']}% -> instance {a['instance']}")
    else:
        usable = [a for a in b["accounts"] if a.get("usable")]
        if usable:
            L.append(f"HAND OFF: {len(usable)} account(s) are usable but ALL sit past their "
                     f"fill ceilings (target {SOFT_TARGET_PCT}% minus plan leeway) - everyone is "
                     "busy; wait for a reset rather than hunting a data problem.")
        else:
            L.append("HAND OFF: no usable account with a fresh reading - fix that before planning anything.")
    L.append("")
    L.append(f"LOAD BALANCING: {b['likelihood']['level'].upper()} - {b['likelihood']['why']}")
    for m in b["moves"]:
        L.append(f"  MOVE '{m['title']}'  {m['from']['instance']} ({m['from']['email']}, "
                 f"{m['from']['bindingPct']}%) -> {m['to']['instance']} ({m['to']['email']}, "
                 f"{m['to']['bindingPct']}%)")
        L.append(f"    why: {m['why']}")
        L.append(f"    run: {m['command']}")
    if b.get("fill"):
        L.append("")
        L.append(f"DELIBERATE FILL (owner rule: never waste paid capacity under the {SOFT_TARGET_PCT}% target):")
        for f in b["fill"]:
            L.append(f"  {f['email']} ({f['plan']}, {f['instance']}): peak {f['peakPct']}% - {f['note']}")
    if b["consoleStrays"]:
        L.append("")
        L.append("CONSOLE STRAYS - invisible to the owner, MUST be landed in the desktop (owner mandate):")
        for c in b["consoleStrays"]:
            L.append(f"  - {c['title']} ({c['kind']})" + (f"  -> {c['to']['instance']}" if c.get("to") else ""))
            if c.get("command"):
                L.append(f"    run: {c['command']}")
    if b.get("planIncomplete"):
        L.append("")
        L.append("⚠ the chat plan under this was INCOMPLETE (a liveness read failed) - treat the")
        L.append("  move list as a lower bound and re-run.")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    try:
        b = build()
    except hydralib.DaemonError as err:
        print(f"balance FAILED: {err}", file=sys.stderr)
        print(f"Is the AgentHydra daemon running? Try: curl {hydralib.BASE}/api/health", file=sys.stderr)
        return 1
    print(json.dumps(b, indent=2) if as_json else render(b))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
