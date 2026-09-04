#!/usr/bin/env python3
"""dashboard.py - OBSERVE ONLY: the decision dashboard, in a browser.

Serves scripts/dashboard.html plus JSON endpoints that answer, for every chat on the fleet:
what state is it in, what WOULD the orchestrator do about it, why, and which account it sits
on. Buttons on the page run these queries; nothing on the page can act.

READ-ONLY BY CONSTRUCTION: this server defines no POST handler at all, and its data layer
calls only the daemon's GET endpoints. The 'act' column on the page is a command you can copy
into a terminal, never a button that fires.

Usage: python dashboard.py [--port 7799] [--open]
Exit:  runs until Ctrl+C. --open launches the default browser at the page.
"""

from __future__ import annotations

import json
import sys
import time
import webbrowser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from lib import clilib, gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib

DEFAULT_PORT = 7799
HTML_PATH = Path(__file__).resolve().parent / "dashboard.html"


def decide(verdict: dict | None, breaker: dict | None, app_running: bool, why_ungated: str = "",
           hold_why: str | None = None, manager: bool = False) -> dict:
    """Map a gate verdict onto WHAT THE ORCHESTRATOR WOULD DO - the one place that mapping
    lives, so the page, the tests, and any future sweep read the same answer.

    Returns {action, kind, detail, command}. kind is one of:
    archive / wait-on-person / judgment / resume / leave-alone / human / held-back / on-hold /
    cannot.
    """
    if hold_why:
        # A person's hands-off switch outranks every verdict below it.
        return {"action": "nothing - the owner put this chat on HOLD", "kind": "on-hold",
                "detail": hold_why, "command": None}
    if manager:
        # THE STANDING MANAGER CHAT IS THE WATCHDOG'S OWN (overlord.protected_session_ids;
        # 2026-09-04). Its recap always offers to carry on, so every other lane read it as
        # work: the archive lane filed it, the interview replied to spares and woke them,
        # saturate woke them - and each woken manager armed its own /orchestrate loop. One
        # owner per responsibility: overlord.py wakes, relocates and names it; nothing else
        # archives, moves, judges or wakes a manager unattended.
        return {"action": "leave alone - a standing manager chat (the watchdog's own)",
                "kind": "leave-alone",
                "detail": ("Born from the manager prompt or titled 'Orchestrate': overlord.py "
                           "owns it. A spare is retired by a person (archive_chat --force), "
                           "never by a lane."),
                "command": "python scripts/overlord.py --status"}
    if verdict is None:
        return {
            "action": "nothing - cannot be gated",
            "kind": "cannot",
            "detail": why_ungated or "no transcript on disk; a thing that cannot be gated cannot be acted on",
            "command": None,
        }
    sid = verdict["session_id"]
    if verdict["state"] == "running":
        if verdict.get("stalled"):
            s = verdict["stalled"]
            return {
                "action": f"flag for a human - looks STUCK on '{s['tool']}'",
                "kind": "judgment",
                "detail": s["why"] + " Never act on a live chat.",
                "command": f"python scripts/gate_chat.py {sid}",
            }
        if verdict.get("idle"):
            mins = verdict["idle"]["quiet_secs"] // 60
            return {
                "action": f"needs a decision - IDLE {mins}min with a live writer",
                "kind": "judgment",
                "detail": (
                    "It finished its turn and is waiting for its next instruction: answer it, "
                    "nudge it onward, or hand it off. Never archive - it still has a writer."
                ),
                "command": f"python scripts/gate_chat.py {sid}",
            }
        return {
            "action": "leave alone - working",
            "kind": "leave-alone",
            "detail": verdict["cause"],
            "command": None,
        }
    if verdict["state"] == "crashed":
        kind = verdict["crashed"]["kind"]
        extra = {
            "usage-limit": "resume once the quota window resets, or migrate it to an account with headroom",
            "overload": "transient server overload - a resume will usually just work",
            "refused": "a safeguard refusal ended it - a person should read it before resuming",
            "error": "an API error ended it - read the tail, then resume",
            "mid-turn": "it died mid-turn (kill, restart, crash) - a resume candidate",
        }.get(kind, "")
        return {
            "action": f"resume candidate - crashed ({kind})",
            "kind": "resume",
            "detail": extra,
            "command": f"python scripts/dossier.py {sid}",
        }
    fin = verdict["finished"]
    if fin["lane"] == "human":
        return {
            "action": "leave for the person who interrupted it",
            "kind": "human",
            "detail": "A person pressed stop - deliberately theirs to pick back up.",
            "command": None,
        }
    if fin["lane"] == "needs-input-review":
        reason = (
            "it OFFERS TO CARRY ON and is waiting to be told to"
            if fin["offers_to_continue"]
            else "it ends on a question"
            if fin["ends_with_question"]
            else f"the recap does not claim done ({fin['done_claim']})"
        )
        return {
            "action": "answer it - waiting on a person",
            "kind": "wait-on-person",
            "detail": f"{reason}. Never archive a chat that is waiting for a word.",
            "command": f"python scripts/gate_chat.py {sid}",
        }
    # archive-candidate
    if breaker and breaker.get("suppressed"):
        return {
            "action": "would archive - but HELD BACK by the breaker",
            "kind": "held-back",
            "detail": breaker["why"],
            "command": f"python scripts/attempts.py",
        }
    if app_running:
        return {
            "action": "ARCHIVE via the app's own control (its app is running)",
            "kind": "archive",
            "detail": (
                "The gate says archive-candidate. archive_chat drives the running app's OWN "
                "archive control - immediate and durable, because the app makes the write "
                "itself. Restarting is never an option (owner's standing order)."
            ),
            "command": f"python scripts/archive_chat.py {sid}",
        }
    return {
        "action": "ARCHIVE (after re-check + verify)",
        "kind": "archive",
        "detail": "Recap says done, nothing asked, no offer to carry on, no live writer.",
        "command": f"python scripts/archive_chat.py {sid}",
    }


@dataclass
class _RowEvaluation:
    """One row of the plan, already gated and decided. incomplete marks a failed liveness
    read (the row still gets a best-effort chat entry, but the plan as a whole is not
    'complete')."""
    chat: dict
    decision_kind: str
    incomplete: bool


def _gate_row(sid: str, row: dict) -> tuple[dict | None, str, bool]:
    """Resolve one row's gate verdict. Returns (verdict, why_ungated, incomplete)."""
    try:
        live = hydralib.live_for(sid)
        verdict = gatelib.gate(sid, row.get("transcript_path") or "", live)
        why_ungated = ""
        if verdict is None:
            _, why_ungated = gatelib.gateable(row.get("transcript_path") or "")
        return verdict, why_ungated, False
    except hydralib.DaemonError as err:
        return None, f"liveness read failed ({err}) - no verdict without it", True


def _breaker_for(verdict: dict | None, sid: str) -> dict | None:
    """The archive circuit-breaker only ever applies to an archive-candidate verdict."""
    if verdict and verdict["state"] == "finished" and verdict["finished"]["lane"] == "archive-candidate":
        return ledgerlib.check("archive", sid)
    return None


def _evidence_for(verdict: dict | None) -> str:
    if not verdict:
        return ""
    src = verdict.get("finished") or verdict.get("idle") or {}
    return (src.get("last_assistant_text") or "")[-400:]


def _plan_chat_entry(row: dict, sid: str, inst: dict | None, verdict: dict | None,
                     why_ungated: str, decision: dict) -> dict:
    return {
        "sessionId": sid,
        "title": row.get("title"),
        "instance": row.get("instance"),
        # RESIDENCE (owner doctrine): a chat with a desktop record lives in the desktop
        # and stays there; instance null = console-only, never landed in the app.
        "origin": "desktop" if row.get("instance") else "console",
        "sourceTool": row.get("tool") or row.get("source"),
        "account": {"email": inst and inst["email"], "plan": inst and inst["plan"],
                    "appRunning": bool(inst and inst["isRunning"])} if inst else None,
        "state": verdict["state"] if verdict else "ungated",
        "cause": verdict["cause"] if verdict else why_ungated,
        "lastActivityAt": row.get("last_activity_at"),
        "decision": decision,
        "evidence": _evidence_for(verdict),
    }


def _evaluate_plan_row(row: dict, instances: dict, holds: dict,
                       protected: set | frozenset = frozenset()) -> _RowEvaluation:
    """Gate one row, decide what the orchestrator would do about it, and shape the chat
    entry the page renders - the whole per-row pipeline build_plan loops over."""
    sid = row.get("session_id") or ""
    inst = instances.get(str(row.get("instance") or "").lower())
    verdict, why_ungated, incomplete = _gate_row(sid, row)
    breaker = _breaker_for(verdict, sid)
    decision = decide(verdict, breaker, bool(inst and inst["isRunning"]), why_ungated,
                      holdlib.why_blocked(sid, _holds=holds), manager=sid in protected)
    chat = _plan_chat_entry(row, sid, inst, verdict, why_ungated, decision)
    return _RowEvaluation(chat=chat, decision_kind=decision["kind"], incomplete=incomplete)


_PLAN_ORDER = ["wait-on-person", "judgment", "archive", "held-back", "resume", "human",
               "cannot", "on-hold", "leave-alone"]


def _plan_sort_key(chat: dict):
    kind = chat["decision"]["kind"]
    return (_PLAN_ORDER.index(kind) if kind in _PLAN_ORDER else 99,
            str(chat["instance"] or ""), str(chat["title"] or ""))


def build_plan() -> dict:
    """The dry run: every visible chat, gated, decided, account-attributed. Touches nothing."""
    instances = hydralib.instances_by_name()
    rows = [s for s in hydralib.sessions() if not s.get("archived")]
    # ONE holds snapshot for the whole plan (this is a read-only surface; every act script
    # re-checks holds fresh at T-0) - per-row reloads also opened the read-clobber window
    # holdlib.check used to have (adversarial review, 2026-08-31).
    holds = holdlib._load()
    # THE MANAGERS ARE THE WATCHDOG'S (2026-09-04): one snapshot of overlord.protected_session_ids
    # for the whole plan, so no lane downstream (archive, judgment, wake) ever reads a standing
    # manager chat as work. It swallows daemon errors itself; a failed read protects nothing
    # extra, the same posture as a failed holds read.
    import overlord

    protected = overlord.protected_session_ids()
    chats = []
    counts: dict[str, int] = {}
    incomplete = 0
    for row in rows:
        result = _evaluate_plan_row(row, instances, holds, protected)
        if result.incomplete:
            incomplete += 1
        counts[result.decision_kind] = counts.get(result.decision_kind, 0) + 1
        chats.append(result.chat)
    chats.sort(key=_plan_sort_key)
    return {
        "generatedAt": int(time.time() * 1000),
        "scanned": len(rows),
        "complete": incomplete == 0,
        "incompleteWhy": None if incomplete == 0 else f"{incomplete} chat(s) had a failed liveness read",
        "counts": counts,
        "chats": chats,
    }


def build_chats() -> dict:
    instances = hydralib.instances_by_name()
    rows = hydralib.sessions()
    out = []
    for r in sorted(rows, key=lambda r: r.get("last_activity_at") or 0, reverse=True):
        inst = instances.get(str(r.get("instance") or "").lower())
        out.append({
            "sessionId": r.get("session_id"),
            "title": r.get("title"),
            "instance": r.get("instance"),
            "origin": "desktop" if r.get("instance") else "console",
            "sourceTool": r.get("tool") or r.get("source"),
            "account": {"email": inst and inst["email"], "plan": inst and inst["plan"]} if inst else None,
            "archived": bool(r.get("archived")),
            "lastActivityAt": r.get("last_activity_at"),
            "preview": str(r.get("last_text_preview") or "")[:200],
        })
    return {"generatedAt": int(time.time() * 1000), "total": len(out), "chats": out}


def build_instances() -> dict:
    rows = hydralib.sessions()
    per_instance: dict[str, int] = {}
    for r in rows:
        if not r.get("archived"):
            key = str(r.get("instance") or "").lower()
            per_instance[key] = per_instance.get(key, 0) + 1
    out = []
    for i in hydralib.instances_by_name().values():
        out.append({**i, "visibleChats": per_instance.get(str(i["name"]).lower(), 0)})
    out.sort(key=lambda i: (not i["isRunning"], i["num"] if i["num"] is not None else 999))
    return {"generatedAt": int(time.time() * 1000), "instances": out}


def build_suppressed() -> dict:
    from lib import incidentlib

    return {"generatedAt": int(time.time() * 1000), "suppressed": ledgerlib.suppressed(),
            "holds": [{**h, "why": holdlib.why_blocked(h["session"])} for h in holdlib.held()],
            # A count only - the incidents themselves are /data/incidents, same split as
            # the accounts strip (a headline number here, the detail behind its own route).
            "incidentsOpen": incidentlib.count_incidents("open") + incidentlib.count_incidents("acked")}


def build_incidents() -> dict:
    from lib import incidentlib

    return {"generatedAt": int(time.time() * 1000), "incidents": incidentlib.list_incidents()}


def build_accounts() -> dict:
    """The account strip + the load-balancing plan. Slow-ish: the daemon's usage survey may
    re-check accounts (seconds), which is why the page loads this panel asynchronously."""
    import balance  # late import; balance also imports this module's build_plan

    return {"generatedAt": int(time.time() * 1000), **balance.build()}


def build_scripts() -> dict:
    """WHAT EVERY SCRIPT DOES - read from each file's own docstring at request time, so a
    description can never drift from the script it describes (the same discipline the rules
    panel follows). Kind and exit codes come from the docstring's own conventions."""
    import ast

    here = Path(__file__).resolve().parent
    KIND_HINT = {
        "observe": "observe", "OBSERVE": "observe", "ACT": "act",
        "act": "act", "lib": "lib",
    }
    rows = []
    # Runnable scripts sit at the top level; the shared libraries live in lib/ and are listed
    # too - "what does each piece do" includes the pieces scripts import.
    for path in sorted(here.glob("*.py")) + sorted((here / "lib").glob("*.py")):
        if path.name.startswith("test_") or path.name == "__init__.py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            doc = ast.get_docstring(tree) or ""
        except (OSError, SyntaxError):
            continue
        lines = [l.rstrip() for l in doc.splitlines()]
        headline = lines[0] if lines else ""
        # "name.py - KIND: one-line summary" is the house docstring shape.
        summary = headline.split(" - ", 1)[1] if " - " in headline else headline
        kind = "lib"
        low = summary.lower()
        if low.startswith("act") or " act:" in low[:24]:
            kind = "act"
        elif low.startswith("observe"):
            kind = "observe"
        elif path.name.endswith("lib.py"):
            kind = "lib"
        elif "act (" in low[:24]:
            kind = "act"
        # The body: everything before the Usage/Exit block, kept as the "why it exists".
        body: list[str] = []
        for l in lines[1:]:
            if l.startswith(("Usage:", "Exit:")):
                break
            body.append(l)
        usage = next((l for l in lines if l.startswith("Usage:")), "")
        exits = ""
        take = False
        for l in lines:
            if l.startswith("Exit:"):
                take = True
            elif take and (not l.strip() or l.startswith("Usage:")):
                break
            if take:
                exits += (" " if exits else "") + l.strip()
        rows.append({
            "name": path.name,
            "kind": kind,
            "summary": summary,
            "detail": "\n".join(body).strip(),
            "usage": usage,
            "exits": exits,
        })
    order = {"observe": 0, "act": 1, "lib": 2}
    rows.sort(key=lambda r: (order.get(r["kind"], 3), r["name"]))
    return {"generatedAt": int(time.time() * 1000), "scripts": rows}


def build_rules() -> dict:
    """THE IF-THIS-THEN-THAT TREE, LISTED - every configured rule with its LIVE value, read
    from the constants the code actually runs. Nothing here is hand-copied prose: change a
    threshold in gatelib/ledgerlib/balance and this listing changes with it."""
    import balance

    g = [
        {"if": "the dossier shows a process attached to the chat",
         "then": "state = RUNNING - never archive, whatever else looks true",
         "value": "live is the dossier's word, not a guess"},
        {"if": f"RUNNING, quiet >= {gatelib.STALL_QUIET_SECS // 60} min, and the newest record is a shell tool call with no result",
         "then": "flag as STUCK for a human - report only, never act on a live chat",
         "value": f"quiet >= {gatelib.STALL_QUIET_SECS // 60} min AND tool matches /{gatelib.SHELL_TOOLS.pattern}/"},
        {"if": f"RUNNING, its last turn COMPLETED, and it has been quiet >= {gatelib.IDLE_AFTER_SECS // 60} min",
         "then": "mark IDLE - it is waiting for its next instruction; judgment lane (answer / nudge / hand off)",
         "value": f"idle after {gatelib.IDLE_AFTER_SECS} s"},
        {"if": "no writer, and the tail ends on an unanswered user message, a dangling tool call, or pure tool traffic",
         "then": "state = CRASHED (mid-turn) - resume candidate",
         "value": "structural read of the last JSONL records"},
        {"if": "no writer, and the last record is an API error",
         "then": "CRASHED, kind by the daemon's own vocabulary: usage-limit / overload / refused / error",
         "value": (f"quota: /{gatelib._QUOTA.pattern}/ · transient: /{gatelib._TRANSIENT.pattern}/ · "
                   "refused: literal 'safeguards flagged this message' · anything else: error")},
        {"if": "the last user record is '[Request interrupted by user]'",
         "then": "FINISHED · human lane - deliberately theirs to pick back up",
         "value": "exact-match on the interrupt marker"},
        {"if": "the last assistant text OFFERS TO CARRY ON (in the recap view: fenced code and quoted lines stripped)",
         "then": "FINISHED · waiting on a person - answer it, NEVER archive (the v2 bug this rewrite exists for)",
         "value": f"/{gatelib.OFFER_TO_CONTINUE.pattern}/"},
        {"if": "the recap under '## Am I 100% done?' says yes, the text does not end in '?', and no offer matched",
         "then": "FINISHED · ARCHIVE CANDIDATE - the only state the act rails accept",
         "value": "all three must hold; anything else -> waiting on a person"},
        {"if": "the transcript is missing or not Claude Code JSONL (e.g. an opencode .db)",
         "then": "UNGATED - a thing that cannot be gated cannot be acted on, and saying so beats guessing",
         "value": "gateable() refuses non-.jsonl"},
    ]
    a = [
        {"if": "a person has put the chat ON HOLD (hold_chat.py, reason required)",
         "then": "the unattended machinery leaves it alone entirely - the hold outranks every gate verdict and the breaker; the chat stays visible, labeled held",
         "value": "a direct request (--force) is never blocked by a hold; holds live in state/holds.json until released or expired"},
        {"if": f"the same act on the same chat has run {ledgerlib.ATTEMPT_CAP}+ times inside the window",
         "then": "HELD BACK by the breaker, loudly (success clears the count; a person's direct word overrides)",
         "value": f"cap {ledgerlib.ATTEMPT_CAP} per {ledgerlib.ATTEMPT_WINDOW_MS // 3600_000} h sliding window"},
        {"if": "an attempt failed DETERMINISTICALLY (no match, two rows share a title, a 400/409 the daemon will repeat)",
         "then": "suppressed after ONE, and the row outlives the window until cleared by success or a person",
         "value": "deterministic rows never age out"},
        {"if": "the chat moved (or grew a writer) between deciding and acting",
         "then": "ABORT - a person's word is the highest input; re-decide against the new state",
         "value": "fresh dossier read immediately before every POST"},
        {"if": "the instance's app is RUNNING when an archive is due",
         "then": "drive the APP'S OWN archive control (focus-free UI Automation) - immediate and durable, because the app makes the write itself. NEVER write a disk flag under a running app, and NEVER wait for a restart (the owner does not restart the apps, ever)",
         "value": "archive_chat.py routes by app state: running -> actuator/manage_desktop_chat.ps1 Archive; closed -> disk flags"},
        {"if": "the daemon said ok",
         "then": "still VERIFY by re-reading the dossier before claiming anything landed",
         "value": "no verification, no success claim"},
    ]
    b = [
        {"if": "a chat has a desktop record (an instance name on its row)",
         "then": "it LIVES in the desktop and stays there - nothing ever moves a chat out of the desktop",
         "value": "owner doctrine; import-desktop is the only mover and it only lands INTO desktop instances"},
        {"if": "a session is console-only (no instance on its row)",
         "then": "it MUST be landed in a desktop instance, then dispositioned there (archive / resume note / answer) - the owner reads chats only in the desktop",
         "value": "owner mandate 2026-08-31; sweep.py --land-console executes it"},
        {"if": f"an OPEN account's peak usage (5-hour or weekly) is over the {balance.SOFT_TARGET_PCT}% target (or the daemon itself says offload)",
         "then": "it is UNDER PRESSURE - movable chats on it get a planned move",
         "value": f"soft target {balance.SOFT_TARGET_PCT}%; daemon shouldOffload outranks the number"},
        {"if": f"an OPEN account's peak usage reaches the {balance.HARD_GATE_PCT}% HARD GATE",
         "then": "EVACUATION is mandatory, not advice - its movable chats move to accounts with room",
         "value": f"hard gate {balance.HARD_GATE_PCT}% on either window (owner rule 2026-08-31)"},
        {"if": f"an account sits comfortably UNDER the {balance.SOFT_TARGET_PCT}% target",
         "then": "DELIBERATE FILL: it takes migrations and simpler new chats so paid capacity is not wasted - up to its plan-sized ceiling",
         "value": "fill ceiling = target minus plan leeway (Max 20x: -2, Max 5x: -5, Pro/unknown: -10); owner 2026-08-31: 'so we don't have wasted potential'"},
        {"if": f"a CLOSED account is past the pressure line",
         "then": "that is the orchestrator's own DO-NOT-OPEN note, never a notification for the owner - nothing burns on a closed app",
         "value": "owner directive 2026-08-31: 'that is merely a notification for yourself'"},
        {"if": "work must be handed off (delegation via orchestration)",
         "then": "hand to an OPEN account with fill-room; open a fresh account only when no open one qualifies, and say that opening is required",
         "value": f"open-first, most room under the fill ceiling wins; readings older than {balance.FRESH_HOURS} h are stale and never planned on"},
        {"if": "several chats need moving at once",
         "then": "SPREAD, never dump: targets rotate round-robin (open accounts first) and each planned move debits the target's room - many moves land across many accounts instead of murdering one 5-hour window",
         "value": "owner 2026-08-31: 'load balance across all of them, not mass-migrate to the least used'"},
        {"if": f"{hydralib.MAX_RUNNING_CHATS} chats are already RUNNING machine-wide",
         "then": "anything that would WAKE another chat (a delivery, a revive, a compact turn) DEFERS - it stays staged and the next 5-minute cycle retries it (the round robin)",
         "value": f"owner 2026-08-31: cap {hydralib.MAX_RUNNING_CHATS} 'for the sake of not murdering my computer'"},
        {"if": "a chat has a LIVE writer",
         "then": "it NEVER moves (the import rewrites the transcript; the daemon refuses live sessions too)",
         "value": "no exception, --force included"},
        {"if": "a chat lands in the desktop (fresh imports arrive NAMELESS and render generic)",
         "then": "THE NAMING PASS runs as part of the landing: probe-rename one indistinguishable row, learn which chat took it from the app's own re-save, set its real title through the daemon; repeat. A chat with no known real name is QUARANTINED for an AI to name - never guessed",
         "value": "name_chats.py + actuator/rename_first.ps1, auto after sweep --land-console; proven 11/11 live, no restart"},
    ]
    w = [
        {"if": "a chat's STATE must be determined (running / idle / stuck / crashed / finished / lane)",
         "then": "CODE decides - deterministic read of transcript bytes + the dossier; no AI anywhere in it",
         "value": "gatelib.gate()"},
        {"if": "an archive candidate, a load-balancing move, or a console-stray landing must be EXECUTED",
         "then": "CODE executes, batched - one command runs the whole predetermined plan within caps and reports every exit",
         "value": f"python scripts/sweep.py --all --yes (per-lane cap {__import__('sweep').DEFAULT_MAX_PER_LANE}, plan-only without --yes)"},
        {"if": "a chat is WAITING ON A PERSON or IDLE (the judgment queue)",
         "then": "THE AI decides WHAT TO SAY (code never composes a reply), stages it with stage_reply.py, and the COURIER types it into the chat",
         "value": "courier.py, or sweep.py --deliver; staging and sending are deliberately separate acts"},
        {"if": "a staged reply is about to be delivered",
         "then": "checked in this order: HELD? breaker? resolves to exactly one chat? turn IN FLIGHT (never interrupt)? verify-snippet present? then send, then CONFIRM the chat actually moved",
         "value": "an idle live chat is the normal target; a mid-turn chat is never touched; 'sent but did not move' is reported as NOT delivered"},
        {"if": "a STUCK-looking live chat is flagged",
         "then": "A HUMAN OR AI READS IT - a genuinely long command looks identical from outside; report only",
         "value": "never acted on by code"},
        {"if": "a job should run on its own schedule (dashboard keepalive, reconcile, the to-do sweep)",
         "then": "WINDOWS TASK SCHEDULER runs it from this repo - never the desktop app's own config, and never AgentHydra's queue (that queue launches chats, and headless runs are hard-refused by owner law)",
         "value": "scripts/schedule_jobs.py (--apply / --status / --remove); every job logs to state/logs and SKIPS itself when the daemon is not answering"},
        {"if": "usage numbers are needed anywhere",
         "then": "always obtained THROUGH AGENTHYDRA (its whole-fleet survey; its advice fields outrank re-derived math)",
         "value": "GET /api/usage/survey - never scraped, never guessed, never read off fleet rows"},
    ]
    return {"generatedAt": int(time.time() * 1000), "sections": [
        {"title": "Who decides - code vs the AI", "rules": w},
        {"title": "The gate - classification", "rules": g},
        {"title": "The act rails - archiving", "rules": a},
        {"title": "Residence & load balancing", "rules": b},
    ]}


ROUTES = {
    "/data/plan": build_plan,
    "/data/chats": build_chats,
    "/data/instances": build_instances,
    "/data/suppressed": build_suppressed,
    "/data/incidents": build_incidents,
    "/data/accounts": build_accounts,
    "/data/rules": build_rules,
    "/data/scripts": build_scripts,
    "/data/health": lambda: {"daemon": hydralib.health(), "daemonUrl": hydralib.BASE},
}


class Handler(BaseHTTPRequestHandler):
    # NO do_POST on purpose: the base class answers 501 for anything but GET, which makes
    # 'this page cannot act' a structural property rather than a promise.

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                body = HTML_PATH.read_bytes()
                self._send(200, "text/html; charset=utf-8", body)
                return
            fn = ROUTES.get(path)
            if fn is None:
                self._send(404, "application/json", b'{"error":"no such route"}')
                return
            payload = fn()
            self._send(200, "application/json", json.dumps(payload).encode())
        except hydralib.DaemonError as err:
            # A failed read must never render as an empty fleet - the page shows this loudly.
            self._send(502, "application/json", json.dumps({"error": str(err)}).encode())
        except Exception as err:  # noqa: BLE001 - a dashboard must not die mid-request
            self._send(500, "application/json", json.dumps({"error": f"{type(err).__name__}: {err}"}).encode())

    def _send(self, status: int, ctype: str, body: bytes):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    port = DEFAULT_PORT
    if "--port" in argv:
        port = int(argv[argv.index("--port") + 1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"orchestrator dashboard (READ-ONLY) at {url}  -  Ctrl+C stops it")
    if "--open" in argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
