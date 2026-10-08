"""The keep-current loop for HSwarm's routing: each chat provider's live model list, read by free GETs, compared with the
routes registered here and with the benchmark index (data/published-models.json).

A model a provider starts serving is kept in ~/.hswarm/model-watch.json with a standing: `routed` (a registered route
serves that id), `benchmarked_unrouted` (the index scores it and no route here does: add a route), `unbenchmarked` (no
index point: source its published scores), or `gone` (listed before, not now). Owner, 2026-10-07: a new model is noted as
a potential endpoint for its service, with its rank, its cost and what it is good and bad at.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import math
import re
import time

from . import config, keys, shared
from .selection import evidence

ROUTED, BENCHMARKED, UNBENCHMARKED, GONE = "routed", "benchmarked_unrouted", "unbenchmarked", "gone"
STANDINGS = (ROUTED, BENCHMARKED, UNBENCHMARKED, GONE)
MAX_AGE_S = 24 * 3600
LOOK_EVERY_S = 600
# A provider's own suffixes for a resold copy of a model. "-high" is not one: the index scores reasoning variants apart.
SUFFIXES = ("-tee", "-rl", "-latest", "-instruct")
DATE_STAMP = re.compile(r"-\d{4}$")
# critpt is under review and left out of eligibility (selection.plan), so it is not a benchmark to rank on either.
EXCLUDED = {"critpt"}


def path():
    return config.HOME / "model-watch.json"


def normalize(model_id: str) -> str:
    """The comparable form of a provider's model id: lowercase, its last path segment, dots as dashes, and a resold
    suffix or a date stamp dropped (`Qwen3.8-27B-TEE` -> `qwen3-8-27b`, `DeepSeek-V4-Pro-0813` -> `deepseek-v4-pro`)."""
    s = str(model_id).strip().lower().rsplit("/", 1)[-1].replace(".", "-")
    while True:
        t = DATE_STAMP.sub("", s)
        t = next((t[: -len(x)] for x in SUFFIXES if t.endswith(x) and len(t) > len(x)), t)
        if t == s:
            return s
        s = t


def routed_for(provider: str, models: dict) -> set[str]:
    """The normalized id each registered route of `provider` serves: its `api_id`, else its registry name."""
    out = set()
    for name, entry in models.items():
        if entry.get("provider") == provider:
            raw = entry.get("api_id") or name
            if ":" not in raw:  # a `rank:` route with no api_id of its own serves no id a provider lists
                out.add(normalize(raw))
    return out


def index_slugs(points: list[dict]) -> set[str]:
    return {normalize(p["slug"]) for p in points}


def classify(model_id: str, routed: set[str], slugs: set[str]) -> str:
    n = normalize(model_id)
    if n in routed:
        return ROUTED
    return BENCHMARKED if n in slugs else UNBENCHMARKED


def merge(previous: dict, listed: dict[str, str], now: str) -> dict:
    """The stored table after a scan that listed `listed` (model id -> standing). A model keeps its first_seen; one not
    listed any more is `gone` and keeps its last_seen, so a model that comes back is recognised as one it saw before."""
    out = {}
    for mid, standing in listed.items():
        old = previous.get(mid) or {}
        out[mid] = {"first_seen": old.get("first_seen", now), "last_seen": now, "standing": standing}
    for mid, old in previous.items():
        if mid not in listed:
            out[mid] = {**old, "standing": GONE}
    return out


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def percentile(values: list[float], q: float) -> float:
    xs = sorted(values)
    k = (len(xs) - 1) * q / 100
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def blended(point: dict) -> float | None:
    """Artificial Analysis's blended price, 3 input tokens to 1 output, in USD per 1M tokens."""
    i, o = point.get("input"), point.get("output")
    if not (_num(i) and _num(o)):
        return None
    return round((3 * i + o) / 4, 4)


def profile(points: list[dict]) -> dict[str, dict]:
    """Per index point: the benchmarks it sits above the 75th percentile of the whole index on (strengths), below the
    25th on (weaknesses), and its blended price. A benchmark with fewer than four scores ranks nothing."""
    columns: dict[str, list[float]] = {}
    for p in points:
        for k, v in (p.get("scores") or {}).items():
            if k not in EXCLUDED and _num(v):
                columns.setdefault(k, []).append(float(v))
    bounds = {k: (percentile(vs, 25), percentile(vs, 75)) for k, vs in columns.items() if len(vs) >= 4}
    out = {}
    for p in points:
        strong, weak = [], []
        for k, v in sorted((p.get("scores") or {}).items()):
            if k in bounds and _num(v):
                lo, hi = bounds[k]
                if v > hi:
                    strong.append(k)
                elif v < lo:
                    weak.append(k)
        out[p["slug"]] = {"strengths": strong, "weaknesses": weak, "blended_usd_per_1m": blended(p)}
    return out


def load() -> dict:
    try:
        return json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _epoch(stamp) -> float:
    try:
        return dt.datetime.fromisoformat(stamp).timestamp()
    except (TypeError, ValueError):
        return 0.0


def ids_of(body) -> list[str]:
    """The model ids in a model-list answer: a bare list, or {"data": [...]} (OpenAI's shape)."""
    if isinstance(body, dict):
        rows = body.get("data") or []
    elif isinstance(body, list):
        rows = body
    else:
        rows = []
    ids = []
    for row in rows:
        mid = row.get("id") if isinstance(row, dict) else row
        if isinstance(mid, str) and mid.strip():
            ids.append(mid.strip())
    return list(dict.fromkeys(ids))


def live_providers() -> list[str]:
    return [p for p, spec in config.PROVIDERS.items()
            if config.provider_chat(p) and config.provider_enabled(p) and spec.get("models_path") and keys.has_credit(p)]


async def _list(provider: str) -> list[str]:
    from .client import DeepSeekClient

    client = DeepSeekClient(provider=provider)
    try:
        return [mid for mid in ids_of(await client.get_json(client.spec["models_path"]))
                if config.provider_chat_model(provider, mid)]
    finally:
        await client.aclose()


async def _one(provider: str):
    try:
        return provider, await _list(provider), None
    except Exception as e:  # noqa: BLE001 - one provider failing must not hide the rest
        from . import redaction

        return provider, None, redaction.scrub_keys(f"{type(e).__name__}: {e}")[:200]


def digest(state: dict, only: set[str] | None = None) -> dict:
    """What a scan found, from the stored table (offline): per provider, the new models, the benchmarked-but-unrouted
    models with their strengths, weaknesses and blended price, and the unbenchmarked ones."""
    scanned = state.get("scanned_at")
    points = evidence()["points"]
    by_norm = {normalize(p["slug"]): p["slug"] for p in points}
    profiles = profile(points)
    out = {}
    for provider, rec in sorted((state.get("providers") or {}).items()):
        if only is not None and provider not in only:
            continue
        models = rec.get("models") or {}
        groups: dict[str, list[str]] = {s: [] for s in STANDINGS}
        for mid, row in models.items():
            groups.setdefault(row.get("standing"), []).append(mid)
        unrouted = []
        for mid in sorted(groups[BENCHMARKED]):
            slug = by_norm.get(normalize(mid), "")
            unrouted.append({"id": mid, "slug": slug, **profiles.get(slug, {"strengths": [], "weaknesses": [], "blended_usd_per_1m": None})})
        out[provider] = {
            "error": rec.get("error"),
            "checked_at": rec.get("checked_at"),
            "new": sorted(mid for mid, row in models.items() if row.get("first_seen") == scanned and row.get("standing") != GONE),
            "benchmarked_unrouted": unrouted,
            "unbenchmarked": sorted(groups[UNBENCHMARKED]),
            "routed": len(groups[ROUTED]),
            "gone": len(groups[GONE]),
        }
    return {"scanned_at": scanned, "providers": out}


async def scan(providers: list[str] | None = None) -> dict:
    """One free GET of each live chat provider's model list, in parallel, and the stored table updated. A provider that
    fails keeps its previous table and records its error. Returns this run's digest."""
    now = _now()
    names = list(providers) if providers is not None else live_providers()
    results = await asyncio.gather(*(_one(p) for p in names))
    state = load()
    table = dict(state.get("providers") or {})
    slugs = index_slugs(evidence()["points"])
    for provider, ids, error in results:
        before = (table.get(provider) or {}).get("models") or {}
        if error is None:
            routed = routed_for(provider, config.MODELS)
            models = merge(before, {mid: classify(mid, routed, slugs) for mid in ids}, now)
        else:
            models = before
        table[provider] = {"checked_at": now, "error": error, "models": models}
    state = {"scanned_at": now, "providers": table}
    scored = await _scored(digest(state)["providers"])
    state["scored_unindexed"] = scored[0]
    path().parent.mkdir(parents=True, exist_ok=True)
    shared.atomic_write(path(), json.dumps(state, indent=2, sort_keys=True) + "\n", private=True)
    scanned = {p for p, _, _ in results}
    out = digest(state, scanned)
    out["scored_unindexed"] = [r for r in scored[0] if r["provider"] in scanned]
    out["scored_unindexed_error"] = scored[1]
    return out


async def _scored(providers: dict) -> tuple[list[dict], str | None]:
    """The unbenchmarked models Artificial Analysis scores in full, or none with the reason when its page cannot be read.
    The Artificial Analysis read is extra: the scan's own table stands without it. Owner, 2026-10-07."""
    from . import aa_index

    try:
        return await asyncio.to_thread(aa_index.scored_unindexed, providers), None
    except Exception as e:  # noqa: BLE001 - one unreadable page must not fail the scan
        return [], f"{type(e).__name__}: {e}"[:200]


def summary() -> str:
    """The one line `hswarm doctor` carries: what the stored scan says, and how old it is. No network."""
    state = load()
    if not state.get("scanned_at"):
        return "never scanned; `hswarm models --watch` runs one (free GETs to each chat provider with a live key)"
    rows = digest(state)["providers"]
    bu = sum(len(r["benchmarked_unrouted"]) for r in rows.values())
    ub = sum(len(r["unbenchmarked"]) for r in rows.values())
    secs = time.time() - _epoch(state["scanned_at"])
    age = f"{secs / 3600:.1f} h" if secs < 48 * 3600 else f"{secs / 86400:.1f} days"
    sc = len(state.get("scored_unindexed") or [])
    text = f"last scan {age} ago: {bu} benchmarked but unrouted, {ub} unbenchmarked, {sc} scored by Artificial Analysis and not indexed"
    failing = sorted(p for p, r in rows.items() if r["error"])
    if failing:
        text += f", failing: {', '.join(failing)}"
    return text + "; `hswarm models --watch` rescans"


def render(out: dict) -> str:
    lines = [f"scanned {out['scanned_at']}"]
    for provider, row in out["providers"].items():
        if row["error"]:
            lines.append(f"{provider}: FAILED ({row['error']})")
            continue
        lines.append(f"{provider}: {len(row['new'])} new, {len(row['benchmarked_unrouted'])} benchmarked but unrouted, "
                     f"{len(row['unbenchmarked'])} unbenchmarked")
        if row["new"]:
            lines.append("  new: " + ", ".join(row["new"]))
        for r in row["benchmarked_unrouted"]:
            price = "-" if r["blended_usd_per_1m"] is None else f"${r['blended_usd_per_1m']:.4f}"
            lines.append(f"  benchmarked, no route: {r['id']} (index {r['slug']}, blended {price}/1M) "
                         f"strong: {', '.join(r['strengths']) or '-'}; weak: {', '.join(r['weaknesses']) or '-'}")
        if row["unbenchmarked"]:
            lines.append("  unbenchmarked: " + ", ".join(row["unbenchmarked"]))
    return "\n".join(lines)


_next_look = 0.0
_task: asyncio.Task | None = None


def kick() -> None:
    """Starts one scan in the background when the stored one is over a day old. The MCP server calls this on every tool
    call; it never waits, and a scan already running is not started twice."""
    global _next_look, _task
    now = time.monotonic()
    if now < _next_look or (_task is not None and not _task.done()):
        return
    _next_look = now + LOOK_EVERY_S
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if time.time() - _epoch(load().get("scanned_at")) < MAX_AGE_S:
        return
    _task = loop.create_task(scan())
