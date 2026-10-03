"""Offline: a job past its window becomes one compressed file, and every reader keeps working.

After the blob rewrite the job folders were still 115 MiB in 14,665 files plus 30 MiB of filesystem slack,
and all of it is text that compresses to about a fifth. A finished job never changes again, so past a few
hours it is packed into `<id>.zip` and the folder goes away (Michael, 2026-09-16)."""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import archive, blobs, config, history  # noqa: E402
from hswarm.job import Job  # noqa: E402

LONG = "You are a swarm worker. " + ("context line, " * 400)


def _job(job_id: str, tasks: int = 3) -> Path:
    d = config.JOBS_DIR / job_id
    (d / "transcripts").mkdir(parents=True)
    where = blobs.blob_dir(d)
    doc = {"summary": {"job_id": job_id, "state": "done", "tasks": tasks, "label": "unit"},
           "caller": {"instance": "m"}, "tasks": blobs.pack_all([{"id": f"t{i}", "prompt": f"q{i}", "system": LONG} for i in range(tasks)], where),
           "results": {f"t{i}": {"id": f"t{i}", "status": "ok", "answer": f"a{i}"} for i in range(tasks)}}
    (d / "job.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    for i in range(tasks):
        msgs = blobs.pack_all([{"role": "system", "content": LONG}, {"role": "user", "content": f"q{i}"}], where)
        (d / "transcripts" / f"t{i}.json").write_text(json.dumps(msgs, indent=1), encoding="utf-8")
    (d / "results.jsonl").write_text("".join(json.dumps({"id": f"t{i}"}) + "\n" for i in range(tasks)), encoding="utf-8")
    return d


def _id(hours_ago: float) -> str:
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)).strftime("%Y%m%d-%H%M%S") + "-aaaa"


def test_an_aged_job_packs_to_one_file_and_still_reads(tmp_path):
    old, new = _id(48), _id(0.1)
    _job(old, 4)
    _job(new, 2)
    before_doc = json.loads((config.JOBS_DIR / old / "job.json").read_text(encoding="utf-8"))
    before_tr = archive.transcript(old, "t2")
    assert before_tr[0]["content"] == LONG  # blobs expand from the folder

    dry = archive.archive_old(hours=24, apply=False)
    assert dry["jobs"] == 1 and dry["saved"] > dry["before"] * 0.5  # text compresses hard
    assert (config.JOBS_DIR / old).is_dir()  # a dry run moves nothing

    done = archive.archive_old(hours=24, apply=True)
    assert done["jobs"] == 1 and not (config.JOBS_DIR / old).exists() and archive.archive_path(old).is_file()
    assert (config.JOBS_DIR / new).is_dir()  # the fresh job is untouched

    # everything a reader can ask for still answers, out of the archive
    assert archive.read_json(old, "job.json") == before_doc
    assert archive.transcript(old, "t2") == before_tr
    assert archive.transcript(old, "t2")[0]["content"] == LONG
    assert archive.read_text(old, "results.jsonl").count("\n") == 4
    assert archive.transcript(old, "nope") is None and archive.read_json(old, "missing.json") is None
    assert sorted(archive.members(old, "transcripts/")) == [f"transcripts/t{i}.json" for i in range(4)]
    assert archive.is_archived(old) and not archive.is_archived(new)
    assert archive.job_ids() == sorted([old, new], reverse=True)

    assert Job.load_from_disk(old)["summary"]["label"] == "unit"  # the job record, via the archive
    assert {s["job_id"] for s in Job.list_on_disk(10)} == {old, new}
    assert [p.name for p, _ in Job.prunable(1)] == [old + ".zip"]  # an archive is still prunable cache


def test_archiving_is_atomic_and_never_leaves_a_half_written_job(tmp_path, monkeypatch):
    jid = _id(48)
    d = _job(jid, 2)
    files = {f.relative_to(d).as_posix() for f in d.rglob("*") if f.is_file()}

    boom = zipfile.ZipFile

    class Exploding(zipfile.ZipFile):
        def write(self, *args, **kw):  # fail midway through writing members
            if getattr(self, "_n", 0) >= 1:
                raise OSError("disk full")
            self._n = getattr(self, "_n", 0) + 1
            return boom.write(self, *args, **kw)

    monkeypatch.setattr(zipfile, "ZipFile", Exploding)
    with pytest.raises(OSError):
        archive.archive_job(d, apply=True)
    monkeypatch.setattr(zipfile, "ZipFile", boom)
    assert d.is_dir() and {f.relative_to(d).as_posix() for f in d.rglob("*") if f.is_file()} == files
    assert not archive.archive_path(jid).is_file()  # only the .tmp could exist, never the real name

    assert archive.archive_job(d, apply=True)["saved"] > 0  # and a retry succeeds
    assert archive.is_archived(jid) and not d.exists()


def test_unpack_puts_a_job_back_as_a_folder(tmp_path):
    jid = _id(48)
    _job(jid, 2)
    original = archive.transcript(jid, "t1")
    archive.archive_old(hours=24, apply=True)
    assert not (config.JOBS_DIR / jid).exists()

    out = archive.unpack(jid)
    assert out and out.is_dir() and (out / "job.json").is_file()
    assert archive.transcript(jid, "t1") == original  # reads the folder now, same content
    assert archive.unpack("no-such-job") is None


def test_a_job_past_its_warm_week_reads_from_the_days_history_archive(tmp_path):
    # Owner, 2026-10-02: keep every job, compressed ("I'd like you to be able to learn from previous experience").
    # Past COLD_AFTER_DAYS a job's zip joins its day's archive; every reader goes on finding it there.
    cold, other, warm = _id(24 * 9), _id(24 * 9 - 0.01), _id(24 * 3)
    for jid, n in ((cold, 4), (other, 2), (warm, 2)):
        _job(jid, n)
    before_doc = archive.read_json(cold, "job.json")
    before_tr = archive.transcript(cold, "t2")
    archive.archive_old(hours=24, apply=True)

    packed = history.pack_jobs()

    assert packed["jobs"] == 2 and not packed["errors"]
    assert not archive.archive_path(cold).exists() and archive.archive_path(warm).is_file()  # the warm week stays a zip
    assert history.day_path(history.JOBS, cold[:8]).is_file()
    assert archive.is_archived(cold) and cold in archive.job_ids() and other in archive.job_ids()
    assert archive.read_json(cold, "job.json") == before_doc
    assert archive.transcript(cold, "t2") == before_tr and before_tr[0]["content"] == LONG  # blobs expand from history
    assert sorted(archive.members(cold, "transcripts/")) == [f"transcripts/t{i}.json" for i in range(4)]
    assert Job.load_from_disk(cold)["summary"]["label"] == "unit"
    assert archive.read_text(cold, "missing.json") is None

    # A late zip of the same day joins the archive without losing what it already held.
    late = cold[:8] + "-235959-bbbb"
    _job(late, 1)
    archive.archive_old(hours=0, apply=True)
    history.pack_jobs()
    assert archive.read_json(late, "job.json")["summary"]["tasks"] == 1
    assert archive.read_json(cold, "job.json") == before_doc

    # A zip of a job the archive already holds, but with other contents, replaces the job whole: none of its old
    # members stay behind to split it (background review, 2026-10-02).
    with zipfile.ZipFile(archive.archive_path(cold), "w") as zf:
        zf.writestr("job.json", json.dumps({"summary": {"job_id": cold, "label": "redone"}}))
    history.pack_jobs()
    assert archive.read_json(cold, "job.json")["summary"]["label"] == "redone"
    assert archive.members(cold) == ["job.json"] and not archive.archive_path(cold).exists()


def test_a_packer_never_takes_another_ones_work_and_a_damaged_day_keeps_its_sources(tmp_path):
    busy, broken, fine = _id(24 * 12), _id(24 * 11), _id(24 * 10)
    for jid in (busy, broken, fine):
        _job(jid, 1)
    archive.archive_old(hours=24, apply=True)
    history.day_path(history.JOBS, busy[:8]).parent.mkdir(parents=True)
    tmp = history.day_path(history.JOBS, busy[:8]).with_name(busy[:8] + history.SUFFIX + ".tmp")
    tmp.write_bytes(b"another packer's half-written archive")
    history.day_path(history.JOBS, broken[:8]).write_bytes(b"\xfd7zXZ cut short")
    history.index_path(history.JOBS, broken[:8]).write_text("{}", encoding="utf-8")

    out = history.pack_jobs()

    assert len(out["errors"]) == 2 and out["jobs"] == 1  # the busy and the damaged day: reported, not raised
    assert tmp.read_bytes() == b"another packer's half-written archive"
    assert archive.archive_path(busy).is_file() and archive.archive_path(broken).is_file()  # their sources stay
    assert not archive.archive_path(fine).exists() and archive.read_json(fine, "job.json") is not None

    # A .tmp nobody has written to for STALE_TMP_S is a packer that died: it no longer holds the day back.
    old = time.time() - history.STALE_TMP_S - 60
    os.utime(tmp, (old, old))
    assert history.pack_jobs()["jobs"] == 1
    assert not archive.archive_path(busy).exists() and archive.read_json(busy, "job.json") is not None


def test_keep_days_reaches_jobs_already_packed(tmp_path):
    old = _id(24 * 20)
    _job(old, 1)
    archive.archive_old(hours=24, apply=True)
    history.pack_jobs()
    assert old in archive.job_ids() and archive.read_json(old, "job.json") is not None  # read: now cached

    gone = archive.prune_old(14)

    assert gone["jobs"] == 1 and old not in archive.job_ids()
    assert archive.read_json(old, "job.json") is None  # never answered from what the pruned day held
    assert not history.day_path(history.JOBS, old[:8]).exists()
