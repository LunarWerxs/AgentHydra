#!/usr/bin/env python3
"""fan_out.py - ACT: DISSEMINATE a task list into N desktop chats, one account each, and manage them as a group.

THE ASK (owner, 2026-09-04): "if I start a single chat and tell it to do something that involves
checking or linting six or seven different planes, can it orchestrate those chats into other
accounts and manage them?" Before this the answer was "by hand": read the usage survey, pick
accounts, run spawn_chat seven times, remember seven session ids, tail seven transcripts - and
there was no MCP tool at all to send a follow-up into any of them. Worse, the two MCP tools that
LOOK like the answer (add_queue_item, launch_terminal_session) are refused on every call by the
no-headless law, so an agent reading the tool list tried them first and got nowhere. This
script is the one call, and MCP `fan_out` / `fan_out_status` / `fan_out_send` wrap it.

WHAT IT DOES, and every rail it keeps:
  - RANKS accounts by real room the way balance.py does (fill ceiling minus the account's peak
    across 5-hour / weekly / binding; an unknown or stale reading is never room), OPEN
    instances first, ONE task per account by default. SPREAD, NEVER DUMP (owner, 2026-08-31).
  - SPAWNS each chat through spawn_chat.py - the app's own claude://code/new deeplink into a
    RUNNING desktop app, trust pre-written, composer submitted, bypass set at birth - so every
    chat is VISIBLE in a sidebar the owner reads. Nothing headless, ever.
  - ONE AT A TIME. Each spawn drives a window through the accessibility tree; two lanes driving
    two windows in the same second is how text lands in the wrong pane. Sequential is slower
    (~30-90 s per chat) and correct.
  - REMEMBERS the group in state/fanouts.json, so `status` reads every member's gate verdict
    (working / idle / stalled / finished / crashed) with its last words, and `send` delivers one
    follow-up into all of them through the daemon's message route (native peer channel for a
    live chat, the composer for a dormant one), holds respected.
  - A duplicate of a chat that ALREADY EXISTS in the fleet is refused per task (the same
    double-check spawn_chat runs); two tasks in the SAME spec may share a prompt on purpose
    (seven planes, one instruction), so that check runs HERE, once per task, against the fleet
    as it was before this group started.
  - Closed accounts are used only with --open-closed (opening an app is the last resort - owner
    rule); a task with no account left is reported UNASSIGNED, never silently dropped.

This is a PERSON's act, like migrate_chat: it runs when asked and does not need the tray icon.
The `title` on a task is the group's own label for that member (what `status` prints); the
desktop app titles the chat itself from its first prompt, and no UI rename is attempted.

STEERING GOES THROUGH THE COMPOSER, NOT THE PEER PIPE (measured 2026-09-04, this script's own
first drill): the native peer channel accepted a follow-up into both spawned chats, neither
chat ever processed it, and one engine exited holding it - "delivered" was an enqueue record,
not a turn. A chat nobody has clicked drains peer messages only after a person interacts with
it. So `send` first stops each member's IDLE engine (enginelib, the same rails migrate_chat
uses; a working or stuck engine refuses and that member is skipped with the reason) and lets
the daemon's message route boot the chat through the app's own composer, which is the send
that starts a turn and is verified from the transcript.

A DRILL MUST BE DELETED AFTERWARDS (owner rule, 2026-09-04: "all ping requests or account
identification requests must be deleted after they are created and not left in the
account"). `delete <group>` runs delete_chat.py on every member - the app's own Delete
control where the app is running, the meta record and the transcript everywhere, an undo copy
first - so a probe fan-out leaves nothing in any account.

Usage: python fan_out.py --spec <file.json | '{"tasks":[...]}'> [--per-account N]
                         [--exclude <inst>]... [--only <inst>]... [--open-closed]
                         [--group-id <id>] [--dry-run] [--force] [--json]
       python fan_out.py list [--json]
       python fan_out.py status [<group>] [--json]          # the latest group when omitted
       python fan_out.py send <group> --text "..." [--only <sessionId>]... [--force] [--json]
       python fan_out.py recover <group> [--force] [--json] # each failed member's recipe, once
       python fan_out.py delete <group> [--force] [--json]  # every member chat, everywhere
Spec:  {"tasks": [{"title": "...", "folder": "<dir>", "prompt": "..."}, ...], "group": "<name>"}
       (a bare list of tasks is accepted too; `title` is optional)
Exit:  0 every task spawned and its first turn confirmed / status read / every send delivered /
         every member deleted and verified / every failed member recovered
       4 partial: some members not confirmed, refused or unassigned; some sends not delivered;
         some members not deleted; some recoveries escalated
       2 nothing spawned at all (no account with room, or every spawn refused) / nothing to
         send to, delete or recover
       3 bad usage, bad spec, or unknown group - 1 daemon failure.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import balance
import delete_chat
import spawn_chat
from lib import clilib, enginelib, gatelib, holdlib, hydralib, ledgerlib, recoverylib

STATE_FILE = "fanouts.json"
# How long to wait for a closed instance we were told to open to report running, and how long
# between looks.
OPEN_WAIT_SECS = 90
OPEN_POLL_SECS = 5
# How much of a member's last words `status` carries (the whole text stays in its transcript).
LAST_TEXT_CHARS = 600
# The message route's own confirm window; the call waits that long for the chat to move. A
# composer send boots a fresh engine first, which is why it is the route's own 120s default.
SEND_CONFIRM_SECS = 120
# Why send/delete leave a member alone whose chat opens with somebody else's words.
NOT_OUR_CHAT = ("not this group's chat: its first turn is not the member's prompt, so it is "
                "somebody else's - never sent to or deleted")


# --- the group ledger ------------------------------------------------------------------------

def _path() -> Path:
    return ledgerlib._state_dir() / STATE_FILE


def _load() -> list[dict]:
    try:
        rows = json.loads(_path().read_text(encoding="utf-8"))
        return rows if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _upsert(group: dict) -> None:
    """Write one group record, replacing any earlier copy with the same id. Serialized
    across processes (ledgerlib.locked), atomic on disk (_save)."""
    with ledgerlib.locked("fanouts"):
        rows = [r for r in _load() if r.get("id") != group["id"]]
        rows.append(group)
        _save(rows)


def groups() -> list[dict]:
    return sorted(_load(), key=lambda g: str(g.get("createdAt") or ""))


def find_group(group_id: str | None) -> dict | None:
    """By id, by name, or the LATEST when nothing is named. An id prefix is enough."""
    rows = groups()
    if not rows:
        return None
    if not group_id:
        return rows[-1]
    want = group_id.strip().lower()
    for g in reversed(rows):
        if str(g.get("id", "")).lower() == want or str(g.get("name") or "").lower() == want:
            return g
    hits = [g for g in rows if str(g.get("id", "")).lower().startswith(want)]
    return hits[-1] if len(hits) == 1 else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_group_id() -> str:
    return f"fo-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"


# --- the spec --------------------------------------------------------------------------------

def parse_spec(raw: str) -> dict:
    """A path to a JSON file, or JSON text. Returns {"group": name|None, "tasks": [...]} with
    every task validated: folder (an existing directory), prompt (non-empty), title (optional,
    defaulted from the prompt). Raises ValueError with the exact complaint."""
    text = raw
    p = Path(raw)
    try:
        if p.is_file():
            text = p.read_text(encoding="utf-8")
    except OSError as err:
        raise ValueError(f"cannot read spec file {raw!r}: {err}") from err
    try:
        data = json.loads(text)
    except ValueError as err:
        raise ValueError(f"spec is neither a JSON file nor JSON text: {err}") from err
    if isinstance(data, list):
        data = {"tasks": data}
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        raise ValueError('spec must be {"tasks": [...]} or a bare list of tasks')
    if not data["tasks"]:
        raise ValueError("spec has no tasks")
    tasks = []
    for i, t in enumerate(data["tasks"]):
        if not isinstance(t, dict):
            raise ValueError(f"task {i} is not an object")
        folder = str(t.get("folder") or t.get("cwd") or "").strip()
        prompt = str(t.get("prompt") or "").strip()
        if not folder:
            raise ValueError(f"task {i} has no folder")
        if not Path(folder).is_dir():
            raise ValueError(f"task {i}: {folder!r} is not a directory - a chat cannot start there")
        if not prompt:
            raise ValueError(f"task {i} has no prompt")
        title = str(t.get("title") or "").strip() or prompt.splitlines()[0][:60]
        tasks.append({"title": title, "folder": str(Path(folder).resolve()), "prompt": prompt})
    name = str(data.get("group") or "").strip() or None
    return {"group": name, "tasks": tasks}


# --- the targets -----------------------------------------------------------------------------

# ⛔ A PERSON AT THE KEYBOARD IS NOT ROOM (found live 2026-09-15). A three-task fan-out put its one
# spawned chat on #37 while the owner was working in that very app: its log shows him sending
# three messages to his own chats and clicking between them from 02:52 to 02:57 local, the spawn
# taking the focus at 02:59:26, and him coming back at 03:00:22 to find a chat he had not started,
# stop it (`[Request interrupted by user]`, 55 s in) and delete it through the app. The account
# had quota room, which is all the ranking asked. The app's own main.log records every chat a
# hand sends to or clicks into, so an app that did either within HANDS_ON_SECS is skipped with
# the reason; `--only` naming it is a person's word and still reaches it. A lane's own UI acts
# log the same lines, so a just-spawned account also reads as hands-on for a while - which only
# spreads the next fan-out wider, the direction this script is meant to err in.
HANDS_ON_SECS = 10 * 60
HANDS_ON_TAIL_BYTES = 512 * 1024
_HANDS_ON_LINE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[info\] "
    r"(?:LocalSessions\.sendMessage:|\[CCD\] LocalSessions\.setFocusedSession: sessionId=local_)")


def hands_on_secs_ago(inst_dir: str | None, now: float | None = None) -> float | None:
    """Seconds since the desktop app in `inst_dir` last logged a message sent to, or a click
    into, one of its chats - or None when that was longer than HANDS_ON_SECS ago, or there is no
    readable log. The log's timestamps are local wall-clock time; only its tail is read."""
    if not inst_dir:
        return None
    try:
        with open(Path(inst_dir) / "logs" / "main.log", "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - HANDS_ON_TAIL_BYTES))
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    latest = None
    for line in tail.splitlines():
        m = _HANDS_ON_LINE.match(line)
        if not m:
            continue
        try:
            at = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
        latest = at if latest is None else max(latest, at)
    if latest is None:
        return None
    age = (time.time() if now is None else now) - latest
    return max(0.0, age) if age <= HANDS_ON_SECS else None


def _resolve_nums(fleet_data: dict, refs: list[str]) -> set:
    """Instance refs (number, name, dir, label, email) -> the set of instance nums. An
    unresolvable ref is a ValueError: a filter that silently matches nothing is how work
    lands on the account it was meant to avoid."""
    out = set()
    for r in refs:
        inst = hydralib.resolve_instance(fleet_data, r)
        if not inst:
            raise ValueError(f"no instance matches {r!r}")
        out.add(inst.get("num"))
    return out


def rank_targets(exclude: list[str] | None = None, only: list[str] | None = None,
                 open_closed: bool = False) -> dict:
    """The accounts that may take a chat, best room first: OPEN instances first (in room
    order), then - only with open_closed - the closed ones. Returns {"targets": [...],
    "source": survey|cache-fallback|unavailable, "skipped": [why each other account was
    left out]} so a short list is explainable."""
    survey, source = balance.usage_rows_with_fallback()
    fleet_data = hydralib.fleet()
    only_nums = _resolve_nums(fleet_data, only or [])
    excl_nums = _resolve_nums(fleet_data, exclude or [])
    ranked = balance.rank_next(balance.accounts_overview(survey, fleet_data))
    targets: list[dict] = []
    skipped: list[dict] = []
    seen_nums = set()
    for acct in ranked:
        ti = balance._target_instance(acct)
        inst = hydralib.resolve_instance(fleet_data, str(ti.get("name"))) if ti else None
        if not inst:
            skipped.append({"account": acct.get("email"), "why": "no signed-in instance"})
            continue
        num = inst.get("num")
        seen_nums.add(num)
        label = f"#{num} {inst.get('name')}"
        if only_nums and num not in only_nums:
            skipped.append({"instance": label, "why": "not in --only"})
            continue
        if num in excl_nums:
            skipped.append({"instance": label, "why": "--exclude"})
            continue
        if acct.get("mustOpen") and not open_closed:
            skipped.append({"instance": label, "why": "closed (pass --open-closed to use it)"})
            continue
        hands_on = hands_on_secs_ago(inst.get("dir"))
        if hands_on is not None and num not in only_nums:
            skipped.append({"instance": label, "why": (
                f"a person is working in it: its app logged a message sent or a chat opened "
                f"{int(hands_on // 60)} min ago (name it with --only to use it anyway)")})
            continue
        targets.append({
            "num": num, "name": inst.get("name"), "dir": inst.get("dir"),
            "email": acct.get("email"), "plan": acct.get("plan"),
            "roomPct": acct.get("roomPct"), "peakPct": acct.get("peakPct"),
            "isRunning": bool(inst.get("isRunning")), "mustOpen": bool(acct.get("mustOpen")),
        })
    # Accounts the ranking dropped (no room, unknown reading) are named too, so "only two
    # targets" never reads as "only two accounts exist".
    for inst in fleet_data.get("instances", []):
        if inst.get("num") in seen_nums:
            continue
        skipped.append({"instance": f"#{inst.get('num')} {inst.get('name')}",
                        "why": "no room, or no fresh successful usage reading"})
    return {"targets": targets, "source": source, "skipped": skipped}


def plan(tasks: list[dict], targets: list[dict], per_account: int = 1) -> list[dict]:
    """Round-robin the tasks over the targets, at most `per_account` each, best room first:
    task 1 -> best, task 2 -> next, ... and only when every target has one does a second
    round start. A task with no target left is UNASSIGNED (target None), reported, never
    dropped."""
    cap = max(1, int(per_account or 1))
    taken = {t["num"]: 0 for t in targets}
    out = []
    cursor = 0
    for i, task in enumerate(tasks):
        chosen = None
        for _ in range(len(targets)):
            cand = targets[cursor % len(targets)] if targets else None
            cursor += 1
            if cand and taken[cand["num"]] < cap:
                chosen = cand
                taken[cand["num"]] += 1
                break
        out.append({"index": i, "task": task, "target": chosen})
    return out


# --- spawning --------------------------------------------------------------------------------

def _open_and_wait(target: dict, *, clock=time.monotonic, sleep=time.sleep) -> str | None:
    """Open a closed instance and wait for it to report running. Returns None when it is up,
    else why not.

    Look first, sleep after, never past the deadline, and look ONE more time once it has passed.
    The old loop tested the clock before each look, so an instance that came up during the last
    sleep was reported as never running - a verdict that depended on where the wall clock fell,
    not on the instance. `clock` (monotonic: a clock step cannot shorten or stretch the wait) and
    `sleep` are injectable so a test drives the wait without waiting."""
    try:
        import urllib.parse
        hydralib.api_post(f"/api/instances/{urllib.parse.quote(str(target['dir']), safe='')}/open")
    except hydralib.DaemonError as err:
        return f"open failed: {err.detail or err}"
    deadline = clock() + OPEN_WAIT_SECS
    while True:
        try:
            inst = hydralib.resolve_instance(hydralib.fleet(), str(target["num"]))
        except hydralib.DaemonError:
            inst = None
        if inst and inst.get("isRunning"):
            return None
        left = deadline - clock()
        if left <= 0:
            return f"opened, but not running after {OPEN_WAIT_SECS}s"
        sleep(min(OPEN_POLL_SECS, left))


def _member(assignment: dict) -> dict:
    task = assignment["task"]
    target = assignment["target"]
    return {
        "index": assignment["index"],
        "title": task["title"],
        "folder": task["folder"],
        "prompt": task["prompt"],
        "instance": (f"#{target['num']} {target['name']}" if target else None),
        "instanceNum": target["num"] if target else None,
        "sessionId": None,
        "state": "planned" if target else "unassigned",
        "why": None if target else "no account with room left for this task",
    }


def _spawn_state(res: dict) -> tuple[str, str | None]:
    if not res.get("ok"):
        return "refused", str(res.get("why") or "spawn refused")
    if not res.get("sessionId"):
        if res.get("unboundSessionId"):
            # a new chat appeared but never opened with this prompt: not claimed as a member
            return "unbound", (f"new chat {res['unboundSessionId']} was not bound - "
                               f"{res.get('started')}")
        return "not-registered", (f"the app never registered a new session (submitted: "
                                  f"{res.get('submitted')}; {res.get('submitNote') or ''})".strip())
    started = str(res.get("started") or "")
    if started.startswith("running"):
        return "spawned", None
    return "spawned-unconfirmed", f"registered, but the first turn is not confirmed: {started}"


def _placeholder(group_id: str, spec: dict) -> dict:
    """The record written before ranking: no members yet, `phase` says how far it got."""
    return {"id": group_id, "name": spec.get("group"), "createdAt": _now_iso(), "dryRun": False,
            "phase": "planning", "members": [], "sends": []}


def _spawn_member(group: dict, m: dict, target: dict, spawned_ids: set,
                  force: bool = False) -> None:
    """One member into one target with every rail of the group spawn, recorded as it goes.
    Shared by spawn_group and `recover` (an unassigned member re-placed), so the second path
    can never skip a rail the first one keeps."""
    if not force:
        # THE FLEET DOUBLE-CHECK, minus this group's own members (a shared prompt across
        # the group's tasks is the point of a fan-out, not a duplicate).
        try:
            dups = hydralib.same_task_chats(m["prompt"], exclude=spawned_ids)
        except hydralib.DaemonError as err:
            dups = []
            m["note"] = f"duplicate check failed ({err.detail or err}); spawned anyway"
        if dups:
            d = dups[0]
            m["state"] = "refused-duplicate"
            m["why"] = (f"a chat for this exact task already exists: '{d.get('title')}' in "
                        f"{d.get('instance')} ({'running' if d.get('live') else 'dormant'})"
                        " - --force is a person's word to insist")
            m["duplicateOf"] = dups
            _upsert(group)
            return
    if target.get("mustOpen") or not target.get("isRunning"):
        why = _open_and_wait(target)
        if why:
            m["state"] = "open-failed"
            m["why"] = why
            _upsert(group)
            return
        m["opened"] = True
    # force=True here lifts ONLY spawn_chat's own duplicate check, which this function has
    # already run with the group's members excluded; every other rail in spawn() stays.
    try:
        res = spawn_chat.spawn(m["folder"], m["prompt"], str(target["num"]), force=True)
    except hydralib.DaemonError as err:
        res = {"ok": False, "why": f"daemon failure during spawn: {err.detail or err}"}
    m["state"], m["why"] = _spawn_state(res)
    m["sessionId"] = res.get("sessionId")
    m["spawn"] = {k: res.get(k) for k in ("started", "submitted", "submitNote", "landedIn",
                                          "modeSet", "trustDialog", "window",
                                          "unboundSessionId", "skippedForeign")
                  if k in res}
    m["spawnedAt"] = _now_iso()
    if m["sessionId"]:
        spawned_ids.add(m["sessionId"])
    _upsert(group)


def spawn_group(spec: dict, assignments: list[dict], force: bool = False,
                dry_run: bool = False, group_id: str | None = None,
                targeting: dict | None = None) -> dict:
    """Spawn every assigned task, one at a time, recording the group after each so a crash
    half-way still leaves a readable record. Dry run: the plan only, nothing written.

    `group_id` lets a caller (the MCP `fan_out` tool) mint the id itself and hand it in, so it
    can return that SAME id to its own caller before this function has spawned anything -
    otherwise the id exists only inside this process and cannot be known until the whole spawn
    (30-90s per chat) has finished. Defaults to a fresh one, exactly as before.

    `targeting` ({exclude, only}) is kept on the record so `recover` re-ranks inside the same
    fence the group was spawned in - never onto the calling chat's own account."""
    group = {
        "id": group_id or _new_group_id(), "name": spec.get("group"), "createdAt": _now_iso(),
        "dryRun": bool(dry_run), "phase": "spawning",
        "members": [_member(a) for a in assignments], "sends": [],
    }
    if targeting is not None:
        group["targeting"] = targeting
    if dry_run:
        return group
    _upsert(group)
    spawned_ids: set = set()
    for a, m in zip(assignments, group["members"]):
        if a["target"]:
            _spawn_member(group, m, a["target"], spawned_ids, force)
    group["phase"] = "done"
    _upsert(group)
    return group


def spawn_exit_code(group: dict) -> int:
    members = group.get("members", [])
    spawned = [m for m in members if m.get("state") == "spawned"]
    with_session = [m for m in members if m.get("sessionId")]
    if not with_session:
        return 2
    if len(spawned) == len(members):
        return 0
    return 4


# --- status ----------------------------------------------------------------------------------

def _load_row_and_live(out: dict, sid: str) -> tuple[dict | None, object]:
    """Reads the session row and liveness for sid, recording any read failure onto out
    (liveness's own failure note wins if both reads fail, matching the original order)."""
    row = None
    try:
        row = hydralib.session_row(sid)
    except hydralib.DaemonError as err:
        out["note"] = f"session read failed: {err.detail or err}"
    try:
        live = hydralib.live_for(sid)
        out["liveKnown"] = True
    except hydralib.DaemonError as err:
        live = None
        out["liveKnown"] = False
        out["note"] = f"liveness unread: {err.detail or err}"
    return row, live


def _unknown_liveness_status(out: dict, tp: str | None) -> dict:
    """Fills the report for a session whose liveness could not be determined."""
    # LIVENESS UNKNOWN IS NOT "NOT LIVE" (hydralib.live_for's own contract; review
    # 2026-09-05): gating with live=None would print a confident finished/crashed verdict
    # for a chat that may still be working. Report the last words, never a verdict.
    out["state"] = "unknown"
    out["quietSecs"] = gatelib.quiet_secs_of(tp) if tp else None
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp)) if tp else ""
    except OSError:
        text = ""
    out["lastText"] = text[-LAST_TEXT_CHARS:] if text else ""
    return out


def _finalize_gated_status(out: dict, tp: str, verdict: dict) -> dict:
    """Fills the report fields derived from a completed gate verdict."""
    out["quietSecs"] = verdict.get("quiet_secs")
    if verdict.get("state") == "running":
        out["state"] = ("stalled" if verdict.get("stalled")
                        else "idle" if verdict.get("idle") else "working")
    else:
        out["state"] = verdict.get("state")  # finished | crashed
    out["cause"] = verdict.get("cause")
    fin = verdict.get("finished") or {}
    if fin:
        out["doneClaim"] = fin.get("done_claim")
        out["endsWithQuestion"] = fin.get("ends_with_question")
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp))
    except OSError:
        text = ""
    out["lastText"] = text[-LAST_TEXT_CHARS:] if text else ""
    return out


def _member_status(m: dict) -> dict:
    sid = m.get("sessionId")
    out = {"index": m.get("index"), "title": m.get("title"), "instance": m.get("instance"),
           "sessionId": sid, "spawnState": m.get("state"), "why": m.get("why")}
    if not sid:
        out["state"] = m.get("state")
        return out
    if m.get("deleted"):
        out["state"] = "deleted"
        out["trash"] = (m.get("deleteReport") or {}).get("trash")
        return out
    row, live = _load_row_and_live(out, sid)
    tp = (row or {}).get("transcript_path") or gatelib.find_transcript_on_disk(sid)
    out["chatTitle"] = (row or {}).get("title")
    if not out["liveKnown"]:
        return _unknown_liveness_status(out, tp)
    verdict = gatelib.gate(sid, tp, live) if tp else None
    if verdict is None:
        out["state"] = "ungateable" if tp else "unknown"
        out["quietSecs"] = None
        return out
    return _finalize_gated_status(out, tp, verdict)


def status(group: dict) -> dict:
    members = [_member_status(m) for m in group.get("members", [])]
    counts: dict[str, int] = {}
    for rec, m in zip(group.get("members", []), members):
        counts[m.get("state") or "?"] = counts.get(m.get("state") or "?", 0) + 1
        # Which recipe `recover` would meet this member with, and whether its one automatic
        # attempt is still unspent - so "why did it escalate" is answered before anyone asks.
        kind = failure_kind(group, rec, m.get("state"))
        if kind:
            m["recovery"] = {**recoverylib.recipe_for(kind),
                             "attemptsUsed": recoverylib.attempts_used(kind, _subject(group, rec))}
    out = {"id": group["id"], "name": group.get("name"), "createdAt": group.get("createdAt"),
           "dryRun": group.get("dryRun", False), "counts": counts, "members": members,
           "sends": group.get("sends", []),
           "recoveries": recoverylib.ledger(_subject_prefix(group))}
    for key in ("phase", "error"):
        if group.get(key):
            out[key] = group[key]
    return out


# --- send ------------------------------------------------------------------------------------

def _quiesce(sid: str) -> dict:
    """Stop the member's IDLE engine so the daemon's message route reaches the app's
    composer (the docstring says why the peer pipe is not a send for a spawned chat). Returns
    {state: not-live | stopped | refused | unknown, ...}. A working or stuck engine is never
    touched: that is `refused`, with enginelib's reason, and the caller skips the member."""
    try:
        matches = hydralib.dossier(sid)
    except hydralib.DaemonError as err:
        return {"state": "unknown", "why": f"dossier unreadable: {err.detail or err}"}
    match = next((m for m in matches
                  if m.get("cliSessionId") == sid or sid in (m.get("lineageIds") or [])), None)
    if match is None and len(matches) == 1:
        match = matches[0]
    live = (match or {}).get("live")
    if live is None:
        return {"state": "not-live"}
    bg = enginelib.background_work(match)
    quiet = (enginelib.NOW_QUIET_SECS if bg.get("scanned") and not bg.get("outstanding")
             else enginelib.IDLE_STOP_SECS)
    rep = enginelib.stop_idle_engine(match, min_quiet_secs=quiet)
    if (not rep.get("stopped") and rep.get("reason") == enginelib.R_TOO_SOON
            and 0 < int(rep.get("needs_secs") or 0) <= 60):
        time.sleep(int(rep["needs_secs"]) + 1)
        rep = enginelib.stop_idle_engine(match, min_quiet_secs=quiet)
    if rep.get("stopped"):
        return {"state": "stopped", "pid": rep.get("pid"), "why": rep.get("why")}
    return {"state": "refused", "reason": rep.get("reason"), "why": rep.get("why")}


def _short_last_line(sid: str) -> str:
    """The chat's last on-screen line when it is SHORTER than the route's own verify floor
    (10 characters), else "". The composer send proves it found the right pane by matching a
    line of the chat's own last words; the route derives that from the transcript and refuses
    to type blind when every line is too short - which is exactly what a terse reply ("PONG",
    "Done.") looks like. A supplied short line is the route's documented placeholder for that
    case; a long one is never supplied, so the route's own derivation stays in charge."""
    try:
        row = hydralib.session_row(sid)
    except hydralib.DaemonError:
        row = None
    tp = (row or {}).get("transcript_path") or gatelib.find_transcript_on_disk(sid)
    if not tp:
        return ""
    try:
        text = gatelib.last_assistant_text(gatelib.read_records(tp))
    except OSError:
        return ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return ""
    last = re.sub(r"[`*_#>]", "", lines[-1]).strip()
    return last if 0 < len(last) < 10 else ""


def _unbind_if_foreign(m: dict) -> bool:
    """True, and the member unbound in its record, when its chat opens with somebody else's
    words (spawn_chat.first_turn_owner). The record keeps the id as `unboundSessionId`, so
    status stops gating a stranger's chat as ours and nothing later acts on it."""
    sid = m.get("sessionId")
    if not sid or spawn_chat.first_turn_owner(sid, m.get("prompt") or "") != "foreign":
        return False
    m["unboundSessionId"], m["sessionId"] = sid, None
    m["state"], m["why"] = "unbound", NOT_OUR_CHAT
    return True


def send(group: dict, text: str, only: list[str] | None = None, force: bool = False) -> dict:
    """One follow-up into every member with a session (or the `only` ones): the member's idle
    engine is stopped first (_quiesce), then the daemon's message route boots the chat through
    the app's own composer and confirms the turn from the transcript. Holds are respected
    unless --force (a person's word)."""
    only_set = {s.strip() for s in (only or []) if s.strip()}
    results = []
    for m in group.get("members", []):
        sid = m.get("sessionId")
        if not sid:
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": None,
                            "delivered": False, "skipped": "no session"})
            continue
        if only_set and sid not in only_set:
            continue
        if m.get("deleted"):
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "skipped": "deleted"})
            continue
        if _unbind_if_foreign(m):
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "skipped": NOT_OUR_CHAT})
            continue
        held = holdlib.why_blocked(sid)
        if held and not force:
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "skipped": held})
            continue
        eng = _quiesce(sid)
        if eng.get("state") == "refused":
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": False, "engine": eng,
                            "skipped": f"engine {eng.get('reason')}: {eng.get('why')}"})
            continue
        body = {"text": text, "confirm_secs": SEND_CONFIRM_SECS, "allow_stop_idle": True}
        short = _short_last_line(sid)
        if short:
            body["verify_text"] = short
        try:
            got = hydralib.api_post(f"/api/sessions/{sid}/message", body,
                                    timeout=SEND_CONFIRM_SECS + 150)
            got = got if isinstance(got, dict) else {}
            results.append({"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                            "delivered": bool(got.get("delivered")), "route": got.get("route"),
                            "detail": got.get("detail"), "engine": eng})
        except hydralib.DaemonError as err:
            detail = f"{err.detail or err}"
            entry = {"index": m.get("index"), "title": m.get("title"), "sessionId": sid,
                     "delivered": False, "error": detail, "engine": eng}
            # The HTTP status is what tells a refusal (4xx: nothing was typed) from an unknown
            # (a timeout or a lost connection: it may be on screen) - `recover` reads it.
            if getattr(err, "status", None):
                entry["httpStatus"] = err.status
            if "no desktop chat holds" in detail:
                # Measured 2026-09-04: a spawned chat answered, its app logged the session
                # mapping, and wrote no local_*.json for minutes - the row exists only in the
                # app's memory, and the daemon's route finds a chat by that record.
                entry["hint"] = ("the app has not written this chat's record to disk yet (it "
                                 "renders the row from memory); retry once it has, or open the "
                                 "chat in the app once")
            elif "already holds text" in detail:
                entry["hint"] = ("the chat's composer holds a draft that is not ours; the "
                                 "actuator never overwrites one - clear it in the app, then retry")
            results.append(entry)
    record = {"at": _now_iso(), "text": text[:200], "results": results}
    if any(_refused_before_typing(r) for r in results):
        # the whole text, kept only when `recover` may owe it one re-send
        record["retryText"] = text
    group.setdefault("sends", []).append(record)
    _upsert(group)
    return record


def _refused_before_typing(result: dict) -> bool:
    """A send the message route REFUSED with a 4xx: it answered, and it typed nothing."""
    return (not result.get("delivered") and not result.get("skipped")
            and 400 <= int(result.get("httpStatus") or 0) < 500)


def send_exit_code(record: dict) -> int:
    attempted = [r for r in record["results"] if not r.get("skipped")]
    if not attempted:
        return 2
    return 0 if all(r.get("delivered") for r in attempted) else 4


# --- recover ---------------------------------------------------------------------------------
# WHY: a failed member used to get whatever the manager chat thought of next - usually the same
# send again, and again. `recover` meets each failed member with its recipe from lib/recoverylib
# (one automatic attempt, then the recipe's escalation), and every attempt lands on the recovery
# ledger that `status` shows.

STALL_QUESTION = ("You have been quiet on this task for a while. Are you stuck? Reply with where "
                  "you are and what is blocking you, or say that you are done.")


def _subject_prefix(group: dict) -> str:
    return f"fanout:{group['id']}:"


def _subject(group: dict, m: dict) -> str:
    return f"{_subject_prefix(group)}{m.get('index')}"


def _last_send_result(group: dict, sid: str) -> tuple[dict | None, dict | None]:
    """The newest send record that reached this member, and this member's result in it."""
    for rec in reversed(group.get("sends", [])):
        for r in rec.get("results", []):
            if r.get("sessionId") == sid:
                return rec, r
    return None, None


def failure_kind(group: dict, m: dict, state: str | None) -> str | None:
    """The recipe kind a member's failure maps to, or None when nothing is owed. Only failures
    the table knows: a refused or crashed spawn is a person's call, not a recipe."""
    if state == "unassigned":
        return "account-at-cap"
    sid = m.get("sessionId")
    if not sid or m.get("deleted"):
        return None
    if state == "stalled":
        return "chat-stalled"
    _, last = _last_send_result(group, sid)
    if last and not last.get("delivered") and not last.get("skipped"):
        return "delivery-failed"
    return None


def _resend_step(group: dict, m: dict, force: bool):
    rec, last = _last_send_result(group, m["sessionId"])

    def step() -> tuple[bool, str]:
        if not _refused_before_typing(last or {}):
            return False, ("the message route did not refuse the send outright, so the text may "
                           "already be on screen - never re-sent blind")
        text = (rec or {}).get("retryText")
        if not text:
            return False, "the failed send's full text was not kept, so it cannot be re-sent"
        got = send(group, text, only=[m["sessionId"]], force=force)
        r = next(iter(got["results"]), {})
        return bool(r.get("delivered")), str(r.get("skipped") or r.get("error") or r.get("detail")
                                             or ("delivered" if r.get("delivered") else "not delivered"))
    return step


def _ask_stalled_step(group: dict, m: dict, force: bool):
    def step() -> tuple[bool, str]:
        got = send(group, STALL_QUESTION, only=[m["sessionId"]], force=force)
        r = next(iter(got["results"]), {})
        return bool(r.get("delivered")), str(r.get("skipped") or r.get("error") or r.get("detail")
                                             or ("asked" if r.get("delivered") else "not asked"))
    return step


def _replace_step(group: dict, m: dict, force: bool):
    def step() -> tuple[bool, str]:
        targeting = group.get("targeting")
        if targeting is None:
            # a group from before targeting was recorded: its --exclude (the calling chat's own
            # account, from the MCP) is unknown, and guessing could land work on that account
            return False, "this group's account fence was not recorded - not re-ranked"
        taken = [str(x["instanceNum"]) for x in group.get("members", []) if x.get("instanceNum")]
        ranking = rank_targets(exclude=list(targeting.get("exclude") or []) + taken,
                               only=targeting.get("only") or None)
        if not ranking["targets"]:
            return False, "re-ranked: still no account with room"
        target = ranking["targets"][0]
        m["instance"], m["instanceNum"] = f"#{target['num']} {target['name']}", target["num"]
        ids = {x["sessionId"] for x in group.get("members", []) if x.get("sessionId")}
        _spawn_member(group, m, target, ids, force)
        return m.get("state") == "spawned", f"{m['state']} into {m['instance']}" + (
            f": {m['why']}" if m.get("why") else "")
    return step


_STEPS = {"delivery-failed": _resend_step, "chat-stalled": _ask_stalled_step,
          "account-at-cap": _replace_step}


def recover(group: dict, force: bool = False) -> dict:
    """Meet every failed member with its recipe: one automatic attempt, then the recipe's
    escalation, each written to the recovery ledger. Members with nothing owed are left alone."""
    results = []
    for m in group.get("members", []):
        state = _member_status(m).get("state")
        kind = failure_kind(group, m, state)
        if not kind:
            continue
        row = recoverylib.attempt_recovery(
            kind, _subject(group, m), _STEPS[kind](group, m, force),
            context=f"member [{m.get('index')}] {str(m.get('title'))[:60]} was {state or kind}")
        results.append({"index": m.get("index"), "title": m.get("title"),
                        "sessionId": m.get("sessionId"), **row})
    _upsert(group)
    return {"id": group["id"], "name": group.get("name"), "results": results}


def recover_exit_code(record: dict) -> int:
    if not record["results"]:
        return 2
    return 0 if all(r.get("outcome") == "recovered" for r in record["results"]) else 4


# --- delete ----------------------------------------------------------------------------------

def delete_group(group: dict, force: bool = False) -> dict:
    """delete_chat.py on every member this group spawned: engine stopped if idle, the app's
    own Delete where the app runs, record + transcript gone everywhere, undo copy first."""
    results = []
    for m in group.get("members", []):
        sid = m.get("sessionId")
        base = {"index": m.get("index"), "title": m.get("title"), "sessionId": sid}
        if not sid:
            results.append({**base, "deleted": False, "skipped": "no session"})
            continue
        if m.get("deleted"):
            results.append({**base, "deleted": True, "skipped": "already deleted"})
            continue
        if _unbind_if_foreign(m):
            # somebody else's chat, adopted by a spawn from before the first-turn check: never
            # deleted, --force included - force is a person's word about holds, not ownership
            results.append({**base, "deleted": False, "skipped": NOT_OUR_CHAT})
            continue
        try:
            # the instance this group spawned the chat into: the app that renders it even
            # before its record reaches the disk
            res = delete_chat.delete(sid, stop_idle=True, force=force,
                                     instance_hint=(str(m["instanceNum"])
                                                    if m.get("instanceNum") else None))
        except hydralib.DaemonError as err:
            res = {"ok": False, "code": 1, "why": f"daemon failure: {err.detail or err}"}
        m["deleted"] = bool(res.get("ok"))
        m["deleteReport"] = {k: res.get(k) for k in ("code", "why", "trash", "remaining", "ui",
                                                     "engine", "note") if k in res}
        results.append({**base, "deleted": bool(res.get("ok")), "code": res.get("code"),
                        "why": res.get("why"), "remaining": res.get("remaining"),
                        "trash": res.get("trash"), "note": res.get("note")})
    with_session = [r for r in results if r.get("sessionId")]
    if with_session and all(r.get("deleted") for r in with_session):
        group["deletedAt"] = _now_iso()
    _upsert(group)
    return {"id": group["id"], "name": group.get("name"), "results": results}


def delete_exit_code(record: dict) -> int:
    attempted = [r for r in record["results"] if r.get("sessionId") and not r.get("skipped")]
    if not attempted:
        return 2
    return 0 if all(r.get("deleted") for r in attempted) else 4


# --- CLI -------------------------------------------------------------------------------------

def _take_values(argv: list[str], flag: str) -> list[str]:
    out = []
    i = 0
    while i < len(argv):
        if argv[i] == flag and i + 1 < len(argv):
            out.append(argv[i + 1])
            i += 2
            continue
        i += 1
    return out


def _take_value(argv: list[str], flag: str) -> str | None:
    vals = _take_values(argv, flag)
    return vals[-1] if vals else None


def _positional(argv: list[str]) -> list[str]:
    """Words that are neither flags nor a flag's value."""
    valued = {"--spec", "--per-account", "--exclude", "--only", "--text", "--group-id"}
    out = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in valued:
            i += 2
            continue
        if a.startswith("--"):
            i += 1
            continue
        out.append(a)
        i += 1
    return out


def _print_plan(group: dict, ranking: dict) -> None:
    print(f"fan-out {group['id']}{' (' + group['name'] + ')' if group.get('name') else ''}"
          f"{' - DRY RUN, nothing spawned' if group.get('dryRun') else ''}")
    print(f"  targets from the {ranking.get('source')} usage survey: "
          + ", ".join(f"#{t['num']} {t['name']} (room {t['roomPct']}%"
                      f"{', closed' if t.get('mustOpen') else ''})" for t in ranking["targets"])
          if ranking["targets"] else "  targets: NONE - no account has room")
    for m in group["members"]:
        line = f"  [{m['index']}] {m['title'][:50]:<50} -> {m.get('instance') or 'UNASSIGNED'}"
        line += f"  {m['state']}"
        if m.get("sessionId"):
            line += f"  {m['sessionId']}"
        if m.get("why"):
            line += f"  ({m['why'][:120]})"
        print(line)


def _print_status(s: dict) -> None:
    print(f"fan-out {s['id']}{' (' + s['name'] + ')' if s.get('name') else ''} "
          f"created {s.get('createdAt')}: " + ", ".join(f"{k} {v}" for k, v in s["counts"].items())
          + (f" [{s['phase']}]" if s.get("phase") else ""))
    if s.get("error"):
        print(f"  FAILED before any member was spawned: {s['error']}")
    for m in s["members"]:
        line = f"  [{m['index']}] {m['title'][:40]:<40} {m.get('instance') or '-':<22} {m.get('state')}"
        if m.get("quietSecs") is not None:
            line += f"  quiet {m['quietSecs']}s"
        if m.get("cause"):
            line += f"  - {m['cause'][:80]}"
        print(line)
        if m.get("lastText"):
            tail = m["lastText"].strip().splitlines()
            print("      " + (tail[-1][:140] if tail else ""))
        elif m.get("why"):
            print(f"      {m['why'][:140]}")
        rec = m.get("recovery")
        if rec:
            print(f"      recipe {rec['kind']}: {rec['step'] or 'no automatic step'} "
                  f"({rec['attemptsUsed']}/{rec['maxAttempts']} used, then {rec['escalation']})")
    for r in s.get("recoveries") or []:
        print(f"  ledger {r.get('subject', '').rsplit(':', 1)[-1]:>3} {r.get('kind')}: "
              f"{r.get('outcome')}" + (f" -> {r['escalation']}" if r.get("escalation") else "")
              + f"  {str(r.get('detail') or '')[:120]}")


def _cmd_list(as_json: bool) -> int:
    """Prints every recorded fan-out group as one summary line (or as JSON rows)."""
    rows = [{"id": g["id"], "name": g.get("name"), "createdAt": g.get("createdAt"),
             "dryRun": g.get("dryRun", False),
             "members": len(g.get("members", [])),
             "spawned": sum(1 for m in g.get("members", []) if m.get("sessionId")),
             "sends": len(g.get("sends", []))} for g in groups()]
    if as_json:
        print(json.dumps({"groups": rows}, indent=2))
    else:
        for r in rows:
            print(f"{r['id']}  {r.get('name') or '-':<24} {r['createdAt']}  "
                  f"{r['spawned']}/{r['members']} spawned, {r['sends']} sends")
        if not rows:
            print("no fan-outs recorded")
    return 0


def _cmd_status(words: list[str], as_json: bool) -> int:
    """Looks up the named group and prints its members' current status."""
    group = find_group(words[1] if len(words) > 1 else None)
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    s = status(group)
    if as_json:
        print(json.dumps(s, indent=2))
    else:
        _print_status(s)
    return 0


def _cmd_send(argv: list[str], words: list[str], as_json: bool, force: bool) -> int:
    """Validates the send arguments, then delivers the text and reports per-member results."""
    text = _take_value(argv, "--text")
    if len(words) < 2 or not text or not text.strip():
        print(__doc__.strip(), file=sys.stderr)
        return 3
    group = find_group(words[1])
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    record = send(group, text.strip(), _take_values(argv, "--only"), force=force)
    if as_json:
        print(json.dumps({"id": group["id"], **record}, indent=2))
    else:
        for r in record["results"]:
            print(f"  [{r.get('index')}] {str(r.get('title'))[:40]:<40} "
                  f"{'delivered' if r.get('delivered') else 'NOT delivered'}"
                  f"  {r.get('route') or ''} {r.get('skipped') or r.get('error') or r.get('detail') or ''}")
    return send_exit_code(record)


def _cmd_recover(words: list[str], as_json: bool, force: bool) -> int:
    """Looks up the named group and meets each failed member with its recovery recipe."""
    if len(words) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    group = find_group(words[1])
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    record = recover(group, force=force)
    if as_json:
        print(json.dumps(record, indent=2))
    elif not record["results"]:
        print("nothing to recover - no member is in a failure the recipe table knows")
    else:
        for r in record["results"]:
            print(f"  [{r.get('index')}] {str(r.get('title'))[:40]:<40} {r['kind']}: "
                  f"{r['outcome'].upper()}"
                  + (f" -> {r['escalation']}" if r.get("escalation") else "")
                  + (f" (incident {r['incident']})" if r.get("incident") else "")
                  + f"  {str(r.get('detail') or '')[:120]}")
    return recover_exit_code(record)


def _cmd_delete(words: list[str], as_json: bool, force: bool) -> int:
    """Looks up the named group and deletes its spawned members, reporting the outcome."""
    if len(words) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    group = find_group(words[1])
    if not group:
        print("REFUSED: no such fan-out group (fan_out list shows them)", file=sys.stderr)
        return 3
    record = delete_group(group, force=force)
    if as_json:
        print(json.dumps(record, indent=2))
    else:
        for r in record["results"]:
            print(f"  [{r.get('index')}] {str(r.get('title'))[:40]:<40} "
                  f"{'deleted' if r.get('deleted') else 'NOT deleted'}"
                  f"  {r.get('skipped') or r.get('why') or ''}"
                  f"{'  STILL THERE: ' + '; '.join(r['remaining']) if r.get('remaining') else ''}")
    return delete_exit_code(record)


def _cmd_spawn(argv: list[str], force: bool, as_json: bool) -> int:
    """Parses --spec, ranks targets, plans assignments, and spawns the new fan-out group."""
    spec_raw = _take_value(argv, "--spec")
    if not spec_raw:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    try:
        spec = parse_spec(spec_raw)
        per_account = int(_take_value(argv, "--per-account") or 1)
    except ValueError as err:
        print(f"REFUSED: {err}", file=sys.stderr)
        return 3
    dry_run = "--dry-run" in argv
    group_id = _take_value(argv, "--group-id") or _new_group_id()
    if not dry_run:
        # THE RECORD EXISTS BEFORE ANYTHING CAN FAIL (found live 2026-09-24, chat ffb5fe39): the
        # MCP hands the caller this id at once, and a ranking that died on an unready daemon left
        # no record, so status answered "no such fan-out group" - a silent drop.
        _upsert(_placeholder(group_id, spec))
    try:
        ranking = rank_targets(exclude=_take_values(argv, "--exclude"),
                               only=_take_values(argv, "--only"),
                               open_closed="--open-closed" in argv)
    except (ValueError, hydralib.DaemonError) as err:
        daemon = isinstance(err, hydralib.DaemonError)
        why = f"daemon not ready: {err}" if daemon else str(err)
        if not dry_run:
            _upsert({**_placeholder(group_id, spec), "phase": "failed", "error": why})
        print(f"{'fan_out FAILED' if daemon else 'REFUSED'}: {why}", file=sys.stderr)
        return 1 if daemon else 3
    assignments = plan(spec["tasks"], ranking["targets"], per_account)
    group = spawn_group(spec, assignments, force=force, dry_run=dry_run, group_id=group_id,
                        targeting={"exclude": _take_values(argv, "--exclude"),
                                   "only": _take_values(argv, "--only")})
    if as_json:
        print(json.dumps({**group, "targets": ranking["targets"],
                          "skippedTargets": ranking["skipped"],
                          "usageSource": ranking["source"]}, indent=2))
    else:
        _print_plan(group, ranking)
    if group.get("dryRun"):
        return 0 if all(m.get("state") == "planned" for m in group["members"]) else 4
    return spawn_exit_code(group)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    words = _positional(argv)
    cmd = (words[0] if words and words[0] in ("list", "status", "send", "recover", "delete")
           else None)

    try:
        if cmd == "list":
            return _cmd_list(as_json)
        if cmd == "status":
            return _cmd_status(words, as_json)
        if cmd == "send":
            return _cmd_send(argv, words, as_json, force)
        if cmd == "recover":
            return _cmd_recover(words, as_json, force)
        if cmd == "delete":
            return _cmd_delete(words, as_json, force)
        return _cmd_spawn(argv, force, as_json)
    except hydralib.DaemonError as err:
        print(f"fan_out FAILED: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
