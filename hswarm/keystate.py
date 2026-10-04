"""The shared per-key rest/strike state: one SQLite row per key fingerprint (never a key), beside config.KEYS_STATE.

It used to be one JSON file (keys.json, ~1 MB: 4,464 entries of ~236 bytes) that every rest or recover rewrote whole
under a file lock, and every other process re-parsed whole. Now a rest upserts its one row, and a reader asks only for
the rows whose `rev` is past the last one it saw. Its own small database rather than tasks.sqlite: this one is written
by every process on every 429, so it keeps its own WAL and never queues behind a job-index transaction.

`rev` is a counter bumped under the write lock (BEGIN IMMEDIATE), so a reader that has seen rev N has seen every row
written before it. A recovered key with nothing left to remember is a `{}` row, not a deleted one, so the change
reaches readers that have the old entry cached; `prune` drops those after a day.

The legacy keys.json is imported once (the `imported` meta row), then deleted; nothing reads or writes it after that.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import time
from pathlib import Path

from . import config

LOCK_WAIT_S = 2.0          # a write waits this long for another process's write before giving up (the pool keeps its own copy)
TOMBSTONE_KEEP_S = 86400.0 # an emptied row is kept this long so every process sees it go (readers re-sync every few seconds)
_READINGS = ("balance_usd", "balance_at", "probed_at", "free_left")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS keys (fp TEXT PRIMARY KEY, entry TEXT NOT NULL, rev INTEGER NOT NULL, ts REAL NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS keys_rev ON keys(rev);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""
_ready: set[str] = set()   # database paths this process has created and imported into


def db_path() -> Path:
    """The database sits beside config.KEYS_STATE (the legacy file), named for it: keys.json -> keys.sqlite."""
    return config.KEYS_STATE.with_suffix(".sqlite")


def _legacy() -> dict | None:
    """The legacy keys.json parsed: {} when there is none, None when it cannot be read now."""
    for attempt in range(5):
        try:
            data = json.loads(config.KEYS_STATE.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except PermissionError:
            time.sleep(0.01 * (attempt + 1))  # Windows refuses a read while an old build replaces the file
        except (OSError, ValueError):
            return None
    return None


def _import_legacy(c: sqlite3.Connection) -> None:
    """Once per database: load keys.json into rows, then delete it. Marked done even when there was no file."""
    c.execute("BEGIN IMMEDIATE")
    try:
        if c.execute("SELECT 1 FROM meta WHERE k = 'imported'").fetchone():
            c.execute("COMMIT")
            return
        data = _legacy()
        if data is None:  # torn or unreadable: try again at the next open, never mark it done
            c.execute("COMMIT")
            return
        now = time.time()
        c.executemany("INSERT OR IGNORE INTO keys(fp, entry, rev, ts) VALUES (?, ?, ?, ?)",
                      [(fp, json.dumps(e, separators=(",", ":")), i, now) for i, (fp, e) in enumerate(data.items(), 1)
                       if isinstance(e, dict) and e])
        c.execute("INSERT OR REPLACE INTO meta(k, v) VALUES ('imported', ?)", (str(now),))
        c.execute("COMMIT")
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            c.execute("ROLLBACK")
        raise
    if data:
        with contextlib.suppress(OSError):
            config.KEYS_STATE.unlink()
    elif config.KEYS_STATE.exists():
        with contextlib.suppress(OSError):
            config.KEYS_STATE.unlink()


def connect() -> sqlite3.Connection:
    p = db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(p, timeout=LOCK_WAIT_S, isolation_level=None)
    try:
        if str(p) not in _ready:
            c.execute("PRAGMA page_size=1024")  # before the first table: a rest touches ~3 pages, so small pages are small writes
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(_SCHEMA)
            _import_legacy(c)
            _ready.add(str(p))
        c.execute("PRAGMA synchronous=NORMAL")
    except BaseException:
        c.close()
        raise
    return c


class Txn:
    """One write transaction (the lock): read a row fresh, put the rows that changed."""

    def __init__(self, c: sqlite3.Connection):
        self.c = c

    def changes(self, since: int | None) -> list[tuple[str, str, int]]:
        return changes(self.c, since)

    def put(self, fp: str, entry: dict) -> None:
        """Upsert one row; an empty entry is the `{}` tombstone. A row that would not change is not written."""
        text = json.dumps(entry, separators=(",", ":")) if entry else "{}"
        row = self.c.execute("SELECT entry FROM keys WHERE fp = ?", (fp,)).fetchone()
        if row is not None and row[0] == text:
            return
        if row is None and not entry:
            return
        self.c.execute(
            "INSERT INTO keys(fp, entry, rev, ts) VALUES (?, ?, (SELECT COALESCE(MAX(rev), 0) + 1 FROM keys), ?) "
            "ON CONFLICT(fp) DO UPDATE SET entry = excluded.entry, rev = excluded.rev, ts = excluded.ts",
            (fp, text, time.time()))


@contextlib.contextmanager
def txn():
    """Hold the write lock for one read-modify-write; yields None when it could not be taken (the caller keeps its own
    copy and writes nothing, as the file lock's timeout did). Commits on exit."""
    c = None
    try:
        c = connect()
        c.execute("BEGIN IMMEDIATE")
    except sqlite3.Error:
        if c is not None:
            c.close()
        yield None
        return
    try:
        yield Txn(c)
        c.execute("COMMIT")
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            c.execute("ROLLBACK")
        raise
    finally:
        c.close()


def changes(c: sqlite3.Connection, since: int | None) -> list[tuple[str, str, int]]:
    """(fingerprint, entry JSON, rev) of every row past `since` (all of them when None), oldest first."""
    return c.execute("SELECT fp, entry, rev FROM keys WHERE rev > ? ORDER BY rev", (since or 0,)).fetchall()


def read_changes(since: int | None) -> list[tuple[str, str, int]] | None:
    """`changes` on a fresh connection; None when the database cannot be read now (the caller keeps what it had)."""
    try:
        c = connect()
        try:
            return changes(c, since)
        finally:
            c.close()
    except sqlite3.Error:
        return None


def read_all() -> dict | None:
    """Every non-empty row as {fingerprint: entry}; None when unreadable (read_key_state)."""
    rows = read_changes(None)
    return None if rows is None else {fp: json.loads(t) for fp, t, _ in rows if t != "{}"}


def prune(live: set[str]) -> dict:
    """Drop rows for fingerprints no key list holds, tombstones past a day, and rests that ran out with nothing else to
    remember. Counts only."""
    now = time.time()
    out = {"stale": 0, "tombstones": 0, "expired": 0, "kept": 0}
    with txn() as tx:
        if tx is None:
            return out
        for fp, text, rev in tx.changes(None):
            e = json.loads(text)
            if fp not in live:
                tx.c.execute("DELETE FROM keys WHERE fp = ?", (fp,))
                out["stale"] += 1
            elif not e:
                if now - tx.c.execute("SELECT ts FROM keys WHERE fp = ?", (fp,)).fetchone()[0] > TOMBSTONE_KEEP_S:
                    tx.c.execute("DELETE FROM keys WHERE fp = ?", (fp,))
                    out["tombstones"] += 1
            elif (not e.get("disabled") and not e.get("broke") and not e.get("strikes")
                  and float(e.get("rest_until") or 0.0) < now):
                tx.put(fp, {k: e[k] for k in _READINGS if k in e})
                out["expired"] += 1
            else:
                out["kept"] += 1
    return out
