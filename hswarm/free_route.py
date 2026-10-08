"""Free web accounts first: a TOOL-FREE task may be answered by one of the owner's signed-in Free claude.ai or chatgpt.com
accounts, which AgentHydra manages, before any paid API leg is used. `consult` reads `free_status`, sends one `free_chat`
task and polls `free_results` over AgentHydra's MCP endpoint (POST /api/mcp, stateless JSON-RPC).

Never a failure of its own: the daemon down or slow, not ready, no idle signed-in account, a refused send, a failed or
timed-out task, or an answer that is not the JSON the schema asks for keeps the task on its API route, logged once per job.
The route taken is on the result (`selection["route"]`) and its ledger line (provider `free`, cost 0). A free account only
answers text: no tools, no system-prompt field, so the system text rides in the prompt."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request

from . import config, shared
from .climayte_route import WORKER_ENV, base_url
from .spec import Result, Task, inline_files, now_iso

log = logging.getLogger("hswarm.free")

STATUS_TIMEOUT_S = 5.0  # 2 s sent every task to the API while the daemon stalled (39 jobs at 23:51-00:00Z, 2026-10-07)
MAX_PROMPT_CHARS = 100_000
WAIT_S = 40  # the daemon waits at most 45 s per call
WAIT_CAP_S = 240  # the longest a free account may hold a task before it goes back to its API route, whatever its timeout_s
HAIKU_PROFILES = ("routine", "general")
_LOGGED: set[str] = set()
_ACTIVE = 0  # tasks on a free account right now, across every job of this process (route_via_free_max)
SCHEMA_LINE = "Answer with only one JSON value that satisfies this JSON Schema, with no prose and no code fence:"


def eligible(task: Task) -> bool:
    """A tool-free, text-only, auto-routed API task of an ordinary profile that no rule keeps off a third-party chat."""
    if os.environ.get(WORKER_ENV) or (shared.REQUEST.get() or {}).get("climayte_worker"):
        return False
    if not config.ROUTE_VIA_FREE or not base_url():
        return False
    if task.tools != "none" or getattr(task, "images", None) or task.zdr:
        return False
    if task.purpose == "evaluation" or task.backend != "api":
        return False
    # An auto task carries its profile and, once built, the plan's first concrete model (spec._resolve_backend); a
    # pinned one has no profile. So the profile, never `model == auto`, says whether HSwarm may choose the route.
    if task.profile not in config.ROUTE_VIA_FREE_PROFILES:
        return False
    return len(shape(task)) <= MAX_PROMPT_CHARS


def shape(task: Task) -> str:
    """The task as a chat message: system text under a heading, the prompt, inlined files, then the schema line."""
    parts = []
    if task.system and task.system.strip():
        parts.append("# Instructions\n\n" + task.system.strip())
    parts.append(inline_files(task, task.prompt.strip()))
    if task.schema:
        parts.append(SCHEMA_LINE + "\n" + json.dumps(task.schema, ensure_ascii=False))
    return "\n\n".join(parts)


def _say(job_id: str, msg: str) -> None:
    if job_id not in _LOGGED:
        _LOGGED.add(job_id)
        log.warning("job %s: %s", job_id, msg)


def _rpc(name: str, arguments: dict, timeout: float) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(base_url() + "/api/mcp", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            doc = json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise OSError(f"HTTP {e.code}") from e
    result = doc.get("result") or {}
    if result.get("isError"):
        raise OSError("tool error")
    return json.loads(result["content"][0]["text"])


async def _call(name: str, arguments: dict, timeout: float) -> dict:
    # to_thread cannot stop a socket early, so the wait is bounded here as well as on the socket
    return await asyncio.wait_for(asyncio.to_thread(_rpc, name, arguments, timeout), timeout + 0.5)


_ERRORS = (OSError, ValueError, KeyError, IndexError, TypeError, asyncio.TimeoutError)


def _idle(status: dict) -> int:
    """Signed-in accounts neither busy nor resting after a failed send (mcp-free.ts restingFor)."""
    if not status.get("ready"):
        return 0
    return sum(1 for a in status.get("accounts") or []
               if isinstance(a, dict) and a.get("signedIn") and not a.get("busy") and not a.get("resting"))


def _result(task: Task, one: dict, why: str, started: str, job_id: str) -> Result | None:
    from .worker import payload_in_text

    text = str(one.get("response") or "").strip()
    if not text:
        _say(job_id, "the free account's reply was empty; the task runs on its API route")
        return None
    # `seconds` is the account's own time on it (free_results), so the ledger shows how busy the Free accounts are.
    on_account = float(one.get("seconds") or 0.0)
    res = Result(id=task.id, backend=task.backend, model="free:" + str(one.get("model") or "unknown"), status="ok",
                 answer=text, cost_usd=0.0, started=started, finished=now_iso(), seconds=on_account,
                 api_seconds=on_account)
    if task.schema:
        data = payload_in_text(text, task.schema)  # strips a code fence; the same schema check as the API route
        if data is None:
            _say(job_id, "the free account's reply did not match the task's schema; the task runs on its API route")
            return None
        res.data = data
    res.selection = {"route": {"via": "free", "account": one.get("account"), "chat_id": one.get("chat_id"), "why": why}}
    return res


async def _serve(job_id: str, task: Task) -> tuple[Result | None, dict | None]:
    started = now_iso("milliseconds")
    name = f"hswarm {job_id} {task.id}"
    try:
        item = {"prompt": shape(task), "name": name}
        # Narrow work asks for the lightest Claude model (Haiku 5.5); research and decision keep the account's usual one
        # (owner, 2026-10-07: low-impact Haiku 5.5 through free instances where possible).
        if task.profile in HAIKU_PROFILES:
            item["model"] = "haiku"
        sent = await _call("free_chat", {"tasks": [item], "wait_s": WAIT_S}, WAIT_S + 5)
    except _ERRORS as e:
        _say(job_id, f"free chat send failed ({type(e).__name__}); the task runs on its API route")
        return None, None
    batch = sent.get("batch")
    if not batch:
        _say(job_id, "free chat refused the task; it runs on its API route")
        return None, None
    loop = asyncio.get_running_loop()
    waits = min(task.timeout_s, WAIT_CAP_S)
    deadline = loop.time() + waits
    while True:
        one = next((t for t in sent.get("tasks") or [] if isinstance(t, dict)), {})
        state = one.get("state")
        if state == "done":
            why = "tool-free task on a signed-in Free account, no API cost"
            res = _result(task, one, why, started, job_id)
            return (res, None) if res else (None, {"via": "api", "fallback": "the free reply was unusable", "account": one.get("account")})
        if state == "failed":
            _say(job_id, f"free account failed the task ({one.get('error') or 'no reason'}); it runs on its API route")
            return None, {"via": "api", "fallback": "free account failed", "account": one.get("account"),
                          "error": str(one.get("error") or "")[:200]}
        left = deadline - loop.time()
        if left <= 1:
            _say(job_id, f"free account still {state or 'silent'} after {waits} s; the task runs on its API route")
            return None, {"via": "api", "fallback": "free account timed out", "account": one.get("account")}
        try:
            sent = await _call("free_results", {"batch": batch, "wait_s": int(min(WAIT_S, left))}, min(WAIT_S, left) + 5)
        except _ERRORS as e:
            _say(job_id, f"free results unavailable ({type(e).__name__}); the task runs on its API route")
            return None, None


async def consult(job_id: str, task: Task) -> tuple[Result | None, dict | None]:
    """(a finished Result, None) when a free account served the task; (None, note) when the API route runs and the
    note says why; (None, None) when nobody was asked or nothing is worth noting."""
    global _ACTIVE
    if not eligible(task):
        return None, None
    try:
        status = await _call("free_status", {}, STATUS_TIMEOUT_S)
    except _ERRORS as e:
        _say(job_id, f"free accounts unavailable ({type(e).__name__}); tasks keep their API route")
        return None, None
    # _idle already leaves out the accounts this process's own tasks hold, so _ACTIVE is checked only against the
    # cap: comparing it with _idle counted each of them twice and stopped a process at 3 of 6 accounts.
    if not isinstance(status, dict) or _idle(status) == 0 or _ACTIVE >= config.ROUTE_VIA_FREE_MAX:
        return None, None
    _ACTIVE += 1  # taken before any await below
    try:
        return await _serve(job_id, task)
    finally:
        _ACTIVE -= 1
