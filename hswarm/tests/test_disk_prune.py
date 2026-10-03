"""Offline: what grew under ~/.hswarm is kept and packed, never deleted, and one `maintain` run does it.

Measured 2026-10-02: spill 3,247 MiB (kept whole for 7 days), job archives 3,333 MiB, and up to 48 h of raw job
folders (2,397 MiB). The same day the owner ruled that all of it is kept ("Ideally, we would keep all of it, and you
would just figure out a way to properly compress"): spill past its day and jobs past their warm week go into the
history, one xz archive a day (history.py). The ledger is the long-term record of what jobs cost."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import archive, commands, config, history, report_html, savings, survival, utilization  # noqa: E402
from hswarm.cli import build_parser  # noqa: E402
from hswarm.tools import Sandbox, _cap, spill  # noqa: E402


def _id(hours_ago: float) -> str:
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)).strftime("%Y%m%d-%H%M%S") + "-aaaa"


def _folder(job_id: str, state: str = "done") -> Path:
    d = config.JOBS_DIR / job_id
    d.mkdir(parents=True)
    summary = {"job_id": job_id, "state": state, "checkpoint_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    (d / "job.json").write_text(json.dumps({"summary": summary, "tasks": [], "results": {}}), encoding="utf-8")
    return d


def _zip(job_id: str) -> Path:
    config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
    z = archive.archive_path(job_id)
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("job.json", json.dumps({"summary": {"job_id": job_id, "state": "done"}}))
    return z


def test_spill_caps_a_huge_output(tmp_path):
    handle = spill("x" * 5_000_000, tmp_path)
    assert (tmp_path / f"{handle}.txt").stat().st_size <= config.SPILL_MAX_BYTES


def test_the_marker_of_a_capped_spill_points_into_the_file_that_was_kept(tmp_path, monkeypatch):
    # Contract: when the spill keeps only the two ends, the marker's own start/end still return the chars that follow
    # the preview's head and precede its tail, and the gap is named instead of silently skipped.
    monkeypatch.setattr(config, "SPILL_MAX_BYTES", 40_000)
    text = "".join(f"line {i:05d}\n" for i in range(10_000))  # 110,000 chars
    out = _cap(text, 2000, tmp_path)
    marker = out[out.index("fetch_output("):]
    handle = marker.split('id="')[1].split('"')[0]
    start = int(marker.split("start=")[1].split(",")[0])
    end = int(marker.split("end=")[1].split(")")[0])
    assert (tmp_path / f"{handle}.txt").stat().st_size <= 40_000
    head, tail = out[:start], out[-(2000 // 3):]
    assert text.startswith(head) and text.endswith(tail)

    sb = Sandbox(tmp_path, max_output_chars=2000, spill_dir=tmp_path)
    after_head = asyncio.run(sb.run("fetch_output", {"id": handle, "start": start, "end": start + 300}))
    before_tail = asyncio.run(sb.run("fetch_output", {"id": handle, "start": end - 300, "end": end}))
    assert after_head == text[len(head):len(head) + 300]
    assert before_tail == text[len(text) - len(tail) - 300:len(text) - len(tail)]
    gap = asyncio.run(sb.run("fetch_output", {"id": handle, "start": 19_900, "end": 20_100}))
    assert "19900-90100" in gap  # (40,000 - 200) // 2 bytes kept at each end of 110,000


def test_a_spill_used_again_stays_another_window():
    # It leaves the spill folder a day after its LAST use: a long task paging one output must keep it there.
    handle = spill("the same output", config.SPILL_DIR)
    stale = time.time() - config.SPILL_RETENTION_S - 60
    os.utime(config.SPILL_DIR / f"{handle}.txt", (stale, stale))
    assert spill("the same output", config.SPILL_DIR) == handle
    assert history.pack_spill()["files"] == 0 and (config.SPILL_DIR / f"{handle}.txt").is_file()


def test_a_folder_left_beside_its_archive_never_replaces_the_archive(tmp_path):
    # Two packers (hourly pack, nightly maintain) can meet on one job: the second finds the folder half removed. What
    # is left of it must not be zipped over the complete archive.
    jid = _id(48)
    d = _folder(jid)
    (d / "results.jsonl").write_text('{"id": "t0"}\n', encoding="utf-8")
    archive.archive_job(d, apply=True)
    complete = archive.archive_path(jid).read_bytes()
    d.mkdir()
    (d / "job.json").write_text("{}", encoding="utf-8")  # the remainder: one file, and not the real one

    archive.archive_old(hours=24, apply=True)

    assert archive.archive_path(jid).read_bytes() == complete and not d.exists()


def test_a_folder_another_packer_is_writing_is_left_alone(tmp_path):
    d = _folder(_id(48))
    tmp = archive.archive_path(d.name).with_suffix(".zip.tmp")
    tmp.write_bytes(b"the other packer's work in progress")

    out = archive.archive_old(hours=24, apply=True)

    assert out["jobs"] == 0 and not out["errors"]
    assert d.is_dir() and tmp.read_bytes() == b"the other packer's work in progress"
    assert not archive.is_archived(d.name)


def test_one_maintain_run_keeps_everything_and_packs_what_is_past_its_working_life(tmp_path, monkeypatch):
    # The heavy steps of the daily pass (measure, score, sync, page) are not what this test is about.
    monkeypatch.setattr(savings, "lower_priority", lambda: None)
    monkeypatch.setattr(savings, "record", lambda backfill: [])
    monkeypatch.setattr(savings, "log", lambda line: None)
    monkeypatch.setattr(survival, "score_due", lambda: {"scored": 0})
    monkeypatch.setattr(utilization, "sync", lambda push: {"imported": 0, "pushed": False, "notes": []})
    monkeypatch.setattr(report_html, "write", lambda: tmp_path / "page.html")

    old_zip, week_old_zip, warm_zip = _zip(_id(15 * 24)), _zip(_id(9 * 24)), _zip(_id(3 * 24))
    finished, running, fresh = _folder(_id(30)), _folder(_id(31), "running"), _folder(_id(1))
    config.SPILL_DIR.mkdir()
    old_spill, new_spill = config.SPILL_DIR / "aaaaaaaaaaaaaaaa.txt", config.SPILL_DIR / "bbbbbbbbbbbbbbbb.txt"
    old_spill.write_text("x")
    new_spill.write_text("y")
    stale = time.time() - 25 * 3600
    os.utime(old_spill, (stale, stale))
    cc_old = config.CC_CONFIG_DIR / "projects" / "D--work" / "s1.jsonl"
    cc_new = config.CC_CONFIG_DIR / "projects" / "D--work" / "s2.jsonl"
    cc_old.parent.mkdir(parents=True)
    cc_old.write_text('{"type":"user"}\n', encoding="utf-8")
    cc_new.write_text('{"type":"user"}\n', encoding="utf-8")
    old = time.time() - 3 * 86400
    os.utime(cc_old, (old, old))
    ledger = config.HOME / "hswarm.sqlite"
    ledger.write_bytes(b"what every job cost")

    assert asyncio.run(commands.cmd_maintain(build_parser().parse_args(["maintain", "--quiet", "--no-push"]))) == 0

    # Jobs: nothing is deleted. Past the warm week a job joins its day's archive and still reads.
    for z in (old_zip, week_old_zip):
        assert not z.exists() and archive.read_json(z.stem, "job.json")["summary"]["job_id"] == z.stem
    assert warm_zip.is_file()
    assert not finished.exists() and archive.is_archived(finished.name)  # folders past 24 h are packed
    assert running.is_dir() and not archive.is_archived(running.name)  # but never out from under a live runner
    assert fresh.is_dir()
    # Spill a day past its last use, and cc transcripts idle two days, move into the history.
    assert not old_spill.exists() and new_spill.is_file()
    assert old_spill.name in history.read_index(history.SPILL, history._utc_day(stale))
    assert not cc_old.exists() and cc_new.is_file()
    assert "D--work/s1.jsonl" in history.read_index(history.CC, history._utc_day(old))
    assert ledger.read_bytes() == b"what every job cost"
