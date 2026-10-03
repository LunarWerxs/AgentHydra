"""Offline: per-model results for the overview charts, from a small temp ledger and survival log."""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hswarm.model_stats import compute  # noqa: E402

NOW = dt.datetime(2026, 10, 3, 12, 0, tzinfo=dt.timezone.utc)


def _ts(days_ago: float) -> str:
    return (NOW - dt.timedelta(days=days_ago)).isoformat()


def _write(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def test_counts_cost_days_and_survival(tmp_path):
    ledger = _write(tmp_path / "ledger.jsonl", [
        {"ts": _ts(40), "job": "j0", "task": "t", "model": "a", "status": "ok", "cost_usd": 9.0},  # outside the window
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "status": "ok", "cost_usd": 0.10, "seconds": 2, "out": 100},
        {"ts": _ts(1), "job": "j1", "task": "t2", "model": "a", "status": "ok", "cost_usd": 0.30, "seconds": 4, "in_miss": 50},
        {"ts": _ts(1), "job": "j1", "task": "t3", "model": "a", "status": "timeout", "cost_usd": 0.20, "seconds": 6},
        {"ts": _ts(2), "job": "j2", "task": "t1", "model": "b", "status": "error", "cost_usd": 0.0},
    ])
    surv = _write(tmp_path / "survival.jsonl", [
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "checkpoint": "5m", "four_gram": 0.1},
        {"ts": _ts(1), "job": "j1", "task": "t1", "model": "a", "checkpoint": "1d", "four_gram": 0.8},
        {"ts": _ts(1), "job": "j1", "task": "t2", "model": "a", "checkpoint": "1d", "four_gram": 0.6},
        {"ts": _ts(1), "job": "j1", "task": "t3", "model": "a", "checkpoint": "1h", "four_gram": 0.0},
    ])
    out = compute(30, ledger, surv, now=NOW)
    a, b = out["models"]
    assert (a["model"], a["tasks"], a["ok"], a["failed"]) == ("a", 3, 2, 1)
    assert a["success_rate"] == round(2 / 3, 4)
    assert a["cost_usd"] == 0.6 and a["cost_per_ok"] == 0.3  # the failed task's spend counts against the ok ones
    assert a["avg_seconds"] == 4.0 and a["tokens"] == 150
    assert a["scored"] == 2 and a["survival"] == 0.7  # 1d rows only: the 5m and 1h rows are ignored
    assert (b["model"], b["ok"], b["failed"], b["cost_per_ok"], b["survival"]) == ("b", 0, 1, None, None)
    assert out["daily"]["top"] == ["a", "b"] and len(out["daily"]["days"]) == 30
    assert sum(d["models"]["a"] for d in out["daily"]["days"]) == 3


def test_days_filter(tmp_path):
    ledger = _write(tmp_path / "ledger.jsonl", [
        {"ts": _ts(10), "job": "j", "task": "old", "model": "a", "status": "ok"},
        {"ts": _ts(1), "job": "j", "task": "new", "model": "a", "status": "ok"},
    ])
    none = tmp_path / "missing.jsonl"
    assert compute(14, ledger, none, now=NOW)["models"][0]["tasks"] == 2
    assert compute(5, ledger, none, now=NOW)["models"][0]["tasks"] == 1
