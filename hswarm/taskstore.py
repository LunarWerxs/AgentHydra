"""Every finished task, one row each: what it was asked to be, what it cost and how it ended.

It exists for two things. A task that names no max_cost_usd gets a cap sized from finished tasks of its own shape
(sized_cap), where the profile's flat default killed tasks that routinely needed more: over 7 days to 2026-10-02 the
cap killed 1,216 tasks and the work they had paid for ($404). And the history is something to learn from (owner,
Michael, 2026-10-02: "I'd like you to be able to learn from previous experience ... we have all this data"):
`hswarm history --tasks` answers what kind of task fails, times out or hits its cap, on which model, by SQL over
this table instead of a script reading thousands of job archives.

`maintain` adds every finished job not yet in it (index_jobs); the first run backfills all of them. The rows live
in config.HISTORY_DIR / tasks.sqlite, beside the archives they were read from, and are rebuilt from those at will."""
from __future__ import annotations

import math
import sqlite3
import time
from pathlib import Path

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  job_id TEXT NOT NULL, task_id TEXT NOT NULL, created TEXT, label TEXT, caller TEXT,
  backend TEXT, profile TEXT, role TEXT, tools TEXT, has_schema INTEGER, files INTEGER, prompt_chars INTEGER,
  size TEXT, model TEXT, served_model TEXT, status TEXT, taint TEXT, error TEXT,
  cost_usd REAL, max_cost_usd REAL, seconds REAL, timeout_s REAL, turns INTEGER, tool_calls INTEGER,
  in_tokens INTEGER, out_tokens INTEGER, legs INTEGER,
  PRIMARY KEY (job_id, task_id));
CREATE INDEX IF NOT EXISTS tasks_shape ON tasks (backend, profile, tools, has_schema, size, status);
CREATE TABLE IF NOT EXISTS indexed_jobs (job_id TEXT PRIMARY KEY);
"""
# A cap sized from history needs this many finished tasks of the shape, in this window, before it is trusted.
MIN_SAMPLES = 20
WINDOW_DAYS = 30
# p95 of what finished tasks of the shape spent, times this: headroom for a task a little bigger than most.
HEADROOM = 1.5
# History only RAISES a default, and never past this many times it: a cap is still the runaway guard.
MAX_RAISE = 4.0


def db_path() -> Path:
    return config.HISTORY_DIR / "tasks.sqlite"


def connect() -> sqlite3.Connection:
    db_path().parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path(), timeout=30)
    con.executescript(SCHEMA)
    return con


def size_bucket(chars: int) -> str:
    """The prompt's size, coarse: what a task costs grows with what it is handed."""
    for limit, name in ((4_000, "s"), (16_000, "m"), (64_000, "l")):
        if chars < limit:
            return name
    return "xl"


def tools_label(tools) -> str:
    if isinstance(tools, (list, tuple)):
        return ",".join(sorted(str(t) for t in tools))
    return str(tools or "read")


def _prompt_chars(job_id: str, task: dict, read_blob) -> int:
    text = task.get("prompt")
    if text is None and task.get("prompt_ref"):
        text = read_blob(task["prompt_ref"]) or ""
    return len(text or "")


def _text(d: dict, key: str, default: str = "") -> str:
    return d.get(key) or default


def _num(d: dict, key: str, cast=float):
    return cast(d.get(key) or 0)


def _tokens_in(usage: dict) -> int:
    return int((usage.get("in_hit") or 0) + (usage.get("in_miss") or 0))


def _task_cols(t: dict, chars: int) -> tuple:
    """backend .. model: what the task was asked to be."""
    return (
        _text(t, "backend", "api"), _text(t, "profile"), _text(t, "role"), tools_label(t.get("tools")),
        1 if (t.get("schema") or t.get("schema_jref")) else 0, len(t.get("files") or []), chars, size_bucket(chars),
        _text(t, "model"),
    )


def _result_cols(r: dict, t: dict) -> tuple:
    """served_model .. legs: how it ended (the cap and timeout are the task's, kept between the result's numbers)."""
    usage = r.get("usage") or {}
    return (
        _text(r, "model"), _text(r, "status"), _text(r, "taint"), _text(r, "error")[:300], _num(r, "cost_usd"),
        _num(t, "max_cost_usd"), _num(r, "seconds"), _num(t, "timeout_s"), _num(r, "turns", int),
        _num(r, "tool_calls", int), _tokens_in(usage), _num(usage, "out", int), len(r.get("failover") or []) + 1,
    )


def _finished_pair(t, results: dict):
    """(task id, its result) for a task that has finished, else None."""
    if not isinstance(t, dict):
        return None
    tid = str(t.get("id") or "")
    r = results.get(tid) or {}
    if not tid or r.get("status") in (None, "pending", "running"):
        return None
    return tid, r


def rows_of(job_id: str, doc: dict, read_blob) -> list[tuple]:
    summary = doc.get("summary") or {}
    head = (_text(summary, "created"), _text(summary, "label"), _text(summary, "caller"))
    results = doc.get("results") or {}
    out = []
    for t in doc.get("tasks") or []:
        pair = _finished_pair(t, results)
        if pair is None:
            continue
        tid, r = pair
        chars = _prompt_chars(job_id, t, read_blob)
        out.append((job_id, tid) + head + _task_cols(t, chars) + _result_cols(r, t))
    return out


def index_jobs(limit: int | None = None) -> dict:
    """Add every finished job not yet in the table. {jobs, tasks, skipped, errors}: a job still running waits, and
    one whose record cannot be read is counted and tried again next pass, never the end of it.

    A packed job (a zip, or its day's archive) never changes again (archive_old leaves a running one alone), so one
    that never finished is indexed with the tasks that did, not read again every night. Jobs past their warm week are
    read a day at a time, one pass of the day's archive (history.each_cold_job). 2026-10-08: read one by one, the 817
    cold jobs left (72 of them never finished, so retried every night) held maintain at its two-hour limit from 2026-10-04
    on, so nothing after this step (packing, the savings record, the page) ran."""
    from . import archive, history
    from .job import Job

    con = connect()
    done = {row[0] for row in con.execute("SELECT job_id FROM indexed_jobs")}
    out = {"jobs": 0, "tasks": 0, "skipped": 0, "errors": 0}

    def add(job_id: str) -> bool:
        """Index one job; False once `limit` is reached."""
        try:
            # load_from_disk folds results.jsonl back in: since dad8ce6 a finished job.json leaves out every result
            # already journaled there, and the raw record indexed such a job with no tasks at all (review, 2026-10-02).
            doc = Job.load_from_disk(job_id)
        except KeyError:
            out["skipped"] += 1
            return True
        except (ValueError, TypeError, AttributeError, OSError):  # a damaged record (UnicodeDecodeError is a ValueError)
            out["errors"] += 1
            return True
        if not (doc.get("summary") or {}).get("finished") and archive.job_dir(job_id).is_dir():
            out["skipped"] += 1
            return True
        try:
            rows = rows_of(job_id, doc, archive.blob_reader(job_id))
        except (ValueError, TypeError, AttributeError, OSError):
            out["errors"] += 1
            return True
        with con:
            con.executemany(f"INSERT OR REPLACE INTO tasks VALUES ({','.join('?' * 27)})", rows)
            con.execute("INSERT OR IGNORE INTO indexed_jobs VALUES (?)", (job_id,))
        out["jobs"] += 1
        out["tasks"] += len(rows)
        return not (limit and out["jobs"] >= limit)

    cold = history.cold_jobs()
    by_day: dict[str, set[str]] = {}
    try:
        for job_id in archive.job_ids():
            if job_id in done:
                continue
            if job_id in cold and not archive.job_dir(job_id).is_dir() and not archive.archive_path(job_id).is_file():
                by_day.setdefault(cold[job_id], set()).add(job_id)
            elif not add(job_id):
                return out
        for day in sorted(by_day, reverse=True):  # newest first, as job_ids
            left = set(by_day[day])
            try:
                for job_id in history.each_cold_job(day, by_day[day]):
                    left.discard(job_id)
                    if not add(job_id):
                        return out
            except history.READ_ERRORS:
                out["errors"] += len(left)
                continue
            out["skipped"] += len(left)  # in the day's index, not in its archive
        return out
    finally:
        con.close()


_caps: dict = {"stamp": None, "by_shape": {}}


def _shape_caps() -> dict[tuple, tuple[float, int]]:
    """{shape: (p95 cost of its ok tasks in the window, how many)}, re-read when the table changes."""
    try:
        st = db_path().stat()
    except OSError:
        return {}
    stamp = (st.st_mtime_ns, st.st_size)
    if stamp == _caps["stamp"]:
        return _caps["by_shape"]
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - WINDOW_DAYS * 86400))
    costs: dict[tuple, list[float]] = {}
    try:
        con = sqlite3.connect(f"file:{db_path().as_posix()}?mode=ro", uri=True, timeout=5)
        for backend, profile, tools, has_schema, size, cost in con.execute(
                "SELECT backend, profile, tools, has_schema, size, cost_usd FROM tasks WHERE status = 'ok' AND created >= ?",
                (since,)):
            costs.setdefault((backend, profile, tools, has_schema, size), []).append(cost)
        con.close()
    except sqlite3.Error:
        return {}
    by_shape = {}
    for shape, xs in costs.items():
        xs.sort()
        by_shape[shape] = (xs[min(len(xs) - 1, math.ceil(0.95 * len(xs)) - 1)], len(xs))
    _caps.update(stamp=stamp, by_shape=by_shape)
    return by_shape


def sized_cap(backend: str, profile: str | None, tools, has_schema: bool, prompt_chars: int, default: float) -> float | None:
    """The cap finished tasks of this shape call for, when it is above `default`. None keeps the default."""
    shape = (backend or "api", profile or "", tools_label(tools), 1 if has_schema else 0, size_bucket(prompt_chars))
    got = _shape_caps().get(shape)
    if not got or got[1] < MIN_SAMPLES:
        return None
    cap = min(got[0] * HEADROOM, default * MAX_RAISE)
    return round(cap, 4) if cap > default else None


def report(days: float = 30) -> list[dict]:
    """By shape and served model: how many tasks, how they ended, and what they cost, for learning from history."""
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - days * 86400))
    con = connect()
    cur = con.execute(
        """SELECT backend, profile, tools, has_schema, size, served_model, COUNT(*),
                  SUM(status = 'ok'), SUM(status = 'error'), SUM(status = 'timeout'), SUM(taint LIKE '%C%'),
                  ROUND(SUM(cost_usd), 4), ROUND(AVG(seconds), 1)
           FROM tasks WHERE created >= ? GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 7 DESC""", (since,))
    keys = ("backend", "profile", "tools", "schema", "size", "model", "tasks", "ok", "error", "timeout", "capped",
            "cost_usd", "avg_s")
    out = [dict(zip(keys, row)) for row in cur]
    con.close()
    return out
