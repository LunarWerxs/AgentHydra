import asyncio
import itertools

import pytest

from hswarm import config, keylimits
from hswarm.client import NoUsableKey

KEYS = ["sk-invented-a", "sk-invented-b"]


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture(autouse=True)
def fresh_state():
    keylimits._SLOTS.clear()
    keylimits._WAITERS.clear()
    yield
    keylimits._SLOTS.clear()
    keylimits._WAITERS.clear()


def _pick(keys):
    """Stands in for KeyPool.pick: round-robin over the keys not excluded, NoUsableKey when none is left."""
    turn = itertools.count()

    def pick(exclude):
        live = [k for k in keys if k not in exclude]
        if not live:
            raise NoUsableKey("no key left")
        return live[next(turn) % len(live)]

    return pick


def test_two_keys_at_concurrency_one_never_have_more_than_two_in_flight(monkeypatch):
    monkeypatch.setitem(config.PROVIDERS, "limitdemo", {"limits": {"key_concurrency": 1}})
    pick = _pick(KEYS)
    on_key: dict[str, int] = {}
    peak = {"total": 0, "per_key": 0}

    async def request():
        key = await keylimits.acquire("limitdemo", pick)
        on_key[key] = on_key.get(key, 0) + 1
        peak["total"] = max(peak["total"], sum(on_key.values()))
        peak["per_key"] = max(peak["per_key"], on_key[key])
        for _ in range(3):
            await asyncio.sleep(0)
        on_key[key] -= 1
        keylimits.release("limitdemo", key)
        return key

    async def run():
        return await asyncio.gather(*(request() for _ in range(6)))

    served = asyncio.run(run())
    assert len(served) == 6
    assert peak["total"] == 2
    assert peak["per_key"] == 1


def test_release_frees_the_slot_it_took_after_the_limits_table_changes(monkeypatch):
    # The long-lived server re-reads provider files on every call: a [limits] table removed mid-request must not leave
    # its slot held, or the key stays one short (at key_concurrency 1, closed) until a restart.
    monkeypatch.setitem(config.PROVIDERS, "limitdemo", {"limits": {"key_concurrency": 1}})
    pick = _pick(KEYS[:1])

    async def run():
        key = await keylimits.acquire("limitdemo", pick)
        monkeypatch.setitem(config.PROVIDERS, "limitdemo", {})
        keylimits.release("limitdemo", key)
        monkeypatch.setitem(config.PROVIDERS, "limitdemo", {"limits": {"key_concurrency": 1}})
        return await asyncio.wait_for(keylimits.acquire("limitdemo", pick), 1.0)

    assert asyncio.run(run()) == KEYS[0]


def test_a_third_request_on_a_key_at_two_a_minute_waits_for_the_window(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(keylimits, "_clock", clock)
    monkeypatch.setattr(keylimits, "_sleep", clock.sleep)
    monkeypatch.setitem(config.PROVIDERS, "limitrpm", {"limits": {"key_rpm": 2}})
    pick = _pick(KEYS[:1])
    starts: list[float] = []

    async def run():
        for _ in range(3):
            key = await keylimits.acquire("limitrpm", pick)
            starts.append(clock.t)
            keylimits.release("limitrpm", key)

    asyncio.run(run())
    assert starts[:2] == [1000.0, 1000.0]
    assert starts[2] == pytest.approx(1060.0)
