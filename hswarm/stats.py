"""Stats from HSwarm's utilization DB, served to the console.

When HSWARM_STATS_DB is set, reads that database (read-only) instead of HSwarm's own, reported as ZSwarm history:
it was for reading ZSwarm's production database while ZSwarm ran. ZSwarm is retired (2026-10-03) and
`hswarm import-zswarm` merged its stats into HSwarm's own DB, so the daemon no longer sets it; a person's own
value is still honoured.
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import time
from pathlib import Path

from . import report_html, utilization

CACHE_TTL = 120.0  # seconds; a live call costs 3-5 s and the web polls it
_cache: dict[tuple[str, int], tuple[float, dict]] = {}


def stats(days: int = 30) -> dict:
    """Stats from the utilization DB (ZSwarm or HSwarm), in the shape the web console consumes.

    Returns {source, generated, empty, total, plan_rates, plan, by_machine, days, claude_by_family,
    accounts, rule_check, recent, today}. A non-empty answer is kept CACHE_TTL seconds per `days` value.
    """
    days = max(1, min(days, 90))
    db_path = _db_path()
    if not db_path or not db_path.exists():
        return _empty()

    key = (str(db_path), days)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]

    answer = _read(db_path, days)
    if not answer["empty"]:
        _cache[key] = (time.monotonic(), answer)
    return answer


def _read(db_path: Path, days: int) -> dict:
    c = _connect(db_path)
    try:
        total = utilization.totals(c)
        if not total or not total.get("n", 0) > 0:
            return _empty()

        rates = utilization.plan_rates(c)
        per_day = report_html.per_day(c, rates)
        mine = utilization.claude_day_rows(c, utilization.MACHINE)
        latest = mine[0] if mine else None
        # The stored check, as the report shows it: recomputing would read this home's routing log, not the DB's.
        rule_check = {**latest["rules"], "day": latest["day"], "partial": bool(latest.get("partial"))} if latest and latest.get("rules") else None
        recent_rows = utilization.recent(c, 50)

        return {
            "source": _source(),
            "generated": _now(),
            "empty": False,
            "total": total,
            "plan_rates": rates,
            "plan": utilization.plan_view(total, rates),
            "by_machine": [report_html.weigh_row(m, rates) for m in utilization.by_machine(c)],
            "days": list(reversed(per_day[:days])),  # both sources are newest first; the answer is oldest first
            "claude_by_family": list(reversed(report_html.claude_by_family(c, rates)[:days])),
            "accounts": report_html.account_view(c),
            "rule_check": rule_check,
            "recent": recent_rows,
            "today": _today_data(per_day),
        }
    finally:
        c.close()


def _source() -> str:
    return "zswarm" if os.environ.get("HSWARM_STATS_DB") else "hswarm"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _empty() -> dict:
    """The answer when there is no DB, or it holds no runs: a normal answer with every list empty."""
    return {
        "source": _source(),
        "generated": _now(),
        "empty": True,
        "total": None,
        "plan_rates": None,
        "plan": None,
        "by_machine": [],
        "days": [],
        "claude_by_family": [],
        "accounts": {"rows": [], "worked": 0, "open": 0},
        "rule_check": None,
        "recent": [],
        "today": _today_data([]),
    }


def _db_path() -> Path | None:
    """The path to the stats DB: HSWARM_STATS_DB when set, else the default hswarm DB."""
    env_path = os.environ.get("HSWARM_STATS_DB", "").strip()
    if env_path:
        return Path(env_path)
    return utilization.db_path()


def _connect(db_path: Path) -> sqlite3.Connection:
    """Open the DB read-only. HSWARM_STATS_DB points to a production database that the hswarm
    sidecar must never write to."""
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15)
    c.row_factory = sqlite3.Row
    return c


def _today_data(per_day: list[dict]) -> dict:
    """The summary for today's local day, from per_day; zeros when there is none."""
    today_iso = dt.date.today().isoformat()
    row = next((d for d in per_day if d.get("day") == today_iso), None)
    if not row:
        return {"runs": 0, "tasks": 0, "est_usd": None, "saved_usd": None, "worker_usd": 0.0, "est_tokens": None}
    return {
        "runs": row.get("n", 0),
        "tasks": row.get("tasks", 0),
        "est_usd": row.get("est_usd"),
        "saved_usd": row.get("saved_usd"),
        "worker_usd": row.get("worker_usd", 0.0),
        "est_tokens": row.get("est_tokens"),
    }
