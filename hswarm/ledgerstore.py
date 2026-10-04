"""The ledger's files: ledger.jsonl holds the current month, ledger-YYYYMM.jsonl.gz one finished month each.

Month = the UTC month of a line's `ts`. gzip, because Python's stdlib and Bun both read it with no dependency (xz: Bun cannot).
Every writer takes the ledger lock for its append; rotation takes it for the whole move, so no line lands between rotation's
read of the live file and its replacement. Crash safety, in two sentences: rotation first writes ledger.rotate.json (how many
lines each archive already held), then builds each archive as "those first N lines + the live file's lines of that month" into
a temp file and os.replaces it, then replaces the live file with the kept lines, then deletes the journal; a crash anywhere in
between leaves the live file whole (the journal's hashes say whether the swap happened), and the next rotation (any append retries it) rebuilds each archive from the journal's N, so
nothing is lost and nothing is added twice. Between a crash and that retry a reader can see the moved lines twice (in the
archive and still in the live file); rotation's retry closes that window.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Iterator

from . import config

try:
    import msvcrt  # Windows: byte-range lock on the ledger's lock file
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None
    import fcntl

LOCK_WAIT_S = 30.0  # rotation holds the lock while it moves a month; an append waits that out rather than skip
RETRY_S = 60.0  # a failed rotation (a reader holds the file open on Windows) is tried again after this
_ARCHIVE = re.compile(r"^(?P<stem>.+)-(?P<month>\d{6})\.jsonl\.gz$")
_state = {"checked": None, "failed_at": 0.0}
_state_lock = threading.Lock()


def _live(path: Path | None = None) -> Path:
    return Path(path or config.LEDGER)


def archive_path(live: Path, month: str) -> Path:
    return live.with_name(f"{live.stem}-{month}{live.suffix}.gz")


def _journal(live: Path) -> Path:
    return live.with_name(live.stem + ".rotate.json")


def _lock_file(live: Path) -> Path:
    return live.with_name(live.stem + ".lock")


@contextlib.contextmanager
def lock(live: Path | None = None):
    """The ledger lock, held across one append or one rotation. Waits up to LOCK_WAIT_S, then goes on unlocked (a stuck
    holder must not stop the swarm from journaling; the worst case is one line racing a rotation, which is why the live file
    is only ever replaced from lines read under the lock)."""
    live = _live(live)
    fd, held = None, False
    try:
        live.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(_lock_file(live)), os.O_RDWR | os.O_CREAT)
        deadline = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                if msvcrt is not None:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
    except OSError:
        pass
    try:
        yield held
    finally:
        if fd is not None:
            if held:
                with contextlib.suppress(OSError):
                    if msvcrt is not None:
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def month_of(ts: str) -> str | None:
    """'YYYYMM' (UTC) of an ISO timestamp, None when it has none that parses."""
    try:
        t = dt.datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(dt.timezone.utc).strftime("%Y%m")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _line_month(line: bytes) -> str | None:
    try:
        return month_of(json.loads(line)["ts"])
    except (ValueError, KeyError, TypeError):
        return None


def _now_month(now: dt.datetime | None = None) -> str:
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).strftime("%Y%m")


def append_line(text: str) -> None:
    """One whole line (with its newline) onto the live ledger, under the ledger lock. Raises OSError like open() does; the
    callers already swallow it. Rotates first when the month has changed since this process last looked."""
    live = _live()
    maybe_rotate(live)
    with lock(live):
        live.parent.mkdir(parents=True, exist_ok=True)
        with live.open("a", encoding="utf-8") as f:
            f.write(text)


def archives(live: Path | None = None) -> dict[str, Path]:
    """{month: archive path} for every archive beside the live ledger."""
    live = _live(live)
    out: dict[str, Path] = {}
    try:
        names = os.listdir(live.parent)
    except OSError:
        return out
    for n in names:
        m = _ARCHIVE.match(n)
        if m and m["stem"] == live.stem:
            out[m["month"]] = live.parent / n
    return out


def paths_for(since: dt.datetime | None, live: Path | None = None) -> list[Path]:
    """The archives a window starting at `since` can reach (oldest first; all of them when None). The live file is not in
    the list: callers read it their own way (a tail walk, a byte offset)."""
    first = month_of(since.isoformat()) if since is not None else None
    if first is not None and since is not None and since.tzinfo is None:
        first = None
    arch = archives(live)
    return [arch[m] for m in sorted(arch) if first is None or m >= first]


def read_archive_lines(path: Path) -> Iterator[bytes]:
    """The lines of one archive; a truncated gzip tail (a crash mid-write cannot happen, the file is replaced whole) or an
    unreadable file ends the iteration quietly."""
    try:
        with gzip.open(path, "rb") as f:
            yield from f
    except (OSError, EOFError):
        return


def iter_lines(since: dt.datetime | None, live: Path | None = None) -> Iterator[bytes]:
    """Every line a window starting at `since` might hold: the archives it reaches, then the whole live file. Callers still
    filter by ts. For readers that parse the lot (backfill); the big tail-walking readers use paths_for + their own walk."""
    live = _live(live)
    for p in paths_for(since, live):
        yield from read_archive_lines(p)
    try:
        with live.open("rb") as f:
            yield from f
    except OSError:
        return


def _write_archive(dest: Path, lines: list[bytes]) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    with open(tmp, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
            gz.write(b"".join(lines))
        raw.flush()
        os.fsync(raw.fileno())
    os.replace(tmp, dest)


def _replace_with_retry(src: Path, dst: Path) -> bool:
    """os.replace, tried a few times: on Windows a reader holding the file open (no delete sharing) refuses it."""
    for _ in range(20):
        try:
            os.replace(src, dst)
            return True
        except OSError:
            time.sleep(0.1)
    return False


def rotate(live: Path | None = None, now: dt.datetime | None = None) -> dict:
    """Move every line of a finished month out of the live ledger into its month's archive. Returns {month: lines moved}
    ({} when there was nothing to do or the lock/replace did not go through; the next call retries)."""
    live = _live(live)
    current = _now_month(now)
    with lock(live) as held:
        if not held:
            return {}
        journal = _journal(live)
        try:
            raw = live.read_bytes()
        except OSError:
            return {}
        try:
            jr = json.loads(journal.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            jr = None
        old_counts: dict[str, int] = {}
        if isinstance(jr, dict):
            try:
                if _sha(raw[: jr["old_len"]]) == jr["old_sha"] and len(raw) >= jr["old_len"]:
                    old_counts = {k: int(v) for k, v in jr["n"].items()}  # the swap never happened: redo from the N
                elif _sha(raw[: jr["keep_len"]]) == jr["keep_sha"] and len(raw) >= jr["keep_len"]:
                    with contextlib.suppress(OSError):
                        journal.unlink()  # the swap did happen, only the journal's delete was lost: archives are final
                else:
                    return {}  # the live file is neither: someone edited it. Touch nothing rather than lose or double.
            except (KeyError, TypeError, ValueError):
                return {}
        keep: list[bytes] = []
        moved: dict[str, list[bytes]] = {}
        for line in raw.splitlines(keepends=True):
            m = _line_month(line)
            if m is not None and m < current and line.endswith(b"\n"):
                moved.setdefault(m, []).append(line)
            else:
                keep.append(line)
        if not moved:
            with contextlib.suppress(OSError):
                journal.unlink()
            return {}
        arch = archives(live)
        n_now: dict[str, int] = {}
        existing: dict[str, list[bytes]] = {}
        for m in moved:
            old = list(read_archive_lines(arch[m])) if m in arch else []
            # A crashed earlier run may already have added this month's lines to the archive: keep only what it held before.
            existing[m] = old[: old_counts[m]] if m in old_counts else old
            n_now[m] = len(existing[m])
        keep_raw = b"".join(keep)
        tmp_journal = journal.with_name(journal.name + ".tmp")
        tmp_journal.write_text(json.dumps({"old_len": len(raw), "old_sha": _sha(raw), "keep_len": len(keep_raw),
                                           "keep_sha": _sha(keep_raw), "n": n_now}), encoding="utf-8")
        os.replace(tmp_journal, journal)
        for m, lines in moved.items():
            _write_archive(archive_path(live, m), existing[m] + lines)
        tmp_live = live.with_name(live.name + ".rotating")
        tmp_live.write_bytes(keep_raw)
        if not _replace_with_retry(tmp_live, live):
            with contextlib.suppress(OSError):
                tmp_live.unlink()
            return {}  # the journal stays: the next rotation rebuilds the archives from it and tries the swap again
        with contextlib.suppress(OSError):
            journal.unlink()
        return {m: len(v) for m, v in moved.items()}


def maybe_rotate(live: Path | None = None) -> None:
    """Called before an append: cheap unless the month changed since this process last checked (or a rotation is half
    done). Never raises; the swarm's journaling does not depend on rotation."""
    live = _live(live)
    month = _now_month()
    with _state_lock:
        key = (str(live), month)
        pending = _journal(live).exists()
        if _state["checked"] == key and not pending:
            return
        if time.monotonic() - _state["failed_at"] < RETRY_S and _state["failed_at"]:
            return
        _state["checked"] = key
    try:
        first = None
        with live.open("rb") as f:
            for line in f:  # the oldest line decides: a live file is in time order within an hour's slack
                first = _line_month(line)
                if first is not None:
                    break
        if pending or (first is not None and first < month):
            if not rotate(live) and (pending or first is not None):
                with _state_lock:
                    _state["failed_at"] = time.monotonic()
                    _state["checked"] = None
    except Exception:  # noqa: BLE001 - rotation is housekeeping, never a reason to lose a ledger line
        pass
