"""Offline: a stalled read (httpx.ReadTimeout) inside ChatClient._post is retried once, then raised as
a provider error shaped like a 504 - so jobs.leg_unavailable fails it over the same way an ordinary
error already does, instead of the call hanging until the whole task's own budget runs out with nothing
retried and nothing failed over. The finding this pins:
docs/todo/improvements/tooling/a-stalled-model-request-eats-a-whole-hswarm-task.md
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.client import OUTPUT_TOKENS_PER_S, READ_TIMEOUT_S, REASONING_EFFORT_READ_SCALE, STALL_RETRIES, ChatClient, _read_timeout_s  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402


def test_the_read_timeout_scales_by_reasoning_effort_and_stays_under_the_task_budget():
    assert _read_timeout_s(None) == READ_TIMEOUT_S == _read_timeout_s("low")
    assert _read_timeout_s("high") == READ_TIMEOUT_S * 2
    assert _read_timeout_s("max") == READ_TIMEOUT_S * 3
    # An effort tier this function has never heard of must never blow the window up unbounded.
    assert _read_timeout_s("a-future-tier-nobody-registered-yet") == READ_TIMEOUT_S
    # Task.timeout_s defaults to 600s; even the slowest deliberate tier must leave room to fail over.
    assert _read_timeout_s("max") < 600.0


def test_a_long_answer_gets_a_read_window_that_can_fit_its_output_and_a_small_one_keeps_the_old_window():
    """A non-streaming reply is silent until it is whole, so a 32000-token answer needs more than 180 s."""
    seen: list[float] = []

    def handler(req: httpx.Request):
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}], "usage": {}})

    def read_window(max_tokens: int, rest_budget_s: float | None = None) -> float:
        c = _client(handler)
        orig_post = c._http.post

        async def spy_post(*a, **kw):
            seen.append(kw["timeout"].read)
            return await orig_post(*a, **kw)

        c._http.post = spy_post
        body = {"model": "deepseek-flash", "messages": [{"role": "user", "content": "x"}], "max_tokens": max_tokens}
        asyncio.run(c._post(body, rest_budget_s=rest_budget_s))
        return seen[-1]

    assert read_window(32000) == 32000 / OUTPUT_TOKENS_PER_S > READ_TIMEOUT_S
    assert read_window(32000, rest_budget_s=300.0) == 300.0
    assert read_window(1000) == READ_TIMEOUT_S


def _client(handler):
    c = ChatClient(api_keys=["sk-test-1"])
    c._http = httpx.AsyncClient(base_url=c.spec["base_url"], transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def test_a_stall_that_never_recovers_is_retried_once_then_raised_as_a_504_naming_the_stall():
    seen: list[int] = []

    def handler(req: httpx.Request):
        seen.append(1)
        raise httpx.ReadTimeout("simulated stall", request=req)

    c = _client(handler)
    with pytest.raises(ApiError, match="stalled: no reply within") as ei:
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False, reasoning_effort="low"))
    assert ei.value.status == 504
    assert len(seen) == STALL_RETRIES + 1 == 2  # the first try plus one retry, then it gives up
    assert c.stalls == 2 and c.retries >= 1


def test_a_stall_that_then_answers_succeeds_without_failing_over():
    calls: list[int] = []

    def handler(req: httpx.Request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("simulated stall", request=req)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 2}})

    c = _client(handler)
    r = asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False, reasoning_effort="low"))
    assert r.content == "OK" and len(calls) == 2 and c.stalls == 1


def test_reasoning_effort_high_is_given_a_longer_window_before_it_counts_as_stalled():
    """The per-request timeout handed to httpx carries the scaled window, not the flat default."""
    seen_timeouts: list[httpx.Timeout] = []

    def handler(req: httpx.Request):
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}], "usage": {}})

    c = _client(handler)
    orig_post = c._http.post

    async def spy_post(*a, **kw):
        seen_timeouts.append(kw.get("timeout"))
        return await orig_post(*a, **kw)

    c._http.post = spy_post
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False, reasoning_effort="high"))
    assert seen_timeouts[0].read == READ_TIMEOUT_S * REASONING_EFFORT_READ_SCALE["high"]
    assert seen_timeouts[0].connect == 30.0  # connect stays as it was, only read is scaled
