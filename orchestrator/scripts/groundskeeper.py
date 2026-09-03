#!/usr/bin/env python3
"""groundskeeper.py - ACT: the two things nobody was doing to a dormant chat.

THE COMPLAINT (owner, 2026-09-01): "multiple of my accounts have dormant chats just sitting
there not running or archived - what's up with that? Do you just ignore some?" The honest
answer was yes, and not on purpose. Measured that morning: 12 dormant chats, and a lane for
none of them.

  - saturate WAKES chats, but skips any account over its usage target - correctly. Seven of
    the twelve sat on one account that had burned to 100%, so saturate saw zero candidates
    and the machine drained from 14 running to 6 while work sat idle.
  - reconcile only re-checks archives that were ALREADY ATTEMPTED. Nothing ever STARTED one.
    A chat whose own recap said "done" therefore sat in the sidebar forever.

So four duties, all mechanical, all on the 5-minute cadence:

DUTY 1 - EVACUATE THE STRANDED. EVERY un-archived DORMANT chat on an account past its usage
target leaves for the emptiest account that may take work - an open account always wins; a
closed one is opened only when every open one is past its target, and one per run at most.
Owner correction, 2026-09-01: a chat left on a burnt account can do nothing at all until the
window resets, so work in hand only decides the ORDER they leave in, never whether.
Deliberately UNCAPPED (EVACUATE_PER_RUN = None); --evacuate-max is for a careful run.
⛔ A chat with a LIVE engine on such an account is NAMED (activeOnBurnt), never moved: owner,
2026-09-01, "never move active chats - only chats that are stopped, waiting, chilling". It
leaves once it has stopped.

DUTY 2 - ARCHIVE THE DONE. A dormant chat whose gate verdict is 'archive-candidate' (its own
recap claims done, asks nothing, offers nothing) AND that has been quiet ARCHIVE_QUIET_SECS
goes through archive_chat, which performs the owner's knowledge-preservation step first - the
chat is asked to update any relevant markdown before it is put away, and exit 8 means that
ask is in flight (or another run holds the chat), retried next pass. Capped (ARCHIVE_PER_RUN).

DUTY 3 - NAME THE STUCK. A running chat the gate calls STALLED (a permission prompt nobody
answered) is REPORTED every pass (stuck), with a shorter window for a chat whose configured
mode is not bypassPermissions (PROMPT_STALL_SECS - its stall IS the missing stamp). It is
never moved: moving a live chat kills its process, and the owner's word (2026-09-01) is that
active chats are never moved. unblock_prompts presses the prompt for bypass chats; anything
else is a person's call, said loudly here.

DUTY 4 - REBALANCE. When one open account holds REBALANCE_GAP more chats than the emptiest
open one, dormant chats move from the fullest to the thinnest until the gap is closed enough.
Among the apps already open only - spreading never opens an account. Capped
(REBALANCE_PER_RUN, and never more than half the gap).

⛔ IT NEVER MOVES A CHAT WITH A LIVE ENGINE - mid-turn or idle - and never touches a held
chat, one under a breaker, or the overlord's own chat (overlord.protected_session_ids: it
relocates itself and is never archived unattended). It never archives a chat whose recap does
not claim done. Duties 2 and 4 are capped per run so a bad reading can only ever cost a few
chats before a person sees it; duty 1 is not, on the owner's word. And like every acting
lane it acts ONLY inside a window a person opened (armlib) - otherwise it plans and reports.

Usage: python groundskeeper.py [--json]            # what it WOULD do; touches nothing
       python groundskeeper.py --yes [--evacuate-max N] [--archive-max N]
       python groundskeeper.py --yes --only-archive | --only-evacuate
Exit:  0 nothing to do, or everything landed - 2 something did not land (each named) -
       1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from lib import armlib, clilib
from lib import bandlib
from lib import clilib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib

# NO CAP ON EVACUATIONS (owner, 2026-09-01: "chats at their limit should always move ALL
# unarchived chats to a different account"). A per-run cap left some behind on an account that
# cannot run them, which is the whole problem. --evacuate-max still exists for a careful run.
EVACUATE_PER_RUN: int | None = None
ARCHIVE_PER_RUN = 3
# A chat whose configured mode is NOT bypassPermissions and whose newest record is a shell
# call with no result is, after this long, a permission prompt nobody is present to click -
# not a long build (2026-09-01: a deeplink-born chat is LIVE from birth, so the bypass stamp
# cannot stick, and it stalls on its very first shell call). The gate's generic stall window
# (30 min) is for chats that MAY be running real work; a default-mode chat is a doctrine
# violation whose prompt does not resolve itself, so it is NAMED sooner. unblock_prompts will
# not press for it (mode not bypass = a person's call) and this lane never moves a live chat,
# so naming it loudly, every pass, is the whole act.
PROMPT_STALL_SECS = 10 * 60
# ⛔ OPENING AN ACCOUNT IS A LAST RESORT, NOT A BALANCING MOVE (owner, standing: "only ever
# open an account if you absolutely have no more tokens"). This is reached only when EVERY
# open account is past its usage target and a chat still has to go somewhere - one per run.
OPEN_PER_RUN = 1
# Spreading only kicks in on a REAL imbalance, and moves a few at a time: shuffling chats
# between healthy accounts costs a migration each and is not free.
# Owner, 2026-09-01: "if any one account has more chats than others, when possible, it
# should be disseminated." So the trigger is a real gap of 2, not a pile of 3, and a run
# moves enough to actually converge instead of nibbling at it.
REBALANCE_GAP = 2
REBALANCE_PER_RUN = 5
# A chat moved for balance stays put for this long (live soak, 2026-09-01: the same stopped
# chats went 5claude -> work -> funzypops -> anutha23 in three passes as the "fullest"
# account changed - each landing re-imports the chat and boots an engine, so the shuffle
# burned quota and was exactly the "keeps load balancing" the owner complained about).
REBALANCE_COOLDOWN_SECS = 6 * 3600


def _moved_recently(sid: str, ledger_rows: list[dict], now_ms: int | None = None) -> bool:
    """Was this chat migrated (any 'migrate' ledger row) inside REBALANCE_COOLDOWN_SECS?"""
    import time as _t

    now_ms = now_ms if now_ms is not None else int(_t.time() * 1000)
    return any(r.get("kind") == "migrate" and r.get("session") == sid
               and now_ms - int(r.get("at") or 0) < REBALANCE_COOLDOWN_SECS * 1000
               for r in ledger_rows or [])
# How long a chat must have been quiet before the unattended lane may put it away. The gate's
# four signals say it thinks it is done; this gives it time to be wrong about that.
ARCHIVE_QUIET_SECS = 45 * 60
# A visible chat untouched this long that no lane can act on gets NAMED, every run, so it
# cannot quietly rot for days in a sidebar.
STALE_HOURS = 12


def _target_account(bands: dict, per_instance: dict[str, int], share: int,
                    exclude: set[str], landed: dict[str, int] | None = None) -> dict | None:
    """The emptiest account that may take work - OPEN OR NOT.

    Fewest-chats-first, not most-quota-first: the point of moving a chat is to spread the
    machine, and picking the emptiest account is what does that. Quota only decides who is
    ELIGIBLE (the band), never who wins among the eligible.

    ⛔⛔ AN ALREADY-OPEN ACCOUNT ALWAYS WINS. A CLOSED ONE IS THE LAST RESORT (owner, standing,
    restated 2026-09-01: "only ever open an account if you absolutely have no more tokens").
    Opening apps is the owner's call, not a load-balancing tactic - so a closed account is
    considered ONLY when every open one is past its usage target, i.e. the machine really has
    nowhere left to put the work. Two passes, open first; never one ranking with closed
    accounts winning on emptiness.

    ⛔ THE PER-ACCOUNT SHARE DELIBERATELY DOES NOT APPLY HERE. The share is a ceiling on
    RUNNING chats, and a landed chat does not run until something wakes it - saturate applies
    the ceiling at that moment. Applying it to the MOVE as well left chats stranded on a burnt
    account waiting for a window reset, which is exactly the waiting the move exists to avoid.
    """
    landed = landed or {}

    def pick(open_only: bool) -> dict | None:
        best: tuple | None = None
        chosen: dict | None = None
        for acct in bands.get("accounts", []):
            if (acct.get("band") or "unknown") in bandlib.CLOSED_BANDS:
                continue
            if not acct.get("usable", True):
                continue
            for inst in acct.get("instances", []):
                name = str(inst.get("name"))
                if name in exclude or not inst.get("signedIn", True):
                    continue
                if open_only and not inst.get("isRunning"):
                    continue
                # Count what is running there PLUS what this plan has already sent - otherwise
                # one emptier account wins every comparison and we rebuild the hog we undid.
                load = per_instance.get(name, 0) + landed.get(name, 0)
                if open_only:
                    key = (load, -float(acct.get("roomPct") or 0), name)
                else:
                    # ...and ONE closed account per plan, full stop. Once this plan has chosen
                    # a closed account and filled it to its share, a further evacuee WAITS on
                    # the burnt account rather than opening a second app. Dormant chats cost
                    # nothing sitting there; a window reset is hours away; opening apps is the
                    # owner's call. "No more tokens" earns one app, never a cascade.
                    chosen_closed = [n for n, k in landed.items() if k > 0
                                     and not any(i.get("isRunning") for a in bands.get("accounts", [])
                                                 for i in a.get("instances", []) if str(i.get("name")) == n)]
                    if chosen_closed and name not in chosen_closed:
                        continue
                    # ⛔ AMONG CLOSED ACCOUNTS, ONE AT A TIME. Emptiest-first rotates across
                    # every closed account (each is empty until chosen), so a pass that had
                    # to fall back here would have opened a DIFFERENT app for every chat it
                    # moved - twelve apps over an hour, which is exactly "you're opening all
                    # of them" (owner, 2026-09-01). An account this plan has already chosen
                    # wins until it reaches its share; only then is a second one considered.
                    already = landed.get(name, 0) > 0 and load < share
                    key = (0 if already else 1, load, -float(acct.get("roomPct") or 0), name)
                if best is None or key < best:
                    best = key
                    chosen = {"name": name, "isRunning": bool(inst.get("isRunning")),
                              "band": acct.get("band")}
        return chosen

    return pick(True) or pick(False)


def build_plan(evacuate_max: int | None = EVACUATE_PER_RUN,
               archive_max: int = ARCHIVE_PER_RUN) -> dict:
    """What the groundskeeper would do right now. Touches nothing."""
    import saturate
    from lib import deliverylib

    live, per_instance = hydralib.running_by_instance()
    # The live BLOCKS (pid included), not just the ids: a chat that is running on a burnt
    # account still has to leave, and telling "idle between turns" from "mid-turn" is the
    # difference between a safe move and interrupting work.
    try:
        live_block = {s.get("sessionId"): s
                      for s in hydralib.api_get("/api/sessions/live").get("sessions", [])}
    except hydralib.DaemonError:
        live_block = {}
    bands = bandlib.snapshot()
    open_accounts = len({str(i.get("name")) for i in hydralib.fleet().get("instances", [])
                         if i.get("isRunning")})
    share = bandlib.per_account_share(open_accounts, hydralib.MAX_RUNNING_CHATS)

    staged_by_session = {e["session"]: e for e in deliverylib.pending()}
    holds = holdlib._load()
    ledger_rows = ledgerlib._load()
    # The overlord's own chat is nobody's to archive or move (overlord.protected_session_ids):
    # it relocates itself on its own tick, and archiving it darkened the watchdog for good.
    import overlord

    protected = overlord.protected_session_ids()
    # Each chat's CONFIGURED permission mode, from the desktop stores (the same surface
    # unblock_prompts reads): duty 3 rescues a not-bypass chat sooner (PROMPT_STALL_SECS).
    from lib import stamplib

    modes: dict[str, str | None] = {}
    try:
        for store in stamplib.store_roots(hydralib.fleet()):
            for path, meta in stamplib.iter_metas(store["root"]):
                if not meta.get("isArchived"):
                    msid = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
                    modes[msid] = meta.get("permissionMode")
    except (hydralib.DaemonError, OSError):
        modes = {}  # unknown mode reads as bypass: the generic window applies, never a shorter one

    evacuate: list[dict] = []
    archive: list[dict] = []
    stranded: list[dict] = []
    stuck: list[dict] = []            # live chats stalled on a prompt - NAMED, never moved
    active_on_burnt: list[dict] = []  # live chats on a burnt account - NAMED, never moved
    # A chat whose own row is malformed, or whose gate throws, used to take the whole tick down
    # with it - one bad transcript zeroed all four duties for every OTHER chat that pass. Now it
    # is skipped and named here instead; main() prints the list loudly rather than swallowing it.
    errored: list[dict] = []
    # The plan counts its own moves forward, so a batch of evacuations cannot all pile onto
    # the same target account and recreate the hog this lane exists to undo.
    sent: dict[str, int] = {}

    for row in hydralib.visible_chats():
        sid = row.get("session_id") or ""
        try:
            inst = row.get("instance")
            if not sid or not inst or row.get("archived"):
                continue
            if holdlib.why_blocked(sid, _holds=holds):
                continue
            # THE OVERLORD IS PROTECTED FROM BEING ARCHIVED OR SHUFFLED, NOT FROM BEING RESCUED
            # (2026-09-01, the same afternoon the shield went in): it relocates itself on its own
            # tick and must never be archived here - but a manager stuck on a permission prompt
            # cannot relocate anything, and duty 3 is the one lane that frees it. So the shield
            # covers duties 1, 2 and 4 and leaves duty 3 (naming the stuck) alone.
            is_protected = sid in protected
            band = bandlib.band_of(inst, bands)
            is_live = sid in live

            # DUTY 1: stranded on an account that may take no work at all.
            if band in bandlib.CLOSED_BANDS and not is_protected:
                if ledgerlib.check("migrate", sid, _rows=ledger_rows)["suppressed"]:
                    continue
                if is_live:
                    # ⛔ NEVER MOVE AN ACTIVE CHAT (owner, 2026-09-01). A running chat on a burnt
                    # account is NAMED every pass and left where it is - moving it kills its
                    # process. It leaves through the dormant path once it has stopped.
                    active_on_burnt.append({"sessionId": sid, "title": row.get("title"),
                                            "instance": inst, "band": band,
                                            "why": "running on an account past its usage target "
                                                   "- not moved while its process lives; it "
                                                   "leaves once it stops"})
                    continue
                # EVERY dormant chat on a burnt account moves, not only the ones with work queued
                # (owner correction, 2026-09-01). A chat left there can do nothing at all until the
                # window resets - it cannot be woken, answered, or even archived, because putting it
                # away asks it to save its knowledge first, and that needs a turn the account cannot
                # pay for. Work-in-hand only decides the ORDER they leave in.
                why, _staged = saturate.wake_reason(row, staged_by_session)
                stranded.append({"sessionId": sid, "title": row.get("title"), "from": inst,
                                 "band": band, "hasWork": bool(why), "live": False,
                                 "why": why or "stuck on an account that cannot run it - "
                                               "moving it is what lets it resume"})
                continue

            # DUTY 3: NAME THE STUCK (owner, 2026-09-01: "when a chat asks for permission to run
            # something because you forgot to set the permissions, it shouldn't break the entire
            # account"). The gate names this shape exactly - a tool call with no result and
            # nothing moving. The first cut MOVED such a chat (migrate dormant, re-land with the
            # stamp); the owner's later word the same day - "never move active chats" - wins, so
            # the stuck chat is REPORTED every pass and never touched here. unblock_prompts
            # presses the prompt for a bypass chat; anything else is a person's call.
            if is_live:
                # A chat NOT configured bypassPermissions stalls on a prompt much sooner than the
                # generic window (PROMPT_STALL_SECS): its stall IS the missing stamp.
                not_bypass = modes.get(sid) not in (None, "bypassPermissions")
                v = gatelib.gate(sid, row.get("transcript_path") or "",
                                 live_block.get(sid) or {"pid": 0},
                                 stall_after_secs=PROMPT_STALL_SECS if not_bypass else None)
                if v and v.get("stalled"):
                    stuck.append({"sessionId": sid, "title": row.get("title"), "instance": inst,
                                  "band": band, "mode": modes.get(sid),
                                  "why": (f"STUCK ({modes.get(sid)} mode, never stamped): "
                                          if not_bypass else "STUCK: ")
                                         + (v["stalled"] or {}).get("why", "")[:110]
                                         + " - never moved while its process lives; a person "
                                           "answers it (unblock_prompts presses bypass chats)"})
                continue
            if is_protected:
                continue  # the overlord is never archived here (it is woken, moved or rescued)
            if len(archive) >= archive_max:
                continue
            if ledgerlib.check("archive", sid, _rows=ledger_rows)["suppressed"]:
                continue
            verdict = gatelib.gate(sid, row.get("transcript_path") or "", None)
            if not verdict or verdict["state"] != "finished":
                continue
            # THE SETTLING PERIOD (owner, 2026-09-01: "I strongly feel chats are being archived
            # when they are not completely done"). The gate's four signals say the chat BELIEVES
            # it is finished; this says it has had time to be wrong about that. A chat that ended
            # its turn ten minutes ago may still be picked back up - by the owner, by a staged
            # reply, by its own next thought - and archiving it in that window is the one mistake
            # here that costs work rather than a turn.
            if verdict.get("quiet_secs", 0) < ARCHIVE_QUIET_SECS:
                continue
            if (verdict.get("finished") or {}).get("lane") != "archive-candidate":
                continue
            archive.append({"sessionId": sid, "title": row.get("title"), "instance": inst,
                            "band": band, "why": verdict.get("cause") or "recap claims done"})
        except Exception as exc:  # one malformed chat must never zero the other three duties
            errored.append({"sessionId": sid, "title": row.get("title"), "error": str(exc)})
            continue

    # WORK IN HAND LEAVES FIRST, then the rest - but everything leaves. A chat with a staged
    # reply or its own offer to carry on can resume the moment it lands; one with nothing
    # queued still has to be somewhere it CAN be woken later.
    # DUTY 4 - REBALANCE (owner, 2026-09-01: "load balancing still seems incorrect - there's
    # multiple accounts with almost no migrated chats"). Evacuation only ever emptied accounts
    # that were BURNT, so a healthy account that happened to be open collected everything while
    # signed-in accounts nobody had opened stayed at zero forever. This moves dormant chats off
    # the fullest account onto the emptiest, opening it if it is closed, until the gap is not
    # embarrassing. Dormant only - a running chat is left to finish where it is.
    load: dict[str, int] = {}
    for row in hydralib.visible_chats():
        if row.get("archived") or not row.get("instance"):
            continue
        load[str(row["instance"])] = load.get(str(row["instance"]), 0) + 1
    # ⛔ SPREADING NEVER OPENS AN ACCOUNT (owner, standing: "only ever open an account if you
    # absolutely have no more tokens"). Rebalancing is a convenience, so it works strictly
    # among the apps the owner already has open; a closed account is not a spread target.
    usable_names = {str(i.get("name"))
                    for a in bands.get("accounts", [])
                    if (a.get("band") or "unknown") not in bandlib.CLOSED_BANDS
                    and a.get("usable", True)
                    for i in a.get("instances", [])
                    if i.get("signedIn", True) and i.get("isRunning")}
    stranded_ids = {c["sessionId"] for c in stranded} | {c["sessionId"] for c in stuck}
    if usable_names:
        fullest = max((n for n in load if n in usable_names),
                      key=lambda n: load.get(n, 0), default=None)
        thinnest = min(usable_names, key=lambda n: load.get(n, 0), default=None)
        gap = load.get(str(fullest), 0) - load.get(str(thinnest), 0)
        if fullest and thinnest and fullest != thinnest and gap >= REBALANCE_GAP:
            moved = 0
            for row in hydralib.visible_chats():
                if moved >= REBALANCE_PER_RUN or moved >= gap // 2:
                    break
                sid = row.get("session_id") or ""
                if (not sid or row.get("archived") or sid in live or sid in stranded_ids
                        or sid in protected or str(row.get("instance")) != fullest):
                    continue
                if holdlib.why_blocked(sid, _holds=holds):
                    continue
                if ledgerlib.check("migrate", sid, _rows=ledger_rows)["suppressed"]:
                    continue
                if _moved_recently(sid, ledger_rows):
                    continue  # it just landed somewhere for balance - no ping-pong
                stranded.append({
                    "sessionId": sid, "title": row.get("title"), "from": fullest,
                    "band": bandlib.band_of(fullest, bands), "hasWork": False, "live": False,
                    "why": f"spreading the load: {fullest} holds {load.get(fullest)} chats and "
                           f"{thinnest} holds {load.get(str(thinnest), 0)}"})
                moved += 1

    # A STUCK chat is moved on the same rails as a stranded one - the move IS the recovery.
    for cand in sorted(stranded, key=lambda c: (not c["hasWork"], str(c["title"] or ""))):
        if evacuate_max is not None and len(evacuate) >= evacuate_max:
            break
        target = _target_account(bands, per_instance, share,
                                 exclude={str(cand["from"])}, landed=sent)
        if not target:
            break  # every other account is cooked too - nowhere honest to put it
        sent[target["name"]] = sent.get(target["name"], 0) + 1
        evacuate.append({**cand, "to": target["name"], "toIsOpen": target["isRunning"]})

    # WHAT NOBODY IS GOING TO TOUCH (owner, 2026-09-01: "why are there so many that haven't
    # been touched in hours - open - like sweep ones which haven't been in days"). With the
    # full sidebar now visible, most stale chats land in a lane above. Anything left is a chat
    # no lane CAN act on - held, waiting on a person, or unreadable - and the honest thing is
    # to name it rather than let it rot quietly for another three days.
    import time as _t

    taken = ({r["sessionId"] for r in evacuate} | {r["sessionId"] for r in archive}
             | {c["sessionId"] for c in stranded} | {c["sessionId"] for c in stuck}
             | {c["sessionId"] for c in active_on_burnt})
    stale: list[dict] = []
    now = _t.time()
    for row in hydralib.visible_chats():
        sid = row.get("session_id") or ""
        if not sid or row.get("archived") or sid in live or sid in taken:
            continue
        tp = row.get("transcript_path") or ""
        try:
            hours = (now - Path(tp).stat().st_mtime) / 3600 if tp else None
        except OSError:
            hours = None
        if hours is None or hours < STALE_HOURS:
            continue
        held = holdlib.why_blocked(sid, _holds=holds)
        verdict = gatelib.gate(sid, tp, None)
        why = ("the owner put it on HOLD" if held
               else "no readable transcript - nothing can judge it" if not verdict
               else "a person pressed stop - theirs to resume" if (verdict.get("finished") or {}).get("interrupted")
               else "wake-able - waiting only for a free slot; the machine is at its floor"
               if saturate.wake_reason(row, staged_by_session)[0]
               else f"{verdict['state']}/{(verdict.get('finished') or {}).get('lane')} - "
                    "no lane claims this shape")
        stale.append({"sessionId": sid, "title": row.get("title"), "instance": row.get("instance"),
                      "hours": round(hours, 1), "why": why})
    stale.sort(key=lambda r: -r["hours"])

    return {"running": len(live), "perAccountShare": share,
            "runningPerInstance": per_instance,
            "evacuate": evacuate, "archive": archive, "stale": stale,
            # NAMED, never acted on (owner, 2026-09-01: active chats are never moved)
            "stuck": stuck, "activeOnBurnt": active_on_burnt,
            "strandedTotal": len(stranded),
            "strandedLeftBehind": max(0, len(stranded) - len(evacuate)),
            "errored": errored}


def execute(plan: dict, do_evacuate: bool = True, do_archive: bool = True,
            do_reap: bool = True) -> list[dict]:
    import archive_chat
    import migrate_chat

    import open_instance

    results: list[dict] = []
    if do_evacuate:
        opened: set[str] = set()
        for row in plan["evacuate"]:
            # OPEN THE TARGET ONLY BECAUSE THERE IS NOWHERE ELSE. _target_account returns a
            # closed account only after finding no OPEN account that may take work - i.e.
            # every open one is past its usage target. That is the owner's "no more tokens"
            # condition, and the only condition under which an app may be opened.
            if not row.get("toIsOpen"):
                if len(opened) >= OPEN_PER_RUN:
                    results.append({**row, "duty": "evacuate", "exit": 0, "ok": True,
                                    "outcome": "deferred - its target account is closed and "
                                               "this run already opened its quota of apps",
                                    "detail": "the next pass opens it"})
                    continue
                code_o, said_o = clilib.capture(open_instance.main, [str(row["to"])])
                opened.add(str(row["to"]))
                if code_o != 0:
                    results.append({**row, "duty": "evacuate", "exit": code_o, "ok": False,
                                    "outcome": f"could NOT open {row['to']}",
                                    "detail": (said_o.splitlines()[-1][:160] if said_o else "")})
                    continue
                time.sleep(8)  # let the app finish coming up before importing into it
            # ⛔ NO LIVE PATH ANY MORE (owner, 2026-09-01: "never move active chats"). The
            # daemon /migrate route that stopped a live writer and re-landed the chat lived
            # here; every row in plan["evacuate"] is DORMANT now, and migrate_chat refuses a
            # live writer by its own rule, so nothing below can move a chat with a process.
            # A LANDING BOOTS AN ENGINE (live soak, 2026-09-01: 29 engines alive against the
            # owner's cap of 18, most of them booted by evacuations) - so at the cap a move is
            # deferred, exactly as a wake or a delivery is.
            try:
                running_now = hydralib.running_count()
            except hydralib.DaemonError as err:
                results.append({**row, "duty": "evacuate", "exit": 1, "ok": False,
                                "outcome": "did NOT move - the running count could not be read",
                                "detail": str(err)[:160]})
                continue
            if running_now >= hydralib.MAX_RUNNING_CHATS:
                results.append({**row, "duty": "evacuate", "exit": 0, "ok": True,
                                "outcome": "deferred - the machine is at its running cap "
                                           f"({running_now} of {hydralib.MAX_RUNNING_CHATS}); a "
                                           "landing boots an engine",
                                "detail": "the reaper frees idle engines; the next pass retries"})
                continue
            code, out = clilib.capture(migrate_chat.main, [row["sessionId"], "--to", row["to"]])
            results.append({**row, "duty": "evacuate", "exit": code, "ok": code == 0,
                            "outcome": (f"moved to {row['to']}" if code == 0
                                        else "did NOT move"),
                            "detail": (out.splitlines()[-1][:160] if out else "")})
    if do_archive:
        for row in plan["archive"]:
            code, out = clilib.capture(archive_chat.main, [row["sessionId"]])
            # 8 is the owner's knowledge-preservation step in flight, not a failure: the chat
            # was asked to update its markdown and archives on a later pass once it has.
            outcome = ("archived" if code == 0
                       else "asked to preserve its knowledge first (or another run holds it) "
                            "- archives next pass"
                       if code == 8 else "did NOT archive")
            results.append({**row, "duty": "archive", "exit": code, "ok": code in (0, 8),
                            "outcome": outcome,
                            "detail": (out.splitlines()[-1][:160] if out else "")})
    if do_reap:
        results.extend(reap_idle_engines())
    return results


# DUTY 5 - REAP (live soak, 2026-09-01). The desktop never stops a chat's engine on its own,
# so every chat ever touched keeps a claude.exe alive: 29 live engines against the owner's
# cap of 18 "for the sake of not murdering my computer", 17 of them IDLE. The cap then
# deferred every delivery and every wake - the fleet clogged with processes doing nothing.
# When the count is over the cap, the longest-idle engines are stopped (lib/enginelib: turn
# finished, quiet REAP_IDLE_SECS, gate says idle, never stuck or mid-turn) until it is not.
# A stopped chat is unchanged; its next instruction boots a fresh engine.
REAP_IDLE_SECS = 10 * 60


def reap_idle_engines() -> list[dict]:
    from lib import enginelib
    import overlord

    try:
        live = hydralib._live_endpoint()
        rows = {r.get("session_id"): r for r in hydralib.sessions()}
    except hydralib.DaemonError as err:
        return [{"duty": "reap", "exit": 1, "ok": False, "title": "",
                 "outcome": "reaper skipped - the fleet could not be read", "detail": str(err)[:160]}]
    if not live:
        return []
    over = int(live.get("count") or 0) - hydralib.MAX_RUNNING_CHATS
    if over <= 0:
        return []
    protected = overlord.protected_session_ids()
    cands = []
    for s in live.get("sessions", []):
        sid = str(s.get("sessionId") or "")
        if not sid or sid in protected or holdlib.why_blocked(sid):
            continue
        row = rows.get(sid) or {}
        match = {"cliSessionId": sid, "title": row.get("title") or s.get("title") or "",
                 "instance": row.get("instance"), "live": {"pid": s.get("pid")}}
        idle, why = enginelib.idle_verdict(match, REAP_IDLE_SECS)
        if idle:
            quiet = int(str(why).split("quiet ")[-1].split("s")[0] or 0) if "quiet " in str(why) else 0
            cands.append((quiet, match, why))
    cands.sort(key=lambda c: -c[0])
    results = []
    for quiet, match, why in cands[:over]:
        got = enginelib.stop_idle_engine(match, REAP_IDLE_SECS)
        results.append({"duty": "reap", "sessionId": match["cliSessionId"], "title": match["title"],
                        "instance": match.get("instance"), "from": match.get("instance"), "to": None,
                        "why": f"over the running cap by {over}: {why}",
                        "exit": 0 if got.get("stopped") else 1, "ok": bool(got.get("stopped")),
                        "outcome": (f"stopped idle engine pid {got.get('pid')} ({why})" if got.get("stopped")
                                    else f"did NOT stop: {got.get('why')}"),
                        "detail": f"over the cap by {over}"})
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
        refusal = armlib.refuse_unless_armed(argv, "the groundskeeper's duties")
        if refusal:
            print(refusal)
            act = False
    do_evac = "--only-archive" not in argv
    do_arch = "--only-evacuate" not in argv
    ev_max = int(argv[argv.index("--evacuate-max") + 1]) if "--evacuate-max" in argv else EVACUATE_PER_RUN
    ar_max = int(argv[argv.index("--archive-max") + 1]) if "--archive-max" in argv else ARCHIVE_PER_RUN

    try:
        plan = build_plan(ev_max if do_evac else 0, ar_max if do_arch else 0)
        results = execute(plan, do_evac, do_arch) if act else []
    except hydralib.DaemonError as err:
        print(f"groundskeeper FAILED: {err}", file=sys.stderr)
        return 1
    except Exception as err:  # one crash must never look like a silent, clean no-op tick
        import traceback

        print(f"groundskeeper CRASHED: {err}", file=sys.stderr)
        traceback.print_exc()
        return 1

    if plan.get("errored"):
        print(f"{len(plan['errored'])} chat(s) errored in planning: " + "; ".join(
            f"{e.get('title') or e['sessionId']}: {e['error']}" for e in plan["errored"]),
            file=sys.stderr)
    if as_json:
        print(json.dumps({**plan, "results": results}, indent=2))
    else:
        print(f"{plan['running']} running, share {plan['perAccountShare']} per account - "
              f"{plan['runningPerInstance']}")
        if not plan["evacuate"] and not plan["archive"]:
            print("nothing dormant needs moving or putting away.")
        for r in plan.get("stale", []):
            print(f"  ?? [stale {r['hours']:.0f}h] {r['title']} ({r['instance']}): {r['why']}")
        # Live chats are NAMED here and never moved (owner, 2026-09-01) - a person reads these.
        for r in plan.get("stuck", []):
            print(f"  !! [STUCK - not moved] {r['title']} ({r['instance']}): {r['why']}")
        for r in plan.get("activeOnBurnt", []):
            print(f"  !! [active on a burnt account - not moved] {r['title']} ({r['instance']}): {r['why']}")
        if plan.get("strandedLeftBehind"):
            print(f"  ⚠ {plan['strandedLeftBehind']} chat(s) STAY on a burnt account this pass "
                  "(per-run cap, or every other open account is cooked too) - next pass takes them.")
        for r in (results or plan["evacuate"] + plan["archive"]):
            duty = r.get("duty") or ("evacuate" if "to" in r else "archive")
            mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
            where = f"{r['from']} -> {r['to']}" if duty == "evacuate" else str(r.get("instance"))
            # Every duty's rows print through here; a row missing a field must never take the
            # whole report down (2026-09-01: the first reap rows lacked 'why' and the tick
            # died AFTER acting, with a traceback for a report that had already happened).
            print(f"  {mark}[{duty}] {r.get('title')} ({where}): {r.get('why', '')}"
                  + (f" -> {r.get('outcome')}" if results else ""))
        if not act and (plan["evacuate"] or plan["archive"]):
            print("\nPLAN ONLY - nothing touched. Add --yes to act.")
    return 2 if [r for r in results if not r["ok"]] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
