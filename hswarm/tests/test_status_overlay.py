"""Offline: a status read of a RUNNING job reflects the tasks that have already finished.

⛔ THE DEFECT (measured 2026-09-17). `job.json` is rewritten at checkpoints; `results.jsonl` is
appended the moment each task returns. Between those two, `hswarm status` reported a 34-task job as
`pending: 34` while every one of its results was already on disk - and the orchestrator watching it
spent eighteen minutes looking for a hang that did not exist. A status read that lags the facts it
summarises is worse than no status, because it is read as evidence.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.job import Job  # noqa: E402


def _write(job_dir: Path, doc: dict, rows: list[dict]) -> None:
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "job.json").write_text(json.dumps(doc), encoding="utf-8")
    if rows:
        (job_dir / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def _doc(job_id: str, *, finished: str = "", results: dict | None = None) -> dict:
    return {
        "summary": {
            "job_id": job_id,
            "label": "fixture",
            "state": "finished" if finished else "running",
            "tasks": 3,
            "counts": {"pending": 3},
            "cost_usd": 0.0,
            "cost_unknown_tasks": 0,
            "longest_task_s": 0.0,
            "finished": finished,
        },
        "tasks": [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}],
        "results": results or {},
    }


def test_a_running_job_reports_the_tasks_that_already_returned(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    job_id = "20260917-000000-test"
    _write(
        (tmp_path / "jobs" / job_id),
        _doc(job_id),
        [
            {"id": "t1", "status": "ok", "cost_usd": 0.01, "seconds": 12.0},
            {"id": "t2", "status": "error", "cost_usd": 0.02, "seconds": 3.5},
        ],
    )

    summary = Job.load_from_disk(job_id)["summary"]
    assert summary["counts"] == {"ok": 1, "error": 1, "pending": 1}, summary["counts"]
    assert summary["cost_usd"] == 0.03, summary["cost_usd"]
    assert summary["longest_task_s"] == 12.0, summary["longest_task_s"]


def test_a_half_written_last_line_is_skipped_not_raised(tmp_path, monkeypatch):
    # The file is being APPENDED to while it is read, so the last line can be a partial record.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    job_id = "20260917-000001-test"
    job_dir = tmp_path / "jobs" / job_id
    _write(job_dir, _doc(job_id), [{"id": "t1", "status": "ok", "cost_usd": 0.01, "seconds": 1.0}])
    with (job_dir / "results.jsonl").open("a", encoding="utf-8") as f:
        f.write('{"id": "t2", "status": "o')

    summary = Job.load_from_disk(job_id)["summary"]
    assert summary["counts"] == {"ok": 1, "pending": 2}, summary["counts"]


def test_a_finished_record_is_returned_untouched(tmp_path, monkeypatch):
    # A finished job's record is already whole, and is often served from the archive where no
    # results.jsonl sits beside it - overlaying there would be a second source of truth.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    job_id = "20260917-000002-test"
    doc = _doc(job_id, finished="2026-09-17T00:00:00+00:00", results={"t1": {"id": "t1", "status": "ok", "cost_usd": 0.5, "seconds": 9.0}})
    doc["summary"]["counts"] = {"ok": 3}
    doc["summary"]["cost_usd"] = 1.5
    _write((tmp_path / "jobs" / job_id), doc, [{"id": "t1", "status": "error", "cost_usd": 99.0, "seconds": 1.0}])

    summary = Job.load_from_disk(job_id)["summary"]
    assert summary["counts"] == {"ok": 3} and summary["cost_usd"] == 1.5, summary


def test_the_job_list_reports_running_jobs_live_too(tmp_path, monkeypatch):
    # `hswarm_jobs` lists jobs through list_on_disk, which read job.json's checkpoint summary raw. On
    # 2026-09-23 it showed every running job of a 10-pipeline build as "pending: all" - verify-sabri 178 of
    # 178 after 17 minutes with 52 results on disk - and the operator asked whether anything was working.
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    job_id = "20260917-000004-test"
    _write((tmp_path / "jobs" / job_id), _doc(job_id), [{"id": "t1", "status": "ok", "cost_usd": 0.01, "seconds": 2.0}])

    listed = {s["job_id"]: s for s in Job.list_on_disk(10)}
    assert listed[job_id]["counts"] == {"ok": 1, "pending": 2}, listed[job_id]["counts"]


def test_a_job_with_no_results_file_yet_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    job_id = "20260917-000003-test"
    _write((tmp_path / "jobs" / job_id), _doc(job_id), [])

    summary = Job.load_from_disk(job_id)["summary"]
    assert summary["counts"] == {"pending": 3}, summary["counts"]
