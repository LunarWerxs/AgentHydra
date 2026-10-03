"""Shaping a job's results for the MCP tools: compact by default, filtered by id, status or taint, and
readable from disk when the job belongs to an earlier server process."""
from __future__ import annotations

from .job import Job
from .receipts import unverified_ids
from .spec import brief_row, merge_taint

CLEAN = "clean"  # the taint filter value that keeps only results with no taint letter at all
# Queued ids are listed up to this many, a count past it: the caller wrote them, and the list with its hint was
# 24.5% of hswarm_run answer chars (20,222 of 82,617 sampled). hswarm_results(status="pending") lists them all.
PENDING_IDS = 5
# The always-present bookkeeping of a job summary, which a poll does not decide on: a finished job's status answer
# was a median 685 chars with it and 103 without (284 jobs). The record on disk and verbose=true keep it.
BOOKKEEPING = ("tasks", "dir", "caller", "savings", "created", "finished", "checkpoint_at", "longest_task_s", "oldest_running_s", "queued_on_pool")


def brief_summary(summary: dict) -> dict:
    """A job summary as hswarm_status, hswarm_cancel and hswarm_jobs answer it: job_id, label, state, counts, cost_usd
    and every key the summary carries only when it matters (error, taints, not_advanced, acceptance, mis_scoped,
    quiet_running, a set budget, tasks of unknown cost...). `pools` stays only while one is waited on."""
    out = {k: v for k, v in summary.items() if k not in BOOKKEEPING}
    if out.get("budget_usd") is None:
        out.pop("budget_usd", None)
    if not out.get("cost_unknown_tasks"):
        out.pop("cost_unknown_tasks", None)
    if not out.get("waiting_on_rate_limited_pool"):
        out.pop("pools", None)
    return out


def _delivered(task_ids: list[str], since: str | None) -> set[str]:
    """The finished task ids a `cursor` says its caller already holds. The cursor is a hex bitmask over the job's
    task order, set for every finished row an answer carried: a row is skipped only once it was delivered. A time
    stamp cannot do this: a scripted or verified task is held at "running" past its own `finished` stamp, so a
    later cursor would skip it for good."""
    if not since:
        return set()
    try:
        mask = int(since, 16)
    except ValueError:
        raise ValueError(f"since {since!r} is not a cursor: pass the `cursor` an earlier answer for this job returned") from None
    return {tid for i, tid in enumerate(task_ids) if mask >> i & 1}


def _cursor(task_ids: list[str], delivered: set[str]) -> str:
    return format(sum(1 << i for i, tid in enumerate(task_ids) if tid in delivered), "x")


def _queue_hint(job: Job, running: list[dict], pending: list[str]) -> str:
    oldest = max((x["elapsed_s"] for x in running), default=0.0)
    return (f"{len(running)} running (oldest {oldest:.0f}s), {len(pending)} queued; "
            f"call hswarm_results('{job.id}') later or hswarm_status to poll.")


def taint_matches(taint: str | None, want: str | None) -> bool:
    """The taint filter: None keeps everything, "clean" keeps the untainted, and letters ("F", "TS") keep a result
    carrying ANY of them, so an orchestrator can pull exactly the results it must re-verify (spec.TAINTS)."""
    if not want:
        return True
    if want.strip().lower() == CLEAN:
        return not taint
    # Separators a caller may type ("F,T", "F T") are ignored; an unknown letter still raises, naming the known ones.
    return bool(set(taint or "") & set(merge_taint("".join(c for c in want.upper() if c.isalpha()))))


def _split(task_ids, results_by_id, ids: list[str] | None, status: str | None, ages: dict, max_answer_chars: int, taint: str | None = None,
           quiet: dict | None = None, skip: set[str] | frozenset = frozenset(), include_selection: bool = False) -> tuple[list, list, list]:
    """The finished results (answers truncated), the running ones with their age, and the queued ids. `skip`: the
    finished ids the caller's cursor says it already holds."""
    results, running, pending = [], [], []
    for t in task_ids:
        r = results_by_id.get(t.id)
        if r is None or t.id in skip or (ids and t.id not in ids) or (status and r.status != status):
            continue
        if r.status == "running":
            # Listed apart from the queue with its age, so a worker that has run for 40 minutes is visible
            # as exactly that instead of hiding among tasks that have not started. `quiet_s` is how long since
            # its last model reply: it keeps resetting on a slow task and only grows on a stalled one.
            entry = {"id": t.id, "started": r.started, "elapsed_s": ages.get(t.id, 0.0)}
            if quiet is not None and t.id in quiet:
                entry["quiet_s"] = quiet[t.id]
            running.append(entry)
        elif r.status == "pending":
            pending.append(t.id)
        elif taint_matches(r.taint, taint):
            # long answers are truncated with a hint, never silently cut
            results.append(_compact(r.as_dict(max_answer_chars, brief=True, include_selection=include_selection)))
    return results, running, pending


def _compact(d: dict, include_receipts: bool = False) -> dict:
    """The receipt ledger stays on disk: the verdicts say what it proved, and include_receipts brings it back."""
    if not include_receipts:
        d.pop("receipts", None)
    return d


def _flag_unverified(out: dict) -> dict:
    """Name the finished tasks whose "done" is not backed by receipts, so the orchestrator re-checks those first
    (it certifies nothing about the rest)."""
    unverified = unverified_ids(out["results"])
    if unverified:
        out["unverified"] = unverified
    return out


def job_payload(job: Job, max_answer_chars: int, include_pending: bool = False, ids: list[str] | None = None, status: str | None = None,
                include_receipts: bool = False, taint: str | None = None, since: str | None = None, include_selection: bool = False) -> dict:
    order = [t.id for t in job.tasks]
    held = _delivered(order, since)
    results, running, pending = _split(job.tasks, job.results, ids, status, job.running_ages(), max_answer_chars, taint, job.quiet_seconds(),
                                       held, include_selection)
    if include_receipts:
        for r in results:
            r["receipts"] = job.results[r["id"]].receipts
    out = _flag_unverified({"summary": job.summary(), "results": results})
    _stamp_cursor(out, order, held)
    if include_pending or running or pending:
        out["running"] = running
        out["pending"] = pending if len(pending) < PENDING_IDS or status == "pending" else len(pending)
        if running or pending:
            out["hint"] = _queue_hint(job, running, pending)
    return out


def _stamp_cursor(out: dict, order: list[str], held: set[str]) -> None:
    """`cursor` on every answer: pass it back as `since` and the next one carries only the rows that finished after
    it (14% of result-row chars in the sample, 38,070 of 267,653, were rows the chat already had). A record read
    from disk also lists its unfinished rows: those are never marked, so they come back once they finish. A
    `cancelled` row is unfinished too until its job is: in a job still running it was a server stop that cut the
    task, and the next server runs it again (jobs._journaled)."""
    open_ = ("pending", "running") if out["summary"].get("finished") else ("pending", "running", "cancelled")
    out["cursor"] = _cursor(order, held | {r["id"] for r in out["results"] if r.get("status") not in open_})
    if held:
        out["already_delivered"] = len(held)


def results_from_disk(job_id: str, ids: list[str] | None, status: str | None, max_answer_chars: int, include_receipts: bool = False,
                      taint: str | None = None, since: str | None = None, include_selection: bool = False) -> dict:
    """A job from an earlier server process: read its record instead of the live manager. A record written before
    taints existed has no `taint` key and reads as clean."""
    d = Job.load_from_disk(job_id)
    order = [t.get("id") for t in d.get("tasks") or [] if isinstance(t, dict)] or list(d["results"])
    held = _delivered(order, since)
    res = [r for r in d["results"].values()
           if r["id"] not in held and (not ids or r["id"] in ids) and (not status or r["status"] == status) and taint_matches(r.get("taint"), taint)]
    res = [_compact(brief_row(r, max_answer_chars, include_selection), include_receipts) for r in res]
    out = _flag_unverified({"summary": d["summary"], "results": res})
    _stamp_cursor(out, order, held)
    return out
