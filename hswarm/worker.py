"""What a DeepSeek worker is told and how its replies are read: the prompt contract, the
`submit_result` tool that carries structured answers, and the per-turn helpers the loop in
agent.py calls. Nothing here talks to the network."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from . import receipts
from .acceptance import prompt_clause
from .client import ChatResult
from .guard import GuardError, frame, with_charter
from .code_brief import system_for
from .review import receipt_gap, unread_gap
from .redaction import Redactor
from .spec import Result, Task, inline_files
from .tools import Sandbox
from .toolspecs import tool_names

WORKER_SYSTEM = """You are a hswarm worker: one autonomous, terse agent doing exactly one task for an orchestrator that reads your final message as data.

Rules:
- Working directory: {cwd}. Paths may be relative to it. You cannot leave the sandbox roots.
- Look before you answer: use tools, never guess file contents. Issue independent tool calls together in one turn.
- Never ask questions. If something is ambiguous, state one assumption and continue.
- Final message = the answer only. Concrete and specific, file:line references where relevant, no preamble, no restating the task, no offers of further help.{schema_clause}
- If the task cannot be done, reply with one line starting with FAILED: and the reason."""

SCHEMA_CLAUSE = "\n- When you have the result, call submit_result exactly once with the requested fields. That call ends the task."

# Sent when the turn budget is spent: no tools, answer from what was gathered.
NUDGE = "Turn budget exhausted. Do not call tools. Reply now with the best final answer you can give from what you have gathered."
# Sent when a turn came back empty (thinking ate the whole output budget, or the model emitted nothing).
EMPTY_NUDGE = "Your last message was empty. Reply now with the final answer as plain text (or call submit_result if it exists). Do not reason at length."
EMPTY_RETRIES = 2


def uses_tools(task: Task) -> bool:
    return task.tools not in ("none", "", [])


# Told up front so a worker spends no turns discovering the frozen files by refusal.
WRITABLE_CLAUSE = "\n- You may create or change only files matching {globs} (relative to the working directory). Every other file is read-only to you: read it, never try to change it."

# Told up front so a worker on a runtime (runtimes.py) writes POSIX paths and that system's commands, not this host's.
RUNTIME_CLAUSE = "\n- Your tools run inside {runtime}, not on the orchestrator's machine: paths are POSIX paths there, and bash is that system's shell (background jobs and propose are not available)."


def build_messages(task: Task, redactor: Redactor | None = None) -> list[dict]:
    clauses = (SCHEMA_CLAUSE if task.schema else "") + (WRITABLE_CLAUSE.format(globs=task.writable) if task.writable is not None else "")
    if uses_tools(task):
        # The receipt contract (receipts.py): cite [rN tool] for each claimed action, so the orchestrator
        # re-checks first what no tool call backs.
        clauses += receipts.RECEIPT_CLAUSE
    if task.green:
        base = receipts.GREEN_BASE if receipts.GREEN_LEVELS.index(task.green) >= receipts.GREEN_LEVELS.index(receipts.BASE_REQUIRED_FROM) else ""
        clauses += receipts.GREEN_CLAUSE.format(level=task.green, base=base)
    if getattr(task, "runtime", ""):
        # Without this a worker writes Windows paths and host-only commands into a Linux container or a Mac.
        clauses += RUNTIME_CLAUSE.format(runtime=task.runtime)
    system = WORKER_SYSTEM.format(cwd=task.cwd, schema_clause=clauses)
    extra = system_for(task)  # the caller's own system prompt, or the lazy-senior brief for an edit task (code_brief.py)
    if extra:
        system += "\n\n" + extra.strip()
    # The safety charter heads every worker prompt (guard.py): tool output is data, never instructions.
    # The acceptance criteria ride on the user turn, so the worker can meet what it will be judged on (acceptance.py).
    user = task.prompt.strip() + prompt_clause(task.acceptance)
    return [{"role": "system", "content": with_charter(system)}, {"role": "user", "content": inline_files(task, user, redactor)}]


def submit_result_spec(schema: dict) -> dict:
    """A tool whose arguments ARE the answer: the model fills the schema instead of writing prose."""
    params = dict(schema)
    params.setdefault("type", "object")
    return {"type": "function", "function": {"name": "submit_result", "description": "Submit the final structured result. Calling this ends the task.", "parameters": params}}


PARTIAL_CHARS = 4000  # what a task that hit its wall hands back from its own transcript
PARTIAL_TOOL_OUTPUTS = 6  # the most recent tool results kept, each cut to a few hundred chars


def partial_evidence(messages: list[dict]) -> str:
    """What a task gathered before it hit its wall, from its own transcript: the model's text, the tool calls it
    made and the tail of the latest tool results. Measured 2026-09-24 (job 20260924-234903-1c5b): 20 tasks timed
    out after ~9 turns and 11 tool calls each and came back with an empty answer, so every turn was thrown away.
    Empty when the task made no call at all."""
    notes: list[str] = []
    outputs: list[str] = []
    for m in messages[2:]:  # past the system prompt and the task itself
        if m.get("role") == "assistant":
            if isinstance(m.get("content"), str) and m["content"].strip():
                notes.append("said: " + m["content"].strip()[:600])
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                notes.append(f"called {fn.get('name')}({str(fn.get('arguments') or '')[:200]})")
        elif m.get("role") == "tool" and isinstance(m.get("content"), str):
            outputs.append(m["content"].strip()[:400])
    if not notes:
        return ""
    body = "\n".join(notes) + "".join(f"\n--- tool result ---\n{o}" for o in outputs[-PARTIAL_TOOL_OUTPUTS:])
    head = "PARTIAL - the task hit its wall before answering; this is what it had gathered, not an answer:\n"
    return head + (body if len(body) <= PARTIAL_CHARS else "...\n" + body[-PARTIAL_CHARS:])


def over_budget(res: Result, task: Task, r: ChatResult) -> bool:
    """Context or cost ceiling crossed: mark the result and stop the loop."""
    if r.usage.prompt > task.max_context:
        res.status, res.error, res.answer = "error", f"context budget exceeded: {r.usage.prompt} prompt tokens > {task.max_context}", r.content
        res.add_taint("C")
        return True
    # The per-task cost cap is the reasoning-runaway guard: one worker spent 80k reasoning tokens on a false premise (2026-09-15).
    if task.max_cost_usd and (res.cost_usd or 0.0) > task.max_cost_usd:
        res.add_taint("C")
        res.status = "error"
        res.error = f"cost budget exceeded: ${res.cost_usd:.4f} > ${task.max_cost_usd:.4f} (reasoning runaway? lower reasoning_effort or raise max_cost_usd)"
        res.answer = r.content.strip()
        return True
    return False


def final_text(res: Result, r: ChatResult) -> None:
    """A message with no tool calls is the answer; `FAILED:` is the contract for a refusal."""
    answer = r.content.strip()
    res.answer = answer
    if not answer:
        res.status, res.error = "error", f"empty answer (finish_reason={r.finish_reason})"
    elif answer.startswith("FAILED:"):
        res.status, res.error = "error", answer
    else:
        res.status = "ok"


# Liveness: did a finished task move the work, or only say what it would do? A worker "ok" means it replied,
# not that it did anything: a reply of "I'll inspect the config next" or "blocked: no API key" is status ok
# and reads as done to an orchestrator skimming statuses. These labels let it send one bounded continuation
# or hand the task to a human instead of accepting a no-op. Pure text + counters, no model call.
# Idea adapted from paperclipai/paperclip server/src/services/run-liveness.ts (MIT); written fresh here.
LIVENESS_STATES = ("advanced", "planning_only", "blocked_external", "approval_required", "failed")

# A reply that opens by announcing work instead of reporting it.
_PLAN_OPENER = re.compile(
    r"^\s*(?:(?:ok(?:ay)?|sure|alright|first)[,.!]?\s+)?"
    r"(?:i['’]ll|i will|i['’]m going to|i am going to|let me|let['’]s|i need to|i should|i plan to"
    r"|next,? i(?:['’]ll| will))\b", re.I)
# A "Next steps:" / "Next action:" / "Plan:" line, with whatever follows it on that line.
_NEXT_LINE = re.compile(r"^[ \t>*#-]*(?:\*\*)?(?:next steps?|next actions?|plan)(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(.*)$", re.I | re.M)
# Stopped by something outside the task's reach: credentials, access, a login. First person only: the worker
# says it is the one stopped.
_BLOCKED_SELF = re.compile(
    r"\b(?:i|we)(?:['’]m|['’]re| am| are| was| were)?\s+(?:currently\s+)?blocked (?:on|by)\b"
    r"|\b(?:i|we)\s+(?:do not have|don['’]t have|have no|lack|need|require)\s+(?:an?\s+|the\s+|valid\s+|any\s+)?"
    r"(?:access|permission|credentials?|api[ _-]?keys?|access tokens?|auth(?:entication)? tokens?)\b"
    r"|\b(?:i|we)\s+(?:cannot|can['’]t|am unable to|are unable to)\s+(?:access|authenticate|log ?in|sign in)\b", re.I)
# Noun forms name a blocker without saying whose it is. hswarm reviews code that handles keys, so "config.py:88
# crashes with no API key set" or "the request is blocked by CORS" is a finding; these count only under the
# worker's own stop line, a reply that leads with FAILED: or blocked:.
_BLOCKED_NOUN = re.compile(
    r"\bblocked (?:on|by)\b"
    r"|\b(?:missing|no|without|lacks?|lacking|needs?|requires?)\s+(?:an?\s+|the\s+|valid\s+|any\s+)?"
    r"(?:credentials?|api[ _-]?keys?|access tokens?|auth(?:entication)? tokens?)\b"
    r"|\bpermission denied\b|\baccess denied\b|\b401 unauthori[sz]ed\b|\b403 forbidden\b", re.I)
_BLOCKED_LEAD = re.compile(r"^\s*(?:FAILED:|(?:\*\*)?blocked(?:\*\*)?\s*(?::|on\b|by\b))", re.I)
# Waiting on someone's yes. The worker contract forbids questions, so this is a stop, not a courtesy.
_APPROVAL = re.compile(
    r"\bawaiting (?:your |human |manager |owner )?(?:approval|confirmation|sign-?off|review)\b"
    r"|\b(?:needs?|requires?|requesting)\s+(?:your |human |manager |owner |explicit )?(?:approval|sign-?off|confirmation)\b"
    r"|\bplease (?:confirm|approve)\b"
    r"|\b(?:should|shall|may|can) i (?:proceed|go ahead|continue|apply|commit|push|delete|overwrite)\b", re.I)
_PLAN_SHORT_CHARS = 400  # a planning opener counts only on a reply this short; past it the reply is the work itself
_EDGE_HEAD, _EDGE_TAIL = 400, 600  # blockers and asks are read at the reply's edges, not inside a long report
NEXT_ACTION_CHARS = 240


def _edges(text: str) -> str:
    """Where a worker states a blocker or an ask: its opening and its close. A long report that quotes
    'permission denied' as a finding in its middle is not blocked."""
    return text if len(text) <= _EDGE_HEAD + _EDGE_TAIL else text[:_EDGE_HEAD] + "\n" + text[-_EDGE_TAIL:]


_STOP = re.compile(r"[.!?](?=\s|$)|\n")  # a sentence end; the dot in "config.py" is not one


def _sentence_at(text: str, start: int, end: int) -> str:
    """The sentence (or line) around a match: from the previous stop to the next one."""
    left = max((m.end() for m in _STOP.finditer(text, 0, start)), default=0)
    right = _STOP.search(text, end)
    return text[left:right.end() if right else len(text)]


def _clip(s: str) -> str:
    s = " ".join(s.strip().lstrip("-*> \t").split())
    return s if len(s) <= NEXT_ACTION_CHARS else s[:NEXT_ACTION_CHARS - 3] + "..."


def _stated_next(text: str) -> str:
    """The run's own 'Next steps:' line, or the first item under it."""
    m = _NEXT_LINE.search(text)
    if not m:
        return ""
    if m.group(1).strip():
        return _clip(m.group(1))
    below = next((ln for ln in text[m.end():].splitlines() if ln.strip()), "")
    return _clip(below)


def classify_liveness(res: Result) -> tuple[str, str]:
    """(liveness, next_action) for a finished task, from its durable evidence (a submitted schema object,
    files it changed, tool calls it made) and its final text. `advanced` means nothing flagged it; planning_only,
    blocked_external and approval_required name why an `ok` is not a result. A FAILED: line is read for an external blocker;
    any other error, timeout or cancel is `failed` (a PARTIAL answer is transcript, never classified)."""
    text = (res.answer or "").strip()
    own_failure = res.status == "error" and text.startswith("FAILED:")
    if res.status != "ok" and not own_failure:
        return "failed", ""
    if res.data is not None and not own_failure:
        return "advanced", ""  # the schema contract was met: the object IS the result
    edges = _edges(text)
    m = _BLOCKED_SELF.search(edges) or (_BLOCKED_NOUN.search(edges) if _BLOCKED_LEAD.match(text) else None)
    if m:
        return "blocked_external", _stated_next(text) or _clip(_sentence_at(edges, m.start(), m.end()))
    if own_failure:
        return "failed", ""
    m = _APPROVAL.search(edges)
    if m:
        return "approval_required", _clip(_sentence_at(edges, m.start(), m.end()))
    worked = bool(res.files_changed) or res.tool_calls > 0
    opener = _PLAN_OPENER.match(text)
    stated = _stated_next(text)
    # The length bound holds with or without tool work: a tools="none" review has no tool calls by design,
    # and its long answer opening "Let me walk through..." is the analysis, not a plan for one.
    if not res.files_changed and opener and len(text) <= _PLAN_SHORT_CHARS:
        return "planning_only", stated or _clip(_sentence_at(text, 0, opener.end()))
    if not worked and stated and len(text) <= _PLAN_SHORT_CHARS:
        return "planning_only", stated  # no tool touched anything and the reply is a plan headed "Next steps:"
    return "advanced", ""


SCHEMA_REJECTS = 3  # invalid submit_result calls a leg gets before the task fails over as InvalidStructuredAnswer


SCHEMA_TEXT_NUDGE = ("This task's answer must come through the submit_result tool, as JSON that matches its schema, not "
                     "as text. Call submit_result now with the answer.")
SCHEMA_TEXT_RETRIES = 2
_FENCED = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def payload_in_text(text: str, schema: dict | None) -> dict | None:
    """The structured answer a worker wrote as TEXT instead of calling submit_result, when that text holds one that
    meets the schema: a fenced json block, the bare object, or a submit_result call typed out as text (Cohere's Command
    A did all three on 2026-09-26, and each came back ok with no data). None when nothing in it conforms."""
    found: list = []
    for chunk in [*_FENCED.findall(text or ""), text or ""]:
        try:
            found.append(json.loads(chunk.strip()))
        except ValueError:
            continue
    for obj in found:
        calls = obj if isinstance(obj, list) else [obj]
        for c in calls:
            if isinstance(c, dict) and c.get("tool_name") == "submit_result" and isinstance(c.get("parameters"), dict):
                c = c["parameters"]
            if isinstance(c, dict) and not schema_errors(schema, c):
                return c
    return None


def schema_errors(schema: dict | None, args: dict) -> list[str]:
    """Every way the submitted object breaks the task's JSON Schema, nested `required`, `minItems`, types and
    enums included, as short path-named lines; empty when it conforms.

    The provider's function calling treats the schema as advice, not a contract. Measured 2026-09-16: a worker
    left two top-level required keys out and the job reported it ok. Measured 2026-09-25 (jobs
    20260925-143537-e2e8 and -143658-29b0): the Gemini route answered a translation asking for 140 rows with
    `{"rows": []}` and one `dummy` row, and both were reported ok, because only the top-level `required` list
    was checked. A caller's schema that is not itself valid JSON Schema falls back to that top-level check."""
    if not schema:
        return []
    from jsonschema import exceptions, validators

    params = dict(schema)
    params.setdefault("type", "object")
    cls = validators.validator_for(params)
    try:
        cls.check_schema(params)
    except exceptions.SchemaError:
        return [f"(root): missing required key {k!r}" for k in (params.get("required") or []) if k not in args]
    errors = sorted(cls(params).iter_errors(args), key=lambda e: list(e.absolute_path))
    return [f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message[:200]}" for e in errors[:6]]


def hollow(value) -> bool:
    """No value anywhere: every leaf is an empty object, list or string, or null. `{"translations": {}}` and
    `{"rows": []}` are hollow; `{"found": false, "items": []}` is not (the boolean is an answer)."""
    if isinstance(value, dict):
        return all(hollow(v) for v in value.values())
    if isinstance(value, list):
        return all(hollow(v) for v in value)
    return value is None or value == ""


# Every way run_tools sends a submit_result back opens with one of these, which is how schema_repaired sees it.
REJECTED = "ERROR: submit_result rejected"
UNPARSED = "ERROR: could not parse arguments for submit_result"


def schema_repaired(outputs: list[str]) -> bool:
    """Whether this turn sent a submit_result back for another try: the answer that follows is a repaired one (taint S)."""
    return any(o.startswith((REJECTED, UNPARSED)) for o in outputs if isinstance(o, str))


HOLLOW_REJECT = ("ERROR: submit_result rejected - it carries no data (every field is empty). Do the task from "
                 "the input you were given and submit the real result. If, having done it, there truly is nothing "
                 "to report, call submit_result again with the same empty payload and it will be accepted.")


async def run_tools(sb: Sandbox, tool_calls: list[dict], schema: dict | None = None, state: dict | None = None, *,
                    inventory: list[str] | None = None) -> tuple[list[str], dict | None]:
    """Execute every tool call of one turn concurrently; returns outputs in order plus a submit_result payload if any.

    A submit_result that breaks the schema is a tool error naming what is wrong, so the model retries; `state`
    (one dict per task) counts those rejections (`invalid`) and lets a HOLLOW payload through only the second
    time it is submitted, so a lazy empty answer gets one push and a genuinely empty one still lands.
    With an `inventory` (keyword-only), a schema-valid submit whose coverage receipt does not match it, or that
    lists a still-existing path the sandbox never saw read, is rejected the same way (review.py)."""
    state = state if state is not None else {}
    submitted = None
    pending = []
    turn_start = len(sb.receipts) if sb is not None else 0  # a write anywhere in this turn counts as after its reads
    for tc in tool_calls:
        fn = tc.get("function") or {}
        name = fn.get("name") or ""
        try:
            args = json.loads(fn.get("arguments") or "{}")
            if not isinstance(args, dict):
                raise ValueError("arguments must be an object")
        except ValueError as e:
            # Malformed arguments go back to the model as a tool error, so it can retry instead of the task dying.
            pending.append(asyncio.sleep(0, result=f"ERROR: could not parse arguments for {name}: {e}"))
            continue
        if name == "submit_result":
            errors = schema_errors(schema, args)
            if errors:
                # A payload that breaks the schema is a tool error, not a result: the model gets the list and retries.
                state["invalid"] = state.get("invalid", 0) + 1
                state["last_errors"] = errors
                pending.append(asyncio.sleep(0, result="ERROR: submit_result rejected - it does not match the schema:\n- "
                                             + "\n- ".join(errors) + "\nCall submit_result again with a result that does."))
                continue
            if schema and hollow(args) and not state.get("hollow"):
                state["hollow"] = True
                pending.append(asyncio.sleep(0, result=HOLLOW_REJECT))
                continue
            if inventory and (gap := receipt_gap(inventory, args) or (sb is not None and unread_gap(inventory, sb.cwd, sb.files_read))):
                # A partial receipt is sent back once more rather than accepted: the worker still has turns to review
                # what it skipped, or to say FAILED. If it never matches, jobs.py fails the task on the same check.
                # With a sandbox (api backend) a listed path that exists must also have been opened with read_file.
                pending.append(asyncio.sleep(0, result=f"ERROR: submit_result rejected - {gap}. Review the paths you skipped, "
                                             "then call submit_result again listing only paths you fully reviewed; if you "
                                             "cannot assess one, reply FAILED: with the reason."))
                continue
            submitted = args
            pending.append(asyncio.sleep(0, result="result accepted"))
        else:
            # the receipt header rides inside the frame
            pending.append(_framed(sb, name, args, state, tc.get("id"), turn_start))
    return list(await asyncio.gather(*pending)), submitted


async def _framed(sb: Sandbox, name: str, args: dict, state: dict, call_id: str | None, turn_start: int) -> str:
    """A sandbox tool's output as the model sees it: inside the one <scan_data> frame, markers escaped. Output
    whose forged frame could not be defused is withheld with an error the model can read, not shown armed.
    The call is made in here, not passed in: a turn cancelled before this starts then leaves no unawaited coroutine."""
    try:
        return frame(name, await _stamped(sb, name, args, state, call_id, turn_start))
    except GuardError as e:
        return f"ERROR: {e}"

# A repeat of one of these calls, with nothing it reads changed since, is answered with a pointer to the earlier
# result instead of running again. Measured 2026-10-02 (an3.py): 6,821 of 178,766 tool results (3.8%) repeated an
# earlier identical call in the same leg, 35.8M chars that were re-sent as 238M (12.9% of the re-sent chars on NVIDIA).
_FILE_READS = frozenset({"read_file", "outline", "unfold"})  # one file: unchanged while its mtime and size are
# Many files: a new file or a write elsewhere changes the result without touching an earlier hit, so these are
# unchanged only while this sandbox has run nothing that can write since.
_WALKS = frozenset({"grep", "glob", "list_dir"})
_WRITES_NOTHING = _FILE_READS | _WALKS | {"fetch_output", "read_url", "web_search"}


def _repeat_key(sb: Sandbox, name: str, args: dict) -> tuple | None:
    """What makes two calls the same call over the same data, or None for a call that always runs."""
    if name not in _FILE_READS and name not in _WALKS:
        return None
    if name == "read_file" and args.get("paths"):
        return None  # several files: the key stats no one file, so a batch always runs
    key = (name, json.dumps(args, sort_keys=True, ensure_ascii=False, default=str))
    if name in _WALKS:
        return key
    try:
        p = sb.resolve(args.get("path"))
        if not isinstance(p, Path):
            return None  # a runtime's sandbox (remote_tools.py): the file is not on this disk to stat
        st = p.stat()
    except (OSError, ValueError, TypeError):
        return None  # the call itself reports what is wrong with the path
    return key + (st.st_mtime_ns, st.st_size)


def _earlier(sb: Sandbox, state: dict, key: tuple) -> str | None:
    """The pointer that answers a repeated call, or None when it has to run: never made before, its earlier result
    already swapped for a placeholder by the ContextEditor (`state["cleared"]`, set by agent._loop), or, for a tool
    that walks the tree, a call that can write made since."""
    seen = state.get("seen", {}).get(key)
    if seen is None:
        return None
    rid, call_id, since = seen
    if call_id in state.get("cleared", ()):
        return None
    if key[0] in _WALKS and any(r["tool"] not in _WRITES_NOTHING for r in sb.receipts[since:]):
        return None
    return (f"unchanged: same output as [{rid} {key[0]}] above. Nothing it reads has changed since, so the call was "
            f"not run again; cite [{rid} {key[0]}].")


async def _stamped(sb: Sandbox, name: str, args: dict, state: dict, call_id: str | None, turn_start: int) -> str:
    """One sandbox call, its output headed by the receipt id the worker is told to cite. A repeat that cannot return
    anything new is not run: it gets the pointer to its earlier receipt (_earlier)."""
    key = _repeat_key(sb, name, args)
    if key and (pointer := _earlier(sb, state, key)):
        return pointer
    rec, out = await sb.run_receipted(name, args)
    if key and rec["status"] == "ok":
        state.setdefault("seen", {})[key] = (rec["id"], call_id, turn_start)
    return receipts.stamp(rec, out)


def check_receipts(task: Task, res: Result, sb: Sandbox) -> None:
    """Stamp the ledger and both verdicts on a finished task. Only a task that finished ok claims anything;
    a tool-free task has no ledger, so no citation verdict."""
    res.receipts = list(sb.receipts)
    if res.status != "ok":
        return
    if uses_tools(task):
        res.citations = receipts.verify_citations(res.answer, sb.receipts, tool_names(task.tools))
    if task.green:
        res.green = receipts.evaluate_green(task.green, receipts.parse_green(res.answer, res.data), sb.receipts)
