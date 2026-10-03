"""One job: a batch of tasks, their results, and the on-disk record under ~/.hswarm/jobs/<id>/."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import secrets
import threading
from dataclasses import dataclass, field
from pathlib import Path

from . import blobs, config
from .caller import key as caller_key
from .spec import Result, Task, now_iso
from .web import collect_approvals

WEB_HINT = ("these hosts were not fetched: allow once by re-running the tasks with the host in web_hosts, "
            "always with hswarm_web(allow=[host]) or `hswarm web --allow HOST`; leave them out to deny")


def new_job_id() -> str:
    # Timestamp first so the jobs directory sorts chronologically; a hex tail keeps two jobs in one second apart.
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


@dataclass
class Job:
    id: str
    tasks: list[Task]
    concurrency: dict = field(default_factory=dict)
    label: str = ""
    budget_usd: float | None = None
    caller: dict = field(default_factory=dict)  # who submitted it: caller.detect() at submit time
    created: str = field(default_factory=now_iso)
    finished: str = ""
    state: str = "running"  # running | done | cancelled
    savings: dict = field(default_factory=dict)  # utilization.compact(): the Claude cost this job displaced, set when it finishes
    error: str = ""  # the one job-wide reason its tasks failed, when there is one (jobs.no_credit_left)
    resumed_from: str = ""  # the earlier job whose ok answers this one reused by content hash (jobs.resumable)
    task_keys: dict[str, str] = field(default_factory=dict)  # task id -> jobs.task_key, written on each journal line
    # task id -> the model it was submitted with. Routing moves task.model to the leg it is on, and a checkpoint
    # saves that leg; a job carried on after a restart (JobManager.adopt) must route from the submitted model.
    task_models: dict[str, str] = field(default_factory=dict)
    runner: dict = field(default_factory=dict)  # the process running it: {pid, port} (port: the shared server's)
    results: dict[str, Result] = field(default_factory=dict)
    _tasks: list[asyncio.Task] = field(default_factory=list, repr=False)
    _done: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _journaled: set[str] = field(default_factory=set, repr=False)  # task ids whose result is in results.jsonl

    @property
    def dir(self) -> Path:
        return config.JOBS_DIR / self.id

    def cost(self) -> float:
        return sum(r.cost_usd or 0.0 for r in self.results.values())

    def running_ages(self) -> dict[str, float]:
        """Seconds each RUNNING task has been running. A `cc` worker reports nothing until its process
        exits, so without this a stuck worker and a busy one read identically (cost 0, seconds 0)."""
        now = dt.datetime.now(dt.timezone.utc)
        ages = {}
        for tid, r in self.results.items():
            if r.status == "running" and r.started:
                try:
                    ages[tid] = round((now - dt.datetime.fromisoformat(r.started)).total_seconds(), 1)
                except ValueError:
                    continue  # an unparseable stamp is not an age; never a crash in a status read
        return ages

    def quiet_seconds(self) -> dict[str, float]:
        """Seconds since each RUNNING task last had a model reply booked (spec.Result.progress_at), or since it started
        when none has come yet. A slow task's stamp keeps moving; a stalled one's does not."""
        now = dt.datetime.now(dt.timezone.utc)
        quiet = {}
        for tid, r in self.results.items():
            stamp = (r.progress_at or r.started) if r.status == "running" else ""
            if not stamp:
                continue
            try:
                quiet[tid] = round((now - dt.datetime.fromisoformat(stamp)).total_seconds(), 1)
            except ValueError:
                continue  # an unparseable stamp is not an age; never a crash in a status read
        return quiet

    def quiet_running(self) -> dict[str, float]:
        """Running tasks with no reply for at least config.QUIET_TASK_S, by id: the stalled ones a caller should look at
        or cancel, told apart from the merely slow (2026-09-28: a stalled read job read as "running" until cancelled)."""
        return {tid: s for tid, s in self.quiet_seconds().items() if s >= config.QUIET_TASK_S}

    def waiting(self) -> dict:
        """Running api tasks whose leg has no key that can take a request right now, per leg: they are waiting on a
        rate-limited (or day-spent) pool, not working. Without this a job stuck behind 429 rests read as plain
        "running" for ten minutes (2026-09-24, job 20260924-152821-54f1: 60 of 61 tasks timed out at 0 turns)."""
        from . import keys  # keys builds pools off the client; job.py stays importable without it

        on: dict[str, int] = {}
        for r in self.results.values():
            if r.status == "running" and r.backend == "api":
                on[r.model] = on.get(r.model, 0) + 1
        out = {}
        for leg, n in on.items():
            try:
                prov = config.provider_of(leg)
            except (ValueError, KeyError):
                continue
            pool = keys.pool_for(prov)
            if pool is not None and not pool.available():
                wake = pool.soonest_wake()
                out[leg] = {"tasks": n, "why": f"every {prov} key is resting or disabled" + ("" if wake == float("inf") else f"; the soonest is free in {wake:.0f}s")}
        return out

    def not_advanced(self) -> dict[str, list[str]]:
        """Task ids per liveness label that is not `advanced` or `failed` (planning_only, blocked_external,
        approval_required), in task order; empty when every answered task moved the work."""
        out: dict[str, list[str]] = {}
        for t in self.tasks:
            r = self.results.get(t.id)
            label = getattr(r, "liveness", "") if r else ""
            if label and label not in ("advanced", "failed"):
                out.setdefault(label, []).append(t.id)
        return out

    def taint_counts(self) -> dict[str, int]:
        """How many results carry each taint letter (spec.TAINTS)."""
        out: dict[str, int] = {}
        for r in self.results.values():
            for c in r.taint:
                out[c] = out.get(c, 0) + 1
        return out

    def acceptance_counts(self) -> dict[str, int]:
        """holds / fails / UNVERIFIED over every acceptance row the finished tasks carry (acceptance.py); empty when none asked."""
        out: dict[str, int] = {}
        for r in self.results.values():
            for row in getattr(r, "acceptance", None) or []:
                out[row["verdict"]] = out.get(row["verdict"], 0) + 1
        return out

    def _summary_extras(self) -> dict:
        """The summary keys that appear only when they have something to say."""
        return {
            # An "ok" that only planned, is blocked or asks for a yes, by label: the ids a caller should
            # continue or escalate rather than count as done (worker.classify_liveness).
            **({"not_advanced": na} if (na := self.not_advanced()) else {}),
            # How many results carry each taint letter (spec.TAINTS), so a caller sees at a glance what to re-verify.
            **({"taints": tc} if (tc := self.taint_counts()) else {}),
            # "status ok" is the worker's word; these are the criteria checked in code, over every finished task
            **({"acceptance": ac} if (ac := self.acceptance_counts()) else {}),
            **({"error": self.error} if self.error else {}),
            **({"resumed_from": self.resumed_from, "cached": sum(1 for r in self.results.values() if r.cached_from)} if self.resumed_from else {}),
            # tasks that carried a scope block and never echoed it: their answers are about some other tree
            **({"mis_scoped": ms} if (ms := sorted(i for i, r in self.results.items() if getattr(r, "mis_scoped", False))) else {}),
            **({"waiting_on_rate_limited_pool": w} if self.state == "running" and (w := self.waiting()) else {}),
            # Running tasks with no model reply for config.QUIET_TASK_S: stalled, not slow (job.quiet_running).
            **({"quiet_running": q} if self.state == "running" and (q := self.quiet_running()) else {}),
            # The suspend half of read_url's host gate: every host a worker needed and was not given, once each.
            **({"web_approvals": a, "web_approvals_hint": WEB_HINT} if (a := collect_approvals(self.results.values())) else {}),
        }

    def summary(self) -> dict:
        counts: dict[str, int] = {}
        for t in self.tasks:
            r = self.results.get(t.id)
            st = r.status if r else "pending"
            counts[st] = counts.get(st, 0) + 1
        return {
            "job_id": self.id,
            "label": self.label,
            "state": self.state,
            "tasks": len(self.tasks),
            "counts": counts,
            **self._summary_extras(),
            "cost_usd": round(self.cost(), 6),
            "cost_unknown_tasks": sum(1 for r in self.results.values() if r.cost_usd is None),
            "budget_usd": self.budget_usd,
            "longest_task_s": round(max((r.seconds for r in self.results.values()), default=0.0), 2),
            "oldest_running_s": max(self.running_ages().values(), default=0.0),
            "caller": caller_key(self.caller),
            "savings": self.savings,
            "created": self.created,
            "finished": self.finished,
            "dir": str(self.dir),
        }

    def to_dict(self, blob_dir: Path | None = None, summary: dict | None = None, omit: set[str] | frozenset = frozenset()) -> dict:
        """The job record. With `blob_dir`, each task's long strings (the shared system prompt, a big schema)
        move to a blob there and the task keeps a short `<field>_ref`: one copy per job instead of one per
        task, which is the whole difference between 271 MiB and 1 MiB on a 1,844-task job. Without it the
        record is fully self-contained, which is what `run --out` wants. `summary` is the live status a running
        job's checkpoint writes (JobManager.status), in place of the bare summary. `omit`: task ids whose result
        the record leaves out (already in results.jsonl; Job.save)."""
        tasks = [t.as_dict() for t in self.tasks]
        return {
            # Top-level mirrors of summary.state/finished: a hand-written waiter polls `j.get('finished')`
            # because every result row carries one. Two such loops ran 70 minutes past a done job on
            # 2026-09-23, unbounded, because the job-level stamp only lived under "summary".
            "state": self.state,
            "finished": self.finished,
            "summary": summary or self.summary(),
            "caller": dict(self.caller),
            "runner": dict(self.runner),
            "task_keys": dict(self.task_keys),
            "task_models": dict(self.task_models),
            "concurrency": self.concurrency,
            "tasks": blobs.pack_all(tasks, blob_dir) if blob_dir else tasks,
            "results": {k: v.as_dict() for k, v in self.results.items() if k not in omit},
        }

    def save(self, status: dict | None = None) -> None:
        """Atomic write: a reader that races the save sees the old file or the new one, never a torn one. The
        summary carries `checkpoint_at`, which is how a reader tells a running job from one nothing runs any more.

        Every save leaves out the results already appended to results.jsonl: every reader folds that file over the
        record (_overlay_live_results while it runs, fold_journal once it is finished, adopt's _journaled), and writing
        them again every checkpoint rewrote a 37 MB record six times a minute on the loop (ZergSwarm, 2026-09-29).
        The last save wrote them all a second time: job 20261001-073621-cf71's job.json was 40.4 MB, 23.75 MB of it
        the results its 24.7 MB journal already held, and 27% of it the indent, so the record is compact too."""
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / "job.json.tmp"
        summary = {**(status or self.summary()), "checkpoint_at": now_iso()}
        tmp.write_text(json.dumps(self.to_dict(blobs.blob_dir(self.dir), summary, self._journaled), separators=(",", ":"), ensure_ascii=False, default=str), encoding="utf-8")
        os.replace(tmp, self.dir / "job.json")

    @staticmethod
    def load_from_disk(job_id: str) -> dict:
        from . import archive

        doc = archive.read_json(job_id, "job.json")  # the folder, else the archive
        if doc is None:
            raise KeyError(job_id)
        return fold_journal(job_id, Job._overlay_live_results(job_id, doc))

    @staticmethod
    def _overlay_live_results(job_id: str, doc: dict) -> dict:
        """Fold `results.jsonl` over a RUNNING job's record before anyone reads it.

        ⛔ WHY: `job.json` is rewritten at checkpoints, `results.jsonl` is appended the moment each
        task finishes - so a reader between checkpoints saw a job whose every task had ALREADY
        returned reported as `pending: 34`. Measured 2026-09-17 by an orchestrator that watched a
        finished 34-task job report zero progress for eighteen minutes and went looking for a hang
        that did not exist. A status read that lags the facts it is summarising is worse than no
        status: it is read as evidence.

        Only a job that is not yet `finished` is overlaid (a finished record's summary is already whole;
        fold_journal puts its results back), and an unreadable or half-written line is skipped rather than
        raised - a status read must never be the thing that crashes.
        """
        summary = doc.get("summary")
        if not isinstance(summary, dict) or summary.get("finished"):
            return doc
        if summary.get("state") == "running" and (silent := Job._silent_for(summary)) is not None:
            # The process running the job checkpoints every config.CHECKPOINT_S; a record this quiet is one nothing is
            # running (a killed `python -m hswarm run`, a closed session), so its pending tasks will never start.
            summary = {**summary, "state": "orphaned", "orphaned": Job._orphaned_why(doc, silent)}
            doc = {**doc, "state": "orphaned", "summary": summary}
        path = config.JOBS_DIR / job_id / "results.jsonl"
        if not path.exists():
            return doc
        live = _read_live_rows(path)
        if not live:
            return doc
        results = {**doc.get("results", {}), **live}
        doc = {**doc, "results": results}
        doc["summary"] = _live_summary(summary, doc.get("tasks", []) or [], results)
        return doc

    @staticmethod
    def _orphaned_why(doc: dict, silent: float) -> str:
        """What a quiet record tells its caller. A shared server's job is carried on by the next server on its port
        (JobManager.adopt_orphans): a caller told to resubmit it would pay for the unfinished tasks twice."""
        port = (doc.get("runner") or {}).get("port")
        if port and silent <= config.ADOPT_WITHIN_S:
            return (f"no checkpoint for {silent:.0f}s: the shared server on port {port} stopped, and it carries this job "
                    f"on when it restarts within {config.ADOPT_WITHIN_S / 60:.0f} min of the last checkpoint. To run the "
                    "tasks elsewhere instead, cancel this job first (hswarm_cancel), or they run twice")
        return (f"no checkpoint for {silent:.0f}s: the process running this job is gone or wedged, "
                "so its unfinished tasks will not run; resubmit them")

    @staticmethod
    def _silent_for(summary: dict) -> float | None:
        """Seconds since a running record's last checkpoint, when past config.CHECKPOINT_SILENT_S; else None (a
        record written before checkpoints existed carries no stamp and is never judged)."""
        try:
            at = dt.datetime.fromisoformat(str(summary["checkpoint_at"]))
        except (KeyError, ValueError):
            return None
        silent = (dt.datetime.now(dt.timezone.utc) - at).total_seconds()
        return silent if silent > config.CHECKPOINT_SILENT_S else None

    @staticmethod
    def prunable(days: int) -> list[tuple[Path, int]]:
        """Finished jobs older than `days`, folders and archives alike, with their size in bytes. These are a
        CACHE of work already delivered (results and worker transcripts); the numbers live in the ledger and
        the synced shard, so nothing here is the only copy of anything."""
        if not config.JOBS_DIR.exists():
            return []
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max(0, days))
        stamp = cutoff.strftime("%Y%m%d-%H%M%S")  # job ids sort chronologically, so the id IS the age test
        out = []
        for p in sorted(config.JOBS_DIR.iterdir()):
            name = p.stem if p.is_file() and p.suffix == ".zip" else p.name
            if name >= stamp or not (p.is_dir() or p.suffix == ".zip"):
                continue
            size = p.stat().st_size if p.is_file() else sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            out.append((p, size))
        return out

    @staticmethod
    def list_on_disk(limit: int = 20) -> list[dict]:
        from . import archive

        out = []
        for job_id in archive.job_ids(max(1, limit)):
            # A finished record is parsed once per process, not on every poll: the console lists jobs every 3 s,
            # and one 37 MB job.json among the newest was parsed whole each time for its summary alone (ZergSwarm,
            # 2026-09-29). A rewrite or an archiving changes the stamp, so it is read again then.
            stamp = _record_stamp(job_id)
            if stamp is not None and (hit := _FINISHED_SUMMARIES.get(job_id)) and hit[0] == stamp:
                out.append(dict(hit[1]))
                continue
            doc = archive.read_json(job_id, "job.json")
            if isinstance(doc, dict) and "summary" in doc:
                # the same live overlay a single status read gets: a running job's checkpoint says "pending"
                # for every task that has returned since, and hswarm_jobs is the first place anyone looks
                summary = Job._overlay_live_results(job_id, doc)["summary"]  # a half-written or foreign entry is skipped, not fatal
                out.append(summary)
                if stamp is not None and isinstance(summary, dict) and summary.get("finished"):
                    with _FINISHED_LOCK:
                        _FINISHED_SUMMARIES[job_id] = (stamp, dict(summary))
                        while len(_FINISHED_SUMMARIES) > 512:
                            _FINISHED_SUMMARIES.pop(next(iter(_FINISHED_SUMMARIES)))
        return out


_FINISHED_SUMMARIES: dict[str, tuple[tuple, dict]] = {}  # job id -> (record stamp, the finished record's summary)
_FINISHED_LOCK = threading.Lock()


def _record_stamp(job_id: str) -> tuple | None:
    """(path, mtime_ns, size) of the file archive.read_json(job_id, "job.json") reads: the folder's record, else the
    archive. Any rewrite or archiving changes it."""
    from . import archive

    for p in (archive.job_dir(job_id) / "job.json", archive.archive_path(job_id)):
        try:
            st = p.stat()
        except OSError:
            continue
        return (str(p), st.st_mtime_ns, st.st_size)
    from . import history

    return history.job_day_stamp(job_id)


def _live_row(line: str) -> dict | None:
    """One `results.jsonl` line as a result row with a string id, else None."""
    line = line.strip()
    if not line:
        return None
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        return None  # the last line of a file being appended to can be half-written
    return row if isinstance(row, dict) and isinstance(row.get("id"), str) else None


def _live_rows(text: str) -> dict[str, dict]:
    """Every readable row of a `results.jsonl` text by task id, the last one winning."""
    live: dict[str, dict] = {}
    for line in text.splitlines():
        row = _live_row(line)
        if row is not None:
            live[row["id"]] = row
    return live


def _read_live_rows(path: Path) -> dict[str, dict]:
    """_live_rows of the file at `path`; empty when it cannot be read."""
    try:
        return _live_rows(path.read_text(encoding="utf-8"))
    except OSError:
        return {}


def fold_journal(job_id: str, doc: dict) -> dict:
    """A FINISHED record with the results its saves left to `results.jsonl` (Job.save) put back, in task order.

    The journal is read from the folder or the archive (a zipped job has no folder), so a finished job still answers
    status and results from disk. A record that already holds a result for every task (one saved before 2026-10-02,
    or by cancel_on_disk) is returned as it is, its journal unread; where both hold a row the record's wins."""
    summary = doc.get("summary")
    if not isinstance(summary, dict) or not summary.get("finished"):
        return doc
    from . import archive

    results = doc.get("results") or {}
    ids = [t.get("id") for t in doc.get("tasks") or [] if isinstance(t, dict)]
    if all(i in results for i in ids):
        return doc
    rows = {**_live_rows(archive.read_text(job_id, "results.jsonl") or ""), **results}
    ordered = {i: rows.pop(i) for i in ids if i in rows}
    return {**doc, "results": {**ordered, **rows}}


def _live_counts(tasks: list, results: dict) -> dict[str, int]:
    counts: dict[str, int] = {}
    for task in tasks:
        tid = task.get("id") if isinstance(task, dict) else None
        status = (results.get(tid) or {}).get("status", "pending") if tid else "pending"
        counts[status] = counts.get(status, 0) + 1
    return counts


def _live_summary(summary: dict, tasks: list, results: dict) -> dict:
    """The record's summary with its counts, cost and longest task recomputed over the live results."""
    counts = _live_counts(tasks, results)
    costs = [r.get("cost_usd") for r in results.values() if isinstance(r, dict)]
    return {
        **summary,
        "counts": counts or summary.get("counts", {}),
        "cost_usd": round(sum(c for c in costs if isinstance(c, (int, float))), 6),
        "cost_unknown_tasks": sum(1 for c in costs if c is None),
        "longest_task_s": round(max((r.get("seconds") or 0.0) for r in results.values()), 2) if results else 0.0,
    }
