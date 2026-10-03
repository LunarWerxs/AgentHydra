"""Offline: a task's `verify` - the check after the worker, the capped retry with the failure handed back, and the
escalation record. Fake attempts, checks and judges only: no shell, no provider."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, verify  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402


def _task(tmp_path, v, **kw) -> Task:
    return Task.from_dict({"id": "t1", "prompt": "fix it", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", "verify": v, **kw}, {}, 0)


def _worker(cost: float = 0.01, prompts: list | None = None):
    async def attempt(t: Task, first: bool):
        if prompts is not None:
            prompts.append(t.prompt)
        return Result(id=t.id, status="ok", answer=f"done {len(prompts or [])}", cost_usd=cost, turns=1), [{"role": "user", "content": t.prompt}]
    return attempt


def _checks(*exits: int):
    it = iter(exits)

    async def check(command, cwd, timeout_s):
        code = next(it)
        return {"exit": code, "output_tail": "" if code == 0 else f"AssertionError: expected 3 got {code}"}
    return check


def test_a_failed_check_reruns_the_task_with_its_output_and_passes(tmp_path):
    # Contract: a non-zero check sends the task back with the output tail in the prompt; a later pass is ok, and every
    # attempt's spend is on the result. Regression: without the loop the first claim comes back unchecked.
    prompts: list[str] = []
    t = _task(tmp_path, "pytest -q")
    res, _ = asyncio.run(verify.run_verified(t, _worker(prompts=prompts), check=_checks(1, 0)))
    assert res.status == "ok" and res.verify["passed"] and res.verify["attempts"] == 2 and res.verify["exit"] == 0, res.verify
    assert "AssertionError: expected 3 got 1" in prompts[1] and "AssertionError" not in prompts[0]
    assert abs(res.cost_usd - 0.02) < 1e-9 and res.turns == 2
    assert t.prompt == "fix it"  # the caller's task (and job.json) keeps the prompt it was given


def test_a_check_that_never_passes_escalates_with_every_attempt(tmp_path):
    t = _task(tmp_path, {"command": "pytest -q", "retries": 2})
    res, _ = asyncio.run(verify.run_verified(t, _worker(), check=_checks(1, 1, 1)))
    assert res.status == "error" and res.error.startswith("VerifyFailed:"), res.error
    assert res.verify["escalation"]["blocked"] and [h["attempt"] for h in res.verify["history"]] == [1, 2, 3]
    assert all(h["exit"] == 1 for h in res.verify["history"])


def test_the_judge_issues_go_back_to_the_worker_and_a_pass_ends_it(tmp_path):
    prompts: list[str] = []
    verdicts = iter([
        {"verdict": "FAIL", "issues": [{"category": "completeness", "severity": "major", "detail": "edge case n=0 missing"}],
         "criteria": [{"criterion": "handles n=0", "met": False}]},
        {"verdict": "PASS", "issues": [], "criteria": [{"criterion": "handles n=0", "met": True}]},
    ])

    async def judge(prompt, system):
        assert "handles n=0" in prompt and "Start from FAIL" in system
        return Result(id="ask", status="ok", data=next(verdicts), cost_usd=0.001, turns=1)

    t = _task(tmp_path, {"judge": "handles n=0"})
    res, _ = asyncio.run(verify.run_verified(t, _worker(prompts=prompts), judge=judge))
    assert res.status == "ok" and res.verify["passed"] and res.verify["verdict"]["verdict"] == "PASS"
    assert "edge case n=0 missing" in prompts[1] and "criterion not met: handles n=0" in prompts[1]
    assert abs(res.cost_usd - 0.022) < 1e-9  # two workers and two judge calls


def test_a_pass_over_an_unmet_criterion_is_not_a_pass():
    assert not verify.verdict_passed({"verdict": "PASS", "issues": [], "criteria": [{"criterion": "x", "met": False}]})
    assert verify.verdict_passed({"verdict": "PASS", "issues": [], "criteria": [{"criterion": "x", "met": True}]})


def test_retries_stop_at_max_cost_usd(tmp_path):
    # Contract: the whole loop stays inside the task's max_cost_usd; the retry cap alone would have run three.
    prompts: list[str] = []
    t = _task(tmp_path, {"command": "pytest -q", "retries": 2}, max_cost_usd=0.015)
    res, _ = asyncio.run(verify.run_verified(t, _worker(cost=0.01, prompts=prompts), check=_checks(1, 1, 1)))
    assert len(prompts) == 2 and res.status == "error" and "max_cost_usd" in res.verify["escalation"]["reason"]


def test_a_worker_that_fails_itself_is_not_retried(tmp_path):
    calls = []

    async def attempt(t, first):
        calls.append(t)
        return Result(id=t.id, status="timeout", error="task exceeded 600s"), None

    res, _ = asyncio.run(verify.run_verified(_task(tmp_path, "pytest -q"), attempt, check=_checks()))
    assert len(calls) == 1 and res.status == "timeout" and res.verify["escalation"]["attempts"] == 1


def test_a_bad_verify_spec_is_refused_by_name(tmp_path):
    with pytest.raises(ValueError, match="verify has unknown fields"):
        _task(tmp_path, {"cmd": "pytest"})
    with pytest.raises(ValueError, match="verify needs a command"):
        _task(tmp_path, {"retries": 1})
    assert _task(tmp_path, "pytest -q").verify == {"command": "pytest -q", "judge": None, "retries": 2, "timeout_s": 300}


def test_a_job_task_with_verify_runs_the_check(tmp_path, monkeypatch):
    # Seam: JobManager._run_one reaches verify.run_verified, so hswarm_run's `verify` is live, not decoration.
    from hswarm.client import ChatResult, Usage

    class FakeClient:
        async def chat(self, messages, **kw):
            return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(), model="deepseek-flash",
                              seconds=0.01, cost_usd=0.01, peak=False)

        async def aclose(self):
            pass

    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")  # never write a test job into the real ledger
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(verify, "run_command", _checks(1, 0))

    async def go():
        m = JobManager(client=FakeClient())
        return await m.run_batch([_task(tmp_path, "pytest -q")], concurrency=1)

    r = asyncio.run(go()).results["t1"]
    assert r.status == "ok" and r.verify["attempts"] == 2 and r.verify["passed"], r.verify
    assert config.LEDGER.read_text(encoding="utf-8").count('"task": "t1"') == 1  # one ledger line, all attempts in it
