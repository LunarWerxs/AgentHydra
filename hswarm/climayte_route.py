"""One tool with CliMayte: an agentic task may run as a Claude Code CLI worker on the owner's Claude subscription
instead of on its API route. Before a task runs, `consult` asks AgentHydra (POST /api/routing/decide, which weighs the
task's API cost against the subscription room); on 'subscription' the task is dispatched to CliMayte
(POST /api/corch/workers), polled (GET /api/corch/workers/:id) and its report is the answer.

Never a failure of its own: AgentHydra down, slow (over DECIDE_TIMEOUT_S), or answering anything but 200 keeps the
task's own route, logged once per job. A worker that fails or is cancelled hands the task back to the API route once.
The route taken is on the result (`selection["route"]`) and its ledger line (provider `climayte`)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import time
import urllib.request

from . import config, prices, shared
from .spec import Result, Task, inline_files, now_iso

log = logging.getLogger("hswarm.climayte")

DEFAULT_URL = "http://127.0.0.1:7787"
DECIDE_TIMEOUT_S = 2.0
POLL_S = 10.0
WORKER_ENV = "AGENTHYDRA_CLIMAYTE_WORKER"
LIST_MODEL = "claude-sonnet-5-5"  # the list price a non-Claude task is compared against
# What an agentic task is sized at when nothing better is known: tokens read (prompt, files and tool results across
# turns) and written. The decision only needs the order of magnitude: it compares two prices of the same work.
EST_IN_TOKENS, EST_OUT_TOKENS = 40_000, 4_000
_ELIGIBLE_TOOLS = ("read", "edit", "all")
_LOGGED: set[str] = set()
_ACTIVE = 0  # tasks routed to CliMayte right now, across every job of this process (route_via_climayte_max)
_SWITCH = {"at": -1e9, "on": True}  # AgentHydra's own routing on/off, read at most once per SWITCH_TTL_S
SWITCH_TTL_S = 60.0


def base_url() -> str:
    return os.environ.get("AGENTHYDRA_URL", DEFAULT_URL).rstrip("/")


def eligible(task: Task) -> bool:
    """An agentic task a CLI worker can do as asked: an absolute folder, tools that read or change files, no
    sandbox rule a worker could not keep (writable globs, receipts, a container), and not already a CliMayte worker."""
    if os.environ.get(WORKER_ENV) or (shared.REQUEST.get() or {}).get("climayte_worker"):
        return False  # the shared server's env is not the caller's: a worker's own request carries the header
    if not config.ROUTE_VIA_CLIMAYTE or not base_url():
        return False
    if not isinstance(task.tools, str) or task.tools not in _ELIGIBLE_TOOLS:
        return False
    if not task.cwd or not (os.path.isabs(task.cwd) or task.cwd.startswith("/")):
        return False
    if getattr(task, "runtime", "") or task.writable is not None or task.scripted or task.inventory or task.green:
        return False
    return True


def _say(job_id: str, msg: str) -> None:
    """One line per job, whatever happens to its other tasks."""
    if job_id not in _LOGGED:
        _LOGGED.add(job_id)
        log.warning("job %s: %s", job_id, msg)


def _tokens() -> dict:
    return {"input": EST_IN_TOKENS, "output": EST_OUT_TOKENS}


class _Unpriced(Exception):
    pass


def _usd(model: str) -> float | None:
    """USD of the estimated tokens on a model id as the registry names it: a leg is `rank:claude-opus-5-5-high:direct`,
    an effort or host variant of a model whose price is under its `api_id` (prices.json knows `claude-opus-5-5`)."""
    usd = prices.cost(model, _tokens())
    if usd is not None:
        return usd
    try:
        spec = config.MODELS[config.resolve_model(model)]
    except (ValueError, KeyError):
        return None
    for ref in (spec.get("api_id"), spec.get("price_ref")):
        if ref and (usd := prices.cost(str(ref), _tokens())) is not None:
            return usd
    p = spec.get("price")  # the registry's own rates ($ per million: hit, miss, out), for a model prices.json lacks
    if isinstance(p, dict) and "miss" in p and "out" in p:
        return (EST_IN_TOKENS * float(p["miss"]) + EST_OUT_TOKENS * float(p["out"])) / 1_000_000
    return None


def _api_leg(task: Task) -> dict | None:
    """{provider, model, usd} of the route the plan chose for this task, or None when it has none."""
    model = task.model
    if task.profile and task.route:
        from .dispatch import _legs, plan_for

        cands = _legs(plan_for(task), task)
        if not cands:
            return None
        model = cands[0]["model"]
    if not model or model == config.AUTO:
        return None
    usd = _usd(model)
    if usd is None:
        raise _Unpriced(model)  # never guessed at: the leg's benchmark_cost_usd is a different quantity
    try:
        provider = config.provider_of(model)
    except (ValueError, KeyError):
        provider = ""
    return {"provider": provider, "model": model, "usd": round(float(usd), 6)}


def _list_usd(api: dict | None) -> float:
    model = api["model"] if api and str(api["model"]).lower().startswith("claude") and _usd(api["model"]) is not None else LIST_MODEL
    return round(_usd(model) or 0.0, 6)


def _request(method: str, path: str, body: dict | None, timeout: float) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


async def _call(method: str, path: str, body: dict | None = None, timeout: float = 15.0) -> tuple[int, dict]:
    return await asyncio.to_thread(_request, method, path, body, timeout)


async def switch_on() -> bool:
    """AgentHydra's routing on/off (settings.enabled of GET /api/routing/cost-model), the owner's switch; read at most
    once a minute. Unreadable means the last answer stands (on, before any answer)."""
    if time.monotonic() - _SWITCH["at"] < SWITCH_TTL_S:
        return _SWITCH["on"]
    _SWITCH["at"] = time.monotonic()
    try:
        status, doc = await asyncio.wait_for(_call("GET", "/api/routing/cost-model", None, DECIDE_TIMEOUT_S), DECIDE_TIMEOUT_S + 0.5)
    except (OSError, ValueError, asyncio.TimeoutError):
        return _SWITCH["on"]
    enabled = (doc.get("settings") or {}).get("enabled") if status == 200 else None
    if isinstance(enabled, bool):
        _SWITCH["on"] = enabled
    return _SWITCH["on"]


async def decide(job_id: str, task: Task) -> dict | None:
    """AgentHydra's answer for this task, or None (and a log line) when it does not give one in time."""
    try:
        api = _api_leg(task)
    except _Unpriced as e:
        _say(job_id, f"{e} has no price in data/prices.json, so there is nothing to compare; tasks keep their own route")
        return None
    body = {"key": f"{job_id}:{task.id}", "listUsd": _list_usd(api), "api": api, "subscriptionRoom": True}
    try:
        # to_thread cannot stop a socket early, so the wait is bounded here as well as on the socket
        status, doc = await asyncio.wait_for(_call("POST", "/api/routing/decide", body, DECIDE_TIMEOUT_S), DECIDE_TIMEOUT_S + 0.5)
    except (OSError, ValueError, asyncio.TimeoutError) as e:
        _say(job_id, f"routing decision unavailable ({type(e).__name__}); tasks keep their own route")
        return None
    if status != 200 or doc.get("route") not in ("api", "subscription"):
        _say(job_id, f"routing decision answered HTTP {status}; tasks keep their own route")
        return None
    return doc


def brief(task: Task) -> str:
    """The task as a CLI worker is told it: HSwarm's brief for the kind of work, the prompt, its acceptance criteria
    and files, and the shape its final message must have."""
    from .acceptance import prompt_clause
    from .code_brief import system_for

    parts = [p.strip() for p in (system_for(task),) if p]
    parts.append(inline_files(task, task.prompt.strip() + prompt_clause(task.acceptance)))
    if task.schema:
        parts.append("Your final message must be ONLY one JSON object that matches this JSON Schema, no prose around it:\n"
                     + json.dumps(task.schema, ensure_ascii=False))
    return "\n\n".join(parts)


async def _cancel(wid: str) -> None:
    try:
        await _call("POST", "/api/corch/cancel", {"id": wid}, 5.0)
    except (OSError, ValueError):
        pass  # AgentHydra gone: nothing is left to cancel


async def run_worker(job_id: str, task: Task, note: dict) -> Result | None:
    """Run the task as a CliMayte worker; the Result, or None when the API route should take it instead."""
    title = (task.prompt.strip().splitlines() or ["hswarm task"])[0][:80]
    spec = {"prompt": brief(task), "cwd": task.cwd, "title": title, "kind": "code" if task.tools in ("edit", "all") else "review"}
    try:
        status, doc = await _call("POST", "/api/corch/workers", {"tasks": [spec], "group": f"hswarm-{job_id}-{task.id}"})
    except (OSError, ValueError) as e:
        _say(job_id, f"CliMayte dispatch failed ({type(e).__name__}); the task runs on its API route")
        return None
    workers = doc.get("workers") if status == 200 else None
    wid = workers[0].get("id") if isinstance(workers, list) and workers and isinstance(workers[0], dict) else None
    if not wid:
        _say(job_id, f"CliMayte refused the task (HTTP {status}); it runs on its API route")
        return None
    note["worker"] = wid
    finished = False
    try:
        res = await _wait_worker(job_id, task, note, wid)
        finished = True
        return res
    finally:
        if not finished:  # the task or job was cancelled while the worker ran
            await asyncio.shield(_cancel(wid))


async def _wait_worker(job_id: str, task: Task, note: dict, wid: str) -> Result | None:
    started = now_iso("milliseconds")
    loop = asyncio.get_running_loop()
    begun = loop.time()
    deadline = begun + task.timeout_s
    while True:
        try:
            status, w = await _call("GET", f"/api/corch/workers/{wid}")
        except (OSError, ValueError):
            status, w = 0, {}
        state = w.get("status") if status == 200 else None
        if state == "done":
            return _result(task, w, note, started, job_id)
        if state in ("failed", "cancelled"):
            _say(job_id, f"CliMayte worker {wid} {state}; its task runs on the API route")
            note["climayte_" + state] = wid
            return None
        if state != "running" and loop.time() - begun >= config.ROUTE_VIA_CLIMAYTE_START_S:
            await _cancel(wid)
            _say(job_id, f"CliMayte worker {wid} was still {state or 'unreachable'} after {config.ROUTE_VIA_CLIMAYTE_START_S:g} s; cancelled, its task runs on the API route")
            note["climayte_not_started"] = wid
            return None
        if loop.time() + POLL_S > deadline:
            await _cancel(wid)
            res = Result(id=task.id, backend=task.backend, model=w.get("reportedModel") or "claude", status="timeout",
                         error=f"CliMayte worker {wid} still {state or 'unreachable'} after {task.timeout_s} s", started=started, finished=now_iso())
            res.selection = {"route": {**note, "via": "climayte"}}
            return res
        await asyncio.sleep(POLL_S)


def _result(task: Task, w: dict, note: dict, started: str, job_id: str) -> Result | None:
    from .worker import payload_in_text, schema_errors

    text = str(w.get("result") or "").strip()
    res = Result(id=task.id, backend=task.backend, model=w.get("reportedModel") or w.get("model") or "claude", status="ok",
                 answer=text, cost_usd=0.0, started=started, finished=now_iso())
    if not text:
        note["climayte_failed"] = note.get("worker")
        return None
    if task.schema:
        data = payload_in_text(text, task.schema)
        if data is None:
            note["climayte_failed"] = note.get("worker")
            _say(job_id, "CliMayte's report did not match the task's schema; it runs on the API route")
            return None
        res.data = data
    res.selection = {"route": {**note, "via": "climayte"}}
    return res


async def consult(job_id: str, task: Task) -> tuple[Result | None, dict | None]:
    """(a finished Result, None) when CliMayte served the task; (None, note) when the API route runs, the note being
    the decision to carry on its result; (None, None) when nobody was asked."""
    global _ACTIVE
    if not eligible(task) or _ACTIVE >= config.ROUTE_VIA_CLIMAYTE_MAX:
        return None, None
    _ACTIVE += 1  # taken before any await, held from the question to the worker's end: the cap is on tasks in CliMayte's hands
    try:
        if not await switch_on():
            return None, None
        return await _consult(job_id, task)
    finally:
        _ACTIVE -= 1


async def _consult(job_id: str, task: Task) -> tuple[Result | None, dict | None]:
    doc = await decide(job_id, task)
    if doc is None:
        return None, None
    note = {"provider": "climayte", "decided": doc["route"], "why": doc.get("why", "")}
    if doc["route"] != "subscription":
        return None, {"via": "api", "decided": "api", "why": note["why"]}
    res = await run_worker(job_id, task, note)
    if res is not None:
        return res, None
    return None, {"via": "api", "decided": "subscription", "why": note["why"], "fallback": "CliMayte could not serve it",
                  **{k: v for k, v in note.items() if k.startswith("climayte_") or k == "worker"}}
