"""Offline: a leg whose host keeps failing is tried LAST by routed work until one probe finds it back (breaker.py).

Without it every one of 64 concurrent workers, and every later job, times out on a dead leg before it fails over.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import breaker, jobs  # noqa: E402
from hswarm.jobs import JobManager, leg_unavailable  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402

DOWN = "deepseek API 503: service unavailable"


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(breaker, "time", SimpleNamespace(monotonic=lambda: now[0]))
    return now


def _res(error: str | None) -> Result:
    return Result(id="t", status="error" if error else "ok", error=error, answer=None if error else "ok")


def _record(leg: str, error: str | None) -> None:
    r = _res(error)
    breaker.record(leg, r, leg_unavailable(r))


def test_routed_tasks_skip_a_leg_after_consecutive_host_failures_until_a_probe_serves(monkeypatch, tmp_path, clock):
    calls: list[str] = []
    healthy = {"deepseek-flash-or": False}

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        calls.append(task.model)
        if warm is not None and is_pilot:
            warm.set()
        down = task.model == "deepseek-flash-or" and not healthy["deepseek-flash-or"]
        return Result(id=task.id, backend="api", model=task.model, status="error" if down else "ok",
                      error=DOWN if down else None, answer=None if down else "42"), []

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash-or", "deepseek-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: object())

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    def run_one():
        calls.clear()

        async def go():
            job = m.submit([Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})])
            return await asyncio.wait_for(m.wait(job.id, None), 10)
        return asyncio.run(go()).results["t1"]

    for _ in range(breaker.THRESHOLD):  # each pays for finding the leg down, and fails over
        r = run_one()
        assert calls == ["deepseek-flash-or", "deepseek-flash"] and r.failover == ["deepseek-flash-or"]
    assert breaker.state("deepseek-flash-or") == "open"

    r = run_one()  # open: straight to the fallback, the dead leg is not called at all
    assert calls == ["deepseek-flash"] and r.status == "ok" and r.failover == []

    clock[0] += breaker.OPEN_S  # half-open: one task probes the leg in its usual place; it serves, so it closes
    healthy["deepseek-flash-or"] = True
    r = run_one()
    assert calls == ["deepseek-flash-or"] and r.status == "ok"
    assert breaker.state("deepseek-flash-or") == "closed" and breaker.report() == {}


def test_only_host_failures_count_and_an_answer_resets_the_count(clock):
    for err in ("FAILED: the premise is wrong", 'deepseek API 400: {"error":"bad schema"}',
                "NoUsableKey: every one of the 4 deepseek keys is disabled", 'groq API 413: Request too large'):
        for _ in range(breaker.THRESHOLD + 1):
            _record("x", err)
        assert breaker.state("x") == "closed", err
    _record("y", DOWN)
    _record("y", "deepseek API 504: stalled: no reply within 180s")
    _record("y", "FAILED: the leg served, the work did not")  # an answer, so not CONSECUTIVE host failures
    _record("y", "ConnectError: getaddrinfo failed")
    assert breaker.state("y") == "closed"
    _record("y", "SlowLeg: gemini-3.8-flash averaged 58s a turn over 3 turns (budget 30s)")
    _record("y", "claude exit 1: API Error: 529 overloaded")
    assert breaker.state("y") == "open" and breaker.order(["y", "z"]) == ["z", "y"]


def test_half_open_hands_out_one_probe_and_a_failed_probe_reopens(clock):
    for _ in range(breaker.THRESHOLD):
        _record("a", DOWN)
    assert breaker.order(["a", "b"]) == ["b", "a"]
    clock[0] += breaker.OPEN_S
    assert breaker.order(["a", "b"]) == ["a", "b"], "the first task after the wait probes it"
    assert breaker.order(["a", "b"]) == ["b", "a"], "its siblings do not pile onto the probe"
    _record("a", DOWN)
    assert breaker.state("a") == "open" and breaker.report()["a"]["probe_in_s"] == breaker.OPEN_S
    assert breaker.order(["a", "b"]) == ["b", "a"]
    assert breaker.order(["a"]) == ["a"], "a leg is never dropped: with nothing else it is still the last resort"


def test_a_fallback_moved_ahead_of_an_open_primary_runs_untimed_as_the_last_leg(monkeypatch, tmp_path, clock):
    # Timed by list position, the fallback ran under SlowLeg and a slow thinking model failed over onto the dead leg.
    for _ in range(breaker.THRESHOLD):
        _record("deepseek-flash-or", DOWN)
    budgets: list[tuple[str, float | None]] = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        budgets.append((task.model, slow_turn_s))
        if warm is not None and is_pilot:
            warm.set()
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="42"), []

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash-or", "deepseek-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: object())
    monkeypatch.setattr(jobs, "_spent_legs", lambda model, plan: [])

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})])
        return await asyncio.wait_for(m.wait(job.id, None), 10)

    r = asyncio.run(go()).results["t1"]
    assert r.status == "ok" and budgets == [("deepseek-flash", None)]


def test_a_task_timeout_leaves_the_breaker_as_it_was(clock):
    for _ in range(breaker.THRESHOLD):
        _record("a", DOWN)
    breaker.record("a", Result(id="t", status="timeout", error="task exceeded 600s"), False)
    assert breaker.state("a") == "open", "running out of its own time is no answer from the host"


NOT_SERVED = ('cerebras API 404: {"message":"Model does not exist or you do not have access to it.",'
              '"type":"not_found_error","param":"model","code":"model_not_found"}')


def test_nvidia_saying_the_function_is_not_found_opens_its_leg_at_once(clock):
    # 2026-09-29: NVIDIA answered kimi-k3 with its own wording of model_not_found, and every task of a 64-task
    # review paid a call on the leg before failing over.
    leg = "rank:kimi-k3:nvidia"
    _record(leg, ('nvidia API 404: {"status":404,"title":"Not Found","detail":"Function id \'1586112a\' version '
                  '\'null\': Specified function in account \'abc\' is not found"}'))
    assert breaker.state(leg) == "open"


def test_a_model_the_keys_here_are_not_served_opens_its_leg_at_once_and_select_names_it_last(clock):
    # Board #4291, 2026-09-27: Cerebras lists qwen-3.8-27b in /models, but its one live key answers every chat call
    # 404 model_not_found. A 404 is no host failure, so the breaker never opened: every code task paid a call on the
    # leg and hswarm_select showed it as the first candidate. The answer repeats until a key changes: one opens it.
    leg, other = "rank:qwen3-8-27b:cerebras", "rank:qwen3-8-27b:groq"
    _record(leg, NOT_SERVED)
    assert breaker.state(leg) == "open" and breaker.order([leg, other]) == [other, leg]
    assert "model_not_found" in breaker.report()[leg]["why"]
    shown = breaker.mark_open([{"model": leg}, {"model": other}])
    assert [c["model"] for c in shown] == [other, leg] and shown[1]["breaker"]["state"] == "open"
    assert "breaker" not in shown[0]
    clock[0] += breaker.OPEN_S
    assert breaker.state(leg) == "open", "held longer than a host outage: the keys, not the host, decide it"
    clock[0] += breaker.NOT_SERVED_S
    assert breaker.order([leg, other]) == [leg, other], "then one task probes it, in case a key that serves it arrived"
    _record(leg, NOT_SERVED)
    assert breaker.state(leg) == "open" and breaker.report()[leg]["probe_in_s"] == breaker.NOT_SERVED_S
    _record("x", "openrouter API 404: No endpoints found matching your data policy")
    assert breaker.state("x") == "closed", "only a model the provider says it does not serve here opens at once"
