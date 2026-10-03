"""Cold jobs become one compressed file each; hot jobs stay as folders.

Measured 2026-09-16 after the blob rewrite: 115 MiB of job records in 14,665 files, plus 30 MiB of
filesystem slack because most of those files are smaller than a 4 KiB cluster. Everything in them is text
and compresses hard (job.json to 6%, transcripts to 15%, blobs to 28% under LZMA), so a finished job is
worth about a fifth of its size and a single file instead of seventy.

The split is by age, not by importance (owner ask, Michael, 2026-09-16: "have the compression auto-apply
after 24 hours or 6 hours"). A job younger than the window stays a plain folder: it is cheap to write, easy
to look at, and may still be read while the work is fresh. Past the window a job never changes again, so it
is packed into `<job-id>.zip` and the folder is removed. Every reader here checks the folder first and the
archive second, so nothing above this module knows the difference.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import shutil
import zipfile
from pathlib import Path

from . import blobs, config, history

SUFFIX = ".zip"
DEFAULT_HOURS = 24
# LZMA: stdlib, and measured on this data at roughly half the size of deflate for the JSON members.
COMPRESSION = zipfile.ZIP_LZMA


def archive_path(job_id: str) -> Path:
    return config.JOBS_DIR / f"{job_id}{SUFFIX}"


def job_dir(job_id: str) -> Path:
    return config.JOBS_DIR / job_id


def is_archived(job_id: str) -> bool:
    return archive_path(job_id).is_file() or job_id in history.cold_jobs()


def job_ids(limit: int | None = None) -> list[str]:
    """Every job on disk, newest first: folders, archives and the jobs in cold history alike (the id sorts
    chronologically)."""
    ids = set(history.cold_jobs())
    if not config.JOBS_DIR.exists():
        return sorted(ids, reverse=True)[:limit] if limit else sorted(ids, reverse=True)
    # scandir answers is_dir from the directory read itself: iterdir + is_dir stat'ed each of 5,354 entries,
    # 0.27-0.37 s a call against 0.02 s, on every hswarm_jobs and every 3 s console poll.
    with os.scandir(config.JOBS_DIR) as entries:
        for e in entries:
            if e.is_dir():
                ids.add(e.name)
            elif e.name.endswith(SUFFIX):
                ids.add(e.name[:-len(SUFFIX)])
    out = sorted(ids, reverse=True)
    return out[:limit] if limit else out


def read_text(job_id: str, member: str) -> str | None:
    """A file from a job, whether it is a folder or an archive. `member` is a posix path like
    "transcripts/t1.json". None when it is not there."""
    p = job_dir(job_id) / member
    if p.is_file():
        try:
            with open(p, encoding="utf-8", newline="") as f:
                return f.read()
        except OSError:
            return None
    z = archive_path(job_id)
    if not z.is_file():
        data = history.read_job_member(job_id, member)  # past its warm week: the day's archive
        return None if data is None else data.decode("utf-8")
    try:
        with zipfile.ZipFile(z) as zf:
            return zf.read(member).decode("utf-8")
    except (OSError, KeyError, zipfile.BadZipFile):
        return None


def read_json(job_id: str, member: str):
    raw = read_text(job_id, member)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def members(job_id: str, prefix: str = "") -> list[str]:
    """Member names under `prefix`, from the folder or the archive."""
    d = job_dir(job_id)
    if d.is_dir():
        base = d / prefix if prefix else d
        if not base.is_dir():
            return []
        return sorted((f.relative_to(d).as_posix()) for f in base.iterdir() if f.is_file())
    z = archive_path(job_id)
    if not z.is_file():
        return history.job_members(job_id, prefix)
    try:
        with zipfile.ZipFile(z) as zf:
            return sorted(n for n in zf.namelist() if n.startswith(prefix) and not n.endswith("/"))
    except (OSError, zipfile.BadZipFile):
        return []


def blob_reader(job_id: str):
    """A reader for blobs.expand_with that works against a folder or an archive, caching what it opens."""
    cache: dict[str, str | None] = {}

    def read(sha: str) -> str | None:
        if sha not in cache:
            cache[sha] = read_text(job_id, f"{blobs.BLOBS}/{sha}.txt")
        return cache[sha]

    return read


def transcript(job_id: str, task_id: str):
    """One task's transcript with its blobs expanded, from wherever the job lives. None when absent."""
    doc = read_json(job_id, f"transcripts/{task_id}.json")
    return None if doc is None else blobs.expand_any_with(doc, blob_reader(job_id))


# ---- packing -------------------------------------------------------------------------------------

def older_than(hours: float) -> list[Path]:
    """Job FOLDERS whose id is older than `hours`. The id is a UTC timestamp, so it is the age test."""
    if not config.JOBS_DIR.exists():
        return []
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=max(0.0, hours))).strftime("%Y%m%d-%H%M%S")
    return [d for d in sorted(config.JOBS_DIR.iterdir()) if d.is_dir() and d.name < cutoff]


def archive_job(d: Path, apply: bool = False) -> dict:
    """Pack one job folder into `<id>.zip` and remove the folder. Returns {before, after, saved} in bytes.

    The archive is written to a temporary name and moved into place, and the folder is only deleted once
    every member has been read back from the finished archive, so an interrupted run leaves either the
    folder or a complete archive, never a half of each."""
    d = Path(d)
    files = [f for f in sorted(d.rglob("*")) if f.is_file()]
    before = sum(f.stat().st_size for f in files)
    if not files:
        return {"before": 0, "after": 0, "saved": 0}
    if not apply:  # measure honestly: compress into memory, keep nothing
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", COMPRESSION) as zf:
            for f in files:
                zf.write(f, f.relative_to(d).as_posix())
        after = buf.tell()
        return {"before": before, "after": after, "saved": max(0, before - after)}

    final = archive_path(d.name)
    if final.is_file():
        # An archive only gets its real name after it verified against the whole folder, so a folder beside one is
        # what a removal left behind (the other packer still deleting, or a file a reader held open). Zipping that
        # remainder over the archive would lose the job's transcripts: finish the removal, never replace.
        shutil.rmtree(d, ignore_errors=True)
        after = final.stat().st_size
        return {"before": before, "after": after, "saved": max(0, before - after)}
    tmp = final.with_suffix(".zip.tmp")
    try:  # a .tmp untouched for an hour (the pack cadence) belongs to a packer that died, not one at work
        if dt.datetime.now().timestamp() - tmp.stat().st_mtime > 3600:
            tmp.unlink()
    except OSError:
        pass
    try:
        zf = zipfile.ZipFile(tmp, "x", COMPRESSION)
    except FileExistsError:
        # The hourly pack and the nightly maintain are two processes and can meet on one folder (both catch up at
        # start after the machine was off). The .tmp is the other one's work in progress: leave it and the folder.
        return {"before": 0, "after": 0, "saved": 0}
    try:
        with zf:
            for f in files:
                zf.write(f, f.relative_to(d).as_posix())
        with zipfile.ZipFile(tmp) as zf:
            if zf.testzip() is not None or len(zf.namelist()) != len(files):
                tmp.unlink(missing_ok=True)
                return {"before": before, "after": before, "saved": 0, "error": f"archive of {d.name} did not verify"}
        os.replace(tmp, final)
    except (OSError, zipfile.BadZipFile):
        # This run's own half-written .tmp must not block the retry.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    shutil.rmtree(d, ignore_errors=True)
    after = final.stat().st_size
    return {"before": before, "after": after, "saved": max(0, before - after)}


def _running(d: Path) -> bool:
    """A job folder whose record says a live process is still working on it (a quiet one reads as orphaned)."""
    from .job import Job

    try:
        return Job.load_from_disk(d.name)["summary"].get("state") == "running"
    except (KeyError, TypeError, AttributeError):
        return False


def archive_old(hours: float = DEFAULT_HOURS, apply: bool = False) -> dict:
    """Pack every job folder past the window. Dry run reports what it would save. A job still running is left
    alone (packing removes the folder its runner writes to), and one folder that fails is a note, not the end of
    the pass: the scheduled runs go on to the rest."""
    out = {"jobs": 0, "before": 0, "after": 0, "saved": 0, "errors": []}
    for d in older_than(hours):
        if _running(d):
            continue
        try:
            r = archive_job(d, apply)
        except (OSError, zipfile.BadZipFile) as exc:
            out["errors"].append(f"archive of {d.name} failed: {exc}")
            continue
        if not r["before"]:
            continue
        out["jobs"] += 1
        for k in ("before", "after", "saved"):
            out[k] += r[k]
        if r.get("error"):
            out["errors"].append(r["error"])
    return out


def prune_old(days: int) -> dict:
    """Delete every job past `days`, archive or folder (Job.prunable: a cache of delivered work). Only files under
    JOBS_DIR go; the ledger and the savings DB, which hold what each job cost, are never opened here."""
    from .job import Job

    out = {"jobs": 0, "freed": 0}
    for p, size in Job.prunable(days):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                p.unlink()
            except OSError:
                continue  # open in a reader right now: the next pass takes it
        out["jobs"] += 1
        out["freed"] += size
    # Packed days too, or --keep-days past COLD_AFTER_DAYS would keep every job anyway (review, 2026-10-02). Only a
    # day entirely past the cutoff goes: an archive holds a whole UTC day.
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max(0, days))).strftime("%Y%m%d")
    for packed in sorted((config.HISTORY_DIR / history.JOBS).glob(f"*{history.SUFFIX}")):
        day = packed.name[:8]
        if not day.isdigit() or day >= cutoff:
            continue
        jobs = {m.split("/", 1)[0] for m in history.read_index(history.JOBS, day)}
        try:
            size = packed.stat().st_size
            packed.unlink()
        except OSError:
            continue
        history.index_path(history.JOBS, day).unlink(missing_ok=True)
        out["jobs"] += len(jobs)
        out["freed"] += size
    return out


def unpack(job_id: str) -> Path | None:
    """Put an archived job back as a folder (for poking at it by hand). The archive is left in place."""
    z = archive_path(job_id)
    d = job_dir(job_id)
    if not z.is_file():
        if d.is_dir() or job_id not in history.cold_jobs():
            return d if d.is_dir() else None
        for member in history.job_members(job_id):
            data = history.read_job_member(job_id, member)
            if data is not None:
                (d / member).parent.mkdir(parents=True, exist_ok=True)
                (d / member).write_bytes(data)
        return d
    d.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(z) as zf:
        zf.extractall(d)
    return d
