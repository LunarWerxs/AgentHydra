"""The api backend's Claude transport (anthropic_native, ChatClient): Anthropic's OpenAI-compatible endpoint caches
nothing, so 1,513 multi-turn Claude tasks sent 147M input tokens at full price on 2026-10-01."""
import asyncio
import json

import httpx
import pytest

from hswarm.client import ChatClient

MODEL = "rank:claude-opus-5-5:direct"
TOOLS = [{"type": "function", "function": {"name": "read_file", "description": "Read a file.",
                                           "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]


def test_a_claude_task_sends_cache_breakpoints_from_one_key_on_every_turn_and_prices_what_it_reads():
    """Contract: every turn of one task goes to the native Messages endpoint on the SAME key (a prompt cache belongs
    to one organisation; the pool has three, so round-robin would move turn two), with breakpoints on the system
    prompt and on the last two user turns, the transcript left untouched; cache reads come back as in_hit and
    writes are billed at Opus 5.5's write rate."""
    sent: list[httpx.Request] = []

    def reply(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "ok"}],
                                         "stop_reason": "end_turn", "usage": {"input_tokens": 10, "cache_read_input_tokens": 900,
                                                                              "cache_creation_input_tokens": 50, "output_tokens": 5}})

    client = ChatClient(api_keys=["sk-test-a", "sk-test-b", "sk-test-c"], provider="anthropic")
    client._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(reply))
    messages = [{"role": "system", "content": "You are a worker."}, {"role": "user", "content": "Read a.txt"}]

    async def two_turns():
        await client.chat(messages, model=MODEL, tools=TOOLS, affinity="job:t1")
        messages.append({"role": "assistant", "content": "", "tool_calls": [
            {"id": "functions.read_file:0", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}}]})
        messages.append({"role": "tool", "tool_call_id": "functions.read_file:0", "content": "hello"})
        r = await client.chat(messages, model=MODEL, tools=TOOLS, affinity="job:t1")
        await client.aclose()
        return r

    r = asyncio.run(two_turns())
    assert [(q.url.host, q.url.path) for q in sent] == [("api.anthropic.com", "/v1/messages")] * 2
    assert sent[0].headers["x-api-key"] == sent[1].headers["x-api-key"] and "authorization" not in sent[1].headers
    body = json.loads(sent[1].content)
    assert body["system"] == [{"type": "text", "text": "You are a worker.", "cache_control": {"type": "ephemeral"}}]
    first, call, result = body["messages"]
    assert first["content"][-1]["cache_control"] == result["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert call["content"] == [{"type": "tool_use", "id": "functions_read_file_0", "name": "read_file", "input": {"path": "a.txt"}}]
    assert result["content"][0]["tool_use_id"] == "functions_read_file_0"
    assert "cache_control" not in json.dumps(messages)
    assert (r.usage.hit, r.usage.miss, r.usage.as_dict()["in_write"], r.content) == (900, 60, 50, "ok")
    # 900 read at $0.20 + 10 input at $4 + 50 written at $5 + 5 out at $20, per million
    assert r.cost_usd == pytest.approx((900 * 0.2 + 10 * 4.0 + 50 * 5.0 + 5 * 20.0) / 1e6)
