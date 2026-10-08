"""Offline: the per-key limiter wired into ChatClient._post and ServiceClient.call (keylimits). Every acquire is released
exactly once on every way out of an attempt, a request waiting for a key is not sent and leaves no receipt, and a
provider with no [limits] sends exactly as before. Invented keys, httpx MockTransport, the isolated home's ledger."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from hswarm import config, egress, keylimits
from hswarm.client import ChatClient
from hswarm.service import ServiceClient
from hswarm.usage import ApiError

A, B = "sk-invented-aaaa1111", "sk-invented-bbbb2222"
MSG = [{"role": "user", "content": "example"}]


def _limit(monkeypatch, provider: str, **limits) -> None:
    monkeypatch.setitem(config.PROVIDERS, provider, {**config.PROVIDERS[provider], "limits": limits})


def _held() -> int:
    return sum(slot.inflight for slot in keylimits._SLOTS.values())


def _key_of(req: httpx.Request) -> str:
    return next(k for k in (A, B) if k in " ".join(req.headers.values()))


def _ok() -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


def _chat_client(handler, keys) -> ChatClient:
    c = ChatClient(api_keys=keys)
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler),
                                headers={"Content-Type": "application/json"})
    return c


async def _until(cond, timeout: float = 5.0) -> None:
    async def spin():
        while not cond():
            await asyncio.sleep(0.005)
    await asyncio.wait_for(spin(), timeout)


@pytest.mark.parametrize("path", ["failover_402", "transport_then_ok", "stalled_twice", "receipt_refused", "cancelled_in_flight"])
def test_every_way_out_of_a_chat_attempt_releases_its_key_once(path, monkeypatch):
    """Contract: whatever ends an attempt (a 402 that moves to the next key, a transport error and its backoff, two
    stalls, a refused receipt, a cancel mid-POST), no slot stays held, the backoff sleeps holding none, and there is
    exactly one receipt per request the host received."""
    _limit(monkeypatch, "deepseek", key_concurrency=1)
    seen: list[str] = []
    held_at_backoff: list[int] = []
    monkeypatch.setattr(ChatClient, "_backoff", staticmethod(lambda attempt: held_at_backoff.append(_held()) or 0.0))

    async def handler(req):
        seen.append(_key_of(req))
        if path == "failover_402" and len(seen) == 1:
            return httpx.Response(402, json={"error": {"message": "Insufficient Balance"}})
        if path == "transport_then_ok" and len(seen) == 1:
            raise httpx.ConnectError("refused", request=req)
        if path == "stalled_twice":
            raise httpx.ReadTimeout("no reply", request=req)
        if path == "cancelled_in_flight":
            await asyncio.Event().wait()
        return _ok()

    if path == "receipt_refused":
        def broken(entry):
            raise OSError("disk full")
        monkeypatch.setattr(egress, "_append", broken)

    async def go():
        c = _chat_client(handler, [A, B])
        if path == "receipt_refused":
            with egress.fail_closed(), pytest.raises(egress.EgressReceiptFailed):
                await c.chat(MSG, model="deepseek-flash", thinking=False)
        elif path == "stalled_twice":
            with pytest.raises(ApiError) as err:
                await c.chat(MSG, model="deepseek-flash", thinking=False)
            assert err.value.status == 504
        elif path == "cancelled_in_flight":
            task = asyncio.create_task(c.chat(MSG, model="deepseek-flash", thinking=False))
            await _until(lambda: seen)
            assert _held() == 1
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert (await c.chat(MSG, model="deepseek-flash", thinking=False)).content == "OK"
        await c.aclose()

    asyncio.run(go())
    assert _held() == 0
    assert held_at_backoff == ([0] if path == "transport_then_ok" else [])
    if path == "failover_402":
        assert seen == [A, B]
    assert len(egress.tail(50)) == len(seen)


@pytest.mark.parametrize("limited", [True, False])
def test_a_request_waiting_for_a_full_key_is_not_sent_and_no_limits_sends_at_once(limited, monkeypatch):
    """Contract: at key_concurrency 1 on one key, the second chat waits unsent and unreceipted until the first ends,
    and a third cancelled while waiting leaves nothing behind; with no [limits] both go out together, as before."""
    if limited:
        _limit(monkeypatch, "deepseek", key_concurrency=1)
    gate = asyncio.Event()
    seen: list[str] = []

    async def handler(req):
        seen.append(_key_of(req))
        await gate.wait()
        return _ok()

    async def go():
        c = _chat_client(handler, [A])
        first = asyncio.create_task(c.chat(MSG, model="deepseek-flash", thinking=False))
        second = asyncio.create_task(c.chat(MSG, model="deepseek-flash", thinking=False))
        if limited:
            third = asyncio.create_task(c.chat(MSG, model="deepseek-flash", thinking=False))
            await _until(lambda: len(seen) == 1 and len(keylimits._WAITERS) == 2)
            assert len(egress.tail(50)) == 1
            third.cancel()
            with pytest.raises(asyncio.CancelledError):
                await third
            assert len(keylimits._WAITERS) == 1 and len(seen) == 1
        else:
            await _until(lambda: len(seen) == 2)
            assert not keylimits._SLOTS
        gate.set()
        await asyncio.gather(first, second)
        await c.aclose()

    asyncio.run(go())
    assert seen == [A, A] and len(egress.tail(50)) == 2 and _held() == 0 and not keylimits._WAITERS


def test_a_call_with_another_leg_waits_for_a_full_key_no_longer_than_its_rest_budget(monkeypatch):
    """Contract: a call that could fail over gives up waiting for a full key at its rest budget, unsent, with the 429
    jobs.leg_unavailable moves a task on with; it never queues behind our own limit for as long as the key stays full."""
    _limit(monkeypatch, "deepseek", key_concurrency=1)
    gate = asyncio.Event()
    seen: list[str] = []

    async def handler(req):
        seen.append(_key_of(req))
        await gate.wait()
        return _ok()

    async def go():
        c = _chat_client(handler, [A])
        first = asyncio.create_task(c.chat(MSG, model="deepseek-flash", thinking=False))
        await _until(lambda: seen)
        with pytest.raises(ApiError) as err:
            await asyncio.wait_for(c.chat(MSG, model="deepseek-flash", thinking=False, rest_budget_s=0.05), 5.0)
        assert err.value.status == 429 and seen == [A]
        gate.set()
        await first
        await c.aclose()

    asyncio.run(go())
    assert len(egress.tail(50)) == 1 and _held() == 0 and not keylimits._WAITERS


def test_a_service_call_takes_another_key_while_one_is_full_and_a_named_key_waits_for_it(monkeypatch):
    """Contract: with one key busy at key_concurrency 1, a new client's call goes out on the other at once; a client
    named to the busy key by fingerprint waits unsent until that call ends, then sends on it. Nothing stays held."""
    _limit(monkeypatch, "tavily", key_concurrency=1)
    gate = asyncio.Event()
    seen: list[str] = []

    async def handler(req):
        seen.append(_key_of(req))
        if len(seen) == 1:
            await gate.wait()
        return httpx.Response(200, json={"results": []})

    def client(**kw) -> ServiceClient:
        return ServiceClient("tavily", api_keys=[A, B], transport=httpx.MockTransport(handler), **kw)

    async def go():
        busy = client()
        first = asyncio.create_task(busy.call("search", {"query": "example"}))
        await _until(lambda: seen)
        held, free = seen[0], ({A, B} - {seen[0]}).pop()
        other = client()
        assert await other.call("search", {"query": "example"}) == {"results": []}
        assert seen == [held, free] and other.key_fingerprint == config.fingerprint(free)
        named = client(key_fingerprint=config.fingerprint(held))
        waiting = asyncio.create_task(named.call("search", {"query": "example"}))
        await _until(lambda: len(keylimits._WAITERS) == 1)
        assert len(seen) == 2 and len(egress.tail(50)) == 2
        gate.set()
        await asyncio.gather(first, waiting)
        for c in (busy, other, named):
            await c.aclose()
        return held, free

    held, free = asyncio.run(go())
    assert seen == [held, free, held] and len(egress.tail(50)) == 3 and _held() == 0


def test_fresh_service_clients_do_not_all_start_on_the_same_key():
    """Contract: each `hswarm service` call is its own process with its own pool, and they spread over the keys. Found
    2026-10-07: every fresh pool began its round-robin at the first key, so parallel Tavily searches would all have
    landed on one key of 1,178, whose per-key limit no in-process limiter can see across processes."""
    keys = [f"sk-invented-{i:04d}" for i in range(10)]

    async def one() -> str | None:
        async with ServiceClient("tavily", api_keys=keys,
                                 transport=httpx.MockTransport(lambda req: httpx.Response(200, json={}))) as c:
            await c.call("search", {"query": "example"})
            return c.key_fingerprint

    assert len({asyncio.run(one()) for _ in range(20)}) > 1
