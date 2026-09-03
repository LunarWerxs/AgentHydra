#!/usr/bin/env python3
"""chatwatch.py - OBSERVE: journal every change to every desktop chat, and say WHO did it.

THE GAP THIS FILLS (owner, 2026-09-02: "it probably needs for both logging, so you can make
sure that when shit like that happens you know what's going on so you can monitor your work").
Two chats turned up archived and answering "who archived them?" took six tool calls of forensics
against file timestamps - because every lane logs what IT did, and nothing logged what HAPPENED
TO A CHAT. Those are not the same question. A chat can be archived, renamed or moved by a lane,
by another agent session on this machine, or by a person clicking in the app, and only the first
of those was ever written down. So the honest answer to "did the orchestrator do this?" was a
shrug, which is the worst possible answer for a system that is allowed to act unattended.

This reads the app's own per-chat metadata - the ground truth on disk, no daemon and no tray
needed, so it still works exactly when everything else is down and you most need it - snapshots
it, and appends every difference to a journal with a timestamp and an attribution.

ATTRIBUTION IS EVIDENCE, NEVER A GUESS. A change is credited to this orchestrator only when its
own attempts ledger names that session inside the window; everything else is reported as
EXTERNAL, meaning "not this orchestrator" - another agent session, or a person. It never
guesses which, because it cannot know, and a made-up culprit is worse than an honest "not me".

Usage:
  python chatwatch.py                 # snapshot, journal what changed, print it
  python chatwatch.py --tail 40       # the last 40 journal entries (changes nothing)
  python chatwatch.py --since 2h      # entries from the last 2 hours (30m, 2h, 3d)
  python chatwatch.py --session <id>  # every recorded change to one chat, current or prior id
  python chatwatch.py --json
  python chatwatch.py --quiet         # journal silently (how the scheduled lane runs it)

Exit:  0 always for a read - 0 for a snapshot that journalled cleanly - 1 the chat store could
       not be read at all (which is itself worth knowing, so it is never silent).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# The orchestrator's own record of what IT tried, used only to credit changes it can prove.
ATTRIB_WINDOW_MS = 180_000  # 3 min: a lane's act and the app's disk write are not simultaneous.
JOURNAL_CAP = 20_000        # keep the tail; a journal that grows forever stops being readable.


def _repo() -> Path:
    return Path(__file__).resolve().parent.parent


def _state() -> Path:
    d = os.environ.get("ORCHESTRATOR_STATE_DIR")
    return Path(d) if d else _repo() / "state"


def _instances_root() -> Path:
    d = os.environ.get("ORCH_INSTANCES_ROOT")
    return Path(d) if d else Path.home() / ".claude-instances"


def _journal_path() -> Path:
    return _state() / "logs" / "chat-journal.jsonl"


def _snapshot_path() -> Path:
    return _state() / "chat-watch-snapshot.json"


# ── reading the app's own truth ────────────────────────────────────────────────

def scan() -> dict[str, dict]:
    """Every desktop chat, keyed by its per-instance chat id.

    Deliberately reads the metadata files rather than asking the daemon: this has to work when
    the daemon is down, and the files are what the app actually believes.
    """
    out: dict[str, dict] = {}
    root = _instances_root()
    if not root.is_dir():
        return out
    for path in root.rglob("local_*.json"):
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a half-written file is not a reason to lose the pass
            continue
        try:
            instance = path.relative_to(root).parts[0]
        except ValueError:
            continue
        chat_id = str(rec.get("sessionId") or path.stem)
        out[f"{instance}/{chat_id}"] = {
            "instance": instance,
            "chatId": chat_id,
            "sessionId": rec.get("cliSessionId"),
            "title": rec.get("title"),
            "archived": bool(rec.get("isArchived")),
            "lastActivityAt": rec.get("lastActivityAt"),
        }
    return out


def _attempts(now_ms: int) -> list[dict]:
    try:
        rows = json.loads((_state() / "attempts.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    if isinstance(rows, dict):
        rows = rows.get("attempts") or []
    return [r for r in rows if isinstance(r, dict)
            and abs(now_ms - int(r.get("at") or 0)) <= ATTRIB_WINDOW_MS]


def _blame(session_id, recent: list[dict]) -> str:
    """Who moved it. Only this orchestrator's own proven acts earn its name."""
    if not session_id:
        return "EXTERNAL"
    for r in recent:
        if str(r.get("session") or "") == str(session_id):
            return f"orchestrator:{r.get('kind') or 'act'}"
    return "EXTERNAL"


# ── the diff ───────────────────────────────────────────────────────────────────

def diff(before: dict[str, dict], after: dict[str, dict], now_ms: int) -> list[dict]:
    recent = _attempts(now_ms)
    events: list[dict] = []

    def ev(kind: str, row: dict, **extra) -> None:
        events.append({
            "at": now_ms, "kind": kind, "instance": row.get("instance"),
            "chatId": row.get("chatId"), "sessionId": row.get("sessionId"),
            "title": row.get("title"), "by": _blame(row.get("sessionId"), recent), **extra,
        })

    # A move is one chat leaving and the same LINEAGE arriving elsewhere; report it as a move
    # rather than as an unrelated vanish plus an unrelated appear, which is what the raw diff
    # looks like and what made the incident hard to read.
    gone = {k: v for k, v in before.items() if k not in after}
    new = {k: v for k, v in after.items() if k not in before}
    moved_from = {}
    for nk, nv in list(new.items()):
        for gk, gv in list(gone.items()):
            if nv.get("sessionId") and nv["sessionId"] == gv.get("sessionId"):
                moved_from[nk] = gv
                gone.pop(gk, None)
                break

    for k, v in new.items():
        if k in moved_from:
            ev("moved", v, fromInstance=moved_from[k].get("instance"))
        else:
            ev("appeared", v)
    for v in gone.values():
        ev("vanished", v)
    for k, now in after.items():
        was = before.get(k)
        if not was:
            continue
        if bool(was.get("archived")) != bool(now.get("archived")):
            ev("archived" if now.get("archived") else "unarchived", now)
        if (was.get("title") or "") != (now.get("title") or ""):
            ev("renamed", now, fromTitle=was.get("title"))
    return events


def append(events: list[dict]) -> None:
    if not events:
        return
    p = _journal_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    try:  # keep the tail readable; rotation here is cheap and never loses the recent past
        lines = p.read_text(encoding="utf-8").splitlines()
        if len(lines) > JOURNAL_CAP:
            p.write_text("\n".join(lines[-JOURNAL_CAP:]) + "\n", encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def read_journal() -> list[dict]:
    p = _journal_path()
    if not p.is_file():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:  # noqa: BLE001
            continue
    return rows


def _dur(text: str) -> int:
    unit = text[-1].lower()
    mult = {"m": 60, "h": 3600, "d": 86400}.get(unit)
    return int(float(text[:-1]) * mult * 1000) if mult else int(float(text) * 1000)


def render(events: list[dict]) -> str:
    if not events:
        return "no chat changes recorded."
    lines = []
    for e in events:
        when = time.strftime("%m-%d %H:%M:%S", time.localtime((e.get("at") or 0) / 1000))
        by = e.get("by") or "?"
        mark = "!!" if by == "EXTERNAL" and e.get("kind") in ("archived", "vanished", "moved") else "  "
        extra = ""
        if e.get("kind") == "moved":
            extra = f"  ({e.get('fromInstance')} -> {e.get('instance')})"
        elif e.get("kind") == "renamed":
            extra = f"  (was: {str(e.get('fromTitle'))[:36]})"
        lines.append(f"{mark} {when}  {str(e.get('kind')):10} {str(e.get('instance') or '-'):14} "
                     f"{by:22} {str(e.get('title') or '(untitled)')[:44]}{extra}")
    lines.append(f"\n{len(events)} event(s).  '!!' = a state change this orchestrator cannot "
                 "claim - another session or a person did it.")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    quiet = "--quiet" in argv

    def opt(flag: str):
        return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else None

    tail, since, session = opt("--tail"), opt("--since"), opt("--session")

    if tail or since or session:
        rows = read_journal()
        if since:
            floor = int(time.time() * 1000) - _dur(since)
            rows = [r for r in rows if int(r.get("at") or 0) >= floor]
        if session:
            rows = [r for r in rows if session in (str(r.get("sessionId")), str(r.get("chatId")))]
        if tail:
            rows = rows[-int(tail):]
        print(json.dumps({"events": rows}, indent=2) if as_json else render(rows))
        return 0

    now_ms = int(time.time() * 1000)
    after = scan()
    if not after:
        print(f"chat store unreadable or empty at {_instances_root()} - nothing journalled.",
              file=sys.stderr)
        return 1
    try:
        before = json.loads(_snapshot_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - first run has no baseline, and that is not a failure
        before = None

    events = [] if before is None else diff(before, after, now_ms)
    append(events)
    snap = _snapshot_path()
    snap.parent.mkdir(parents=True, exist_ok=True)
    tmp = snap.with_suffix(".tmp")
    tmp.write_text(json.dumps(after), encoding="utf-8")
    tmp.replace(snap)

    if quiet:
        if events:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {len(events)} chat change(s) journalled: "
                  + ", ".join(sorted({str(e['kind']) for e in events})))
        return 0
    if before is None:
        print(f"baseline taken: {len(after)} chat(s) now tracked. Changes from here on are journalled.")
        return 0
    print(json.dumps({"events": events}, indent=2) if as_json else render(events))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
