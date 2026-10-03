"""Offline: Claude transcript pricing and dedupe, the daily savings rows, the counterfactual range."""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import claude_usage, config, savings, savings_view  # noqa: E402

TODAY = dt.date.today()
YESTERDAY = TODAY - dt.timedelta(1)


def _ts(day: dt.date) -> str:
    """Local noon written the way Claude Code writes it (UTC, Z), so day bucketing holds in any timezone."""
    return dt.datetime.combine(day, dt.time(12)).astimezone().astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _req(rid: str, day: dt.date, model: str = "claude-sonnet-5", **usage) -> str:
    u = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0} | usage
    return json.dumps({"requestId": rid, "timestamp": _ts(day), "type": "assistant", "message": {"model": model, "usage": u}}) + "\n"


def _write(path: Path, *lines: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HOME", tmp_path / "hswarm")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "hswarm" / "ledger.jsonl")
    monkeypatch.setattr(claude_usage, "PROJECTS", tmp_path / "projects")
    return tmp_path


def test_price_request_uses_list_rates_and_cache_multipliers():
    m = 1_000_000
    assert claude_usage.price_request("claude-sonnet-5", {"input_tokens": m}) == pytest.approx(2.0)
    assert claude_usage.price_request("claude-sonnet-5", {"output_tokens": m}) == pytest.approx(10.0)
    assert claude_usage.price_request("claude-sonnet-5", {"cache_read_input_tokens": m}) == pytest.approx(0.2)
    assert claude_usage.price_request("claude-sonnet-5", {"cache_creation_input_tokens": m}) == pytest.approx(2.5)
    one_hour = {"cache_creation_input_tokens": m, "cache_creation": {"ephemeral_1h_input_tokens": m}}
    assert claude_usage.price_request("claude-sonnet-5", one_hour) == pytest.approx(4.0)
    assert claude_usage.price_request("claude-fable-5-1", {"cache_read_input_tokens": m}) == pytest.approx(0.25)
    assert claude_usage.price_request("claude-fable-5", {"cache_read_input_tokens": m}) == pytest.approx(1.0)
    assert claude_usage.price_request("<synthetic>", {"output_tokens": m}) is None


def test_collect_counts_each_request_once_and_splits_main_from_subagents(home):
    root = home / "projects" / "proj"
    old = YESTERDAY - dt.timedelta(2)
    _write(root / "sess.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000), _req("r1", YESTERDAY, output_tokens=1_000_000),
           _req("r0", old, output_tokens=1_000_000))
    _write(root / "sess" / "subagents" / "agent-a.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000),
           _req("r2", YESTERDAY, output_tokens=100_000))
    _write(root / "sess" / "subagents" / "workflows" / "wf_1" / "agent-b.jsonl",
           _req("r3", YESTERDAY, model="claude-opus-5", output_tokens=100_000))

    d = claude_usage.collect(YESTERDAY, YESTERDAY)[YESTERDAY.isoformat()]

    assert d["main_usd"] == pytest.approx(10.0)  # r1 once, and billed to the main loop that issued it
    assert d["sub_usd"] == pytest.approx(3.5)
    assert d["requests"] == 3
    assert d["agents"] == {"sonnet": [1.0], "opus": [2.5]}


def _ledger(home: Path, rows: list[tuple[str, float | None]]) -> None:
    ts = dt.datetime.combine(YESTERDAY, dt.time(12)).astimezone().isoformat()
    lines = [json.dumps({"ts": ts, "job": job, "task": f"t{i}", "cost_usd": cost}) for i, (job, cost) in enumerate(rows)]
    _write(home / "hswarm" / "ledger.jsonl", *(line + "\n" for line in lines))


def test_record_is_idempotent_and_prices_the_measured_counterfactual(home):
    _ledger(home, [("J1", 0.01), ("J1", 0.01), ("J2", 0.005)])
    for i in range(savings.MIN_POOL):
        _write(home / "projects" / "p" / "s" / "subagents" / f"agent-{i}.jsonl", _req(f"s{i}", YESTERDAY, output_tokens=100_000))

    assert savings.record(backfill=2, today=TODAY) == [(TODAY - dt.timedelta(2)).isoformat(), YESTERDAY.isoformat()]
    assert savings.record(backfill=2, today=TODAY) == []

    s = savings.report(days=14, include_today=False, today=TODAY)
    assert s["per_subagent"] == {"usd": 1.0, "basis": "Sonnet sub-agents", "sample": savings.MIN_POOL}
    day = s["days"][-1]
    assert (day["hswarm_jobs"], day["hswarm_tasks"], day["claude_subagents"]) == (2, 3, 5)
    assert (day["avoided_low_usd"], day["avoided_high_usd"]) == (2.0, 3.0)
    assert day["net_saved_low_usd"] == pytest.approx(1.975)
    assert day["claude_share_displaced_low"] == pytest.approx(2 / 7, abs=1e-4)
    assert s["month"]["active_days"] == 1
    assert s["month"]["deepseek_usd"] == pytest.approx(0.75)
    assert "Sonnet sub-agents" in savings_view.render(s)


def test_usd_keeps_a_tiny_cost_visible_and_never_prints_zero_for_one():
    assert savings_view.usd(None) == "-" and savings_view.usd(0) == "$0" and savings_view.usd(3588.4087) == "$3,588.41"
    assert savings_view.usd(0.0562) == "$0.0562" and savings_view.usd(0.001) == "$0.001" and savings_view.usd(0.000003) == "$0.000003"
    assert savings_view.usd(0.0000002) == "<$0.000001" and savings_view.usd(-0.5) == "$-0.5000"


def test_too_few_subagents_is_not_measured_never_zero(home):
    _ledger(home, [("J1", 0.01)])
    savings.record(backfill=1, today=TODAY)

    s = savings.report(days=14, include_today=False, today=TODAY)

    assert s["per_subagent"]["usd"] is None
    assert "avoided_low_usd" not in s["days"][-1]
    assert s["totals"]["avoided_low_usd"] is None
    assert "-" in savings_view.render(s)
