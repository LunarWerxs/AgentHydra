"""Egress receipts: a content-free, hash-chained record of every request body that left this machine.

WHY: the swarm ships session transcripts, files and prompts to third-party model hosts, and until this
module nothing on disk said what left, or where. After an incident the question is "did this ever get
sent, and to whom", and the answer must not require keeping the secret itself. So before each provider
POST one JSON line goes to that UTC day's ~/.hswarm/egress-YYYYMMDD.jsonl holding the sink, the sha256 and
byte count of the EXACT bytes sent, and `prev` = sha256 of the previous raw line (a day's first line chains
to the day before). Nothing of the payload is stored; a line that is edited, dropped or reordered breaks
the chain, and `hswarm egress verify` says where.

Two modes. The default is fail-open: a receipt that cannot be written never stops a swarm job (it is
counted and reported once on stderr). Inside `fail_closed()` - the memory pipeline's distill and triage,
which carry transcript text - a receipt that cannot be written REFUSES the send with EgressReceiptFailed.
`HSWARM_EGRESS_STRICT=1` makes every send fail-closed.

Idea from garrytan/gstack lib/egress-receipt.ts (MIT); no code copied, written fresh for hswarm.
"""
from __future__ import annotations

import contextlib
import contextvars
import datetime as dt
import hashlib
import json
import lzma
import os
import shutil
import sys
import threading
import time
from collections import deque
from pathlib import Path

try:
    import msvcrt  # Windows: byte-range lock on the ledger's lock file
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None
    import fcntl

from . import config

LOCK_WAIT_S = 2.0  # how long an append waits for another process's append before refusing (strict) or going ahead
TAIL_BYTES = 8192  # one receipt is ~250 bytes; the last line is always inside this window

_STRICT: contextvars.ContextVar[bool] = contextvars.ContextVar("hswarm_egress_strict", default=False)
FAILURES = 0  # receipts this process could not write in fail-open mode
_warned = False


class EgressReceiptFailed(RuntimeError):
    """A fail-closed send whose receipt could not be written. The request was NOT sent."""


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")


def ledger_path() -> Path:
    """The segment receipts are appended to now: one file per UTC day. The single egress.jsonl before it only grew
    (446 MiB in six days, 71 MiB a day, 2026-10-02) and nothing could pack or drop a part of it."""
    # Derived from config.HOME at call time, so HSWARM_HOME and the test fixture's patched HOME both hold.
    return config.HOME / f"egress-{_today()}.jsonl"


def segments() -> list[Path]:
    """Every ledger file, oldest first: the single egress.jsonl older builds wrote (a chain of its own, left as it
    is), then one segment per UTC day, `.xz` once packed (compact). While both forms of a day exist, a pack cut
    short, the plain one is the whole of it."""
    home = config.HOME
    days = sorted(p for p in home.glob("egress-????????.jsonl*") if p.name.endswith((".jsonl", ".jsonl.xz")))
    days = [p for p in days if not (p.suffix == ".xz" and p.with_suffix("").exists())]
    # The old single file: its plain form left beside the packed one by a refused delete is all of it (it is older than
    # the .xz); a plain one written AFTER the pack is a process still on an old build appending anew, so both count.
    legacy, packed = home / "egress.jsonl", home / "egress.jsonl.xz"
    if legacy.exists() and packed.exists():
        first = [packed, legacy] if legacy.stat().st_mtime > packed.stat().st_mtime else [legacy]
    else:
        first = [p for p in (legacy, packed) if p.exists()]
    return first + days


def _open(p: Path):
    return lzma.open(p, "rb") if p.suffix == ".xz" else p.open("rb")


def strict() -> bool:
    return _STRICT.get() or os.environ.get("HSWARM_EGRESS_STRICT", "").lower() in ("1", "true", "on", "yes")


@contextlib.contextmanager
def fail_closed():
    """Every send started inside this block (and in asyncio tasks created inside it) refuses to go out
    without its receipt. Tasks inherit the flag because asyncio copies the context at create_task."""
    token = _STRICT.set(True)
    try:
        yield
    finally:
        _STRICT.reset(token)


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _last_line(fd: int) -> bytes:
    """The last complete line of the ledger, without its newline; b"" for an empty file."""
    size = os.lseek(fd, 0, os.SEEK_END)
    if size == 0:
        return b""
    start = max(0, size - TAIL_BYTES)
    os.lseek(fd, start, os.SEEK_SET)
    tail = os.read(fd, size - start).rstrip(b"\r\n")
    return tail.rsplit(b"\n", 1)[-1]


def _lock(fd: int) -> bool:
    deadline = time.monotonic() + LOCK_WAIT_S
    while True:
        try:
            if msvcrt is not None:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)


def _unlock(fd: int) -> None:
    try:
        if msvcrt is not None:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


def _day_before(path: Path) -> bytes:
    """The last line of the day segment before `path`, which a new segment's first receipt chains to. b"" when
    there is none or it is already packed: the new segment then starts a chain of its own. Never the older
    egress.jsonl: a process still on the older build may be appending to that, and the link would not hold."""
    older = [p for p in segments() if p.name.startswith("egress-") and p.name < path.name]
    if not older or older[-1].suffix == ".xz":
        return b""
    fd = os.open(str(older[-1]), os.O_RDONLY | getattr(os, "O_BINARY", 0))
    try:
        return _last_line(fd)
    finally:
        os.close(fd)


# This process's appends take turns here. They run in threads (client._post), and each has its own handle on the
# lock file, so without this they would wait for one another by polling the file lock every 5 ms.
_APPEND_GATE = threading.Lock()


def _append(entry: dict) -> None:
    """Chain and append one receipt under the ledger's lock, so two processes never fork the chain."""
    config.HOME.mkdir(parents=True, exist_ok=True)
    with _APPEND_GATE:
        lock_fd = os.open(str(config.HOME / "egress.jsonl.lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if not _lock(lock_fd):
                raise OSError("egress ledger lock not taken within %.0fs" % LOCK_WAIT_S)
            try:
                path = ledger_path()  # read under the lock, so the day rolls over once for every process
                fd = os.open(str(path), os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
                try:
                    prev = _last_line(fd) or _day_before(path)
                    entry["prev"] = _sha(prev) if prev else ""
                    line = json.dumps(entry, separators=(",", ":"), ensure_ascii=True).encode("ascii") + b"\n"
                    os.lseek(fd, 0, os.SEEK_END)
                    if os.write(fd, line) != len(line):
                        raise OSError("short write to the egress ledger")
                finally:
                    os.close(fd)
            finally:
                _unlock(lock_fd)
        finally:
            os.close(lock_fd)


def compact() -> dict:
    """Pack every day segment but the newest with xz (`hswarm maintain`): nothing appends to an earlier day, and
    verify, tail and find read a packed segment as they read a plain one. {packed, saved}: files and bytes."""
    packed = saved = 0
    # The single egress.jsonl older builds appended to (470 MiB by 2026-10-02) packs once nothing has written to it for
    # a day: every process runs the per-day build by then, and segments() already reads egress.jsonl.xz in its place.
    # Never over an existing egress.jsonl.xz: a plain one beside it is either a refused delete's copy or new appends.
    legacy = [p for p in segments() if p.name == "egress.jsonl" and time.time() - p.stat().st_mtime > 86400
              and not p.with_name("egress.jsonl.xz").exists()]
    for p in legacy + [p for p in segments() if p.name.startswith("egress-")][:-1]:
        if p.suffix == ".xz":
            continue
        out, tmp = p.with_name(p.name + ".xz"), p.with_name(p.name + ".tmp")
        try:
            size = p.stat().st_size
            with p.open("rb") as src, lzma.open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            os.replace(tmp, out)
            p.unlink()  # refused while a reader holds it (Windows): both forms stay, and the next pass packs it again
            packed, saved = packed + 1, saved + size - out.stat().st_size
        except OSError:
            tmp.unlink(missing_ok=True)
    return {"packed": packed, "saved": saved}


def record(sink: str, payload: bytes, provider: str = "", model: str = "") -> dict | None:
    """Write the receipt for `payload` BEFORE it is sent. Returns the receipt, or None when it could not
    be written in fail-open mode. In fail-closed mode a failure raises EgressReceiptFailed, and the caller
    must not send."""
    global FAILURES, _warned
    entry = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"), "sink": sink,
             "provider": provider, "model": model, "sha256": _sha(payload), "bytes": len(payload)}
    try:
        _append(entry)
        return entry
    except OSError as e:
        if strict():
            raise EgressReceiptFailed(f"EGRESS_RECEIPT_FAILED: no receipt for a send to {sink}, so it was not sent ({e})") from e
        FAILURES += 1
        if not _warned:
            _warned = True
            print(f"hswarm: egress receipt not written ({e}); sends continue fail-open", file=sys.stderr)
        return None


# How far this process has already walked each segment: path -> (offset, lines, raw last line). The doctor verifies
# on every call and the ledger only grows (318 MB on one machine, 2026-09-29: seconds of CPU per hswarm_doctor, on
# the shared server's loop), so an incremental verify reads only the bytes appended since.
_VERIFIED: dict[str, tuple[int, int, bytes]] = {}
_VERIFY_LOCK = threading.Lock()


def verify(incremental: bool = False) -> dict:
    """Recompute the chain over every segment, oldest first. {ok, lines, path}, plus broken_at (1-based line of
    the segment at `path`) and reason when not ok; a missing ledger is ok with 0 lines. A segment's first receipt
    either continues the segment before it or opens a chain (prev ""); the first segment walked may continue one
    that is no longer here.

    incremental=True (the doctor) walks the newest segment only, from the lines this process already verified
    when the file did not shrink and its last verified line is still where it was. So a new process reads one
    day at most, not the whole ledger (446 MiB took about 6 s after each restart, 2026-10-02). An edit inside
    what it skips is caught by the full walk, which `hswarm egress verify` always does."""
    files = segments()[-1:] if incremental else segments()
    if not files:
        return {"ok": True, "lines": 0, "path": str(ledger_path())}
    lines, prev = 0, b""
    with _VERIFY_LOCK:
        for p in files:
            with _open(p) as f:
                start, n, last = 0, 0, b""
                seen = _VERIFIED.get(str(p)) if incremental else None
                if seen and f.seek(0, os.SEEK_END) >= seen[0]:
                    f.seek(seen[0] - len(seen[2]))
                    if f.read(len(seen[2])) == seen[2]:
                        start, n, last = seen
                f.seek(start)
                if last:
                    prev = last.rstrip(b"\r\n")
                good = (start, n, last)
                try:
                    for raw in f:
                        n += 1
                        line = raw.rstrip(b"\r\n")
                        try:
                            entry = json.loads(line)
                        except ValueError:
                            return {"ok": False, "lines": lines + n, "broken_at": n, "reason": "not JSON", "path": str(p)}
                        want = _sha(prev) if prev else ""
                        opens = n == 1 and isinstance(entry, dict) and (p == files[0] or entry.get("prev") == "")
                        if not isinstance(entry, dict) or (entry.get("prev") != want and not opens):
                            return {"ok": False, "lines": lines + n, "broken_at": n, "reason": "prev does not match the line before", "path": str(p)}
                        prev = line
                        if raw.endswith(b"\n"):  # a line still being appended is verified again next time, whole
                            good = (good[0] + len(raw), n, raw)
                finally:
                    if good[1]:
                        _VERIFIED[str(p)] = good
            lines += n
    return {"ok": True, "lines": lines, "path": str(files[-1])}


def _tail_lines(p: Path, limit: int) -> list[bytes]:
    if p.suffix == ".xz":  # no reading back from the end; reached only when the newer segments hold fewer than `limit`
        with _open(p) as f:
            return [raw.rstrip(b"\r\n") for raw in deque(f, maxlen=limit)]
    # Read back from the end a block at a time: the ledger is append-only and was 269 MB on 2026-09-28, and
    # reading all of it to return 20 lines cost a quarter-gigabyte read per call.
    with p.open("rb") as f:
        f.seek(0, os.SEEK_END)
        pos, buf = f.tell(), b""
        while pos > 0 and buf.count(b"\n") <= limit:
            step = min(65536, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
    if pos > 0:
        buf = buf[buf.index(b"\n") + 1:]  # the first line read is a fragment unless the read reached the file start
    return buf.splitlines()[-limit:]


def tail(limit: int = 20) -> list[dict]:
    lines: list[bytes] = []
    for p in reversed(segments()):
        if len(lines) >= limit:
            break
        lines = _tail_lines(p, limit - len(lines)) + lines
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            out.append({"unparseable": True})
    return out


def find(sha256: str) -> list[dict]:
    """Every receipt for one exact payload hash, in every segment: "did these bytes ever leave, and where to"."""
    want = sha256.strip().lower()
    hits = []
    for p in segments():
        with _open(p) as f:
            for raw in f:
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("sha256") == want:
                    hits.append(e)
    return hits
