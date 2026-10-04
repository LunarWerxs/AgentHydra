"""Offline: Claude transcript pricing and dedupe, the daily savings rows, the counterfactual range."""
from __future__ import annotations

import datetime as dt
import json
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
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
    monkeypatch.setenv("AGENTHYDRA_URL", "")  # no daemon: the scan runs, whatever else is listening on this machine
    return tmp_path


@pytest.fixture
def kit_daemon(home, monkeypatch):
    """A real HTTP server standing in for AgentHydra's /api/kit/usage; `answer` is its JSON, `asked` the queries it got."""
    box: dict = {"answer": {}, "asked": [], "sub_answer": {"rows": []}, "sessions": {"rows": []}, "agents": {"rows": []}}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            box["asked"].append(q)
            group = q.get("groupBy", [""])[0]
            if "agent_id" in group:
                answer = box["agents"]
            elif group == "day,session":
                answer = box["sessions"]
            else:
                answer = box["sub_answer"] if "agent" in q else box["answer"]
            body = json.dumps(answer).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("AGENTHYDRA_URL", f"http://127.0.0.1:{server.server_port}")
    yield box
    server.shutdown()


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


def _kit_answer(events: int, rows: list[dict], last_ts: int | None = None) -> dict:
    first = int(dt.datetime.combine(YESTERDAY - dt.timedelta(30), dt.time.min).timestamp() * 1000)
    last = int(time.time() * 1000) if last_ts is None else last_ts  # by default the kit has caught up
    sources = {"cli": {"events": events, "firstTs": first, "lastTs": last}} if events else {}
    return {"rows": rows, "totals": {}, "coverage": {"sources": sources}}


def test_claude_side_comes_from_the_kit_when_it_has_claude_events_else_from_the_scan(kit_daemon, home):
    _write(home / "projects" / "p" / "s.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000))  # the scan would say $10
    rows = [{"day": YESTERDAY.isoformat(), "model": "claude-sonnet-5", "tokens": 700, "input": 700, "list_usd": 1.25},
            {"day": YESTERDAY.isoformat(), "model": "claude-opus-5", "tokens": 300, "input": 300, "list_usd": 0.5}]

    kit_daemon["answer"] = _kit_answer(events=4, rows=rows)
    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[YESTERDAY.isoformat()]
    assert (day["claude_usd"], day["claude_tokens"], day["claude_source"]) == (1.75, 1000, "kit")
    asked = kit_daemon["asked"][0]
    assert asked["pc"] == ["self"] and asked["source"] == ["cli,desktop,climayte"] and asked["groupBy"] == ["day,model"]

    kit_daemon["answer"] = _kit_answer(events=0, rows=[])  # the kit answers but has seen no Claude yet: not a zero
    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[YESTERDAY.isoformat()]
    assert (day["claude_usd"], day["claude_source"]) == (pytest.approx(10.0), "scan")
    assert day["claude_tokens"] == 1_000_000

    s = savings.report(days=1, include_today=False, today=TODAY)  # nothing recorded yet: the report names its source
    assert s["claude_source"] == "scan"


def test_a_kit_that_lags_the_window_end_is_not_trusted_for_the_day(kit_daemon, home):
    _write(home / "projects" / "p" / "s.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000))  # the scan says $10
    rows = [{"day": YESTERDAY.isoformat(), "model": "claude-sonnet-5", "tokens": 5, "list_usd": 0.01}]
    # Old events exist (so the window start is covered) but the newest is two days old: the daemon was down.
    stale = int((time.time() - 2 * 86400) * 1000)
    kit_daemon["answer"] = _kit_answer(events=4, rows=rows, last_ts=stale)
    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[YESTERDAY.isoformat()]
    assert (day["claude_source"], day["claude_usd"]) == ("scan", pytest.approx(10.0))


def test_the_main_sub_agent_split_comes_from_a_kit_request_filtered_to_sub_agents(kit_daemon, home):
    _write(home / "projects" / "p" / "s.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000))  # the scan would say $10 main
    day_s = YESTERDAY.isoformat()
    kit_daemon["answer"] = _kit_answer(events=4, rows=[{"day": day_s, "model": "claude-sonnet-5", "tokens": 700, "list_usd": 2.0}])
    kit_daemon["sub_answer"] = {"rows": [{"day": day_s, "model": "claude-sonnet-5", "list_usd": 0.5}]}
    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[day_s]
    assert (day["claude_usd"], day["claude_sub_usd"], day["claude_main_usd"]) == (2.0, 0.5, 1.5)
    assert kit_daemon["asked"][1]["agent"] == ["subagent"]


def test_every_claude_field_comes_from_a_few_kit_requests_and_the_scan_never_runs(kit_daemon, home, monkeypatch):
    def scan(*a, **k):
        raise AssertionError("the transcript scan must not run when the kit answers")

    monkeypatch.setattr(claude_usage, "collect", scan)
    day_s = YESTERDAY.isoformat()
    hour = dt.datetime.combine(YESTERDAY, dt.time(12)).astimezone().astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:00:00.000Z")
    kit_daemon["answer"] = _kit_answer(events=9, rows=[
        {"day": day_s, "model": "claude-sonnet-5", "tokens": 90, "input": 10, "output": 20, "cache_read": 30, "cache_write_5m": 20, "cache_write_1h": 10,
         "calls": 6, "list_usd": 3.0},
        {"day": day_s, "model": "claude-mystery-1", "tokens": 5, "input": 5, "calls": 3, "list_usd": None}])
    kit_daemon["answer"]["unpriced"] = ["claude-mystery-1"]
    kit_daemon["sub_answer"] = {"rows": [{"day": day_s, "model": "claude-sonnet-5", "list_usd": 1.0}]}
    kit_daemon["sessions"] = {"rows": [{"day": day_s, "session": "sess-1234567890", "calls": 6, "list_usd": 3.0, "input": 10, "output": 20,
                                        "cache_read": 30, "cache_write_5m": 20, "cache_write_1h": 10}, {"day": day_s, "session": None, "calls": 3}]}
    agent = {"hour": hour, "model": "claude-sonnet-5", "session": "sess-1234567890", "output": 100, "cache_write_1h": 7}
    kit_daemon["agents"] = {"rows": [
        {**agent, "agent_id": "agent-a", "calls": 2, "list_usd": 0.4},
        {**agent, "agent_id": "agent-a", "hour": hour, "calls": 1, "list_usd": 0.1},
        {**agent, "agent_id": "workflows/wf_1/agent-b", "calls": 1, "list_usd": 0.5},
        {**agent, "agent_id": "agent-c", "model": "claude-mystery-1", "calls": 4, "list_usd": None}]}

    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[day_s]

    assert len(kit_daemon["asked"]) == 4  # a few requests a run, never one per day, session or sub-agent
    assert day["claude_source"] == "kit"
    assert (day["claude_usd"], day["claude_sub_usd"], day["claude_main_usd"]) == (3.0, 1.0, 2.0)
    assert (day["claude_requests"], day["claude_unpriced_requests"], day["claude_tokens"]) == (9, 3, 95)
    assert day["tokens"] == {"input": 15, "cache_read": 30, "cache_5m": 20, "cache_1h": 10, "output": 20}
    assert day["by_session"] == {"sess-1234567890": {"usd": 3.0, "requests": 6, "tokens": {"input": 10, "cache_read": 30, "cache_5m": 20, "cache_1h": 10, "output": 20}}}
    assert day["subagent_usd"] == {"sonnet": [0.5, 0.5]}  # the unpriced sub-agent is not one the counterfactual is measured from
    a = next(t for t in day["agent_tokens"]["sonnet"] if not t["workflow"])
    assert (a["requests"], a["usd"], a["model"], a["session"], a["output"], a["cache_1h"]) == (3, 0.5, "claude-sonnet-5", "sess-123", 200, 14)
    assert day["by_model"]["claude-sonnet-5"]["agents"] == 2 and day["by_model"]["claude-sonnet-5"]["sub_usd"] == 1.0
    assert sum(t["workflow"] for t in day["agent_tokens"]["sonnet"]) == 1


def test_a_kit_listing_that_leaves_sub_agent_hours_out_falls_back_to_the_scan(kit_daemon, home):
    _write(home / "projects" / "p" / "s.jsonl", _req("r1", YESTERDAY, output_tokens=1_000_000))
    kit_daemon["answer"] = _kit_answer(events=4, rows=[{"day": YESTERDAY.isoformat(), "model": "claude-sonnet-5", "tokens": 5, "list_usd": 0.01}])
    kit_daemon["agents"] = {"rows": [], "notes": ["agent_id filter cannot be applied to hourly rollups: usage before 2026-09-01 is not included"]}
    day = savings.measure(YESTERDAY, YESTERDAY, TODAY)[YESTERDAY.isoformat()]
    assert (day["claude_source"], day["claude_usd"]) == ("scan", pytest.approx(10.0))
