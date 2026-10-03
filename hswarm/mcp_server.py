"""MCP server (stdio) exposing the hswarm to an orchestrating Claude Code session.

Tools: hswarm_run, hswarm_status, hswarm_results, hswarm_apply_proposals (screen and apply a propose job's queued changes; hswarm/proposals.py), hswarm_cancel, hswarm_loop (the frontier loop, hswarm/loop.py), hswarm_jobs, hswarm_ask,
hswarm_cost, hswarm_savings, hswarm_usage, hswarm_doctor, hswarm_bench (the benchmark results DB, hswarm/benchdb.py),
hswarm_decide (typed decisions: TypeSafe Jev first, the tool-free default for what it is unsure of; hswarm/decisions.py),
hswarm_panel (a blind multi-model review with an anonymised rebuttal round; hswarm/panel.py),
hswarm_review and hswarm_doubt (evidence-gated review, refute pass and claim-blind doubt cycle; hswarm/review.py). Results are kept compact by default; fetch full answers or
transcripts with hswarm_results. Doctor and cost bodies live in health.py; result shaping in results.py;
the savings tracker in savings.py; the caller stamp (which session asked) in caller.py; the usage report in ledger.py.
"""
from __future__ import annotations

import asyncio
import functools
import inspect
import json
import os
import traceback
from importlib.resources import files
from pathlib import Path
from typing import Any

try:  # mcp >= 2
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP

from . import archive, batching, blobs, config, dispatch, health, mcp_policy, proposals, review, shared, utilization, verdict
from .caller import detect as detect_caller
from .jobs import JobManager
from .ledger import append_row, ask_row, usage_report
from .results import brief_summary, job_payload, results_from_disk
from .spec import EFFORTS, Task

# The instructions every client shows its model: the same text `hswarm install --instructions` writes into
# CLAUDE.md / AGENTS.md (data/agent-instructions.md), so "delegate the cheap, wide work here" is said once.
mcp = FastMCP("hswarm", instructions=files("hswarm").joinpath("data", "agent-instructions.md").read_text(encoding="utf-8").strip())

_manager: JobManager | None = None
_adopted = False


def manager() -> JobManager:
    global _manager, _adopted
    if _manager is None:
        _manager = JobManager()  # one manager per server process: jobs stay addressable for the session's lifetime
        _manager.port = shared.SERVING_PORT  # the shared server stamps its jobs with its port
    if not _adopted and _manager.port:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return _manager  # asked from a worker thread: the first call on the loop carries the jobs on
        _adopted = True
        # A restart: the jobs the previous server on this port left unfinished carry on here, under their own ids,
        # before this first call looks any of them up.
        _manager.adopt_orphans()
    return _manager


def _parse_tasks(tasks: list[dict], defaults: dict) -> list[Task]:
    return [Task.from_dict({"prompt": t} if isinstance(t, str) else t, defaults, i) for i, t in enumerate(tasks)]


def _returns_errors(fn):
    """⛔ A TOOL THAT FAILS MUST SAY WHY (2026-09-21). An exception escaping a tool reaches the caller as the bare
    "Error executing tool <name>". Measured on Jacob's PC: hswarm_ask failed that way three times in a row while
    `hswarm.py ask` answered the same question in 0.24 s, and the caller sent its fact-check to a Sonnet agent
    instead. Return the exception as data - its type, message and the frames that raised it - so the next
    failure names its own cause. (Only on tools that return a dict: a list-typed tool must keep its shape.)"""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - the whole point is to hand the failure back as data
            frames = traceback.extract_tb(e.__traceback__)[-3:]
            return {"error": f"{type(e).__name__}: {e}"[:600], "tool": fn.__name__,
                    "where": [f"{Path(f.filename).name}:{f.lineno} {f.name}" for f in frames]}

    return wrapper


def _served(fn):
    """Register a tool THROUGH the least-authority table (mcp_policy.py): its annotations are derived from its class,
    a tool with no class fails at import instead of being served unclassified, and a class this server does not grant
    (HSWARM_MCP_CLASSES) is refused as data before the body runs, so nothing is spent or written."""
    name = fn.__name__
    list_typed = str(inspect.signature(fn).return_annotation).startswith("list")

    @functools.wraps(fn)
    async def gated(*args, **kwargs):
        why = mcp_policy.refusal(name)
        if why:
            refused = {"error": why, "tool": name}
            return [refused] if list_typed else refused
        config.refresh()  # a settings change (hswarm ui, a provider file) reaches this long-lived server on its next call
        return await fn(*args, **kwargs)

    # A dict answer goes out as ONE compact JSON line. Left to the SDK, a bare `-> dict` is rendered with indent=2
    # (func_metadata._convert_to_content): over the last 300 job records 24.8% of hswarm_results bytes were indentation.
    # `gated` stays the module attribute and keeps returning the dict, for the console and every in-process caller.
    @functools.wraps(gated)
    async def compact(*args, **kwargs):
        return json.dumps(await gated(*args, **kwargs), separators=(",", ":"), ensure_ascii=False, default=str)

    if list_typed:
        mcp.tool(annotations=mcp_policy.annotations_for(name))(gated)
    else:
        mcp.tool(annotations=mcp_policy.annotations_for(name), structured_output=False)(compact)
    _refuse_unknown_arguments(name)
    return gated


def _refuse_unknown_arguments(name: str) -> None:
    """⛔ AN ARGUMENT THE TOOL DOES NOT TAKE IS REFUSED, NEVER DROPPED. The SDK's argument model ignores extra keys
    (func_metadata.ArgModelBase), so hswarm_run took `budget`, `max_cost`, `web_host` and `timeout` without a word and
    ran with budget_usd=None (an uncapped job), the $0.25 default cap, no web host and 600 s. The check has to live in
    the argument model: by the time the tool body runs, the SDK has already dropped the key."""
    import difflib

    from pydantic import model_validator

    meta = mcp._tool_manager.get_tool(name).fn_metadata
    known = sorted(f.alias or n for n, f in meta.arg_model.model_fields.items())

    class Strict(meta.arg_model):
        @model_validator(mode="before")
        @classmethod
        def refuse_unknown(cls, data):
            for key in data if isinstance(data, dict) else ():
                if key not in known:
                    near = difflib.get_close_matches(str(key), known, n=1)
                    raise ValueError(f"unknown argument {key!r} for {name}; nothing was run. "
                                     + (f"Did you mean {near[0]!r}?" if near else f"It takes: {', '.join(known)}"))
            return data

    meta.arg_model = Strict


# The longest hswarm_run waits before it answers. An MCP client drops a call that has said nothing for about 300 s:
# a hswarm_run with wait_s 300 was aborted that way (2026-10-02), its answer lost though the job ran on. A longer
# wait_s is held to this; the job keeps running and hswarm_status / hswarm_results read it later.
RUN_WAIT_MAX_S = 240
_told_behind: set[str] = set()  # the chats (MCP session ids) hswarm_run has already given shared.behind()'s sentence


@_served
@_returns_errors
async def hswarm_run(
    tasks: list[Any], backend: str = "api", model: str = "auto", cwd: str | None = None, tools: str = "read", system: str | None = None,
    max_turns: int | None = None, timeout_s: int = 600, schema: dict | None = None, concurrency: int | None = None, thinking: bool | None = None,
    reasoning_effort: str | None = None, max_cost_usd: float | None = None, budget_usd: float | None = None, label: str = "",
    wait: bool = True, wait_s: int = 240, max_answer_chars: int = 4000, role: str | None = None, lean: bool | None = None, profile: str | None = None,
    confirm_write: bool | None = None, isolated: bool | None = None, recipe: str | None = None,
    capability: str | dict | None = None, web_hosts: list[str] | None = None, verify: str | dict | None = None,
    resume_from_job: str | None = None, scope: str | None = None, escalate: str | None = None,
    done_when: str | None = None, envelope: dict | None = None, checkpoint_at: float | None = None,
    scripted: bool = False, redact: str | dict | None = None, purpose: str | None = None, unbatched: bool = False,
) -> dict:
    """Fan a batch of tasks out to swarm workers and return their results.

    BATCH THE QUESTIONS, NOT THE CALLS. A worker answers 50 short questions in about the time it answers one: put
    20-100 small items in ONE task (numbered in the prompt, or listed in a file the worker reads) with a schema whose
    answer is an array keyed by item id. One task per item only when each needs its own tools, cwd or heavy reading.
    8+ small tool-free tasks of one shape are REFUSED with the packing recipe; unbatched=true sends them anyway,
    and purpose="evaluation" jobs are never refused.

    tasks: prompt strings, or {prompt, id?, files?, ...} objects. The arguments below are every task's defaults and
    each may be set per task, except the job-wide concurrency, budget_usd, label, wait, wait_s, max_answer_chars.
    cwd: an ABSOLUTE folder; the worker's tools see nothing outside it.
    tools: exactly one of read (default) | edit (read + write files) | all (edit + a shell) | none (reason only) |
    web (read + read_url, only for hosts in web_hosts) | jobs (all + background shell jobs) | propose (read +
    changes queued for hswarm_apply_proposals), or a comma list of tool names. read has no web access.
    schema: a JSON schema whenever the answer is data. The parsed object comes back in `data`; the whole schema is
    enforced, so say minItems where an empty answer is wrong.
    model: leave "auto": the cheapest evaluated model meeting the profile's score floors, failing over inside Swarm.
    profile: routine (tool-free only) | general | code | decision | research | critical sets that bar; role (search,
    code, judge, summarize, review) picks the model this machine wires for it. hswarm_select previews the route.
    Cost: max_cost_usd caps ONE worker, and a capped task dies with its work: set it for long code or research tasks
    (defaults: $0.25; with tools code $1, research $1.50; critical $2). budget_usd caps the WHOLE job and cancels what is still pending
    once crossed; unset, the job has no ceiling.
    timeout_s: RUN time per task; time queued at a busy provider's gate spends none. max_turns: default 24 (cc 40).
    wait=true returns what finished within wait_s (at most 240 s: MCP clients drop a call silent ~300 s; the job runs
    on); wait=false returns a job_id at once: poll hswarm_status, read
    hswarm_results (answers here are cut at max_answer_chars; whole there).
    backend: api (sandboxed tool loop) | cc (headless Claude Code; edit/all there also need confirm_write=true).
    Answer: summary and results [{id, status, answer or data, ...}]. Re-check first what `unverified`,
    summary.mis_scoped and summary.not_advanced list.
    An argument this tool does not take is refused with the nearest valid name, never dropped.
    Every other option (reasoning_effort, verify, acceptance, done_when, green, escalate, scope, capability,
    writable, inventory, recipe, scripted, redact, envelope, resume_from_job, lean, isolated, ...) and every result
    field is in docs/API.md of the hswarm repo under "hswarm_run options": read it before using one.
    """
    defaults = {
        "backend": backend, "model": model, "cwd": cwd, "tools": tools, "system": system, "max_turns": max_turns,
        "timeout_s": timeout_s, "schema": schema, "thinking": thinking, "reasoning_effort": reasoning_effort, "max_cost_usd": max_cost_usd, "role": role, "lean": lean, "profile": profile,
        "confirm_write": confirm_write, "isolated": isolated,
        "recipe": recipe,
        "capability": capability,
        "web_hosts": web_hosts,
        "verify": verify,
        "scope": scope,
        "escalate": escalate,
        "done_when": done_when,
        "checkpoint_at": checkpoint_at,
        "scripted": scripted or None,
        "redact": redact,
        "purpose": purpose,
    }
    # ⛔ A REFUSED TASK SPEC MUST SAY WHY (2026-09-19). Task validation raises ValueError with a precise
    # message ("reasoning_effort must be low|high|max"), and the MCP layer turned it into a bare
    # "Error executing tool hswarm_run" - measured: a caller passing reasoning_effort="medium" lost two
    # 10-task batches and had to bisect the arguments by hand. Return the message as data instead.
    try:
        parsed = _parse_tasks(tasks, {k: v for k, v in defaults.items() if v is not None})
    except ValueError as exc:
        return {"error": f"task spec refused: {exc}", "hint": f"reasoning_effort is one of {'|'.join(EFFORTS)}"}
    if not unbatched and (why := batching.unbatched_run(parsed)):
        return {"error": why, "batching": batching.RECIPE}  # nothing submitted, nothing spent
    try:
        job = manager().submit(parsed, concurrency=concurrency, label=label, budget_usd=budget_usd, resume_from=resume_from_job, envelope=envelope)
    except ValueError as exc:
        if not str(exc).startswith(("spawn refused", "envelope:")):
            raise
        return {"error": str(exc)}  # a spawn-tree refusal is an answer to act on, not a crash
    # Said in the FIRST response, before any wait: a profile with one provider left whose pool is resting, or a
    # width past its live-call cap (job 20260925-143635-e3f6 learnt it after a ten-minute timeout).
    outlook = dispatch.route_outlook(parsed, manager()._gates)
    if wait:
        await manager().wait(job.id, min(wait_s, RUN_WAIT_MAX_S))
    payload = job_payload(job, max_answer_chars, include_pending=True)
    if outlook:
        payload["route_outlook"] = outlook
    if behind := shared.behind():
        # The sentence once per chat, then a flag: it rode on 38 of 51 sampled run answers (15.5% of their characters)
        # and no caller can act on it per call. hswarm_doctor always carries it in full.
        chat = (shared.REQUEST.get() or {}).get("mcp_session") or ""  # a stdio server has one chat
        payload["server_behind"] = True if chat in _told_behind else behind
        _told_behind.add(chat)
    return payload


@_served
@_returns_errors
async def hswarm_status(job_id: str, verbose: bool = False) -> dict:
    """Counts, cost and state of a job (running or finished), plus what needs a look and only then: error, taints,
    not_advanced, acceptance, mis_scoped, web_approvals. `waiting_on_rate_limited_pool` says every key of a provider
    is resting - the state that used to read as a silent "running" - and comes with `pools`: each provider the tasks
    sit on, with the gate's live limit and how many keys are ready. `quiet_running` names the running
    tasks with no model reply for QUIET_TASK_S (stalled, not slow); hswarm_results gives every running task its `quiet_s`.
    verbose adds the bookkeeping (dir, caller, savings, created, finished, task ages, pools while it runs)."""
    try:
        full = manager().status(manager().get(job_id))
    except KeyError:
        # Off the loop: reading a big record (0.5 s on job cf71) stalled every chat on the shared server.
        full = await asyncio.to_thread(JobManager.summary_on_disk, job_id)
    return full if verbose else brief_summary(full)


@_served
@_returns_errors
async def hswarm_results(job_id: str, ids: list[str] | None = None, status: str | None = None, max_answer_chars: int = 20000, include_transcript: bool = False,
                         include_receipts: bool = False, taint: str | None = None, since: str | None = None, include_selection: bool = False) -> dict:
    """Results of a job. Filter by task ids or status (ok|error|timeout|loop|cancelled). include_transcript adds the worker's full message log per task.

    A row carries only the fields that are set. With a schema the answer is `data`; `answer` rides along only when it
    says something else. max_answer_chars caps each: a cut one carries answer_truncated / data_truncated (the full
    length) and the call that fetches it whole. Every answer carries `cursor`: pass it back as `since` and the next
    call returns only the rows that finished after it (`already_delivered` counts the ones left out). `selection`
    is only the legs that failed (and `below_floor` when a rescue leg served); include_selection returns AUTO's full record.

    Every api result carries `citations`: its answer's [rN tool] citations checked against the receipt ledger of the
    tool calls it really made - verdict resolved | mismatched | unknown (a receipt id no call had) | uncited (an action
    claim with no receipt) | none. A task given `green` also carries `green`: verified, or unverified with `missing`.
    Top-level `unverified` lists the ok tasks whose done is not backed: re-check those FIRST. It certifies nothing else:
    `resolved` only proves a receipt of a fitting tool exists (any exit-0 bash backs "tests pass"), and `none` also
    covers file:line findings, so still verify anything load-bearing yourself. include_receipts adds the ledger.

    A doubted result carries `taint`, sticky letters saying why (no `taint` = clean): F failed over to another leg,
    R re-run or re-prompted, S schema repaired, T output truncated, B turn budget forced the answer, C cost/context cap hit.
    taint="FT" keeps results carrying ANY of those letters; taint="clean" keeps only untainted ones."""
    try:
        job = manager().get(job_id)
    except KeyError:
        # Off the loop: reading and parsing a big record (0.5 s on job cf71) stalled every chat on the shared server.
        out = await asyncio.to_thread(results_from_disk, job_id, ids, status, max_answer_chars, include_receipts, taint, since, include_selection)
    else:
        out = job_payload(job, max_answer_chars, ids=ids, status=status, include_receipts=include_receipts, taint=taint, since=since,
                          include_selection=include_selection)
    if include_transcript:
        # Long strings live once per job under blobs/; put them back so the caller sees the real messages,
        # whether the job is still a folder or has aged into its archive.
        for r in out["results"]:
            r["transcript"] = archive.transcript(job_id, r["id"])
    return out


@_served
@_returns_errors
async def hswarm_apply_proposals(job_id: str, ids: list[str] | None = None, apply: bool = True) -> dict:
    """Screen, then apply, the file changes a tools:"propose" job queued instead of making them.

    A propose-preset worker reads but cannot write: its only lever is the `propose` tool. Here each queued change
    is screened twice - rules first (guarded paths such as .git/.env/.secrets/CI, secret-shaped strings, too large
    to review), then one tool-free call per task on the `judge` role that sees the task as trusted text and the
    proposals as data - and only what passes is written, inside the task's own cwd and roots. A judge that fails
    or skips a proposal blocks it. apply=false screens only (a dry run). Applying twice re-runs what passed: an
    edit whose old_string is already gone comes back as an ERROR row and writes nothing."""
    doc = JobManager.load_from_disk(job_id)
    doc = {**doc, "tasks": blobs.expand_all_with(doc.get("tasks") or [], archive.blob_reader(job_id))}

    async def ask(prompt: str, system: str, schema: dict):
        return await manager().ask_role("judge", prompt, system=system, schema=schema)

    out = await proposals.review_job(doc, ask, ids=ids, apply=apply)
    calls = out.pop("calls")
    return {"job_id": job_id, **out} | await _book_asks(calls, "screen")


@_served
@_returns_errors
async def hswarm_cancel(job_id: str) -> dict:
    """Cancel every pending/running task of a job, whichever process runs it: another live process is asked and stops
    within ~10 s; a job nothing runs any more (a killed `hswarm.py run`) is marked cancelled on disk.
    Answers like hswarm_status: state, counts, cost and what needs a look."""
    try:
        return brief_summary(manager().cancel(job_id).summary())
    except KeyError:
        return brief_summary(await asyncio.to_thread(JobManager.cancel_on_disk, job_id))


# Frontier loops started in this server process: loop id -> (the loop, its asyncio task). A loop outlives the tool
# call that started it, so a caller can come back for its status; its log file outlives the process.
_loops: dict[str, tuple[Any, asyncio.Task]] = {}


@_served
@_returns_errors
async def hswarm_loop(
    probe: str | None = None, cwd: str | None = None, loop_id: str | None = None, cancel: bool = False, log: str | None = None,
    max_rounds: int = 5, max_workers: int = 4, stall_rounds: int = 2, budget_usd: float | None = None, probe_timeout_s: float = 600.0,
    tools: str = "edit", model: str = "auto", backend: str = "api", max_turns: int = 24, fix_prompt: str | None = None, port_prompt: str | None = None,
    wait: bool = True, wait_s: int = 240,
) -> dict:
    """A FRONTIER LOOP: hswarm finds the next target itself, so you orchestrate without reading source.

    probe: a shell command run in cwd (absolute) that prints JSON {frontier, perStage}. frontier is the EARLIEST failing
    stage - a name, or {stage, mode?: fix|port, failures?: [...], detail?} - and null when everything passes. Each round
    hswarm runs the probe, picks FIX (stage fails) or PORT (perStage marks it missing/unported/todo, or mode says so),
    sends one worker per listed failure (at most max_workers) with your task defaults, waits, and probes again. It stops
    on frontier null (done), max_rounds, budget_usd, a probe that prints no JSON, or stall_rounds rounds that leave the
    frontier and its failures unchanged. Status and a step log go to a markdown file (log, default
    ~/.hswarm/loops/<id>.md); pointing log at an existing file resumes it. fix_prompt/port_prompt override the worker
    templates ({stage} {failure} {detail} {per_stage} {probe} {cwd}). Workers in one round share cwd, so keep
    max_workers at 1 when their fixes would touch the same files. Returns the status after wait_s (the loop keeps
    running); call again with loop_id for its status, or loop_id + cancel=true to stop it.
    """
    from . import loop as frontier

    if loop_id:
        if loop_id not in _loops:
            return {"error": f"no loop {loop_id!r} in this server process; its log file still holds its status", "loops": sorted(_loops)}
        lp, task = _loops[loop_id]
        if cancel and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        elif wait and not task.done():
            await asyncio.wait({task}, timeout=wait_s)
        return lp.status()
    if not probe or not cwd:
        return {"error": "give probe and an absolute cwd to start a loop, or loop_id to read one"}
    lp = frontier.build(probe, cwd, log, max_rounds=max_rounds, max_workers=max_workers, stall_rounds=stall_rounds, budget_usd=budget_usd,
                        probe_timeout_s=probe_timeout_s, task_defaults={"tools": tools, "model": model, "backend": backend, "max_turns": max_turns},
                        fix_prompt=fix_prompt or frontier.FIX_PROMPT, port_prompt=port_prompt or frontier.PORT_PROMPT)
    task = asyncio.create_task(lp.run(manager()), name=lp.id)
    _loops[lp.id] = (lp, task)
    if wait:
        await asyncio.wait({task}, timeout=wait_s)
    return lp.status()


@_served
async def hswarm_jobs(limit: int = 10, verbose: bool = False) -> list[dict]:
    """Recent jobs, newest first (from disk, so it covers earlier sessions too): each as hswarm_status answers it,
    and verbose adds the same bookkeeping."""
    live = {j.id: j.summary() for j in manager().jobs.values()}
    seen: set[str] = set()
    out = []
    # Off the loop: the scan and any record it has to parse stalled every chat on the shared server.
    on_disk = await asyncio.to_thread(JobManager.list_on_disk, limit)
    for s in sorted(list(live.values()) + on_disk, key=lambda s: s["job_id"], reverse=True):
        if s["job_id"] not in seen:
            seen.add(s["job_id"])
            out.append(s if verbose else brief_summary(s))
    return out[:limit]


@_served
@_returns_errors
async def hswarm_ask(prompt: str, system: str | None = None, model: str = "auto", schema: dict | None = None, thinking: bool | None = None, reasoning_effort: str | None = None, max_tokens: int = 16000, role: str | None = None, images: list[str] | None = None, profile: str | None = None, min_scores: dict | None = None, exclude_models: list[str] | None = None, timeout_s: float | None = None, purpose: str = "production") -> dict:
    """One TOOL-FREE call, selected from published task scores and measured cost: classify,
    summarize, rewrite, second-opinion. Several questions go in ONE call: number them in the prompt and give a schema
    whose answer is an array (20-100 per call is normal); a chat that sends small asks one after another gets that
    recipe back in `batching`. With schema, `data` holds the parsed object. With `images`, only models
    that can see serve it; none available is an explicit error. AUTO preserves evaluated effort and escalates within Swarm.
    role "review" here picks the model only: its rubric, default schema and coverage receipt apply to hswarm_run.
    timeout_s (AUTO): the whole walk's budget over every route it tries, 120 s unless given; a long read or a long
    answer gives more, so each leg's share of it is enough to finish."""
    from .selection import profile_for

    if role and config.ROLES.get(role.strip().lower()) != config.AUTO:
        model = config.resolve_role(role)
        profile = None
    elif not model or model.strip().lower() == config.AUTO:
        model = config.AUTO
        profile = profile or profile_for(role, "none")
    else:
        model = config.resolve_model(model)
        profile = None
    system = review.with_contract(role, system)  # judge / refute / doubt carry their evidence bar
    # The routed path, failing over to the next only when a path is unavailable (config.ROUTES, jobs.leg_unavailable).
    options = {"profile": profile, "min_scores": min_scores, "exclude_models": exclude_models or [],
               "purpose": purpose} if profile else {}
    # Dredd's board secretary asked for 300 s and every leg still got a share of 120 (ask_selected's default), because
    # this door took no budget: with NVIDIA crawling, two Lift boards sat for nothing on 2026-09-29.
    if profile and timeout_s:
        options["timeout_s"] = float(timeout_s)
    r = await manager().ask_routed(prompt, model, system=system, schema=schema, thinking=thinking, reasoning_effort=reasoning_effort, max_tokens=max_tokens, images=images or None, **options)
    out = r.as_dict(brief=True) | await _book_asks([r], "ask")
    try:
        if note := batching.note_ask(prompt):
            out["batching"] = note  # beside the answer, never instead of it
    except Exception:  # noqa: BLE001 - the advice must never cost the answer
        pass
    return out


@_served
@_returns_errors
async def hswarm_select(profile: str = "general", tools: str = "none", backend: str = "api", min_scores: dict | None = None, reasoning_effort: str | None = None, vision: bool = False, purpose: str = "production", verbose: bool = False) -> dict:
    """Preview the plan a task would run NOW, from published task scores, exact effort, cost and live key pools. No
    model call. Profiles: routine, general, code, decision, research, critical. CritPt is excluded from eligibility.
    `candidates` is EVERY leg dispatch walks, in the order it would try them (a resting pool only when no pool is
    live; a lower profile, named in `below_floor`, when the asked one has no key): each is its model plus the flags
    that apply. `rescue` names the profile below the one asked that it comes from: a task moves onto it when its own
    routes crawl or fail, so a `crawling` leg ahead of it costs a slow turn, never the task. `breaker` marks a leg
    this server found failing (host errors, or 404 model_not_found on the keys here): dispatch tries it last.
    `saturated` is a provider this server found answering nothing. `rejected` and `unavailable` are COUNTS of the
    routes kept out.
    Only EMPTY candidates is the answer to write `why-not-hswarm` from; "only crawling routes" is not one, because
    the rescue legs behind them are live (2026-09-28: two chats read two crawling GLM legs as "no route" and ran 997
    Opus sub-agents on the owner's Claude quota while Gemini, Groq and Kimi were answering).
    verbose=true returns the whole plan instead (about 19,000 characters): every candidate's scores, rates, source
    and `load_bias`, each rejected route's filter and reason (a provider whose terms allow evaluation only is
    rejected with filter "purpose" unless purpose="evaluation"), each unavailable route's why (all keys disabled,
    every key resting, no key here) and what opened each breaker. Ask for it only to debug a route.
    Set task.profile when dispatching; final acceptance remains with the desktop Opus 5.5 orchestrator."""
    from .breaker import mark_open
    from .dispatch import _plan, _pressure, _rebias_levels, _rescue, _with_rescue
    from .selection import rebias

    out = _plan(profile, tools=tools, backend=backend, min_scores=min_scores, reasoning_effort=reasoning_effort,
                vision=vision, min_context=0, explain=True, purpose=purpose)
    gates = manager()._gates
    pressure = lambda p: _pressure(p, gates)  # noqa: E731
    have = {c["model"] for c in out["candidates"]}
    rescue = [c for c in _rescue(out.get("below_floor") or profile, tools=tools, backend=backend, min_scores=min_scores,
                                 reasoning_effort=reasoning_effort, vision=vision, min_context=0,
                                 purpose=purpose) if c["model"] not in have]
    own = rebias(out["candidates"], pressure)
    out["candidates"] = mark_open(_with_rescue(own, _rebias_levels(rescue, pressure)) if rescue else own)  # the order dispatch applies
    if saturated := {p: why for p, gate in gates.items() if (why := gate.tripped())}:
        out["saturated"] = saturated
    if verbose:
        return out
    # The decision this serves (are the candidates empty, which leads, is it crawling) needs names and flags. The whole
    # plan measured a median 19,315 characters over 9 calls (candidates' scores and rates 50%, rejected 30%,
    # unavailable 17%), and the routing skill sends every chat here before each hswarm_run.
    brief = {"profile": out["profile"],
             "candidates": [{"model": c["model"]} | {k: c[k] for k in ("crawling", "rescue") if c.get(k)}
                            | ({"breaker": True} if "breaker" in c else {}) for c in out["candidates"]],
             "rejected": len(out.get("rejected") or ()), "unavailable": len(out.get("unavailable") or ())}
    return brief | {k: out[k] for k in ("below_floor", "saturated") if out.get(k)}


@_served
@_returns_errors
async def hswarm_review(cwd: str, diff: str | None = None, base: str = "HEAD", focus: str = "", findings: list[dict] | None = None,
                        refute: bool = True, nit_cap: int = 5, wait_s: int = 600, budget_usd: float | None = None) -> dict:
    """Review a change with an evidence bar, in up to two jobs: INVESTIGATE (a read-only worker under the judge
    contract returns findings, each with path, line, verbatim quote, severity important|nit|question, failure mode
    and confidence 1-10), a mechanical GATE (a quote not found in its cited file is capped at confidence 4 and an
    important one becomes a question; confidence 5+ shown, 3-4 in `appendix`, 1-2 suppressed; nits past nit_cap
    become `nits_omitted`; each finding tagged in_diff / off_diff by 3-gram overlap with the diff), then REFUTE (a
    `refute`-role worker tries to disprove each finding with cited path:line evidence; unsure means it survives,
    an off_diff finding must be confirmed, and a refute pass that fails keeps every finding).
    diff: the unified diff under review; omitted, `git diff <base>` in cwd is used (base HEAD = uncommitted work).
    findings: hand in findings you already have to skip INVESTIGATE; with refute=false no model is called at all.
    wait_s: at most 240 s over both passes (an MCP client drops a call silent for ~300 s); a pass still running then
    is named with its job id, to read later.
    Returns findings (the survivors), refuted (each with its refutation), appendix, counts and the job ids."""
    if not Path(cwd).is_absolute() or not Path(cwd).is_dir():
        return {"error": f"cwd must be an absolute directory, got {cwd!r}"}
    text = await review.diff_for(cwd, diff, base)
    if not text.strip() and findings is None:
        return {"error": f"nothing to review: no diff given and `git diff {base}` in {cwd} is empty"}
    return await review.run_review(manager(), cwd, text, focus=focus, findings=findings, refute=refute, nit_cap=nit_cap,
                                   wait_s=min(wait_s, RUN_WAIT_MAX_S), budget_usd=budget_usd)


@_served
@_returns_errors
async def hswarm_doubt(artifact: str, contract: str, history: list[list[dict]] | None = None) -> dict:
    """One doubt cycle: a fresh, tool-free reviewer on the `doubt` role (wire a non-Claude model there
    for a second opinion from another family; nothing enforces it) is handed ONLY the
    artifact and the contract it must meet - there is deliberately no parameter for your claim or conclusion,
    which biases a reviewer toward agreeing. Issues come back in fixed precedence: contract_misread, actionable,
    tradeoff, noise. history: the `issues` lists of earlier cycles on the same artifact, oldest first. `stop` is
    true after 3 cycles, when this cycle found nothing substantive, or on `doubt_theater` (two or more cycles with
    substantive issues and none actionable: stop doubting and decide)."""
    payload, r = await review.run_doubt(manager(), artifact, contract, history)
    return payload | await _book_asks([r], "ask")


async def _book_asks(results: list, kind: str, extra: tuple = ()) -> dict:
    """Attribute and cost finished asks (ledger line + the savings running total). ⛔ Bookkeeping NEVER fails the
    answer it records (2026-09-21): the CLI `ask` does none of this and answered on the machine where the MCP tool
    kept failing, so a caller-stamp, ledger or savings-database fault must come back as a note beside the answer,
    not replace it.

    `extra` is (Result, ledger fields) pairs for spend that is not one of `results` (hswarm_decide's Jev calls). Each
    gets a ledger line AND its own utilization row: the ledger line has no `id`, so handing it to utilization.record
    failed every decide with `KeyError: 'id'` (3,070 times, 2026-09-21 to 2026-09-24) and no Jev spend was saved."""
    try:
        caller = detect_caller(kind)
        for r, fields in extra:
            append_row(ask_row(r, caller) | fields)
            await asyncio.to_thread(utilization.record, utilization.ask_row(r, caller) | {"label": fields.get("job") or kind})
        saved = None
        for r in results:
            append_row(ask_row(r, caller) | ({"job": kind} if kind != "ask" else {}))
            saved = utilization.compact(await asyncio.to_thread(utilization.record_ask, r, caller))
        return {"savings": saved} if kind == "ask" else {}
    except Exception as e:  # noqa: BLE001 - see the docstring
        return {"bookkeeping_error": f"{type(e).__name__}: {e}"[:300]}


@_served
@_returns_errors
async def hswarm_decide(items: list[dict], escalate_below: float = 0.7, fallback_model: str = "auto", batch: int = 1, model: str = "jev-1.13.0") -> dict:
    """TYPED decisions over many items in one call, fast: classify, route, yes/no, grade on a scale.

    Each item: {id?, state (text or any JSON), question, type: choice | yesno | score, options}. options is a list of
    keys or a {key: description} map for choice (2-255), an ordered list of 2-10 level descriptions for score, and
    optional {yes: ..., no: ...} descriptions for yesno. Put the facts the decision needs in state, nothing else.
    TypeSafe's Jev answers every item first (~0.15 s and ~$0.00004 each, with a calibrated confidence); an answer
    under escalate_below confidence is re-asked through the published decision capability profile.
    If no valid stronger answer is obtained, the decision remains unanswered with an explicit error.
    The desktop orchestrator retains final authority. escalate_below=0 trusts Jev on
    everything, 1.01 sends everything to the fallback. Items with the same state always share one Jev call (the
    state is read and billed once); batch also packs up to 5 unrelated items per call (more hurt accuracy).
    NOT for arithmetic, counting, dates or writing text (Jev is weak there by design): use hswarm_ask for those.
    model defaults to jev-1.13.0, the version the thresholds were measured on (typesafe.MODEL); 'jev-latest' is the
    moving alias. model 'featherless-ai/<Model>-classifier' sends the typed leg to Featherless's keyless Simple Jev demo instead:
    for re-tests only, it measured no better than Jev and worse calibrated (docs/BENCH-2026-09-24-simple-jev.md).
    model 'clef' or 'clef-flash' sends it to Cloudflare's Workers AI (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID): re-tests
    only, no detectable difference from Jev, and its confidence scale differs, so escalate_below 0.7 is not Jev's 0.7
    there (~0.42 matches it on choices; docs/BENCH-2026-10-02-clef.md); never batch it.
    Returns answers [{id, answer, source, jev: {answer, confidence, probabilities}, fallback?}] plus a cost summary.
    """
    from .decisions import decide
    from .spec import Result, now_iso

    out = await decide(items, manager(), escalate_below=escalate_below, fallback_model=fallback_model, model=model, batch=batch)
    stats = out.pop("_jev_stats")
    fallbacks = out.pop("_fallback_results")
    jev: tuple = ()
    if stats.get("calls"):
        # The Jev part is one ledger line (all its calls), costed like an ask; the caller stamp is added in _book_asks.
        jr = Result(id="decide", status="ok" if not stats.get("errors") else "error", backend="typesafe", model=stats.get("model") or model,
                    usage={"in_hit": 0, "in_miss": stats.get("in", 0), "out": stats.get("out", 0), "reasoning": 0}, cost_usd=stats.get("cost_usd", 0.0),
                    seconds=round(stats.get("secs", 0.0), 3), turns=stats["calls"], finished=now_iso())
        jev = ((jr, {"provider": "typesafe", "job": "decide"}),)
    return out | await _book_asks(fallbacks, "decide", jev)


@_served
@_returns_errors
async def hswarm_panel(prompt: str, models: list[str] | None = None, system: str | None = None, max_findings: int = 8, reasoning_effort: str | None = "low", seed: int | None = None) -> dict:
    """A BLIND PANEL review: one prompt to 2-5 models at once, then an anonymised rebuttal round (hswarm/panel.py).

    Round 1 sends the same prompt to every panelist in parallel, so no answer anchors another; each lists numbered
    findings (at most max_findings). Round 2 shows each panelist the others' findings as Reviewer A/B/C, the letters
    shuffled afresh per panelist, and reads UPHOLD/REJECT <ref>, CONCEDE <own ref> and MISSED lines. models: model
    names, aliases or roles (default: the tool-free and tool-using defaults, or `panel` in ~/.hswarm/settings.toml).
    Returns findings grouped with who upheld/rejected each and a status (contested first, then upheld, unreviewed,
    conceded), `contested` (ids to read first: someone rejects it while someone stands behind it), `missed`, the
    per-panelist board and a cost summary. Tool-free: give it the text to review in the prompt."""
    from .panel import panel

    if reasoning_effort is not None and reasoning_effort not in EFFORTS:
        return {"error": f"reasoning_effort must be one of {'|'.join(EFFORTS)}"}
    out = await panel(prompt, manager(), models=models, system=system, max_findings=max_findings, reasoning_effort=reasoning_effort, seed=seed)
    return out | await _book_asks(out.pop("_results"), "panel")


@_served
@_returns_errors
async def hswarm_cost(days: float = 1.0, balance: bool = True) -> dict:
    """Spend from the local ledger over the last N days, current peak/off-peak rate, next rate change, and the account balance.
    by_model[m].survival, where present: how much of what that model's api workers wrote was still in the file later."""
    return await health.cost(manager(), days, balance)


@_served
@_returns_errors
async def hswarm_savings(days: int = 14, include_today: bool = False) -> dict:
    """What the hswarm saved. `running_total`: every utilization (each hswarm_run job and hswarm_ask, all machines)
    with the DeepSeek cost, the estimated cost of the same work as Claude sub-agents on the caller's model at the
    time, and the saving, plus the fleet total and the last 10. Then per local day on this machine: DeepSeek spend,
    Claude usage (API list-price equivalent), the sub-agent cost avoided as a low-high range, and a 30-day
    projection. include_today scans today's Claude transcripts live, which takes a while."""
    from . import savings

    return await asyncio.to_thread(savings.report, days, include_today)


@_served
@_returns_errors
async def hswarm_sync(push: bool = True, restore: bool = False) -> dict:
    """Sync this machine's utilization ledger with the fleet: pull the other machines' shards from the `sync` branch
    of the private repo HSWARM_SYNC_REPO names (off when unset), import them, export ours, regenerate TOTALS.md (the
    running total), commit and push.
    restore=true first reads THIS machine's own shard back, rebuilding the ledger after a lost ~/.hswarm."""
    out = await asyncio.to_thread(utilization.restore) if restore else {}
    return {**({"restore": out} if restore else {}), **await asyncio.to_thread(utilization.sync, push)}


@_served
@_returns_errors
async def hswarm_usage(hours: float = 24.0) -> dict:
    """WHO used the swarm in the last N hours (per calling account / session / folder: jobs, tasks, ok/error, cost, labels),
    plus every Claude sub-agent decision the routing gate logged, with the fan-outs that matched the mechanical rule but went to Claude anyway."""
    return await asyncio.to_thread(usage_report, hours)  # file reads: off the loop every chat's calls share


@_served
@_returns_errors
async def hswarm_doctor() -> dict:
    """Health: key present (never the value), models reachable, balance, claude/rg/bash binaries, home dir, rate window."""
    return await health.doctor(manager())


@_served
@_returns_errors
async def hswarm_web(allow: list[str] | None = None, block: list[str] | None = None, forget: list[str] | None = None) -> dict:
    """read_url's standing host policy (the web preset), and which backend serves each channel right now.

    allow: hosts every batch may fetch from now on - the allow-always answer to a summary.web_approvals entry
    (allow-once is web_hosts on the next hswarm_run). block: the admin block list; a blocked host is never
    fetched, whatever a batch lists. forget: take hosts off both lists. With no arguments this only reports.
    """
    from . import web

    if allow or block or forget:
        await asyncio.to_thread(web.save_policy, allow, block, forget)
    return web.report()


@_served
@_returns_errors
async def hswarm_keys(action: str = "list", fingerprint: str | None = None, provider: str | None = None, all_keys: bool = False, reason: str = "disabled by hand", verbose: bool = False) -> dict:
    """The API-key pools (DeepSeek, OpenRouter, ...) and the DISABLED slot. Keys are never returned, only 8-character fingerprints.

    A key that runs out of credit (a 402), or that has been revoked past its strikes, goes to the disabled slot and is
    NEVER handed to a worker again - no timer, no retry ladder - so a spent key costs nothing to route around.
    action: list (offline, default) | probe (one FREE GET per key; a topped-up key comes back out of the slot here)
    | enable (take one out by fingerprint, or all_keys=true for the lot) | disable (put one in by hand).
    A key disabled for a 402 keeps serving ':free' models while its free-tier allowance lasts.
    list is BOUNDED by default - every count, plus only the keys needing attention (at most 40 per provider);
    verbose=true returns every row (1,700+ keys is ~900k characters, more than a client will show).
    """
    from . import keys as keymod

    if action == "list":
        return keymod.report(provider, verbose=verbose)
    if action == "probe":
        return await keymod.probe(provider)
    if action in ("enable", "disable"):
        if not fingerprint and not (action == "enable" and all_keys):
            return {"error": "give a fingerprint (hswarm_keys action='list' prints them), or all_keys=true with enable"}
        return await asyncio.to_thread(keymod.set_enabled, fingerprint, action == "enable", provider, all_keys, reason)
    return {"error": f"unknown action {action!r}; use list | probe | enable | disable"}


@_served
@_returns_errors
async def hswarm_bench(suite: str | None = None, arm: str | None = None, all_versions: bool = False, include_legacy: bool = True, limit: int = 120) -> dict:
    """The bench RESULTS DATABASE: what every model/arm scored on every benchmark suite, with cost per item and latency.

    CHECK THIS BEFORE YOU BENCHMARK OR A/B TEST ANY MODEL. If the question is answered here, re-measuring it wastes
    usage (owner directive, 2026-09-21). Rows are committed in the hswarm repo (bench/results/*.jsonl), so every
    machine sees every other machine's runs; the harnesses (bench/decide.py, bench/hard_reasoning.py, `hswarm bench`)
    write every answer as it lands and skip what is already measured for the same suite version.
    suite: e.g. 'decisions.triage', 'bench.judgment', 'hard_reasoning' (substring match); arm: substring of the arm label.
    Newest suite version only unless all_versions; source 'doc' rows are aggregates transcribed from docs/BENCH-*.md.
    """
    from . import benchdb

    lines = await asyncio.to_thread(benchdb.board, None, include_legacy, all_versions)
    if suite:
        lines = [x for x in lines if suite in (x["suite"] or "")]
    if arm:
        lines = [x for x in lines if arm in (x["arm"] or "")]
    return {"rows": lines[:limit], "total": len(lines), "suites": sorted({x["suite"] for x in lines}),
            "how": "rate = passed/graded; ungraded rows (limits, errors) never count as fails; skipped = known-gap tasks the arm "
                   "was not run on, so its rate covers fewer items than its peers'; hswarm benchdb board prints the same table"}


@_served
@_returns_errors
async def hswarm_models(refresh: str | None = None, grep: str | None = None, limit: int = 60) -> dict:
    """Every model this machine can address, with its price per 1M tokens ('-' when none is on record).

    OpenRouter models are addressed as 'or:<its id>' (e.g. 'or:deepseek/deepseek-chat-v3.1', 'or:z-ai/glm-5.3-flash')
    with no registration step. refresh='openrouter' pulls its live catalogue (~440 models) and their current rates, so
    their cost stops reading '-'; OpenRouter also reports what it actually charged on every call, and that number wins.
    """
    from . import catalogue

    if refresh:
        return await catalogue.refresh(refresh)
    return await asyncio.to_thread(catalogue.listing, grep, limit)


def main() -> None:
    config.ensure_dirs()
    # Opt-in session recording (hswarm/replay.py): with HSWARM_RECORD set this process only relays stdio to a
    # child server and writes every JSON-RPC line down, so a crash deep in a long session can be replayed.
    # 0/false/off/no mean "off", not a folder named ./0/ under the server's cwd.
    target = os.environ.get("HSWARM_RECORD", "").strip()
    if target.lower() not in ("", "0", "false", "off", "no"):
        from . import replay

        raise SystemExit(replay.record(replay.server_command(), replay.record_path(target)))
    verdict.write()  # offline; the routing gate reads it (verdict.py)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
