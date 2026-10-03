"""Offline: a schema on `ask` must not collide with thinking mode.

DeepSeek answers HTTP 400 "Thinking mode does not support this tool_choice" when
tool_choice=required arrives with thinking on - and a schema IS tool_choice=required, so the
default-thinking caller got a hard error instead of data. Pinned here because the failure is on
the provider's side and would otherwise only reappear as a live 400.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.agent import ask  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402


class _RecordingClient:
    """Records the kwargs of the one chat() call and answers with a submit_result tool call."""

    def __init__(self):
        self.kw = None

    async def chat(self, messages, **kw):
        self.kw = kw
        call = {"function": {"name": "submit_result", "arguments": json.dumps({"ok": True})}}
        return ChatResult(
            message={"role": "assistant", "content": "", "tool_calls": [call]},
            finish_reason="tool_calls",
            usage=Usage(),
            model="deepseek-flash",
            seconds=0.01,
            cost_usd=0.0,
            peak=False,
        )


def _ask(**kwargs):
    client = _RecordingClient()
    res = asyncio.run(ask(client, "q", schema={"type": "object", "properties": {"ok": {"type": "boolean"}}}, **kwargs))
    return client, res


def test_schema_turns_thinking_off_and_still_parses_data():
    client, res = _ask()
    assert client.kw["tool_choice"] == "required"
    assert client.kw["thinking"] is False
    assert res.status == "ok" and res.data == {"ok": True}


def test_an_explicit_thinking_true_is_left_alone():
    # The caller asked for it; the provider's refusal is theirs to see, not ours to hide.
    client, _ = _ask(thinking=True)
    assert client.kw["thinking"] is True


def test_a_thinking_claude_route_asks_for_the_tool_instead_of_forcing_it():
    # A benchmarked direct-Anthropic route keeps its default thinking, and Anthropic refuses tool_choice any/tool with
    # thinking on (HTTP 400): Lift's round 7 hearing lost its drafter and its design score to it (2026-09-29).
    client, res = _ask(model="rank:claude-sonnet-5-5-low:direct")
    assert client.kw["thinking"] is True
    assert client.kw["tool_choice"] == "auto"
    assert res.status == "ok" and res.data == {"ok": True}


def test_a_schemaless_ask_keeps_the_default_thinking():
    client = _RecordingClient()
    asyncio.run(ask(client, "q"))
    assert client.kw["tool_choice"] is None and client.kw["thinking"] is None
