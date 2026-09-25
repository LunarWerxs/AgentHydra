#!/usr/bin/env python3
"""stall_watch.py - ACT: ask a chat about the background work it left hanging.

THE COMPLAINT (owner, 2026-09-24): "You keep starting sub chats that go forever. ... You have the
annoying little gray dot forever, even if you're done, if one of your sub chats are running. And
tons of your sub chats ... keep friggin' running for like 15 hours, and I keep trusting that dot."
And the design, in the same conversation: "Shouldn't this just be a part of Agent Hydra that just
has the settings to manage long chats and ... just says to the chat, Hey, you've been stuck a
while. Are you stuck?"

Measured the moment this was written: 12 live chats held background tasks that had written
nothing for 2 to 61 hours - five hung workflows in one chat, three "wait for X" shells in another
running since two days before. Every one of those chats showed as busy, and every one of their
models was idle, because a hung task never sends the completion notice that would wake it.

WHAT IT DOES, every tick (see lib/stalllib.py for how a transcript is read):
  1. every LIVE chat's transcript is read for background tasks it launched that never ended;
  2. a task silent past stallwatch.silent_secs (a shell: running past stallwatch.shell_secs) is
     STALLED;
  3. a chat whose own turn has ENDED and that holds a stalled task gets ONE message through the
     composer naming each stalled task, its id and the exact TaskStop line, asking whether it is
     stuck. The chat decides - this never kills anything, because only the chat that launched a
     task knows whether a quiet one is stuck or merely slow, and only it can TaskStop it;
  4. the same task is asked about again only after stallwatch.renudge_secs, at most
     stallwatch.max_nudges times; after that it is filed as an INCIDENT (you see it in
     list_incidents) and the chat is left alone.

NOT TYPED INTO: a chat mid-turn (it is working - the stall is reported, not interrupted), a HELD
chat, and anything while the tray icon is down (plan only, as every acting lane).

Usage: python stall_watch.py [--json]                 # what is stalled, and who would be asked
       python stall_watch.py --yes [--max N]          # ask them
       python stall_watch.py --session <id> [--yes]   # just these chats (repeatable, or a comma list)
Exit:  0 nothing stalled, or every chat asked - 2 an ask did not land (each named) - 3 bad usage
       (an unknown flag, refused before anything is read) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import armlib, clilib, configlib
from lib import deliverylib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import incidentlib
from lib import ledgerlib
from lib import recoverylib
from lib import stalllib

SILENT_SECS = configlib.get("stallwatch.silent_secs")
SHELL_SECS = configlib.get("stallwatch.shell_secs")
RENUDGE_SECS = configlib.get("stallwatch.renudge_secs")
MAX_NUDGES = configlib.get("stallwatch.max_nudges")
MAX_PER_RUN = configlib.get("stallwatch.max_per_run")
# Another lane (saturate, the courier) that typed into this chat inside this window already woke
# it; a second message on top would be noise.
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
    return ledgerlib._state_dir() / "stallwatch.json"


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


def plan(now: float, only: set[str] | None = None) -> dict:
    """Every live chat's open background tasks, judged. Reads only; writes the parse cache."""
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
        tasks, caches[sid] = stalllib.scan(tp, caches.get(sid))
        if not tasks:
            continue
        judged = []
        for t in tasks:
            a = stalllib.activity(t, tp, now)
            judged.append({"task": t, "activity": a,
                           "verdict": stalllib.verdict(t, a, silent_secs=SILENT_SECS,
                                                       shell_secs=SHELL_SECS)})
        vis = visible.get(sid) or {}
        v = gatelib.gate(sid, tp, s) or {}
        # WHO MAY BE ASKED: a chat whose turn has ended (the gate's idle verdict), OR one whose own
        # transcript has been quiet at least as long as a stalled task. The second is not a
        # working chat: measured the day this was written, a chat the gate called "running" had
        # written nothing for 3.8 hours - its last records were two completion notices that
        # arrived and were never answered, so its own turn was hung. A message typed into a turn
        # that is truly in flight waits in the queue and is read when the turn ends; into a hung
        # one it does not land, which the courier reports and max_nudges turns into an incident.
        quiet = v.get("quiet_secs")
        idle = bool(v.get("state") == "running" and v.get("idle"))
        askable = idle or (quiet is not None and quiet >= SILENT_SECS)
        chats.append({"sessionId": sid, "title": vis.get("title") or s.get("name") or sid,
                      "instance": vis.get("instance") or "", "transcriptPath": tp,
                      "idle": askable, "quietSecs": quiet,
                      "held": holdlib.why_blocked(sid, _holds=holds), "tasks": judged})
    # Drop parse caches of chats that are no longer live, so the file does not grow forever.
    live = {s.get("sessionId") for s in rows}
    for sid in list(caches):
        if sid not in live:
            caches.pop(sid, None)
    with ledgerlib.locked("stallwatch"):
        state = _load_state()
        state["cache"] = caches
        _save_state(state)
    return {"chats": chats, "scanned": len(rows)}


def _due(entry: dict | None, now: float) -> str:
    """'ask' | 'wait' | 'escalate' for one stalled task, from its nudge history."""
    if not entry:
        return "ask"
    if entry.get("incident"):
        return "done"
    if int(entry.get("nudges", 0)) >= MAX_NUDGES:
        return "escalate"
    if now - float(entry.get("lastAt", 0)) < RENUDGE_SECS:
        return "wait"
    return "ask"


def ask(chat: dict, items: list[tuple[dict, dict]]) -> tuple[bool, str]:
    """Type the stall question into one chat through the composer - the courier's own rails
    (verify snippet, claim, honest confirm), exactly like overlord.nudge()."""
    import courier

    sid = chat["sessionId"]
    recent = deliverylib.recent_delivery(sid, RECENT_DELIVERY_SECS)
    if recent:
        return True, f"another lane typed into it {recent.get('by')} moments ago - not twice"
    tail = deliverylib.transcript_tail_text(chat["transcriptPath"])
    verify = deliverylib._verify_snippet(tail)
    if not verify:
        return False, "no verify snippet could be taken from its last words - refusing to type blind"
    entry = deliverylib.stage(sid, stalllib.nudge_text(items), title=chat["title"],
                              instance=chat["instance"], verify_text=verify,
                              evidence=tail[-600:], by="stall_watch", dedupe=True)
    code, said = clilib.capture(courier.main, ["--yes", "--only", entry["id"]])
    if code == 0:
        return True, "asked through the composer - delivered and confirmed"
    last = said.splitlines()[-1] if said else f"exit {code}"
    return False, f"the ask did not land ({last[:160]})"


def run(argv: list[str]) -> tuple[dict, int]:
    now = time.time()
    act = "--yes" in argv
    notes = []
    if act and not configlib.get("stallwatch.enabled"):
        notes.append("PLAN ONLY - asking chats about stalled work is switched OFF in your policy "
                     "(stallwatch.enabled).")
        act = False
    if act:
        refusal = armlib.refuse_unless_armed(argv, "asking chats about stalled background work")
        if refusal:
            notes.append(refusal)
            act = False
            # The recipe table's tray-not-armed row: no automatic step (arming is a person's
            # act), escalation abort - recorded, so the ledger says why this lane did nothing.
            # Only a real DISARMED refusal: an unreadable policy file is not a tray state.
            if refusal.startswith("DISARMED"):
                recoverylib.attempt_recovery("tray-not-armed", "stall_watch", context=refusal)
    cap = MAX_PER_RUN
    if _values(argv, "--max"):
        try:
            cap = max(1, int(_values(argv, "--max")[0]))
        except ValueError:
            return {"error": "--max needs a whole number"}, 3
    only = set(_values(argv, "--session")) or None
    try:
        p = plan(now, only)
    except hydralib.DaemonError as err:
        return {"error": f"daemon read failed: {err}"}, 1

    state = _load_state()
    history = state.setdefault("tasks", {})
    rows, failed, asked = [], 0, 0
    for chat in p["chats"]:
        stalled = [(j["task"], j["activity"]) for j in chat["tasks"] if j["verdict"] == "stalled"]
        row = {"sessionId": chat["sessionId"], "title": chat["title"], "instance": chat["instance"],
               "idle": chat["idle"], "held": chat["held"],
               "tasks": [{"id": j["task"]["id"], "kind": j["task"]["kind"], "verdict": j["verdict"],
                          "line": stalllib.describe(j["task"], j["activity"])} for j in chat["tasks"]],
               "action": "none"}
        rows.append(row)
        if not stalled:
            continue
        due = {t["id"]: _due(history.get(f"{chat['sessionId']}:{t['id']}"), now) for t, _ in stalled}
        for t, a in stalled:
            if due[t["id"]] == "escalate":
                key = f"{chat['sessionId']}:{t['id']}"
                if act:
                    iid = incidentlib.record("stall_watch", key,
                                             f"asked {MAX_NUDGES}x and still stalled: "
                                             f"{stalllib.describe(t, a)}")
                    history[key]["incident"] = iid
                row["action"] = "escalated to an incident"
        to_ask = [(t, a) for t, a in stalled if due[t["id"]] == "ask"]
        if not to_ask:
            if row["action"] == "none":
                row["action"] = ("incident already filed" if all(d == "done" for d in due.values())
                                 else "already asked recently")
            continue
        if chat["held"]:
            row["action"] = f"held - not typed into ({chat['held']})"
            continue
        if not chat["idle"]:
            row["action"] = (f"working (wrote {int((chat.get('quietSecs') or 0) // 60)} min ago) - "
                             "reported, not interrupted")
            continue
        if asked >= cap:
            row["action"] = f"over this run's cap of {cap} - next tick"
            continue
        if not act:
            row["action"] = "would ask"
            continue
        ok, why = ask(chat, to_ask)
        row["action"] = ("asked" if ok else "ASK FAILED") + f": {why}"
        if ok:
            asked += 1
            for t, _ in to_ask:
                key = f"{chat['sessionId']}:{t['id']}"
                prev = history.get(key) or {}
                history[key] = {"nudges": int(prev.get("nudges", 0)) + 1, "lastAt": now,
                                "firstAt": prev.get("firstAt", now)}
        else:
            failed += 1
    if act:
        # Forget tasks of chats that are gone, so the history cannot grow forever.
        live = {c["sessionId"] for c in p["chats"]}
        for key in list(history):
            if key.split(":", 1)[0] not in live and now - float(history[key].get("lastAt", 0)) > 86400:
                history.pop(key, None)
        with ledgerlib.locked("stallwatch"):
            merged = _load_state()
            merged["tasks"] = history
            _save_state(merged)
    stalled_chats = [r for r in rows if any(t["verdict"] == "stalled" for t in r["tasks"])]
    payload = {"scanned": p["scanned"], "withBackgroundWork": len(rows),
               "stalledChats": len(stalled_chats), "asked": asked, "failed": failed,
               "acting": act, "notes": notes, "chats": rows,
               "thresholds": {"silentSecs": SILENT_SECS, "shellSecs": SHELL_SECS,
                              "renudgeSecs": RENUDGE_SECS, "maxNudges": MAX_NUDGES}}
    return payload, (2 if failed else 0)


def render(r: dict) -> str:
    if "error" in r:
        return f"stall_watch FAILED: {r['error']}"
    L = [f"{r['scanned']} live chats read; {r['withBackgroundWork']} hold background work, "
         f"{r['stalledChats']} of them stalled (silent {r['thresholds']['silentSecs'] // 60}+ min, "
         f"or a command running {r['thresholds']['shellSecs'] // 60}+ min)."]
    L.extend(r["notes"])
    for c in r["chats"]:
        if not any(t["verdict"] == "stalled" for t in c["tasks"]):
            continue
        L.append(f"\n[{c['instance'] or '?'}] {c['title']}  -> {c['action']}")
        for t in c["tasks"]:
            L.append(f"   {'STALLED' if t['verdict'] == 'stalled' else 'ok     '} {t['line']}")
    if r["acting"]:
        L.append(f"\nasked {r['asked']} chat(s); {r['failed']} ask(s) did not land.")
    elif r["stalledChats"]:
        L.append("\nPLAN ONLY - add --yes to ask these chats whether their work is stuck.")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    unknown = _unknown_args(argv)
    if unknown:
        print(f"stall_watch FAILED: unknown argument(s) {' '.join(unknown)} - this build understands "
              f"{' '.join(sorted(_FLAGS_NO_VALUE | _FLAGS_WITH_VALUE))}", file=sys.stderr)
        return 3
    payload, code = run(argv)
    if "error" in payload and code == 3:
        print(f"stall_watch FAILED: {payload['error']}", file=sys.stderr)
        return 3
    print(json.dumps(payload, indent=2) if "--json" in argv else render(payload))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
