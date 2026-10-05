"""Which Claude ACCOUNT did a piece of work, and what that account's plan costs per day - with no
name and no email anywhere (owner ask, Michael, 2026-09-17: "maybe each account should have a unique
identifier somehow, like a hash number ... I reuse the numbers, like 17 and 13, and sometimes they
get cycled out").

An account is identified by `acct-<8 hex>`, the first 8 hex of sha256 over Anthropic's own account
uuid. That uuid never changes and never repeats, so the id is stable across machines and across every
renaming or renumbering of the instance folder it happens to live in; the email and the display name
behind it are read to find the uuid and then thrown away - they are never stored and never rendered.

The chain, all of it optional and all of it read-only:
  a transcript's session id -> AgentHydra's `session_stats.instance` (the instance folder that ran it)
  -> `instances-cache.json` (that folder's account uuid, plan and rate-limit tier) -> the hashed id.
A machine with no AgentHydra resolves nothing, and every such session is "unattributed": that is "not
measured", never a guess.

Plan cost: each tier's list price per month, charged per DAY and only on the days that account actually
did work (owner ask, same message: cost the accounts that were used, not every account that is open).
AgentHydra's own plan prices (Routing page, GET /api/routing/cost-model) win over those list prices when it answers;
the table below is only the offline fallback. ~/.hswarm/plan.json overrides anything here, either per tier or as one flat monthly figure:
  {"tier_usd_month": {"max_20x": 200}, "usd_month": null}
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.request
from pathlib import Path, PureWindowsPath

from . import config

HYDRA = Path(os.environ.get("HSWARM_AGENTHYDRA") or (Path.home() / ".agenthydra"))
DAYS_PER_MONTH = 365.25 / 12  # a plan is billed monthly; a day of it is this slice

# Anthropic's list prices per month, checked 2026-09-17. A tier with no price is not costed ('-', never zero).
TIER_USD_MONTH = {"max_20x": 200.0, "max_5x": 100.0, "pro": 20.0, "team": 30.0, "free": 0.0}
TIER_LABEL = {"max_20x": "Max 20x", "max_5x": "Max 5x", "pro": "Pro", "team": "Team", "free": "Free", "": "unknown plan"}
UNATTRIBUTED = "unattributed"


def plan_config() -> dict:
    """~/.hswarm/plan.json, the owner's override; {} when there is none."""
    try:
        doc = json.loads((config.HOME / "plan.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


_AH_TIER = {"Pro": "pro", "Max 5×": "max_5x", "Max 20×": "max_20x"}  # AgentHydra's plan names -> our tiers
_AH_TTL_S = 300.0
_AH_TIMEOUT_S = 2.0
_ah_cache: tuple[float, dict[str, float]] | None = None


def _agenthydra_prices() -> dict[str, float]:
    """The owner's plan prices from AgentHydra (planPrices on /api/routing/cost-model), per tier; {} when it does not
    answer within 2 s. Cached for a few minutes, a miss too, so an offline machine pays the timeout once per window."""
    global _ah_cache
    if _ah_cache and time.monotonic() - _ah_cache[0] < _AH_TTL_S:
        return _ah_cache[1]
    out: dict[str, float] = {}
    base = os.environ.get("AGENTHYDRA_URL", "http://127.0.0.1:7787").rstrip("/")
    if base:
        try:
            with urllib.request.urlopen(f"{base}/api/routing/cost-model", timeout=_AH_TIMEOUT_S) as r:
                doc = json.loads(r.read().decode("utf-8"))
            plans = (doc.get("settings") or {}).get("planPrices") or {}
            out = {tier: float(plans[name]) for name, tier in _AH_TIER.items() if isinstance(plans.get(name), (int, float)) and plans[name] >= 0}
        except Exception:  # offline, slow, or an unexpected answer: the built-in table stands
            out = {}
    _ah_cache = (time.monotonic(), out)
    return out


def tier_prices() -> dict[str, float]:
    base = TIER_USD_MONTH | _agenthydra_prices()
    over = plan_config().get("tier_usd_month")
    return base | {k: float(v) for k, v in over.items() if isinstance(v, (int, float))} if isinstance(over, dict) else base


def tier_usd_month(tier: str) -> float | None:
    return tier_prices().get(tier or "")


def tier_usd_day(tier: str) -> float | None:
    v = tier_usd_month(tier)
    return None if v is None else v / DAYS_PER_MONTH


def account_id(uuid: str) -> str:
    """The stable public id of an account: a hash of its uuid, so nothing identifying travels or renders."""
    return "acct-" + hashlib.sha256((uuid or "").encode("utf-8")).hexdigest()[:8]


_TIER_RX = re.compile(r"max[_-]?(\d+)x")


def tier_of(entry: dict) -> str:
    """max_20x | max_5x | pro | team | free | "" - from AgentHydra's rateLimitTier, then its plan/orgType."""
    raw = str(entry.get("rateLimitTier") or "").lower()
    m = _TIER_RX.search(raw)
    if m:
        return f"max_{m.group(1)}x"
    plan = str(entry.get("plan") or "").lower()
    org = str(entry.get("orgType") or "").lower()
    if "enterprise" in raw or "enterprise" in org:
        return ""  # Enterprise has no published price: unknown, and an unknown tier is never costed
    if "team" in raw or "team" in org:
        return "team"
    if "pro" in plan or "pro" in org:
        return "pro"
    if "free" in plan or "free" in org:
        return "free"
    if "max" in plan:  # a Max account whose rate-limit tier was never read: the cheaper Max, never the dearer one
        return "max_5x"
    return ""


def _read_json(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


_SHOWN_TIER_RX = re.compile(r"max\s*(\d+)\s*[x×]", re.I)


def _shown_tier(account: str) -> str:
    """The tier AgentHydra prints beside an account ("... - Max 20x" / "Max 5x" / "Pro"); "" when it names none.
    The name and the email in that same string are read past and never kept."""
    m = _SHOWN_TIER_RX.search(account or "")
    if m:
        return f"max_{m.group(1)}x"
    tail = (account or "").rsplit("·", 1)[-1].strip().lower()
    return {"pro": "pro", "team": "team", "free": "free"}.get(tail, "")


def _folder_name(path: str) -> str:
    """The last folder of an AgentHydra path, lowercased. Its caches hold Windows paths, which Path on Linux or macOS
    reads as one long name; PureWindowsPath splits on both slashes, so a POSIX path reads right as well."""
    return PureWindowsPath(path).name.strip().lower()


def _cached_tiers() -> dict[str, str]:
    """instance folder (lowercased) -> the tier AgentHydra last displayed for it. Used only where the account's
    rate-limit tier does not say, which is exactly where a personal org reads as `claude_free` but pays for Max."""
    out: dict[str, str] = {}
    for key, entry in _read_json(HYDRA / "data" / "usage-cache.json").items():
        if not isinstance(entry, dict) or not str(key).startswith("desktop:"):
            continue
        tier = _shown_tier(str(entry.get("account") or ""))
        if tier:
            out[_folder_name(str(key)[len("desktop:"):])] = tier
    return out


def instances() -> dict[str, dict]:
    """instance folder name (lowercased) -> {"account", "tier"}. The uuid is hashed here and never leaves."""
    shown = _cached_tiers()
    out: dict[str, dict] = {}
    plain: list[tuple[str, dict]] = []
    for path, entry in sorted(_read_json(HYDRA / "instances-cache.json").items()):
        if not isinstance(entry, dict) or not entry.get("uuid"):
            continue
        label = _folder_name(str(path))
        if not label:
            continue
        row = {"account": account_id(str(entry["uuid"])), "tier": better_tier(tier_of(entry), shown.get(label, ""))}
        out[label] = row
        if ".claude-instances" not in str(path).replace("/", "\\").lower():
            plain.append((str(path).replace("/", "\\").lower(), row))
    if plain:  # caller.py stamps a session outside an instance folder as "default": that is the plain install
        preferred = next((r for p, r in plain if p.endswith(r"appdata\roaming\claude")), plain[0][1])
        out.setdefault("default", preferred)
    return out


def better_tier(a: str, b: str) -> str:
    """Of two readings for the SAME account, the one that costs more. Two instance folders can point at one
    account and read its plan differently (a personal org says `claude_free` while the account pays for Max);
    taking the dearer reading keeps the plan cost from being quietly understated."""
    if not a:
        return b
    if not b:
        return a
    prices = tier_prices()
    return a if (prices.get(a) or 0.0) >= (prices.get(b) or 0.0) else b


def _hydra_db() -> Path:
    return HYDRA / "data" / "agenthydra.db"


def session_instances() -> dict[str, str]:
    """session id -> the instance folder that ran it, from AgentHydra's own session scan. {} when it has none."""
    db = _hydra_db()
    if not db.exists():
        return {}
    try:
        c = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return {}
    try:
        rows = c.execute("SELECT session_id, instance FROM session_stats WHERE instance IS NOT NULL AND session_id IS NOT NULL").fetchall()
    except sqlite3.Error:
        return {}
    finally:
        c.close()
    return {str(s): str(i).strip().lower() for s, i in rows if s and i}


_CACHE: dict = {"at": 0.0, "value": None}
CACHE_S = 300.0  # every job records a utilization; re-reading AgentHydra's session table each time is pointless


def resolver(fresh: bool = False) -> dict:
    """Everything needed to attribute sessions in one read: {"by_session", "by_instance", "accounts"}.
    Cached for CACHE_S, because a job record asks for it and jobs come in bursts."""
    import time

    now = time.monotonic()
    if not fresh and _CACHE["value"] is not None and now - _CACHE["at"] < CACHE_S:
        return _CACHE["value"]
    by_instance = instances()
    tiers: dict[str, str] = {}
    for i in by_instance.values():  # one account behind two folders: keep the dearer reading, not the last one
        tiers[i["account"]] = better_tier(tiers.get(i["account"], ""), i["tier"])
    value = {"by_session": session_instances(), "by_instance": by_instance, "accounts": tiers}
    _CACHE.update(at=now, value=value)
    return value


def of_instance(label: str, res: dict | None = None) -> dict | None:
    """The account behind an instance folder name, or None when nothing knows it."""
    res = res if res is not None else resolver()
    return res["by_instance"].get((label or "").strip().lower())


def of_session(session_id: str, res: dict | None = None) -> dict | None:
    """The account behind a session id, or None when nothing knows it."""
    res = res if res is not None else resolver()
    label = res["by_session"].get(session_id or "")
    return res["by_instance"].get(label) if label else None


def attribute(by_session: dict, res: dict | None = None) -> dict[str, dict]:
    """One day's per-session usage folded onto accounts.

    `by_session` is {session id: {"usd", "requests", "tokens"{...}}} as the scanners emit it. Returns
    {account id: {"tier", "usd", "requests", "sessions", "tokens"{...}}}, with everything unresolved
    summed under `unattributed` so the page can say how much of the day it could not place."""
    res = res if res is not None else resolver()
    out: dict[str, dict] = {}
    for sid, u in (by_session or {}).items():
        if not isinstance(u, dict):
            continue
        acct = of_session(sid, res)
        key = acct["account"] if acct else UNATTRIBUTED
        row = out.setdefault(key, {"tier": "", "usd": 0.0, "requests": 0, "sessions": 0,
                                   "tokens": {k: 0 for k in ("input", "cache_read", "cache_5m", "cache_1h", "output")}})
        if acct:  # two folders can point at one account and read its plan differently: keep the dearer reading
            row["tier"] = better_tier(row["tier"], acct["tier"])
        row["usd"] += float(u.get("usd") or 0.0)
        row["requests"] += int(u.get("requests") or 0)
        row["sessions"] += 1
        for k, v in (u.get("tokens") or {}).items():
            if k in row["tokens"]:
                row["tokens"][k] += int(v or 0)
    for row in out.values():
        row["usd"] = round(row["usd"], 4)
    return out


def day_plan_usd(accounts: dict[str, dict]) -> float | None:
    """What the accounts that worked on one day cost that day: each one's plan price / days in a month.

    A flat `usd_month` in plan.json overrides the sum (a machine with no AgentHydra can still say what it
    pays). None when nothing is known: not measured, never zero."""
    if not accounts:  # nothing ran that day: nothing to charge, and nothing measured either
        return None
    flat = plan_config().get("usd_month")
    if isinstance(flat, (int, float)) and flat >= 0:
        return round(float(flat) / DAYS_PER_MONTH, 6)
    prices = tier_prices()
    total, known = 0.0, False
    for acct, row in (accounts or {}).items():
        if acct == UNATTRIBUTED:
            continue
        price = prices.get(row.get("tier") or "")
        if price is None:
            continue
        known = True
        total += price / DAYS_PER_MONTH
    return round(total, 6) if known else None


def label_of(tier: str) -> str:
    return TIER_LABEL.get(tier or "", tier or "unknown plan")
