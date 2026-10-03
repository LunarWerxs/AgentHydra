"""Offline: a free tier whose cap is DAILY (Cerebras) gives a spent key back at the reset, not a day after the 402.

Seen 2026-10-02 on Jacob's PC: 416 of 419 Cerebras keys sat in the disabled slot as "out of credit (402)",
parked between 01:15 and 12:19 UTC, and a `hswarm keys probe` that evening found every one of them serving.
They were never out of money: the free tier's tokens for that day were spent. A 402 disables a key with no
date, and probation then lets it out 24 h after the 402, whenever the cap actually came back. A provider whose
file names its daily reset hour now dates that disable, so probation lets the key out at the reset itself.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import client as client_mod  # noqa: E402
from hswarm import config  # noqa: E402
from hswarm.client import ChatClient, KeyPool  # noqa: E402

KEYS = ["csk-test-a", "csk-test-b"]


@pytest.fixture(autouse=True)
def _isolated_key_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys-state.json")


def _ok() -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


def _cerebras(handler) -> ChatClient:
    c = ChatClient(api_keys=KEYS, provider="cerebras")
    c._http = httpx.AsyncClient(base_url="https://cerebras.test", transport=httpx.MockTransport(handler))
    return c


def _next_reset(hour: int, now: float) -> float:
    t = dt.datetime.fromtimestamp(now, dt.timezone.utc)
    reset = t.replace(hour=hour, minute=0, second=0, microsecond=0)
    if reset <= t:
        reset += dt.timedelta(days=1)
    return reset.timestamp()


def test_cerebras_names_its_daily_reset_hour():
    assert isinstance(config.PROVIDERS["cerebras"].get("daily_quota_reset_utc_hour"), int)


def test_a_cerebras_402_comes_back_at_the_daily_reset_not_a_day_later(monkeypatch):
    def handler(req: httpx.Request):
        if req.headers.get("authorization", "").endswith(KEYS[0]):
            return httpx.Response(402, json={"error": {"message": "payment required"}})
        return _ok()

    c = _cerebras(handler)
    before = client_mod.time.time()
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="cerebras-gpt-oss-120b"))
    fp = config.fingerprint(KEYS[0])
    assert c.pool.disabled() == [fp]  # still parked at once: the next request goes round it
    hour = config.PROVIDERS["cerebras"]["daily_quota_reset_utc_hour"]
    until = c.pool._entry(KEYS[0]).get("disabled_until")
    assert until is not None and abs(until - _next_reset(hour, before)) < 5, until
    assert c.pool.probation() == []  # before the reset nothing moves
    monkeypatch.setattr(client_mod.time, "time", lambda: until + 1)
    assert c.pool.probation() == [fp]  # at the reset it is back, without waiting 24 h from the 402
    assert c.pool.available() == 2


def test_a_provider_without_a_daily_reset_keeps_the_undated_disable():
    p = KeyPool(["sk-d"], provider="deepseek")
    assert config.PROVIDERS["deepseek"].get("daily_quota_reset_utc_hour") is None
    c = ChatClient(api_keys=["sk-d"], provider="deepseek")
    assert c._daily_reset_at() is None
    p.broke("sk-d", status=402)
    assert p._entry("sk-d").get("disabled_until") is None
