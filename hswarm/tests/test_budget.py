"""Offline: the reserve-then-settle ceilings and the wrap-up checkpoint (hswarm/budget.py).

WHY these tests: before budget.py the worker cap and the job budget were checked AFTER the turn (or task) that
crossed them, so a worker overshot max_cost_usd by a turn and a job with N workers in flight overshot budget_usd
by up to N workers' spend. Each test below fails with the reservation (or the checkpoint) taken out."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, config  # noqa: E402
from hswarm.budget import top_rates  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402

OUT_RATE = top_rates("deepseek-flash")["out"]  # the highest output rate the leg can charge, per 1M


class _Spender:
    """Never answers: every turn reads a file and bills its whole output allowance, the worst case a turn can write."""

    def __init__(self):
        self.seen: list[list[dict]] = []

    async def chat(self, messages, max_tokens=None, **kw):
        self.seen.append([dict(m) for m in messages])
        await asyncio.sleep(0.001)
        # A new slice each turn: re-reading the same call with the same result is a no-progress loop (loopguard.py),
        # which would end the task before the cap this test is about.
        args = f'{{"path": "evidence.txt", "end_line": {len(self.seen) + 1}}}'
        call = {"id": f"c{len(self.seen)}", "type": "function", "function": {"name": "read_file", "arguments": args}}
        return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                          usage=Usage(), model="deepseek-flash", seconds=0.001, cost_usd=max_tokens * OUT_RATE / 1_000_000.0, peak=True)

    async def aclose(self):
        pass


def _task(tmp_path, **extra) -> Task:
    (tmp_path / "evidence.txt").write_text("the line that matters\n", encoding="utf-8")
    spec = {"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash", "route": False, **extra}
    return Task.from_dict(spec, {}, 0)


def test_worker_cap_is_never_crossed_and_the_worker_is_told_to_wrap_up_once(tmp_path):
    # Contract: a worker's spend stays at or under max_cost_usd, the turn that would cross it is not sent, and it
    # comes back with what it gathered. Regression: the after-the-fact check let a 16k-token turn land over the cap.
    client = _Spender()
    task = _task(tmp_path, max_cost_usd=0.25)
    res, _ = asyncio.run(agent.run_api_task(client, task))
    assert res.cost_usd <= task.max_cost_usd + 1e-9, res.cost_usd
    assert res.status == "error" and "max_cost_usd) reached" in (res.error or ""), res.error
    assert res.answer.startswith("PARTIAL") and "the line that matters" in res.answer
    last = client.seen[-1]
    notes = [m["content"] for m in last if m.get("role") == "user" and "<budget_status>" in str(m.get("content"))]
    assert notes and "turn 2 of 24" in notes[0]
    assert sum("Budget checkpoint" in n for n in notes) == 1  # given once, at checkpoint_at of the cap, never repeated


def test_job_budget_holds_across_workers_in_flight(tmp_path, monkeypatch):
    # Contract: with several workers in flight, the job's summed spend never passes budget_usd. Regression: the old
    # guard ran only when a task finished, so four concurrent workers each ran to their own $0.25 cap first.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")

    async def go():
        m = JobManager(client=_Spender())
        tasks = [_task(tmp_path, id=f"t{i}") for i in range(4)]
        return await asyncio.wait_for(m.run_batch(tasks, concurrency=4, budget_usd=0.06), 30)

    job = asyncio.run(go())
    assert job.cost() <= 0.06 + 1e-9, job.cost()
    assert any("job budget (budget_usd) reached" in (r.error or "") for r in job.results.values())


class _Answerer:
    """Answers at once and cheaply: a job whose real spend is far below its budget."""

    def __init__(self):
        self.max_tokens_sent: list[int] = []

    async def chat(self, messages, max_tokens=None, **kw):
        self.max_tokens_sent.append(max_tokens)
        await asyncio.sleep(0.01)
        return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop",
                          usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.00001, peak=True)

    async def aclose(self):
        pass


def test_sibling_holds_wait_instead_of_refusing_or_shrinking(tmp_path, monkeypatch):
    # Contract: a turn is refused or shrunk only against SETTLED spend; one that fits the money spent but not the
    # money siblings still hold waits for them to settle. Regression: with 8 workers released at once, holds worth
    # ~3 turns of budget refused most workers at turn 0 ('job budget reached' with ~$0 spent) and cut max_tokens.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    client = _Answerer()
    tasks = [_task(tmp_path, id=f"t{i}", tools="none") for i in range(8)]
    budget = 3 * tasks[0].max_tokens * OUT_RATE / 1_000_000.0  # room for ~2 worst-case holds at once, not 8

    async def go():
        m = JobManager(client=client)
        return await asyncio.wait_for(m.run_batch(tasks, concurrency=8, budget_usd=budget), 30)

    job = asyncio.run(go())
    assert all(r.status == "ok" for r in job.results.values()), {r.id: r.error for r in job.results.values()}
    assert job.cost() <= budget + 1e-9, job.cost()
    assert client.max_tokens_sent and set(client.max_tokens_sent) == {tasks[0].max_tokens}
