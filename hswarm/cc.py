"""`cc` backend: a headless Claude Code process pointed at DeepSeek's Anthropic-compatible
endpoint (or Hugging Face's / OpenRouter's, when the task's route fails over to them, or a loopback
facade in front of an OpenAI-only provider such as gemini or groq: anthropic_facade.py). Full
Claude Code tooling (Read/Edit/Bash/Grep/Glob, project CLAUDE.md, hooks in the project) with
DeepSeek flash doing the thinking. Costs are computed from the serving path's rates, never from
the `total_cost_usd` Claude Code prints (it assumes Anthropic prices for an unrecognised model
and is ~1000x too high). Binary and environment: claude_env.py.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from . import config, result_hooks
from .client import key_limit_spent, spend_exhausted
from .acceptance import decide as decide_acceptance, prompt_clause
from .anthropic_facade import anthropic_endpoint
from .claude_env import cc_env, cc_model_id, claude_argv, claude_bin, ensure_cc_config  # noqa: F401 - claude_bin, ensure_cc_config re-exported for the installer
from .code_brief import system_for
from .procs import TIMEOUT_EXIT, run_hidden
from .spec import CC_WRITE_TIERS, Result, Task, add_spend, cc_tier, inline_files, now_iso

READ_ONLY_DISALLOWED = "Edit,Write,MultiEdit,NotebookEdit,Bash,PowerShell"
RESULT_FILE_DISALLOWED = "Edit,MultiEdit,NotebookEdit,Bash,PowerShell"
# A read-only worker fails CLOSED: under dontAsk every tool this list does not name is denied, where the
# denylist alone let through whatever it forgot (WebFetch, Agent, Workflow, a new MCP tool). dontAsk, not
# plan: measured against a local fake endpoint, plan mode sent each un-allowed call to an extra classifier
# model request (44 requests for a 2-tool turn against 4), and dontAsk denies it outright for free.
READ_ONLY_ALLOWED = "Read,Grep,Glob"
# `--tools`: the built-in tools a worker is HANDED. The permission flags only deny a call; Claude Code still sent
# every built-in schema plus the agent and skill listings on each request. Measured 2026-10-02 against a loopback
# sink (Claude Code 2.1.286): a read worker's first request was 65,757 chars (44,266 of them tool schemas) and
# 19,465 with `--tools Read,Grep,Glob`; edit 69,090 -> 18,829. Across 258 real cc runs the workers called only
# these (5,684 calls), plus Agent 3 times and ToolSearch twice.
WRITE_TOOLS = "Edit,Write,MultiEdit,NotebookEdit"
SHELL_TOOLS = "Bash,PowerShell"
EDIT_TOOLS = {"Edit": "file_path", "Write": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}
# Lines Claude Code prints on every run under this setup that explain nothing about a failure. They
# used to be the whole error message of a worker that simply ran out of turns.
_STDERR_NOISE = (re.compile(r"^Ignoring \d+ permissions\.allow entries"), re.compile(r"^\[claude-code:unrecognized_model\]"))


def _extract_json(text: str):
    """First JSON object in a reply (handles ```json fences and prose around it)."""
    m = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    cands = [m.group(1)] if m else []
    start = text.find("{")
    while start != -1 and len(cands) <= 8:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    cands.append(text[start : i + 1])
                    break
        start = text.find("{", start + 1)
    for c in cands:
        try:
            v = json.loads(c)
            if isinstance(v, dict):
                return v
        except ValueError:
            continue
    return None


def _prompt(task: Task) -> str:
    user = task.prompt.strip() + prompt_clause(task.acceptance)
    if task.result_file:
        # The hooks enforce this; saying it up front saves the worker a denied write to learn it.
        user += (f"\n\nResult file: write your result to {Path(task.result_file).as_posix()} with the Write tool. It is the ONLY "
                 "file you may write; any other write is denied. A hook checks it after every write and before you finish.")
        if task.schema:
            user += " It must hold ONE JSON value and nothing else, matching this JSON schema:\n" + json.dumps(task.schema, ensure_ascii=False)
    elif task.schema:
        # Claude Code has no submit_result tool, so the schema rides as an output contract and the reply is parsed.
        user += "\n\nOutput contract: your final message must be ONE JSON object and nothing else, matching this JSON schema:\n" + json.dumps(task.schema, ensure_ascii=False)
    return inline_files(task, user)


def _command(task: Task, hook_settings: Path | None = None) -> list[str]:
    # stream-json (with --verbose, which it requires) carries every tool call, so a worker's edits and
    # tool count come from what IT did - the plain json envelope has neither.
    cmd = [*claude_argv(), "-p", "--output-format", "stream-json", "--verbose", "--model", cc_model_id(task.model), "--max-turns", str(task.max_turns)]
    if task.reasoning_effort is not None:
        cmd += ["--effort", task.reasoning_effort]
    # No --max-budget-usd: Claude Code cannot price a DeepSeek model ("unrecognized_model") and bills it at its own
    # fallback rate, measured 2026-09-25 at ~63x the real bill ($0.253 vs $0.004 for one 26.7k-token turn), so a
    # DeepSeek-dollar cap stopped every full-context worker on the Connections checkout after 2 turns
    # (job 20260925-053205-45c1, 4 of 4). max_cost_usd is enforced in real dollars from the stream (_SpendWatch).
    tier = cc_tier(task.tools)
    # Bypassing permissions takes both opt-ins (spec validates them; this re-checks, so a Task built around
    # the validator still gets the read-only argv). Every other case, a comma list included, is read-only.
    if tier in CC_WRITE_TIERS and task.confirm_write is True:
        cmd += ["--dangerously-skip-permissions", "--tools", f"{READ_ONLY_ALLOWED},{WRITE_TOOLS}" + ("" if tier == "edit" else f",{SHELL_TOOLS}")]
        if tier == "edit":
            cmd += ["--disallowedTools", "Bash,PowerShell"]
    elif task.result_file:
        # A read-only worker with a result file keeps Write: the PreToolUse hook holds it to that one path.
        cmd += ["--permission-mode", "dontAsk", "--tools", READ_ONLY_ALLOWED + ",Write", "--allowedTools", READ_ONLY_ALLOWED + ",Write", "--disallowedTools", RESULT_FILE_DISALLOWED]
    elif tier == "none":
        # A tool-free task was asked to reason, so it gets no built-in tool schemas at all (`--tools ""`), and Read
        # only when the task attached files; idea from CopilotKit/OpenBot agent-claude-sdk/src/adapter.py:96-121 (MIT), 2026-10-03.
        allowed = "Read" if task.files else ""
        # The read-only denylist stays as the belt: an MCP tool or a future built-in is still not one it may call.
        cmd += ["--permission-mode", "dontAsk", "--tools", allowed, "--disallowedTools", READ_ONLY_DISALLOWED]
        if allowed:
            cmd += ["--allowedTools", allowed]
    else:
        cmd += ["--permission-mode", "dontAsk", "--tools", READ_ONLY_ALLOWED, "--allowedTools", READ_ONLY_ALLOWED, "--disallowedTools", READ_ONLY_DISALLOWED]
    # A `none` task is always lean: it was asked to reason, not to work in the folder, so the folder's house rules
    # cannot matter to it. `read` stays opt-in: a reviewer is exactly the task that judges code against them.
    if task.lean or task.isolated or tier == "none":
        # Measured 2026-09-24 from the Connections checkout against a local probe endpoint: the first request was
        # 138.7k chars with AGENTS.md in it; with `--setting-sources user` 84.6k, AGENTS.md, .claude/rules, the
        # project's hooks and settings gone, the worker's own CLAUDE.md and the user-level shield hook kept.
        # `--bare` (6.5k) was rejected: it drops the worker CLAUDE.md and the shield hook too. "user", not
        # "project,local": CLAUDE_CONFIG_DIR already keeps the operator's ~/.claude out, so "user" is the
        # worker's own config dir, and dropping it would drop the shield. Emitted once for lean and isolated.
        cmd += ["--setting-sources", "user"]
    if task.isolated:
        # isolated is lean plus no MCP server at all, so the task folder's .mcp.json servers cannot start either.
        cmd += ["--strict-mcp-config"]
    system = system_for(task)
    if system:
        cmd += ["--append-system-prompt", system]
    if hook_settings is not None:
        cmd += ["--settings", str(hook_settings)]
    return cmd


def _hook_dir(task: Task, stale_stamp: int | None = None) -> Path:
    """A private folder for one result-file task: the hooks' spec, the --settings file wiring them, and the
    log of every write the worker attempted. Removed after the run; the log rides on the transcript.
    `stale_stamp` is the result file's pre-launch result_hooks.file_stamp(), so the Stop hook refuses a leftover."""
    d = Path(tempfile.mkdtemp(prefix="hswarm-cc-result-"))
    spec = {"result_file": task.result_file, "schema": task.schema, "log": str(d / "writes.log"), "stale_stamp": stale_stamp}
    (d / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    (d / "settings.json").write_text(json.dumps(result_hooks.settings(d / "spec.json")), encoding="utf-8")
    return d


def read_result_file(res: Result, task: Task, stale_stamp: int | None = None) -> None:
    """Publish the result file through the same validate() the hooks ran: a valid file becomes res.data (the
    parsed JSON under a schema, the text otherwise); an invalid one turns an ok run into an error that names why.
    A file still carrying its pre-launch `stale_stamp` was not written by this run and counts as missing."""
    value, errors = result_hooks.validate(task.result_file, task.schema, stale_stamp)
    if errors:
        res.data = None  # with a result file the data comes from the file alone, never a JSON-looking reply
        if res.status == "ok":
            res.status, res.error = "error", "result file not publishable: " + "; ".join(errors)
        return
    res.data = value


def _usage(u: dict) -> dict:
    """Claude Code's usage envelope as the ledger's four counters (Anthropic-shaped fields)."""
    inp, hit = int(u.get("input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0)
    write = int(u.get("cache_creation_input_tokens") or 0)
    miss = (inp - hit if inp >= hit else inp) + write
    out = {"in_hit": hit, "in_miss": miss, "out": int(u.get("output_tokens") or 0), "reasoning": int((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0)}
    if write:  # priced at the model's cache-write rate, not as plain input (config.cost_usd)
        out["in_write"] = write
    return out


class _SpendWatch:
    """run_hidden's `on_line` for one cc run: totals the usage each model call reports in the stream, at the
    serving path's rates, and stops the worker once that reaches max_cost_usd. Nothing enforced the cap on cc
    before: over 30 days 23 cc tasks overran theirs by $11.04 in total, the worst $1.99 on a $0.25 cap in 57 turns
    (job 20260930-225738-5b55), 11 of them on OpenRouter, so it reads the stream, which every provider's run has.
    It trips only on a message that calls a tool, which is the next request it prevents: a final answer that
    crosses the cap is already paid for and is kept. The first stop comes at checkpoint_at of the cap, where the
    api worker is asked to wrap up (budget.py); run_cc_task then raises `limit` to the whole cap for the wrap-up."""

    def __init__(self, task: Task):
        self.task, self.calls, self.chars, self.tripped = task, {}, {}, False
        self.limit = (task.max_cost_usd or 0.0) * (task.checkpoint_at or 1.0)

    def spent(self) -> tuple[dict, float | None]:
        usage: dict = {}
        for call in self.calls.values():
            for k, v in call.items():
                usage[k] = usage.get(k, 0) + v
        return usage, config.cost_usd(self.task.model, usage.get("in_hit", 0), usage.get("in_miss", 0), usage.get("out", 0), write=usage.get("in_write", 0))

    def __call__(self, line: str) -> bool:
        try:
            ev = json.loads(line) if line.startswith("{") else None
            msg = ev.get("message") if isinstance(ev, dict) and ev.get("type") == "assistant" else None
            if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                return False
            # One model call arrives as one event per content block, each repeating the call's usage: count it once.
            mid = str(msg.get("id") or len(self.calls))
            call = _usage(msg["usage"])
            # The usage on these events is the one the call opened with (message_start): the prompt is counted but the
            # output is a placeholder, and the final count only comes with the result event. So the output is never
            # taken below chars/4 of what the call wrote, or an Opus worker's writing ($25/M) went unpriced.
            self.chars[mid] = self.chars.get(mid, 0) + len(json.dumps(msg.get("content") or [], ensure_ascii=False))
            call["out"] = max(call["out"], self.chars[mid] // 4)
            self.calls[mid] = call
            cost = self.spent()[1]
            self.tripped = bool(_tool_uses(ev)) and cost is not None and cost >= self.limit
        except (ValueError, TypeError, AttributeError):
            return False  # an unreadable line is skipped, as _events skips it
        return self.tripped


def _parse_stream(out: str) -> tuple[dict | None, int, list[str]]:
    """Claude Code's stream-json: the final `result` event (the same fields the json envelope has), the
    number of tool calls, and every path an edit tool was pointed at, in order. Unparseable lines skip."""
    final, tool_calls, edited = None, 0, []
    for ev in _events(out):
        if ev.get("type") == "result":
            final = ev
        for block in _tool_uses(ev):
            tool_calls += 1
            key = EDIT_TOOLS.get(block.get("name"))
            path = (block.get("input") or {}).get(key) if key else None
            if path:
                edited.append(str(path))
    return final, tool_calls, edited


def _events(out: str):
    """Each JSON event line of a stream-json run; unparseable lines skip."""
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def _tool_uses(ev: dict) -> list[dict]:
    if ev.get("type") != "assistant":
        return []
    return [b for b in (ev.get("message") or {}).get("content") or [] if isinstance(b, dict) and b.get("type") == "tool_use"]


TRACE_INPUT_CHARS = 300


def tool_trace(out: str) -> list[dict]:
    """Every tool call a worker made, in order, as {tool, input} with the input cut to a readable line.
    WHY: `hswarm comply` grades whether a rule was obeyed by what the worker DID, and a call count alone
    cannot say whether the test ran before the commit."""
    return [{"tool": str(b.get("name") or ""), "input": json.dumps(b.get("input") or {}, ensure_ascii=False)[:TRACE_INPUT_CHARS]}
            for ev in _events(out) for b in _tool_uses(ev)]


def _relative_paths(paths: list[str], cwd: str) -> list[str]:
    """Sorted, de-duplicated, forward-slashed; repo-relative when under the task dir, as given otherwise."""
    root = Path(cwd).resolve()
    out = set()
    for p in paths:
        try:
            out.add(Path(p).resolve().relative_to(root).as_posix())
        except ValueError:
            out.add(Path(p).as_posix())
    return sorted(out)


def _meaningful_stderr(err: str) -> str:
    return "\n".join(line for line in err.splitlines() if line.strip() and not any(rx.search(line) for rx in _STDERR_NOISE))


def trust_project(cwd: str) -> None:
    """Mark the task folder trusted in the WORKER's own config dir (never the operator's), so Claude Code
    stops warning that it is ignoring the project's permission list. Write-tier workers already run with
    permissions bypassed. A read-only worker's denylist outranks a project allow rule for the edit and shell
    tools, but a trusted project's allow rule for some other tool does widen it: `isolated` drops project
    settings for a worker that must not inherit them. Concurrent workers may race the write - each
    writes the same key, and the replace is atomic, so a lost update only costs one repeat warning."""
    d = config.CC_CONFIG_DIR
    d.mkdir(parents=True, exist_ok=True)
    p = d / ".claude.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except ValueError:
        data = {}
    data.setdefault("hasCompletedOnboarding", True)
    key = str(Path(cwd)).replace("\\", "/")
    proj = data.setdefault("projects", {}).setdefault(key, {})
    if proj.get("hasTrustDialogAccepted") is True:
        return
    proj["hasTrustDialogAccepted"] = True
    tmp = d / f".claude.json.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _failure_reason(task: Task, res: Result, subtype: str, code: int, err: str) -> str:
    """Why a failed run failed: the turn cap by name, else the worker's own answer, else the exit and stderr."""
    if subtype == "error_max_turns":
        return f"stopped at max_turns={task.max_turns} after {res.turns} turns with no final answer; raise max_turns or split the task"
    if res.answer:
        return res.answer
    why = _meaningful_stderr(err)[-500:]
    return f"claude exit {code}" + (f" ({subtype})" if subtype and subtype != "success" else "") + (f": {why}" if why else "")


def _read_reply(res: Result, task: Task, j: dict, code: int, err: str) -> None:
    """Fill the Result from Claude Code's final result event: usage at DeepSeek rates, answer, status."""
    res.usage = _usage(j.get("usage") or {})
    res.cost_usd = config.cost_usd(task.model, res.usage["in_hit"], res.usage["in_miss"], res.usage["out"], write=res.usage.get("in_write", 0))
    res.turns = int(j.get("num_turns") or 0)
    res.answer = str(j.get("result") or "").strip()
    res.data = _extract_json(res.answer) if task.schema and res.answer else None
    if res.data is not None and not (res.answer.startswith("{") and res.answer.endswith("}")):
        res.add_taint("S")  # the contract asked for ONE JSON object and nothing else; this one was dug out of prose or a fence
    failed = j.get("is_error") or code != 0
    res.status = "error" if (failed or res.answer.startswith("FAILED:")) else "ok"
    if failed:
        res.error = _failure_reason(task, res, str(j.get("subtype") or ""), code, err)
    elif res.status == "error":
        res.error = res.answer


OUT_OF_BALANCE_SIGNATURE = "api error: 402"  # Claude Code's own rendering of the provider's 402, on every path that reaches res.error


def out_of_balance(res: Result) -> bool:
    """A cc run that died because its key had no balance. Claude Code renders the provider's 402 as the run's
    error, "API Error: 402 Insufficient Balance" (seen five times on 2026-09-16), and that literal is the whole
    signature: the ERROR is read and nothing else, a worker's own answer is never the run's death, and a looser
    match (a 402 anywhere near the word balance) took a failed worker's text about a payment gateway for the
    provider's verdict. A task that failed for its own reasons ("FAILED: ...") is not it either. OpenRouter's
    403 "Key limit exceeded" is the same death: the key spent its own spending limit (two tasks of one
    2026-09-28 job died on one such key, mid-work, and the key stayed in rotation). So are the spent-key 400s
    the api client disables on (client.spend_exhausted: Anthropic's usage limit and empty credit, groq's spend alert)."""
    if res.status != "error" or not res.error:
        return False
    text = res.error.lower()
    return (OUT_OF_BALANCE_SIGNATURE in text or key_limit_spent(text) or spend_exhausted(text)) and not text.startswith("failed:")


def key_revoked(res: Result) -> bool:
    """A cc run that died because the provider REFUSED its key before any work: Claude Code renders a 401/403 as
    the run's error, "Failed to authenticate. API Error: 401 User not found." (all five tasks of one 2026-09-28
    job, on one OpenRouter key, with no retry on another). Read like out_of_balance: the ERROR only, never the
    worker's answer, and only for a run that made no tool call - a worker that got going and then failed is not
    a verdict on its key."""
    if res.status != "error" or not res.error or res.tool_calls:
        return False
    text = res.error.lower()
    return not text.startswith("failed:") and ("failed to authenticate" in text or re.search(r"api error: 40[13]\b", text) is not None)


# A key that dies mid-run no longer costs the run its work. Each fresh run is given its own session id, so Claude
# Code keeps its conversation in the worker's config dir (projects/<cwd slug>/<id>.jsonl), and the run on the next
# key passes `--resume <id>`: Claude Code continues that conversation, under the same id, on whatever key the new
# process holds. The tool calls and edits before the failed call stand, where a restart from the prompt redid them
# on a tree the dead run had half-edited. Only the key changes: the same provider, model and endpoint get the same
# conversation, so nothing in it (a provider's thinking signatures) meets a host that did not write it.
RESUME_PROMPT = ("Your run was cut off mid-task when the API key it ran on stopped working; another key has taken over "
                 "and there is nothing about it for you to do. The conversation above is intact and every edit you made "
                 "is on disk. Carry on from where you stopped, do not redo finished steps, and end with the final answer "
                 "the task asks for.")


# A worker stopped at checkpoint_at of its cost cap is not left with no answer: its session is resumed once with
# this prompt and a few turns, still under the whole cap. WHY: an unnamed cap is $0.25, and a hard stop there ended
# an Opus edit task that used to finish at $0.30-$2.00 as an error with no answer and a tool call cut off mid-way.
WRAP_UP_PROMPT = ("Budget checkpoint: you were stopped because this task has used most of its spending budget, and the tool "
                  "call you had just made may not have run. Finish only the step you were on and start nothing new. Give "
                  "your final answer now from what you have; if work remains, end it with up to 3 lines 'REMAINING: <item>' "
                  "so the orchestrator can pick it up.")
WRAP_UP_TURNS = 3


def saved_session(session_id: str | None) -> bool:
    """True when the worker's config dir holds the conversation `--resume session_id` would continue."""
    try:
        uuid.UUID(str(session_id))
    except ValueError:
        return False
    return any((config.CC_CONFIG_DIR / "projects").glob(f"*/{session_id}.jsonl"))


def edited_note(files: list[str]) -> str:
    """What a run starting from the prompt is told when runs before it died mid-work (a session that was not
    saved, or a provider switch, which cannot carry one): the files they edited, on disk as they left them, so it
    builds on those edits instead of making them again."""
    if not files:
        return ""
    return ("\n\nEarlier runs of this task died mid-work and already edited these files, which are on disk as they "
            "left them: " + ", ".join(files) + ". Read them before you change them, keep what is done, and do only "
            "the work that is still unfinished.")


def _finish_result(res: Result, task: Task, j: dict, out: str, code: int, err: str, checkpoint: list[dict],
                   tool_calls: list, edited: list, prior: list, transcript: dict, stale_stamp: int | None) -> None:
    """Fill `res` from the run's result event."""
    transcript["json"] = {k: v for k, v in j.items() if k != "result"}
    transcript["tool_trace"] = tool_trace(out)
    _read_reply(res, task, j, code, err)
    add_spend(res, checkpoint)
    _note_failed_wrap_up(res, task, checkpoint)
    res.tool_calls = tool_calls
    # Only what THIS worker's edit tools touched. A git diff of the task dir credited every peer's edit
    # on a shared checkout to the worker; edits made through Bash are not visible here, and say so.
    res.files_changed = sorted({*prior, *_relative_paths(edited, task.cwd)})
    if task.result_file:
        read_result_file(res, task, stale_stamp)


async def _wrap_up(task: Task, watch: "_SpendWatch", session: str, settings: Path | None, env: dict, t0: float, transcript: dict) -> tuple:
    """Resume a run stopped at its cost checkpoint for a wrap-up turn. The same argv but for the turn count, so the
    resumed conversation meets the same tools and system prompt and stays in the provider's prompt cache. Its stream
    follows the stopped run's: the calls and edits are counted across both, and the result event is the wrap-up's."""
    usage, cost = watch.spent()
    checkpoint = [{"cost_usd": cost, "usage": usage, "turns": len(watch.calls)}]
    transcript["cost_checkpoint"] = checkpoint[0]
    watch.limit, watch.tripped = task.max_cost_usd, False
    cmd = [*_command(dataclasses.replace(task, max_turns=WRAP_UP_TURNS), settings), "--resume", session]
    code, more, err = await run_hidden(cmd, task.cwd, max(1.0, task.timeout_s - (time.perf_counter() - t0)), env=env,
                                       stdin_text=WRAP_UP_PROMPT, on_line=watch)
    return checkpoint, cmd, code, more, err


def _drop_hook_dir(hook_dir: Path | None, transcript: dict) -> None:
    """Keep the result-file hook's write log in the transcript, then remove its scratch dir."""
    if hook_dir is None:
        return
    log = hook_dir / "writes.log"
    transcript["result_file_writes"] = log.read_text(encoding="utf-8").splitlines()[-200:] if log.exists() else []
    shutil.rmtree(hook_dir, ignore_errors=True)


def _decide_cc_acceptance(res: Result, task: Task) -> None:
    """File leaves are decided against the task dir as for api. Claude Code's Bash calls leave no receipt with
    an exit code here, so tests_passed stays UNVERIFIED (runs=None) rather than read off the worker's prose."""
    if not task.acceptance:
        return
    try:
        from .tools import Sandbox  # a path resolver only; cc.py otherwise never builds the api sandbox
        res.acceptance = decide_acceptance(task.acceptance, Sandbox(task.cwd, roots=task.roots or None), res.files_changed, None)
    except Exception as e:  # noqa: BLE001 - a checker bug leaves every criterion UNVERIFIED, never the result lost
        res.acceptance = [{"criterion": c, "verdict": "UNVERIFIED", "detail": f"checker error {type(e).__name__}: {e}"} for c in task.acceptance]


def _stream_or_envelope(out: str) -> tuple[dict | None, list, list]:
    """`_parse_stream`, falling back to one JSON envelope for a CLI that ignored stream-json (None when neither parses)."""
    j, tool_calls, edited = _parse_stream(out)
    if j is None:
        try:
            j = json.loads(out)
        except ValueError:
            pass
    return j, tool_calls, edited


def _record_cap_stop(res: Result, task: Task, watch: "_SpendWatch", out: str, prior: list, transcript: dict) -> None:
    """A run stopped at the cost cap has no result event: the spend, the calls and the edits are what the stream showed."""
    _, res.tool_calls, edited = _parse_stream(out)
    transcript["tool_trace"] = tool_trace(out)
    res.usage, res.cost_usd = watch.spent()
    res.turns = len(watch.calls)
    res.files_changed = sorted({*prior, *_relative_paths(edited, task.cwd)})
    res.status = "error"
    res.error = (f"cost budget exceeded: ${res.cost_usd or 0:.4f} of ${task.max_cost_usd:.4f} spent after {res.turns} model calls; the worker was "
                 "stopped with no final answer, and its edits so far are on disk (raise max_cost_usd or split the task)")


def _note_failed_wrap_up(res: Result, task: Task, checkpoint: list[dict]) -> None:
    if checkpoint and res.status == "error":
        res.error = (f"cost budget exceeded: ${res.cost_usd or 0:.4f} of ${task.max_cost_usd:.4f} spent, and the wrap-up run gave no "
                     f"answer ({res.error}); its edits so far are on disk (raise max_cost_usd or split the task)")


async def run_cc_task(task: Task, api_key: str, after: dict | None = None) -> tuple[Result, dict]:
    """One Claude Code process on `api_key`. `after` is what the runs before it that died mid-work left
    (JobManager._run_cc_with_rotation): `session_id`, the conversation to resume when it was saved, and
    `files_changed`, told to a run that starts from the prompt instead (edited_note). Either way those files
    count as this run's too: the task changed them, and acceptance decides on them."""
    after = after or {}
    prior = list(after.get("files_changed") or [])
    resumed = after.get("session_id") if saved_session(after.get("session_id")) else None
    session = resumed or str(uuid.uuid4())
    res = Result(id=task.id, backend="cc", model=task.model, started=now_iso(), files_changed=prior)
    t0 = time.perf_counter()
    transcript: dict = {"session_id": session, **({"resumed": True} if resumed else {})}
    hook_dir: Path | None = None
    stale_stamp: int | None = None
    try:
        if task.result_file:
            # Inside the try: a tempfile failure comes back as an error Result, not an exception out of here.
            stale_stamp = result_hooks.file_stamp(task.result_file)
            hook_dir = _hook_dir(task, stale_stamp)
        settings = hook_dir / "settings.json" if hook_dir else None
        cmd = [*_command(task, settings), *(("--resume", session) if resumed else ("--session-id", session))]
        trust_project(task.cwd)
        watch = _SpendWatch(task)
        checkpoint: list[dict] = []  # the spend of a run stopped at its cost checkpoint, when a wrap-up run followed it
        # An OpenAI-only provider gets a loopback Anthropic facade for exactly this one Claude Code process.
        async with anthropic_endpoint(config.provider_of(task.model)) as base_url:
            env = cc_env(api_key, task.model, envelope=task.envelope, anthropic_url=base_url)
            code, out, err = await run_hidden(cmd, task.cwd, task.timeout_s, env=env,
                                              stdin_text=RESUME_PROMPT if resumed else _prompt(task) + edited_note(prior),
                                              on_line=watch if task.max_cost_usd else None)
            if watch.tripped and task.checkpoint_at and saved_session(session):
                checkpoint, cmd, code, more, err = await _wrap_up(task, watch, session, settings, env, t0, transcript)
                out += more
        err, out = err.replace(api_key, "sk-***"), out.replace(api_key, "sk-***")
        transcript.update(cmd=cmd, exit=code, stderr=err[-4000:])
        if watch.tripped or (checkpoint and _parse_stream(out)[0] is None):
            # Stopped at the cap (or the wrap-up died), so there is no result event: the spend, the calls and the edits are what the stream showed.
            _record_cap_stop(res, task, watch, out, prior, transcript)
            return res, transcript
        if code == TIMEOUT_EXIT and not out:
            res.status, res.error = "timeout", f"claude exceeded {task.timeout_s}s"
            return res, transcript
        j, tool_calls, edited = _stream_or_envelope(out)
        if j is None:
            res.status, res.error = "error", f"claude exit {code}, no result event: {out[-800:]!r} stderr: {_meaningful_stderr(err)[-800:]!r}"
            return res, transcript
        _finish_result(res, task, j, out, code, err, checkpoint, tool_calls, edited, prior, transcript, stale_stamp)
    except asyncio.CancelledError:
        res.status, res.error = "cancelled", "cancelled"
        raise
    except Exception as e:  # noqa: BLE001
        res.status, res.error = "error", f"{type(e).__name__}: {e}"
    finally:
        _drop_hook_dir(hook_dir, transcript)
        res.seconds = round(time.perf_counter() - t0, 3)
        _decide_cc_acceptance(res, task)
        res.finished = now_iso()
    return res, transcript
