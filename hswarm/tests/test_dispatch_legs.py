"""How an evaluated task moves between its legs (hswarm/dispatch.py), measured over the 7 days to 2026-10-02:

- 410 tasks ended at their cost cap after a SlowLeg handoff re-sent a free leg's whole transcript to a priced leg ($199.04);
- 307 tasks were refused on their first turn with $0 spent and cheaper candidates behind never tried;
- 622 ok tasks were served below their floor after nothing but a queue at a full gate that was still serving;
- an ask's 5 s try of a leg already marked crawling renewed the mark for another 10 minutes, for every process;
- a file inlined into the prompt was not counted when AUTO sized the context a route must have.

Each test fails on the code before the fix. The legs are real registry models, so the prices are the shipped ones."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from hswarm import agent, config, dispatch, selection
from hswarm.client import ChatResult, Usage
from hswarm.job import Job
from hswarm.leggate import GateQueued, LegGate
from hswarm.spec import Result, Task

FREE = "rank:kimi-k3:nvidia"  # price 0: the leg that crawls
PRICED = "rank:claude-opus-5-5:direct"  # $4 in, $5 cache write, $20 out per 1M
CHEAP = "deepseek-flash"  # $0.30 in, $1.20 out per 1M at peak


def _plan(models):
    return {"profile": "code", "candidates": [{"model": m, "benchmark_slug": m} for m in models]}


class _Client:
    """Answers "done" on its first call and keeps what it was sent."""
    pool = None

    def __init__(self):
        self.seen: list[list[dict]] = []

    async def chat(self, messages, max_tokens=None, **kw):
        self.seen.append([dict(m) for m in messages])
        return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(),
                          model="m", seconds=0.01, cost_usd=0.001, peak=False)


class _Mgr:
    _gates: dict = {}

    def __init__(self):
        self.clients: dict[str, _Client] = {}

    def client_for(self, leg):
        return self.clients.setdefault(leg, _Client())

    async def _park_broke_keys(self, c):
        pass

    def _gate_for(self, leg, c):
        return None

    async def _gated(self, job, gate, run, give_up=None):
        return await run


def _task(monkeypatch, tmp_path, models, **kw):
    monkeypatch.setattr(selection, "plan", lambda *a, **k: _plan(models))
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [])
    monkeypatch.setattr(config, "SPILL_DIR", tmp_path / "spill")
    t = Task(**{"id": "t", "prompt": "do", "cwd": str(tmp_path), "tools": "read", "model": models[0], "max_turns": 10, **kw})
    t.profile = "code"
    job = Job(id="j", tasks=[t])
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    return t, job


def _history(n_results: int, size: int) -> list[dict]:
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
    for i in range(n_results):
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * size})
    return msgs


def _slow_free_leg(monkeypatch, history):
    """The FREE leg crawls for 3 turns and hands on `history`; every other leg runs the real worker loop."""
    real_run = agent.run_api_task

    async def run(client, task, **kw):
        if task.model != FREE:
            return await real_run(client, task, **kw)
        slow = Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.0, turns=3, seconds=120.0, api_seconds=120.0,
                      error=f"SlowLeg: {FREE} averaged 40s a turn over 3 turns (budget 30s) - failing over while the task still has time")
        return slow, history

    monkeypatch.setattr(agent, "run_api_task", run)


def test_a_priced_leg_taking_over_a_slow_free_leg_gets_a_compacted_transcript_it_can_afford(monkeypatch, tmp_path):
    # Contract: after a handoff the priced leg's first request costs at most a third of what is left of the cap.
    # Regression: the 30k-token transcript (under the 60k context trigger) went out whole, $0.20 of input against a
    # $0.25 cap on Opus, so the second turn was refused and neither leg finished.
    t, job = _task(monkeypatch, tmp_path, [FREE, PRICED], max_cost_usd=0.25)
    _slow_free_leg(monkeypatch, _history(10, 12_000))
    mgr = _Mgr()
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    assert res.status == "ok" and res.model == PRICED and res.failover == [FREE], res.error
    [first] = mgr.clients[PRICED].seen
    results = [m["content"] for m in first if m.get("role") == "tool"]
    assert len(results) == 10, "every completed call is still answered, so the new leg repeats none of them"
    assert results[0].startswith("[stale read_file output cleared") and results[-1].startswith("result 9 x")
    assert sum(len(r) for r in results) < 50_000, "the 120k characters of tool output did not go out whole"


def test_a_priced_leg_whose_compacted_first_turn_is_still_too_dear_is_never_started(monkeypatch, tmp_path):
    # Contract: a priced leg is not started on a transcript whose first request costs over a third of what is left.
    # Regression: the editor keeps the last 3 results whole, so three 30k-character results went to Opus as $0.15 of
    # a $0.25 cap; that fits the cap, so it was sent, and the next turn was refused with the money sunk.
    t, job = _task(monkeypatch, tmp_path, [FREE, PRICED, CHEAP], max_cost_usd=0.25)
    _slow_free_leg(monkeypatch, _history(3, 30_000))
    mgr = _Mgr()
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    assert res.status == "ok" and res.model == CHEAP and res.answer == "done", res.error
    assert PRICED not in mgr.clients, "nothing was sent to the leg that could not afford the transcript"
    assert [a["model"] for a in res.selection["attempts"]] == [FREE, PRICED, CHEAP]


def test_a_first_turn_that_does_not_fit_the_cap_moves_the_task_to_the_next_leg(monkeypatch, tmp_path):
    # Contract: a leg whose first turn is refused unsent (nothing spent) is that leg's price, not the task's failure.
    # Regression: the refusal is not an "unavailable" error, so the walk stopped with one attempt and the cheaper
    # candidate behind was never tried.
    t, job = _task(monkeypatch, tmp_path, [PRICED, CHEAP], prompt="word " * 8000, tools="none", max_cost_usd=0.05)
    mgr = _Mgr()
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    assert res.status == "ok" and res.model == CHEAP and res.answer == "done", res.error
    assert mgr.clients[PRICED].seen == [], "the refused turn was never sent"
    assert [a["model"] for a in res.selection["attempts"]] == [PRICED, CHEAP] and res.failover == [PRICED]


class _QueueMgr(_Mgr):
    """The first leg's gate is full; `replies` is how many answers other tasks got from it while this one queued."""

    def __init__(self, replies):
        super().__init__()
        self.gate, self.replies = LegGate("gemini", cap=2, start=2), replies

    def _gate_for(self, leg, c):
        return self.gate if "gemini" in leg else None

    async def _gated(self, job, gate, run, give_up=None):
        if give_up is not None:
            await asyncio.sleep(config.GATE_PATIENCE_S * 2)  # the gate asks only once the patience has passed
            for _ in range(self.replies):
                gate.ok()
            # ...and then on every wake (leggate.acquire), so the second ask comes with no reply since the first.
            if give_up() or give_up():
                run.close()
                raise GateQueued("waited 45s at the full gemini gate (2 live of 2) while a later leg had room")
        return await run


@pytest.mark.parametrize("replies, served_by", [(1, "rank:gemini-3-8-flash"), (0, "rank:qwen3-8-27b:cerebras")])
def test_a_queue_at_a_serving_gate_does_not_send_a_task_below_its_floor(monkeypatch, tmp_path, replies, served_by):
    # Contract: a rescue leg (below the task's floors) is for own routes that crawl or fail. A full gate that is
    # serving is neither, so the task waits its turn; one that answered nothing for the whole patience has failed,
    # and then the rescue leg is the way out (the bound config.GATE_PATIENCE_S exists for).
    # Regression: any later leg with room was an escape, so a code task left a serving gate for a general model; and
    # "served since last asked" let it go on the wake right after the reply, when nothing new had been answered yet.
    own, rescue = "rank:gemini-3-8-flash", "rank:qwen3-8-27b:cerebras"
    monkeypatch.setattr(config, "GATE_PATIENCE_S", 0.05)
    t, job = _task(monkeypatch, tmp_path, [own], max_cost_usd=1.0)
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [{"model": rescue, "benchmark_slug": rescue, "rescue": "general"}])
    monkeypatch.setattr(dispatch, "_usable", lambda provider, wake=None: True)
    seen = []

    async def fake_run(client, task, **kw):
        seen.append(task.model)
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok", cost_usd=0.01, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    res, _ = asyncio.run(dispatch.run_selected(_QueueMgr(replies), job, t, None, True))
    assert res.status == "ok" and seen == [served_by]
    assert res.selection.get("below_floor") == (None if served_by == own else "general")


def test_an_asks_short_try_of_a_crawling_leg_does_not_renew_its_mark(monkeypatch):
    # Contract: a crawl mark lasts config.SLOW_MARK_S from the reading that set it. Regression: every ask cut the
    # marked leg after CRAWLING_LEG_TRY_S (5 s, far under the 30 s crawl bar) and stamped that as a new crawl, so a
    # model that answers in 6 s stayed marked for as long as asks kept arriving.
    plan = _plan(["crawls", "answers", "backup"])
    monkeypatch.setattr(dispatch, "_plan", lambda *a, **k: plan)
    monkeypatch.setattr(config, "CRAWLING_LEG_TRY_S", 0.05)
    marked_at = time.time() - 60
    # Every leg is marked: a marked leg runs after the healthy ones (free or not), so only with none healthy does the
    # first one keep its place and get its short try.
    for model in ("crawls", "answers", "backup"):
        selection.note_crawl(model, now=marked_at)

    async def fake_ask(client, prompt, model=None, **kw):
        await asyncio.sleep(10 if model == "crawls" else 0)
        return Result(id="ask", backend="api", model=model, status="ok", answer=model, cost_usd=0.0)

    monkeypatch.setattr(agent, "ask", fake_ask)
    res = asyncio.run(dispatch.ask_selected(SimpleNamespace(client_for=lambda leg: SimpleNamespace(pool=None)), "q", timeout_s=2.0))
    assert res.status == "ok" and res.answer == "answers" and res.failover == ["crawls"]
    assert selection.crawling("crawls", now=marked_at + config.SLOW_MARK_S - 1), "the mark it had still stands"
    assert not selection.crawling("crawls", now=marked_at + config.SLOW_MARK_S + 1), "and ages out when it was due"


def test_inlined_files_count_toward_the_context_a_route_must_have(monkeypatch, tmp_path):
    # Contract: AUTO only plans routes whose context holds the prompt as it will be SENT, files included.
    # Regression: min_context counted the prompt and system text alone, so a one-character prompt carrying a 600 KB
    # file was planned as 16,000 tokens.
    (tmp_path / "big.txt").write_text("x" * 600_000, encoding="utf-8")
    asked = []

    def fake_plan(profile, **kw):
        asked.append(kw["min_context"])
        return _plan(["rank:gemini-3-8-flash"])

    monkeypatch.setattr(selection, "plan", fake_plan)
    t = Task(id="t", prompt="x", cwd=str(tmp_path), tools="none", model="deepseek-flash", files=["big.txt"])
    t.profile = "general"
    dispatch.plan_for(t)
    assert asked and asked[0] > 200_000
