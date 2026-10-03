"""Offline: a submit_result call that omits a schema's `required` key is a tool error, not a result.

The provider's function calling treats `required` as advice (2026-09-16: a worker returned an
object with two required keys missing and the job reported it ok), so run_tools enforces it and
hands the model the missing list for one more turn. Pinned here because the failure only shows
up as silently incomplete data downstream.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.worker import run_tools, schema_errors  # noqa: E402

SCHEMA = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "integer"}}, "required": ["a", "b"]}


def _call(args: dict) -> dict:
    return {"id": "t1", "function": {"name": "submit_result", "arguments": json.dumps(args)}}


def test_schema_errors_name_only_absent_keys():
    [err] = schema_errors(SCHEMA, {"a": "x"})
    assert "'b'" in err and "'a'" not in err
    assert schema_errors(SCHEMA, {"a": "x", "b": 1}) == []
    assert schema_errors(None, {}) == []
    assert schema_errors({"type": "object"}, {}) == []


def test_incomplete_submit_is_a_tool_error_not_a_result():
    outputs, submitted = asyncio.run(run_tools(None, [_call({"a": "x"})], SCHEMA))
    assert submitted is None
    assert outputs[0].startswith("ERROR: submit_result rejected") and "b" in outputs[0]


def test_complete_submit_is_accepted():
    outputs, submitted = asyncio.run(run_tools(None, [_call({"a": "x", "b": 2})], SCHEMA))
    assert submitted == {"a": "x", "b": 2}
    assert outputs == ["result accepted"]


def test_no_schema_means_no_enforcement():
    outputs, submitted = asyncio.run(run_tools(None, [_call({"whatever": 1})], None))
    assert submitted == {"whatever": 1}


ROWS = {"type": "object", "required": ["rows"], "properties": {"rows": {"type": "array", "minItems": 3, "items": {
    "type": "object", "required": ["locale", "key", "text"],
    "properties": {"locale": {"type": "string"}, "key": {"type": "string"}, "text": {"type": "string"}}}}}}


def test_nested_schema_is_enforced_not_just_top_level_required():
    """2026-09-25: the Gemini route answered a translation asking for 140 rows with `{"rows": []}` and one
    `dummy` row, and both were ok because only the top-level `required` list was read."""
    state: dict = {}
    for bad in ({"rows": [{"text": "dummy", "locale": "dummy", "key": "dummy"}]}, {"rows": [{"locale": "fr"}] * 3}):
        outputs, submitted = asyncio.run(run_tools(None, [_call(bad)], ROWS, state))
        assert submitted is None and outputs[0].startswith("ERROR: submit_result rejected")
    assert state["invalid"] == 2 and any("rows/0" in e for e in state["last_errors"])


def test_a_hollow_result_is_pushed_back_once_then_accepted():
    open_map = {"type": "object", "properties": {"translations": {"type": "object"}}, "required": ["translations"]}
    state: dict = {}
    outputs, submitted = asyncio.run(run_tools(None, [_call({"translations": {}})], open_map, state))
    assert submitted is None and "carries no data" in outputs[0]
    outputs, submitted = asyncio.run(run_tools(None, [_call({"translations": {}})], open_map, state))
    assert submitted == {"translations": {}}, "a genuinely empty answer still lands on the second submit"


class _TextAnswerer:
    """Answers in plain text every turn, as Cohere's Command A did under a schema on 2026-09-26."""

    def __init__(self, replies: list[str]):
        self.replies, self.turns = list(replies), 0

    async def chat(self, messages, **kw):
        from hswarm.client import ChatResult, Usage

        self.turns += 1
        text = self.replies[min(self.turns - 1, len(self.replies) - 1)]
        return ChatResult(message={"role": "assistant", "content": text}, finish_reason="stop", usage=Usage(),
                          model="deepseek-flash", seconds=0.001, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


# Contract: a task with a schema never ends ok without its data. A text answer that holds a conforming payload (fenced
# or typed as a submit_result call) is taken; one that holds none sends the worker back, then fails the leg over as
# InvalidStructuredAnswer. Regression: "I've found several findings" and tool calls written as text came back ok with
# data None to four jobs on 2026-09-26.
def test_a_schema_task_answered_in_text_is_never_ok_without_its_data(tmp_path):
    from hswarm import agent
    from hswarm.spec import Task

    def run(replies):
        task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", "route": False,
                               "schema": SCHEMA}, {}, 0)
        client = _TextAnswerer(replies)
        res, _ = asyncio.run(agent.run_api_task(client, task))
        return res, client.turns

    res, _ = run(['[{"tool_call_id": "0", "tool_name": "submit_result", "parameters": {"a": "x", "b": 2}}]'])
    assert res.status == "ok" and res.data == {"a": "x", "b": 2}
    res, _ = run(['Here it is:\n```json\n{"a": "y", "b": 3}\n```'])
    assert res.status == "ok" and res.data == {"a": "y", "b": 3}
    res, turns = run(["I've found several findings"])
    assert res.status == "error" and res.error.startswith("InvalidStructuredAnswer") and res.data is None and turns == 3
