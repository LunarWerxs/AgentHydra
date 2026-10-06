"""Offline: what the MCP answers of hswarm_status, hswarm_results, hswarm_cancel and hswarm_jobs carry.

Measured 2026-10-02 over the last 300 jobs: a schema answer came back twice (32.6% of hswarm_results bytes), every
row AUTO routed carried ~2.9 KB of routing record (22%), `data` ignored max_answer_chars (a 200-char request returned
360 KB), every status poll repeated ~580 chars of bookkeeping, and a re-poll re-sent the rows the chat already had.
The record on disk keeps every field; these pin what an answer leaves out and what it must never leave out.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import archive, mcp_server  # noqa: E402
from hswarm.job import Job  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task, now_iso  # noqa: E402

FINISHED = "2026-10-02T00:00:00+00:00"
# AUTO's record as dispatch stores it on a result its first leg served.
FULL = {"profile": "code", "evidence_date": "2026-09-25", "requirements": {"swe": 60},
        "rejected": [{"model": f"m{i}", "filter": "usable", "reason": "no key"} for i in range(48)],
        "candidates": [{"model": "served", "scores": {"swe": 71}}],
        "warnings": ["Floors are operational policy, not a guarantee; the orchestrator verifies task acceptance."],
        "selected": {"model": "served", "configuration": "Served (high)"},
        "attempts": [{"model": "served", "status": "ok", "error": None}]}


def _job(tmp_path, job_id: str, results: list[Result], state: str = "done") -> Job:
    tasks = [Task.from_dict({"id": r.id, "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, n)
             for n, r in enumerate(results)]
    job = Job(id=job_id, tasks=tasks, label="fixture", state=state, finished=FINISHED if state == "done" else "")
    job.results = {r.id: r for r in results}
    return job


def _serve(monkeypatch, *live: Job) -> None:
    """The server process holds `live`; any other job id is read from its record on disk."""
    m = JobManager()
    m.jobs = {j.id: j for j in live}
    monkeypatch.setattr(mcp_server, "manager", lambda: m)


def _rows(job_id: str, **kw) -> dict[str, dict]:
    out = asyncio.run(mcp_server.hswarm_results(job_id, **kw))
    return {r["id"]: r for r in out["results"]}


def test_status_cancel_and_the_job_list_answer_without_the_bookkeeping(tmp_path, monkeypatch):
    job = _job(tmp_path, "20261002-000000-aaaa", [Result(id="t1", status="ok", cost_usd=0.01, finished=FINISHED),
                                                  Result(id="t2", status="ok", mis_scoped=True, finished=FINISHED)])
    job.save()
    _serve(monkeypatch)

    # mis_scoped is on the record only when it matters ("do not trust it"), so it stays; dir, caller, savings,
    # created, finished, checkpoint_at, a null budget, zero unknown costs and the task ages do not. Tokens lead every
    # view (8ae38d70), so they stay.
    brief = {"job_id": job.id, "label": "fixture", "state": "done", "counts": {"ok": 2}, "cost_usd": 0.01, "tokens": 0, "mis_scoped": ["t2"]}
    assert asyncio.run(mcp_server.hswarm_status(job.id)) == brief
    assert asyncio.run(mcp_server.hswarm_cancel(job.id)) == brief  # already finished: nothing to cancel, same answer
    assert asyncio.run(mcp_server.hswarm_jobs(5)) == [brief]
    full = asyncio.run(mcp_server.hswarm_status(job.id, verbose=True))
    assert full["dir"] == str(job.dir) and full["created"] == job.created and full["finished"] == FINISHED
    assert asyncio.run(mcp_server.hswarm_jobs(5, verbose=True))[0]["created"] == job.created  # the console's jobs page


def test_disk_status_reads_a_finished_record_once(tmp_path, monkeypatch):
    # Job cf71: every poll of a job this server did not hold read and parsed the whole record (0.17 s + 0.35 s)
    # for an ~800-byte summary, on the loop every chat shares.
    job = _job(tmp_path, "20261002-000001-bbbb", [Result(id="t1", status="ok", finished=FINISHED)])
    job.save()
    _serve(monkeypatch)
    reads, real = [], archive.read_json
    monkeypatch.setattr(archive, "read_json", lambda job_id, member: reads.append(member) or real(job_id, member))

    assert asyncio.run(mcp_server.hswarm_status(job.id))["state"] == "done"
    assert asyncio.run(mcp_server.hswarm_status(job.id))["counts"] == {"ok": 1}
    assert reads == ["job.json"], reads
    job.label = "rewritten since the first read"
    job.save()  # a rewrite changes the record's stamp: the cached summary must not outlive it
    assert asyncio.run(mcp_server.hswarm_status(job.id))["label"] == "rewritten since the first read"


def test_a_schema_row_carries_its_data_once_and_only_the_fields_that_are_set(tmp_path, monkeypatch):
    job = _job(tmp_path, "20261002-000002-cccc", [
        Result(id="dup", status="ok", data={"a": 1}, answer='{"a": 1}', started=FINISHED, finished=FINISHED),
        Result(id="prose", status="ok", data={"a": 1}, answer="Looked at both files: a is 1.", finished=FINISHED),
        Result(id="none", status="ok", data=[], answer="[]", finished=FINISHED)])
    job.save()
    _serve(monkeypatch)

    rows = _rows(job.id)
    dup = rows["dup"]
    assert dup["data"] == {"a": 1} and "answer" not in dup
    assert not [k for k, v in dup.items() if v in (None, "", [], {})], dup
    assert not {"started", "progress_at", "usage"} & set(dup)
    assert dup["cost_usd"] == 0.0  # free is said; only an unknown cost is left out
    assert rows["prose"]["answer"] == "Looked at both files: a is 1." and rows["prose"]["data"] == {"a": 1}
    assert rows["none"]["data"] == []  # "no findings" is an answer, not an empty field
    # the same row from a job the server still holds
    _serve(monkeypatch, job)
    assert _rows(job.id) == rows


def test_data_over_the_cap_is_cut_and_says_how_to_fetch_it(tmp_path, monkeypatch):
    data = {"items": [{"n": i, "text": "x" * 40} for i in range(1000)]}
    job = _job(tmp_path, "20261002-000003-dddd", [Result(id="big", status="ok", data=data, answer=json.dumps(data), finished=FINISHED)])
    job.save()
    _serve(monkeypatch)

    row = _rows(job.id, max_answer_chars=200)["big"]
    assert len(json.dumps(row)) < 1000, len(json.dumps(row))
    assert row["data_truncated"] > 50_000 and f"max_answer_chars={row['data_truncated']}" in row["data"]
    whole = _rows(job.id, ids=["big"], max_answer_chars=row["data_truncated"])["big"]  # the call the hint names
    assert whole["data"] == data and "data_truncated" not in whole


def test_a_row_names_only_the_legs_that_failed_and_keeps_a_below_floor_warning(tmp_path, monkeypatch):
    saturated = {"model": "first", "status": "error", "error": "PoolSaturated: every key resting"}
    verify_it = "Every code route was crawling or failed, so a general profile model answered: verify it."
    job = _job(tmp_path, "20261002-000004-eeee", [
        Result(id="ok", status="ok", model="served", answer="done", selection=FULL),
        Result(id="moved", status="ok", model="served", answer="done", selection={**FULL, "attempts": [saturated, FULL["attempts"][0]]}),
        Result(id="rescued", status="ok", model="served", answer="done",
               selection={**FULL, "below_floor": "general", "warnings": [verify_it] + FULL["warnings"]}),
        Result(id="noroute", status="error", error="NoCapableSwarmRoute: nothing meets the code floors", selection=FULL)])
    job.save()
    _serve(monkeypatch)

    rows = _rows(job.id)
    assert "selection" not in rows["ok"]
    assert rows["moved"]["selection"] == {"attempts": [{"model": "first", "error": "PoolSaturated: every key resting"}]}
    assert rows["rescued"]["selection"] == {"below_floor": "general", "warnings": [verify_it]}
    assert rows["noroute"]["selection"] == FULL  # there the record IS the answer
    assert _rows(job.id, include_selection=True)["ok"]["selection"] == FULL


def test_queued_ids_past_a_handful_come_back_as_a_count(tmp_path, monkeypatch):
    job = _job(tmp_path, "20261002-000005-ffff", [Result(id=f"t{i}", status="pending") for i in range(80)], state="running")
    _serve(monkeypatch, job)

    out = asyncio.run(mcp_server.hswarm_results(job.id))
    assert out["pending"] == 80 and "80 queued" in out["hint"]
    assert asyncio.run(mcp_server.hswarm_results(job.id, status="pending"))["pending"] == [f"t{i}" for i in range(80)]


def test_a_cursor_returns_only_the_rows_that_finished_since(tmp_path, monkeypatch):
    job = _job(tmp_path, "20261002-000006-abcd", [Result(id="a", status="ok", answer="A", finished=FINISHED),
                                                  Result(id="b", status="ok", answer="B", finished=FINISHED),
                                                  Result(id="c", status="running", started=now_iso())], state="running")
    _serve(monkeypatch, job)

    first = asyncio.run(mcp_server.hswarm_results(job.id))
    assert [r["id"] for r in first["results"]] == ["a", "b"]
    # A scripted or verified task is held at "running" past its own `finished` stamp: it turns visible AFTER the
    # first answer with a stamp from BEFORE it, which a time cursor would skip for good.
    job.results["c"] = Result(id="c", status="ok", answer="C", finished=FINISHED)
    second = asyncio.run(mcp_server.hswarm_results(job.id, since=first["cursor"]))
    assert [r["id"] for r in second["results"]] == ["c"] and second["already_delivered"] == 2
    assert second["summary"]["counts"] == {"ok": 3}  # the rows left out are still counted
    third = asyncio.run(mcp_server.hswarm_results(job.id, since=second["cursor"]))
    assert third["results"] == [] and third["already_delivered"] == 3
    assert "not a cursor" in asyncio.run(mcp_server.hswarm_results(job.id, since="2026-10-02T00:00:00"))["error"]


def test_a_row_cancelled_by_a_server_stop_comes_back_once_it_is_run_again(tmp_path, monkeypatch):
    # A server stop journals the task in flight as `cancelled` while the job stays running; the next server runs it
    # again (jobs._journaled). A cursor that marked the cancelled row would hide the real answer for good.
    job = _job(tmp_path, "20261002-000007-bcde", [Result(id="a", status="ok", answer="A", finished=FINISHED),
                                                  Result(id="b", status="cancelled", finished=FINISHED)], state="running")
    _serve(monkeypatch, job)

    first = asyncio.run(mcp_server.hswarm_results(job.id))
    assert [r["id"] for r in first["results"]] == ["a", "b"]
    job.results["b"] = Result(id="b", status="ok", answer="B", finished=FINISHED)
    second = asyncio.run(mcp_server.hswarm_results(job.id, since=first["cursor"]))
    assert [(r["id"], r["answer"]) for r in second["results"]] == [("b", "B")] and second["already_delivered"] == 1
    # In a finished job a cancelled row is final: it is delivered once.
    job.results["b"], job.state, job.finished = Result(id="b", status="cancelled", finished=FINISHED), "cancelled", FINISHED
    last = asyncio.run(mcp_server.hswarm_results(job.id, since=asyncio.run(mcp_server.hswarm_results(job.id))["cursor"]))
    assert last["results"] == [] and last["already_delivered"] == 2
