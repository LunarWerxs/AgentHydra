"""Zero data retention (ZDR): which OpenRouter models may receive a task that must not be kept by the provider.

Idea adapted from whirlchat/whirl zeroRetention.ts (MIT); written fresh.

OpenRouter lists the endpoints that keep no prompts at GET /api/v1/endpoints/zdr, and enforces it per request
with `provider: {"zdr": true}` (https://openrouter.ai/docs/guides/features/zdr). `catalogue.refresh_zdr` saves
that list under config.HOME with its timestamp and keeps the last good copy when a refresh fails.

Fails closed: a list that was never read (or cannot be parsed) clears nothing, so a `zdr` task is refused
with a reason instead of being sent anywhere. OpenRouter's automatic router (`openrouter/auto`) is never cleared.
"""
from __future__ import annotations

import json
import time

from . import config

FILE_NAME = "openrouter-zdr.json"
PATH = "/endpoints/zdr"
ROUTER_IDS = {"openrouter/auto"}
PREFERENCE = {"zdr": True}


def cache_file():
    return config.HOME / FILE_NAME


def parse(body: object) -> list[str]:
    """The sorted, de-duplicated lower-case model ids a /endpoints/zdr answer clears; [] when it is not that shape."""
    rows = body.get("data") if isinstance(body, dict) else None
    ids = {str(r.get("model_id")).strip().lower() for r in rows or [] if isinstance(r, dict) and r.get("model_id")}
    return sorted(ids - ROUTER_IDS)


def save(ids: list[str]) -> None:
    path = cache_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"fetched_at": time.time(), "models": ids}), encoding="utf-8")


def load() -> dict:
    """{"fetched_at": epoch seconds | None, "models": set of ids}; empty when never read or unreadable."""
    try:
        doc = json.loads(cache_file().read_text(encoding="utf-8"))
        ids = {str(m).lower() for m in doc["models"]} - ROUTER_IDS
        return {"fetched_at": float(doc["fetched_at"]), "models": ids}
    except (OSError, ValueError, KeyError, TypeError):
        return {"fetched_at": None, "models": set()}


def refusal(model: str) -> str | None:
    """Why `model` may not serve a zdr task, or None when it is cleared."""
    entry = config.MODELS.get(model) or {}
    if entry.get("provider") != "openrouter":
        return f"{model} is not served through OpenRouter, which is the only provider whose zero-retention list is checked"
    api_id = str(entry.get("api_id") or "").lower()
    if api_id in ROUTER_IDS:
        return "OpenRouter's automatic router is never cleared for zero data retention"
    known = load()
    if known["fetched_at"] is None:
        return f"the zero-retention list was never read (run `hswarm models --refresh openrouter`); nothing is cleared, so {model} is refused"
    if api_id not in known["models"]:
        return f"{api_id} is not on OpenRouter's zero-retention list"
    return None


def cleared(model: str) -> bool:
    return refusal(model) is None


def with_preference(body: dict) -> dict:
    """Add the zero-retention preference to a request body, MERGED into any `provider` pin already on it."""
    body["provider"] = {**(body.get("provider") or {}), **PREFERENCE}
    return body
