"""Offline: the per-utilization ledger - pricing at the caller's model, the profile that sizes it, the
freeze-after-pricing rule, the fleet total across shards, and the hooks in the job manager and caller."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import caller, claude_usage, config, utilization  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402

PROFILE = {"id": "p1", "basis": "Sonnet", "sample": 9, "pool_days": 14, "input": 1000, "cache_read": 200_000, "cache_5m": 20_000, "cache_1h": 0, "output": 4000, "requests": 6}


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")


def _day(agents: list[dict], family: str = "sonnet") -> dict:
    return {"day": "2026-09-14", "agent_tokens": {family: agents}}


def test_estimate_prices_at_the_callers_model_and_floors_when_unknown():
    per_fable = claude_usage.price_tokens("claude-fable-5-1", PROFILE)
    e = utilization.estimate({"orchestrator_model": "claude-fable-5-1", "tasks": 3, "worker_usd": 0.01}, PROFILE)
    assert e["est_model"] == "claude-fable-5-1" and e["est_usd"] == pytest.approx(3 * per_fable, abs=1e-6)
    assert e["est_low_usd"] == pytest.approx(per_fable, abs=1e-6) and e["saved_usd"] == pytest.approx(3 * per_fable - 0.01, abs=1e-6)
    assert "calling session's model" in e["basis"]

    floor = utilization.estimate({"orchestrator_model": "", "tasks": 1, "worker_usd": 0.0}, PROFILE)
    assert floor["est_model"] == utilization.FLOOR_MODEL and "Sonnet floor" in floor["basis"]
    assert floor["est_usd"] == pytest.approx(claude_usage.price_tokens("claude-sonnet-5", PROFILE), abs=1e-6)

    unknown = utilization.estimate({"orchestrator_model": "claude-mystery-9", "tasks": 1}, PROFILE)
    assert unknown["est_model"] == utilization.FLOOR_MODEL and "no list price" in unknown["basis"]

    # Only an answered task saved a sub-agent (2026-09-24: 1 ok of 24 reported "saved $17.64").
    lost = utilization.estimate({"orchestrator_model": "claude-fable-5-1", "tasks": 24, "ok": 1, "worker_usd": 1.14}, PROFILE)
    assert lost["est_usd"] == pytest.approx(per_fable, abs=1e-6) and lost["saved_usd"] == pytest.approx(per_fable - 1.14, abs=1e-6)
    assert utilization.estimate({"orchestrator_model": "claude-fable-5-1", "tasks": 3, "ok": 0, "worker_usd": 0.5}, PROFILE)["saved_usd"] == -0.5

    none = utilization.estimate({"orchestrator_model": "claude-fable-5-1", "tasks": 5}, None)
    assert none["est_usd"] is None and none["saved_usd"] is None and "no sub-agent profile" in none["basis"]


def test_rows_are_priced_by_the_first_profile_and_then_frozen():
    a = utilization.record({"id": "job-a", "ts": "2026-09-15T10:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "orchestrator_model": "claude-opus-5", "tasks": 4, "worker_usd": 0.02})
    assert a["est_usd"] is None and a["seq"] == 1  # no profile on record yet: '-', never zero; numbered from 1

    agents = [{"input": 100 * i, "cache_read": 50_000, "cache_5m": 1000, "cache_1h": 0, "output": 500, "requests": 3} for i in range(1, 8)]
    prof = utilization.refresh_profile([_day(agents)])
    assert prof and prof["basis"] == "Sonnet" and prof["sample"] == 7 and prof["input"] == 400 and prof["repriced"] == 1

    c = utilization.connect()
    row_a = dict(c.execute("SELECT * FROM utilizations WHERE id = 'job-a'").fetchone())
    c.close()
    assert row_a["est_model"] == "claude-opus-5" and row_a["profile_id"] == prof["id"] and row_a["seq"] == 1  # re-priced, same number
    assert row_a["basis"].startswith("4 x Sonnet sub-agent (7 measured, 1d) @ opus-5")
    assert row_a["est_usd"] == pytest.approx(4 * claude_usage.price_tokens("claude-opus-5", prof), abs=1e-6)

    b = utilization.record({"id": "job-b", "ts": "2026-09-15T11:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "orchestrator_model": "claude-sonnet-5", "tasks": 1, "worker_usd": 0.001})
    assert b["profile_id"] == prof["id"]

    bigger = [{"input": 9000, "cache_read": 900_000, "cache_5m": 0, "cache_1h": 0, "output": 9000, "requests": 9}] * 6
    prof2 = utilization.refresh_profile([_day(bigger)])
    assert prof2 and prof2["repriced"] == 0
    c = utilization.connect()
    frozen = {r["id"]: r["profile_id"] for r in c.execute("SELECT id, profile_id FROM utilizations")}
    c.close()
    assert frozen == {"job-a": prof["id"], "job-b": prof["id"]}  # a priced row keeps the numbers of its day


def test_too_few_subagents_is_no_profile_and_any_model_is_the_fallback_basis():
    assert utilization.refresh_profile([_day([{"input": 1, "output": 1}] * 3)]) is None
    mixed = _day([{"input": 1, "output": 1, "requests": 1}] * 2) | {"agent_tokens": {"sonnet": [{"input": 1}] * 2, "opus": [{"input": 5, "output": 2}] * 4}}
    prof = utilization.refresh_profile([mixed])
    assert prof and prof["basis"] == "any-model" and prof["sample"] == 6


def test_totals_by_machine_and_shard_roundtrip(tmp_path):
    for i in range(3):
        utilization.record({"id": f"local-{i}", "ts": f"2026-09-15T0{i}:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "tasks": 2, "worker_usd": 0.01})
    utilization.refresh_profile([_day([{"input": 10, "cache_read": 10_000, "cache_5m": 0, "cache_1h": 0, "output": 100, "requests": 2}] * 5)])
    shards = tmp_path / "shards"
    c = utilization.connect()
    mine = utilization.export_shard(c, shards)
    lines = [json.loads(text) for text in mine.read_text(encoding="utf-8").splitlines()]
    assert [row["row"] for row in lines] == ["profile", "utilization", "utilization", "utilization"]
    assert [row["seq"] for row in lines if row["row"] == "utilization"] == [1, 2, 3]  # the run numbers travel with the shard

    other = [{"row": "utilization", "id": "other-1", "ts": "2026-09-14T00:00:00+00:00", "kind": "ask", "machine": "jacob-pc", "tasks": 1, "worker_usd": 0.002, "est_usd": 0.5, "saved_usd": 0.498, "saved_low_usd": 0.498, "est_model": "claude-sonnet-5"}]
    (shards / "jacob-pc.jsonl").write_text("".join(json.dumps(o) + "\n" for o in other), encoding="utf-8")
    assert utilization.import_shards(c, shards) == 1
    assert utilization.import_shards(c, shards) == 1  # idempotent: upsert by id

    # A normal sync never reads our own shard back; the restore path does, so a lost ledger can be rebuilt from GitHub.
    c.execute("DELETE FROM utilizations WHERE machine = ?", (utilization.MACHINE,))
    c.commit()
    assert c.execute("SELECT COUNT(*) FROM utilizations").fetchone()[0] == 1
    assert utilization.import_shards(c, shards) == 1  # ours stays gone
    assert c.execute("SELECT COUNT(*) FROM utilizations").fetchone()[0] == 1
    assert utilization.import_shards(c, shards, include_self=True) == 4  # 3 ours + 1 theirs
    assert c.execute("SELECT COUNT(*) FROM utilizations WHERE machine = ?", (utilization.MACHINE,)).fetchone()[0] == 3
    assert [r[0] for r in c.execute("SELECT seq FROM utilizations WHERE machine = ? ORDER BY seq", (utilization.MACHINE,))] == [1, 2, 3]

    t = utilization.totals(c)
    assert t["n"] == 4 and t["tasks"] == 7 and t["worker_usd"] == pytest.approx(0.032) and t["unpriced"] == 0
    assert t["claude_usd"] is None and t["share"] is None  # no Claude day measured yet: not measured, never zero
    assert {m["machine"]: m["n"] for m in utilization.by_machine(c)} == {utilization.MACHINE: 3, "jacob-pc": 1}
    c.close()
    # Claude's own usage on the days the swarm ran turns the saving into a share of the work done beside it.
    local_day = __import__("datetime").datetime.fromisoformat("2026-09-15T00:00:00+00:00").astimezone().date().isoformat()
    assert utilization.record_claude_days([{"day": local_day, "claude_usd": 90.0, "claude_sub_usd": 40.0, "subagent_usd": {"sonnet": [1, 2]}}]) == 1
    assert utilization.record_claude_days([{"day": local_day, "claude_usd": 1.0}], partial=True) == 0  # a completed day is never overwritten by a partial one
    c = utilization.connect()
    mine = utilization.totals(c, utilization.MACHINE)
    assert mine["claude_usd"] == 90.0 and mine["claude_days"] == 1 and mine["share"] == pytest.approx(mine["est_usd"] / (mine["est_usd"] + 90.0), abs=1e-4)
    assert utilization.share(10.0, 90.0) == 0.1 and utilization.share(None, 5.0) is None and utilization.share(0.0, 0.0) is None
    shard = utilization.export_shard(c, shards).read_text(encoding="utf-8")
    assert '"row": "claude_day"' in shard and f'"day": "{local_day}"' in shard
    md = utilization.totals_markdown(c)
    assert "jacob-pc" in md and "| **all** | 4 | 7 |" in md and "share" in md
    c.close()
    s = utilization.summary(5)
    assert s["total"]["n"] == 4 and len(s["recent"]) == 4 and "running total" in utilization.render(s) and "% of the Claude work" in utilization.render(s)


class _FakeClient:
    async def chat(self, messages, **kw):
        await asyncio.sleep(0.01)
        return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(hit=10, miss=20, out=5), model="deepseek-flash", seconds=0.01, cost_usd=0.003, peak=False)

    async def aclose(self):
        pass


def test_job_finish_records_a_utilization_at_the_callers_model(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("HSWARM_ORCHESTRATOR_MODEL", "claude-fable-5-1")
    utilization.refresh_profile([_day([{"input": 10, "cache_read": 10_000, "cache_5m": 0, "cache_1h": 0, "output": 100, "requests": 2}] * 5)])

    async def go():
        m = JobManager(client=_FakeClient())
        tasks = [Task.from_dict({"id": f"t{i}", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, i) for i in range(2)]
        return await m.run_batch(tasks, label="unit")

    job = asyncio.run(go())
    c = utilization.connect()
    row = dict(c.execute("SELECT * FROM utilizations WHERE id = ?", (job.id,)).fetchone())
    c.close()
    assert row["tasks"] == 2 and row["ok"] == 2 and row["orchestrator_model"] == "claude-fable-5-1" and row["est_model"] == "claude-fable-5-1"
    assert row["worker_usd"] == pytest.approx(0.006) and row["worker_tokens"] == 70 and row["label"] == "unit"
    assert job.summary()["savings"]["est_usd"] == row["est_usd"] and job.summary()["savings"]["saved_usd"] == pytest.approx(row["est_usd"] - 0.006, abs=1e-6)
    on_disk = json.loads((config.JOBS_DIR / job.id / "job.json").read_text(encoding="utf-8"))
    assert on_disk["summary"]["savings"]["est_model"] == "claude-fable-5-1"


def test_rule_check_reads_models_agents_and_the_gate_log(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTING", tmp_path / "routing.jsonl")
    day = "2026-09-15"
    noon = "2026-09-15T18:00:00+00:00"
    routing = [
        {"ts": "2026-09-15T17:00:00+00:00", "session_id": "aaaaaaaa-1", "tool": "Agent", "model": "sonnet", "agents": 1, "decision": "allowed", "reason": "needs the harness"},
        {"ts": "2026-09-15T17:30:00+00:00", "session_id": "bbbbbbbb-2", "tool": "Workflow", "model": "opus", "agents": 3, "decision": "blocked"},
    ]
    config.ROUTING.write_text("\n".join(json.dumps(r) for r in routing) + "\n", encoding="utf-8")
    agents = {
        "sonnet": [{"input": 1, "output": 1, "requests": 2, "model": "claude-sonnet-5", "session": "aaaaaaaa", "started": noon, "workflow": False, "usd": 0.5},
                   {"input": 1, "output": 1, "requests": 2, "model": "claude-sonnet-5", "session": "cccccccc", "started": noon, "workflow": True, "usd": 0.25},
                   {"input": 1, "output": 1, "requests": 2, "model": "claude-sonnet-5", "session": "dddddddd", "started": "2026-09-15T10:00:00+00:00", "workflow": True, "usd": 0.25}],
        "opus": [{"input": 1, "output": 1, "requests": 5, "model": "claude-opus-5", "session": "bbbbbbbb", "started": noon, "workflow": False, "usd": 2.0}],
    }
    row = {"day": day, "claude_usd": 100.0, "claude_sub_usd": 3.0, "subagent_usd": {"sonnet": [0.5, 0.25, 0.25], "opus": [2.0]}, "agent_tokens": agents,
           "by_model": {"claude-opus-5": {"requests": 50, "usd": 90.0, "main_usd": 88.0, "sub_usd": 2.0, "agents": 1},
                        "claude-sonnet-5": {"requests": 6, "usd": 1.0, "main_usd": 0.0, "sub_usd": 1.0, "agents": 3},
                        "claude-haiku-4-5": {"requests": 2, "usd": 0.01, "main_usd": 0.01, "sub_usd": 0.0, "agents": 0},
                        # Haiku 5.5 is allowed (owner, 2026-10-07): counted apart, never as a broken ban
                        "claude-haiku-5-5": {"requests": 7, "usd": 0.01, "main_usd": 0.01, "sub_usd": 0.0, "agents": 0}}}
    r = utilization.rule_check(row)
    assert r["haiku_requests"] == 2 and r["haiku55_requests"] == 7 and r["sonnet_agents"] == 3 and r["sonnet_usd"] == 1.0 and r["sonnet_workflow_agents"] == 2 and r["opus_agents"] == 1
    assert r["gate_decisions"] == 2 and r["gate_blocked"] == 1 and r["gate_allowed"] == 1 and r["gate_allowed_sonnet_agents"] == 1
    assert r["agents_after_gate"] == 3 and r["ungated_agents_after_gate"] == 1  # cccccccc never hit the gate; dddddddd started before it existed
    assert r["agents_detail"] and r["gate_live_since"] == "2026-09-15T17:00"
    assert utilization.record_claude_days([row]) == 1
    c = utilization.connect()
    d = utilization.claude_day_rows(c, utilization.MACHINE)[0]
    c.close()
    assert d["by_model"]["claude-sonnet-5"]["agents"] == 3 and d["rules"]["ungated_agents_after_gate"] == 1
    text = utilization.rules_text(d)
    assert "HAIKU 4.5 2 REQUESTS" in text and "Haiku 5.5 7" in text and "Sonnet sub-agents 3" in text and "1 of them from sessions the gate never saw" in text
    from hswarm import report_html

    assert "opus" in {report_html.family_of("claude-opus-5")} and report_html.family_of("gpt-x") == "other"
    tiles = report_html.rule_tiles(d)
    assert "BROKEN" in tiles and "Bypassed the gate" in tiles and 'v neg' in tiles


def test_backfill_imports_jobs_on_disk_and_asks_from_the_ledger(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("HSWARM_ORCHESTRATOR_MODEL", "claude-opus-5")
    job = {"summary": {"job_id": "20260915-010101-aaaa", "label": "old-batch", "state": "done", "created": "2026-09-15T01:01:01+00:00", "finished": "2026-09-15T01:02:31+00:00"},
           "caller": {"instance": "temp2", "session_id": "abcdef12-0000", "cwd": "D:/x"},
           "results": {"t1": {"status": "ok", "backend": "api", "model": "deepseek-flash", "usage": {"in_hit": 1, "in_miss": 2, "out": 3}, "cost_usd": 0.01, "seconds": 5},
                       "t2": {"status": "error", "backend": "api", "model": "deepseek-flash", "usage": {}, "cost_usd": 0.02, "seconds": 6}}}
    (config.JOBS_DIR / "20260915-010101-aaaa").mkdir(parents=True)
    (config.JOBS_DIR / "20260915-010101-aaaa" / "job.json").write_text(json.dumps(job), encoding="utf-8")
    (config.JOBS_DIR / "20260915-020202-bbbb").mkdir()
    (config.JOBS_DIR / "20260915-020202-bbbb" / "job.json").write_text(json.dumps({"summary": {"state": "running"}, "results": {}}), encoding="utf-8")
    config.LEDGER.write_text(json.dumps({"ts": "2026-09-15T03:00:00+00:00", "job": "ask", "task": "ask", "model": "deepseek-flash", "status": "ok", "cost_usd": 0.001, "in_hit": 5, "out": 5, "caller_session": "abcdef12"}) + "\n"
                             + json.dumps({"ts": "2026-09-15T03:00:01+00:00", "job": "20260915-010101-aaaa", "task": "t1", "status": "ok", "cost_usd": 0.01}) + "\n", encoding="utf-8")

    assert utilization.backfill() == {"jobs": 1, "asks": 1}
    assert utilization.backfill() == {"jobs": 0, "asks": 0}  # idempotent
    c = utilization.connect()
    rows = {r["id"]: dict(r) for r in c.execute("SELECT * FROM utilizations")}
    c.close()
    j = rows["20260915-010101-aaaa"]
    assert (j["tasks"], j["ok"], j["failed"], j["worker_usd"], j["worker_tokens"], j["seconds"], j["label"]) == (2, 1, 1, 0.03, 6, 90.0, "old-batch")
    assert j["orchestrator_model"] == "claude-opus-5" and j["caller_instance"] == "temp2" and j["est_usd"] is None  # no profile yet: unpriced
    ask = next(r for r in rows.values() if r["kind"] == "ask")
    assert ask["worker_usd"] == 0.001 and ask["worker_tokens"] == 10 and ask["caller_session"] == "abcdef12"


def test_html_page_renders_the_db_and_escapes_what_it_shows(tmp_path):
    from hswarm import report_html

    utilization.refresh_profile([_day([{"input": 10, "cache_read": 10_000, "cache_5m": 0, "cache_1h": 0, "output": 100, "requests": 2}] * 5)])
    utilization.record({"id": "j1", "ts": "2026-09-15T10:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "orchestrator_model": "claude-fable-5-1",
                        "tasks": 3, "worker_usd": 0.01, "label": "<b>x&y</b>", "caller_cwd": "D:/x/Proj"})
    utilization.record({"id": "j2", "ts": "2026-09-14T10:00:00+00:00", "kind": "ask", "machine": "jacob-pc", "tasks": 1, "worker_usd": 0.0})
    utilization.record({"id": "j3", "ts": "2026-09-13T10:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "tasks": 1, "worker_usd": 9.0})  # a loss
    p = report_html.write(tmp_path / "out" / "page.html")
    page = p.read_text(encoding="utf-8")
    assert page.startswith("<!doctype html>") and "&lt;b&gt;x&amp;y&lt;/b&gt;" in page and "<b>x&y</b>" not in page
    assert "jacob-pc" in page and ">fable-5-1<" in page and "<h2>Per day</h2>" in page and page.count("<tr>") >= 8  # model names lose the claude- prefix
    assert "3 runs · 5 tasks" in page and "Click a header to sort" in page
    assert "--bg:#0f1115" in page and "color-scheme' content='dark'" in page  # dark theme (Michael, 2026-09-16)
    # A saving is green with a +, a loss red with a -; the class now also carries the unit group the cell belongs to.
    assert 'class="n mu pos"' in page and 'class="n mu neg"' in page and "+$" in page and "-$" in page
    assert report_html.ratio(4.0, 0.01) == 400.0 and report_html.ratio_text(4321.9) == "4,322x" and report_html.ratio(None, 1) is None and report_html.ratio(1.0, 0.0) is None
    assert "cheaper by" in page and "Claude beside it" in page and "DeepSeek cost" in page and "<h2>Charts</h2>" in page and "<svg" in page
    assert "grid-template-columns:repeat(3,minmax(0,1fr))" in page  # three charts across, wrapping only on a narrow window
    assert report_html.days_note(1).startswith("<div class='note'>One day") and report_html.days_note(2) == ""
    # Every time a human reads is the local clock, because the day buckets are local days (Michael, 2026-09-16).
    import datetime as _dt
    utc = "2026-09-16T01:18:52+00:00"
    want = _dt.datetime.fromisoformat(utc).astimezone().strftime("%Y-%m-%d %H:%M")
    assert report_html.local_min(utc) == want == utilization.local_min(utc) and report_html.local_date(utc) == want[:10]
    assert report_html.local_min("not a time") == "not a time"[:16] and report_html.tz_label().startswith("local (UTC")
    assert " UTC ·" not in page and "every time on this page is your local clock" in page  # the header clock is local, not UTC
    assert f"when, {report_html.tz_label()}" in page
    assert page.index("est. Claude") < page.index("DeepSeek cost")  # the subtraction reads left to right
    assert "<details>" in page and "3 x sub-agent @ fable-5-1" in page and "(floor)" in page  # the short 'how', the essay folded away
    rows = {r["id"]: dict(r) for r in utilization.connect().execute("SELECT id, seq, machine FROM utilizations")}
    assert rows["j1"]["seq"] == 1 and rows["j3"]["seq"] == 2 and rows["j2"]["seq"] == 1  # numbered per machine, in record order
    assert utilization.how(rows["j1"] | {"est_usd": 1.0, "tasks": 3, "est_model": "claude-fable-5-1", "orchestrator_model": "claude-fable-5-1"}) == "3 x sub-agent @ fable-5-1"
    assert utilization.summary(1)["html"].endswith("hswarm.html")
    text = utilization.render(utilization.summary(3))
    assert "x cheaper" in text and "#1" in text and "DeepSeek cost" in text


def test_session_model_reads_the_last_assistant_turn_of_the_transcript(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    monkeypatch.setattr(claude_usage, "PROJECTS", projects)
    sid = "11111111-2222-4333-8444-555555555555"
    lines = [
        json.dumps({"type": "assistant", "message": {"model": "claude-sonnet-5", "usage": {}}}),
        json.dumps({"type": "assistant", "message": {"model": "claude-fable-5-1", "usage": {}}}),
        # a later tool result that merely mentions a model string must not win
        json.dumps({"type": "user", "message": {"content": 'grep hit: "model":"claude-opus-5" "type":"assistant"'}}),
    ]
    (projects / "D--proj").mkdir(parents=True)
    (projects / "D--proj" / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert caller.session_model(sid) == "claude-fable-5-1"
    assert caller.session_model("no-such-session") == ""
    monkeypatch.setenv("HSWARM_ORCHESTRATOR_MODEL", "claude-opus-5")
    assert caller.session_model(sid) == "claude-opus-5"


def test_decide_books_its_jev_spend_as_a_utilization(tmp_path, monkeypatch):
    """hswarm_decide's Jev line used to reach utilization.record as a LEDGER row, which has no `id`, so every
    decide logged `record failed for None: KeyError: 'id'` and its spend never reached the savings database
    (3,070 times from 2026-09-21 to 2026-09-24, every Dredd docket among them)."""
    from hswarm import decisions, mcp_server

    _isolate(monkeypatch, tmp_path)
    monkeypatch.setattr(config, "HOME", tmp_path)
    monkeypatch.setattr(mcp_server, "detect_caller", lambda kind: {"instance": "7", "model": "claude-opus-5-5"})
    monkeypatch.setattr(mcp_server, "manager", lambda: None)

    async def fake_decide(items, mgr, **kw):
        return {"answers": [{"id": "a", "answer": "yes", "source": "jev"}], "summary": {"items": 1},
                "_jev_stats": {"calls": 3, "in": 120, "out": 9, "cost_usd": 0.0001, "secs": 0.4, "model": "jev-1.13.0"},
                "_stand_in_stats": None, "_fallback_results": []}

    monkeypatch.setattr(decisions, "decide", fake_decide)  # hswarm_decide imports it at call time
    out = asyncio.run(mcp_server.hswarm_decide([{"id": "a", "state": "x", "question": "q?", "type": "yesno"}]))
    assert "bookkeeping_error" not in out and "error" not in out
    c = utilization.connect()
    rows = [dict(r) for r in c.execute("SELECT * FROM utilizations").fetchall()]
    c.close()
    assert len(rows) == 1 and rows[0]["label"] == "decide" and rows[0]["worker_model"] == "jev-1.13.0"
    assert rows[0]["worker_usd"] == pytest.approx(0.0001) and rows[0]["orchestrator_model"] == "claude-opus-5-5"
    ledger = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert [(r["job"], r["provider"], r["calls"]) for r in ledger] == [("decide", "typesafe", 3)]


def test_old_db_migrates_to_a_stored_day_and_readers_cover_unbackfilled_rows(tmp_path):
    import sqlite3

    utilization.record({"id": "a", "ts": "2026-09-15T12:00:00+00:00", "kind": "run", "machine": utilization.MACHINE, "tasks": 1, "worker_usd": 0.01})
    c = utilization.connect()
    day = c.execute("SELECT day FROM utilizations WHERE id = 'a'").fetchone()[0]
    assert day == utilization.local_day("2026-09-15T12:00:00+00:00")
    c.execute("INSERT OR REPLACE INTO claude_days (machine, day, claude_usd, partial) VALUES (?, ?, 5.0, 0)", (utilization.MACHINE, day))
    c.commit()
    # A DB from before this change: no stored day on the row, version 0. The old rows must still be seen by the summary.
    c.execute("UPDATE utilizations SET day = NULL")
    c.commit()
    assert utilization.totals(c)["claude_days"] == 1  # fallback path while the backfill is incomplete
    c.execute("PRAGMA user_version = 0")
    c.close()
    c = utilization.connect()
    assert c.execute("PRAGMA user_version").fetchone()[0] == utilization.SCHEMA_VERSION
    assert c.execute("SELECT day FROM utilizations WHERE id = 'a'").fetchone()[0] == day
    names = {r[1] for r in c.execute("PRAGMA index_list(utilizations)")}
    assert {"utilizations_machine_day", "utilizations_machine_seq"} <= names
    assert utilization.totals(c)["claude_days"] == 1
