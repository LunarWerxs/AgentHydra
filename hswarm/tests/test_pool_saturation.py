"""Offline: a job does not drown a rate-limited key pool, and a task on a saturated pool fails fast, by name.

Job 20260924-152821-54f1 (203 read-only tasks, auto model gemini-3.8-flash, default concurrency 64) is the
case: 60 of 61 finished tasks timed out at 600 s, 43 of them with `turns 0, api_seconds 0, failover []`. Two
gaps let that happen, and each has a test here:

- A 429 on a pool with ANOTHER key free rotates at once with no sleep, so the time went to round trips, not
  to rests, and `rest_budget_s` (which only counted sleeps) never fired. With 72 keys a task could make 74
  attempts before the client gave up. Time on a rate-limited pool is now counted in wall-clock seconds.
- A task on its route's LAST leg had no rest budget at all, so it could only ever end at `timeout_s`. It now
  gets config.SATURATED_REST_S, and the error says `PoolSaturated` so the caller knows what happened.

And the load side: every job's tasks on one provider share a LegGate that starts at config.LEG_RAMP_START
live calls, grows by one per 200, halves when a 429 finds every key resting, and never exceeds the pool's
usable keys times its per-key allowance. A task waiting for the gate is not burning its own timeout.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, client as client_mod, config, jobs  # noqa: E402
from hswarm.client import DeepSeekClient  # noqa: E402
from hswarm.jobs import JobManager, leg_unavailable  # noqa: E402
from hswarm.leggate import LegGate  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402


def _keys(n: int) -> list[str]:
    return [f"sk-test{i:04d}xxxx" for i in range(n)]


def _client(handler, keys) -> DeepSeekClient:
    c = DeepSeekClient(api_keys=keys)
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def _ok():
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1}, "model": "deepseek-flash"})


# ---- the client: time on a rate-limited pool is wall-clock, rotations included ----------------------------


def test_rotating_through_a_churning_pool_counts_against_the_rest_budget(monkeypatch):
    """Every key 429s but wakes at once, so the pool always shows a key free and the client rotates with no
    sleep. Before: 42 round trips (len(pool) + 2) before giving up, whatever the budget. Now: out at the budget."""
    monkeypatch.setattr(client_mod, "RATE_REST_S", 0.0)
    seen = []

    async def handler(req: httpx.Request):
        seen.append(1)
        await asyncio.sleep(0.05)
        return httpx.Response(429, json={"error": "rate"})

    c = _client(handler, _keys(40))
    t0 = time.monotonic()
    waited = [0.0]
    token = client_mod.RATE_WAIT.set(waited)
    try:
        with pytest.raises(ApiError) as e:
            asyncio.run(c.chat([{"role": "user", "content": "x"}], rest_budget_s=0.3))
    finally:
        client_mod.RATE_WAIT.reset(token)
    assert time.monotonic() - t0 < 1.5, "the budget was not honoured while rotating"
    assert waited[0] >= 0.25, "the rate-limited wait was not reported, so a rerun would lose it off the task's clock"
    assert e.value.status == 429 and "rate-limited" in str(e.value)
    assert len(seen) < 20
    assert leg_unavailable(Result(id="t", status="error", error=str(e.value)))


def test_a_saturated_pool_on_the_last_leg_fails_fast_and_says_pool_saturated():
    def handler(req: httpx.Request):
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "rate"})

    c = _client(handler, _keys(3))
    with pytest.raises(ApiError) as e:
        asyncio.run(asyncio.wait_for(c.chat([{"role": "user", "content": "x"}], rest_budget_s=5, last_leg=True), timeout=5))
    assert e.value.status == 429 and "PoolSaturated" in str(e.value) and "no other leg" in str(e.value)


def test_a_200_grows_the_gate_and_a_429_on_a_resting_pool_shrinks_it():
    state = {"n": 0}

    def handler(req: httpx.Request):
        state["n"] += 1
        return _ok() if state["n"] == 1 else httpx.Response(429, headers={"retry-after": "30"}, json={"error": "rate"})

    c = _client(handler, _keys(1))
    gate = LegGate("deepseek", cap=64, start=8)
    c.gate = gate
    asyncio.run(c.chat([{"role": "user", "content": "x"}]))
    assert gate.limit == 9
    with pytest.raises(ApiError):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], rest_budget_s=1, last_leg=True))
    assert gate.limit == 4 and gate.saturations == 1


# ---- the agent: which budget a leg gets ------------------------------------------------------------------


class _Recorder:
    """A client whose chat() records its kwargs and answers at once."""

    def __init__(self):
        self.kw: list[dict] = []

    async def chat(self, messages, **kw):
        self.kw.append(kw)
        from hswarm.usage import ChatResult, Usage

        return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(), model="m", seconds=0.01,
                          cost_usd=0.0, peak=False)


@pytest.mark.parametrize("slow, budget, last", [(30.0, 30.0, False), (None, None, True)])
def test_the_last_leg_gets_the_saturation_budget_and_a_middle_leg_the_slow_leg_one(tmp_path, slow, budget, last):
    rec = _Recorder()
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none"})
    res, _ = asyncio.run(agent.run_api_task(rec, task, slow_turn_s=slow))
    assert res.status == "ok", res.error
    kw = rec.kw[0]
    assert kw["rest_budget_s"] == (budget if budget is not None else config.SATURATED_REST_S)
    assert bool(kw.get("last_leg")) is last


# ---- the gate itself -------------------------------------------------------------------------------------


def test_the_gate_holds_live_calls_to_its_limit_and_the_ramp_opens_it():
    gate = LegGate("gemini", cap=10, start=2)
    live = {"now": 0, "max": 0}

    async def one():
        async with gate:
            live["now"] += 1
            live["max"] = max(live["max"], live["now"])
            await asyncio.sleep(0.01)
            live["now"] -= 1

    async def go():
        await asyncio.gather(*(one() for _ in range(12)))

    asyncio.run(go())
    assert live["max"] == 2
    for _ in range(20):
        gate.ok()
    assert gate.limit == 10  # additive increase stops at the cap
    gate.saturated()
    assert gate.limit == 5
    gate.set_cap(3)
    assert gate.limit == 3 and gate.cap == 3
    snap = gate.snapshot()
    assert snap["provider"] == "gemini" and snap["limit"] == 3 and snap["live"] == 0 and snap["waiting"] == 0


def test_the_cap_follows_the_usable_keys(monkeypatch):
    m = JobManager(client=object())
    c = DeepSeekClient(api_keys=_keys(3))
    gate = m._gate_for("deepseek-flash", c)
    assert gate is not None and gate.cap == 3 * config.LIVE_PER_KEY and c.gate is gate
    c.pool.disable(c.pool.keys[0])
    assert m._gate_for("deepseek-flash", c).cap == 2 * config.LIVE_PER_KEY
    assert m._gate_for("deepseek-flash", object()) is None  # a fake client with no pool is never gated


# ---- the job: live concurrency is capped, and status reports the wait ------------------------------------


def test_a_job_on_one_leg_runs_no_more_live_tasks_than_its_gate_allows(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "LEG_RAMP_START", 3)
    c = DeepSeekClient(api_keys=_keys(2))
    live = {"now": 0, "max": 0}
    snapshots: list[dict] = []
    m = JobManager(client=c)
    monkeypatch.setattr(m, "route_plan", lambda model, backend="api": ["deepseek-flash"])

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        if warm is not None and is_pilot:
            warm.set()
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        await asyncio.sleep(0.02)
        snapshots.append(m.pool_report(job_ref["job"]))
        live["now"] -= 1
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="a"), []

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    job_ref: dict = {}

    async def go():
        job = m.submit([Task.from_dict({"prompt": f"p{i}", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, i) for i in range(12)])
        job_ref["job"] = job
        return await asyncio.wait_for(m.wait(job.id, None), 10)

    job = asyncio.run(go())
    assert all(r.status == "ok" for r in job.results.values())
    assert live["max"] == 3, live
    busy = [s for s in snapshots if s.get("queued_on_pool")]
    assert busy, snapshots[:2]
    pool = busy[0]["pools"]["deepseek"]
    assert pool["limit"] == 3 and pool["keys"] == 2 and pool["ready"] == 2


def test_status_names_a_pool_whose_every_key_is_resting(monkeypatch, tmp_path):
    c = DeepSeekClient(api_keys=_keys(2))
    for k in c.pool.keys:
        c.pool.rest(k, 60, status=429)
    m = JobManager(client=c)
    m._gate_for("deepseek-flash", c)
    job = type("J", (), {"id": "j1", "results": {"t1": Result(id="t1", status="running", model="deepseek-flash")}})()
    rep = m.pool_report(job)
    assert rep["pools"]["deepseek"]["ready"] == 0
    assert "rate-limited" in rep["waiting_on_rate_limited_pool"]["deepseek"]
