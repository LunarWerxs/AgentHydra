"""Per-model results for the console's overview charts: thumbs up/down, cost per successful task, edit survival, daily volume.

Pure aggregation over the ledger (one line per finished task) and the survival log (edit scores per checkpoint). The ledger
runs to ~140 MB, so only the window's tail is parsed (ledger._window_start) and the answer is cached by both files'
size+mtime: a repeated call while nothing was appended reads nothing.
"""
from __future__ import annotations

import datetime as dt
import json
import threading
from pathlib import Path

from . import config
from .ledger import _window_start, money_kind

TOP_DAILY = 6
_CACHE: dict = {}
_LOCK = threading.Lock()


def _sig(p: Path) -> tuple[int, int] | None:
    try:
        st = p.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime_ns


def _survival_1d(path: Path, since: dt.datetime) -> dict[tuple, float]:
    """(job, task) -> four_gram of the task's newest 1d score. The log is small next to the ledger: read whole."""
    out: dict[tuple, float] = {}
    try:
        f = path.open("rb")
    except OSError:
        return out
    with f:
        for line in f:
            try:
                r = json.loads(line)
                if r.get("checkpoint") != "1d" or dt.datetime.fromisoformat(r["ts"]) < since - dt.timedelta(days=2):
                    continue
                out[(r.get("job"), r.get("task"))] = float(r["four_gram"])
            except (ValueError, KeyError, TypeError):
                continue
    return out


def compute(days: int, ledger: Path, survival_log: Path, now: dt.datetime | None = None) -> dict:
    """Per-model tallies for ledger lines newer than `days` days. Failed = any status but "ok"; a `cached` line (a resume
    reusing an answer) is no new task. Cost per ok task = the model's whole spend over its ok tasks (failures are paid for)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=days)
    models: dict[str, dict] = {}
    day_counts: dict[str, dict[str, int]] = {}
    rows: list[tuple[str, tuple]] = []
    if ledger.exists():
        with ledger.open("rb") as f:
            f.seek(_window_start(f, since))
            for line in f:
                try:
                    r = json.loads(line)
                    at = dt.datetime.fromisoformat(r["ts"])
                except (ValueError, KeyError, TypeError):
                    continue
                if at < since or r.get("cached"):
                    continue
                name = str(r.get("model") or "other")
                m = models.setdefault(name, {"model": name, "tasks": 0, "ok": 0, "failed": 0, "cost_usd": 0.0, "seconds": 0.0,
                                             "spent_usd": 0.0, "free_usd": 0.0, "unknown_usd": 0.0, "tokens": 0, "scored": 0, "_surv": 0.0})
                m["tasks"] += 1
                m["ok" if r.get("status") == "ok" else "failed"] += 1
                m["cost_usd"] += float(r.get("cost_usd") or 0.0)
                m[money_kind(r) + "_usd"] += float(r.get("cost_usd") or 0.0)
                m["seconds"] += float(r.get("seconds") or 0.0)
                m["tokens"] += sum(r.get(k) or 0 for k in ("in_hit", "in_miss", "out", "reasoning") if isinstance(r.get(k), int))
                day = at.astimezone().date().isoformat()
                day_counts.setdefault(name, {}).setdefault(day, 0)
                day_counts[name][day] += 1
                rows.append((name, (r.get("job"), r.get("task"))))
    scores = _survival_1d(survival_log, since) if rows else {}
    for name, key in rows:
        if key in scores:
            models[name]["scored"] += 1
            models[name]["_surv"] += scores[key]
    out = []
    for m in sorted(models.values(), key=lambda m: (-m["tasks"], m["model"])):
        s = m.pop("_surv")
        out.append({**m, "success_rate": round(m["ok"] / m["tasks"], 4), "cost_usd": round(m["cost_usd"], 6),
                    "value_usd": round(m["cost_usd"], 6), "spent_usd": round(m["spent_usd"], 6),
                    "free_usd": round(m["free_usd"], 6), "unknown_usd": round(m["unknown_usd"], 6),
                    "cost_per_ok": round(m["cost_usd"] / m["ok"], 6) if m["ok"] else None,
                    "tokens_per_ok": round(m["tokens"] / m["ok"]) if m["ok"] else None,
                    "avg_seconds": round(m["seconds"] / m["tasks"], 2), "seconds": round(m["seconds"], 1),
                    "survival": round(s / m["scored"], 4) if m["scored"] else None})
    top = [m["model"] for m in out[:TOP_DAILY]]
    today = now.astimezone().date()
    dates = [(today - dt.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    daily = [{"date": d, "models": {n: day_counts.get(n, {}).get(d, 0) for n in top},
              "other": sum(c.get(d, 0) for n, c in day_counts.items() if n not in top)} for d in dates]
    return {"days": days, "models": out, "daily": {"top": top, "days": daily}}


def model_stats(days: int = 14) -> dict:
    """compute() for the live files, cached until either file grows or changes."""
    days = max(1, min(90, int(days)))
    ledger, log = config.LEDGER, config.HOME / "survival.jsonl"
    key = (str(ledger), str(log), days, _sig(ledger), _sig(log))
    with _LOCK:
        hit = _CACHE.get(days)
        if hit and hit[0] == key:
            return hit[1]
        out = compute(days, ledger, log)
        _CACHE[days] = (key, out)
        return out
