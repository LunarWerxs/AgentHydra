"""Offline: the limits a job runs under hold across its legs, its cancels and its neighbours (hswarm/jobs.py).

WHY these tests (discovery of 2026-10-02): each leg of a pinned route started on the task's whole timeout, turns and
cost cap again; a cancelled task's paid turns were journaled at $0 and a budget crossing killed api tasks whose turn
in flight was already reserved; and one job's `concurrency` became the shared server's limit for every later job.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, jobs  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402


def _task(tmp_path, tid: str, prompt: str = "x", **extra) -> Task:
    return Task.from_dict({"id": tid, "prompt": prompt, "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", **extra}, {}, 0)


def _reply(cost: float, tool_call: dict | None = None) -> ChatResult:
    message = {"role": "assistant", "content": "" if tool_call else "OK", **({"tool_calls": [tool_call]} if tool_call else {})}
    return ChatResult(message=message, finish_reason="tool_calls" if tool_call else "stop", usage=Usage(), model="deepseek-flash",
                      seconds=0.01, cost_usd=cost, peak=False)


def _said(messages) -> str:
    # Only the user turns: the worker's system prompt is long and not the test's.
    return " ".join(str(m.get("content")) for m in messages if m.get("role") == "user")


def _pinned_route(monkeypatch, first_leg: Result):
    """A JobManager whose route is two scripted legs: the first yields `first_leg`, the second answers. Returns it and
    the (model, max_cost_usd, timeout_s, max_turns) each leg was handed, in call order."""
    handed: list[tuple] = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        handed.append((task.model, task.max_cost_usd, task.timeout_s, task.max_turns))
        if warm is not None and is_pilot:
            warm.set()
        r = first_leg if len(handed) == 1 else Result(id="t", status="ok", answer="42", cost_usd=0.01, turns=1, seconds=1.0)
        out = Result(id=task.id, backend="api", model=task.model, status=r.status, error=r.error, answer=r.answer,
                     cost_usd=r.cost_usd, turns=r.turns, seconds=r.seconds)
        return out, [{"role": "user", "content": task.prompt}]

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash-or", "deepseek-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: object())

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    return m, handed


def _run_one_task(m, task) -> Result:
    async def go():
        job = m.submit([task])
        return await asyncio.wait_for(m.wait(job.id, None), 10)
    return asyncio.run(go()).results[task.id]


def test_a_pinned_routes_next_leg_runs_on_what_the_dead_leg_left(monkeypatch, tmp_path):
    # Contract: a task's timeout_s, max_turns and max_cost_usd are the TASK's, however many legs serve it.
    # Regression: _walk_route handed every leg the original task, so leg 2 of a $0.25 task got $0.25 again after leg 1
    # had spent $0.20 (968 pinned multi-leg tasks ran past their own timeout_s in 30 days).
    down = Result(id="t", status="error", error="deepseek API 503: service unavailable", cost_usd=0.20, turns=3, seconds=100.0)
    m, handed = _pinned_route(monkeypatch, down)
    r = _run_one_task(m, _task(tmp_path, "t", max_cost_usd=0.25, timeout_s=600, max_turns=24))
    (leg1, cost1, time1, turns1), (leg2, cost2, time2, turns2) = handed
    assert (leg1, leg2) == ("deepseek-flash-or", "deepseek-flash") and r.status == "ok"
    assert cost2 == pytest.approx(cost1 - 0.20) and time2 == pytest.approx(time1 - 100.0) and turns2 == turns1 - 3
    assert r.cost_usd == pytest.approx(0.21) and r.failover == ["deepseek-flash-or"]  # the dead leg's spend, counted once


def test_a_pinned_route_stops_when_a_dead_leg_spent_the_whole_cap(monkeypatch, tmp_path):
    # Contract: with nothing left to run on, no further leg is started and the dead leg's result is the task's,
    # its spend counted once. Regression: leg 2 ran on a fresh cap.
    down = Result(id="t", status="error", error="deepseek API 503: service unavailable", cost_usd=0.25, turns=3, seconds=100.0)
    m, handed = _pinned_route(monkeypatch, down)
    r = _run_one_task(m, _task(tmp_path, "t", max_cost_usd=0.25))
    assert [leg for leg, *_ in handed] == ["deepseek-flash-or"]
    assert r.status == "error" and "503" in r.error and r.cost_usd == pytest.approx(0.25) and r.failover == []


class _ThenHangs:
    """Turn 1 reads a file and costs $0.10; turn 2 never answers."""

    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        if self.calls > 1:
            await asyncio.Event().wait()
        return _reply(0.10, {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "evidence.txt"}'}})

    async def aclose(self):
        pass


def test_a_cancelled_task_is_journaled_with_the_turns_it_paid_for(tmp_path):
    # Contract: the ledger and the job's cost carry what a cancelled task spent. Regression: _record_cancel journaled
    # the job's placeholder row, so all 11,302 cancelled rows of one week went into the ledger at $0.
    (tmp_path / "evidence.txt").write_text("the line that matters\n", encoding="utf-8")
    client = _ThenHangs()

    async def go():
        m = JobManager(client=client)
        job = m.submit([_task(tmp_path, "t", tools="read")])
        for _ in range(2000):
            if client.calls > 1:  # turn 1 is paid for and turn 2 is in flight
                break
            await asyncio.sleep(0.005)
        m.cancel(job.id, reason="stopped by the caller")
        return await asyncio.wait_for(m.wait(job.id, None), 10)

    job = asyncio.run(go())
    r = job.results["t"]
    assert r.status == "cancelled" and r.error == "stopped by the caller"
    assert r.cost_usd == pytest.approx(0.10) and r.turns == 1 and job.cost() == pytest.approx(0.10)
    ledger = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()]
    assert [row["cost_usd"] for row in ledger if row["task"] == "t"] == [pytest.approx(0.10)]


class _BudgetCrossing:
    """The pilot costs $0.21 and every other reply $0.10. The task marked SLOW stays in flight until its job has been
    cancelled, which is where the budget guard finds it."""

    job = None

    async def chat(self, messages, **kw):
        said = _said(messages)
        if "MARK-SLOW" in said:
            while self.job.state == "running":
                await asyncio.sleep(0.005)
        return _reply(0.21 if "MARK-PILOT" in said else 0.10)

    async def aclose(self):
        pass


def test_a_budget_crossing_cancels_what_is_pending_and_lets_a_running_api_task_finish(tmp_path):
    # Contract: crossing budget_usd stops the tasks that have not started; an api task already running keeps the turn
    # it reserved and its spend is recorded. Regression: cancel() killed running tasks too and journaled them at $0
    # (job 20260930-193509-b585: the budget had settled $59.79, the results recorded $52.01, 4 running tasks killed).
    client = _BudgetCrossing()

    async def go():
        m = JobManager(client=client)
        tasks = [_task(tmp_path, tid, prompt) for tid, prompt in
                 (("pilot", "MARK-PILOT"), ("slow", "MARK-SLOW"), ("fast", "x"), ("queued", "x"))]
        client.job = m.submit(tasks, concurrency=2, budget_usd=0.30)
        return await asyncio.wait_for(m.wait(client.job.id, None), 30)

    job = asyncio.run(go())
    r = job.results
    assert job.state == "cancelled" and "job budget exceeded" in (r["queued"].error or "")
    assert [r[t].status for t in ("pilot", "slow", "fast", "queued")] == ["ok", "ok", "ok", "cancelled"]
    assert r["slow"].cost_usd == pytest.approx(0.10) and job.cost() == pytest.approx(0.41)


def test_a_budget_crossing_stops_a_task_resting_between_dead_reruns(monkeypatch, tmp_path):
    # Contract: the budget guard spares only a turn in flight; a started task with none out is stopped with the rest.
    # Regression: every "running" api row was spared, so a task asleep in the dead-rerun rest (150 s a rest, 3 h of
    # patience) had no turn for the budget to refuse and held a cancelled job open. Faked at _run_legs: the rest
    # loop, the cancel and the job's end are the real ones.
    monkeypatch.setattr(config, "DEAD_RERUN_PATIENCE_S", 3 * 3600.0)
    monkeypatch.setattr(config, "DEAD_RERUN_REST_S", 150.0)
    m = JobManager(client=object())
    box: dict = {}

    async def fake_legs(job, task, warm, is_pilot):
        if task.id == "down":
            return Result(id=task.id, backend="api", model=task.model, status="error", error="NoUsableKey: no key with credit left"), None
        while not box["job"].results["down"].next_action:  # until `down` is asleep in its rest
            await asyncio.sleep(0.005)
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="42", cost_usd=0.40, turns=1), None

    monkeypatch.setattr(m, "_run_legs", fake_legs)

    async def go():
        box["job"] = m.submit([_task(tmp_path, "down"), _task(tmp_path, "spend")], budget_usd=0.30)
        return await m.wait(box["job"].id, 5)

    job = asyncio.run(go())
    assert job.finished, "the job waited out the resting task"
    assert [job.results[t].status for t in ("down", "spend")] == ["cancelled", "ok"]
    assert "job budget exceeded" in (job.results["down"].error or "")


class _SparedThenHangs:
    """The pilot is free; the task marked HANG never answers; the one marked SPEND answers at $1.50 once HANG's turn
    is in flight, which crosses the job's budget."""

    hung = False

    async def chat(self, messages, **kw):
        said = _said(messages)
        if "MARK-HANG" in said:
            self.hung = True
            await asyncio.Event().wait()
        if "MARK-SPEND" in said:
            while not self.hung:
                await asyncio.sleep(0.005)
            return _reply(1.50)
        return _reply(0.0)

    async def aclose(self):
        pass


def test_a_task_the_budget_cancel_spared_is_still_stopped_from_another_process(monkeypatch, tmp_path):
    # Contract: `hswarm cancel` from another process stops a job's running work, also after its budget cancelled it.
    # Regression: the owner polled for the request only while the job read "running", and cancel_on_disk wrote a
    # "cancelled" record off as finished, so a spared task ran on with nothing able to stop it.
    monkeypatch.setattr(config, "CHECKPOINT_S", 0.05)
    client = _SparedThenHangs()

    async def go():
        m = JobManager(client=client)
        job = m.submit([_task(tmp_path, tid, prompt) for tid, prompt in (("pilot", "x"), ("hang", "MARK-HANG"), ("spend", "MARK-SPEND"))],
                       budget_usd=1.00)
        for _ in range(2000):
            if job.state == "cancelled":  # the budget guard has cancelled it and spared `hang`
                break
            await asyncio.sleep(0.005)
        asked = await asyncio.to_thread(JobManager.cancel_on_disk, job.id, "stopped from another process")
        return await m.wait(job.id, 5), asked

    job, asked = asyncio.run(go())
    assert "asked the process running it" in asked.get("cancel", ""), asked
    assert job.finished, "nothing stopped the spared task"
    r = job.results["hang"]
    assert r.status == "cancelled" and r.error == "stopped from another process"


class _Counting:
    """Answers after a moment, counting how many calls are in flight at once."""

    def __init__(self):
        self.live = self.peak = 0

    async def chat(self, messages, **kw):
        self.live += 1
        self.peak = max(self.peak, self.live)
        await asyncio.sleep(0.05)
        self.live -= 1
        return _reply(0.0)

    async def aclose(self):
        pass


def test_one_jobs_concurrency_does_not_limit_the_next_job(tmp_path):
    # Contract: `concurrency` caps the job that named it; a job that names none runs at the default width.
    # Regression: the manager kept one semaphore per backend and a job's size replaced it for good, so on the shared
    # server 23 of 90 jobs that named none inherited an api limit of 1-14 from an earlier caller.
    client = _Counting()

    async def go():
        m = JobManager(client=client)
        await asyncio.wait_for(m.run_batch([_task(tmp_path, f"a{i}") for i in range(3)], concurrency=1), 30)
        narrow, client.peak = client.peak, 0
        await asyncio.wait_for(m.run_batch([_task(tmp_path, f"b{i}") for i in range(4)]), 30)
        return narrow, client.peak

    narrow, wide = asyncio.run(go())
    assert narrow == 1 and wide > 1, (narrow, wide)
