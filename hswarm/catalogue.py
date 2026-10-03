"""`hswarm models`: list what this machine can address, and pull a provider's live catalogue and prices.

OpenRouter fronts ~440 models whose rates change without notice, so hard-coding a price table here would
be inventing a number - the one thing the ledger must never do. Instead `hswarm models --refresh openrouter`
reads the provider's own /models endpoint and writes what it says into config.CATALOGUE_FILE, which reload()
layers UNDER the user's provider files. Until a refresh has run, an `or:<id>` model has no price on
record and its cost reads '-' - except that OpenRouter reports the real charged cost on every call, so a
priced table is a convenience here, not the source of truth.

OpenRouter quotes USD per TOKEN as strings; the registry is USD per 1M tokens, so every figure is scaled
by a million on the way in. `input_cache_read` is the cache-hit rate where the model has one.
"""
from __future__ import annotations

import json

from . import config
from .client import ChatClient

PER_M = 1_000_000.0


def _price(pricing: object) -> dict | None:
    """{hit, miss, out} in USD per 1M tokens, or None when the provider did not quote BOTH sides.

    Both, not either: a half-quoted pair used to fill the missing side with 0.0, which prices unquoted
    output tokens at $0/1M and reads in the ledger as a measured free model. A rate nobody quoted is
    '-' (not measured), never zero - that is the one rule the ledger has. A model quoted as 0 on both
    sides IS free, and zero there is a measurement.
    `input_cache_read` is optional and falls back to the prompt rate, which is what a provider without
    a cache charges for the same tokens - a substitution, not an invention.
    """
    if not isinstance(pricing, dict):
        return None
    def f(key: str) -> float | None:
        try:
            return float(pricing[key]) * PER_M
        except (KeyError, TypeError, ValueError):
            return None
    miss, out = f("prompt"), f("completion")
    if miss is None or out is None:
        return None
    hit = f("input_cache_read")
    return {"hit": miss if hit is None else hit, "miss": miss, "out": out}


def build(models: list[dict], provider: str = "openrouter") -> dict:
    """The overlay document for a provider's live catalogue: one `or:<id>` entry per model it offers."""
    prefix = (config.PROVIDERS[provider].get("passthrough") or ("or:",))[0]
    out: dict = {}
    for m in models:
        mid = str(m.get("id") or "").strip()
        if not mid:
            continue
        entry: dict = {"provider": provider, "api_id": mid, "passthrough": True}
        ctx = m.get("context_length")
        if isinstance(ctx, (int, float)) and ctx:
            entry["ctx"] = int(ctx)
        p = _price(m.get("pricing"))
        if p is not None:
            # The model page's BASE rate. What a call actually bills depends on which of the model's hosts
            # served it (they are priced differently, and DeepSeek's own endpoint keeps its peak/off-peak
            # schedule), so this is a list price for the listing; the ledger records the reported cost.
            entry["price"] = p
        out[f"{prefix}{mid}".lower()] = entry
    return {"_generated_by": f"hswarm models --refresh {provider}", "models": out}


async def refresh(provider: str = "openrouter") -> dict:
    """Pull the provider's catalogue and write it to config.CATALOGUE_FILE. Returns a summary, never a key."""
    if provider not in config.PROVIDERS:
        raise SystemExit(f"hswarm models: unknown provider {provider!r}; known: {sorted(config.PROVIDERS)}")
    if not config.PROVIDERS[provider].get("passthrough"):
        raise SystemExit(f"hswarm models: {provider} has no passthrough catalogue to refresh; add its models under [models.<name>] in {config.user_file(provider)}")
    async with ChatClient(provider=provider) as c:
        body = await c.get_json(config.PROVIDERS[provider]["models_path"])
    rows = [m for m in (body.get("data") or []) if isinstance(m, dict)]
    doc = build(rows, provider)
    config.CATALOGUE_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.CATALOGUE_FILE.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    config.reload()
    priced = sum(1 for e in doc["models"].values() if e.get("price"))
    free = sum(1 for k in doc["models"] if k.endswith(":free"))
    return {"provider": provider, "models": len(doc["models"]), "priced": priced, "unpriced": len(doc["models"]) - priced,
            "free_models": free, "file": str(config.CATALOGUE_FILE),
            "note": f"{len(doc['models'])} {provider} models addressable as 'or:<id>' ({priced} priced, {free} free); "
                    f"a price written in {config.PROVIDERS_DIR} still wins"}


def routes_view() -> dict:
    """Which provider serves each routed model RIGHT NOW, and why. Reads the key pools (no network call)
    so the answer is the one the next task will actually get, not a price table in the abstract."""
    from . import keys as keymod

    when = None
    peak = config.is_peak()
    nxt, after = config.next_rate_change()
    out = []
    for name in sorted(config.ROUTES):
        opts = config.route_options(name, when)
        for o in opts:
            o["has_credit"] = keymod.has_credit(o["provider"])
        chosen = config.cheapest_route(name, when, usable=keymod.has_credit)
        pick = next((o for o in opts if o["model"] == chosen), None)
        cheapest = opts[0] if opts else None
        why = "cheapest with credit"
        if pick and pick["fallback"]:
            why = "fallback: no primary leg has a key with credit"
        elif cheapest and pick and cheapest["model"] != chosen:
            if cheapest["fallback"] and cheapest["has_credit"]:
                why = (f"{cheapest['model']} is cheaper but a FALLBACK (benchmarked slower and weaker on code review, "
                       f"docs/BENCH-2026-09-17.md); "
                       f"`fallback = false` under [models.{cheapest['model']}] in your {config.MODELS[cheapest['model']]['provider']}.toml lets price decide")
            else:
                why = f"cheapest ({cheapest['model']}) has no key with credit"
        elif len(opts) > 1 and cheapest and opts[1]["usd_per_1m"] == cheapest["usd_per_1m"]:
            why = "tie on price, broken by credit and order"
        out.append({"model": name, "serves": chosen, "provider": pick["provider"] if pick else None,
                    "usd_per_1m": round(pick["usd_per_1m"], 4) if pick and pick["usd_per_1m"] is not None else None,
                    "why": why, "options": opts})
    return {
        "enabled": config.PRICE_ROUTING, "rate_now": "peak" if peak else "off-peak",
        "next_change_utc": nxt.isoformat(), "next_state": after,
        "reference_mix": config.REFERENCE_MIX, "routes": out,
        "note": ("price routing is OFF (HSWARM_PRICE_ROUTING=off or `routing = false` in settings.toml): every model is served as named"
                 if not config.PRICE_ROUTING else
                 f"it is {'peak' if peak else 'off-peak'} now, so each model above goes to the path named under `serves`; "
                 f"next rate change {nxt.isoformat()} ({after}). Compared on the measured token mix, not one rate."),
    }


def listing(grep: str | None = None, limit: int = 60) -> dict:
    """Every model this machine can address, with its provider and its price per 1M tokens ('-' when unpriced)."""
    rows = []
    for name in sorted(config.MODELS):
        if grep and grep.lower() not in name.lower():
            continue
        p = config.price(name)
        rows.append({"model": name, "provider": config.MODELS[name].get("provider"),
                     "ctx": config.MODELS[name].get("ctx"),
                     "usd_per_1m": "-" if p is None else {k: round(v, 4) for k, v in p.items()}})
    return {"count": len(rows), "shown": min(len(rows), limit), "models": rows[:limit],
            "aliases": dict(config.ALIASES), "roles": dict(config.ROLES),
            "catalogue": f"{config.CATALOGUE_FILE} ({'present' if config.CATALOGUE_FILE.exists() else 'absent; run `hswarm models --refresh openrouter`'})"}
