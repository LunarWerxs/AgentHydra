"""Checked work: a task's opt-in `verify` runs after the worker finishes, and a failed check sends the task back to a
worker with the failure appended, a capped number of times, so the caller gets a PASS or one escalation record
instead of a plausible claim it has to re-run itself.

Two checks, either or both. `command` runs in the task's cwd through the harness (never the worker), and its exit
code is the verdict. `judge` is the acceptance criteria, scored by the judge role against a PASS/FAIL schema with
typed issues and per-criterion status; it runs only once the command (if any) has passed, so a red build never
costs a judge call. The whole loop, judge calls included, stays inside the task's `max_cost_usd`.

Ideas from msitarzewski/agency-agents (QA verdict, retry with the issue list, escalation after 3 attempts) and
multica-ai/andrej-karpathy-skills ("[step] -> verify: [check]"), both MIT; written fresh for hswarm."""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable

from .procs import find_bash, run_hidden

if TYPE_CHECKING:
    from .spec import Result, Task

DEFAULT_RETRIES = 2  # three attempts in all: the agency-agents cap before a task is escalated as blocked
MAX_RETRIES = 5
DEFAULT_TIMEOUT_S = 300
TAIL_CHARS = 2000  # the end of the check's output: where a test runner or compiler puts the failure that matters
ANSWER_CHARS = 6000  # of the worker's answer, handed to the judge
FEEDBACK_ANSWER_CHARS = 1500  # of the previous answer, handed back to the next attempt
JUDGE_FILES, JUDGE_FILE_CHARS = 4, 3000  # changed files the judge reads, and how much of each
FIELDS = ("command", "judge", "retries", "timeout_s")

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
        "issues": {"type": "array", "items": {"type": "object", "properties": {
            "category": {"type": "string", "description": "e.g. correctness, completeness, format, scope"},
            "severity": {"type": "string", "enum": ["critical", "major", "minor"]},
            "detail": {"type": "string", "description": "what is wrong and where, specific enough to fix"},
        }, "required": ["severity", "detail"]}},
        "criteria": {"type": "array", "items": {"type": "object", "properties": {
            "criterion": {"type": "string"},
            "met": {"type": "boolean"},
            "evidence": {"type": "string", "description": "the quoted part of the result that shows it, or what is missing"},
        }, "required": ["criterion", "met"]}},
    },
    "required": ["verdict", "issues", "criteria"],
}

# The judge starts from FAIL and passes only on evidence in front of it (the agency-agents Reality Checker stance):
# a judge that grades on plausibility waves through exactly the confident junk this exists to catch.
JUDGE_SYSTEM = """You are a strict reviewer grading one worker's result for an orchestrator that reads your verdict as data.
Start from FAIL. Return PASS only when the result in front of you shows every acceptance criterion met; a claim without evidence is not met.
List every criterion with met true/false and the evidence. List every issue with a category, a severity (critical | major | minor) and a detail specific enough for the worker to fix it.
Minor issues alone do not fail a result. Call submit_result exactly once."""


def normalise(v: object, task_id: str) -> dict | None:
    """A task's `verify` as given (a command string, or {command?, judge?, retries?, timeout_s?}) in one shape, or
    None when off. `judge: true` grades against the task prompt alone; a string is the acceptance criteria."""
    if v is None or v is False or v == "":
        return None
    if isinstance(v, str):
        v = {"command": v}
    if not isinstance(v, dict):
        raise ValueError(f"task {task_id}: verify must be a command string or an object {{{', '.join(FIELDS)}}}")
    unknown = set(v) - set(FIELDS)
    if unknown:
        raise ValueError(f"task {task_id}: verify has unknown fields {sorted(unknown)}; known: {list(FIELDS)}")
    command = str(v.get("command") or "").strip() or None
    judge = v.get("judge")
    if judge is True:
        judge = "The result does what the task asks, completely and correctly."
    judge = str(judge).strip() if judge else None
    if not command and not judge:
        raise ValueError(f"task {task_id}: verify needs a command, judge criteria, or both")
    retries = int(v.get("retries", DEFAULT_RETRIES))
    if not 0 <= retries <= MAX_RETRIES:
        raise ValueError(f"task {task_id}: verify.retries must be 0..{MAX_RETRIES}")
    timeout_s = max(5, min(int(v.get("timeout_s", DEFAULT_TIMEOUT_S)), 3600))
    return {"command": command, "judge": judge, "retries": retries, "timeout_s": timeout_s}


def tail(text: str, limit: int = TAIL_CHARS) -> str:
    text = text.strip()
    return text if len(text) <= limit else "...\n" + text[-limit:]


async def run_command(command: str, cwd: str, timeout_s: int) -> dict:
    """Run the check the way the worker's own bash tool does (hidden, gated, tree-killed on timeout). `exit` None
    means the check could not run at all: a harness fault, which no retry of the worker will fix."""
    sh = find_bash()
    if not sh:
        return {"exit": None, "output_tail": "no working bash found (Git Bash expected on Windows)"}
    code, out, err = await run_hidden([sh, "-lc", command], cwd, timeout_s)
    return {"exit": code, "output_tail": tail(out + (("\n[stderr]\n" if out else "") + err if err else ""))}


def judge_prompt(task: Task, res: Result, check: dict | None) -> str:
    parts = [f"TASK given to the worker:\n{task.prompt.strip()}", f"ACCEPTANCE CRITERIA:\n{task.verify['judge']}"]
    answer = json.dumps(res.data, ensure_ascii=False) if res.data is not None else res.answer
    parts.append("WORKER RESULT:\n" + (answer[:ANSWER_CHARS] + ("\n... [truncated]" if len(answer) > ANSWER_CHARS else "") if answer else "<empty>"))
    if check:
        parts.append(f"CHECK `{task.verify['command']}` exited {check['exit']}. Output tail:\n{check['output_tail'] or '<none>'}")
    for rel in res.files_changed[:JUDGE_FILES]:
        p = Path(task.cwd) / rel
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            text = f"<unreadable: {e}>"
        cut = f"\n... [{len(text) - JUDGE_FILE_CHARS} more chars]" if len(text) > JUDGE_FILE_CHARS else ""
        parts.append(f"--- changed file: {rel} ---\n{text[:JUDGE_FILE_CHARS]}{cut}\n--- end file ---")
    return "\n\n".join(parts)


def verdict_passed(data: object) -> bool:
    """PASS needs the verdict AND every listed criterion met: a PASS over an unmet criterion is the judge contradicting itself."""
    if not isinstance(data, dict) or data.get("verdict") != "PASS":
        return False
    return all(bool(c.get("met")) for c in data.get("criteria") or [] if isinstance(c, dict))


def feedback(task: Task, entry: dict, attempt: int, attempts: int) -> str:
    """What the next attempt is told: the check's failure, the judge's issues and unmet criteria, and the head of
    the answer that failed (a tool-free worker starts fresh and has no other way to know what it said)."""
    lines = [f"--- verify: attempt {attempt} of {attempts} FAILED its check ---",
             "A previous attempt at this task did not pass. Fix the cause below, then give the final answer again."]
    if entry.get("exit") is not None:
        lines.append(f"Check `{task.verify['command']}` exited {entry['exit']}. Output tail:\n{entry.get('output_tail') or '<none>'}")
    verdict = entry.get("verdict") or {}
    for i in verdict.get("issues") or []:
        if isinstance(i, dict):
            lines.append(f"- [{i.get('severity', '?')}] {i.get('category') or 'issue'}: {i.get('detail', '')}")
    for c in verdict.get("criteria") or []:
        if isinstance(c, dict) and not c.get("met"):
            lines.append(f"- criterion not met: {c.get('criterion', '')}" + (f" ({c['evidence']})" if c.get("evidence") else ""))
    if entry.get("answer_head"):
        lines.append(f"Previous answer (head):\n{entry['answer_head']}")
    return "\n".join(lines)


def _fold(into: Result, other: Result) -> None:
    """An earlier attempt's (or a judge call's) spend is real: it rides on the result the ledger and budget see."""
    if other.cost_usd is not None:
        into.cost_usd = (into.cost_usd or 0.0) + other.cost_usd
    for k, v in (other.usage or {}).items():
        into.usage[k] = into.usage.get(k, 0) + v
    into.turns += other.turns
    into.tool_calls += other.tool_calls
    into.seconds = round(into.seconds + other.seconds, 3)


Attempt = Callable[["Task", bool], Awaitable[tuple["Result", object]]]
Judge = Callable[[str, str], Awaitable["Result"]]


async def run_verified(task: Task, attempt: Attempt, judge: Judge | None = None, check=None) -> tuple[Result, object]:
    """Run `task` through `attempt(task_copy, first)` until its verify passes, the retry cap or `max_cost_usd` is
    reached, or the worker itself fails (an error or timeout is already a clear answer; retrying it only spends).
    Returns the last attempt's result with every attempt's and judge call's spend folded in and `verify` filled; a
    task that never passed comes back status error, `VerifyFailed:`, with `verify.escalation` holding the history."""
    check = check or run_command  # looked up at call time, so a test can stand in for the shell
    attempts = task.verify["retries"] + 1
    history: list[dict] = []
    earlier: list[Result] = []
    changed: set[str] = set()
    note = ""
    reason = ""
    for n in range(1, attempts + 1):
        res, transcript = await attempt(_attempt_task(task, note, earlier), n == 1)
        changed.update(res.files_changed)
        entry, passed, reason = await _check_attempt(task, res, n, check, judge, earlier, reason)
        history.append(entry)
        final = passed or n == attempts or _unretryable(res, reason)
        if not final and _budget_spent(task, earlier + [res]):
            final, reason = True, f"{reason}; max_cost_usd ${task.max_cost_usd:.4f} spent before another attempt"
        if final:
            break
        note = feedback(task, entry, n, attempts)
        earlier.append(res)
    _settle(res, earlier, changed, history, passed, reason)
    return res, transcript


def _attempt_task(task: Task, note: str, earlier: list[Result]) -> Task:
    """The task as the next attempt sees it: the last failure appended, and only the budget earlier spend left."""
    spent = sum(r.cost_usd or 0.0 for r in earlier)
    return dataclasses.replace(task, prompt=task.prompt.rstrip() + ("\n\n" + note if note else ""),
                               max_cost_usd=max(task.max_cost_usd - spent, 0.0001) if task.max_cost_usd else task.max_cost_usd)


async def _check_attempt(task: Task, res: Result, n: int, check, judge: Judge | None, earlier: list[Result],
                         reason: str) -> tuple[dict, bool, str]:
    """One attempt's history entry and verdict: the worker's own status, then the command, then the judge, each only
    once the one before has passed. `reason` is carried in unchanged when nothing here fails."""
    entry: dict = {"attempt": n, "status": res.status, "cost_usd": res.cost_usd, "answer_head": (res.answer or "")[:FEEDBACK_ANSWER_CHARS]}
    passed = res.status == "ok"
    if not passed:
        entry["error"] = (res.error or "")[:300]
        reason = f"the worker itself ended {res.status} on attempt {n}"
    if passed and task.verify["command"]:
        passed, reason = await _run_check(task, check, entry, reason)
    if passed and task.verify["judge"]:
        passed, reason = await _run_judge(task, res, entry, judge, earlier)
    return entry, passed, reason


async def _run_check(task: Task, check, entry: dict, reason: str) -> tuple[bool, str]:
    spec = task.verify
    result = await check(spec["command"], task.cwd, spec["timeout_s"])
    entry.update(result)
    passed = result["exit"] == 0
    if result["exit"] is None:
        reason = f"the check could not run: {result['output_tail']}"
    elif not passed:
        reason = f"check exited {result['exit']}"
    return passed, reason


async def _run_judge(task: Task, res: Result, entry: dict, judge: Judge | None, earlier: list[Result]) -> tuple[bool, str]:
    """The judge's verdict on this attempt; its call's spend joins `earlier` so it is folded in and counts to the budget."""
    if judge is None:
        return False, "no judge is wired for this backend"
    try:
        j = await judge(judge_prompt(task, res, entry if task.verify["command"] else None), JUDGE_SYSTEM)
    except (ValueError, KeyError) as e:  # no judge role wired on this machine
        return False, f"the judge could not run: {e}"
    earlier.append(j)
    entry["verdict"] = j.data if isinstance(j.data, dict) else None
    if j.status != "ok" or entry["verdict"] is None:
        return False, f"the judge could not run: {(j.error or 'no verdict returned')[:200]}"
    passed = verdict_passed(j.data)
    return passed, "" if passed else "judge verdict FAIL"


def _unretryable(res: Result, reason: str) -> bool:
    """A worker that itself failed, or a check or judge that could not run: another attempt would only spend."""
    return res.status != "ok" or reason.startswith(("the check could not", "the judge could not", "no judge"))


def _budget_spent(task: Task, spend: list[Result]) -> bool:
    return bool(task.max_cost_usd) and sum(r.cost_usd or 0.0 for r in spend) >= task.max_cost_usd


def _settle(res: Result, earlier: list[Result], changed: set[str], history: list[dict], passed: bool, reason: str) -> None:
    """Fold every earlier attempt and judge call into the kept result and fill its `verify`; a task that never passed
    becomes status error with an escalation record."""
    for e in earlier:
        _fold(res, e)
        res.add_taint("R", e.taint)  # the answer kept is a re-run of a failed attempt, whose own letters stay on it
    res.files_changed = sorted(changed)
    last = history[-1]
    res.verify = {"passed": passed, "attempts": len(history), "exit": last.get("exit"), "output_tail": last.get("output_tail"),
                  "verdict": last.get("verdict"), "history": history}
    if not passed:
        res.verify["escalation"] = {"blocked": True, "reason": reason, "attempts": len(history)}
        if res.status == "ok":
            res.status = "error"
            res.error = f"VerifyFailed: {reason} after {len(history)} attempt(s); verify.history holds every attempt"
