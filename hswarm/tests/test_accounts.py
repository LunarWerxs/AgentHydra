"""Offline: which ACCOUNT did the work, what its plan costs, and the three units the page reads in.

Nothing here touches a real AgentHydra or a real ~/.hswarm: the fixture builds a fake instances cache, a
fake usage cache and a fake session table in tmp_path, and conftest redirects config.HOME.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import accounts, claude_usage, config, report_html, utilization  # noqa: E402

UUID_A, UUID_B, UUID_C = "uuid-max20", "uuid-max5", "uuid-pro"


@pytest.fixture
def hydra(tmp_path, monkeypatch):
    """A fake AgentHydra: two instance folders on one account, one on another, and a session table."""
    root = tmp_path / "hydra"
    (root / "data").mkdir(parents=True)
    (root / "instances-cache.json").write_text(json.dumps({
        r"c:\users\x\.claude-instances\work": {"uuid": UUID_A, "plan": "max", "rateLimitTier": "default_claude_max_20x", "orgType": "claude_max"},
        # The same account seen through a second folder, where the org reads as free: the dearer reading must win.
        r"c:\users\x\.claude-instances\work2": {"uuid": UUID_A, "plan": "max", "rateLimitTier": "default_claude_ai", "orgType": "claude_free"},
        r"c:\users\x\.claude-instances\five": {"uuid": UUID_B, "plan": "max", "rateLimitTier": "default_claude_max_5x", "orgType": "claude_max"},
        r"c:\users\x\appdata\roaming\claude": {"uuid": UUID_C, "plan": "pro", "rateLimitTier": "default_claude_ai", "orgType": "claude_pro"},
    }), encoding="utf-8")
    (root / "data" / "usage-cache.json").write_text(json.dumps({
        r"desktop:c:\users\x\.claude-instances\work2": {"account": "Someone <someone@example.com> \u00b7 Max 20\u00d7"},
    }), encoding="utf-8")
    db = sqlite3.connect(root / "data" / "agenthydra.db")
    db.execute("CREATE TABLE session_stats (session_key TEXT, session_id TEXT, instance TEXT)")
    db.executemany("INSERT INTO session_stats (session_key, session_id, instance) VALUES (?,?,?)",
                   [("k1", "sess-a", "work"), ("k2", "sess-b", "five"), ("k3", "sess-c", "work2")])
    db.commit()
    db.close()
    monkeypatch.setattr(accounts, "HYDRA", root)
    accounts._CACHE.update(at=0.0, value=None)
    return root


def test_account_id_is_a_stable_hash_and_never_the_uuid():
    a = accounts.account_id(UUID_A)
    assert a.startswith("acct-") and len(a) == len("acct-") + 8
    assert a == accounts.account_id(UUID_A) and a != accounts.account_id(UUID_B)
    assert UUID_A not in a


def test_tiers_read_from_the_rate_limit_tier_then_what_agenthydra_displays(hydra):
    inst = accounts.instances()
    assert inst["work"] == {"account": accounts.account_id(UUID_A), "tier": "max_20x"}
    # A personal org reads as claude_free; the displayed "Max 20x" is the truth, and the dearer reading wins.
    assert inst["work2"]["tier"] == "max_20x"
    assert inst["five"]["tier"] == "max_5x" and inst["default"]["tier"] == "pro"
    assert accounts.tier_usd_month("max_20x") == 200.0 and accounts.tier_usd_day("max_20x") == pytest.approx(200 / accounts.DAYS_PER_MONTH)
    assert accounts.tier_usd_month("nonsense") is None


def test_sessions_fold_onto_accounts_and_only_the_ones_that_worked_are_costed(hydra):
    by_session = {"sess-a": {"usd": 10.0, "requests": 2, "tokens": {"input": 1, "cache_read": 9, "cache_5m": 0, "cache_1h": 0, "output": 5}},
                  "sess-c": {"usd": 4.0, "requests": 1, "tokens": {"input": 1, "cache_read": 1, "cache_5m": 0, "cache_1h": 0, "output": 1}},
                  "sess-unknown": {"usd": 1.0, "requests": 1, "tokens": {"input": 1, "cache_read": 0, "cache_5m": 0, "cache_1h": 0, "output": 0}}}
    got = accounts.attribute(by_session, accounts.resolver(fresh=True))
    a = accounts.account_id(UUID_A)
    assert got[a]["usd"] == 14.0 and got[a]["sessions"] == 2 and got[a]["tokens"]["cache_read"] == 10
    assert got[accounts.UNATTRIBUTED]["usd"] == 1.0 and got[accounts.UNATTRIBUTED]["tier"] == ""
    # One account worked that day, on Max 20x: one day of one plan, and the unattributed session costs nothing.
    assert accounts.day_plan_usd(got) == pytest.approx(200 / accounts.DAYS_PER_MONTH, abs=1e-6)
    assert accounts.day_plan_usd({}) is None  # nothing known is not measured, never zero


def test_plan_json_overrides_prices_and_can_be_one_flat_figure(hydra):
    config.HOME.mkdir(parents=True, exist_ok=True)
    (config.HOME / "plan.json").write_text(json.dumps({"tier_usd_month": {"max_20x": 250}}), encoding="utf-8")
    assert accounts.tier_usd_month("max_20x") == 250.0
    (config.HOME / "plan.json").write_text(json.dumps({"usd_month": 609.0}), encoding="utf-8")
    worked = {accounts.account_id(UUID_A): {"tier": "max_20x", "usd": 1.0}}
    assert accounts.day_plan_usd(worked) == pytest.approx(609.0 / accounts.DAYS_PER_MONTH, abs=1e-6)


def test_the_scanner_counts_tokens_per_day_per_model_and_per_session(tmp_path, monkeypatch):
    """Tokens are counted even for a model with no list price, and a session carries its own split."""
    import datetime as dt

    monkeypatch.setattr(claude_usage, "PROJECTS", tmp_path / "projects")
    day = dt.date.today() - dt.timedelta(1)
    ts = dt.datetime.combine(day, dt.time(12)).astimezone().astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    def req(rid, model, **usage):
        u = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0} | usage
        return json.dumps({"requestId": rid, "timestamp": ts, "type": "assistant", "message": {"model": model, "usage": u}}) + "\n"

    proj = tmp_path / "projects" / "proj"
    proj.mkdir(parents=True)
    (proj / "sess-a.jsonl").write_text(req("r1", "claude-sonnet-5", input_tokens=100, output_tokens=10)
                                       + req("r2", "<synthetic>", output_tokens=7), encoding="utf-8")
    (proj / "sess-b.jsonl").write_text(req("r3", "claude-opus-5", cache_read_input_tokens=1000), encoding="utf-8")
    days = claude_usage.collect_python(day, day)
    d = days[day.isoformat()]
    assert d["tokens"] == {"input": 100, "cache_read": 1000, "cache_5m": 0, "cache_1h": 0, "output": 17}
    assert d["by_model"]["<synthetic>"]["tokens"]["output"] == 7 and d["unpriced_requests"] == 1
    assert d["by_session"]["sess-a"]["tokens"]["output"] == 17 and d["by_session"]["sess-a"]["requests"] == 2
    assert d["by_session"]["sess-b"]["tokens"]["cache_read"] == 1000
    assert d["by_session"]["sess-a"]["usd"] == pytest.approx(claude_usage.price_tokens("claude-sonnet-5", {"input": 100, "cache_read": 0, "cache_5m": 0, "cache_1h": 0, "output": 10}), abs=1e-9)
    assert claude_usage.session_of(str(proj / "sess-a.jsonl")) == "sess-a"
    sub = str(proj / "sess-a" / "subagents" / "agent-1.jsonl")
    assert claude_usage.session_of(sub) == "sess-a" and claude_usage.agent_session(sub) == "sess-a"[:8]


def _day_row(day: str, usd: float, sessions: dict) -> dict:
    return {"day": day, "claude_usd": usd, "claude_sub_usd": 0.0, "subagent_usd": {}, "by_model": {}, "agent_tokens": {},
            "tokens": {"input": 0, "cache_read": int(usd * 1000), "cache_5m": 0, "cache_1h": 0, "output": 0}, "by_session": sessions}


def test_days_carry_accounts_a_plan_cost_and_a_rate_that_converts_list_dollars(hydra, monkeypatch):
    monkeypatch.setattr(utilization, "MACHINE", "test-box")
    day = "2026-09-16"
    sessions = {"sess-a": {"usd": 80.0, "requests": 3, "tokens": {"input": 0, "cache_read": 80000, "cache_5m": 0, "cache_1h": 0, "output": 0}},
                "sess-b": {"usd": 20.0, "requests": 1, "tokens": {"input": 0, "cache_read": 20000, "cache_5m": 0, "cache_1h": 0, "output": 0}}}
    assert utilization.record_claude_days([_day_row(day, 100.0, sessions)]) == 1
    c = utilization.connect()
    try:
        rows = utilization.account_rows(c)
        by = {r["account"]: r for r in rows}
        assert by[accounts.account_id(UUID_A)]["usd"] == 80.0 and by[accounts.account_id(UUID_B)]["usd"] == 20.0
        rates = utilization.plan_rates(c)
        one_day = (200 + 100) / accounts.DAYS_PER_MONTH  # a Max 20x and a Max 5x both worked that day
        assert rates["fleet"]["rate"] == pytest.approx(one_day / 100.0, abs=1e-6)
        assert utilization.weigh(100.0, rates["fleet"]["rate"]) == pytest.approx(one_day, abs=1e-4)
        rate, borrowed = utilization.rate_of(rates, "test-box")
        assert not borrowed and rate == rates["fleet"]["rate"]
        assert utilization.rate_of(rates, "some-other-box") == (rates["fleet"]["rate"], True)
        # A re-measure must not leave a stale account behind.
        assert utilization.record_claude_days([_day_row(day, 80.0, {"sess-a": sessions["sess-a"]})]) == 1
        assert {r["account"] for r in utilization.account_rows(c)} == {accounts.account_id(UUID_A)}
    finally:
        c.close()


def test_the_page_renders_all_three_units_and_names_no_one(hydra, monkeypatch):
    monkeypatch.setattr(utilization, "MACHINE", "test-box")
    utilization.record(({"id": "job-1", "ts": "2026-09-16T12:00:00+00:00", "kind": "run", "machine": "test-box", "tasks": 3, "ok": 3,
                         "failed": 0, "seconds": 1.0, "worker_usd": 0.02, "worker_tokens": 1234, "label": "unit",
                         "caller_instance": "work", "caller_session": "sess-a", "caller_cwd": "", "orchestrator_model": "claude-opus-5"}))
    utilization.record_claude_days([_day_row("2026-09-16", 100.0, {"sess-a": {"usd": 100.0, "requests": 2,
                                                                              "tokens": {"input": 0, "cache_read": 100000, "cache_5m": 0, "cache_1h": 0, "output": 0}}})])
    page = report_html.write(config.HOME / "page.html").read_text(encoding="utf-8")
    assert "data-mode='usd'" in page and "data-mode='tok'" in page and "data-mode='plan'" in page
    assert "class='mode-plan'" in page  # a measured rate means the plan view is what opens
    assert accounts.account_id(UUID_A) in page and "someone@example.com" not in page and "Someone" not in page
    assert "Claude tokens avoided" in page and "A list dollar really cost" in page
