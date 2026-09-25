"""goallib - a chat's standing goal file, read, and the words that keep it moving honestly.

WHY THIS EXISTS: the /goal command writes a standing goal to `tmp/handoff/GOAL.md` in the repo
(GOAL, STATUS: IN PROGRESS, DONE, NEXT as a `- [ ]` checklist, TOUCHED, UPDATED) so it survives a
chat swap. Nothing outside the chat ever read it back. A chat whose turn ended at a milestone sat
there with the goal still IN PROGRESS, and a chat that was re-prompted by hand had no rule for
telling a real step from a status restatement, or a finished goal from one that had quietly
shrunk to what passed. Idea adapted from OpenAI Codex's goal continuation and budget-limit
prompts (codex-rs/ext/goal/templates/goals, Apache-2.0); the wording here is written fresh.

What lives here, all pure (no daemon, no clock except the one passed in):
  * find_goal_file()  the GOAL.md a chat's working folder belongs to (walks up to the repo root);
  * parse()           STATUS, open and ticked checklist items, and a content hash;
  * mentions_goal()   whether a chat's transcript ever touched the goal file (incremental), so a
                      goal is only continued by a chat that owns it, never by a bystander in the
                      same repo;
  * continuation_text() / wrapup_text()  the two messages goal_watch types.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

GOAL_REL = Path("tmp") / "handoff" / "GOAL.md"
# How far up from a chat's cwd the goal file is looked for: a chat that cd'd into a subfolder
# still belongs to its repo's goal, but the walk stops at the repo root (the folder with .git).
_MAX_UP = 6
# The goal file is small by contract (the /goal command caps it at 4 KB); a runaway one is read
# only this far, so a tick never pulls a huge file into memory.
_MAX_BYTES = 64 * 1024

_STATUS_LINE = re.compile(r"^[#>*_ \t-]*STATUS[*_ \t]*[:=-][ \t]*[*_]*[ \t]*(.+?)[ \t*_]*$",
                          re.I | re.M)
# A GOAL written verbatim can itself hold a line that starts "Status:"; the checklist's own
# STATUS line is the one whose value is one of the states the /goal command writes.
_KNOWN = ("IN PROGRESS", "IN-PROGRESS", "DONE", "BLOCKED")
_STATUS_HEAD = re.compile(r"^#+\s*STATUS\s*$", re.I)
_OPEN_ITEM = re.compile(r"^\s*[-*]\s*\[ \]\s*(.+)$", re.M)
_DONE_ITEM = re.compile(r"^\s*[-*]\s*\[[xX]\]\s*(.+)$", re.M)
_MENTION = b"handoff/GOAL.md"


def find_goal_file(cwd: str | None) -> Path | None:
    """The GOAL.md for a chat working in `cwd`, or None."""
    if not cwd:
        return None
    try:
        here = Path(cwd)
    except (TypeError, ValueError):
        return None
    for _ in range(_MAX_UP):
        cand = here / GOAL_REL
        if cand.is_file():
            return cand
        if (here / ".git").exists() or here.parent == here:
            return None
        here = here.parent
    return None


def _status_of(text: str) -> str:
    found = [m.group(1).strip("*_- ").upper() for m in _STATUS_LINE.finditer(text)]
    # `## STATUS` as a heading, with the value on the next non-empty line.
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if _STATUS_HEAD.match(line.strip()):
            nxt = next((n for n in lines[i + 1:] if n.strip()), "")
            found.append(nxt.strip().strip("*_- ").upper())
    known = [s for s in found if s.startswith(_KNOWN)]
    return (known or found or [""])[0]


def parse(path: Path) -> dict | None:
    """{status, inProgress, open, done, hash, firstOpen} for one goal file, or None if unreadable.

    `inProgress` is the only state that is continued: DONE, BLOCKED or anything the chat wrote
    itself is its own call and is left alone."""
    try:
        with open(path, "rb") as f:
            raw = f.read(_MAX_BYTES)
    except OSError:
        return None
    # CRLF on Windows: a `$` in multiline mode stops before "\n", so "\r" would ride into the
    # status and "DONE\r" would read as unknown.
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    status = _status_of(text)
    opened = _OPEN_ITEM.findall(text)
    return {"status": status or "UNKNOWN",
            "inProgress": status.startswith("IN PROGRESS") or status.startswith("IN-PROGRESS"),
            "open": len(opened), "done": len(_DONE_ITEM.findall(text)),
            "firstOpen": opened[0].strip()[:160] if opened else "",
            "hash": hashlib.sha256(raw).hexdigest()[:16]}


def mentions_goal(transcript_path: str, cache: dict | None = None) -> tuple[bool, dict]:
    """(did this transcript ever name the goal file, cache for next time).

    Incremental like stalllib.scan: only bytes appended since the last tick are read, and once a
    chat has named the file it stays an owner. A file that shrank is read again from the start."""
    p = Path(transcript_path)
    try:
        size = p.stat().st_size
    except OSError:
        return False, {}
    c = cache or {}
    if c.get("path") != str(p) or size < int(c.get("offset", 0)):
        c = {"path": str(p), "offset": 0, "mentions": False}
    if c["mentions"]:
        return True, c
    with open(p, "rb") as f:
        # Step back a little so a mention split across the previous read's end is still seen.
        start = max(0, int(c["offset"]) - len(_MENTION))
        f.seek(start)
        chunk = f.read()
    # Transcripts escape Windows paths ("tmp\\handoff\\GOAL.md"), so both slash forms count.
    c["mentions"] = _MENTION in chunk or b"handoff\\\\GOAL.md" in chunk or b"handoff\\GOAL.md" in chunk
    c["offset"] = start + len(chunk)
    return c["mentions"], c


def continuation_text(goal: dict, *, rel_path: str, unchanged_for: int = 0) -> str:
    """The message that re-prompts a chat whose turn ended with its goal still IN PROGRESS.

    Three audits, each a rule the chat can apply to itself: label the last turn, count a repeated
    blocker once, and prove DONE item by item. `unchanged_for` is the lane's own observation: how
    many earlier continuations left the goal file byte-identical."""
    head = (f"AgentHydra goal check: {rel_path} still reads STATUS: IN PROGRESS "
            f"({goal['open']} open, {goal['done']} done) and this chat's turn has ended. "
            "Continue the goal from NEXT"
            + (f' (first open item: "{goal["firstOpen"]}")' if goal.get("firstOpen") else "")
            + ".")
    seen = ""
    if unchanged_for:
        seen = (f"\n\nObserved from outside: the goal file has not changed since the last "
                f"{unchanged_for} goal check(s). Treat that as no progress unless you can name "
                "what moved.")
    return (
        head + seen
        + "\n\nFirst, audit the turn that just ended in one line, as exactly one of:"
        "\n- PROGRESS: a NEXT item moved, and what shows it (a diff, an exit code, a live read)."
        "\n- VERIFIED WAIT: you polled a live handle this turn (a task id, a build, a CI run) and "
        "it is still running. Name the handle. A timeout is not an ending: check the handle again "
        "before calling it dead."
        "\n- NO PROGRESS: anything else. Restating status, re-planning or re-reading files is no "
        "progress. The same blocker met again in other words is one blocker, not new work: after "
        "a second no-progress turn on it, change approach or set STATUS: BLOCKED."
        "\n\nThen work. Rewrite the goal file after each milestone. Set STATUS: DONE only after a "
        "completion audit: every requirement in GOAL mapped to evidence you saw this session. Do "
        "not shrink the goal to fit what passes; an item you could not finish stays - [ ] with the "
        "reason. If only the owner can unblock it (a spend, a credential, another person), set "
        "STATUS: BLOCKED naming that one thing, finish everything else, and stop."
    )


def wrapup_text(goal: dict, *, rel_path: str, pct: int, wrapup_pct: int) -> str:
    """The message sent instead of a continuation when the chat's account nears its usage cap.

    A goal cut off mid-step by the limit loses the step AND the handoff; one wrapped up a little
    early loses neither. It never marks the goal DONE: running out of budget is not finishing."""
    return (
        f"AgentHydra goal check: this chat's account is at {pct}% of its usage window (the wrap-up "
        f"line is {wrapup_pct}%), and {rel_path} still reads STATUS: IN PROGRESS with "
        f"{goal['open']} open item(s). Do not start new work. Finish or safely stop the step in "
        "hand, then rewrite the goal file so another chat can resume it cold: tick what is done "
        "with its evidence, leave every unfinished item as - [ ] in NEXT with the exact next "
        "command, keep STATUS: IN PROGRESS (a goal is not done because the budget ran out), and "
        "update UPDATED. Then stop, with a three-line recap: done, left, and what proves the done "
        "part."
    )
