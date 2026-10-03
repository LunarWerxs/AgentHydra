"""Offline: a tool call the model wrote as TEXT is promoted to a real call, and prose about tool calls is not.

The api loop takes a reply without tool_calls as the final answer, so a cheap worker (gpt-oss harmony headers,
Qwen <tool_call> tags, Mistral [TOOL_CALLS] brackets) that writes its call as text ended the task with the markup
as its answer and status ok. Pinned at two seams: the parser (which shapes count, which never do) and the loop
(a promoted call is dispatched through run_tools and the task goes on to its real answer).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.spec import Task  # noqa: E402
from hswarm.toolcall_repair import find_text_tool_calls, promote_text_tool_calls, tool_schemas  # noqa: E402
from hswarm.tools import specs_for  # noqa: E402

SCHEMAS = tool_schemas(specs_for("read"))


@pytest.mark.parametrize("text", [
    '<|start|>assistant<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>{"path": "a.py", "start_line": 3}<|call|>',
    'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.py", "start_line": 3}}\n</tool_call>',
    '<tool_call>\n<function=read_file>\n<parameter=path>\na.py\n</parameter>\n<parameter=start_line>\n3\n</parameter>\n</function>\n</tool_call>',
    '[TOOL_CALLS]read_file[ARGS]{"path": "a.py", "start_line": 3}',
    '[TOOL_CALLS][{"name": "read_file", "arguments": {"path": "a.py", "start_line": 3}}]',
    '{"name": "read_file", "arguments": "{\\"path\\": \\"a.py\\", \\"start_line\\": 3}"}',
])
def test_every_text_shape_becomes_one_structured_call(text):
    calls, _ = find_text_tool_calls(text, SCHEMAS)
    assert calls == [{"name": "read_file", "arguments": {"path": "a.py", "start_line": 3}}]


@pytest.mark.parametrize("text", [
    '```\n<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>\n```',  # quoted in a code fence
    'Workers emit `[TOOL_CALLS]read_file[ARGS]{"path": "a.py"}` when they misbehave.',  # inline code
    '> <tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>',  # blockquote
    'The answer: call <tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call> first.',  # mid-sentence
    '<tool_call>{"name": "bash", "arguments": {"command": "rm -rf ."}}</tool_call>',  # not offered this turn
    '{"name": "read_file", "count": 3}',  # a JSON answer that merely has a name key
])
def test_prose_code_and_unoffered_tools_are_never_calls(text):
    assert find_text_tool_calls(text, SCHEMAS)[0] == []


def test_promoted_message_carries_structured_calls_and_drops_the_markup():
    msg = {"role": "assistant", "content": "x", "reasoning_content": "kept"}
    text = 'Reading it.\n[TOOL_CALLS]grep[ARGS]{"pattern": "def "}'
    fixed = promote_text_tool_calls(msg, text, specs_for("read"))
    assert fixed["content"] == "Reading it." and fixed["reasoning_content"] == "kept"
    (tc,) = fixed["tool_calls"]
    assert tc["function"]["name"] == "grep" and json.loads(tc["function"]["arguments"]) == {"pattern": "def "}
    assert len(tc["id"]) == 9 and tc["id"].isalnum()  # Mistral rejects any other id shape
    assert promote_text_tool_calls(msg, "just an answer", specs_for("read")) is None


def test_the_api_loop_runs_a_text_written_call_instead_of_answering_with_it(tmp_path):
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    (tmp_path / "evidence.txt").write_text("the line that matters\n", encoding="utf-8")
    harmony = '<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>{"path": "evidence.txt"}<|call|>'

    class Harmony:
        seen: list[dict] = []

        async def chat(self, messages, **kw):
            self.seen = list(messages)
            said = harmony if len(messages) == 2 else "the line that matters"
            return ChatResult(message={"role": "assistant", "content": said}, finish_reason="stop",
                              usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)

    client = Harmony()
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(client, task))
    assert res.status == "ok" and res.answer == "the line that matters"
    assert res.tool_calls == 1 and res.repaired_calls == 1
    call_turn, tool_turn = client.seen[2], client.seen[3]
    assert call_turn["tool_calls"][0]["function"]["name"] == "read_file"
    assert tool_turn["tool_call_id"] == call_turn["tool_calls"][0]["id"] and "the line that matters" in tool_turn["content"]
