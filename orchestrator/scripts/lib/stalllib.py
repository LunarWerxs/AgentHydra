"""stalllib - which of a chat's BACKGROUND tasks are still open, and how long each has been silent.

THE COMPLAINT THIS EXISTS FOR (owner, 2026-09-24): "You keep starting sub chats that go forever.
... you don't tell me that you're done. You have the annoying little gray dot forever, even if
you're done, if one of your sub chats are running. And tons of your sub chats ... keep friggin'
running for like 15 hours, and I keep trusting that dot, and I should not trust that dot."

A chat's main turn can finish while a background sub-agent, workflow or shell it launched hangs.
The desktop app keeps the session "running" (the grey dot) for as long as ANY background task is
registered, the chat's model is idle so nothing inside it ever looks again, and a hung task never
sends the completion notice that would wake it. overlord.long_runners() cannot see this shape: it
skips a chat whose last record is finished assistant text, which is exactly what such a chat looks
like. Nothing the chat was TOLD to remember fixes it, so the check lives here, outside every chat.

WHAT THIS READS - the chat's own transcript, nothing else:
  * a LAUNCH is a tool result whose `toolUseResult` names a background task: `agentId` with
    `isAsync` (the Agent tool), `taskId` with `taskType: local_workflow` (the Workflow tool), or
    `backgroundTaskId` (a Bash/PowerShell run in the background, including a foreground command
    the harness moved to the background when it hit its timeout).
  * an END is a `<task-notification>` naming the task id with any status (completed, failed,
    killed, stopped), wherever the harness wrote it (a `queue-operation` record, a
    `queued_command` attachment, or a plain user string), OR a successful TaskStop of that id -
    a TaskStop leaves no notification behind, so without this a stopped task would read as open
    forever. A launch recorded under a DIFFERENT sessionId than the transcript's own is from a
    previous process of a resumed chat; that process is gone, so its tasks cannot be running.
  * SILENCE is how long since the task last wrote anything: an agent's own transcript, the
    newest file in a workflow's transcript directory (and, per agent, which ones started and never
    returned a result in its journal), or a shell's output file.

MEASURED THRESHOLD (2026-09-24, 10,132 sub-agent transcripts over 14 days on this machine): the
longest silence inside an agent that went on to finish was 0.6 min at the median, 3.2 min at p90
and 18.9 min at p99. Every longer gap was a single tool call that itself hung (a code-search MCP
call sat 26-30 minutes before returning). So 20 minutes of silence is past 99% of healthy work,
and asking at that point is right even for the rare long one - the ask is a question, never a
kill; the chat that owns the task makes the call.

Pure functions over files: no daemon, no clock except the one passed in, so every rule here is
unit-testable against a fixture transcript.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

_NOTIFY_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
_TASK_ID_RE = re.compile(r"<task-id>\s*([^<\s]+)\s*</task-id>")
_STATUS_RE = re.compile(r"<status>\s*([^<\s]+)\s*</status>")
_BG_ID_RE = re.compile(r"running in background with ID:\s*([A-Za-z0-9_-]+)")
_OUTPUT_RE = re.compile(r"Output is being written to:\s*(\S+?\.output)")
_WF_TASK_RE = re.compile(r"Task ID:\s*([A-Za-z0-9_-]+)")
_WF_DIR_RE = re.compile(r"Transcript dir:\s*(.+)")
_WF_RUN_RE = re.compile(r"\b(wf_[A-Za-z0-9_-]+)")
_AGENT_ID_RE = re.compile(r"agentId:\s*([A-Za-z0-9_-]+)")


def _epoch(ts) -> float | None:
    if not ts:
        return None
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.timestamp() if dt.tzinfo else dt.replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content if isinstance(b, dict))
    return ""


def _notifications(rec: dict) -> list[str]:
    """Every task id this record reports as ended. Only the three places the harness writes a
    notification are read - a notification QUOTED inside a tool result or an assistant message
    (this module's own tests, a transcript being discussed) must never end a real task."""
    texts = []
    if rec.get("type") == "queue-operation" and isinstance(rec.get("content"), str):
        texts.append(rec["content"])
    att = rec.get("attachment")
    if isinstance(att, dict) and att.get("type") == "queued_command" and isinstance(att.get("prompt"), str):
        texts.append(att["prompt"])
    if rec.get("type") == "user":
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, str):
            texts.append(content)
    ended = []
    for text in texts:
        for block in _NOTIFY_RE.findall(text):
            tid = _TASK_ID_RE.search(block)
            if tid and _STATUS_RE.search(block):
                ended.append(tid.group(1))
    return ended


def _launch_from(result_block: dict, rec: dict, use: dict) -> dict | None:
    """The background task a tool result launched, or None when it launched nothing."""
    if result_block.get("is_error"):
        return None
    tur = rec.get("toolUseResult") if isinstance(rec.get("toolUseResult"), dict) else {}
    # ⛔ THE TEXT FALLBACK ONLY READS A RESULT THAT *IS* A LAUNCH MESSAGE (found on its first live
    # run, 2026-09-24): a foreground command that PRINTED a transcript sample carried
    # "running in background with ID: ..." in its output and was read as a launch. The structured
    # `toolUseResult` is the source of truth; the text is consulted only when the harness wrote
    # none, and only when the result BEGINS with the harness's own launch sentence.
    text = _text_of(result_block.get("content")).lstrip()
    if tur:
        text = ""
    elif not text.startswith(("Command running in background", "Workflow launched in background",
                              "Async agent launched")):
        text = ""
    name = use.get("name")
    label = str((use.get("input") or {}).get("description") or "")[:120]
    if tur.get("taskType") == "local_workflow" or (name == "Workflow" and _WF_TASK_RE.search(text)):
        tid = tur.get("taskId") or (_WF_TASK_RE.search(text) or [None, None])[1]
        run = tur.get("runId") or (_WF_RUN_RE.search(text) or [None, None])[1]
        tdir = tur.get("transcriptDir") or ((_WF_DIR_RE.search(text) or [None, None])[1] or "").strip()
        if not tid:
            return None
        return {"id": tid, "kind": "workflow", "label": tur.get("workflowName") or label or tid,
                "runId": run, "transcriptDir": tdir or None}
    if tur.get("backgroundTaskId") or _BG_ID_RE.search(text):
        tid = tur.get("backgroundTaskId") or _BG_ID_RE.search(text).group(1)
        out = _OUTPUT_RE.search(text)
        cmd = str((use.get("input") or {}).get("command") or "")
        return {"id": tid, "kind": "shell", "label": label or cmd[:80] or tid,
                "outputFile": out.group(1) if out else None}
    if (tur.get("isAsync") and tur.get("agentId")) or (name in ("Agent", "Task") and _AGENT_ID_RE.search(text)
                                                         and "async" in text.lower()):
        aid = tur.get("agentId") or _AGENT_ID_RE.search(text).group(1)
        return {"id": aid, "kind": "agent", "label": tur.get("description") or label or aid,
                "agentId": aid}
    return None


def scan(transcript_path: str | os.PathLike, cache: dict | None = None) -> tuple[list[dict], dict]:
    """(open background tasks, cache to pass back next time).

    Incremental: `cache` carries the byte offset already read plus the still-open state, so a
    5-minute tick over a 50 MB transcript reads only what was appended since. A file that SHRANK
    (rewritten, not appended) is re-read from the start."""
    path = Path(transcript_path)
    own_sid = path.stem
    try:
        size = path.stat().st_size
    except OSError:
        return [], {}
    c = cache or {}
    if not c or c.get("path") != str(path) or size < int(c.get("offset", 0)):
        c = {"path": str(path), "offset": 0, "uses": {}, "open": {}, "stops": {}}
    uses, open_, stops = c["uses"], c["open"], c["stops"]
    with open(path, "rb") as f:
        f.seek(int(c["offset"]))
        chunk = f.read()
    # Only whole lines are consumed; a half-written last line is read on the next tick.
    cut = chunk.rfind(b"\n") + 1
    for raw in chunk[:cut].splitlines():
        try:
            rec = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(rec, dict):
            continue
        for tid in _notifications(rec):
            open_.pop(tid, None)
        content = (rec.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                name = block.get("name")
                inp = block.get("input") or {}
                if name == "TaskStop":
                    stops[block.get("id")] = inp.get("task_id") or inp.get("shell_id")
                elif name in ("Agent", "Task", "Workflow", "Bash", "PowerShell"):
                    uses[block.get("id")] = {"name": name, "input": {
                        "description": inp.get("description"), "command": inp.get("command")}}
            elif block.get("type") == "tool_result":
                uid = block.get("tool_use_id")
                if uid in stops:
                    target = stops.pop(uid)
                    if target and not block.get("is_error"):
                        open_.pop(target, None)
                    continue
                use = uses.pop(uid, None)
                if not use:
                    continue
                task = _launch_from(block, rec, use)
                if not task:
                    continue
                if rec.get("sessionId") and rec.get("sessionId") != own_sid:
                    continue  # a previous process of a resumed chat - it cannot still be running
                task["launchedAt"] = _epoch(rec.get("timestamp"))
                open_[task["id"]] = task
    c["offset"] = int(c["offset"]) + cut
    # A tool_use whose result never came is not a launch; keep the map from growing forever.
    if len(uses) > 500:
        for k in list(uses)[:-200]:
            uses.pop(k, None)
    return list(open_.values()), c


def _mtime(p) -> float | None:
    try:
        return os.stat(p).st_mtime
    except (OSError, TypeError, ValueError):
        return None


def session_dir(transcript_path: str | os.PathLike) -> Path:
    """`<project>/<sid>.jsonl` keeps its sub-agents under `<project>/<sid>/subagents/`."""
    p = Path(transcript_path)
    return p.with_suffix("")


def _workflow_pending(tdir: Path, now: float) -> list[dict]:
    """Agents a workflow's journal says STARTED and never settled, with how long each has been
    silent. One of these holds a barrier forever when it hangs.

    Read in order and by the journal's `key` (one agent() call), not by agentId: a retry starts
    the SAME key under a NEW agentId, and `failed` settles a key as surely as `result` does.
    Matching by agentId on `result` alone (the rule until 2026-09-24) left every failed or
    retried attempt open forever - 4,531 `failed` rows and 1,469 retried keys across the 1,995
    journals on this PC - so a finished workflow still read as running."""
    open_: dict[str, tuple[str, str]] = {}  # key -> (agentId of its latest attempt, label)
    try:
        lines = (tdir / "journal.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            j = json.loads(line)
        except ValueError:
            continue
        key = j.get("key") or j.get("agentId")
        if not key or not j.get("agentId"):
            continue
        if j.get("type") == "started":
            open_[key] = (j["agentId"], j.get("label") or j["agentId"])
        elif j.get("type") in ("result", "failed"):
            open_.pop(key, None)
    out = []
    for aid, label in open_.values():
        m = _mtime(tdir / f"agent-{aid}.jsonl")
        out.append({"agentId": aid, "label": label,
                    "silentSecs": max(0, int(now - m)) if m else None})
    return out


def subagent_activity(transcript_path: str | os.PathLike, now: float, recent_secs: int) -> dict:
    """What a chat's OWN sub-agents and workflows are doing, for the gate: {quietSecs, openAgents}.

    `quietSecs` is how long nothing under `<sid>/subagents/` has been written (None: nothing
    there). `openAgents` are the agents a workflow's journal says started and never settled, in
    a workflow whose folder was written within `recent_secs`; an older one is hung, which is
    stall_watch's question, not a reason to call the chat busy forever."""
    sdir = session_dir(transcript_path) / "subagents"
    newest, open_agents = None, []
    if not sdir.is_dir():
        return {"quietSecs": None, "openAgents": []}
    for root, _dirs, files in os.walk(sdir):
        stamps = [m for m in (_mtime(os.path.join(root, f)) for f in files) if m]
        if not stamps:
            continue
        folder_last = max(stamps)
        newest = folder_last if newest is None else max(newest, folder_last)
        if "journal.jsonl" in files and now - folder_last < recent_secs:
            open_agents += _workflow_pending(Path(root), now)
    return {"quietSecs": max(0, int(now - newest)) if newest else None,
            "openAgents": open_agents}


def activity(task: dict, transcript_path: str | os.PathLike, now: float) -> dict:
    """{silentSecs, ageSecs, basis, stuckAgents} for one open task. `silentSecs` is None when
    nothing on disk shows the task's activity - the caller then judges on age alone."""
    launched = task.get("launchedAt") or now
    sdir = session_dir(transcript_path) / "subagents"
    stamps: list[float] = []
    basis = ""
    stuck: list[dict] = []
    if task["kind"] == "agent":
        m = _mtime(sdir / f"agent-{task['agentId']}.jsonl")
        if m:
            stamps.append(m)
            basis = "its own transcript"
    elif task["kind"] == "workflow":
        tdir = Path(task["transcriptDir"]) if task.get("transcriptDir") else (
            sdir / "workflows" / task["runId"] if task.get("runId") else None)
        if tdir and tdir.is_dir():
            try:
                stamps.extend(m for m in (_mtime(e.path) for e in os.scandir(tdir) if e.is_file()) if m)
            except OSError:
                pass
            basis = "the newest file in its transcript folder"
            stuck = _workflow_pending(tdir, now)
    elif task["kind"] == "shell":
        m = _mtime(task.get("outputFile"))
        if m:
            stamps.append(m)
            basis = "its output file"
    last = max(stamps) if stamps else None
    # Clamped: a file written after `now` was taken (the tick reads for a few seconds) is
    # simply active, never "silent -1 min".
    silent = max(0, int(now - max(last, launched))) if last else None
    return {"silentSecs": silent, "ageSecs": int(now - launched), "basis": basis,
            "stuckAgents": stuck}


def verdict(task: dict, act: dict, *, silent_secs: int, shell_secs: int) -> str:
    """'stalled' when the owning chat should be asked, else 'active'.

    Agents and workflows are judged on SILENCE (they write constantly while healthy). A shell is
    judged on AGE: a command that redirects its own output writes nothing to its output file
    while it works, so its silence says nothing, and the one signal left is how long it has run."""
    if task["kind"] == "shell":
        return "stalled" if act["ageSecs"] >= shell_secs else "active"
    silent = act["silentSecs"] if act["silentSecs"] is not None else act["ageSecs"]
    if silent >= silent_secs:
        return "stalled"
    # ONE HUNG AGENT HOLDS A WHOLE WORKFLOW (measured on the live fleet the day this was written:
    # a workflow whose folder was written 15 minutes ago held an agent that had started and
    # written nothing for 15 HOURS). Its siblings keep the folder fresh, so folder silence alone
    # reads it as healthy - until the next barrier waits on the hung one forever. An agent with
    # no transcript yet is queued, not hung, and is not counted.
    if any((a.get("silentSecs") or 0) >= silent_secs for a in act.get("stuckAgents") or []):
        return "stalled"
    return "active"


def describe(task: dict, act: dict) -> str:
    mins = lambda s: f"{int(s // 60)} min" if s is not None else "unknown"  # noqa: E731
    kind = {"agent": "sub-agent", "workflow": "workflow", "shell": "background command"}[task["kind"]]
    if task["kind"] == "shell":
        line = f'{kind} "{task["label"]}" (id {task["id"]}) running {mins(act["ageSecs"])}'
    else:
        line = (f'{kind} "{task["label"]}" (id {task["id"]}) silent '
                f'{mins(act["silentSecs"] if act["silentSecs"] is not None else act["ageSecs"])}')
    hung = [a for a in act.get("stuckAgents") or [] if (a["silentSecs"] or 0) >= 60]
    if hung:
        worst = max(hung, key=lambda a: a["silentSecs"] or 0)
        line += (f'; inside it, agent "{worst["label"]}" started and has written nothing for '
                 f'{mins(worst["silentSecs"])}')
    return line


def nudge_text(items: list[tuple[dict, dict]]) -> str:
    """The message typed into the chat. A question with the exact commands, never an order to
    kill: the chat that launched the task is the only one that knows whether a quiet task is
    stuck or merely slow."""
    lines = [f"- {describe(t, a)}" for t, a in items]
    has_wf = any(t["kind"] == "workflow" for t, _ in items)
    return (
        "AgentHydra stall check: this chat's turn has ended but background work it started is "
        "still registered as running, which keeps the chat showing as busy:\n"
        + "\n".join(lines)
        + "\n\nIs it stuck? If so, stop it with TaskStop <id>"
        + (" (for a workflow, TaskStop it and relaunch with resumeFromRunId: finished agents "
           "come back from cache and only the stuck one reruns)" if has_wf else "")
        + ". If it is genuinely still working, say so in one line. Then tell Jacob plainly "
        "whether the job is finished."
    )
