"""`hswarm import-zswarm`: bring a ZSwarm home's stats and history into HSwarm's, a ONE-SHOT.

The first real run records `ran_at` in import-zswarm.json; every later real run returns at once, reading and writing
nothing (ZSwarm is retired and archived; nothing reads ~/.zswarm afterwards). --dry-run still counts.

What moves: the four stats tables of zswarm.sqlite, the line files (ledger, survival, routing, savings-daily) and the
job records and day archives. What never moves: egress logs, keys, secrets, vault files, the console token, claude-config,
procslots, spill, logs (and history/tasks.sqlite, a cache HSwarm rebuilds from the archives).

The line files are appended to, never rewritten from scratch: a line already in HSwarm's file (same hash of the stripped
line) is not added again. ledger, survival and routing are read by time (ledger.py walks the ledger from its END until it
passes a time), so a first import merges the two files by `ts` into a temp file and swaps it in; later runs read only the
bytes ZSwarm appended since (the state file records the offset) and append them when they belong at the end. Nothing here
holds a lock the writers do not take (they plainly append), so the swap re-checks the destination's size just before
os.replace and carries over whatever was appended meanwhile.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import heapq
import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

from . import utilization

STATE_NAME = "import-zswarm.json"
LINE_FILES = ("ledger.jsonl", "survival.jsonl", "routing.jsonl")
SAVINGS = "savings-daily.jsonl"
# Whole names (file or folder, any depth) that are never copied from a job or a history folder.
NEVER = {"keys.json", "secrets", ".secrets", "console-token", "claude-config", "procslots", "spill", "logs", "tasks.sqlite",
         "tasks.sqlite-wal", "tasks.sqlite-shm", "vault.key", "vault.json"}
NEVER_PREFIXES = ("egress", "vault", "keys.json")
APPEND_SLACK_S = 1800.0  # new lines that start within this of the destination's newest are appended in place
TAIL_BYTES = 16 << 20
SWAP_TRIES = 8


def _never(name: str) -> bool:
    n = name.lower()
    return n in NEVER or n.startswith(NEVER_PREFIXES) or n.endswith((".key", ".pin"))


def _h(line: bytes) -> bytes:
    return hashlib.blake2b(line.strip(), digest_size=12).digest()


def _ts(line: bytes, last: float) -> float:
    """A line's time for ordering; a line with none keeps the time of the one before it."""
    try:
        t = dt.datetime.fromisoformat(json.loads(line)["ts"])
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return t.timestamp()
    except (ValueError, KeyError, TypeError):
        return last


def _complete_lines(path: Path, start: int):
    """(line, end offset) for every whole line from `start`; a last line still being written is left for the next run."""
    with path.open("rb") as f:
        f.seek(start)
        pos = start
        for line in f:
            if not line.endswith(b"\n"):
                return
            pos += len(line)
            yield line, pos


def _first_hash(path: Path) -> str:
    with path.open("rb") as f:
        return _h(f.readline()).hex()


def _hashes(path: Path, start: int = 0) -> set[bytes]:
    out: set[bytes] = set()
    if not path.exists():
        return out
    with path.open("rb") as f:
        f.seek(start)
        for line in f:
            if line.strip():
                out.add(_h(line))
    return out


def _tail_start(size: int) -> int:
    return max(0, size - TAIL_BYTES)


def _tail_max_ts(path: Path, size: int) -> float:
    last = 0.0
    start = _tail_start(size)
    with path.open("rb") as f:
        f.seek(start)
        if start:
            f.readline()  # cut mid-line
        for line in f:
            last = max(last, _ts(line, last))
    return last


def _swap(dest: Path, tmp: Path, size: int) -> None:
    """os.replace(tmp, dest), after carrying over what was appended to dest since `size` bytes of it were merged."""
    for _ in range(SWAP_TRIES):
        now = dest.stat().st_size if dest.exists() else 0
        if now > size:
            with dest.open("rb") as src, tmp.open("ab") as out:
                src.seek(size)
                out.write(src.read(now - size))
            size = now
            continue
        try:
            os.replace(tmp, dest)
            return
        except PermissionError:
            time.sleep(0.2)
    raise OSError(f"{dest.name}: kept changing while it was merged; run again")


def _merge_into(dest: Path, tmp: Path, fresh: list[tuple[float, bytes]]) -> int:
    """Write dest's lines and `fresh` merged by time into tmp; returns the dest size that was merged. `fresh` is the
    new lines in source order, each with its time."""
    size = dest.stat().st_size if dest.exists() else 0

    def old():
        last = 0.0
        if size:
            with dest.open("rb") as f:
                n = 0
                for line in f:
                    n += len(line)
                    if n > size:
                        return
                    if not line.endswith(b"\n"):
                        line += b"\n"
                    last = _ts(line, last)
                    yield last, line

    def new():
        for t, line in fresh:
            yield t, line if line.endswith(b"\n") else line + b"\n"

    with tmp.open("wb") as out:
        for _, line in heapq.merge(old(), new(), key=lambda p: p[0]):
            out.write(line)
    return size


def _import_lines(name: str, src_home: Path, dest_home: Path, state: dict, dry: bool) -> dict:
    src, dest = src_home / name, dest_home / name
    res = {"read": 0, "added": 0, "already_there": 0}
    if not src.exists():
        return res
    ssize = src.stat().st_size
    fh = _first_hash(src) if ssize else ""
    dsize = dest.stat().st_size if dest.exists() else 0
    prev = state.get(name) or {}
    # Only the new bytes when the source only grew and the destination is as we left it; else the whole file again.
    incremental = bool(prev) and prev.get("first") == fh and prev.get("offset", 0) <= ssize and prev.get("dest_size", 0) <= dsize
    start = prev["offset"] if incremental else 0
    known = _hashes(dest, _tail_start(dsize)) if incremental else _hashes(dest)
    fresh: list[tuple[float, bytes]] = []
    seen: set[bytes] = set()
    end, last = start, 0.0
    for line, end in _complete_lines(src, start):
        if not line.strip():
            continue
        res["read"] += 1
        h = _h(line)
        if h in known or h in seen:
            res["already_there"] += 1
            continue
        seen.add(h)
        last = _ts(line, last)
        fresh.append((last, line))
    res["added"] = len(fresh)
    if dry or end == start and not fresh:
        return res
    if fresh:
        dest.parent.mkdir(parents=True, exist_ok=True)
        oldest = min(t for t, _ in fresh)
        in_place = dsize == 0 or (incremental and oldest >= _tail_max_ts(dest, dsize) - APPEND_SLACK_S)
        if in_place:
            chunk = b"".join(line if line.endswith(b"\n") else line + b"\n" for _, line in fresh)
            with dest.open("ab") as f:  # a torn last line (no newline) must not swallow our first
                if dsize and _last_byte(dest) != b"\n":
                    f.write(b"\n")
                f.write(chunk)
        else:
            tmp = dest.with_name(dest.name + ".importing")
            try:
                merged = _merge_into(dest, tmp, fresh)
                _swap(dest, tmp, merged)
            finally:
                tmp.unlink(missing_ok=True)
    state[name] = {"offset": end, "first": fh, "dest_size": dest.stat().st_size if dest.exists() else 0}
    return res


def _last_byte(path: Path) -> bytes:
    with path.open("rb") as f:
        f.seek(-1, os.SEEK_END)
        return f.read(1)


def _import_savings(src_home: Path, dest_home: Path, state: dict, dry: bool) -> dict:
    """savings-daily.jsonl holds one row per day, rewritten whole by its writer. A day HSwarm already has is kept as
    HSwarm measured it; a day it lacks is taken from ZSwarm (its `zswarm_*` counters renamed to `hswarm_*`)."""
    src, dest = src_home / SAVINGS, dest_home / SAVINGS
    res = {"read": 0, "added": 0, "already_there": 0}
    if not src.exists():
        return res
    st = src.stat()
    stamp = [st.st_size, st.st_mtime_ns]
    prev = state.get(SAVINGS) or {}
    if prev.get("stamp") == stamp and dest.exists() and prev.get("dest_size", 0) <= dest.stat().st_size:
        return res
    have: dict[str, bytes] = {}
    if dest.exists():
        for line in dest.read_bytes().splitlines():
            try:
                have[json.loads(line)["day"]] = line
            except (ValueError, KeyError, TypeError):
                continue
    fresh: dict[str, bytes] = {}
    with src.open("rb") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                day = row["day"]
            except (ValueError, KeyError, TypeError):
                continue
            res["read"] += 1
            if day in have:
                res["already_there"] += 1
                continue
            row = {(("hswarm_" + k[len("zswarm_"):]) if k.startswith("zswarm_") else k): v for k, v in row.items()}
            fresh[day] = json.dumps(row).encode("utf-8")
    res["added"] = len(fresh)
    if dry:
        return res
    if fresh:
        for _ in range(SWAP_TRIES):
            size = dest.stat().st_size if dest.exists() else 0
            rows = {**have, **fresh}
            tmp = dest.with_name(dest.name + ".importing")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_bytes(b"".join(rows[d] + b"\n" for d in sorted(rows)))
            if (dest.stat().st_size if dest.exists() else 0) == size:
                try:
                    os.replace(tmp, dest)
                    break
                except PermissionError:
                    time.sleep(0.2)
            tmp.unlink(missing_ok=True)
            have = {}
            if dest.exists():
                for line in dest.read_bytes().splitlines():
                    try:
                        have[json.loads(line)["day"]] = line
                    except (ValueError, KeyError, TypeError):
                        continue
        else:
            raise OSError(f"{SAVINGS} kept changing while it was merged; run again")
        tmp.unlink(missing_ok=True)
    state[SAVINGS] = {"stamp": stamp, "dest_size": dest.stat().st_size if dest.exists() else 0}
    return res


# ---- SQLite --------------------------------------------------------------------------------------------------

TABLES = (  # (table, key columns, replace?)
    ("utilizations", ("id",), False),
    ("profiles", ("id",), False),
    ("claude_days", ("machine", "day"), True),
    ("claude_accounts", ("machine", "day", "account"), True),
)


def _import_sqlite(src_home: Path, dest_home: Path, dry: bool) -> dict:
    src_db, dest_db = src_home / "zswarm.sqlite", dest_home / "hswarm.sqlite"
    out = {t: {"read": 0, "added": 0, "already_there": 0} for t, _, _ in TABLES}
    if not src_db.exists():
        return out
    s = sqlite3.connect(f"file:{src_db.as_posix()}?mode=ro", uri=True, timeout=15)
    try:
        if dry:
            if not dest_db.exists():
                d = sqlite3.connect(":memory:")
                d.executescript(utilization.SCHEMA)
                utilization._migrate(d)
            else:
                d = sqlite3.connect(f"file:{dest_db.as_posix()}?mode=ro", uri=True, timeout=15)
        else:
            dest_home.mkdir(parents=True, exist_ok=True)
            d = sqlite3.connect(dest_db, timeout=15)
            d.execute("PRAGMA journal_mode=WAL")
            d.executescript(utilization.SCHEMA)
            utilization._migrate(d)
        try:
            for table, key, replace in TABLES:
                scols = [r[1] for r in s.execute(f"PRAGMA table_info({table})")]
                dcols = {r[1] for r in d.execute(f"PRAGMA table_info({table})")}
                cols = [c for c in scols if c in dcols]
                if not set(key) <= set(cols):
                    continue
                sel = ", ".join(cols)
                existing = {tuple(r[:len(key)]): tuple(r[len(key):]) for r in d.execute(
                    f"SELECT {', '.join(key)}, {', '.join(c for c in cols if c not in key) or '1'} FROM {table}")}
                rest_idx = [i for i, c in enumerate(cols) if c not in key]
                rows = []
                res = out[table]
                for row in s.execute(f"SELECT {sel} FROM {table}"):
                    res["read"] += 1
                    k = tuple(row[cols.index(c)] for c in key)
                    if k not in existing:
                        res["added"] += 1
                        rows.append(tuple(row))
                    elif replace and existing[k] != (tuple(row[i] for i in rest_idx) or (1,)):
                        res["updated"] = res.get("updated", 0) + 1
                        rows.append(tuple(row))
                    else:
                        res["already_there"] += 1
                if rows and not dry:
                    verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
                    d.executemany(f"{verb} INTO {table} ({sel}) VALUES ({', '.join('?' * len(cols))})", rows)
            if not dry:
                d.commit()
        finally:
            d.close()
    finally:
        s.close()
    return out


# ---- job records and history ---------------------------------------------------------------------------------

def _copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, ignore=lambda _d, names: [n for n in names if _never(n)])


def _copy_new(src_root: Path, dest_root: Path, dry: bool, depth_dirs: bool) -> dict:
    """Every entry of src_root that dest_root lacks, each copied under a temp name and renamed. With `depth_dirs` the
    unit is a top-level entry (a job); otherwise it is every file below (the history's archives and indexes)."""
    res = {"read": 0, "added": 0, "already_there": 0}
    if not src_root.is_dir():
        return res

    def units():
        if depth_dirs:
            for e in sorted(src_root.iterdir()):
                if not _never(e.name):
                    yield e, Path(e.name)
            return
        for base, dirs, files in os.walk(src_root):
            dirs[:] = sorted(d for d in dirs if not _never(d))
            for f in sorted(files):
                if not _never(f):
                    p = Path(base) / f
                    yield p, p.relative_to(src_root)

    for src, rel in units():
        res["read"] += 1
        dst = dest_root / rel
        if dst.exists():
            res["already_there"] += 1
            continue
        res["added"] += 1
        if dry:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(f".{dst.name}.importing")
        try:
            shutil.rmtree(tmp, ignore_errors=True) if tmp.is_dir() else tmp.unlink(missing_ok=True)
            if src.is_dir():
                _copy_tree(src, tmp)
            else:
                shutil.copy2(src, tmp)
            os.replace(tmp, dst)
        finally:
            shutil.rmtree(tmp, ignore_errors=True) if tmp.is_dir() else tmp.unlink(missing_ok=True)
    return res


# ---- entry ---------------------------------------------------------------------------------------------------

def default_source() -> Path:
    return Path(os.environ.get("ZSWARM_HOME") or (Path.home() / ".zswarm"))


def run(src_home: Path, dest_home: Path, dry: bool = False) -> dict:
    """Import everything; returns {kind: {read, added, already_there}}. Nothing is written when `dry`."""
    src_home, dest_home = Path(src_home), Path(dest_home)
    if not src_home.is_dir():
        raise FileNotFoundError(f"no ZSwarm home at {src_home}")
    state_path = dest_home / STATE_NAME
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("source") != str(src_home.resolve()):
            state = {}
    except (OSError, ValueError):
        state = {}
    if state.get("ran_at") and not dry:
        return {"already_ran": state["ran_at"]}  # a one-shot: ZSwarm is retired, nothing reads its home after the first run
    state["source"] = str(src_home.resolve())
    files = state.setdefault("files", {})
    out: dict = {"sqlite": _import_sqlite(src_home, dest_home, dry)}
    for name in LINE_FILES:
        out[name] = _import_lines(name, src_home, dest_home, files, dry)
    out[SAVINGS] = _import_savings(src_home, dest_home, files, dry)
    out["jobs"] = _copy_new(src_home / "jobs", dest_home / "jobs", dry, True)
    out["history"] = _copy_new(src_home / "history", dest_home / "history", dry, False)
    if not dry:
        dest_home.mkdir(parents=True, exist_ok=True)
        state["ran_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        tmp = state_path.with_name(STATE_NAME + ".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, state_path)
    return out


def summary_line(out: dict, dry: bool = False) -> str:
    if "already_ran" in out:
        return f"already ran at {out['already_ran']}; this import is a one-shot and does nothing more"
    parts = []
    for kind, v in out.items():
        if kind == "sqlite":
            for t, c in v.items():
                parts.append(f"{t}: read {c['read']}, added {c['added']}, there {c['already_there']}")
        else:
            parts.append(f"{kind}: read {v['read']}, added {v['added']}, there {v['already_there']}")
    return ("dry run, nothing written\n" if dry else "") + "\n".join(parts)
