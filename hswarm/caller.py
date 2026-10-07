"""Who asked: the caller stamp every job carries, read from the environment the calling Claude
session hands its children, so the ledger can answer "which chat used the swarm" without
anyone reading transcripts (owner ask, 2026-09-15 morning).

A Claude Code engine exports CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_HOST_SESSION_ID (the desktop
chat id), CLAUDE_CODE_EXECPATH (the binary under the account's instance folder) and
CLAUDE_CODE_ENTRYPOINT to every MCP server and shell it starts; a plain CLI run has none of them
and is stamped with its argv instead. Nothing here is invented: an unknown field stays "".

The stamp also carries the MODEL the calling session was running at that moment (`model`), read
from the tail of the session's own transcript, because the savings estimate is priced at that model
(owner ask, 2026-09-15 evening: "estimated savings per utilization, based on the model at the time").
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from . import shared

_INSTANCE_RX = re.compile(r"[\\/]\.claude-instances[\\/]([^\\/]+)")
TAIL_BYTES = 262_144  # the last assistant turn is always within the last quarter megabyte of a live transcript

FIELDS = ("instance", "session_id", "chat_id", "entrypoint", "cwd", "parent_pid", "argv", "label", "model", "climayte_worker")


def _model_in_transcript(path) -> str:
    """The model of the last assistant turn in one transcript file, read from its tail; "" when there is none."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            tail = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    for line in reversed(tail.splitlines()):
        if '"model"' not in line or '"assistant"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # the first line of the tail is usually cut mid-record
        msg = rec.get("message") if isinstance(rec, dict) else None
        model = msg.get("model") if isinstance(msg, dict) else None
        if rec.get("type") == "assistant" and isinstance(model, str) and model.startswith("claude-"):
            return model
    return ""


def session_model(session_id: str) -> str:
    """The Claude model a session is running, from the last assistant record in its transcript; "" when unknown.

    HSWARM_ORCHESTRATOR_MODEL overrides it (tests, and a CLI run that knows who it stands in for)."""
    forced = os.environ.get("HSWARM_ORCHESTRATOR_MODEL")
    if forced:
        return forced.strip()
    if not session_id:
        return ""
    from .claude_usage import PROJECTS  # here, not at import: caller.py must stay import-cheap for every job

    for path in PROJECTS.glob(f"*/{session_id}.jsonl"):
        model = _model_in_transcript(path)
        if model:
            return model
    return ""


def _instance_of(execpath: str) -> str:
    """The account instance the calling binary lives under, from its path; "default" when it names none."""
    m = _INSTANCE_RX.search(execpath)
    return m.group(1) if m else ("default" if execpath else "")


_CHAT_ID_RX = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_CHATS: dict[str, dict] = {}  # chat id -> what its Desktop record says (only records found; a new chat is looked up again)


def desktop_chat(chat_id: str) -> dict:
    """{"instance", "session", "cwd"} of a Claude Desktop chat, from the record its account folder keeps
    (<profile>/claude-code-sessions/<account>/<org>/<chat id>.json: cliSessionId and cwd); {} when none is found.

    Desktop runs the shared server's headersHelper outside the chat's engine: its environment has the chat id
    (CLAUDE_CODE_HOST_SESSION_ID) but no CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_EXECPATH or CLAUDE_PROJECT_DIR, and its
    folder is ~/.claude. Measured 2026-10-07: 133 of 212 Desktop jobs on 10-06 reached the ledger as "no account,
    folder ~/.claude", so the per-account views showed the owner's Desktop accounts using a fraction of the swarm
    they really used ("using WAAAAY less Hswarm"). The record names all three."""
    if not chat_id or not _CHAT_ID_RX.match(chat_id):
        return {}
    if chat_id in _CHATS:
        return _CHATS[chat_id]
    roots = [(p.name, p / "claude-code-sessions") for p in sorted((Path.home() / ".claude-instances").glob("*"))]
    if os.name == "nt":
        roaming = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        roots.append(("default", roaming / "Claude" / "claude-code-sessions"))
    for instance, sessions in roots:
        for path in sessions.glob(f"*/*/{chat_id}.json"):
            try:
                rec = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(rec, dict):
                continue
            found = {"instance": instance, "session": str(rec.get("cliSessionId") or ""), "cwd": str(rec.get("cwd") or "")}
            _CHATS[chat_id] = found
            return found
    return {}


def _entry_of(env, argv: list[str] | None) -> tuple[str, str]:
    """(entrypoint, argv): a Claude session names its own entrypoint; a plain CLI run is stamped by its argv."""
    if env.get("CLAUDECODE") or env.get("CLAUDE_CODE_SESSION_ID"):
        return env.get("CLAUDE_CODE_ENTRYPOINT") or "claude-code", ""
    return "cli", " ".join(argv if argv is not None else sys.argv[:4])[:200]


def detect(label: str = "", argv: list[str] | None = None) -> dict:
    """The stamp for a job submitted from this process. Cheap: environment, cwd and one transcript tail."""
    if shared.ACTIVE:  # one server for every chat: its own env and cwd are whoever started it, so read the request
        r = dict(shared.REQUEST.get() or {})
        if r.get("chat") and not r.get("session"):  # stamped by a helper run outside the chat's engine (desktop_chat)
            rec = desktop_chat(r["chat"])
            if rec:
                r.update(instance=r.get("instance") or rec["instance"], session=rec["session"], cwd=rec["cwd"] or r.get("cwd"))
        session_id = r.get("session") or ""
        return {"instance": r.get("instance") or "", "session_id": session_id, "chat_id": r.get("chat") or "", "entrypoint": "mcp-http",
                "cwd": r.get("cwd") or "", "parent_pid": 0, "argv": "", "label": label or "", "model": session_model(session_id),
                "climayte_worker": bool(r.get("climayte_worker"))}
    env = os.environ
    execpath = env.get("CLAUDE_CODE_EXECPATH") or env.get("CLAUDE_CONFIG_DIR") or ""
    instance = _instance_of(execpath)
    entry, args = _entry_of(env, argv)
    session_id = env.get("CLAUDE_CODE_SESSION_ID") or ""
    return {
        "instance": instance,
        "session_id": session_id,
        "chat_id": env.get("CLAUDE_CODE_HOST_SESSION_ID") or "",
        "entrypoint": entry,
        "cwd": os.getcwd(),
        "parent_pid": os.getppid(),
        "argv": args,
        "label": label or "",
        "model": session_model(session_id),
        "climayte_worker": bool(env.get("AGENTHYDRA_CLIMAYTE_WORKER")),
    }


def key(caller: dict | None) -> str:
    """The grouping key the usage report prints: account, then the chat, then where it ran."""
    c = caller or {}
    who = c.get("instance") or "-"
    sess = (c.get("session_id") or c.get("chat_id") or "")[:8] or "-"
    where = os.path.basename((c.get("cwd") or "").rstrip("\\/")) or "-"
    return f"{who} / {sess} / {where}"


def ledger_fields(caller: dict | None) -> dict:
    """The short fields copied onto every ledger line (the full stamp lives in job.json)."""
    c = caller or {}
    try:
        from . import utilization  # here, not at import: caller.py must stay import-cheap for every job

        account = utilization.caller_account(c)  # the same hashed id the utilizations table carries
    except Exception:  # a ledger line is never lost to an account lookup
        account = ""
    return {
        "caller_instance": c.get("instance") or "",
        "caller_session": (c.get("session_id") or c.get("chat_id") or "")[:8],
        "caller_cwd": c.get("cwd") or "",
        "caller_model": c.get("model") or "",
        "caller_account": account,
    }
