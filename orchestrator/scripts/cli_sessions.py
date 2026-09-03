#!/usr/bin/env python3
"""cli_sessions.py - OBSERVE ONLY: every CONSOLE chat, what state it is in, on which account.

The console fleet's answer to the desktop side's dossier + gate, and it is dramatically
simpler, which is the whole argument for it: a chat IS a transcript file, and a running chat
IS a process that published a record. There is no app index to disagree with, no archived
flag held in memory, no second copy of the same conversation, and nothing to render.

  a chat        <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl
  running       a record in <CLAUDE_CONFIG_DIR>/sessions/<pid>.json whose process is alive
  its state     the same gate the desktop lanes use, over the same transcript bytes

So the desktop concepts that do not exist here are exactly the ones that produced defects:
"visible but not indexed", "archived on disk but still on screen", "two records, one chat".

Usage: python cli_sessions.py [--json] [--account <name>] [--all]
       (by default only chats touched in the last 7 days; --all lifts that)
Exit:  0 always - this observes.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cli_accounts
from lib import clilib, gatelib
from lib import holdlib
from lib import peerlib

RECENT_DAYS = 7


def _transcript_cwd(path: str, max_bytes: int = 256 * 1024) -> str | None:
    """A DORMANT chat's real working directory, recovered from its own transcript.

    ⛔ THE ENCODED PROJECT-DIRECTORY NAME IS NOT THE CWD (found 2026-09-01). A running chat's
    session record carries the real cwd, but a dormant one has no such record, and the
    fallback used to be the transcript's PARENT FOLDER NAME - which is Claude Code's encoded
    form of the path (separators flattened to dashes), lossy and not a real directory. Handing
    that to cli_spawn as --folder opens a terminal in a path that usually does not exist. The
    JSONL records themselves carry the real, unencoded cwd on most lines (a session's cwd does
    not change mid-chat), so read the head of the file and return the first one found. None
    when nothing readable turns one up - never a guess dressed up as an answer.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(max_bytes).decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in head.split("\n"):
        t = line.strip()
        if not t.startswith("{"):
            continue
        try:
            ev = json.loads(t)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict) and ev.get("cwd"):
            return str(ev["cwd"])
    return None


def _console_owned() -> set[str]:
    """Session ids the console fleet can PROVE are its own - the same positive test the
    desktop side uses to exclude them, so the two fleets partition the machine consistently.

    ⛔ Both fleets leave transcripts in the same shape and both register under sessions/
    while running, so a transcript alone cannot say whose chat it is. The first cut of the
    console floor lane listed every desktop chat as a console candidate and would have
    `claude --resume`d them in terminals - resuming a desktop chat outside its app, the one
    thing every desktop memory says never to do. The second cut excluded chats with a desktop
    meta record and claimed the rest - which swept in every one-shot `claude -p` transcript
    under ~/.claude (compaction runs, drills) as a chat to wake. Now: a chat is ours when its
    transcript lives under a console ACCOUNT's config dir, or the registry says the CLI
    started it. A dormant ~/.claude transcript nobody can vouch for belongs to neither lane,
    and neither lane touches it - that is the honest answer, not a gap.
    """
    from lib import hydralib

    return hydralib.console_session_ids()


def chats(account_filter: str | None = None, recent_days: int | None = RECENT_DAYS) -> list[dict]:
    now = time.time()
    rows: list[dict] = []
    ours = _console_owned()
    for acct in cli_accounts.accounts():
        if account_filter and account_filter.lower() not in acct["name"].lower():
            continue
        cfg = Path(acct["configDir"])
        live = {str(r.get("sessionId")): r for r in peerlib.live_sessions(cfg)}
        proj = cfg / "projects"
        if not proj.exists():
            continue
        for tp in proj.glob("*/*.jsonl"):
            try:
                age_days = (now - tp.stat().st_mtime) / 86400
            except OSError:
                continue
            if recent_days is not None and age_days > recent_days:
                continue
            sid = tp.stem
            rec = live.get(sid)
            # Only what this fleet can prove is its own (see _console_owned).
            if sid not in ours:
                continue
            verdict = gatelib.gate(sid, str(tp), {"pid": rec["pid"]} if rec else None)
            fin = (verdict or {}).get("finished") or {}
            # A running chat's own session record carries the real cwd; a dormant one has no
            # such record, so recover it from the transcript itself rather than reporting the
            # encoded project-directory name (see _transcript_cwd). None when it cannot be
            # recovered - a caller that needs a real folder must check for that, not assume one.
            cwd = (rec or {}).get("cwd") or (None if rec else _transcript_cwd(str(tp)))
            rows.append({
                "sessionId": sid, "account": acct["name"], "configDir": str(cfg),
                "cwd": cwd,
                "name": (rec or {}).get("name"),
                "running": bool(rec), "pid": (rec or {}).get("pid"),
                "ageDays": round(age_days, 2),
                "state": (verdict or {}).get("state") or "ungateable",
                "lane": fin.get("lane"),
                "cause": (verdict or {}).get("cause") or "",
                "held": holdlib.why_blocked(sid),
                "transcript": str(tp),
            })
    rows.sort(key=lambda r: (not r["running"], r["ageDays"]))
    return rows


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    acct = argv[argv.index("--account") + 1] if "--account" in argv else None
    rows = chats(acct, None if "--all" in argv else RECENT_DAYS)
    if "--json" in argv:
        print(json.dumps(rows, indent=2))
        return 0
    running = [r for r in rows if r["running"]]
    print(f"{len(rows)} console chat(s), {len(running)} running")
    for r in rows[:60]:
        mark = "RUN" if r["running"] else "   "
        lane = f"/{r['lane']}" if r["lane"] else ""
        held = " HELD" if r["held"] else ""
        label = r["name"] or (Path(r["cwd"]).name if r["cwd"] else "(cwd unknown)")
        print(f"  {mark} [{r['account']:<10}] {r['state']}{lane}{held}  "
              f"{label[:34]:<34} {r['ageDays']:6.1f}d  "
              f"{r['sessionId'][:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
