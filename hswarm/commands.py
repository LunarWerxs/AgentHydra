"""The CLI's command bodies. Each takes the parsed argparse namespace and returns an exit code;
the parser and dispatch are in cli.py, the installer in install.py."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from . import batching, config, dispatch, review
from .acceptance import tally
from .jobs import JobManager
from .results import taint_matches
from .spec import Task


def _print(obj) -> None:
    print(json.dumps(obj, indent=1, ensure_ascii=False, default=str))


async def cmd_doctor(_a) -> int:
    from .mcp_server import hswarm_doctor  # the MCP tool is the one implementation; the CLI just prints it

    d = await hswarm_doctor()
    _print(d)
    # The verdict, not the DeepSeek key: a machine with no DeepSeek key but a live Gemini/groq pool serves every
    # auto route, and exiting 1 there told sessions the swarm was dead when it was not (verdict.py).
    return 0 if d["verdict"]["usable"] and "api_error" not in d else 1


async def cmd_ask(a) -> int:
    from . import config

    # `ask` is TOOL-FREE by definition, so AUTO here means the tool-free default, not the safe tool-using one.
    from .selection import profile_for
    profile = getattr(a, "profile", None)
    if getattr(a, "role", None) and config.ROLES.get(a.role.strip().lower()) != config.AUTO:
        model = config.resolve_role(a.role)
        profile = None
    elif not a.model or str(a.model).strip().lower() == config.AUTO:
        model = config.AUTO
        profile = profile or profile_for(getattr(a, "role", None), "none")
    else:
        model = config.resolve_model(a.model)
        profile = None
    schema = json.loads(a.schema) if a.schema else None
    system = review.with_contract(getattr(a, "role", None), a.system)  # the same evidence bar the MCP ask gives a review role
    m = JobManager()
    try:
        r = await m.ask_routed(a.prompt, model, route=not getattr(a, "no_route", False), system=system, schema=schema,
                               thinking=a.thinking, reasoning_effort=a.effort, **({"profile": profile} if profile else {}))
    finally:
        await m.aclose()
    if a.json:
        _print(r.as_dict())
    else:
        print(r.answer if r.status == "ok" else f"[{r.status}] {r.error}")
        cost = "-" if r.cost_usd is None else f"${r.cost_usd:.6f}"
        via = f" (failed over from {', '.join(r.failover)})" if r.failover else ""
        tainted = f" taint={r.taint}" if r.taint else ""
        print(f"-- {r.model}{via}{tainted} {r.seconds}s {cost} usage={r.usage}", file=sys.stderr)
    return 0 if r.status == "ok" else 1


async def cmd_panel(a) -> int:
    # The MCP tool is the one implementation (it also books the asks); the CLI just prints it.
    from .mcp_server import hswarm_panel

    models = [m for m in (a.models or "").split(",") if m.strip()] or None
    out = await hswarm_panel(a.prompt, models=models, system=a.system, max_findings=a.max_findings, reasoning_effort=a.effort, seed=a.seed)
    if a.json or "error" in out:
        _print(out)
        return 1 if "error" in out else 0
    for r in out["findings"]:
        who = f"upheld by {', '.join(r['upheld_by']) or '-'}; rejected by {', '.join(r['rejected_by']) or '-'}"
        print(f"[{r['status'].upper():10}] {r['id']:6} {r['finding']}\n{'':20}{r['by']} | {who}")
    for m in out["missed"]:
        print(f"[MISSED    ] {m['finding']}  ({m['by']})")
    s = out["summary"]
    print(f"-- {s['panelists']} panelists, {s['answered']} answered, {s['contested']} contested, ${s['cost_usd']:.6f}, {s['seconds']}s"
          + (f" ({s['note']})" if s.get("note") else ""), file=sys.stderr)
    return 0 if s["answered"] else 1


def _load_tasks(path: str, a) -> list[Task]:
    """A tasks file is a list, or {defaults, tasks}; command-line flags override the file's defaults.

    `run` takes a PATH, not a prompt. Handing it a prompt is the obvious first mistake (it reads like
    every other CLI), and the bare read used to answer with a FileNotFoundError traceback whose
    "filename" was the whole prompt - true, and useless. Say what the argument is instead, and name
    the one-prompt command next door.
    """
    p = Path(path)
    if not p.exists():
        hint = "`hswarm ask \"<prompt>\"` runs a single prompt" if (" " in path or len(path) > 120) else ""
        raise SystemExit(f"hswarm run: '{path}' is not a file. The argument is a PATH to a JSON tasks file "
                         f"(a list of tasks, or {{\"defaults\": {{...}}, \"tasks\": [...]}}). {hint}".rstrip())
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"hswarm run: {path} is not valid JSON ({e}).") from None
    defaults = {}
    tasks = doc
    if isinstance(doc, dict):
        # WHY: only `defaults` and `tasks` are read, so a file written with `default` (or budget_usd, concurrency) ran
        # its whole batch on the built-in ones: tools read instead of none, the shell's folder, no schema, no budget.
        if extra := sorted(set(doc) - {"defaults", "tasks"}):
            from .spec import did_you_mean

            flags = {"budget_usd": "--budget", "budget": "--budget", "concurrency": "--concurrency", "label": "--label"}
            said = "".join(f"; {k!r} is the {flags[k]} flag, not a file key" for k in extra if k in flags)
            raise SystemExit(f"hswarm run: {path} has top-level keys a tasks file does not take: {extra}{said}; it takes "
                             f'only "defaults" and "tasks"{did_you_mean([k for k in extra if k not in flags], ("defaults", "tasks"))}')
        defaults = doc.get("defaults") or {}
        tasks = doc.get("tasks") or []
    if not isinstance(defaults, dict) or not isinstance(tasks, list):
        raise SystemExit(f"hswarm run: {path} must be a list of tasks, or {{\"defaults\": {{...}}, \"tasks\": [...]}} "
                         "with an object and a list.")
    defaults = dict(defaults)
    for k in ("backend", "model", "cwd", "tools", "web_hosts", "capability", "max_turns", "timeout_s", "confirm_write", "isolated", "recipe", "escalate", "redact"):
        v = getattr(a, k, None)
        if v is not None:
            defaults[k] = v
    return [Task.from_dict(t if isinstance(t, dict) else {"prompt": t}, defaults, i) for i, t in enumerate(tasks)]


def _check_run(a) -> int:
    """`run --check`: everything `run` does to a tasks file before it submits (load, merge the flags, validate every
    task, the batching rule, the route check), then a line per task instead of a job. Spends nothing and writes no
    job: a file with a typo used to show its mistake only after the batch had run and been paid for (2026-10-02)."""
    from . import jobs

    try:
        tasks = _load_tasks(a.tasks, a)
        if not getattr(a, "unbatched", False) and (why := batching.unbatched_run(tasks)):
            raise ValueError(why + " (CLI: --unbatched)")
        if why := jobs.batch_refusal(tasks):  # what submit itself refuses (duplicate ids, the daily cap, ...)
            raise ValueError(why)
        if getattr(a, "envelope", None):
            json.loads(a.envelope)
    except ValueError as e:  # json.JSONDecodeError is a ValueError
        print(f"hswarm run --check: refused: {e}")
        return 1
    for t in tasks:
        route = t.model if t.model and t.model != "auto" else f"auto/{t.profile or 'general'}"
        print(f"{t.id}: cwd={t.cwd} tools={t.tools} route={route} max_cost_usd={t.max_cost_usd} "
              f"timeout_s={t.timeout_s} schema={'yes' if t.schema else 'no'}")
    print(f"job: {len(tasks)} task(s), budget_usd={a.budget}, concurrency={a.concurrency}, "
          f"label={a.label or Path(a.tasks).stem}")
    if why := jobs.unservable(tasks):
        print(f"not servable: {why}")
        return 1
    print("servable: nothing was sent")
    return 0


async def cmd_run(a) -> int:
    if getattr(a, "check", False):
        return _check_run(a)
    m = JobManager()
    t0 = time.perf_counter()
    envelope = json.loads(a.envelope) if getattr(a, "envelope", None) else None
    try:
        tasks = _load_tasks(a.tasks, a)
        if not getattr(a, "unbatched", False) and (why := batching.unbatched_run(tasks)):
            raise ValueError(why + " (CLI: --unbatched)")
        job = m.submit(tasks, concurrency=a.concurrency, label=a.label or Path(a.tasks).stem, budget_usd=a.budget,
                       envelope=envelope, resume_from=getattr(a, "resume_from", None))
    except ValueError as e:  # a task spec or a job refused up front (NoCapableSwarmRoute, NoCreditLeft): say why, no traceback
        raise SystemExit(f"hswarm run: refused: {e}") from None
    cached = sum(1 for r in job.results.values() if r.cached_from)
    print(f"job {job.id}: {len(tasks)} tasks" + (f", {cached} reused from {job.resumed_from}" if job.resumed_from else ""), file=sys.stderr)
    for note in dispatch.route_outlook(tasks, m._gates):  # what hswarm_run says in its first response
        print(f"  route: {note}", file=sys.stderr)
    last = ""
    while not job._done.is_set():
        await asyncio.sleep(0.5)  # a progress line whenever the status counts change, so a long batch is visibly alive
        status = m.status(job)
        line = " ".join(f"{k}={v}" for k, v in sorted(status["counts"].items()))
        if waiting := status.get("waiting_on_rate_limited_pool"):
            line += " | waiting: " + "; ".join(f"{p}: {why}" for p, why in sorted(waiting.items()))
        if line != last and not a.quiet:
            print(f"  {time.perf_counter() - t0:6.1f}s {line}", file=sys.stderr)
            last = line
    await m.aclose()
    if a.out:
        Path(a.out).write_text(json.dumps(job.to_dict(), indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {a.out}", file=sys.stderr)
    s = job.summary()
    sv = s.get("savings") or {}
    saved = f" saved~${sv['saved_usd']:.4f} vs {sv['est_model']}" if sv.get("saved_usd") is not None else ""
    print(f"done in {time.perf_counter() - t0:.1f}s: {s['counts']} cost=${s['cost_usd']:.4f}{saved}", file=sys.stderr)
    if not a.out or a.print:
        for t in tasks:
            _print_result(t.id, job.results[t.id].as_dict())
    return 0 if all(r.status == "ok" for r in job.results.values()) else 1


def _print_result(task_id: str, r: dict) -> None:
    tainted = f" taint={r['taint']}" if r.get("taint") else ""
    print(f"\n=== {task_id} [{r['status']}]{tainted} {r['seconds']}s ${(r['cost_usd'] or 0):.5f} turns={r['turns']} files={r['files_changed']}")
    print(r["answer"] if r["status"] == "ok" else r["error"])
    # The receipt verdicts (receipts.py): whether the answer's claims are backed by the worker's own tool calls.
    if r.get("citations"):
        print(f"--- citations: {r['citations']['verdict']} ({r['citations']['resolved']} resolved of {r['citations']['receipts']} receipts)")
    if r.get("green"):
        print(f"--- green {r['green']['required']}: {r['green']['verdict']}" + "".join(f"\n    missing: {m}" for m in r["green"]["missing"]))
    # The typed acceptance criteria (acceptance.py), decided in code: "2/3 hold, 1 fails" before anything is merged.
    if r.get("acceptance"):
        print(f"--- criteria: {tally(r['acceptance'])}" + "".join(f"\n    [{row['verdict']}] {row['criterion']} - {row['detail']}" for row in r["acceptance"]))


async def cmd_status(a) -> int:
    _print(JobManager.load_from_disk(a.job)["summary"])
    return 0


async def cmd_cancel(a) -> int:
    try:
        _print(JobManager.cancel_on_disk(a.job))
    except KeyError:
        raise SystemExit(f"hswarm cancel: no job {a.job}") from None
    return 0


async def cmd_results(a) -> int:
    try:
        taint_matches("", getattr(a, "taint", None))  # a bad --taint is a usage error, not a traceback
    except ValueError as exc:
        raise SystemExit(f"hswarm results --taint: {exc}") from None
    for r in JobManager.load_from_disk(a.job)["results"].values():
        if (not a.id or r["id"] in a.id) and taint_matches(r.get("taint"), getattr(a, "taint", None)):
            _print_result(r["id"], r)
    return 0


async def cmd_jobs(a) -> int:
    if a.archive_hours is not None:
        from . import archive

        r = await asyncio.to_thread(archive.archive_old, a.archive_hours, a.apply)
        if not r["jobs"]:
            print(f"no job folder older than {a.archive_hours}h under {config.JOBS_DIR}")
            return 0
        verb = "freed" if a.apply else "would free"
        print(f"{r['jobs']} job(s) older than {a.archive_hours}h: {r['before']/2**20:,.0f} MiB -> {r['after']/2**20:,.0f} MiB, "
              f"{verb} {r['saved']/2**20:,.0f} MiB ({r['saved']/r['before']*100:.0f}%)")
        for e in r["errors"]:
            print(f"  SKIPPED: {e}")
        if not a.apply:
            print("dry run. Each job becomes one compressed file; every reader falls back to it, so results and\n"
                  "transcripts keep working. Re-run with --apply.")
        return 0 if not r["errors"] else 1
    if a.compact:
        from . import blobs

        folders = sorted(d for d in config.JOBS_DIR.iterdir() if d.is_dir()) if config.JOBS_DIR.exists() else []
        before = after = 0
        for d in folders:
            r = await asyncio.to_thread(blobs.compact_job, d, a.apply)
            before += r["before"]
            after += r["after"]
        saved = max(0, before - after)
        verb = "freed" if a.apply else "would free"
        print(f"{len(folders)} job folder(s): {before/2**20:,.0f} MiB of records -> {after/2**20:,.0f} MiB, {verb} {saved/2**20:,.0f} MiB "
              f"({saved/before*100:.0f}%)" if before else "no job records on disk")
        if not a.apply and before:
            print("dry run, and it is lossless: long strings move to one blob per job, the records keep a short\n"
                  "reference and expand on read. Re-run with --apply to rewrite them.")
        return 0
    if a.prune_days is not None:
        from .job import Job

        victims = Job.prunable(a.prune_days)
        mb = sum(size for _, size in victims) / 2**20
        if not victims:
            print(f"nothing older than {a.prune_days} day(s) under {config.JOBS_DIR}")
            return 0
        print(f"{len(victims)} job folder(s) older than {a.prune_days} day(s), {mb:,.0f} MiB: {victims[0][0].name} .. {victims[-1][0].name}")
        if not a.apply:
            print("dry run. The ledger, the savings DB and the synced shard keep every number; these folders hold the\n"
                  "workers' own results and transcripts, already delivered. Re-run with --apply to delete them.")
            return 0
        import shutil

        for d, _ in victims:
            shutil.rmtree(d, ignore_errors=True)
        print(f"deleted {len(victims)} folder(s), {mb:,.0f} MiB freed")
        return 0
    for s in JobManager.list_on_disk(a.limit):
        print(f"{s['job_id']}  {s['state']:9s} tasks={s['tasks']:<4d} {s['counts']}  ${s['cost_usd']:.4f}  {s['label']}")
    return 0


async def cmd_cost(a) -> int:
    from .mcp_server import hswarm_cost

    _print(await hswarm_cost(a.days, a.balance))
    return 0


async def cmd_bench(a) -> int:
    from bench.run import run_bench  # type: ignore

    return await run_bench(a)


async def cmd_savings(a) -> int:
    from . import savings, savings_view, utilization

    savings.lower_priority()
    if a.record:
        done = await asyncio.to_thread(savings.record, a.backfill)
        savings.log(f"recorded {', '.join(done) or 'nothing new'}")
    if a.backfill_jobs:
        added = await asyncio.to_thread(utilization.backfill)
        print(f"backfilled {added['jobs']} job(s) and {added['asks']} ask(s) from disk into the utilization ledger")
    if a.remeasure:
        done = await asyncio.to_thread(savings.remeasure, a.remeasure)
        savings.log(f"remeasured {', '.join(done) or 'nothing'}")
        if not a.quiet:
            print(f"re-measured {len(done)} day(s): {', '.join(done)}")
    if a.profile:
        rows = savings.load_rows()
        prof = await asyncio.to_thread(utilization.refresh_profile, [rows[k] for k in sorted(rows)])
        print(f"profile {prof['id']}: {prof['basis']} x{prof['sample']} over {prof['pool_days']} day(s), repriced {prof['repriced']} row(s)" if prof
              else "profile: not measured, fewer than 5 sub-agents on the recorded days (run --record first)")
    if a.sync:
        rep = await asyncio.to_thread(utilization.sync, True)
        savings.log(f"sync: imported {rep['imported']}, committed {rep['committed']}, pushed {rep['pushed']}, notes {rep['notes']}")
        if not a.quiet:
            _print(rep)
    from . import report_html

    html_to = Path(a.html) if isinstance(a.html, str) and a.html else None
    if a.quiet and (a.record or a.profile or a.sync or a.backfill_jobs or a.remeasure):
        if not a.sync:  # sync already measured today; a quiet record still refreshes the page with today's share
            await asyncio.to_thread(utilization.measure_today)
        report_html.write(html_to)
        return 0
    if a.list or (a.html and not a.today):
        if not a.sync:
            await asyncio.to_thread(utilization.measure_today)
        print(f"html: {report_html.write(html_to)}")
        if a.list:
            print(utilization.render(utilization.summary(a.list)))
        return 0
    s = await asyncio.to_thread(savings.report, a.days, a.today)  # with today: the live scan that also records today's Claude usage
    page = report_html.write(html_to)  # after the report, so the page carries today's share
    if a.html:
        print(f"html: {page}")
        return 0
    if a.json:
        _print(s)
    else:
        print(savings_view.render(s))
    return 0


async def cmd_usage(a) -> int:
    """Who used the swarm, and which Claude fan-outs the gate saw instead. `--json` for the whole report."""
    from .ledger import usage_report

    rep = usage_report(a.hours)
    if a.json:
        _print(rep)
        return 0
    sw, cf = rep["swarm"], rep["claude_fanouts"]
    print(f"hswarm usage, last {a.hours:g}h: {sw['tasks']} tasks, ${sw['cost_usd']:.4f}")
    print(f"  {'caller (instance / session / folder)':44s} {'jobs':>4s} {'tasks':>5s} {'ok':>5s} {'err':>4s} {'cost':>8s}  labels")
    for g in sw["callers"]:
        name = g["caller"] if g["stamped"] else "unstamped (before the caller stamp)"
        print(f"  {name[:44]:44s} {g['jobs']:>4d} {g['tasks']:>5d} {g['ok']:>5d} {g['error'] + g['timeout']:>4d} {g['cost_usd']:>8.4f}  {', '.join(g['labels'])[:60]}")
    print(f"Claude sub-agent decisions (routing gate), last {a.hours:g}h: {cf['decisions']} (blocked {cf['blocked']}, allowed {cf['allowed']}, reminded {cf['reminded']})")
    for s, b in sorted(cf["by_session"].items(), key=lambda kv: -kv[1]["calls"]):
        print(f"  session {s:8s} {b['instance'] or '-':12s} calls={b['calls']:<3d} blocked={b['blocked']:<3d} claude agents={b['agents']:<3d} {b['cwd']}")
    if cf["mechanical_but_claude"]:
        print(f"  fan-outs that matched the mechanical rule but went to Claude: {len(cf['mechanical_but_claude'])}")
        for r in cf["mechanical_but_claude"][:20]:
            print(f"    {r['ts'][:16]} {r['tool']:8s} {r['model']:8s} x{r['agents']} \"{r['mechanical']}\" {('reason: ' + r['reason']) if r['reason'] else ''}")
    return 0


async def cmd_maintain(a) -> int:
    """Everything the machine should do once a day, in one command: age old job folders into their archives,
    pack jobs past their warm week, spill files past their day and cc transcripts past two days into the history,
    measure yesterday, re-measure the sub-agent profile, exchange shards with the fleet and rewrite the page."""
    from . import archive, history, report_html, savings, survival, taskstore, utilization

    if a.keep_days < 0:
        raise SystemExit("hswarm maintain --keep-days: 0 keeps every job (the default), N >= 1 deletes jobs older than N days")
    savings.lower_priority()
    packed = await asyncio.to_thread(archive.archive_old, a.archive_hours, True)
    # Kept by default and packed by day (owner, Michael, 2026-10-02: "Ideally, we would keep all of it, and you would
    # just figure out a way to properly compress"); --keep-days N is the one way left to delete jobs.
    pruned = await asyncio.to_thread(archive.prune_old, a.keep_days) if a.keep_days else {"jobs": 0, "freed": 0}
    indexed = await asyncio.to_thread(taskstore.index_jobs)  # before packing: a warm zip reads in milliseconds
    cold = await asyncio.to_thread(history.pack_jobs)
    spilled = await asyncio.to_thread(history.pack_spill)
    cc = await asyncio.to_thread(history.pack_cc_transcripts)
    # A key-state write Windows refused used to leave keys.json.<pid>.tmp behind (38 files, 61.5 MiB, 2026-10-02). The
    # writer now retries and removes its own; this takes what a killed process leaves. By name and age, never opened.
    temps = [p for p in config.HOME.glob("keys.json.*.tmp") if time.time() - p.stat().st_mtime > 3600]
    for p in temps:
        p.unlink(missing_ok=True)
    days = await asyncio.to_thread(savings.record, a.backfill)
    kept = await asyncio.to_thread(survival.score_due)
    from . import egress

    await asyncio.to_thread(egress.compact)  # the egress receipts of earlier days, packed in place
    rep = await asyncio.to_thread(utilization.sync, a.push)
    page = report_html.write()
    mib = lambda n: f"{n / 2**20:,.0f} MiB"  # noqa: E731
    deleted = f"deleted {pruned['jobs']} job(s) older than {a.keep_days} day(s) freeing {mib(pruned['freed'])}; " if a.keep_days else ""
    line = (f"maintain: archived {packed['jobs']} job(s) freeing {mib(packed['saved'])}; {deleted}into the history: {cold['jobs']} job(s) "
            f"of {cold['days']} day(s) ({mib(cold['before'])} as zips), {spilled['files']} spill file(s) ({mib(spilled['before'])}) and "
            f"{cc['files']} cc transcript(s) ({mib(cc['before'])}); indexed {indexed['tasks']} task(s) of {indexed['jobs']} job(s); "
            f"{len(temps)} stale key temp file(s); recorded {len(days)} day(s); "
            f"scored {kept['scored']} edit survival checkpoint(s); sync imported {rep['imported']}, pushed {rep['pushed']}; page {page}")
    savings.log(line)
    if not a.quiet:
        print(line)
        for e in packed["errors"] + cold["errors"] + spilled["errors"] + cc["errors"] + rep["notes"]:
            print(f"  note: {e}")
    return 0


async def cmd_history(a) -> int:
    """The task table (taskstore): --index backfills it now; otherwise each shape and model's tasks, how they ended,
    and what they cost over --days, busiest first."""
    from . import taskstore

    if a.index:
        _print(await asyncio.to_thread(taskstore.index_jobs))
        return 0
    rows = taskstore.report(a.days)
    if a.json:
        _print(rows)
        return 0
    print(f"tasks of the last {a.days:g} day(s) by shape and model, busiest first")
    print(f"  {'backend/profile/tools/schema/size':44s} {'model':28s} {'tasks':>5s} {'ok':>5s} {'err':>4s} {'t/o':>4s} {'cap':>4s} {'cost $':>8s} {'avg s':>6s}")
    for r in rows[:60]:
        shape = f"{r['backend']}/{r['profile'] or '-'}/{r['tools']}/{'schema' if r['schema'] else '-'}/{r['size']}"
        print(f"  {shape[:44]:44s} {(r['model'] or '-')[:28]:28s} {r['tasks']:>5d} {r['ok']:>5d} {r['error']:>4d} "
              f"{r['timeout']:>4d} {r['capped']:>4d} {r['cost_usd']:>8.4f} {r['avg_s']:>6.1f}")
    return 0


async def cmd_survival(a) -> int:
    """Score the edits that reached a checkpoint, then say per model how much of what its workers wrote was kept."""
    from . import survival
    from .ledger import ledger_summary

    done = await asyncio.to_thread(survival.score_due)
    by_model = {m: b["survival"] for m, b in ledger_summary(a.days)["by_model"].items() if b.get("survival")}
    if a.json:
        _print({"scored_now": done["scored"], "by_model": by_model})
        return 0
    print(f"edit survival, tasks of the last {a.days:g} day(s) that wrote files ({done['scored']} checkpoint(s) scored now)")
    print(f"  {'model':40s} {'scored':>6s} {'kept (4-gram)':>13s} {'not reverted':>12s}")
    for m, s in sorted(by_model.items(), key=lambda kv: -kv[1]["scored"]):
        fg, nr = ("-" if s[k] is None else f"{s[k]:.0%}" for k in ("four_gram", "no_revert"))
        print(f"  {m[:40]:40s} {s['scored']:>6d} {fg:>13s} {nr:>12s}")
    if not by_model:
        print("  nothing scored yet: an api task's edits are first scored 5 minutes after it finishes")
    return 0


async def cmd_sync(a) -> int:
    """Pull the other machines' utilization shards, push ours, regenerate the fleet TOTALS.md.
    With --restore, read THIS machine's own shard back first (rebuilding a lost ledger)."""
    from . import utilization

    if a.restore:
        rep = await asyncio.to_thread(utilization.restore)
        _print(rep)
        if rep["notes"]:
            return 1
    rep = await asyncio.to_thread(utilization.sync, a.push)
    _print(rep)
    return 0 if not rep["notes"] else 1


async def cmd_keys(a) -> int:
    """The key pools and the disabled slot. `list` touches no network; `probe` spends one free GET per key."""
    from . import keys as keymod

    action = getattr(a, "action", "list")
    if action in ("add", "remove"):
        return await _keys_edit(a, action)
    if action == "list":
        out = keymod.report(a.provider)
    elif action == "probe":
        out = await keymod.probe(a.provider)
    else:
        want_on = action == "enable"
        if not a.fingerprint and not (want_on and a.all):
            raise SystemExit(f"hswarm keys {action}: give the 8-character fingerprint `hswarm keys` prints"
                             + (", or --all to empty the slot" if want_on else ""))
        out = keymod.set_enabled(a.fingerprint, want_on, a.provider, all_keys=a.all, reason=a.reason)
    if a.json:
        _print(out)
    else:
        _print_keys(out) if action in ("list", "probe") else print(out["note"])
    return 0


async def _keys_edit(a, action: str) -> int:
    """`keys add <provider>` reads the key from stdin (piped) or a hidden prompt, so it never lands in shell history;
    `keys remove <fingerprint> --provider P` takes it out of the key store. Both go through settings.py."""
    from . import settings

    try:
        if action == "add":
            provider = a.provider or a.fingerprint
            if not provider:
                raise settings.SettingsError("name the provider: hswarm keys add <provider>")
            if sys.stdin.isatty():
                import getpass

                text = getpass.getpass(f"{provider} API key(s), space-separated (hidden): ")
            else:
                text = sys.stdin.read()  # several keys at once: one per line, or split by spaces or commas
            batch = settings.split_keys(text)
            if not batch:
                raise settings.SettingsError("no key given on stdin or at the prompt")
            from . import keys

            refused = 0
            for key in batch:
                out = settings.add_key(provider, key)
                if not out["added"]:
                    print(f"{provider}: {out.get('note')} {out['fingerprint']}")
                    continue
                checked = await keys.check(provider, out["fingerprint"])
                if checked.get("result") == "rejected":  # the console does the same: a refused key is not kept
                    settings.remove_key(provider, out["fingerprint"])
                    print(f"{provider} did not accept key {out['fingerprint']}, so it was not kept: {checked.get('note')}", file=sys.stderr)
                    refused += 1
                    continue
                print(f"{provider}: added {out['fingerprint']} ({checked.get('note')})")
            if refused:
                return 1
        else:
            if not (a.provider and a.fingerprint):
                raise settings.SettingsError("hswarm keys remove <fingerprint> --provider <provider>")
            settings.remove_key(a.provider, a.fingerprint)
            print(f"{a.provider}: removed {a.fingerprint}")
    except settings.SettingsError as e:
        print(f"hswarm keys {action}: {e}", file=sys.stderr)
        return 2
    return 0


def _read_secret_text(prompt: str) -> str:
    """Keys and pairing codes come from stdin (piped) or a hidden prompt, never the command line or the screen."""
    if sys.stdin.isatty():
        import getpass

        return getpass.getpass(prompt)
    return sys.stdin.read()


async def cmd_vault(a) -> int:
    """The shared key vault (vault.py). Every verb prints counts and fingerprints; a key and the pairing code never reach
    a pipe: `pair` refuses unless stdout is a terminal, so a script or an agent running it learns nothing."""
    from . import vault

    action = a.action
    try:
        if action == "pair":
            if not sys.stdout.isatty():
                raise vault.VaultError("the pairing code opens every stored key, so it prints only to a terminal: run `hswarm vault pair` "
                                       "in your own terminal and hand the code over directly (text or DM), never in a chat or a ticket")
            print(await asyncio.to_thread(vault.pair_code))
            return 0
        if action == "init":
            if not a.target:
                raise vault.VaultError("hswarm vault init <backend>, e.g. ssh://user@host/hswarm-vault or dir:D:/shared/hswarm-vault")
            out = await asyncio.to_thread(vault.init, a.target)
        elif action == "join":
            out = await asyncio.to_thread(vault.join, _read_secret_text("vault pairing code (hidden): "), a.backend, a.force)
        elif action == "adopt":
            out = await asyncio.to_thread(vault.adopt)
        elif action == "request":
            if not a.target:
                raise vault.VaultError("hswarm vault request <backend>: the vault's backend as this machine reaches it, e.g. ssh://user@host/hswarm-vault")
            r = await asyncio.to_thread(vault.request, a.target, a.force)
            if a.json:
                _print(r)
            else:
                print(f"request {r['machine']}  fingerprint {r['fingerprint']}  on {r['backend']}")
                print(f"next: on the vault machine run `hswarm vault grant {r['machine']}` and check it shows {r['fingerprint']}; "
                      "then here: `hswarm vault accept`")
            return 0
        elif action == "grant":
            rows = await asyncio.to_thread(vault.requests_waiting)
            if not a.json:
                for r in rows:
                    print(f"{r['machine']:24} {r.get('at') or '-':21} {r.get('fingerprint') or r.get('error')}"
                          f"{'  (granted, not accepted yet)' if r['granted'] else ''}")
            ask = None
            if a.yes is None and sys.stdin.isatty():
                def ask(row):
                    return input(f"grant {row['machine']} ({row['fingerprint']})? type the fingerprint's first 4 characters: ")
            r = await asyncio.to_thread(vault.grant, a.target, a.yes, ask)
            if a.json:
                _print(r)
            else:
                print(f"granted {r['granted']} ({r['fingerprint']})")
            return 0
        elif action == "accept":
            try:
                out = await asyncio.to_thread(vault.accept, a.force)
            except vault.NotGranted as e:
                print(f"hswarm vault accept: {e}", file=sys.stderr)
                return 3
        elif action == "sync":
            out = await asyncio.to_thread(lambda: vault.sync(rebase=a.rebase, allow_removals=a.allow_removals, dry_run=a.dry_run))
        elif action == "list":
            out = {"rows": await asyncio.to_thread(vault.rows, a.target)}
        elif action in ("add", "remove"):
            if not a.target or (action == "remove" and not a.fingerprint):
                raise vault.VaultError("hswarm vault add <list>  |  hswarm vault remove <list> <fingerprint>")
            if action == "add":
                from . import settings

                out = await asyncio.to_thread(vault.add_keys, a.target, settings.split_keys(_read_secret_text(f"{a.target} API key(s), space-separated (hidden): ")))
            else:
                out = await asyncio.to_thread(vault.remove_key, a.target, a.fingerprint)
        else:
            out = await asyncio.to_thread(vault.status)
    except vault.VaultError as e:
        print(f"hswarm vault {action}: {e}", file=sys.stderr)
        return 2
    if a.json:
        _print(out)
        return 0
    if "rows" in out:
        print(f"{'list':30} {'fingerprint':12} {'key':14} added by / at")
        for r in out["rows"]:
            print(f"{r['list']:30} {r['fingerprint']:12} {r['masked']:14} {(r['by'] or '-')} {r['at'] or ''}")
        print(f"{len(out['rows'])} keys")
    else:
        for k, v in out.items():
            print(f"{k}: {v}")
    return 0


def _print_keys(out: dict) -> None:
    """A table a human reads at a glance; the fingerprint is the handle every other verb takes."""
    for name, p in (out.get("providers") or {}).items():
        if p.get("error"):
            print(f"{name}: ERROR {p['error']}")
            continue
        rows = p.get("rows") or []
        head = f"{name}: {len(rows)} keys"
        if "disabled" in p:
            head += f" | {p['ok']} ready, {p['resting']} resting, {p['disabled']} DISABLED"
        print(f"\n{head}")
        print(f"  {'fingerprint':12} {'state':22} {'credit':>10} {'free':>6}  why")
        for r in rows:
            credit = r.get("balance_usd", r.get("credit_usd"))
            credit = "-" if credit is None else f"{float(credit):.4f}"
            free = r.get("free_left")
            why = r.get("disabled_reason") or r.get("note") or r.get("error") or ""
            state = r.get("state") or ("disabled" if r.get("disabled") else "ok")
            print(f"  {r['fingerprint']:12} {state:22} {credit:>10} {str(free if free is not None else '-'):>6}  {why[:70]}")
    print(f"\n{out.get('note', '')}")


async def cmd_import_keys(a) -> int:
    """Import API keys from a ZSwarm clone's .secrets/ directory into HSWARM_HOME/secrets/."""
    import shutil

    source_dir = Path(a.source_dir)
    if not source_dir.exists():
        print(f"Error: source directory not found: {source_dir}", file=sys.stderr)
        return 1

    secrets_dir = source_dir / ".secrets"
    if not secrets_dir.exists():
        print(f"Error: .secrets/ not found in {source_dir}", file=sys.stderr)
        return 1

    # Create target directory
    hswarm_secrets = config.HOME / "secrets"
    hswarm_secrets.mkdir(parents=True, exist_ok=True)

    # Copy all *_api_keys files
    count = 0
    for src_file in secrets_dir.glob("*_api_keys"):
        if src_file.is_file():
            dst_file = hswarm_secrets / src_file.name
            shutil.copy2(src_file, dst_file)
            count += 1

    print(f"Imported {count} key file(s) into {hswarm_secrets}")
    return 0


async def cmd_models(a) -> int:
    from . import catalogue

    if a.refresh:
        out = await catalogue.refresh(a.refresh)
        _print(out) if a.json else print(out["note"])
        return 0
    if getattr(a, "routes", False):
        out = await asyncio.to_thread(catalogue.routes_view)
        if a.json:
            _print(out)
            return 0
        print(f"rate now: {out['rate_now']} | next change {out['next_change_utc']} ({out['next_state']}) | routing {'on' if out['enabled'] else 'OFF'}\n")
        for r in out["routes"]:
            print(f"{r['model']}  ->  {r['serves']}   ({r['why']})")
            for o in r["options"]:
                mark = "*" if o["model"] == r["serves"] else " "
                price_ = "-" if o["usd_per_1m"] is None else f"${o['usd_per_1m']:.4f}/1M blended"
                credit = "has credit" if o["has_credit"] else "NO KEY WITH CREDIT"
                tier = "fallback" if o.get("fallback") else "primary"
                print(f"  {mark} {o['model']:38} {o['provider']:11} {tier:9} {price_:22} {credit}")
            print()
        print(out["note"])
        return 0
    out = catalogue.listing(a.grep, a.limit)
    if a.json:
        _print(out)
        return 0
    for r in out["models"]:
        p = r["usd_per_1m"]
        rate = "-" if p == "-" else f"in {p['miss']:.4f} / out {p['out']:.4f} per 1M"
        print(f"{r['model']:58} {str(r['provider'] or '-'):11} {rate}")
    print(f"\n{out['shown']} of {out['count']} models | catalogue: {out['catalogue']}")
    return 0


async def cmd_web(a) -> int:
    """read_url's standing policy: allow-always and admin-block hosts, then the report the doctor shows too."""
    from .mcp_server import hswarm_web  # the MCP tool is the one implementation; the CLI just prints it

    _print(await hswarm_web(allow=a.allow, block=a.block, forget=a.forget))
    return 0


async def cmd_prefix(a) -> int:
    # What one cc spawn ships before any work, measured against a loopback sink: no provider call, no spend.
    from . import prefix

    r = await prefix.measure(a.cwd or str(Path.cwd()), model=a.model, tools=a.tools, operator=a.operator, timeout_s=a.timeout_s, top=a.top)
    _print(r) if a.json else print(prefix.render(r))
    return 1 if r.get("error") else 0


async def cmd_egress(a) -> int:
    """The egress receipts (egress.py): verify recomputes the hash chain, tail shows the latest sends, find
    answers "did these exact bytes ever leave" by sha256. Offline; no receipt holds any payload."""
    from . import egress

    if a.action == "verify":
        rep = egress.verify()
        if a.json:
            _print(rep)
        elif rep["ok"]:
            print(f"egress ledger intact: {rep['lines']} receipt(s) chained in {rep['path']}")
        else:
            print(f"egress ledger BROKEN at line {rep['broken_at']} of {rep['path']}: {rep['reason']}")
        return 0 if rep["ok"] else 1
    if a.action == "find" and not a.sha256:
        raise SystemExit("hswarm egress find: give the sha256 of the exact request body")
    rows = egress.find(a.sha256) if a.action == "find" else egress.tail(a.limit)
    if a.json:
        _print(rows)
        return 0
    for r in rows:
        print(f"{r.get('ts', '?')[:23]:23} {r.get('sink', '?'):40} {r.get('model', ''):34} {r.get('bytes', 0):>9} B  {r.get('sha256', '')[:16]}")
    if a.action == "find" and not rows:
        print("no receipt for that hash: those bytes were never sent through hswarm (since the ledger began)")
    return 0


COMMANDS = {
    "doctor": cmd_doctor, "web": cmd_web, "ask": cmd_ask, "panel": cmd_panel, "run": cmd_run, "status": cmd_status, "cancel": cmd_cancel, "results": cmd_results,
    "jobs": cmd_jobs, "cost": cmd_cost, "savings": cmd_savings, "usage": cmd_usage, "bench": cmd_bench, "sync": cmd_sync,
    "maintain": cmd_maintain, "history": cmd_history, "keys": cmd_keys, "vault": cmd_vault, "import-keys": cmd_import_keys, "models": cmd_models, "survival": cmd_survival, "prefix": cmd_prefix, "egress": cmd_egress,
}
