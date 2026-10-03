"""Stats endpoint: read-only access to the utilization DB (ZSwarm or HSwarm), the shape the web console consumes."""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from hswarm import console, stats, utilization

NO_ACCOUNTS = {"rows": [], "worked": 0, "open": 0}


@pytest.fixture(autouse=True)
def _fresh_cache():
    stats._cache.clear()
    yield
    stats._cache.clear()


def test_stats_with_existing_db_returns_correct_shape(tmp_path, monkeypatch):
    """Stats returns the expected shape with all required keys."""
    db_path = tmp_path / "test.sqlite"
    monkeypatch.setenv("HSWARM_STATS_DB", str(db_path))

    c = sqlite3.connect(str(db_path), timeout=15)
    c.row_factory = sqlite3.Row
    c.executescript(utilization.SCHEMA)
    utilization._migrate(c)
    c.execute(
        "INSERT INTO utilizations (id, ts, kind, machine, orchestrator_model, tasks, worker_usd, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("test-1", "2026-09-15T10:00:00+00:00", "run", utilization.MACHINE, "claude-sonnet-5", 3, 0.05, 1),
    )
    c.commit()
    c.close()

    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS):
        result = stats.stats(30)

    assert result["empty"] is False
    assert result["source"] == "zswarm"
    assert result["generated"] is not None
    assert result["total"] is not None
    assert result["total"]["n"] == 1
    assert result["total"]["tasks"] == 3
    assert "by_machine" in result
    assert "days" in result
    assert "claude_by_family" in result
    assert "plan_rates" in result
    assert "plan" in result
    assert "recent" in result
    assert "today" in result


def test_stats_with_missing_db_returns_empty_shape(tmp_path, monkeypatch):
    """When the DB file does not exist, stats returns empty: true and empty lists."""
    monkeypatch.setenv("HSWARM_STATS_DB", str(tmp_path / "missing.sqlite"))
    result = stats.stats(30)
    assert result["empty"] is True
    assert result["total"] is None
    assert result["by_machine"] == []
    assert result["days"] == []
    assert result["accounts"]["rows"] == []
    assert result["source"] == "zswarm"


def test_stats_without_env_reads_default_hswarm_db(tmp_path, monkeypatch):
    """When HSWARM_STATS_DB is not set, source is hswarm."""
    monkeypatch.delenv("HSWARM_STATS_DB", raising=False)
    result = stats.stats(30)
    assert result["source"] == "hswarm"


def test_stats_db_file_unchanged_no_wal_files(tmp_path, monkeypatch):
    """The read-only connection does not modify the DB or create -wal/-shm files."""
    db_path = tmp_path / "test.sqlite"
    monkeypatch.setenv("HSWARM_STATS_DB", str(db_path))

    c = sqlite3.connect(str(db_path), timeout=15)
    c.row_factory = sqlite3.Row
    c.executescript(utilization.SCHEMA)
    utilization._migrate(c)
    c.close()

    mtime_before = db_path.stat().st_mtime
    import time
    time.sleep(0.01)

    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS):
        result = stats.stats(30)

    mtime_after = db_path.stat().st_mtime
    wal = db_path.with_suffix(".sqlite-wal")
    shm = db_path.with_suffix(".sqlite-shm")

    assert mtime_before == mtime_after, "DB file was modified"
    assert not wal.exists(), "-wal file was created"
    assert not shm.exists(), "-shm file was created"
    assert result["empty"] is True


def test_stats_respects_days_parameter(tmp_path, monkeypatch):
    """The days parameter is clamped 1..90."""
    db_path = tmp_path / "test.sqlite"
    monkeypatch.setenv("HSWARM_STATS_DB", str(db_path))

    c = sqlite3.connect(str(db_path), timeout=15)
    c.row_factory = sqlite3.Row
    c.executescript(utilization.SCHEMA)
    utilization._migrate(c)
    c.close()

    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS):
        result_1 = stats.stats(1)
        result_0 = stats.stats(0)  # should clamp to 1
        result_200 = stats.stats(200)  # should clamp to 90

    assert result_1["empty"] is True
    assert result_0["empty"] is True
    assert result_200["empty"] is True


def _seeded_db(tmp_path, monkeypatch, n_days=5):
    """A DB with one run and one stored Claude day (with its rule check) on each of the last n_days local days."""
    db_path = tmp_path / "test.sqlite"
    monkeypatch.setenv("HSWARM_STATS_DB", str(db_path))
    c = sqlite3.connect(str(db_path), timeout=15)
    c.executescript(utilization.SCHEMA)
    utilization._migrate(c)
    days = []
    for i in range(n_days):
        noon = dt.datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0) - dt.timedelta(days=i)
        day = noon.date().isoformat()
        days.append(day)
        c.execute("INSERT INTO utilizations (id, ts, kind, machine, tasks, worker_usd, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"r{i}", noon.isoformat(), "run", utilization.MACHINE, 1, 0.01, i))
        c.execute("INSERT INTO claude_days (machine, day, claude_usd, sub_usd, subagents, partial, by_model, rules, tokens, plan_usd)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (utilization.MACHINE, day, 1.0, 0.0, 0, 0, "{}", json.dumps({"haiku_requests": i, "agents_detail": True}), "{}", 0.0))
    c.commit()
    c.close()
    return days  # newest first


def test_stats_days_are_the_newest_window_oldest_first(tmp_path, monkeypatch):
    days = _seeded_db(tmp_path, monkeypatch)
    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS):
        result = stats.stats(2)
    assert [d["day"] for d in result["days"]] == [days[1], days[0]]
    assert [d["day"] for d in result["claude_by_family"]] == [days[1], days[0]]


def test_stats_rule_check_is_the_latest_stored_day(tmp_path, monkeypatch):
    days = _seeded_db(tmp_path, monkeypatch)
    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS):
        result = stats.stats(30)
    assert result["rule_check"]["day"] == days[0]
    assert result["rule_check"]["haiku_requests"] == 0


def test_stats_second_call_within_ttl_does_not_reopen_the_db(tmp_path, monkeypatch):
    _seeded_db(tmp_path, monkeypatch)
    with patch("hswarm.report_html.account_view", return_value=NO_ACCOUNTS),             patch.object(stats, "_connect", wraps=stats._connect) as connect:
        first = stats.stats(7)
        second = stats.stats(7)
        assert connect.call_count == 1
        assert second is first
        stats.stats(3)  # another `days` value is its own entry
        assert connect.call_count == 2
        monkeypatch.setattr(stats, "CACHE_TTL", 0.0)
        stats.stats(7)
        assert connect.call_count == 3
