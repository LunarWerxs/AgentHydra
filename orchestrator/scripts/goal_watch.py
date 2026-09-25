#!/usr/bin/env python3
"""goal_watch.py - ACT: keep a chat's standing goal moving, and audit it while it moves.

WHY: the /goal command writes a standing goal to `tmp/handoff/GOAL.md` (STATUS: IN PROGRESS, a
NEXT checklist) so it survives a chat swap, but nothing outside the chat ever read it back. A chat
that stopped at a milestone sat idle with its goal unfinished until a person typed "keep going",
and nothing told it how to tell progress from a status restatement, or a finished goal from one
that had shrunk to fit what passed. Idea adapted from OpenAI Codex's goal continuation and
budget-limit prompts (Apache-2.0); the rules and wording are lib/goallib.py's own.

WHAT IT DOES, every tick:
  1. every LIVE chat whose working folder has a goal file (lib/goallib.find_goal_file) and whose
     own transcript has named that file (only an owner continues a goal, never a bystander in the
     same repo) is read;
  2. a goal that is not STATUS: IN PROGRESS (DONE, BLOCKED, anything the chat wrote) is left alone;
  3. a chat whose turn has ENDED and been quiet goalwatch.quiet_secs gets ONE continuation through
     the composer: continue from NEXT, first label the last turn PROGRESS / VERIFIED WAIT / NO
     PROGRESS, prove DONE item by item, never shrink the goal;
  4. THE OUTSIDE AUDIT: a continuation that leaves the goal file byte-identical counts as no
     progress, and the next one says so. After goalwatch.max_unchanged of those in a row the goal
     is filed as an INCIDENT and the chat is left alone until the file changes again;
  5. THE BUDGET RULE: when the chat's account reaches goalwatch.wrapup_pct of its usage window, a
     WRAP-UP is sent instead (stop starting work, leave the file resumable, keep IN PROGRESS), once
     per climb over the line. The line sits below the courier's own delivery gate
     (bands.soft_target_pct) on purpose: past that gate nothing can be delivered at all.

NOT TYPED INTO: a chat mid-turn, a chat waiting on its person (its turn ended on a question, or
the goal holds an open "NEED:" item), an older owner of a goal a newer chat also owns, a HELD chat, a chat another lane typed into moments ago, and
anything while the tray icon is down (plan only, as every acting lane).

Usage: python goal_watch.py [--json]                 # which goals are open, and who would be prompted
       python goal_watch.py --yes [--max N]          # prompt them
       python goal_watch.py --session <id> [--yes]   # just these chats (repeatable, or a comma list)
Exit:  0 nothing to do, or every prompt landed - 2 a prompt did not land (each named) - 3 bad usage
       (an unknown flag, refused before anything is read) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import armlib, bandlib, clilib, configlib
from lib import deliverylib
from lib import gatelib
from lib import goallib
from lib import holdlib
from lib import hydralib
from lib import incidentlib
from lib import ledgerlib

QUIET_SECS = configlib.get("goalwatch.quiet_secs")
RENUDGE_SECS = configlib.get("goalwatch.renudge_secs")
MAX_UNCHANGED = configlib.get("goalwatch.max_unchanged")
WRAPUP_PCT = configlib.get("goalwatch.wrapup_pct")
MAX_PER_RUN = configlib.get("goalwatch.max_per_run")
# Another lane (saturate, stall_watch, the courier) that typed into this chat inside this window
# already woke it; a second message on top would be noise.
RECENT_DELIVERY_SECS = configlib.get("saturate.recent_delivery_secs")

_FLAGS_NO_VALUE = frozenset({"--json", "--yes", "--force", "--help", "-h"})
_FLAGS_WITH_VALUE = frozenset({"--session", "--max"})


def _unknown_args(argv: list[str]) -> list[str]:
    out, skip = [], False
    for a in argv:
        if skip:
            skip = False
            continue
        if a in _FLAGS_WITH_VALUE:
            skip = True
        elif a not in _FLAGS_NO_VALUE:
            out.append(a)
    return out


def _values(argv: list[str], flag: str) -> list[str]:
    out = []
    for i, a in enumerate(argv):
        if a == flag and i + 1 < len(argv):
            out.extend(v.strip() for v in argv[i + 1].split(",") if v.strip())
    return out


def _state_path():
    return ledgerlib._state_dir() / "goalwatch.json"


def _load_state() -> dict:
    try:
        got = json.loads(_state_path().read_text(encoding="utf-8"))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    p = _state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    tmp.replace(p)


def _usage_pct_by_instance(snap: dict) -> dict[str, int]:
    """{instance name -> the account's peak usage %}, from the one survey bandlib takes. An
    unread account is simply absent: it is continued, never wrapped up on a guess."""
    out: dict[str, int] = {}
    for a in snap.get("accounts") or []:
        pct = a.get("peakPct")
        if pct is None:
            continue
        for i in a.get("instances") or []:
            out[str(i.get("name"))] = int(pct)
    return out


def plan(only: set[str] | None = None) -> dict:
    """Every live chat that owns an open goal file, with its gate verdict. Reads only; writes the
    ownership cache."""
    got = hydralib.api_get("/api/sessions/live")
    rows = got.get("sessions", []) if isinstance(got, dict) else []
    visible = {r.get("session_id"): r for r in hydralib.visible_chats()}
    caches = dict(_load_state().get("cache") or {})
    holds = holdlib._load()
    chats = []
    for s in rows:
        sid = s.get("sessionId") or ""
        tp = s.get("transcriptPath")
        if not sid or not tp or (only and sid not in only):
            continue
        path = goallib.find_goal_file(s.get("cwd"))
        if not path:
            continue
        owns, caches[sid] = goallib.mentions_goal(tp, caches.get(sid))
        if not owns:
            continue
        goal = goallib.parse(path)
        if not goal:
            continue
        vis = visible.get(sid) or {}
        v = gatelib.gate(sid, tp, s) or {}
        quiet = v.get("quiet_secs")
        ended = bool(v.get("state") == "running" and v.get("idle"))
        # A turn that ended on a question waits on its person (saturate never wakes one either).
        asking = bool(ended and (v.get("idle") or {}).get("ends_with_question"))
        chats.append({"sessionId": sid, "title": vis.get("title") or s.get("name") or sid,
                      "instance": vis.get("instance") or "", "transcriptPath": tp,
                      "goalPath": str(path), "goal": goal, "turnEnded": ended, "asking": asking,
                      "quietSecs": quiet, "held": holdlib.why_blocked(sid, _holds=holds)})
    live = {s.get("sessionId") for s in rows}
    for sid in list(caches):
        if sid not in live:
            caches.pop(sid, None)
    with ledgerlib.locked("goalwatch"):
        state = _load_state()
        state["cache"] = caches
        _save_state(state)
    return {"chats": chats, "scanned": len(rows)}


def send(chat: dict, text: str) -> tuple[bool, str]:
    """Type one goal message into one chat through the composer - the courier's own rails
    (verify snippet, claim, honest confirm), exactly like stall_watch.ask()."""
    import courier

    sid = chat["sessionId"]
    recent = deliverylib.recent_delivery(sid, RECENT_DELIVERY_SECS)
    if recent:
        return True, f"another lane typed into it {recent.get('by')} moments ago - not twice"
    tail = deliverylib.transcript_tail_text(chat["transcriptPath"])
    verify = deliverylib._verify_snippet(tail)
    if not verify:
        return False, "no verify snippet could be taken from its last words - refusing to type blind"
    entry = deliverylib.stage(sid, text, title=chat["title"], instance=chat["instance"],
                              verify_text=verify, evidence=tail[-600:], by="goal_watch",
                              dedupe=True)
    code, said = clilib.capture(courier.main, ["--yes", "--only", entry["id"]])
    if code == 0:
        return True, "delivered and confirmed"
    last = said.splitlines()[-1] if said else f"exit {code}"
    return False, f"the prompt did not land ({last[:160]})"


def _decide(chat: dict, entry: dict, pct: int | None, snap: dict | None,
            now: float) -> tuple[str, str]:
    """(kind, why) for one open goal: kind is 'continue', 'wrapup', 'escalate' or 'skip'."""
    goal = chat["goal"]
    if not goal["inProgress"]:
        return "skip", f"STATUS: {goal['status']} - the chat's own call, left alone"
    if chat["held"]:
        return "skip", f"held - not typed into ({chat['held']})"
    quiet = chat.get("quietSecs")
    if not chat["turnEnded"]:
        return "skip", "mid-turn - working, not interrupted"
    # WHY: /goal tells a chat to stop and ask its owner, recording the ask as an open NEED: item
    # while STATUS stays IN PROGRESS. A nudge on top of that buries the question; it waits.
    if chat.get("asking"):
        return "skip", "its last turn ended on a question - waiting on its person, not nudged"
    if goal.get("need"):
        return "skip", f"waiting on its owner (open {goal['need'][:80]}) - not nudged"
    if quiet is None or quiet < QUIET_SECS:
        return "skip", (f"turn ended {int((quiet or 0) // 60)} min ago (< {QUIET_SECS // 60} min) - "
                        "left to finish its thought")
    if pct is not None and pct >= WRAPUP_PCT:
        if entry.get("wrapupSent"):
            return "skip", f"account at {pct}% - wrap-up already sent; nothing more until it cools"
        ok, why_not = bandlib.may_take_work(chat["instance"], snap)
        if not ok:
            return "skip", f"account at {pct}% and {why_not} - the wrap-up cannot be delivered there"
        return "wrapup", f"account at {pct}% (wrap-up line {WRAPUP_PCT}%)"
    if entry.get("incident") and entry.get("lastHash") == goal["hash"]:
        return "skip", "incident already filed - left alone until the goal file changes"
    if entry.get("lastAt") and now - float(entry["lastAt"]) < RENUDGE_SECS:
        return "skip", "continued recently"
    # The wrap-up line normally sits below the courier's gate, but the owner can move either one:
    # a continuation the courier would refuse is a skip here, not a failed prompt every tick.
    ok, why_not = bandlib.may_take_work(chat["instance"], snap)
    if not ok:
        return "skip", f"{why_not} - a continuation cannot be delivered there"
    return "continue", ""


def run(argv: list[str]) -> tuple[dict, int]:
    now = time.time()
    act = "--yes" in argv
    notes = []
    if act and not configlib.get("goalwatch.enabled"):
        notes.append("PLAN ONLY - continuing standing goals is switched OFF in your policy "
                     "(goalwatch.enabled).")
        act = False
    if act:
        refusal = armlib.refuse_unless_armed(argv, "continuing chats' standing goals")
        if refusal:
            notes.append(refusal)
            act = False
    cap = MAX_PER_RUN
    if _values(argv, "--max"):
        try:
            cap = max(1, int(_values(argv, "--max")[0]))
        except ValueError:
            return {"error": "--max needs a whole number"}, 3
    only = set(_values(argv, "--session")) or None
    try:
        p = plan(only)
    except hydralib.DaemonError as err:
        return {"error": f"daemon read failed: {err}"}, 1

    # One usage survey per run, shared by every chat's decision (bandlib's snapshot rule), and
    # none at all when no goal is open - the survey is the slow read.
    snap, pcts = None, {}
    if any(c["goal"]["inProgress"] for c in p["chats"]):
        snap = bandlib.snapshot()
        pcts = _usage_pct_by_instance(snap)
    state = _load_state()
    history = state.setdefault("goals", {})
    # Several live chats can own one goal file (a swap leaves the old one idle): only the one
    # that spoke last is prompted, so one goal never gets two chats racing on it.
    newest: dict[str, str] = {}
    for c in sorted(p["chats"], key=lambda c: c.get("quietSecs") or 0, reverse=True):
        newest[c["goalPath"]] = c["sessionId"]
    rows, failed, sent = [], 0, 0
    for chat in p["chats"]:
        key = f"{chat['sessionId']}|{chat['goalPath']}"
        entry = dict(history.get(key) or {})
        goal = chat["goal"]
        pct = pcts.get(chat["instance"])
        if pct is not None and pct < WRAPUP_PCT:
            entry.pop("wrapupSent", None)
        row = {"sessionId": chat["sessionId"], "title": chat["title"], "instance": chat["instance"],
               "goalPath": chat["goalPath"], "status": goal["status"],
               "inProgress": goal["inProgress"], "open": goal["open"],
               "done": goal["done"], "usagePct": pct, "action": "none"}
        rows.append(row)
        kind, why = _decide(chat, entry, pct, snap, now)
        # A wrap-up is also a "rewrite the goal file" order, so it goes to the newest owner only.
        if kind in ("continue", "wrapup") and newest.get(chat["goalPath"]) != chat["sessionId"]:
            kind, why = "skip", "another live chat owns the same goal and spoke more recently"
        # THE OUTSIDE AUDIT: the file byte-identical since the last continuation = no progress.
        streak = 0
        if kind == "continue" and entry.get("lastHash"):
            streak = int(entry.get("unchanged", 0)) + 1 if entry["lastHash"] == goal["hash"] else 0
            if streak >= MAX_UNCHANGED:
                kind = "escalate"
        if kind == "skip":
            row["action"] = why
            history[key] = entry
            continue
        if kind == "escalate":
            row["action"] = (f"escalated to an incident: {MAX_UNCHANGED} continuation(s) left the "
                             "goal file unchanged")
            if act:
                entry["incident"] = incidentlib.record(
                    "goal_watch", key,
                    f"{MAX_UNCHANGED} continuations and {chat['goalPath']} never changed "
                    f"({goal['open']} open item(s)) - the chat is spinning or stuck")
                entry["lastHash"] = goal["hash"]
            history[key] = entry
            continue
        if sent >= cap:
            row["action"] = f"over this run's cap of {cap} - next tick"
            history[key] = entry
            continue
        rel = str(goallib.GOAL_REL).replace("\\", "/")
        text = (goallib.wrapup_text(goal, rel_path=rel, pct=pct or 0, wrapup_pct=WRAPUP_PCT)
                if kind == "wrapup" else
                goallib.continuation_text(goal, rel_path=rel, unchanged_for=streak))
        if not act:
            row["action"] = f"would {'send the wrap-up' if kind == 'wrapup' else 'continue'}" + (
                f" ({why})" if why else "")
            continue
        ok, detail = send(chat, text)
        row["action"] = (("wrap-up sent" if kind == "wrapup" else "continued") if ok
                         else "PROMPT FAILED") + f": {detail}"
        if not ok:
            failed += 1
            continue
        sent += 1
        if kind == "wrapup":
            entry["wrapupSent"] = True
        else:
            entry.update({"lastAt": now, "lastHash": goal["hash"], "unchanged": streak,
                          "incident": None})
        history[key] = entry
    if act:
        # Forget goals of chats that are gone, so the history cannot grow forever.
        live = {c["sessionId"] for c in p["chats"]}
        for key in list(history):
            if key.split("|", 1)[0] not in live and now - float(history[key].get("lastAt") or 0) > 86400:
                history.pop(key, None)
        with ledgerlib.locked("goalwatch"):
            merged = _load_state()
            merged["goals"] = history
            _save_state(merged)
    payload = {"scanned": p["scanned"], "withGoals": len(rows),
               "openGoals": sum(1 for r in rows if r["inProgress"]),
               "sent": sent, "failed": failed, "acting": act, "notes": notes, "chats": rows,
               "thresholds": {"quietSecs": QUIET_SECS, "renudgeSecs": RENUDGE_SECS,
                              "maxUnchanged": MAX_UNCHANGED, "wrapupPct": WRAPUP_PCT}}
    return payload, (2 if failed else 0)


def render(r: dict) -> str:
    if "error" in r:
        return f"goal_watch FAILED: {r['error']}"
    L = [f"{r['scanned']} live chats read; {r['withGoals']} own a goal file, "
         f"{r['openGoals']} of them IN PROGRESS."]
    L.extend(r["notes"])
    for c in r["chats"]:
        pct = f", account {c['usagePct']}%" if c["usagePct"] is not None else ""
        L.append(f"\n[{c['instance'] or '?'}] {c['title']}  ({c['status']}, {c['open']} open, "
                 f"{c['done']} done{pct})\n   -> {c['action']}")
    if r["acting"]:
        L.append(f"\nprompted {r['sent']} chat(s); {r['failed']} prompt(s) did not land.")
    elif any(c["action"].startswith("would") for c in r["chats"]):
        L.append("\nPLAN ONLY - add --yes to prompt these chats.")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    unknown = _unknown_args(argv)
    if unknown:
        print(f"goal_watch FAILED: unknown argument(s) {' '.join(unknown)} - this build understands "
              f"{' '.join(sorted(_FLAGS_NO_VALUE | _FLAGS_WITH_VALUE))}", file=sys.stderr)
        return 3
    payload, code = run(argv)
    if "error" in payload and code == 3:
        print(f"goal_watch FAILED: {payload['error']}", file=sys.stderr)
        return 3
    print(json.dumps(payload, indent=2) if "--json" in argv else render(payload))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
