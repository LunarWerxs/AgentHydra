"""Offline: every finished task becomes one row, and a task that names no cap gets one sized from its own shape.

Over 7 days to 2026-10-02 the flat per-profile default killed 1,216 tasks with the work they had paid for ($404)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import archive, config, history, taskstore  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def _job(job_id: str, cost: float, status: str = "ok", finished: bool = True, journaled: bool = False) -> None:
    d = config.JOBS_DIR / job_id
    d.mkdir(parents=True)
    doc = {"summary": {"job_id": job_id, "label": "unit", "created": "2099-01-01T00:00:00+00:00",
                       "finished": "2099-01-01T00:01:00+00:00" if finished else ""},
           "tasks": [{"id": "t1", "prompt": "read the repo and say", "tools": "read", "profile": "research",
                      "backend": "api", "max_cost_usd": 1.5}],
           "results": {"t1": {"id": "t1", "status": status, "model": "m", "cost_usd": cost, "seconds": 9.0,
                              "usage": {"in_hit": 10, "in_miss": 5, "out": 7}, "turns": 3}}}
    if journaled:  # how Job.save writes a finished job since dad8ce6: the results only in results.jsonl
        (d / "results.jsonl").write_text(json.dumps(doc["results"]["t1"]) + "\n", encoding="utf-8")
        doc["results"] = {}
    (d / "job.json").write_text(json.dumps(doc), encoding="utf-8")


def test_finished_jobs_are_indexed_once_and_a_running_one_waits():
    _job("20990101-000000-aaaa", 0.5, journaled=True)  # its results only in results.jsonl, as every job saves now
    _job("20990101-000001-bbbb", 0.1, finished=False)
    bad = config.JOBS_DIR / "20990101-000002-cccc"
    bad.mkdir()
    (bad / "job.json").write_bytes(b'{"summary": {"finished": "x", "label": "\xff"}}')  # not UTF-8: a damaged record

    first = taskstore.index_jobs()
    again = taskstore.index_jobs()

    assert first == {"jobs": 1, "tasks": 1, "skipped": 1, "errors": 1}
    assert again == {"jobs": 0, "tasks": 0, "skipped": 1, "errors": 1}  # the damaged one is tried again, never fatal
    row = taskstore.report(days=10000)[0]
    assert row["profile"] == "research" and row["tools"] == "read" and row["size"] == "s"
    assert (row["tasks"], row["ok"], row["cost_usd"]) == (1, 1, 0.5)


def test_a_cold_day_is_read_once_and_a_packed_job_that_never_finished_is_not_read_again(monkeypatch):
    # 2026-10-08: each cold job was read on its own, a pass over its day's archive up to it (2026-09-23: 438 MiB, 40 s
    # a pass, 410 jobs), and the 72 that never finished were read again every night: maintain hit its two-hour limit
    # in this step every night from 2026-10-04 on, and never reached the packing, the savings record or the page.
    for i in range(3):
        _job(f"20200101-00000{i}-aaaa", 0.5, journaled=True)
    _job("20200101-000009-dddd", 0.1, finished=False)  # stopped mid-run: once packed, it can never finish
    archive.archive_old(hours=0, apply=True)
    assert history.pack_jobs()["jobs"] == 4
    history._job_cache.clear()
    passes = []
    real = history._members
    monkeypatch.setattr(history, "_members", lambda path: passes.append(path) or real(path))

    first = taskstore.index_jobs()
    again = taskstore.index_jobs()

    assert first == {"jobs": 4, "tasks": 4, "skipped": 0, "errors": 0}  # the unfinished job's one finished task too
    assert again == {"jobs": 0, "tasks": 0, "skipped": 0, "errors": 0}
    assert len(passes) == 1  # one pass over the day, not one per job, and none the night after


def test_a_task_with_no_named_cap_gets_one_its_shape_has_needed():
    # 30 finished research/read tasks spending $2.00-$2.29: their p95 x 1.5 is above the $1.50 default, so an unnamed
    # cap rises to it, never past 4x the default; a named cap always wins.
    con = taskstore.connect()
    rows = [(f"20990101-0000{i:02d}-aaaa", "t1", "2099-01-01T00:00:00", "", "", "api", "research", "", "read", 0, 0, 20,
             "s", "", "m", "ok", "", "", 2.0 + i / 100, 1.5, 9.0, 600.0, 3, 1, 15, 7, 1) for i in range(30)]
    with con:
        con.executemany(f"INSERT INTO tasks VALUES ({','.join('?' * 27)})", rows)
    con.close()

    sized = Task.from_dict({"prompt": "read the repo and say", "profile": "research", "tools": "read"}, {}, 0)
    named = Task.from_dict({"prompt": "read the repo and say", "profile": "research", "tools": "read", "max_cost_usd": 1.0}, {}, 0)
    other = Task.from_dict({"prompt": "read the repo and say", "profile": "code", "tools": "read"}, {}, 0)

    assert sized.max_cost_usd == round(2.28 * 1.5, 4)  # p95 of 2.00..2.29 is 2.28
    assert named.max_cost_usd == 1.0
    assert other.max_cost_usd == config.default_max_cost_usd("code", "read")  # no history of its shape: the default
