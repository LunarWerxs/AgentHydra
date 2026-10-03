"""Fault injection: fail a chosen provider call on demand, so every failover path is testable.

WHY: leg failover (jobs.leg_unavailable, route_plan) was only ever proven on the outages that happened to
occur. A fault spec armed here makes ChatClient.chat raise a provider error BEFORE the request is sent -
no spend, no network - so a test or a deliberate drill can fail exactly the Nth call to a leg and watch
the task walk the rest of its route. Idea from the Linux kernel's fault-injection attributes
(probability, interval, times, fail-the-Nth); written fresh for hswarm.

Armed two ways, both process-wide:

- `HSWARM_FAULTS` in the environment: specs separated by `;`, each a comma list of key=value, e.g.
  `HSWARM_FAULTS="provider=groq,nth=2;provider=openrouter,probability=0.3,times=5,status=429"`.
  Re-read whenever the variable's value changes (counters start over then).
- `arm(...)` / `clear()` from a test.

Keys: `provider` (a provider name or `*`, default `*`), `model` (a resolved model name; empty matches any),
`nth` (calls before the Nth matching one never fail; 0 = from the first), `times` (how many calls may fail,
default 1; -1 = no limit), `interval` (only every Kth matching call may fail), `probability` (0..1, default 1),
`seed` (makes probability reproducible), `status` (the HTTP status to fake, default 503 - an unavailable leg;
400 fakes the task's own failure, which must NOT fail over; 504 fakes a stalled read). So `nth=3` alone
fails exactly the third matching call and no other. Only the api backend's calls pass through here: a cc
worker's requests are made by Claude Code, not by this client.
"""
from __future__ import annotations

import os
import random
from dataclasses import dataclass, field

from .usage import ApiError

ENV = "HSWARM_FAULTS"
_INT_KEYS = ("nth", "times", "interval", "status", "seed")


@dataclass
class Fault:
    provider: str = "*"
    model: str = ""
    nth: int = 0
    times: int = 1
    interval: int = 1
    probability: float = 1.0
    seed: int | None = None
    status: int = 503
    calls: int = 0     # matching calls seen so far
    failed: int = 0    # of which this spec failed
    by_code: bool = field(default=False, repr=False)  # armed by arm(), so an env change keeps it
    _rng: random.Random = field(default_factory=random.Random, repr=False)

    def __post_init__(self):
        if not 0.0 <= self.probability <= 1.0:
            raise ValueError(f"{ENV}: probability must be within 0..1, got {self.probability}")
        if self.interval < 1 or self.nth < 0 or self.times < -1:
            raise ValueError(f"{ENV}: interval must be >= 1, nth >= 0 and times >= -1")
        if self.seed is not None:
            self._rng.seed(self.seed)

    def matches(self, provider: str, model: str) -> bool:
        return self.provider in ("*", provider) and self.model in ("", model)

    def fires(self) -> bool:
        """Count one matching call and say whether it fails. Every filter must pass; `times` is spent last."""
        self.calls += 1
        if self.times == 0 or self.calls < self.nth or self.calls % self.interval:
            return False
        if self.probability < 1.0 and self._rng.random() >= self.probability:
            return False
        if self.times > 0:
            self.times -= 1
        self.failed += 1
        return True

    def describe(self) -> dict:
        return {"provider": self.provider, "model": self.model or "*", "nth": self.nth, "times_left": self.times,
                "interval": self.interval, "probability": self.probability, "seed": self.seed, "status": self.status,
                "calls": self.calls, "failed": self.failed}


_ARMED: list[Fault] = []
_ENV_SEEN: str | None = None


def parse(text: str) -> list[Fault]:
    """`provider=groq,nth=2;provider=*,probability=0.5` -> Faults. An unknown key or a bad value is a loud error."""
    out = []
    for chunk in (c.strip() for c in text.split(";")):
        if not chunk:
            continue
        kw: dict = {}
        for pair in (p.strip() for p in chunk.split(",") if p.strip()):
            key, sep, val = pair.partition("=")
            key, val = key.strip(), val.strip()
            if not sep or key not in ("provider", "model", "probability") + _INT_KEYS:
                raise ValueError(f"{ENV}: cannot read {pair!r} (keys: provider, model, nth, times, interval, probability, seed, status)")
            try:
                kw[key] = int(val) if key in _INT_KEYS else float(val) if key == "probability" else val
            except ValueError:
                raise ValueError(f"{ENV}: {key} needs a number, got {val!r}") from None
        out.append(Fault(**kw))
    return out


def _sync_env() -> None:
    global _ENV_SEEN, _ARMED
    text = os.environ.get(ENV, "")
    if text != (_ENV_SEEN or ""):
        # Parse BEFORE marking the value seen: a bad spec must raise on every call until it is fixed, never once and
        # then run silently on the previous specs (the drill would quietly not happen and doctor would show nothing).
        env_faults = parse(text)
        _ENV_SEEN = text
        _ARMED = [f for f in _ARMED if f.by_code] + env_faults


def arm(**kw) -> Fault:
    """Arm one fault from code (tests). Returns it so the caller can read calls/failed afterwards."""
    _sync_env()
    f = Fault(**kw, by_code=True)
    _ARMED.append(f)
    return f


def clear() -> None:
    """Disarm everything, the environment's specs included until the variable changes again."""
    global _ENV_SEEN
    _ARMED.clear()
    _ENV_SEEN = os.environ.get(ENV, "")


def armed() -> list[dict]:
    """What is armed right now, for doctor: a fault left armed on a live machine must never go unnoticed."""
    _sync_env()
    return [f.describe() for f in _ARMED]


def check(provider: str, model: str) -> None:
    """Called before every provider request. Raises the faked ApiError when an armed spec fires. Every matching
    spec counts the call, so two specs on one provider keep independent counts."""
    _sync_env()
    fired = [f for f in _ARMED if f.matches(provider, model) and f.fires()]
    if fired:
        f = fired[0]
        # A 504 body carries "stalled:" so the stall is named on the result exactly as a real read timeout's is.
        why = "stalled: " if f.status == 504 else ""
        raise ApiError(f.status, f"{why}injected fault ({ENV}: call {f.calls} to {provider}/{model})", provider)
