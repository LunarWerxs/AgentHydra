"""Offline: a recipe task's cached tool plan (plans.py) - recorded from a passing run, replayed before the model plans
again, dropped when a replayed call errors, and never kept for a task with no recipe."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from hswarm import plans  # noqa: E402
from hswarm.agent import run_api_task  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.spec import Task  # noqa: E402


class _Scripted:
    """A fake client that plays back assistant messages in order and keeps what each call was sent."""

    def __init__(self, *replies: dict):
        self.replies, self.sent = list(replies), []

    async def chat(self, messages, **kw):
        self.sent.append(json.loads(json.dumps(messages)))
        msg = self.replies.pop(0)
        return ChatResult(message=msg, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.0, cost_usd=0.0, peak=False)


def _read(path: str, call_id: str = "c1") -> dict:
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": call_id, "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": path})}}]}


ANSWER = {"role": "assistant", "content": "the answer"}


def _task(cwd: Path, recipe: str | None = "weekly-digest") -> Task:
    return Task.from_dict({"prompt": "summarise notes.txt", "cwd": str(cwd), "tools": "read", "model": "deepseek-flash", "recipe": recipe})


def test_a_passing_recipe_run_is_replayed_before_the_model_plans_again(tmp_path):
    (tmp_path / "notes.txt").write_text("monday: shipped", encoding="utf-8")
    first = _Scripted(_read("notes.txt"), ANSWER)
    res, _ = asyncio.run(run_api_task(first, _task(tmp_path)))
    assert res.status == "ok" and res.plan == "miss" and len(first.sent) == 2

    # New input of the same shape: the recorded read runs on today's bytes and reaches the model's FIRST call.
    (tmp_path / "notes.txt").write_text("tuesday: fixed the build", encoding="utf-8")
    second = _Scripted(ANSWER)
    res, _ = asyncio.run(run_api_task(second, _task(tmp_path)))
    user_turn = second.sent[0][1]["content"]
    assert res.status == "ok" and res.plan == "hit: 1 calls" and len(second.sent) == 1
    assert "replayed plan: recipe weekly-digest" in user_turn and "tuesday: fixed the build" in user_turn
    assert "monday" not in user_turn  # the plan is cached, never the output


def test_a_replayed_call_that_errors_drops_the_replay_and_the_model_plans(tmp_path):
    (tmp_path / "notes.txt").write_text("monday", encoding="utf-8")
    asyncio.run(run_api_task(_Scripted(_read("notes.txt"), ANSWER), _task(tmp_path)))
    (tmp_path / "notes.txt").unlink()
    (tmp_path / "log.txt").write_text("renamed", encoding="utf-8")

    client = _Scripted(_read("log.txt", "c9"), ANSWER)
    res, _ = asyncio.run(run_api_task(client, _task(tmp_path)))
    assert res.status == "ok" and res.plan.startswith("fallback: read_file ERROR")
    assert "replayed plan" not in client.sent[0][1]["content"]
    # The run that passed after the fallback is the plan now.
    assert plans.lookup(_task(tmp_path)) == [{"name": "read_file", "args": {"path": "log.txt"}}]


def test_a_task_with_no_recipe_is_never_cached(tmp_path):
    (tmp_path / "notes.txt").write_text("monday", encoding="utf-8")
    res, _ = asyncio.run(run_api_task(_Scripted(_read("notes.txt"), ANSWER), _task(tmp_path, recipe=None)))
    assert res.status == "ok" and res.plan is None and not plans.plans_file().exists()


def test_writes_are_not_recorded_and_another_version_is_not_replayed(tmp_path, monkeypatch):
    (tmp_path / "notes.txt").write_text("monday", encoding="utf-8")
    task = Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "tools": "edit", "model": "deepseek-flash", "recipe": "r1"})
    write = {"role": "assistant", "content": "", "tool_calls": [
        {"id": "w1", "type": "function", "function": {"name": "write_file", "arguments": json.dumps({"path": "out.txt", "content": "x"})}},
        {"id": "r1", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": "notes.txt"})}}]}
    asyncio.run(run_api_task(_Scripted(write, ANSWER), task))
    assert plans.lookup(task) == [{"name": "read_file", "args": {"path": "notes.txt"}}]
    monkeypatch.setattr(plans, "__version__", "9.9.9")
    assert plans.lookup(task) == []


def test_a_recipe_must_be_a_name_on_the_api_backend(tmp_path):
    with pytest.raises(ValueError, match="recipe must be a name"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "recipe": "summarise whatever the user pasted"})
