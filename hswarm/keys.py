"""The key-pool report and the disabled slot: `hswarm keys`, `keys probe`, `keys enable`, `keys disable`.

One row per key per provider, fingerprints only - a key is never returned, printed or logged. The four
verbs are the whole surface an operator needs when a key runs out:

  hswarm keys                      what every pool looks like right now (no network call)
  hswarm keys probe                one FREE GET per key; a topped-up key comes back out of the slot here
  hswarm keys enable <fp>|--all    take a key out of the slot by hand
  hswarm keys disable <fp>         put one in by hand (a key you want to stop using without deleting)

Why the slot exists (owner ask, Michael, 2026-09-17): "when any key runs out of DeepSeek or OpenRouter,
have it go to, like, a disabled slot so it's not constantly retried." Disabling is sticky - no timer, no
ladder - so a spent key never costs another worker to rediscover. The way back is a free probe or one of
the verbs above.
"""
from __future__ import annotations

import time

import httpx

from . import config, keylimits
from .client import ChatClient, KeyPool


_POOLS: dict[tuple[str, str], tuple[float, tuple[str, ...], "KeyPool | None"]] = {}
POOL_RECHECK_S = 5.0  # how often pool_for re-reads the KEY LIST, matching the pool's own state recheck


def pool_for(provider: str) -> "KeyPool | None":
    """That provider's key pool, cached; None when the machine has no key for it. A KeyPool, not a
    client, so asking costs no socket.

    The cache RE-READS the key list every POOL_RECHECK_S and rebuilds when it changed. That is not
    belt-and-braces: the MCP server holds one process for a whole Claude session, and a cache that
    read the keys once meant a provider with no key file at startup was cached as None and stayed
    unusable for the rest of the session - so dropping in `~/.hswarm/secrets/openrouter_api_keys` while a
    session was running did nothing until a restart (found in review, 2026-09-17, the same day that
    file was created mid-session). Key DISABLES were already picked up, because the pool re-reads the
    shared state file itself; only the key list was frozen. The cache is keyed by the state-file path
    too, so a test that redirects ~/.hswarm invalidates it instead of inheriting another test's pool.
    """
    ck = (provider, str(config.KEYS_STATE))
    now = time.monotonic()
    cached = _POOLS.get(ck)
    if cached is not None and now - cached[0] < POOL_RECHECK_S:
        return cached[2]
    keys = tuple(config.load_api_keys(provider))
    if cached is not None and cached[1] == keys:
        _POOLS[ck] = (now, keys, cached[2])  # unchanged: keep the pool, and with it its round-robin cursor
        return cached[2]
    pool = KeyPool(list(keys), provider) if keys else None
    _POOLS[ck] = (now, keys, pool)
    return pool


def has_credit(provider: str) -> bool:
    """Can this provider take a request right now: a key that is neither disabled nor resting. This is
    what breaks a price tie between two paths to the same model, and it is the half that matters on a
    day when most of one provider's keys are out of credit."""
    pool = pool_for(provider)
    return bool(pool and pool.available())


def _providers(only: str | None = None) -> list[str]:
    """Every provider that has at least one key on this machine, or just the one asked for."""
    if only:
        if only not in config.PROVIDERS:
            raise SystemExit(f"hswarm keys: unknown provider {only!r}; known: {sorted(config.PROVIDERS)}")
        return [only]
    return [p for p in config.PROVIDERS if config.load_api_keys(p)]


# Rows a bounded report keeps per provider: every key that is NOT plainly ok (disabled, resting,
# broke, free-only) up to this many, so the answer to "why is the pool short" is in the reply while
# 1,700 healthy rows are not. Measured 2026-09-20: the unbounded MCP reply was 900,045 characters
# across 31,928 lines, which the client refused to show and the caller could not read either way.
BOUNDED_ROWS_PER_PROVIDER = 40


def report(only: str | None = None, *, verbose: bool = True, counts_only: bool = False) -> dict:
    """Offline: what the shared state file says about every pool. No network call, so it is safe to run
    while two hundred workers are in flight. `verbose=False` keeps every count and only the rows that
    are not plainly ok (capped per provider, with `rows_omitted` saying how many were left out).
    `counts_only=True` keeps the counts and no rows at all: the doctor's default, where even the bounded
    rows were 74,801 of its 82,669 characters (2026-10-06, mostly disabled keys)."""
    out: dict = {"providers": {}}
    for name in _providers(only):
        keys = config.load_api_keys(name)
        if not keys:
            out["providers"][name] = {"keys": 0, "note": config.no_key_message(name)}
            continue
        # KeyPool, not ChatClient: this report is offline, and building a client would open an httpx
        # AsyncClient (512 connections) that a sync function can never aclose - one leaked per provider
        # per call, and an MCP server serving hswarm_keys calls it all day.
        rows = KeyPool(keys, name).status()
        entry = {
            "keys": len(rows), "base_url": config.PROVIDERS[name].get("base_url"),
            "balance_authority": config.PROVIDERS[name].get("balance_authority") or "reading",
            "ok": sum(1 for r in rows if r["state"] == "ok"),
            "resting": sum(1 for r in rows if r["state"] == "resting"),
            "disabled": sum(1 for r in rows if r["disabled"]),
            "free_only": sum(1 for r in rows if r["free_only"]),
        }
        entry["limits"] = keylimits.describe(name)
        if entry["limits"]:
            entry["keys_at_limit"] = keylimits.keys_at_limit(name, keys)
        if counts_only:
            pass  # the counts above are the whole entry
        elif verbose:
            entry["rows"] = rows
        else:
            attention = [r for r in rows if r["state"] != "ok" or r["disabled"] or r.get("broke")]
            entry["rows"] = attention[:BOUNDED_ROWS_PER_PROVIDER]
            entry["rows_omitted"] = len(rows) - len(entry["rows"])
        out["providers"][name] = entry
    out["note"] = _note(out)
    if counts_only:
        out["note"] += " Counts only: hswarm_keys lists the keys needing attention (verbose=true there prints every row)."
    elif not verbose:
        out["note"] += " Bounded report: only keys needing attention are listed; verbose=true (or `hswarm keys`) prints every row."
    return out


def _note(out: dict) -> str:
    live = sum(p.get("ok", 0) for p in out["providers"].values())
    off = sum(p.get("disabled", 0) for p in out["providers"].values())
    free = sum(p.get("free_only", 0) for p in out["providers"].values())
    tail = f"; {free} of the disabled still serve ':free' models" if free else ""
    if not off:
        return f"{live} keys ready, none disabled{tail}"
    return (f"{live} keys ready, {off} in the disabled slot{tail}. They are never retried with a real request: "
            f"run `hswarm keys probe` after a top-up, or `hswarm keys enable <fingerprint>`")


async def probe(only: str | None = None) -> dict:
    """One FREE GET of the balance endpoint per key. A key that reads as topped up comes back out of the
    disabled slot here; for a provider whose number is not authority (OpenRouter) the reading is reported
    and nothing is disabled by it. Providers with no balance endpoint use their free credential check instead;
    accepting a credential never proves its account is funded, so credit and manual disables remain."""
    out: dict = {"providers": {}}
    for name in _providers(only):
        keys = config.load_api_keys(name)
        if not keys:
            continue
        spec = config.PROVIDERS[name]
        if not config.provider_chat(name) or not spec.get("balance_path"):
            out["providers"][name] = await _check_each(name, keys)
            continue
        async with ChatClient(api_keys=keys, provider=name) as c:
            before = set(c.pool.disabled())
            try:
                rows = await c.balances()
            except Exception as e:  # noqa: BLE001 - one provider down must not hide the rest
                out["providers"][name] = {"error": f"{type(e).__name__}: {e}"[:200]}
                continue
            after = set(c.pool.disabled())
            out["providers"][name] = {
                "keys": len(rows), "usable": sum(1 for r in rows if r.get("usable") is not False),
                "disabled_now": sorted(after - before), "recovered": sorted(before - after),
                "still_disabled": sorted(after), "rows": rows,
            }
    moved = [f"{p}: +{len(v.get('disabled_now') or [])} disabled, {len(v.get('recovered') or [])} recovered"
             for p, v in out["providers"].items() if v.get("disabled_now") or v.get("recovered")]
    out["note"] = "; ".join(moved) or "probed every key; nothing moved in or out of the disabled slot"
    return out


async def _check_each(name: str, keys: list[str], width: int = 16) -> dict:
    """Check credentials independently of credit, without starting a service generation operation."""
    import asyncio

    before = set(KeyPool(keys, name).disabled())
    sem = asyncio.Semaphore(width)

    async def one(k: str) -> dict:
        async with sem:
            return await check(name, config.fingerprint(k))

    rows = await asyncio.gather(*(one(k) for k in keys))
    after = set(KeyPool(keys, name).disabled())
    count = lambda result: sum(1 for r in rows if r.get("result") == result)  # noqa: E731
    usable = sum(1 for row in KeyPool(keys, name).status() if row["state"] == "ok")
    return {"keys": len(rows), "credential_valid": count("ok"), "usable": usable,
            "rejected": count("rejected"), "unchecked": count("unchecked"),
            "disabled_now": sorted(after - before), "recovered": sorted(before - after), "still_disabled": sorted(after),
            "rows": rows}


async def check(provider: str, fingerprint: str) -> dict:
    """Does the provider accept this one key? One FREE request (its model list, or its balance when it has no list)
    sent with that key alone. A key the provider refuses (401/403) goes to the disabled slot with the reason, and one
    it accepts comes back out if an earlier check had put it there, so "ready" in the console means the provider took
    the key, not only that it was saved. Never returns the key."""
    from .usage import ApiError

    key = next((k for k in config.all_keys(provider) if config.fingerprint(k) == fingerprint), None)
    if key is None:
        raise ValueError(f"no {provider} key has fingerprint {fingerprint!r}")
    spec = config.PROVIDERS[provider]
    # An endpoint that needs the key: OpenRouter's model list answers anyone, so a dead key would pass it.
    path = spec.get("check_path") or spec.get("balance_path") or (None if spec.get("models_public") else spec.get("models_path"))
    model_check = bool(config.provider_chat(provider) and spec.get("check_model") and spec.get("check_model_free"))
    service = not config.provider_chat(provider)
    out = {"provider": provider, "fingerprint": fingerprint}
    if not path and not model_check:
        return {**out, "result": "unchecked", "note": f"{provider} has no configured free authenticated key check; the key is saved, credit remains unverified"}
    pool = KeyPool([key], provider)
    try:
        if model_check:
            await _check_by_model(provider, spec, key)
        else:
            await _check_by_get(provider, spec, key, path)
    except ApiError as e:
        if _is_rejection(e, service):
            pool.disable(key, reason=f"{provider} rejected this key (HTTP {e.status})", status=e.status)
            return {**out, "result": "rejected", "status": e.status,
                    "note": f"{provider} rejected this key (HTTP {e.status}): check it was copied whole, or make a new one"}
        return {**out, "result": "unchecked", "status": e.status, "note": f"{provider} answered HTTP {e.status}, so the key could not be checked now"}
    except httpx.HTTPError as e:
        return {**out, "result": "unchecked", "note": f"could not reach {provider} ({type(e).__name__})"}
    _enable_if_rejected_before(pool, key, fingerprint)
    return {**out, "result": "ok", "note": f"{provider} accepted this credential; paid credit was not checked"}


async def _check_by_model(provider: str, spec: dict, key: str) -> None:
    from .usage import ApiError

    async with ChatClient(api_keys=[key], provider=provider) as c:
        # A one-token chat on a free model: OpenRouter's /key answered 200 for keys whose account was deleted
        # (70 such keys were put back on 2026-09-26 and every one failed its first real call).
        r = await c._http.post("/chat/completions", headers=c._auth(key),
                               json={"model": spec["check_model"], "messages": [{"role": "user", "content": "ok"}], "max_tokens": 1})
        if not r.is_success:
            raise ApiError(r.status_code, r.text, provider)


async def _check_by_get(provider: str, spec: dict, key: str, path: str) -> None:
    from .provider_auth import request_headers
    from .usage import ApiError

    headers = request_headers(spec, key)
    if spec.get("transport") == "anthropic":
        from . import anthropic_native

        headers = {**(spec.get("headers") or {}), "x-api-key": key, "anthropic-version": anthropic_native.VERSION}
        headers.pop("Authorization", None)
    async with httpx.AsyncClient(base_url=spec["base_url"], timeout=30, follow_redirects=False) as client:
        response = await client.get(path, headers=headers)
    if not response.is_success:
        raise ApiError(response.status_code, response.text, provider)


def _is_rejection(e, service: bool) -> bool:
    """A refusal of the key itself. A service 403 can mean the key lacks permission for this endpoint, rather than
    being invalid."""
    return e.status == 401 or (not service and e.status == 403) or (e.status == 400 and "api key" in (e.body or "").lower())


def _enable_if_rejected_before(pool: KeyPool, key: str, fingerprint: str) -> None:
    """Take an accepted key out of the slot when an earlier check (not a credit failure) put it there."""
    row = next((r for r in pool.status() if r.get("fingerprint") == fingerprint), {})
    reason = str(row.get("disabled_reason") or "").lower()
    if row.get("disabled") and pool._entry(key).get("disabled_status") in (400, 401, 403) and ("rejected this key" in reason or "revoked" in reason):
        pool.enable(key)


def set_enabled(fingerprint: str | None, enabled: bool, only: str | None = None, all_keys: bool = False, reason: str = "disabled by hand") -> dict:
    """Move a key in or out of the disabled slot by fingerprint (the only form a human ever sees).
    `all_keys` with enabled=True empties the slot across every provider asked for."""
    out: dict = {"providers": {}, "changed": 0}
    for name in _providers(only):
        keys = config.load_api_keys(name)
        if not keys:
            continue
        pool = KeyPool(keys, name)  # offline: no HTTP client to open and leak
        if all_keys and enabled:
            n = pool.enable_all()
            out["providers"][name] = {"enabled": n}
            out["changed"] += n
            continue
        target = next((k for k in pool.keys if config.fingerprint(k) == fingerprint or k == fingerprint), None)
        if target is None:
            continue
        if enabled:
            pool.enable(target)
        else:
            pool.disable(target, reason=reason)
        out["providers"][name] = {"fingerprint": config.fingerprint(target), "enabled": enabled}
        out["changed"] += 1
    if not out["changed"]:
        out["note"] = (f"no key matched {fingerprint!r}" if not all_keys else "nothing in the disabled slot") + "; `hswarm keys` lists the fingerprints"
    else:
        out["note"] = f"{out['changed']} key(s) {'enabled' if enabled else 'disabled'}"
    return out
