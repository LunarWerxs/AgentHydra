"""How many calls one provider's key pool gets at once: a ramped, capped gate shared by every job's tasks on it.

Job 20260924-152821-54f1 put 64 tasks (the api default) onto the free Gemini pool in the same second; 60 of
the 61 that finished timed out at 600 s, most without one reply. A backend semaphore sized for "hundreds of
HTTP calls" says nothing about what a free-tier key pool can serve, so the gate sits per PROVIDER, in front of
each leg's run:

- it opens at config.LEG_RAMP_START live tasks and grows by one per successful reply (additive increase),
- it halves when a 429 finds every key in the pool resting (multiplicative decrease),
- it never exceeds the pool's usable keys times its per-key allowance (config.LIVE_PER_KEY, or a provider's
  own `live_per_key`), re-read every time a task asks, so a key disabled mid-job shrinks it.

A task waiting here has not started its own clock (Task.timeout_s wraps the run, not the queue), which is
the point: queued work waits its turn instead of timing out against a pool that could never have served it.

The gate also remembers a TRIP: a last-leg call that waited out config.SATURATED_REST_S while nothing this
process sent to the provider was answered (`served` did not move) found the pool saturated from outside the
job, so the next tasks fail at once instead of each waiting the same two minutes (dispatch.run_selected).

Waiting here is bounded two ways (config.GATE_PATIENCE_S, config.GATE_RECOVER_S). A halved gate with tasks
waiting doubles again once GATE_RECOVER_S pass with no new 429: a reply can take minutes for a tool-using task, so
growing by one per reply left a recovered pool behind a gate of 2 for twenty minutes. And a task given `give_up`
asks it every GATE_PATIENCE_S while it waits; True leaves the queue with GateQueued, for the next leg of its route.
"""
from __future__ import annotations

import asyncio
import time

from . import config


class GateQueued(RuntimeError):
    """The task waited past its patience at a full gate while a later leg of its route had room: it moves there."""


async def wait_for_pilot(warm: asyncio.Event) -> None:
    """Wait for the pilot's first reply, but never past config.PILOT_PATIENCE_S: its cache warm-up saves money on
    DeepSeek, never enough to hold a whole batch behind one slow call."""
    try:
        await asyncio.wait_for(warm.wait(), config.PILOT_PATIENCE_S)
    except TimeoutError:
        pass


class LegGate:
    def __init__(self, provider: str, cap: int, start: int):
        self.provider = provider
        self.cap = max(1, int(cap))
        self.limit = max(1, min(int(start), self.cap))
        self.live = 0
        self.waiting = 0
        self.saturations = 0  # times a 429 found every key resting and the limit was halved
        self.served = 0  # replies this process got from the provider: the proof that the pool is serving anyone
        self._trip: tuple[float, str] | None = None  # (monotonic end, why) while the pool is known saturated
        self._calm_since = time.monotonic()  # the last 429 halving, or the last time the gate grew back
        self._peak = self.limit  # the widest the gate has been: what a recovery may grow back to, never past
        self._cond: asyncio.Condition | None = None

    def _condition(self) -> asyncio.Condition:
        # Built on first use so the gate binds to the loop that uses it (tests run one loop per asyncio.run).
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    def _full(self) -> bool:
        return self.live >= self.limit

    async def acquire(self, give_up=None) -> None:
        """Wait for a live slot. Every config.GATE_RECOVER_S (and GATE_PATIENCE_S) of waiting, a calm halved gate
        grows back, and `give_up()` (when given) is asked whether to leave the queue for a better leg."""
        cond = self._condition()
        self.waiting += 1
        start = time.monotonic()
        try:
            async with cond:
                while self._full():
                    try:
                        await asyncio.wait_for(cond.wait(), min(config.GATE_RECOVER_S, config.GATE_PATIENCE_S))
                    except TimeoutError:
                        pass
                    if self.recover():
                        cond.notify_all()
                    if (self._full() and give_up is not None
                            and time.monotonic() - start >= config.GATE_PATIENCE_S and give_up()):
                        raise GateQueued(f"waited {time.monotonic() - start:.0f}s at the full {self.provider} gate "
                                         f"({self.live} live of {self.limit}) while a later leg had room")
                self.live += 1
        finally:
            self.waiting -= 1

    def recover(self, now: float | None = None) -> bool:
        """Double a limit that 429s halved, back toward the widest it had been (never past it or the cap: a gate still
        ramping grows only by its replies), once GATE_RECOVER_S passed with no 429 while tasks wait. True if it grew."""
        now = time.monotonic() if now is None else now
        ceiling = min(self.cap, self._peak)
        if not (self.waiting and self.limit < ceiling and now - self._calm_since >= config.GATE_RECOVER_S):
            return False
        self.limit = min(ceiling, self.limit * 2)
        self._calm_since = now
        return True

    def room(self) -> bool:
        """Whether a task sent here now would start at once rather than queue."""
        return self.live < self.limit and not self.tripped()

    async def release(self) -> None:
        cond = self._condition()
        async with cond:
            self.live = max(0, self.live - 1)
            cond.notify_all()

    async def __aenter__(self) -> "LegGate":
        await self.acquire()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.release()

    def _wake(self) -> None:
        cond = self._cond
        if cond is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        async def notify() -> None:
            async with cond:
                cond.notify_all()

        loop.create_task(notify())

    def ok(self) -> None:
        """A reply came back: one more live call is allowed, up to the cap, and any trip is over."""
        self.served += 1
        self._trip = None
        if self.limit < self.cap:
            self.limit += 1
            self._peak = max(self._peak, self.limit)
            self._wake()

    def saturated(self) -> None:
        """A 429 found every key resting: halve the live calls allowed (never below one)."""
        self.saturations += 1
        self.limit = max(1, self.limit // 2)
        self._calm_since = time.monotonic()

    def set_cap(self, cap: int) -> None:
        cap = max(1, int(cap))
        grew = cap > self.cap
        self.cap = cap
        self.limit = min(self.limit, cap)
        if grew:
            self._wake()

    def trip(self, why: str, seconds: float) -> None:
        self._trip = (time.monotonic() + seconds, why)

    def tripped(self) -> str | None:
        """Why the provider is known saturated right now, or None once the trip has run out (the next task probes)."""
        if self._trip is None or time.monotonic() >= self._trip[0]:
            self._trip = None
            return None
        return self._trip[1]

    def snapshot(self) -> dict:
        snap = {"provider": self.provider, "limit": self.limit, "cap": self.cap, "live": self.live, "waiting": self.waiting,
                "saturations": self.saturations, "served": self.served}
        if why := self.tripped():
            snap["tripped"] = why
        return snap
