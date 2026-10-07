"""The one writer for what hswarm runs on: keys, key and model priority numbers, provider and model switches,
custom providers and models, roles and the routing knobs. The console (`hswarm ui`), the CLI (`hswarm keys
add|remove`) and the HTTP API all call these, so every fact has one owner:

- a provider's settings, its models and their switches live in <home>/providers/<name>.toml, layered over the
  shipped one. Keys added through the console, CLI or API live in <home>/secrets/ and use the shared encrypted
  vault when configured. Legacy TOML keys are still read, and move to secrets/ on the next key edit.
- environment keys remain read-only; provider key lists in secrets/ can be added to and removed from here.
- roles, the review panel and the routing knobs live in <home>/settings.toml (config.SETTINGS_FILE).

Each change is one read-change-write of one file under a lock file beside it, through tomlkit, so a person's own
comments and layout survive. A long-lived server picks the change up through config.refresh(); this process reloads
at once. A key is never returned or logged: a row carries its fingerprint and a masked form (first 3, last 4).
"""
from __future__ import annotations

import re
from pathlib import Path

import tomlkit
from tomlkit.exceptions import TOMLKitError

from . import config
from .shared import atomic_write

NAME_RX = config.NAME_RX


class SettingsError(ValueError):
    """A change that cannot be made as asked; the message says what to do instead."""


def _rank(value) -> int | None:
    """A priority number from the console or the CLI: 1 is used first. Empty, 0 or None clears it."""
    if value in (None, "", 0, "0"):
        return None
    try:
        n = int(value) if not isinstance(value, bool) else -1
    except (TypeError, ValueError):
        n = -1
    if not 1 <= n <= 999:
        raise SettingsError("a priority is a whole number from 1 (used first) to 999; clear it to remove it")
    return n


def _locked(path: Path):
    """Hold <path>.lock across one read-change-write: the console and `hswarm keys add` in a shell must not each
    build on the file as it was and lose the other's change."""
    from .client import file_lock

    return file_lock(path.with_name(path.name + ".lock"))


def _read(path: Path) -> tomlkit.TOMLDocument:
    """The file as it stands. One that is there but is not valid TOML stops the change: building on an empty
    document would write back a file holding only this one change and erase every setting and key in it."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return tomlkit.document()
    except OSError as e:
        raise SettingsError(f"{path} could not be read ({e}); nothing was changed") from e
    try:
        return tomlkit.parse(text)
    except TOMLKitError as e:
        raise SettingsError(f"{path} is not valid TOML ({e}); fix it by hand, nothing was changed") from e


def _header(provider: str | None) -> str:
    if provider is None:
        return "# hswarm settings: roles, the review panel and price routing (docs/PROVIDERS.md).\n\n"
    return (f"# Your settings for {provider}, layered over the ones hswarm ships (docs/PROVIDERS.md).\n"
            "# API keys are managed in secrets/ and synced through the encrypted vault when configured.\n\n")


def _change(path: Path, change, provider: str | None) -> None:
    """One locked read-change-write of a user file, then a reload so this process sees it at once."""
    with _locked(path):
        new = not path.exists()
        doc = _read(path)
        change(doc)
        text = tomlkit.dumps(doc)
        atomic_write(path, (_header(provider) if new else "") + text, private=True)
    config.reload()


def _in_provider(provider: str, change) -> None:
    _change(config.user_file(provider), change, provider)


def _in_settings(change) -> None:
    _change(config.SETTINGS_FILE, change, None)


def _model_table(doc, name: str):
    """The [models.<name>] table of a user file, made when missing."""
    models = doc.get("models")
    if models is None:
        models = doc["models"] = tomlkit.table(is_super_table=True)
    if name not in models:
        models[name] = tomlkit.table()
    return models[name]


def _prune_model(doc, name: str) -> None:
    models = doc.get("models")
    if models is not None and name in models and not len(models[name]):
        del models[name]
    if models is not None and not len(models):
        del doc["models"]


def mask(key: str) -> str:
    return f"{key[:3]}…{key[-4:]}" if len(key) > 12 else "…"


def _provider(name: str) -> dict:
    if name not in config.PROVIDERS:
        raise SettingsError(f"unknown provider {name!r}; known: {', '.join(sorted(config.PROVIDERS))}")
    return config.PROVIDERS[name]


def _key_files(provider: str) -> list[str]:
    """Editable provider lists only: a configured filename is never accepted as an arbitrary path."""
    from . import vault

    files = [name for name in _provider(provider).get("key_files", ()) if vault.LIST_RX.fullmatch(name)]
    return list(dict.fromkeys(files or [vault.list_file(provider)]))


def _editable_sources(provider: str) -> set[str]:
    return {config.user_source(provider), *(f"<home>/secrets/{name}" for name in _key_files(provider))}


def key_rows(provider: str) -> list[dict]:
    """Every key the provider's pool would use, in pool order, with where it comes from and its live state.
    Listed even when the provider is switched off, so the switch can be turned back on knowingly."""
    from .client import KeyPool, key_tier

    _provider(provider)
    editable = _editable_sources(provider)
    rows, seen = [], {}
    for source, read in config.key_sources(provider):
        for k in read():
            if k and k not in seen:
                row = {"key": k, "fingerprint": config.fingerprint(k), "masked": mask(k), "source": source,
                       "editable": source in editable}
                seen[k] = row
                rows.append(row)
            elif k and source in editable:
                seen[k].update(source=source, editable=True)
    if rows:
        state = {r["fingerprint"]: r for r in KeyPool([r["key"] for r in rows], provider).status(reload=False)}
        tiers = config.PROVIDERS[provider].get("key_priority") or {}
        for r in rows:
            s = state.get(r["fingerprint"], {})
            r.update(state=s.get("state", "ok"), disabled=bool(s.get("disabled")), reason=s.get("disabled_reason"),
                     resting_s=s.get("resting_s", 0), free_only=bool(s.get("free_only")), priority=tiers.get(r["fingerprint"]))
    for i, r in enumerate(rows):
        r.pop("key")
        r["position"] = i
    # The order the pool reaches for them (client.key_tier): numbered tiers first, then the rest, each in file order.
    return sorted(rows, key=lambda r: (key_tier(provider, r["fingerprint"]), r["position"]))


def _find(provider: str, fingerprint: str) -> str:
    editable = _editable_sources(provider)
    hits, other = set(), None
    for source, read in config.key_sources(provider):
        for k in read():
            if config.fingerprint(k) == fingerprint:
                if source in editable:
                    hits.add(k)
                else:
                    other = source
    if len(hits) > 1:
        raise SettingsError(f"several {provider} keys share fingerprint {fingerprint!r}; edit their files directly")
    if hits:
        return hits.pop()
    if other:
        raise SettingsError(f"that key comes from {other}; change it there (hswarm edits provider key lists and legacy provider keys)")
    raise SettingsError(f"no {provider} key has fingerprint {fingerprint!r}")


def split_keys(text: str) -> list[str]:
    """Several pasted keys -> the keys, in order and once each: one per line, or split by spaces, commas or semicolons."""
    return list(dict.fromkeys(k for k in re.split(r"[\s,;]+", text or "") if k))


def _edit_provider_keys(provider: str, *, add: str | None = None, remove: str | None = None, reload_config: bool = True) -> dict:
    """Keep keys in syncable lists, and retire a legacy TOML keys field without changing its settings."""
    from . import vault

    names = _key_files(provider)
    path = config.user_file(provider)

    def change():
        with _locked(path):
            doc = _read(path)
            raw = doc.get("keys") or ()
            raw = [raw] if isinstance(raw, str) else raw
            if not isinstance(raw, (list, tuple, tomlkit.items.Array)) or any(not isinstance(k, str) for k in raw):
                raise SettingsError(f"{path} has an invalid keys field; nothing was changed")
            legacy = list(dict.fromkeys(k.strip() for k in raw if k.strip()))
            # Read every affected list before writing any of them; unreadable input is never treated as empty.
            held = {}
            retired = [name + suffix for name in names if not name.endswith((".dead", ".unfunded"))
                       for suffix in (".dead", ".unfunded")]
            for name in names + (retired if add else []):
                try:
                    held[name] = vault._keys_in(config.SECRETS_DIR / name)
                except FileNotFoundError:
                    held[name] = []
            target = _find(provider, remove) if remove else None
            existed = add in config.all_keys(provider) if add else False
            into = [k for k in legacy if k != target]
            if add:
                into.append(add)
            drop = {vault.key_id(target)} if target else set()
            changed_doc = "keys" in doc
            if changed_doc:
                del doc["keys"]
            if target:
                elsewhere = any(k == target for source, read in config.key_sources(provider)
                                if source not in _editable_sources(provider) for k in read())
                if not elsewhere:
                    before = tomlkit.dumps(doc)
                    _key_rank(doc, remove, None)
                    changed_doc = changed_doc or tomlkit.dumps(doc) != before
            for name in names:
                vault._rewrite(config.SECRETS_DIR / name, drop, into if name == names[0] else [])
            if add:
                # An explicit addition is newer evidence that this key is alive.
                for name in retired:
                    vault._rewrite(config.SECRETS_DIR / name, {vault.key_id(add)}, [])
            if changed_doc:
                atomic_write(path, tomlkit.dumps(doc), private=True)
        if reload_config:
            config.reload()
        if add:
            out = {"fingerprint": config.fingerprint(add), "added": not existed, "masked": mask(add),
                   "file": str(config.SECRETS_DIR / names[0])}
            if existed:
                out["note"] = "already in the pool"
            return out
        return {"fingerprint": remove, "removed": True}

    return vault.mutate_local(change, allow_removals=bool(remove))


def add_key(provider: str, key: str, *, _reload: bool = True) -> dict:
    key = (key or "").strip()
    if not key or any(c.isspace() for c in key) or len(key) < 8:
        raise SettingsError("a key is one unbroken string of at least 8 characters")
    _provider(provider)
    return _edit_provider_keys(provider, add=key, reload_config=_reload)


def _key_rank(doc, fingerprint: str, rank: int | None) -> None:
    tiers = doc.get("key_priority")
    if rank is not None:
        if tiers is None:
            tiers = doc["key_priority"] = tomlkit.inline_table()
        tiers[fingerprint] = rank
    elif tiers is not None:
        tiers.pop(fingerprint, None)
        if not len(tiers):
            del doc["key_priority"]


def remove_key(provider: str, fingerprint: str, *, _reload: bool = True) -> dict:
    _provider(provider)
    return _edit_provider_keys(provider, remove=fingerprint, reload_config=_reload)


def set_key_priority(provider: str, fingerprint: str, priority) -> dict:
    """Give a key a priority number (1 is used first) or clear it. Keys sharing a number take turns (round-robin);
    a higher number is reached only when every key above it is resting, disabled or out of credit; keys with no
    number come last. Any key can be numbered, wherever it is stored: the number is kept by fingerprint."""
    _provider(provider)
    rank = _rank(priority)
    if not any(config.fingerprint(k) == fingerprint for k in config.all_keys(provider)):
        raise SettingsError(f"no {provider} key has fingerprint {fingerprint!r}")
    _in_provider(provider, lambda doc: _key_rank(doc, fingerprint, rank))
    return snapshot()


def set_key_enabled(provider: str, fingerprint: str, enabled: bool) -> dict:
    """In or out of the disabled slot (client.KeyPool): a key switched off is kept but never handed to a worker."""
    from .client import KeyPool

    _provider(provider)
    keys = config.all_keys(provider)
    target = next((k for k in keys if config.fingerprint(k) == fingerprint), None)
    if target is None:
        raise SettingsError(f"no {provider} key has fingerprint {fingerprint!r}")
    pool = KeyPool(keys, provider)
    pool.enable(target) if enabled else pool.disable(target, reason="switched off in settings")
    return {"fingerprint": fingerprint, "enabled": enabled}


def set_provider(name: str, *, enabled: bool | None = None, base_url: str | None = None, website: str | None = None) -> dict:
    """website: the company's site, whose favicon the console shows; "" goes back to the shipped one (or none)."""
    _provider(name)
    if base_url is not None and not re.match(r"^https?://", base_url.strip()):
        raise SettingsError("base_url must start with http:// or https://")
    if website and not re.match(r"^https?://\S+$", website.strip()):
        raise SettingsError("the website is an address starting with http:// or https://")

    def change(doc):
        if enabled is not None:
            doc.pop("enabled", None) if enabled else doc.__setitem__("enabled", False)
        if base_url is not None:
            doc["base_url"] = base_url.strip().rstrip("/")
        if website is not None:
            doc.pop("website", None) if not website.strip() else doc.__setitem__("website", website.strip())
    _in_provider(name, change)
    return snapshot()


def add_provider(name: str, base_url: str, *, docs: str = "", anthropic_url: str = "", website: str = "") -> dict:
    """A new OpenAI-compatible endpoint, as its own file; keys go in secrets/ or <NAME>_API_KEY(S) in the env."""
    name = (name or "").strip().lower()
    if not NAME_RX.match(name):
        raise SettingsError("a provider name is lowercase letters, digits, '.', '_' or '-'")
    if name in config.PROVIDERS:
        raise SettingsError(f"{name} already exists; change it instead")
    if not re.match(r"^https?://", (base_url or "").strip()):
        raise SettingsError("base_url must start with http:// or https:// (the part before /chat/completions)")
    if website and not re.match(r"^https?://\S+$", website.strip()):
        raise SettingsError("the website is an address starting with http:// or https://")

    def change(doc):
        doc["base_url"] = base_url.strip().rstrip("/")
        if website:
            doc["website"] = website.strip()
        doc["options"] = ["reasoning_effort"]
        doc["models_path"] = "/models"
        doc["balance_authority"] = "status"
        if docs:
            doc["docs"] = docs.strip()
        if anthropic_url:
            doc["anthropic_url"] = anthropic_url.strip().rstrip("/")
            doc["anthropic_auth"] = "bearer"
    _in_provider(name, change)
    return snapshot()


def remove_provider(name: str) -> dict:
    """Remove a custom provider's settings and models; shared key lists remain in the vault."""
    if name in config.BUILTIN_PROVIDERS:
        raise SettingsError(f"{name} is built in; switch it off instead")
    if not NAME_RX.match(name or "") or name not in config.PROVIDERS:
        raise SettingsError(f"no custom provider {name!r}")
    path = config.user_file(name)
    if not path.exists():
        raise SettingsError(f"no custom provider {name!r}")
    gone = {m for m, s in config.MODELS.items() if s.get("provider") == name}
    with _locked(path):
        path.unlink()
    _unwire(gone)
    config.reload()
    return snapshot()


def _unwire(names: set) -> None:
    """Point any role wired to a removed model back at AUTO, or every task with that role would fail on an unknown
    model. Its star and switch went with its table."""
    roles = config.ROLES
    if not any(isinstance(m, str) and m in names for m in roles.values()):
        return

    def change(doc):
        table = doc.get("roles")
        for role, model in list((table or {}).items()):
            if isinstance(model, str) and model.strip().lower() in names:
                table[role] = config.AUTO
    _in_settings(change)


def _model(name: str) -> str:
    n = (name or "").strip().lower()
    n = config.ALIASES.get(n, n)
    if n not in config.MODELS:
        raise SettingsError(f"unknown model {name!r}")
    return n


def _model_switch(name: str, field: str, value) -> dict:
    """Set or clear one switch (`enabled`, `priority`) on a model, in its provider's user file."""
    n = _model(name)

    def change(doc):
        t = _model_table(doc, n)
        t.pop(field, None) if value is None else t.__setitem__(field, value)
        _prune_model(doc, n)
    _in_provider(config.MODELS[n]["provider"], change)
    return snapshot()


def set_model(name: str, enabled: bool) -> dict:
    return _model_switch(name, "enabled", None if enabled else False)


def set_model_priority(name: str, priority) -> dict:
    """Star a model with a priority number (1 first) or clear it. AUTO tries numbered models first, lowest number
    first, among the ones that meet the task's bar; models sharing a number are ordered by cost."""
    return _model_switch(name, "priority", _rank(priority))


def add_model(name: str, provider: str, api_id: str = "", *, ctx: int = 131_072, price: dict | None = None,
              vision: bool = False, tools: bool = True) -> dict:
    name = (name or "").strip().lower()
    if not NAME_RX.match(name):
        raise SettingsError("a model name is lowercase letters, digits, '.', '_' or '-'")
    if name in config.BUILTIN_MODELS or name in config.ALIASES:
        raise SettingsError(f"{name} is built in; pick another name")
    _provider(provider)
    if (owner := config.MODELS.get(name, {}).get("provider")) and owner != provider:
        raise SettingsError(f"{owner} already has a model called {name}; pick another name")

    def change(doc):
        t = _model_table(doc, name)
        t["api_id"] = (api_id or name).strip()
        t["ctx"] = int(ctx or 131_072)
        t["tools"] = bool(tools)
        if vision:
            t["vision"] = True
        if price and any(price.get(k) not in (None, "") for k in ("hit", "miss", "out")):
            rates = tomlkit.inline_table()
            rates.update({k: float(price.get(k) or 0) for k in ("hit", "miss", "out")})
            t["price"] = rates
    _in_provider(provider, change)
    return snapshot()


def remove_model(name: str) -> dict:
    n = (name or "").strip().lower()
    if n not in config.MODELS or n in config.BUILTIN_MODELS:
        raise SettingsError(f"{n} is not a model you added; switch it off instead")

    def change(doc):
        models = doc.get("models")
        if models is None or n not in models:
            raise SettingsError(f"{n} is not in {config.user_file(config.MODELS[n]['provider'])}; remove it there")
        del models[n]
        _prune_model(doc, n)
    _in_provider(config.MODELS[n]["provider"], change)
    _unwire({n})
    return snapshot()


def set_role(role: str, model: str | None) -> dict:
    r = (role or "").strip().lower()
    if r not in config.ROLES:
        raise SettingsError(f"unknown role {role!r}; known: {', '.join(sorted(config.ROLES))}")
    value = config.AUTO if not model or model.strip().lower() == config.AUTO else _model(model)

    def change(doc):
        table = doc.get("roles")
        if table is None:
            table = doc["roles"] = tomlkit.table()
        table[r] = value
    _in_settings(change)
    return snapshot()


def set_options(*, routing: bool | None = None, load_bias: float | None = None, daily_cap_usd=None, route_via_climayte: bool | None = None,
                route_via_climayte_max: int | None = None, route_via_climayte_start_s: float | None = None) -> dict:
    """daily_cap_usd: a positive number of dollars, or "" / 0 to remove the cap; None leaves it as it is.
    route_via_climayte is a local opt-out ANDed with AgentHydra's own routing switch; _max (0 or more) caps the tasks
    in CliMayte at once, _start_s (above 0) is how long a worker may wait to start before the task takes its API route."""
    if route_via_climayte_max is not None and (isinstance(route_via_climayte_max, bool) or not isinstance(route_via_climayte_max, int) or not 0 <= route_via_climayte_max <= 1000):
        raise SettingsError("route_via_climayte_max is a whole number from 0 to 1000")
    if route_via_climayte_start_s is not None and (isinstance(route_via_climayte_start_s, bool) or not isinstance(route_via_climayte_start_s, (int, float)) or not 0 < route_via_climayte_start_s <= 3600):
        raise SettingsError("route_via_climayte_start_s is a number of seconds above 0, up to 3600")
    if load_bias is not None and (not isinstance(load_bias, (int, float)) or load_bias < 0 or load_bias > 5):
        raise SettingsError("load_bias is a number from 0 (off) to 5")
    cap = None
    if daily_cap_usd not in (None, "", 0, "0"):
        try:
            cap = float(daily_cap_usd)
        except (TypeError, ValueError):
            cap = -1.0
        if not 0 < cap < 1_000_000:
            raise SettingsError("the daily cap is a number of dollars above 0; clear it to remove the cap")

    def change(doc):
        if routing is not None:
            doc["routing"] = bool(routing)
        if route_via_climayte is not None:
            doc["route_via_climayte"] = bool(route_via_climayte)
        if route_via_climayte_max is not None:
            doc["route_via_climayte_max"] = route_via_climayte_max
        if route_via_climayte_start_s is not None:
            doc["route_via_climayte_start_s"] = float(route_via_climayte_start_s)
        if load_bias is not None:
            doc["load_bias"] = float(load_bias)
        if cap is not None:
            doc["daily_cap_usd"] = cap
        elif daily_cap_usd is not None:
            doc.pop("daily_cap_usd", None)
    _in_settings(change)
    return snapshot()


def _provider_row(name: str, p: dict, state: dict | None = None) -> dict:
    from .client import KeyPool

    from collections import Counter

    from . import favicons

    keys = config.all_keys(name)
    rows = KeyPool(keys, name, state=state).status(reload=False) if keys else []
    states = [r["state"] for r in rows]
    why = Counter(r.get("disabled_reason") or "disabled" for r in rows if r.get("disabled"))
    icon, icon_v = favicons.state(name)
    return {
        "website": p.get("website") or "", "icon": icon, "icon_v": icon_v,
        "disabled_why": [{"reason": r, "keys": n} for r, n in why.most_common(4)],
        "name": name, "builtin": name in config.BUILTIN_PROVIDERS, "enabled": config.provider_enabled(name),
        "base_url": p.get("base_url"), "docs": p.get("docs"), "about": p.get("about") or "", "key_url": p.get("key_url") or "",
        "transport": p.get("transport", "openai"), "capabilities": list(p.get("capabilities") or ()),
        "operations": sorted(p.get("operations") or {}),
        "free_tier": bool(p.get("free_tier")), "keys": len(rows),
        "ready": states.count("ok"), "resting": states.count("resting"), "disabled": sum(1 for r in rows if r["disabled"]),
        "prioritized_keys": len(p.get("key_priority") or {}),
        "key_env": list(p.get("key_env") or ()), "file": str(config.user_file(name)),
        "cc": bool(p.get("anthropic_url")), "passthrough": list(p.get("passthrough") or ()),
        "models": sum(1 for m in config.MODELS.values() if m.get("provider") == name and not m.get("passthrough")),
    }


def _model_row(name: str, m: dict, labels: dict, bench: dict) -> dict:
    """labels: the published configuration name of every model AUTO can rank ("Claude Opus 5.5 (high)"), which a
    person reads more easily than its registry name ("rank:claude-opus-5-5-high"); bench: its published score and
    the benchmark's cost to run it, which the console plots against each other."""
    score, cost = bench.get(name, (None, None))
    return {
        "name": name, "label": labels.get(name) or name, "score": score, "bench_cost_usd": cost, "provider": m["provider"], "api_id": m.get("api_id") or name,
        "enabled": name not in config.DISABLED_MODELS and config.provider_enabled(m["provider"]),
        "switched_off": name in config.DISABLED_MODELS, "custom": name not in config.BUILTIN_MODELS, "auto": name in labels,
        "fallback": bool(m.get("fallback")), "vision": bool(m.get("vision")),
        "tools": bool(m.get("tools", name not in labels)), "ctx": m.get("ctx"),
        "price": config.price(name), "usd_per_1m": config.blended_price(name), "priority": config.PRIORITY.get(name),
        "inherits": m.get("inherits"), "effort": m.get("default_reasoning_effort"), "kind": m.get("kind") or "chat",
    }


def snapshot() -> dict:
    """Everything the console shows, in one read: no network call, no key."""
    from . import __version__
    from .selection import auto_models, evidence

    by_slug = {p["slug"]: p for p in evidence()["points"]}
    auto = auto_models()
    labels = {n: by_slug.get(m["benchmark_slug"], {}).get("name", n) for n, m in auto}
    bench = {n: (by_slug[m["benchmark_slug"]].get("score"), by_slug[m["benchmark_slug"]].get("cost"))
             for n, m in auto if m["benchmark_slug"] in by_slug}
    listed = [(n, m) for n, m in sorted(config.MODELS.items()) if not m.get("passthrough") and m.get("provider") in config.PROVIDERS]
    from .client import read_key_state

    state = read_key_state()  # once for every provider row, not twice per provider
    return {
        "version": __version__, "home": str(config.HOME), "providers_dir": str(config.PROVIDERS_DIR),
        "settings_file": str(config.SETTINGS_FILE),
        "providers": [_provider_row(n, p, state) for n, p in config.PROVIDERS.items()],
        "models": [_model_row(n, m, labels, bench) for n, m in listed],
        "priority": dict(config.PRIORITY), "disabled_models": sorted(config.DISABLED_MODELS),
        "roles": dict(sorted(config.ROLES.items())),
        "options": {"routing": config.PRICE_ROUTING, "route_via_climayte": config.ROUTE_VIA_CLIMAYTE, "route_via_climayte_max": config.ROUTE_VIA_CLIMAYTE_MAX,
                    "route_via_climayte_start_s": config.ROUTE_VIA_CLIMAYTE_START_S, "load_bias": config.LOAD_BIAS, "daily_cap_usd": config.DAILY_CAP_USD,
                    "concurrency": config.DEFAULT_CONCURRENCY, "max_concurrency": config.MAX_CONCURRENCY},
    }
