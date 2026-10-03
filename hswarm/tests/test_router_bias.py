"""AUTO's filter reasons and load bias: selection.plan names why each route was skipped, and a live load bias
re-orders near-equal candidates without touching the evidence they are judged on. Offline, fake legs, no keys."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from hswarm import agent, config, dispatch, selection
from hswarm.job import Job
from hswarm.spec import Result, Task


@pytest.fixture(autouse=True)
def _clean_load(monkeypatch):
    selection.reset_load()
    monkeypatch.setattr(config, "LOAD_BIAS", 0.5)
    yield
    selection.reset_load()


# Contract: every evaluated route is either a candidate or named in `rejected` with the first filter it failed.
# Regression: a model silently dropped by a bare `continue`, so "why not X" needed a re-run to answer.
def test_every_route_is_a_candidate_or_a_named_rejection():
    routes = [name for name, _ in selection.auto_models()]
    out = selection.plan("general")
    # An evaluated model's same-provider siblings ride after every evidenced leg (its `siblings`), marked unevidenced.
    evidenced = [c for c in out["candidates"] if not c.get("unevidenced")]
    named = [c["model"] for c in evidenced] + [r["model"] for r in out["rejected"]]
    assert sorted(named) == sorted(routes)
    assert all(r["filter"] and r["reason"] for r in out["rejected"])
    assert all("unevidenced sibling of" in c["configuration"] for c in out["candidates"] if c.get("unevidenced"))


def test_rejection_names_the_filter_that_failed():
    none_usable = selection.plan("general", usable=lambda p: False)
    assert none_usable["candidates"] == []
    assert "usable" in {r["filter"] for r in none_usable["rejected"]}
    floors = [r for r in selection.plan("critical")["rejected"] if r["filter"] == "floor"]
    assert floors and all(any(k in r["reason"] for k in selection.PROFILES["critical"]) for r in floors)
    first = selection.plan("general")["candidates"][0]["model"]
    ex = selection.plan("general", exclude_models=[first])["rejected"]
    assert {"model": first, "filter": "excluded", "reason": "named in exclude_models"} in ex


def _cands():
    return [{"model": "a", "provider": "p1", "benchmark_cost_usd": 1.0, "score": 50},
            {"model": "b", "provider": "p2", "benchmark_cost_usd": 1.2, "score": 50},
            {"model": "c", "provider": "p3", "benchmark_cost_usd": 5.0, "score": 90}]


# Contract: bias moves order only among near-equal legs and never rewrites the unbiased cost.
def test_rebias_spreads_near_equal_legs_and_keeps_unbiased_cost():
    assert [c["model"] for c in selection.rebias(_cands(), lambda p: 0.0)] == ["a", "b", "c"]
    ranked = selection.rebias(_cands(), lambda p: 1.0 if p == "p1" else 0.0)
    assert [c["model"] for c in ranked] == ["b", "a", "c"], "a loaded cheap leg yields to a near-equal one, not a 5x one"
    assert ranked[1]["benchmark_cost_usd"] == 1.0 and ranked[1]["load_bias"] == 0.5


def test_pressure_counts_claims_and_recent_slow_marks():
    selection.claim("p1"), selection.claim("p1")
    assert selection.pressure("p1", 4) == 0.5
    selection.release("p1")
    selection.note_result("p1", "SlowLeg: p1 averaged 55s a turn", now=100.0)
    assert selection.pressure("p1", 4, now=101.0) == 0.5
    assert selection.pressure("p1", 4, now=100.0 + config.SLOW_MARK_S + 1) == 0.25, "a slow mark expires"
    selection.release("p1")
    later = 100.0 + config.SLOW_MARK_S + 1
    selection.note_result("p1", "tests failed: 2 assertions", now=later)
    assert selection.pressure("p1", 4, now=later) == 0.0, "a task failure is no mark"
    for _ in range(5):
        selection.claim("p1")
    assert selection.pressure("p1", 4, now=later) == 1.0, "capped at 1"


class _Mgr:
    def client_for(self, leg):
        return SimpleNamespace(pool=None)

    async def _park_broke_keys(self, c):
        pass

    def _gate_for(self, leg, c):
        return None

    async def _gated(self, job, gate, run):
        return await run


# Seam: run_selected claims a leg before its first await, so a concurrent batch sees the tasks ahead of it.
# Regression: the 2026-09-22 batch where every task of a kind piled onto one leg.
def test_concurrent_tasks_spread_over_near_equal_legs(monkeypatch, tmp_path):
    monkeypatch.setattr(selection, "plan", lambda *a, **k: {"profile": "code", "candidates": _cands()})
    monkeypatch.setattr(dispatch, "_capacity", lambda p, gates=None: 1)
    seen = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        seen.append(task.model)
        await asyncio.sleep(0.05)
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok", cost_usd=0.1, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    tasks = [Task(id=f"t{i}", prompt="do", cwd=str(tmp_path), tools="all", model="a", max_turns=10, max_cost_usd=1.0)
             for i in (1, 2)]
    job = Job(id="j", tasks=tasks)
    for t in tasks:
        t.profile = "code"
        job.results[t.id] = Result(id=t.id, backend="api", model=t.model)

    async def both():
        return await asyncio.gather(*(dispatch.run_selected(_Mgr(), job, t, None, False) for t in tasks))

    (r1, _), (r2, _) = asyncio.run(both())
    assert sorted(seen) == ["a", "b"] and (r1.model, r2.model) == ("a", "b")
    assert r2.selection["selected"]["benchmark_cost_usd"] == 1.2 and r2.selection["selected"]["load_bias"] == 0.0
    assert selection.pressure("p1", 1) == 0.0, "every claim is released when its leg ends"
