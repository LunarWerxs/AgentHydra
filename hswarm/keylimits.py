"""Per-key request limits from a provider file's [limits] table.

key_concurrency caps the requests in flight on one key; key_rpm caps the requests that may start on one key
in a minute. A request takes a key with headroom and waits, without sending, while every live key is full.
A full key is not rested or disabled: the limit is ours to keep, not the provider's verdict.
"""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from collections.abc import Callable, Collection

from . import config

WINDOW_S = 60.0
_clock = time.monotonic
_sleep = asyncio.sleep


class _Slot:
    __slots__ = ("inflight", "starts")

    def __init__(self) -> None:
        self.inflight = 0
        self.starts: deque[float] = deque()


_SLOTS: dict[tuple[str, str, str], _Slot] = {}  # (provider, key fingerprint, name) -> counts
# (provider, key fingerprint, name as asked) -> the slots its acquires took, so release frees exactly those.
_HELD: dict[tuple[str, str, str], list[tuple[str, str, str]]] = {}
_WAITERS: list[asyncio.Future] = []


def _table(provider: str) -> dict:
    return (config.PROVIDERS.get(provider) or {}).get("limits") or {}


def _name(provider: str, name: str) -> str:
    # A name counts on its own only when the provider states a table for it; otherwise every name shares "".
    return name if name and isinstance(_table(provider).get(name), dict) else ""


def limits_for(provider: str, name: str = "") -> tuple[int | None, int | None]:
    table = _table(provider)
    own = table.get(_name(provider, name)) or {}
    merged = {**{k: v for k, v in table.items() if not isinstance(v, dict)}, **own}
    return merged.get("key_concurrency"), merged.get("key_rpm")


def _until(slot: _Slot, conc: int | None, rpm: int | None, now: float) -> float | None:
    """None when the key can take a request now; else the time it may, or inf when only a finished request frees it."""
    if conc is not None and slot.inflight >= conc:
        return math.inf
    if rpm is not None:
        while slot.starts and now - slot.starts[0] >= WINDOW_S:
            slot.starts.popleft()
        if len(slot.starts) >= rpm:
            return slot.starts[0] + WINDOW_S
    return None


def _wake() -> None:
    for waiter in _WAITERS:
        if not waiter.done():
            waiter.set_result(None)
    _WAITERS.clear()


async def _park(timeout: float | None) -> None:
    waiter = asyncio.get_running_loop().create_future()
    _WAITERS.append(waiter)
    timer = asyncio.ensure_future(_sleep(timeout)) if timeout is not None else None
    try:
        await asyncio.wait({waiter, timer} if timer is not None else {waiter}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        if timer is not None:
            timer.cancel()
        if waiter in _WAITERS:
            _WAITERS.remove(waiter)


async def acquire(provider: str, pick: Callable[[frozenset[str]], str], name: str = "",
                  exclude: Collection[str] = ()) -> str:
    """A key with headroom for one request. `pick(exclude)` is the pool's own choice and raises NoUsableKey when
    no key is left; a full key is skipped, and when every key is full this waits. Pair each call with release()."""
    from .client import NoUsableKey

    asked, name = name, _name(provider, name)
    conc, rpm = limits_for(provider, name)
    skip = frozenset(exclude)
    full: dict[str, float] = {}
    while True:
        try:
            key = pick(skip | frozenset(full))
        except NoUsableKey:
            if not full:
                raise
            soonest = min(full.values())
            await _park(None if soonest == math.inf else max(0.0, soonest - _clock()))
            full.clear()
            continue
        if conc is None and rpm is None:
            return key
        now = _clock()
        fp = config.fingerprint(key)
        slot = _SLOTS.setdefault((provider, fp, name), _Slot())
        until = _until(slot, conc, rpm, now)
        if until is None:
            slot.inflight += 1
            if rpm is not None:
                slot.starts.append(now)
            _HELD.setdefault((provider, fp, asked), []).append((provider, fp, name))
            return key
        full[key] = until


def release(provider: str, key: str, name: str = "") -> None:
    """Frees the slot this key's acquire took, whatever the provider's [limits] say now: the long-lived server re-reads
    its provider files on every call, and a table removed between acquire and release would hold the slot for good."""
    mark = (provider, config.fingerprint(key), name)
    held = _HELD.get(mark)
    if not held:
        return
    slot = _SLOTS.get(held.pop())
    if not held:
        del _HELD[mark]
    if slot is not None and slot.inflight:
        slot.inflight -= 1
    _wake()


def describe(provider: str) -> dict | None:
    """The provider's limits for `hswarm doctor`: None when it states none."""
    table = _table(provider)
    if not table:
        return None
    conc, rpm = limits_for(provider)
    out: dict = {"key_concurrency": conc, "key_rpm": rpm}
    named = sum(1 for v in table.values() if isinstance(v, dict))
    if named:
        out["per_model"] = named
    return out


def keys_at_limit(provider: str, keys: Collection[str]) -> int:
    """How many of these keys are full right now under any of the provider's limits. Counts only, never a key."""
    fingerprints = {config.fingerprint(k) for k in keys}
    now = _clock()
    full: set[str] = set()
    for (p, fp, name), slot in _SLOTS.items():
        if p == provider and fp in fingerprints:
            conc, rpm = limits_for(provider, name)
            if _until(slot, conc, rpm, now) is not None:
                full.add(fp)
    return len(full)
