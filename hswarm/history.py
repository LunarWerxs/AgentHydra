"""Cold history: nothing hswarm records is deleted; what is past its working life is packed, one archive a day.

Owner, Michael, 2026-10-02, on whether job archives should be kept 14 days or 7: "Ideally, we would keep all of it,
and you would just figure out a way to properly compress or something. We're not low on space, and I'd like you to
be able to learn from previous experience." Before this, `maintain` deleted job archives past 14 days (449 jobs went
on 2026-10-02), spill files past a day (14,895 files, about 3.2 GiB) and cc workers' own transcripts past 2 days.

Layout, under config.HISTORY_DIR:
  jobs/<YYYYMMDD>.tar.xz            every job whose id falls on that UTC day, members "<job-id>/<path in the job>"
  spill/<YYYYMMDD>.tar.xz           tool outputs spilled for fetch_output, by the UTC day of their last use
  cc-transcripts/<YYYYMMDD>.tar.xz  cc workers' Claude Code transcripts (claude-config/projects), by last write
  <kind>/<YYYYMMDD>.json            the day's index: member name -> size, so a listing never opens an archive

Why one solid archive a day: on 2026-09-30 (479 jobs, 445 MiB of records) one LZMA zip per job, the warm format
archive.py writes, took 82.1 MiB (5.4x); one xz stream for the whole day at preset 9 took 34.6 MiB (13.1x, 120 s to
pack) and reads back whole in 2.0 s, because the jobs of a day repeat each other's prompts, schemas and tool
definitions, which a per-job archive can never share. Preset 6 gave 10.9x; zstd 19 with a long window 13.0x, but only
Python 3.14 has zstd and hswarm runs on 3.11+.

Jobs stay warm (a zip each, read in milliseconds) for COLD_AFTER_DAYS, while results are still fetched and resumed;
after that every reader in archive.py falls back here, and reading one old job costs one pass over its day.

Every write goes to a temporary file that is read back, member by member, before it replaces anything; sources are
removed only after that, and a source a reader holds open stays until the next pass."""
from __future__ import annotations

import datetime as dt
import io
import json
import lzma
import os
import tarfile
import threading
import time
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Iterable, Iterator

from . import config

SUFFIX = ".tar.xz"
# Measured above: 13.1x at 9 against 10.9x at 6, for about 670 MiB of memory while it packs (once a day, in maintain).
PRESET = 9
# A job is warm (its own zip) this long, cold after.
COLD_AFTER_DAYS = 7
# cc workers' transcripts are read only to resume a run inside one task (cc.saved_session).
CC_IDLE_S = 2 * 86400
# A day's .tmp untouched this long is a dead packer's (_write_day).
STALE_TMP_S = 2 * 3600
JOBS, SPILL, CC = "jobs", "spill", "cc-transcripts"


def day_path(kind: str, day: str) -> Path:
    return config.HISTORY_DIR / kind / f"{day}{SUFFIX}"


def index_path(kind: str, day: str) -> Path:
    return config.HISTORY_DIR / kind / f"{day}.json"


def _utc_day(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y%m%d")


def _members(path: Path) -> Iterator[tuple[str, bytes]]:
    """Every member of an archive, in order, streamed."""
    with lzma.open(path, "rb") as xz, tarfile.open(fileobj=xz, mode="r|") as tf:
        for ti in tf:
            if ti.isfile():
                f = tf.extractfile(ti)
                yield ti.name, (f.read() if f else b"")


def read_index(kind: str, day: str) -> dict[str, int]:
    try:
        return json.loads(index_path(kind, day).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_day(kind: str, day: str, new: Iterable[tuple[str, bytes]], new_names: set[str]) -> dict[str, int]:
    """Write the day's archive: what it already holds (less any name in `new_names`, which `new` replaces), then
    `new`, streamed. It replaces the old archive only once every member read back with the size written. Returns
    the new index."""
    final = day_path(kind, day)
    final.parent.mkdir(parents=True, exist_ok=True)
    tmp = final.with_name(final.name + ".tmp")
    # A .tmp untouched for two hours belongs to a packer that died, not one at work: a packer writes it as it goes (the
    # biggest day, 459 MB, took 50 minutes). A day held 2026-09-23's chat transcripts back from that night's maintain.
    try:
        if time.time() - tmp.stat().st_mtime > STALE_TMP_S:
            tmp.unlink()
    except OSError:
        pass
    try:
        raw = open(tmp, "xb")
    except FileExistsError as exc:
        # The nightly maintain can meet a manual one on the same day: the .tmp is the other one's work in progress, and
        # truncating it would let that one move a half-written archive into place and delete its sources.
        raise OSError(f"{tmp.name} is another packer's work in progress") from exc
    written: dict[str, int] = {}
    try:
        with raw:
            with lzma.open(raw, "wb", preset=PRESET) as xz, \
                    tarfile.open(fileobj=xz, mode="w|", format=tarfile.PAX_FORMAT) as tf:
                def add(name: str, data: bytes) -> None:
                    ti = tarfile.TarInfo(name)
                    ti.size = len(data)
                    ti.mtime = 0
                    tf.addfile(ti, io.BytesIO(data))
                    written[name] = len(data)

                if final.exists():
                    for name, data in _members(final):
                        if name not in new_names:
                            add(name, data)
                for name, data in new:
                    add(name, data)
            raw.flush()
            os.fsync(raw.fileno())  # on the disk, not just in the cache, before the callers delete the sources
        back = {name: len(data) for name, data in _members(tmp)}
        if back != written:
            raise OSError(f"history: {tmp.name} did not read back as written ({len(back)} of {len(written)} members)")
        os.replace(tmp, final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    idx = index_path(kind, day)
    idx_tmp = idx.with_name(idx.name + ".tmp")
    with open(idx_tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(written))
        f.flush()
        os.fsync(f.fileno())  # the index too: without it the day's jobs are on disk but no reader finds them
    os.replace(idx_tmp, idx)
    return written


_cold: dict = {"stamp": None, "jobs": {}}


def cold_jobs() -> dict[str, str]:
    """{job id: day} for every job in cold history, from the indexes (re-read when one of them changes)."""
    d = config.HISTORY_DIR / JOBS
    try:
        stamp = tuple(sorted((e.name, e.stat().st_mtime_ns) for e in os.scandir(d) if e.name.endswith(".json")))
    except OSError:
        return {}
    if stamp != _cold["stamp"]:
        jobs: dict[str, str] = {}
        for name, _ in stamp:
            day = name[:-5]
            for member in read_index(JOBS, day):
                jobs[member.split("/", 1)[0]] = day
        _cold.update(stamp=stamp, jobs=jobs)
    return _cold["jobs"]


def job_members(job_id: str, prefix: str = "") -> list[str]:
    """A cold job's member names under `prefix` (posix, relative to the job), from its day's index."""
    day = cold_jobs().get(job_id)
    if not day:
        return []
    head = f"{job_id}/"
    return sorted(m[len(head):] for m in read_index(JOBS, day) if m.startswith(head + prefix))


# The last few cold jobs read whole: a reader asks for job.json, then results.jsonl, then transcripts and blobs.
_job_cache: OrderedDict[str, tuple[tuple, dict[str, bytes]]] = OrderedDict()
_JOB_CACHE = 3
# Readers run on worker threads (the MCP server's to_thread calls), so the cache is touched under a lock.
_job_lock = threading.Lock()
# What reading a day's archive can raise: missing, cut short, or damaged.
READ_ERRORS = (OSError, EOFError, lzma.LZMAError, tarfile.TarError)


def _keep(job_id: str, stamp: tuple, got: dict[str, bytes]) -> None:
    with _job_lock:
        _job_cache[job_id] = (stamp, got)
        while len(_job_cache) > _JOB_CACHE:
            _job_cache.popitem(last=False)


def each_cold_job(day: str, wanted: set[str]) -> Iterator[str]:
    """Each job of `wanted` that a day's archive holds, all read in ONE streamed pass and each left in the cold cache
    as it is yielded, so a reader of the whole set (taskstore.index_jobs) answers from memory. Read one by one, every
    job cost a pass over its day up to it: 2026-10-08, 2026-09-23's 410 unindexed jobs (438 MiB, 40 s a pass) took about
    20 s each and held every nightly maintain at its two-hour limit from 2026-10-04 on. Raises READ_ERRORS."""
    path = day_path(JOBS, day)
    st = path.stat()
    stamp = (st.st_mtime_ns, st.st_size)
    job, got = None, {}
    for name, data in _members(path):
        head, _, member = name.partition("/")
        if head != job:
            if job in wanted:
                _keep(job, stamp, got)
                yield job
            job, got = head, {}  # a job's members are written together: a new head is the last one done
        if head in wanted:
            got[member] = data
    if job in wanted:
        _keep(job, stamp, got)
        yield job


def _cold_job(job_id: str) -> dict[str, bytes] | None:
    """A cold job's members, read once per version of its day's archive: an entry is keyed on the archive's
    (mtime, size), so a re-packed or pruned day is never answered from what it held before (review, 2026-10-02)."""
    day = cold_jobs().get(job_id)
    try:
        st = day_path(JOBS, day).stat() if day else None
    except OSError:
        st = None
    stamp = (st.st_mtime_ns, st.st_size) if st else None
    with _job_lock:
        hit = _job_cache.get(job_id)
        if hit and stamp and hit[0] == stamp:
            _job_cache.move_to_end(job_id)
            return hit[1]
        _job_cache.pop(job_id, None)
    if not stamp:
        return None
    head, got = f"{job_id}/", {}
    try:
        for name, data in _members(day_path(JOBS, day)):
            if name.startswith(head):
                got[name[len(head):]] = data
            elif got:
                break  # a job's members are written together: past them, nothing more of it follows
    except READ_ERRORS:
        return None
    _keep(job_id, stamp, got)
    return got


def read_job_member(job_id: str, member: str) -> bytes | None:
    job = _cold_job(job_id)
    return None if job is None else job.get(member)


def job_day_stamp(job_id: str) -> tuple | None:
    """(path, mtime_ns, size) of the archive holding a cold job, for caches keyed on where a record came from."""
    day = cold_jobs().get(job_id)
    if not day:
        return None
    try:
        st = day_path(JOBS, day).stat()
    except OSError:
        return None
    return (str(day_path(JOBS, day)), st.st_mtime_ns, st.st_size)


def pack_jobs(after_days: float = COLD_AFTER_DAYS) -> dict:
    """Move every warm job zip of a UTC day older than `after_days` into that day's archive. A zip already in the
    archive (a pass whose delete Windows refused) is only deleted. {days, jobs, before, after}: bytes."""
    out = {"days": 0, "jobs": 0, "before": 0, "after": 0, "errors": []}
    if not config.JOBS_DIR.exists():
        return out
    cutoff = _utc_day(time.time() - after_days * 86400)
    by_day: dict[str, list[Path]] = {}
    for p in config.JOBS_DIR.glob("*.zip"):
        day = p.name[:8]
        if day.isdigit() and day < cutoff:
            by_day.setdefault(day, []).append(p)
    for day, zips in sorted(by_day.items()):
        index = read_index(JOBS, day)
        try:
            # A zip whose job the archive already holds is deleted only when it holds exactly what the archive holds
            # (a pass whose delete Windows refused); one that differs is packed again in place of the old copy.
            fresh = [z for z in sorted(zips) if _zip_sizes(z) != _indexed(index, z.stem)]
            if fresh:
                ids = {z.stem for z in fresh}
                # Every old member of a job packed again goes, not just the names its new zip has: a job's members
                # must stay together for _cold_job's early stop (background review, 2026-10-02).
                names = {m for m in index if m.split("/", 1)[0] in ids}
                for z in fresh:
                    names |= set(_zip_sizes(z))

                def stream(zs=fresh) -> Iterator[tuple[str, bytes]]:
                    for z in zs:
                        with zipfile.ZipFile(z) as zf:
                            for n in zf.namelist():
                                if not n.endswith("/"):
                                    yield f"{z.stem}/{n}", zf.read(n)

                _write_day(JOBS, day, stream(), names)
        except (*READ_ERRORS, zipfile.BadZipFile) as exc:
            # EOFError: the day's archive is cut short. Its sources stay, and the other days still pack.
            out["errors"].append(f"history: jobs of {day} not packed: {exc}")
            continue
        out["days"] += 1
        for z in zips:
            try:
                size = z.stat().st_size
                z.unlink()
            except OSError:
                continue  # open in a reader right now: it is in the archive, and the next pass deletes it
            out["jobs"] += 1
            out["before"] += size
        out["after"] += day_path(JOBS, day).stat().st_size
    return out


def _zip_sizes(z: Path) -> dict[str, int]:
    """A job zip's members as the archive names them ("<job-id>/<path>"), with their sizes."""
    with zipfile.ZipFile(z) as zf:
        return {f"{z.stem}/{i.filename}": i.file_size for i in zf.infolist() if not i.filename.endswith("/")}


def _indexed(index: dict[str, int], job_id: str) -> dict[str, int]:
    head = f"{job_id}/"
    return {m: size for m, size in index.items() if m.startswith(head)}


def _pack_files(kind: str, root: Path, files: list[Path]) -> dict:
    """Pack loose files under `root` into their UTC day's archive (by last write), named by their path under it,
    then remove them. A file written again since it was listed waits for a later pass."""
    out = {"files": 0, "before": 0, "after": 0, "errors": []}
    by_day: dict[str, list[tuple[Path, float]]] = {}
    for f in files:
        try:
            mtime = f.stat().st_mtime
        except OSError:
            continue
        by_day.setdefault(_utc_day(mtime), []).append((f, mtime))
    for day, group in sorted(by_day.items()):
        names = {f.relative_to(root).as_posix() for f, _ in group}

        def stream(g=group) -> Iterator[tuple[str, bytes]]:
            for f, _ in g:
                yield f.relative_to(root).as_posix(), f.read_bytes()

        try:
            _write_day(kind, day, stream(), names)
        except READ_ERRORS as exc:  # a damaged day: its files stay
            out["errors"].append(f"history: {kind} of {day} not packed: {exc}")
            continue
        for f, mtime in group:
            try:
                st = f.stat()
                if st.st_mtime != mtime:
                    continue  # written since: its archived copy is older than it, so it stays for the next pass
                f.unlink()
            except OSError:
                continue
            out["files"] += 1
            out["before"] += st.st_size
        out["after"] += day_path(kind, day).stat().st_size
    return out


def pack_spill(idle_s: float | None = None) -> dict:
    """Spill files nothing has paged for `idle_s` (config.SPILL_RETENTION_S): a handle matters only while its task
    runs, so fetch_output never needs one back; the history keeps it."""
    cutoff = time.time() - (config.SPILL_RETENTION_S if idle_s is None else idle_s)
    try:
        files = [Path(e.path) for e in os.scandir(config.SPILL_DIR)
                 if e.name.endswith(".txt") and e.stat().st_mtime < cutoff]
    except OSError:
        return {"files": 0, "before": 0, "after": 0, "errors": []}
    return _pack_files(SPILL, config.SPILL_DIR, files)


def pack_cc_transcripts(idle_s: float = CC_IDLE_S) -> dict:
    """cc workers' own Claude Code transcripts (claude-config/projects) idle for `idle_s`, then the folders they
    leave empty. Claude Code itself never deletes them (claude_env.CC_TRANSCRIPT_DAYS)."""
    root = config.CC_CONFIG_DIR / "projects"
    if not root.is_dir():
        return {"files": 0, "before": 0, "after": 0, "errors": []}
    cutoff = time.time() - idle_s
    files = []
    for p in root.rglob("*"):
        try:  # a running cc worker can rename or remove its transcript between the listing and this look
            if p.is_file() and p.stat().st_mtime < cutoff:
                files.append(p)
        except OSError:
            continue
    out = _pack_files(CC, root, files)
    for d in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            d.rmdir()  # only an empty one goes
        except OSError:
            pass
    return out
