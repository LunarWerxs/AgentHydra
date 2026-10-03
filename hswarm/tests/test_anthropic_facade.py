"""Offline: the Anthropic Messages facade that lets a `cc` worker run on an OpenAI-only provider (gemini, groq,
cerebras). The upstream is an httpx MockTransport and Claude Code is a fake; nothing leaves the machine."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import anthropic_facade as af  # noqa: E402
from hswarm import cc, claude_env, config  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def _types(events):
    return [e for e, _ in events]


def test_a_claude_code_turn_becomes_an_openai_chat_request():
    body = {
        "model": "openai/gpt-oss-120b", "max_tokens": 32000, "stream": True, "temperature": 1, "metadata": {"user_id": "x"},
        "system": [{"type": "text", "text": "You are Claude Code.", "cache_control": {"type": "ephemeral"}}, {"type": "text", "text": "Be brief."}],
        "tools": [{"name": "Read", "description": "read a file", "input_schema": {
                      "$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
                      "properties": {"file_path": {"type": "string"}, "opts": {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}}}},
                  {"type": "web_search_20250305", "name": "web_search"}],
        "tool_choice": {"type": "any"},
        "messages": [
            {"role": "user", "content": "read a.py"},
            {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm", "signature": "s"}, {"type": "text", "text": "Reading."},
                                              {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"file_path": "a.py"}}]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": [{"type": "text", "text": "print(1)"},
                                                                              {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}}]},
                {"type": "tool_result", "tool_use_id": "call_2", "content": "", "is_error": True},
                {"type": "text", "text": "and?"}]},
        ],
    }
    req = af.to_chat_request(body, omit=("temperature",), extras={"call_1": {"google": {"thought_signature": "sig"}}})
    assert req["messages"] == [
        {"role": "system", "content": "You are Claude Code.\nBe brief."},
        {"role": "user", "content": "read a.py"},
        {"role": "assistant", "content": "Reading.", "tool_calls": [{"id": "call_1", "type": "function", "extra_content": {"google": {"thought_signature": "sig"}},
                                                                     "function": {"name": "Read", "arguments": '{"file_path": "a.py"}'}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "print(1)"},
        {"role": "tool", "tool_call_id": "call_2", "content": "ERROR: (no output)"},
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}, {"type": "text", "text": "and?"}]},
    ]
    # the server tool has nothing upstream to run it; `any` is OpenAI's `required`; the refused field is gone
    assert [t["function"]["name"] for t in req["tools"]] == ["Read"] and req["tool_choice"] == "required"
    # zod's "$schema" is a 400 on Gemini's OpenAI endpoint, so it is scrubbed at every depth
    assert req["tools"][0]["function"]["parameters"] == {"type": "object", "properties": {"file_path": {"type": "string"}, "opts": {"type": "object"}}}
    assert req["stream"] is True and req["stream_options"] == {"include_usage": True} and "temperature" not in req
    assert req["max_tokens"] == 32000 and "metadata" not in req


def test_the_chat_stream_is_re_emitted_as_anthropic_events():
    conv = af.StreamConverter("m")
    chunks = [
        {"choices": [{"delta": {"reasoning": "think"}}]},
        {"choices": [{"delta": {"content": "Hi"}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c0", "function": {"name": "Read", "arguments": '{"file_'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'path": "a.py"}'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "c1", "function": {"name": "Grep", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]},
        {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 40}}},
    ]
    events = [ev for c in chunks for ev in conv.feed(c)] + conv.finish()
    assert _types(events) == ["message_start",
                              "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",  # thinking + signature
                              "content_block_start", "content_block_delta", "content_block_stop",  # text
                              "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",  # tool 0
                              "content_block_start", "content_block_delta", "content_block_stop",  # tool 1
                              "message_delta", "message_stop"]
    assert events[3][1]["delta"] == {"type": "signature_delta", "signature": af.SIGNATURE}
    assert events[8][1]["content_block"] == {"type": "tool_use", "id": "c0", "name": "Read", "input": {}}
    args = "".join(d["delta"]["partial_json"] for e, d in events if e == "content_block_delta" and d["index"] == 2)
    assert json.loads(args) == {"file_path": "a.py"}
    assert events[12][1]["index"] == 3 and events[12][1]["content_block"]["name"] == "Grep"
    delta = events[-2][1]
    assert delta["delta"]["stop_reason"] == "tool_use"
    assert delta["usage"] == {"input_tokens": 100, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 0, "output_tokens": 7}


def test_gemini_style_whole_tool_calls_keep_their_signature_for_the_next_turn():
    """Gemini's OpenAI endpoint sends each call whole, both at index 0, finishes a tool turn with "stop", and
    refuses the next turn unless each call's thought signature comes back with it."""
    extras: dict = {}
    conv = af.StreamConverter("gemini-3.8-flash", extras)
    sig = {"google": {"thought_signature": "abc"}}
    events = conv.feed({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "g1", "function": {"name": "Read", "arguments": "{}"}, "extra_content": sig}]}}]})
    events += conv.feed({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "g2", "function": {"name": "Glob", "arguments": "{}"}}]}, "finish_reason": "stop"}]})
    events += conv.finish()
    starts = [d["content_block"]["id"] for e, d in events if e == "content_block_start"]
    assert starts == ["g1", "g2"] and events[-2][1]["delta"]["stop_reason"] == "tool_use"
    replay = af.to_chat_request({"messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "g1", "name": "Read", "input": {}}]}]}, extras=extras)
    assert replay["messages"][0]["tool_calls"][0]["extra_content"] == sig


async def test_the_loopback_facade_serves_claude_code_end_to_end():
    seen: list[httpx.Request] = []
    stream = "".join("data: " + json.dumps(c) + "\n\n" for c in (
        {"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 1}})) + "data: [DONE]\n\n"

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        if body["model"] == "broke":
            return httpx.Response(402, json={"error": {"message": "Insufficient Balance"}})
        if body["model"] == "busy":
            return httpx.Response(429, json={"error": {"message": "slow down"}}, headers={"retry-after": "7"})
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    async with af.Facade("groq", transport=httpx.MockTransport(upstream)) as f:
        assert f.url.startswith("http://127.0.0.1:")
        async with httpx.AsyncClient(base_url=f.url) as client:
            ok = await client.post("/v1/messages?beta=true", headers={"x-api-key": "gsk-test"},
                                   json={"model": "openai/gpt-oss-120b", "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
            broke = await client.post("/v1/messages", headers={"authorization": "Bearer gsk-test"},
                                      json={"model": "broke", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]})
            busy = await client.post("/v1/messages", headers={"x-api-key": "gsk-test"},
                                     json={"model": "busy", "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
            count = await client.post("/v1/messages/count_tokens", json={"messages": [{"role": "user", "content": "x" * 400}]})
    events = [json.loads(line[6:]) for line in ok.text.splitlines() if line.startswith("data: ")]
    assert ok.status_code == 200 and [e["type"] for e in events][-2:] == ["message_delta", "message_stop"]
    assert [e["delta"]["text"] for e in events if e["type"] == "content_block_delta"] == ["done"]
    assert events[-2]["usage"]["input_tokens"] == 5 and events[-2]["delta"]["stop_reason"] == "end_turn"
    # the worker's own key goes upstream as a bearer token, to the provider's chat route
    assert all(r.url.path == "/openai/v1/chat/completions" and r.headers["authorization"] == "Bearer gsk-test" for r in seen)
    # a 402 comes back AS a 402, which is what Claude Code prints as "API Error: 402" and cc.out_of_balance reads
    assert broke.status_code == 402 and broke.json()["error"] == {"type": "billing_error", "message": "Insufficient Balance"}
    # a rate limit keeps the provider's Retry-After, which Claude Code waits out before its retry
    assert busy.status_code == 429 and busy.headers["retry-after"] == "7" and busy.json()["error"]["type"] == "rate_limit_error"
    assert count.status_code == 200 and count.json()["input_tokens"] >= 100


async def test_a_cc_task_on_a_free_leg_runs_through_a_facade_that_lives_only_for_its_run(monkeypatch, tmp_path):
    # Refused at submit before the facade: gemini had no Anthropic endpoint.
    task = Task.from_dict({"prompt": "x", "backend": "cc", "model": "gemini-3.8-flash", "cwd": str(tmp_path)}, {}, 0)
    seen: dict = {}

    async def fake_claude(cmd, cwd, timeout_s, env=None, stdin_text=None, on_line=None):
        seen["url"], seen["no_proxy"] = env["ANTHROPIC_BASE_URL"], env.get("NO_PROXY", "")
        async with httpx.AsyncClient() as client:  # the facade is up while Claude Code runs
            seen["live"] = (await client.get(env["ANTHROPIC_BASE_URL"] + "/nope")).json()["type"]
        return 0, json.dumps({"type": "result", "result": "done", "num_turns": 1, "usage": {}}), ""

    monkeypatch.setattr(cc, "run_hidden", fake_claude)
    res, _ = await cc.run_cc_task(task, "g-key")
    assert res.status == "ok" and seen["url"].startswith("http://127.0.0.1:") and seen["live"] == "error"
    assert "127.0.0.1" in seen["no_proxy"].split(",")  # an operator proxy is never asked to reach the loopback
    with pytest.raises(httpx.ConnectError):  # and gone once the run is over
        async with httpx.AsyncClient() as client:
            await client.get(seen["url"] + "/nope")
    # outside a run there is no endpoint to point Claude Code at, and it says so rather than sending the marker
    with pytest.raises(RuntimeError, match="loopback Anthropic facade"):
        claude_env.cc_env("g-key", "gemini-3.8-flash")
    assert config.PROVIDERS["groq"]["anthropic_url"] == config.PROVIDERS["cerebras"]["anthropic_url"] == config.ANTHROPIC_FACADE


def test_a_cc_task_fails_over_onto_a_facade_leg_only_from_a_model_that_is_facade_served_itself():
    # jobs._run_legs keeps every cc leg with a truthy anthropic_url, the facade marker included. That must not turn a
    # cc task on a paid Anthropic endpoint (DeepSeek, Hugging Face, OpenRouter) into a run on a free facade leg on
    # failover, and AUTO for cc must admit no facade leg until a benchmark clears one.
    facade = lambda m: config.PROVIDERS[config.provider_of(m)].get("anthropic_url") == config.ANTHROPIC_FACADE  # noqa: E731
    for model in config.MODELS:
        if not facade(model) and config.PROVIDERS[config.provider_of(model)].get("anthropic_url"):
            assert not [leg for leg in config.routes_for(model, "cc") if facade(leg)], model
    from hswarm import selection

    for profile in ("general", "code"):
        assert not [c for c in selection.plan(profile, tools="all", backend="cc")["candidates"] if facade(c["model"])], profile
