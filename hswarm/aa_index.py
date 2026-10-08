"""The benchmark index's keep-current path: Artificial Analysis's per-model scores, read from its model pages.

The index scores ten components per model, and Artificial Analysis publishes them only inside the Next.js payload of
its model pages. One page's payload carries every model AA scores in full, so one GET reads about two hundred models.
Owner, 2026-10-07: a model that appears at a provider we hold keys for is scored and priced when it is noticed, and
the index's numbers are refreshed from the same source, so routing ranks on current evidence instead of a snapshot.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time
from pathlib import Path

import httpx

from . import config, model_watch, shared
from .selection import evidence

AA_HOST = "https://artificialanalysis.ai/"
PAGE = AA_HOST + "models/{slug}"
# Pages whose payloads carry the most fully scored models (checked 2026-10-07): the watch reads these, not one page per id.
HUB_PAGES = ("command-a-plus", "claude-opus-5-5")
# A browser agent: the page answers a bare client with a stub that carries no payload.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
TTL_S = 24 * 3600
INDEX = Path(__file__).resolve().parent / "data" / "published-models.json"
CACHE_NAME = "aa-cache.json"
CHUNK = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', re.S)
# How far back from a benchmark key to look for the object that names its model; a model object is never this large.
WALK_CHARS = 400_000
# The index's component -> the payload path it is read from (owner, 2026-10-07; checked against gpt-6-sol).
COMPONENTS = {
    "aa-briefcase": ("briefcaseBreakdown", "overall", "elo"),
    "gdpval-aa": ("gdpval",),
    "automationbench-aa": ("automationBenchPartialScore",),
    "terminalbench-4-0": ("terminalBench40",),
    "scicode": ("scicode",),
    "humanitys-last-exam": ("hle",),
    "gdp-pdf": ("gdpPdfAllPass",),
    "critpt": ("critpt",),
    "omniscience": ("omniscience",),
    "long-context": ("lcr",),
}
# Elo values drift between reads, so a refresh rewrites every number a point carries from the page.
REFRESHED = ("score", "cost", "input", "output", "release_date", "scores", "score_sources")
SCOPE_COUNT = re.compile(r"^\d+ selected exact configurations; not an exhaustive catalogue\. All \d+ component scores sourced")
REFRESH_NOTE = re.compile(r" Numbers refreshed \d{4}-\d{2}-\d{2} from Artificial Analysis's model pages\.")


def cache_path():
    return config.HOME / CACHE_NAME


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _payload_text(html: str) -> str:
    return "".join(json.loads('"' + c + '"') for c in CHUNK.findall(html))


def _enclosing_model(text: str, at: int, dec: json.JSONDecoder) -> dict | None:
    """The nearest object around `at` that decodes and names its model with `slug`. The benchmark key sits inside a
    nested block of the model, so the walk goes out past blocks that have no slug until it reaches the model."""
    pos = at
    while pos > max(0, at - WALK_CHARS):
        pos = text.rfind("{", 0, pos)
        if pos < 0:
            return None
        try:
            obj, end = dec.raw_decode(text, pos)
        except ValueError:
            continue
        if end > at and isinstance(obj, dict) and "slug" in obj:
            return obj
    return None


def _component(obj: dict, path: tuple[str, ...]):
    for key in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def parse(html: str) -> dict[str, dict]:
    """The index-shaped points in a model page's payload, by slug. A model is kept only when the index's ten components,
    its intelligence score and its cost are all numbers: a partly scored model is not ranked on a guess."""
    text = _payload_text(html)
    dec = json.JSONDecoder()
    out: dict[str, dict] = {}
    for m in re.finditer(re.escape('"terminalBench40"'), text):
        obj = _enclosing_model(text, m.start(), dec)
        if obj is None or not isinstance(obj.get("slug"), str) or obj["slug"] in out:
            continue
        slug = obj["slug"]
        scores = {k: _component(obj, path) for k, path in COMPONENTS.items()}
        score = obj.get("intelligenceIndex")
        cost = _component(obj, ("intelligenceIndexCostPerTask", "cost", "total"))
        if not all(_num(v) for v in (*scores.values(), score, cost)):
            continue
        creator = obj.get("creator")
        url = PAGE.format(slug=slug)
        out[slug] = {
            "slug": slug,
            "name": obj.get("name"),
            "short": obj.get("shortName"),
            "creator": creator.get("name") if isinstance(creator, dict) else creator,
            "score": score,
            "cost": cost,
            "input": obj.get("price1mInputTokens"),
            "output": obj.get("price1mOutputTokens"),
            "source": url,
            "release_date": obj.get("releaseDate"),
            "scores": scores,
            "score_sources": {k: url for k in scores},
        }
    return out


def _read_cache() -> dict:
    try:
        return json.loads(cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def fetch(slug: str) -> dict[str, dict]:
    """The scored points on one model's AA page, by slug, cached for a day. A slug AA does not list caches as none."""
    cache = _read_cache()
    entry = cache.get(slug) or {}
    if entry and time.time() - entry.get("fetched_at", 0) < TTL_S:
        return entry["models"]
    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        resp = client.get(PAGE.format(slug=slug))
    if resp.status_code == 404:
        models = {}
    else:
        resp.raise_for_status()
        models = parse(resp.text)
    cache[slug] = {"fetched_at": time.time(), "models": models}
    shared.atomic_write(cache_path(), json.dumps(cache, indent=1, ensure_ascii=False) + "\n", private=True)
    return models


def point(slug: str) -> dict | None:
    """The scored index point for `slug` from its own AA page, or None when AA does not score it in full."""
    return fetch(slug).get(slug)


def pool() -> dict[str, dict]:
    """The scored points the hub pages carry: one page lists full scores for about two hundred models, so the watch reads
    a few pages instead of one page per unbenchmarked model."""
    out: dict[str, dict] = {}
    for slug in HUB_PAGES:
        for k, p in fetch(slug).items():
            out.setdefault(k, p)
    return out


def _read_index() -> dict:
    return json.loads(INDEX.read_text(encoding="utf-8"))


def _write_index(doc: dict) -> None:
    # The file is committed with CRLF line endings; a round trip through json reproduces it byte for byte.
    INDEX.write_bytes((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").replace("\n", "\r\n").encode("utf-8"))


def _write_scope(doc: dict, tail: str) -> None:
    doc["scope"] = SCOPE_COUNT.sub(
        lambda _: f"{len(doc['points'])} selected exact configurations; not an exhaustive catalogue. "
                  f"All {10 * len(doc['points'])} component scores sourced", doc["scope"], count=1)
    doc["scope"] = REFRESH_NOTE.sub("", doc["scope"]) + tail


def refresh() -> dict:
    """Rewrites every AA-sourced index point from its AA page. A point sourced elsewhere (a vendor's own scores) or
    that AA does not score in full is kept as it is and reported."""
    doc = _read_index()
    hub = pool()
    updated, kept = [], []
    for item in doc["points"]:
        fresh = (hub.get(item["slug"]) or point(item["slug"])) if item["source"].startswith(AA_HOST) else None
        if fresh is None:
            kept.append(item["slug"])
            continue
        for key in REFRESHED:
            item[key] = fresh[key]
        updated.append(item["slug"])
    today = dt.date.today().isoformat()
    doc["as_of_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
    _write_scope(doc, f" Numbers refreshed {today} from Artificial Analysis's model pages.")
    _write_index(doc)
    return {"updated": updated, "kept": kept}


def add(slugs: list[str]) -> dict:
    """Appends each slug's scored point, sourced from its AA page, and records the date in the index's scope."""
    doc = _read_index()
    have = {p["slug"] for p in doc["points"]}
    added, refused = [], {}
    for slug in dict.fromkeys(slugs):
        if slug in have:
            refused[slug] = "already in the index"
            continue
        found = point(slug)
        if found is None:
            refused[slug] = "Artificial Analysis does not score all ten components on its page"
            continue
        doc["points"].append(found)
        have.add(slug)
        added.append(slug)
    if added:
        today = dt.date.today().isoformat()
        _write_scope(doc, f" {', '.join(added)} added {today} from Artificial Analysis's model pages.")
        doc["as_of_utc"] = dt.datetime.now(dt.timezone.utc).isoformat()
        _write_index(doc)
    return {"added": added, "refused": refused}


def scored_unindexed(providers: dict[str, dict]) -> list[dict]:
    """The unbenchmarked models a provider serves that Artificial Analysis scores in full, each with its standing against
    the index and the command that adopts it. `providers` is model_watch.digest()'s per-provider table."""
    points = evidence()["points"]
    indexed = model_watch.index_slugs(points)
    scored = {model_watch.normalize(slug): found for slug, found in pool().items()}
    out = []
    for provider, row in sorted(providers.items()):
        for mid in row.get("unbenchmarked") or []:
            slug = model_watch.normalize(mid)
            found = scored.get(slug)
            if found is None or slug in indexed:
                continue
            prof = model_watch.profile(points + [found])[found["slug"]]
            would_rank = 1 + sum(1 for p in points if _num(p.get("score")) and p["score"] > found["score"])
            out.append({"provider": provider, "id": mid, "slug": found["slug"], "score": found["score"], "cost": found["cost"],
                        "would_rank": would_rank, "of": len(points) + 1, **prof, "adopt": f"hswarm index add {found['slug']}"})
    return out


def render(items: list[dict]) -> list[str]:
    lines = []
    for r in items:
        price = "-" if r["blended_usd_per_1m"] is None else f"${r['blended_usd_per_1m']:.4f}"
        lines.append(f"scored, not indexed: {r['id']} ({r['provider']}, Artificial Analysis {r['slug']}, score {r['score']:.1f}, "
                     f"would rank {r['would_rank']} of {r['of']}, blended {price}/1M) strong: {', '.join(r['strengths']) or '-'}; "
                     f"weak: {', '.join(r['weaknesses']) or '-'}")
        lines.append(f"  {r['adopt']}")
    return lines
