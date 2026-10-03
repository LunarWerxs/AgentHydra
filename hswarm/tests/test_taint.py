"""Offline: sticky taint letters on worker results (spec.TAINTS).

An orchestrator reads results as data and could not tell a clean answer from one that survived a failover, a
truncated reply or a rejected submit_result. The taint string says so, is never cleared (not by a later clean
turn, not by the next leg answering), and hswarm_results filters on it. Pinned here because losing a letter
fails silently: the result just reads as clean.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, config, dispatch, jobs, selection  # noqa: E402
from hswarm.job import Job  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.results import _split, taint_matches  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402

SCHEMA = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}


def test_a_taint_is_sticky_ordered_and_named():
    r = Result(id="t")
    r.add_taint("T")
    r.add_taint("F", "T")
    r.add_taint("")
    assert r.taint == "FT", "letters print in TAINTS order and never repeat"
    with pytest.raises(ValueError, match="unknown taint"):
        r.add_taint("Z")
    assert r.taint == "FT", "a refused letter leaves the taint as it was"


class Scripted:
    """A client that answers each turn from a list of (tool-call arguments, finish_reason)."""

    def __init__(self, turns):
        self.turns = list(turns)

    async def chat(self, messages, **kw):
        args, finish = self.turns.pop(0)
        call = {"id": "c", "type": "function", "function": {"name": "submit_result", "arguments": json.dumps(args)}}
        return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason=finish,
                          usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)


def _task(tmp_path) -> Task:
    return Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", "schema": SCHEMA})


def test_a_clean_run_has_no_taint(tmp_path):
    res, _ = asyncio.run(agent.run_api_task(Scripted([({"a": "ok"}, "tool_calls")]), _task(tmp_path)))
    assert res.status == "ok" and res.taint == ""


def test_a_truncated_turn_and_a_rejected_submit_stay_on_the_result_that_recovered(tmp_path):
    client = Scripted([({}, "length"), ({"a": "ok"}, "tool_calls")])
    res, _ = asyncio.run(agent.run_api_task(client, _task(tmp_path)))
    assert res.status == "ok" and res.data == {"a": "ok"}
    assert res.taint == "ST", "the clean second turn must not clear what the first one did"


def test_a_failed_over_task_carries_F_and_the_dead_legs_own_letters(monkeypatch, tmp_path):
    dead = Result(id="t", status="error", error="deepseek API 503: service unavailable", taint="T")
    good = Result(id="t", status="ok", answer="42")

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        r = {"deepseek-flash-or": dead, "deepseek-flash": good}[task.model]
        if warm is not None and is_pilot:
            warm.set()
        return Result(id=task.id, backend="api", model=task.model, status=r.status, error=r.error, answer=r.answer, taint=r.taint), []

    async def no_probe(client):
        return None

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash-or", "deepseek-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: object())
    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})])
        return await asyncio.wait_for(m.wait(job.id, None), 10)

    job = asyncio.run(go())
    assert job.results["t1"].status == "ok" and job.results["t1"].taint == "FT"
    assert job.summary()["taints"] == {"F": 1, "T": 1}
    row = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()][-1]
    assert row["taint"] == "FT"


def test_results_filter_on_any_letter_or_clean():
    by_id = {"a": Result(id="a", status="ok", taint="F"), "b": Result(id="b", status="ok", taint="ST"), "c": Result(id="c", status="ok")}
    tasks = [SimpleNamespace(id=k) for k in by_id]

    def ids(taint):
        return [r["id"] for r in _split(tasks, by_id, None, None, {}, 1000, taint)[0]]

    assert ids(None) == ["a", "b", "c"]
    assert ids("ft") == ["a", "b"]
    assert ids("clean") == ["c"]
    assert not taint_matches("", "F") and taint_matches(None, None)
    assert ids("F,T") == ["a", "b"], "separators a caller types are ignored"
    with pytest.raises(ValueError, match="unknown taint"):
        taint_matches("F", "X")


def test_an_auto_task_that_failed_over_through_run_selected_is_tainted_F(monkeypatch, tmp_path):
    """The default route (model AUTO) folds its legs in dispatch._fold, not jobs._run_legs: F must be set there too."""
    monkeypatch.setattr(selection, "plan", lambda *a, **k: {"profile": "code", "candidates": [
        {"model": m, "reasoning_effort": "high", "thinking": True, "benchmark_slug": m} for m in ("rank:a", "rank:b")]})

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        if task.model == "rank:a":
            return Result(id=task.id, backend="api", model=task.model, status="error", error="API Error: 503 no endpoints", taint="T"), []
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok"), []

    class Mgr:
        def client_for(self, leg):
            return SimpleNamespace(pool=None)

        async def _park_broke_keys(self, c):
            pass

        def _gate_for(self, leg, c):
            return None

        async def _gated(self, job, gate, run):
            return await run

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    t = Task(id="t", prompt="do", cwd=str(tmp_path), tools="all", model="rank:a", max_turns=10, max_cost_usd=1.0)
    t.profile = "code"
    job = Job(id="j", tasks=[t])
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    res, _ = asyncio.run(dispatch.run_selected(Mgr(), job, t, None, True))
    assert res.status == "ok" and res.failover == ["rank:a"]
    assert res.taint == "FT", "a failed-over AUTO answer must not read as clean, and the dead leg's T carries over"


def test_a_resumed_job_keeps_the_cached_results_taint(tmp_path):
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    row = {"status": "ok", "key": "k", "answer": "42", "taint": "FS"}
    assert jobs._cached_result(task, row, "j0").taint == "FS", "a resume never clears a taint"
    assert jobs._cached_result(task, {"status": "ok", "key": "k"}, "j0").taint == "", "a row from before taints reads clean"
