"""Offline: a task's `done_when` is checked by a separate tool-free call where the worker stops.

Contract: an answer the evaluator blocks is not the result - its reason goes back to the worker as a user turn
and the loop continues, up to done_when_max_blocks; impossible and a block past the cap end the task as an
error with the answer kept; an evaluator that fails leaves the answer as it was. Regression: without the gate
the worker's first "tests pass" claim is accepted with no proof behind it. Seam: agent.run_api_task, with a
fake client standing in for the provider (evaluator calls are the ones forcing tool_choice=required).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402


def _reply(content: str = "", tool_calls: list | None = None) -> ChatResult:
    msg = {"role": "assistant", "content": content, **({"tool_calls": tool_calls} if tool_calls else {})}
    return ChatResult(message=msg, finish_reason="tool_calls" if tool_calls else "stop", usage=Usage(), model="m",
                      seconds=0.01, cost_usd=0.001, peak=False)


def _verdict(verdict: str, reason: str) -> ChatResult:
    call = {"id": "v", "type": "function", "function": {"name": "submit_result", "arguments": json.dumps({"verdict": verdict, "reason": reason})}}
    return _reply(tool_calls=[call])


class Fake:
    """Worker replies and evaluator verdicts, each consumed in order; records what every call was sent."""

    def __init__(self, worker: list[ChatResult], verdicts: list):
        self.worker, self.verdicts, self.worker_seen, self.judge_seen = list(worker), list(verdicts), [], []

    async def chat(self, messages, **kw):
        if kw.get("tool_choice") == "required":
            self.judge_seen.append(messages)
            v = self.verdicts.pop(0)
            if isinstance(v, Exception):
                raise v
            return v
        self.worker_seen.append([dict(m) for m in messages])
        return self.worker.pop(0)


def _task(tmp_path, **kw) -> Task:
    return Task.from_dict({"prompt": "make the tests pass", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash",
                           "done_when": "pytest exits 0", **kw})


def test_a_blocked_claim_goes_back_to_the_worker_and_a_proven_one_is_accepted(tmp_path):
    fake = Fake([_reply("tests pass"), _reply("ran pytest: exit=0")],
                [_verdict("block", "no pytest run in the transcript"), _verdict("ok", "exit=0 shown")])
    res, messages = asyncio.run(agent.run_api_task(fake, _task(tmp_path)))
    assert res.status == "ok" and res.answer == "ran pytest: exit=0"
    assert res.goal == {"verdict": "ok", "reason": "exit=0 shown", "checks": 2, "blocks": 1}
    nudge = fake.worker_seen[1][-1]
    assert nudge["role"] == "user" and "no pytest run in the transcript" in nudge["content"]
    # the evaluator read the goal and the claimed answer, with no tools but its verdict form
    assert "pytest exits 0" in fake.judge_seen[0][-1]["content"] and "tests pass" in fake.judge_seen[0][-1]["content"]
    assert abs(res.cost_usd - 0.004) < 1e-9, "both evaluator calls are costed on the task"


def test_blocks_past_the_cap_end_the_task_as_goal_not_met_with_the_answer_kept(tmp_path):
    fake = Fake([_reply("done"), _reply("really done")], [_verdict("block", "no proof")] * 2)
    res, _ = asyncio.run(agent.run_api_task(fake, _task(tmp_path, done_when_max_blocks=1)))
    assert res.status == "error" and res.error.startswith("goal not met after 2 checks") and res.answer == "really done"
    assert not fake.worker, "the worker was sent back exactly once"


def test_impossible_errors_at_once_and_an_evaluator_failure_keeps_the_answer(tmp_path):
    res, _ = asyncio.run(agent.run_api_task(Fake([_reply("done")], [_verdict("impossible", "there is no test suite")]), _task(tmp_path)))
    assert res.status == "error" and res.error == "goal impossible: there is no test suite" and res.answer == "done"
    res, _ = asyncio.run(agent.run_api_task(Fake([_reply("done")], [RuntimeError("provider down")]), _task(tmp_path)))
    assert res.status == "ok" and res.answer == "done" and res.goal["verdict"] == "unchecked" and "provider down" in res.goal["reason"]


def test_a_blocked_submit_result_is_rejected_as_a_tool_error(tmp_path):
    schema = {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}
    submit = lambda s: [{"id": "s", "type": "function", "function": {"name": "submit_result", "arguments": json.dumps({"summary": s})}}]  # noqa: E731
    fake = Fake([_reply(tool_calls=submit("claimed")), _reply(tool_calls=submit("proven"))],
                [_verdict("block", "no exit code"), _verdict("ok", "exit=0")])
    res, _ = asyncio.run(agent.run_api_task(fake, _task(tmp_path, schema=schema)))
    assert res.status == "ok" and res.data == {"summary": "proven"}
    rejected = [m for m in fake.worker_seen[1] if m["role"] != "user"][-1]  # a budget note (zs-budget) may ride behind it
    assert rejected["role"] == "tool" and rejected["content"].startswith("ERROR: submit_result rejected by the goal check")
