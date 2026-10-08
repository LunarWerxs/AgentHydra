"""Offline: a request that cannot work is refused before any paid call, by the name of its mistake and the nearest
valid spelling. Each case here used to be accepted and paid for (discovery 2026-10-02, hswarm-dispatch-validation)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, dispatch, web  # noqa: E402
from hswarm.commands import _load_tasks  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402


def _task(tmp_path, **fields) -> Task:
    return Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "flash", **fields}, {}, 0)


def test_a_tasks_file_with_a_key_it_does_not_take_is_refused_by_name(tmp_path):
    # `default` for `defaults` was ignored: the batch ran with tools read, the shell's folder, no schema and no budget.
    f = tmp_path / "tasks.json"
    f.write_text(json.dumps({"default": {"tools": "none"}, "tasks": ["x"]}), encoding="utf-8")
    with pytest.raises(SystemExit, match="'defaults' for 'default'"):
        _load_tasks(str(f), SimpleNamespace())
    f.write_text(json.dumps({"defaults": {"cwd": str(tmp_path)}, "budget_usd": 2, "tasks": ["x"]}), encoding="utf-8")
    with pytest.raises(SystemExit, match="--budget"):
        _load_tasks(str(f), SimpleNamespace())
    f.write_text(json.dumps({"defaults": {"cwd": str(tmp_path), "tools": "none", "model": "flash"}, "tasks": ["x"]}), encoding="utf-8")
    assert [t.tools for t in _load_tasks(str(f), SimpleNamespace())] == ["none"]  # the right spelling still reaches the task


@pytest.mark.parametrize("schema, says", [
    ({"type": "object", "properties": {"a": {"type": "strng"}}}, "'string' for 'strng'"),  # not JSON Schema: any payload passed
    ({"type": "array", "items": {"type": "string"}}, "root must be type 'object'"),  # sent as function parameters of type array
    ({"type": "object", "properties": {"rows": {"type": "array", "minItems": 5, "maxItems": 2}}}, "minItems 5 is above maxItems 2"),
    ({"type": "object", "properties": {"n": {"type": "integer", "minimum": 9, "maximum": 1}}}, "minimum 9 is above maximum 1"),
    ({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["nmae"], "additionalProperties": False}, "'name' for 'nmae'"),
])
def test_a_schema_no_answer_can_meet_is_refused_at_submit(tmp_path, schema, says):
    with pytest.raises(ValueError, match=says):
        _task(tmp_path, schema=schema)


def test_a_strict_satisfiable_schema_is_still_accepted(tmp_path):
    schema = {"type": "object", "properties": {"rows": {"type": "array", "minItems": 1, "maxItems": 9, "items": {"type": "string"}}},
              "required": ["rows"], "additionalProperties": False}
    assert _task(tmp_path, schema=schema).schema == schema


@pytest.mark.parametrize("error, turns, cost", [
    ("InvalidStructuredAnswer: rank:glm-5-3 submitted 3 results that break the schema", 1, 0.01),
    # refused before anything was served, so it fails over (jobs._refused_unserved); with no leg left, it is the request
    ('openai API 400: {"error":{"message":"Function tools with reasoning_effort are not supported for gpt-6-luna",'
     '"type":"invalid_request_error","param":"reasoning_effort"}}', 0, 0.0),
])
def test_a_task_no_leg_could_structure_is_not_rerun_dead(monkeypatch, tmp_path, error, turns, cost):
    """Every leg ended InvalidStructuredAnswer, or refused the request with a 400: resting and walking the same ladder
    again buys the same refusals. The rerun stays for a route that could not serve (test_failover's rests-and-runs-again
    test)."""
    import hswarm.agent as agent

    calls = []

    async def leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        calls.append(task.model)
        return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=cost, turns=turns, error=error), []

    monkeypatch.setattr(agent, "run_api_task", leg)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {
        "profile": task.profile, "candidates": [{"model": "rank:glm-5-3", "reasoning_effort": "high", "thinking": True}]})
    monkeypatch.setattr(config, "DEAD_RERUN_PATIENCE_S", 60.0)
    monkeypatch.setattr(config, "DEAD_RERUN_REST_S", 0.0)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=None))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    res = asyncio.run(go()).results["t"]
    assert res.status == "error" and res.error == error
    assert len(calls) == 1 and "dead_reruns" not in (res.selection or {}), calls


def test_a_misspelled_tool_is_refused_on_both_backends(tmp_path):
    # cc read 'Edit' as read-only, so with confirm_write it ran a paid Claude Code session that could not write.
    with pytest.raises(ValueError, match="unknown tools.*'edit' for 'Edit'"):
        _task(tmp_path, backend="cc", tools="Edit", confirm_write=True)
    with pytest.raises(ValueError, match="'read' for 'raed'"):  # api: refused only once the task ran
        _task(tmp_path, tools="raed")
    assert _task(tmp_path, tools="read_file, grep").tools == "read_file, grep"  # a comma list of real tools still passes


def test_a_files_entry_that_is_not_there_is_refused_with_its_nearest_name(tmp_path):
    # It was inlined as `<unreadable: ...>` and the paid call answered about a file the worker never saw.
    (tmp_path / "notes.md").write_text("alpha", encoding="utf-8")
    with pytest.raises(ValueError, match="nope.py"):
        _task(tmp_path, files=["notes.md", "nope.py"])
    with pytest.raises(ValueError, match="'notes.md' for 'note.md'"):
        _task(tmp_path, files=["note.md"])


def test_a_web_hosts_entry_pasted_as_a_url_allows_the_host_it_names(tmp_path):
    t = _task(tmp_path, tools="web", web_hosts=["https://docs.python.org/3/", "docs.python.org"])
    assert t.web_hosts == ["docs.python.org"]
    assert web.gate("https://docs.python.org/3/library/", t.web_hosts).action == "allow"
    web.save_policy(allow=["https://example.org/docs/"])  # the standing list is read by the same rule
    assert web.gate("https://news.example.org/", []).action == "allow"
    with pytest.raises(ValueError, match="names no host"):
        _task(tmp_path, tools="web", web_hosts=["https://"])


def test_web_tasks_with_nothing_they_may_fetch_are_noted_not_refused(tmp_path):
    bare = _task(tmp_path, tools="web")  # accepted: approving a host afterwards is how the gate is meant to be used
    assert any("web_hosts" in note for note in dispatch.route_outlook([bare]))
    assert dispatch.route_outlook([_task(tmp_path, tools="web", web_hosts="a.test")]) == []
    web.save_policy(allow=["example.org"])
    assert dispatch.route_outlook([bare]) == []
