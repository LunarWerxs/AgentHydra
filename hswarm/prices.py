"""The one price table, read from data/prices.json (server/src/pricing.ts reads the same file).

Prices are USD per million tokens, written once. A model's cache rates are absolute where the file states
them and derived from its input rate otherwise (read 0.1x, 5-minute write 1.25x, 1-hour write 2x), the same
rule pricing.ts applies. Lookup is exact on the lowercased id with a trailing -YYYYMMDD snapshot date
removed, then on the part after a `provider/` prefix; an id the file does not list is None (never a guess,
never a prefix match: `claude-opus-5-5` once priced as `claude-opus-5`, 81% too high).
"""
from __future__ import annotations

import datetime as dt
import json
import re
from functools import lru_cache
from pathlib import Path

PRICES_FILE = Path(__file__).resolve().parent / "data" / "prices.json"
CACHE_READ_RATIO, CACHE_WRITE_5M_RATIO, CACHE_WRITE_1H_RATIO = 0.1, 1.25, 2.0
_DATE_SUFFIX = re.compile(r"-\d{8}$")


@lru_cache(maxsize=1)
def table() -> dict:
    return json.loads(PRICES_FILE.read_text(encoding="utf-8"))


def models() -> dict[str, dict]:
    return table()["models"]


def as_of() -> str:
    return table()["as_of"]


def _canonical(model: str) -> str:
    return _DATE_SUFFIX.sub("", model.strip().lower())


def entry(model: str) -> tuple[str, dict] | None:
    """(file key, raw entry) for a model id, or None."""
    key = _canonical(model)
    found = models().get(key)
    if found is None and "/" in key:
        key = key.rsplit("/", 1)[1]
        found = models().get(key)
    return None if found is None else (key, found)


def rates(e: dict, when: dt.datetime | None = None) -> dict:
    """Every rate of one raw entry: input, output, cache_read, cache_write_5m, cache_write_1h. `intro` applies
    before its `until` date, as in pricing.ts."""
    inp, out = float(e["input"]), float(e["output"])
    intro = e.get("intro")
    if intro:
        until = dt.datetime.fromisoformat(str(intro["until"]).replace("Z", "+00:00"))
        if until.tzinfo is None:
            until = until.replace(tzinfo=dt.timezone.utc)
        if (when or dt.datetime.now(dt.timezone.utc)) < until:
            inp, out = float(intro["input"]), float(intro["output"])
    pick = lambda name, ratio: float(e[name]) if e.get(name) is not None else inp * ratio  # noqa: E731  (0 is a real rate)
    return {"input": inp, "output": out, "cache_read": pick("cache_read", CACHE_READ_RATIO),
            "cache_write_5m": pick("cache_write_5m", CACHE_WRITE_5M_RATIO), "cache_write_1h": pick("cache_write_1h", CACHE_WRITE_1H_RATIO)}


def price_for(model: str, when: dt.datetime | None = None) -> dict | None:
    """Rates for a model id, or None when the file has no price for it."""
    found = entry(model)
    return None if found is None else rates(found[1], when)


def cost(model: str, t: dict, when: dt.datetime | None = None) -> float | None:
    """USD of the five token buckets (input, cache_read, cache_5m, cache_1h, output); None for an unpriced model."""
    p = price_for(model, when)
    if p is None:
        return None
    return (t.get("input", 0) * p["input"] + t.get("output", 0) * p["output"] + t.get("cache_read", 0) * p["cache_read"]
            + t.get("cache_5m", 0) * p["cache_write_5m"] + t.get("cache_1h", 0) * p["cache_write_1h"]) / 1_000_000


def registry_price(key: str) -> tuple[dict, bool] | None:
    """The file entry `key` (a `models` id, or `provider/model` from `providers`, where a provider's own rates for
    a model live) as the provider registry's `{hit, miss, out, write}`, and whether it halves off-peak (then there
    is no `write`). `write` appears for Anthropic ids (1.25x input) and wherever an entry states a 5-minute write
    rate; any other model pays its input rate for a cache write. None when the file has no such entry."""
    e = models().get(key) or table().get("providers", {}).get(key)
    if e is None:
        return None
    r = rates(e)
    out = {"hit": r["cache_read"], "miss": r["input"], "out": r["output"]}
    if e.get("offpeak"):
        return out, True
    if key.startswith("claude-") or e.get("cache_write_5m") is not None:
        out["write"] = r["cache_write_5m"]
    return out, False


def peak_windows() -> tuple[tuple[int, int], ...]:
    """UTC hour windows (weekdays) at the full rate, for entries with an `offpeak` block; the rest of the time
    those entries cost `multiplier` times."""
    for e in models().values():
        if e.get("offpeak"):
            return tuple((int(a), int(b)) for a, b in e["offpeak"]["utc_hours"])
    return ()
