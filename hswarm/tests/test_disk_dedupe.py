"""Offline: what a job leaves on disk is written once, and still reads back whole.

The measurement behind this (2026-10-02, job 20261001-073621-cf71, 1,119 tasks): 300 transcripts held 0 blob refs
and 26.2 of their 38.5 MB were strings the job already had as blobs, because a routed transcript nests its messages
under {"routes": [...]}; job.json was 40.4 MB, 23.75 MB of it the results its journal already held and 3.69 MB one
schema repeated on every task."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import archive, blobs, config, keystate, utilization  # noqa: E402
from hswarm.client import ChatResult, KeyPool, Usage  # noqa: E402
from hswarm.job import Job  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402

K = ["sk-aaaa1111", "sk-bbbb2222", "sk-cccc3333"]


class _FakeClient:
    """Stands in for DeepSeekClient: every chat() answers OK."""

    async def chat(self, messages, **kw):
        await asyncio.sleep(0.01)
        return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


def _task(tid: str, tmp_path: Path, i: int = 0) -> Task:
    return Task.from_dict({"id": tid, "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, i)


def test_journal_packs_strings_inside_a_routes_transcript(tmp_path):
    system = "S" * 5000
    transcript = {"routes": [{"model": "deepseek-flash", "transcript": [
        {"role": "system", "content": system},
        {"role": "user", "content": "hi", "source_ref": "a worker's own field, not a blob"},
    ]}]}

    async def go():
        task = _task("t0", tmp_path)
        job = Job(id="20261002-000000-test", tasks=[task])
        JobManager(client=_FakeClient())._journal(job, task, Result(id="t0", status="ok", model="deepseek-flash"), transcript)
        return job

    job = asyncio.run(go())
    on_disk = (job.dir / "transcripts" / "t0.json").read_text(encoding="utf-8")
    assert system not in on_disk and "content_ref" in on_disk  # the 5,000 characters are in the blob, once
    assert archive.transcript(job.id, "t0") == transcript  # and the reader puts every field back exactly


def test_a_schema_repeated_on_every_task_is_one_blob(tmp_path):
    where = tmp_path / "blobs"
    schema = {"type": "object", "properties": {f"field_{i}": {"type": "string", "description": "one of many"} for i in range(60)}}
    tasks = [{"id": f"t{i}", "prompt": f"q{i}", "schema": schema, "concurrency": {"api": 2}} for i in range(20)]
    packed = blobs.pack_all(tasks, where)

    assert len(list(where.glob("*.txt"))) == 1  # twenty tasks, one blob for the part of the schema that is large
    assert len(json.dumps(packed)) * 10 < len(json.dumps(tasks))
    assert packed[0]["concurrency"] == {"api": 2}  # a small dict stays inline
    assert blobs.expand_all(packed, where) == tasks


def test_finished_record_does_not_repeat_journaled_results(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")

    async def go():
        return await JobManager(client=_FakeClient()).run_batch([_task("t0", tmp_path, 0), _task("t1", tmp_path, 1)], concurrency=1)

    job = asyncio.run(go())
    record = json.loads((job.dir / "job.json").read_text(encoding="utf-8"))
    assert record["state"] == "done" and not set(record["results"]) & {"t0", "t1"}, list(record["results"])

    def answers() -> dict:
        return {tid: (r["status"], r["answer"]) for tid, r in Job.load_from_disk(job.id)["results"].items()}

    want = {tid: ("ok", job.results[tid].answer) for tid in ("t0", "t1")}
    assert answers() == want  # read back from the journal in the folder
    assert archive.archive_job(job.dir, apply=True).get("error") is None and not job.dir.exists()
    assert answers() == want  # and from the journal inside the archive, once the folder is gone


def test_backfill_counts_a_finished_job_whose_results_are_in_its_journal(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setenv("HSWARM_ORCHESTRATOR_MODEL", "claude-opus-5")
    job_id = "20261002-010101-aaaa"
    record = {"summary": {"job_id": job_id, "label": "journaled", "state": "done", "created": "2026-10-02T01:01:01+00:00", "finished": "2026-10-02T01:02:31+00:00"},
              "caller": {"instance": "temp2", "session_id": "abcdef12-0000", "cwd": "D:/x"}, "tasks": [{"id": "t1"}, {"id": "t2"}], "results": {}}
    rows = [{"id": "t1", "status": "ok", "backend": "api", "model": "deepseek-flash", "usage": {"in_hit": 1, "in_miss": 2, "out": 3}, "cost_usd": 0.01, "seconds": 5},
            {"id": "t2", "status": "error", "backend": "api", "model": "deepseek-flash", "usage": {}, "cost_usd": 0.02, "seconds": 6}]
    (config.JOBS_DIR / job_id).mkdir(parents=True)
    (config.JOBS_DIR / job_id / "job.json").write_text(json.dumps(record), encoding="utf-8")
    (config.JOBS_DIR / job_id / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    assert utilization.backfill()["jobs"] == 1
    c = utilization.connect()
    row = dict(c.execute("SELECT * FROM utilizations WHERE id = ?", (job_id,)).fetchone())
    c.close()
    assert (row["tasks"], row["ok"], row["failed"]) == (2, 1, 1)


def test_a_rest_whose_write_found_the_database_locked_goes_out_with_the_next_one(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    monkeypatch.setattr(keystate, "LOCK_WAIT_S", 0.05)
    pool = KeyPool(K)
    holder = keystate.connect()
    holder.execute("BEGIN IMMEDIATE")  # another process mid-write
    pool.rest(K[1], 20.0, status=429)
    pool.flush()
    holder.execute("ROLLBACK")
    holder.close()
    assert KeyPool(K).status()[1]["resting_s"] == 0  # nothing reached the rows while it was locked

    pool.flush()
    assert KeyPool(K).status()[1]["resting_s"] > 0  # the rest was queued again, not dropped
