"""Nothing a task waits on outlasts its patience (2026-09-28, Connections burn-down job 20260928-072712-e599: 190
builders, 12 done in 35 minutes, 94 queued behind a Gemini gate halved to 2 live calls while 44 of its keys were
ready, and a later batch idle behind one pilot on a crawling NVIDIA model)."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from hswarm import agent, config, dispatch, selection
from hswarm.job import Job
from hswarm.leggate import GateQueued, LegGate, wait_for_pilot
from hswarm.spec import Result, Task


def test_a_full_gate_grows_back_while_calm_and_lets_a_task_leave_for_a_leg_with_room(monkeypatch):
    monkeypatch.setattr(config, "GATE_RECOVER_S", 0.05)
    monkeypatch.setattr(config, "GATE_PATIENCE_S", 0.05)
    gate = LegGate("gemini", cap=8, start=8)
    gate.saturated(), gate.saturated()  # 8 -> 4 -> 2
    assert gate.limit == 2

    async def go():
        gate.live = 2  # two long calls hold the halved gate
        await gate.acquire()  # no give_up: waits, and the calm gate doubles instead of starving it
        grew = gate.limit
        gate.live = gate.limit = 1
        gate._calm_since = float("inf")  # a gate still taking 429s does not grow
        try:
            await gate.acquire(give_up=lambda: True)
        except GateQueued as exc:
            return grew, str(exc)
        return grew, None

    grew, left = asyncio.run(go())
    assert grew == 4
    assert left and "gemini gate" in left


def test_the_batch_waits_for_a_slow_pilot_only_its_patience(monkeypatch):
    monkeypatch.setattr(config, "PILOT_PATIENCE_S", 0.05)

    async def go():
        warm = asyncio.Event()  # the pilot never replies
        await asyncio.wait_for(wait_for_pilot(warm), 1.0)

    asyncio.run(go())


def test_a_task_queued_past_its_patience_runs_on_the_next_leg(monkeypatch, tmp_path):
    monkeypatch.setattr(selection, "plan", lambda *a, **k: {"profile": "code", "candidates": [
        {"model": m, "reasoning_effort": "high", "thinking": True, "benchmark_slug": m}
        for m in ("rank:gemini-3-8-flash", "rank:qwen3-8-27b:cerebras")]})
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [])
    monkeypatch.setattr(dispatch, "_usable", lambda provider, wake=None: True)
    seen = []

    class Mgr:
        _gates = {}

        def client_for(self, leg):
            return SimpleNamespace(pool=None)

        async def _park_broke_keys(self, c):
            pass

        def _gate_for(self, leg, c):
            return LegGate("gemini", cap=2, start=2) if "gemini" in leg else None

        async def _gated(self, job, gate, run, give_up=None):
            if give_up is not None and give_up():  # only a leg with a later one gets give_up: the gemini leg here
                run.close()
                raise GateQueued("waited 45s at the full gemini gate (2 live of 2) while a later leg had room")
            return await run

    async def fake_run(client, task, **kw):
        seen.append(task.model)
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok", cost_usd=0.01, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    t = Task(id="t", prompt="do", cwd=str(tmp_path), tools="edit", model="rank:gemini-3-8-flash", max_turns=10, max_cost_usd=1.0)
    t.profile = "code"
    job = Job(id="j", tasks=[t])
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    res, _ = asyncio.run(dispatch.run_selected(Mgr(), job, t, None, True))
    assert res.status == "ok" and res.model == "rank:qwen3-8-27b:cerebras" and seen == ["rank:qwen3-8-27b:cerebras"]
    assert res.selection["attempts"][0]["error"].startswith("GateQueued:")
