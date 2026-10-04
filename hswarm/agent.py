# Idea adapted from whirlchat/whirl replyRepair.ts (MIT); written fresh.
"""`api` backend: a tool-using worker loop straight on DeepSeek chat completions.

One coroutine per task, no threads. Thinking mode stays on (DeepSeek's default) and
`reasoning_content` from earlier assistant turns is passed back verbatim, which the API
requires whenever `tools` are present. The prompt contract and per-turn helpers are in
worker.py; this module is the loop, the budgets and the single-call `ask`.
"""
from __future__ import annotations

import asyncio
import base64
import contextvars
import json
import time
import traceback
from pathlib import Path

from . import capability, config, goal, plans, redaction, selection, survival, toolhooks
from .acceptance import decide as decide_acceptance
from .budget import CACHE_LIVE_S, Budget, checkpoint_due, checkpoint_text, plan_turn, release, settle_turn, status_line, top_rates, worst_turn_usd
from .capability import Capability
from .client import RATE_WAIT, ApiError, ChatResult, DeepSeekClient, Usage
from .guard import with_charter
from .leggate import wait_for_pilot
from .loopguard import LoopGuard
from .spec import Result, Task, add_spend, now_iso
from .context import ContextEditor
from .toolcall_repair import promote_text_tool_calls
from .tools import Sandbox, specs_for
from .tools import open_sandbox  # the task's runtime picks host or isolate (runtimes.py)
from .toolspecs import SPILL_TOOL
from .worker import EMPTY_NUDGE, EMPTY_RETRIES, NUDGE, SCHEMA_REJECTS, build_messages, check_receipts, final_text, over_budget, partial_evidence, run_tools, schema_errors, submit_result_spec  # noqa: F401 - build_messages/submit_result_spec re-exported
from .worker import SCHEMA_TEXT_NUDGE, SCHEMA_TEXT_RETRIES, payload_in_text, schema_repaired


# The spend of the job task this coroutine runs under, turn by turn (set by jobs._run_one). A cancelled task's Result
# never comes back, so until 2026-10-02 its paid turns were journaled at $0 (11,302 cancelled rows in 7 days).
LIVE_SPEND: contextvars.ContextVar[Result | None] = contextvars.ContextVar("hswarm_live_spend", default=None)
# The job's own row for that task (job.results[id], set by jobs._run_one): each reply stamps its progress_at, which
# status reads for quiet_running (job.quiet_seconds). Until 2026-10-03 only the leg's own Result was stamped, so every
# task running past config.QUIET_TASK_S read as quiet however often it answered, and an orchestrating chat cancelled
# a healthy 7-task job (20261003-002117-1fa4, 5-9 replies a task) at 374 s on it.
LIVE_ROW: contextvars.ContextVar[Result | None] = contextvars.ContextVar("hswarm_live_row", default=None)


class _GoalGate:
    """A task's `done_when`, checked where the worker stops (goal.py says why). The evaluator is a separate tool-free
    call on the task's own model and client, with a fresh context; its spend lands on the task like any turn's."""

    def __init__(self, client: DeepSeekClient, task: Task, usage: Usage, user_tag: str | None) -> None:
        self.client, self.task, self.usage, self.user_tag = client, task, usage, user_tag
        self.checks = self.blocked = 0

    async def _judge(self, res: Result, transcript: list[dict], answer: str) -> tuple[str, str]:
        try:
            r = await self.client.chat(
                goal.evaluator_messages(self.task.done_when or "", self.task.prompt, transcript, answer), model=self.task.model,
                tools=[submit_result_spec(goal.SCHEMA)], tool_choice="required", max_tokens=4_000, thinking=False, user=self.user_tag, zdr=self.task.zdr,
            )
        except Exception as e:  # noqa: BLE001 - an evaluator that fails hands the answer back unchecked, never loses it
            return "unchecked", f"evaluator failed: {type(e).__name__}: {e}"
        self.usage.add(r.usage)
        _note_upstream(res, r)
        res.cost_usd = None if r.cost_usd is None else (res.cost_usd or 0.0) + r.cost_usd  # the same rule as a worker turn
        try:
            return goal.read_verdict(r.tool_calls, r.content)
        except ValueError as e:
            return "unchecked", f"evaluator failed: {e}"

    async def nudge(self, res: Result, transcript: list[dict], answer: str, last: bool) -> str | None:
        """Check the claimed answer. Returns the user turn that sends the worker back, or None when the task ends
        here (res.goal then holds the verdict for settle). A block on the last turn, or past the cap, ends it."""
        verdict, reason = await self._judge(res, transcript, answer)
        self.checks += 1
        self.blocked += verdict == "block"
        res.goal = {"verdict": verdict, "reason": reason, "checks": self.checks, "blocks": self.blocked}
        if verdict != "block" or last or self.blocked > self.task.done_when_max_blocks:
            return None
        return goal.block_nudge(self.task.done_when or "", reason, self.blocked, self.task.done_when_max_blocks)

    @staticmethod
    def settle(res: Result) -> None:
        """A final verdict of impossible, or a block the worker never got past, makes the task an error; the answer stays."""
        g = res.goal or {}
        if g.get("verdict") == "impossible":
            res.status, res.error = "error", f"goal impossible: {g.get('reason')}"
        elif g.get("verdict") == "block":
            res.status, res.error = "error", f"goal not met after {g.get('checks')} checks: {g.get('reason')}"


async def _after_reply(task: Task, res: Result, sb: Sandbox, messages: list[dict], r: ChatResult, empty_retries: int,
                       schema_state: dict | None = None, guard: LoopGuard | None = None,
                       gate: _GoalGate | None = None, last: bool = False, avoid: list[str] | None = None) -> tuple[bool, int]:
    """Handle one assistant reply: budgets, an empty turn, a final text, or a round of tool calls. Returns (done, empty_retries).
    With a goal gate, a final answer (text or submit_result) must pass the done_when check before the task ends."""
    if over_budget(res, task, r):
        return True, empty_retries
    if not r.tool_calls:
        if not r.content.strip() and empty_retries < EMPTY_RETRIES:
            _say(messages, EMPTY_NUDGE)  # the empty reply was not kept, so this joins the turn's own user message
            res.add_taint("R")
            who = (r.raw or {}).get("provider")
            if avoid is not None and who and str(who) not in avoid:
                avoid.append(str(who))  # an empty reply is usually one bad upstream host: the retry goes round it
            return False, empty_retries + 1
        prior = res.status
        final_text(res, r)
        if task.schema and res.status == "ok":
            # A schema task is not done on text: take a conforming payload written as text, else send the worker back
            # to submit_result, else fail the leg over (InvalidStructuredAnswer), never an ok with no data.
            payload = payload_in_text(res.answer, task.schema)
            if payload is not None:
                res.data, res.answer = payload, json.dumps(payload, ensure_ascii=False)
                res.add_taint("S")
            elif not last and (schema_state or {}).get("text", 0) < SCHEMA_TEXT_RETRIES:
                if schema_state is not None:
                    schema_state["text"] = schema_state.get("text", 0) + 1
                res.status, res.answer = prior, ""
                messages.append({"role": "user", "content": SCHEMA_TEXT_NUDGE})
                return False, empty_retries
            else:
                res.status = "error"
                res.error = f"InvalidStructuredAnswer: {task.model} answered in plain text instead of submit_result"
                if last:
                    # The turn budget ending, not a leg that cannot produce the structure: all 75 InvalidStructuredAnswer
                    # tasks of 30 days ended at exactly max_turns+1, and a pinned route then ran another leg on them.
                    res.error = f"turn budget exhausted without a final answer: {task.model} answered in plain text instead of submit_result"
                return True, empty_retries
        held = await _stop_hooks(sb, res.answer, last) if res.status == "ok" else None
        if held:
            res.status, res.answer = prior, ""  # not an answer yet, as with the goal gate below
            messages.append({"role": "user", "content": held})
            return False, empty_retries
        if gate is not None and res.status == "ok":
            nudge = await gate.nudge(res, messages, res.answer, last)
            if nudge:
                res.status, res.answer = prior, ""  # not an answer yet: a timeout from here hands back the partial evidence
                messages.append({"role": "user", "content": nudge})
                return False, empty_retries
            gate.settle(res)
        return True, empty_retries
    schema_state = schema_state if schema_state is not None else {}
    outputs, submitted = await run_tools(sb, r.tool_calls, task.schema, schema_state, inventory=task.inventory)
    if schema_repaired(outputs):
        res.add_taint("S")
    stop = None
    if guard is not None:
        # A worker repeating itself is told so in the tool result it is reading; one whose repeats return
        # nothing new is stopped here rather than left to burn its turns (loopguard.py).
        outputs, stop = guard.review(r.tool_calls, outputs)
        res.loop_warnings = guard.warnings
    replies = [{"role": "tool", "tool_call_id": tc.get("id"), "content": out} for tc, out in zip(r.tool_calls, outputs)]
    nudge = None
    if submitted is not None and gate is not None:
        nudge = await gate.nudge(res, messages + replies, json.dumps(submitted, ensure_ascii=False), last)
        for tc, m in zip(r.tool_calls, replies):
            if nudge and (tc.get("function") or {}).get("name") == "submit_result":
                m["content"] = "ERROR: submit_result rejected by the goal check. " + nudge
    if submitted is not None and not nudge:
        nudge = await _stop_hooks(sb, json.dumps(submitted, ensure_ascii=False), last)
        for tc, m in zip(r.tool_calls, replies):
            if nudge and (tc.get("function") or {}).get("name") == "submit_result":
                m["content"] = "ERROR: submit_result held back. " + nudge
    messages.extend(replies)
    if submitted is None or nudge:
        if schema_state.get("invalid", 0) >= SCHEMA_REJECTS:
            # This leg cannot produce the structure asked for: an error the route fails over on (jobs._UNAVAILABLE),
            # never an ok carrying a payload that breaks the schema.
            res.status = "error"
            res.error = (f"InvalidStructuredAnswer: {task.model} submitted {schema_state['invalid']} results that break "
                         f"the schema; last: " + "; ".join(schema_state.get("last_errors") or [])[:400])
            return True, empty_retries
        if stop is not None:
            res.status, res.error, res.loop = "loop", stop.error, stop.detector
            return True, empty_retries
        return False, empty_retries
    # submit_result carries the structured answer; `summary` doubles as the human-readable one when present.
    res.data = submitted
    res.answer = submitted.get("summary") if isinstance(submitted.get("summary"), str) else json.dumps(submitted, ensure_ascii=False)
    res.status = "ok"
    if gate is not None:
        gate.settle(res)
    return True, empty_retries


async def _stop_hooks(sb: Sandbox, answer: str, last: bool) -> str | None:
    """The user turn that sends the worker back when a Claude Code Stop hook (toolhooks.py) refuses its answer, else None.
    Never on the last turn, where continuing would throw the answer away for "turn budget exhausted"."""
    if sb.hooks is None or last or not answer.strip():
        return None
    reason = await sb.hooks.stop(answer)
    reason = sb.redacted("Stop hook", reason) if reason else reason  # it goes to the provider like any tool output
    return f"A Stop hook did not accept that as finished: {reason}\nAddress it, then give your final answer." if reason else None


# worker.NUDGE for a schema task, whose last turn is sent with submit_result alone (_call_turn).
SCHEMA_NUDGE = "Turn budget exhausted. Call submit_result now with the best result you can give from what you have gathered. Call no other tool."


async def _loop(client: DeepSeekClient, task: Task, res: Result, sb: Sandbox, messages: list[dict], tools: list[dict], usage: Usage, warm: asyncio.Event | None, is_pilot: bool, user_tag: str | None, slow_turn_s: float | None = None, job_budget: Budget | None = None, escape=None) -> None:
    budget = _TurnBudget(task, job_budget)  # first: its clock is the one timeout_s runs on, the wait for the pilot included
    if warm is not None and not is_pilot:
        await wait_for_pilot(warm)  # the pilot's first reply lands the shared prefix in DeepSeek's cache; everyone else reads it
    empty_retries = 0
    avoid: list[str] = []  # upstream hosts that served an empty reply to this task (see _after_reply)
    schema_state: dict = {}
    guard = LoopGuard()
    # Stale tool results past the task's token trigger go out as fetch_output pointers; `messages` stays the whole transcript.
    editor = ContextEditor.for_leg(task, spill=sb.spill)
    schema_state["cleared"] = editor.cleared  # run_tools runs a repeated call again once its earlier result was cleared
    gate = _GoalGate(client, task, usage, user_tag) if task.done_when else None
    for turn in range(task.max_turns + 1):
        exhausted = turn >= task.max_turns
        if exhausted:
            messages.append({"role": "user", "content": SCHEMA_NUDGE if task.schema else NUDGE})
            res.add_taint("B")
        else:
            budget.note(task, messages, turn, editor.view(messages), tools, editor.passes)
        r = await _call_turn(client, task, res, editor, messages, tools, budget, exhausted, user_tag, slow_turn_s, escape, avoid)
        if r is None:
            return
        _account_turn(task, res, r, usage, warm, is_pilot, slow_turn_s, tools, exhausted, escape)
        if r.tool_calls or r.content.strip():
            messages.append({"role": "assistant", **r.message})
        # An empty reply is never sent back: it carries nothing, and a choice with no message at all read as `{}`, a
        # message with no role. 2026-09-27, jobs 20260927-211430-8b33 and -214105-1b87: gemini-3-8-flash answered one
        # turn with no message, the loop appended `{}` ahead of its empty-answer nudge, and the next call died on
        # gemini 400 INVALID_ARGUMENT ("Request contains an invalid argument"), taking the task's turns with it.
        done, empty_retries = await _after_reply(task, res, sb, messages, r, empty_retries, schema_state, guard, gate, exhausted, avoid)
        if done:
            return
    res.status, res.error = "error", "turn budget exhausted without a final answer"


class _TurnBudget:
    """The worker's own cap and the job's are reserved against BEFORE each turn goes out, and settled to the exact
    cost after it (budget.py): a turn that would cross either is shrunk or never sent, instead of found out later."""

    def __init__(self, task: Task, job_budget: Budget | None) -> None:
        self.worker = Budget(task.max_cost_usd, "cost budget (max_cost_usd)") if task.max_cost_usd else None
        self.job_budget = job_budget
        self.ceilings = [b for b in (self.worker, job_budget) if b is not None]
        self.priced = top_rates(task.model) is not None
        self.checkpointed = False
        self.started = time.monotonic()
        # Only a sticky_keys provider keeps a task on one key (ChatClient._pick); any other pool round-robins, and
        # the next turn's key may hold none of the prefix the last one reported.
        self.sticky = self.priced and bool(config.PROVIDERS[config.provider_of(task.model)].get("sticky_keys"))
        # The prompt-cache tokens the last reply reported, when it landed, and the clearing passes made by then.
        self.cached, self.replied, self.passes = 0, 0.0, 0

    def seen(self, r: ChatResult, passes: int) -> None:
        self.cached, self.replied, self.passes = r.usage.hit + r.usage.write, time.monotonic(), passes

    def cached_tokens(self, passes: int) -> int:
        """What the next reservation may price at the cache-hit rate: the last reply's cached tokens, while the next
        turn will read that same cache. That needs a provider that keeps the task on one key (sticky_keys), a cache
        still live, and no clearing pass since (`passes`, ContextEditor.passes: a pass rewrites old tool results,
        so the prefix misses from the first one on). Otherwise 0, and the whole prompt is held at the top rate."""
        if not self.sticky or passes != self.passes:
            return 0
        return self.cached if time.monotonic() - self.replied < CACHE_LIVE_S else 0

    def note(self, task: Task, messages: list[dict], turn: int, sent: list[dict], tools: list[dict], passes: int) -> None:
        """What a turn that is not the last tells the worker: what it has left when there is a priced ceiling to
        report, and once (_due) the request to wrap up. `sent` is the view of `messages` the turn will send, and
        `passes` the editor's clearing passes once that view was made. The note
        rides at the tail, joined to a user message this turn already added, so no earlier byte changes and no two
        user messages sit back to back."""
        if not turn:
            return
        metered = bool(self.ceilings) and self.priced
        lines = [status_line(self.worker, turn, task.max_turns, self.job_budget)] if metered else []
        due = None if self.checkpointed else self._due(task, sent, tools, metered, passes)
        if due is not None:
            lines.append(checkpoint_text(due[0], bool(task.schema), due[1]))
            self.checkpointed = True
        if lines:
            _say(messages, "\n".join(lines))

    def _due(self, task: Task, sent: list[dict], tools: list[dict], metered: bool, passes: int) -> tuple[float, str] | None:
        """(the share used, of what) once the worker should wrap up, else None: task.checkpoint_at of the tighter
        cost ceiling, a ceiling the turn after this one may not fit (budget.checkpoint_due), or checkpoint_at of
        timeout_s, whichever comes first.

        WHY time: the checkpoint read only money, so a worker on a free or cheap leg was never told its time was
        short. Over 7 days to 2026-10-02, 970 tasks timed out after at least one turn (median 9 turns, 288 h of task
        time, $45.68) and came back as a tool-call log. The clock is the one asyncio.wait_for(timeout_s) runs on,
        so 429 rests count. The turn limit needs no checkpoint: its last turn is already an answer turn (NUDGE)."""
        at = task.checkpoint_at
        if not at:
            return None
        if metered:
            worst = worst_turn_usd(task.model, sent, tools, task.max_tokens, self.cached_tokens(passes))
            share = checkpoint_due(self.worker, self.job_budget, at, worst)
            if share is not None:
                return share, "spending budget" if share >= at else "spending budget, and the turn after this one may not fit what is left"
        share = (time.monotonic() - self.started) / task.timeout_s
        return (share, "time limit (timeout_s)") if share >= at else None


async def _call_turn(client: DeepSeekClient, task: Task, res: Result, editor: ContextEditor, messages: list[dict], tools: list[dict],
                     budget: _TurnBudget, exhausted: bool, user_tag: str | None, slow_turn_s: float | None,
                     escape=None, avoid: list[str] | None = None) -> ChatResult | None:
    """Plan one turn against the ceilings and send it. None when a ceiling refused it; res then carries the error."""
    ceilings = budget.ceilings
    send_tools = tools if (tools and not exhausted) else None
    if exhausted and task.schema:
        # A schema task's last turn keeps the one tool that carries its answer. With no tools at all it could only
        # write prose: 75 tasks in 30 days ended InvalidStructuredAnswer that way ($30.59, 59,377 s). The call is not
        # forced: Anthropic and DeepSeek refuse a forced tool_choice on a thinking model with HTTP 400 (ask() below).
        send_tools = [submit_result_spec(task.schema)]
    sent = editor.view(messages)  # before editor.passes is read: this view may be the one that makes a clearing pass
    # The last turn changes the tool list and turns thinking off, and tools sit ahead of everything else in the
    # cached prefix (anthropic_native), so it is a certain miss: held at the top rate, as every turn was before the
    # discount. Held at the hit rate, a 100k-token Opus last turn reserved $0.02 and billed about $0.50.
    plan = await plan_turn(task.model, sent, send_tools, task.max_tokens, ceilings, 0 if exhausted else budget.cached_tokens(editor.passes))
    if isinstance(plan, str):
        res.status, res.error = "error", plan  # run_api_task hands back what it gathered as a partial answer
        res.add_taint("C")  # a cost ceiling (the worker's or the job's) refused the next turn
        return None
    max_tokens, hold = plan
    call = client.chat(
        editor.view(messages), model=task.model, tools=send_tools, max_tokens=max_tokens,
        thinking=task.thinking if not exhausted else False, reasoning_effort=task.reasoning_effort, temperature=task.temperature, user=user_tag, zdr=task.zdr,
        # A leg with a next one leaves a rate-limited pool after slow_turn_s; the LAST leg, with nowhere to go,
        # after config.SATURATED_REST_S, as a PoolSaturated error instead of a silent wait to timeout_s
        # (client._post's rest_budget_s; job 20260924-152821-54f1).
        rest_budget_s=slow_turn_s if slow_turn_s else config.SATURATED_REST_S, last_leg=not slow_turn_s,
        # Every turn of this task names the same conversation, so a sticky provider (Anthropic) answers it from one
        # key and one prompt cache (ChatClient._pick).
        affinity=f"{user_tag}:{task.id}" if task.id else id(messages),
        **({"avoid_upstream": list(avoid)} if avoid else {}),
    )
    limit, live = None, LIVE_SPEND.get()
    if live is not None:
        # Only a turn that is out AND reserved is spared by the budget guard's cancel (jobs.cancel): an unpriced
        # leg holds nothing, so no ceiling would refuse its next turn.
        live.in_flight = hold > 0
    first = res.turns == 0
    try:
        if not (slow_turn_s and (first or selection.crawling(task.model)) and _better_ahead(escape, crawling_ok=first)):
            r = await call
        else:
            # A leg with somewhere to go does not wait out a hung call to a model already marked crawling
            # (config.SLOW_LEG_CALL_S), nor its FIRST call on this leg: a model that has not answered once has shown
            # nothing worth waiting for (2026-09-28: a pilot's first call to Kimi K3 on NVIDIA sat 190 s unanswered
            # and held its batch). This turn is not in `messages` yet, so the next leg sends it again.
            # For a first call a CRAWLING later leg is somewhere to go: it answers, slowly, and this one has not. Until
            # 2026-10-02 the cut asked for a leg not marked crawling, and with every later leg marked (as NVIDIA's
            # free legs often are together) it never fired: over 7 days 235 routed tasks sat 2,017 minutes on a leg
            # with no first reply past this bar, 166 of the 236 legs with every later leg marked crawling at planning
            # (scripts/first_reply_wait.py), GLM 5.3 Flash on NVIDIA alone 103 tasks and 962 minutes.
            async with asyncio.timeout(config.SLOW_LEG_CALL_S) as limit:
                r = await call
    except ApiError:
        release(ceilings, hold)  # the provider refused the call with a status: nothing was billed
        raise
    except BaseException as exc:
        settle_turn(ceilings, hold, None)  # cut off mid-call (timeout, cancel): it may have been billed, so the hold stays spent
        if isinstance(exc, TimeoutError) and limit is not None and limit.expired():
            raise SlowLeg(f"SlowLeg: {task.model} gave no reply to one turn in {config.SLOW_LEG_CALL_S:.0f}s - failing over "
                          f"while the task still has time") from None
        raise
    finally:
        if live is not None:
            live.in_flight = False
    settle_turn(ceilings, hold, r.cost_usd)
    budget.seen(r, editor.passes)
    return r


def _account_turn(task: Task, res: Result, r: ChatResult, usage: Usage, warm: asyncio.Event | None, is_pilot: bool,
                  slow_turn_s: float | None, tools: list[dict], exhausted: bool, escape=None) -> None:
    """Book a reply onto the task: usage, provider, cost, turn count; fail a leg that is too slow over; promote
    tool calls written as text."""
    if warm is not None and is_pilot:
        warm.set()
    usage.add(r.usage)
    _note_upstream(res, r)
    if r.seconds > config.SLOW_LEG_CALL_S:
        selection.note_crawl(task.model)
    _note_truncation(res, r)
    # A model with no price on record costs None for the whole task: not measured, never zero.
    res.cost_usd = None if r.cost_usd is None else (res.cost_usd or 0.0) + r.cost_usd
    res.turns += 1
    if (live := LIVE_SPEND.get()) is not None:
        add_spend(live, [{"cost_usd": r.cost_usd, "usage": r.usage.as_dict(), "turns": 1}])
    # The liveness stamp status reads to tell a stalled task from a slow one. Milliseconds: at whole seconds a quiet
    # age read the current second's fraction, not the reply's age (job.quiet_seconds).
    res.progress_at = now_iso("milliseconds")
    if (row := LIVE_ROW.get()) is not None:
        row.progress_at = res.progress_at  # the row status reads, not this leg's own Result
    if slow_turn_s and res.api_seconds / res.turns > slow_turn_s:
        # Its own SLOW_LEG_MIN_TURNS slow turns, or ONE when another task (in any hswarm process) has already marked the
        # model crawling: a job's tasks on a crawling model move together instead of each paying three slow turns.
        marked = selection.crawling(task.model)
        if (marked or res.turns >= config.SLOW_LEG_MIN_TURNS) and _better_ahead(escape):
            raise SlowLeg(f"SlowLeg: {task.model} averaged {res.api_seconds / res.turns:.0f}s a turn over {res.turns} turns "
                          f"(budget {slow_turn_s:.0f}s{', and it is marked crawling' if marked else ''}) - failing over "
                          f"while the task still has time")
    if tools and not exhausted and not r.tool_calls:
        _promote_text_calls(res, r, tools)


def _say(messages: list[dict], text: str) -> None:
    """A user turn: joined to a trailing user message with text content, else appended, so no two user messages sit
    back to back (some hosts refuse successive user messages)."""
    last = messages[-1] if messages else {}
    if last.get("role") == "user" and isinstance(last.get("content"), str):
        messages[-1] = {**last, "content": last["content"] + "\n\n" + text}
    else:
        messages.append({"role": "user", "content": text})


def _promote_text_calls(res: Result, r: ChatResult, tools: list[dict]) -> None:
    """A reply with no tool_calls is taken as the final answer, so a worker that WROTE its call as text (gpt-oss
    harmony headers, <tool_call> tags, [TOOL_CALLS] brackets) used to end the task with that markup as its answer.
    Promote such calls to real ones before the reply is read; the transcript then carries the structured calls, so
    the tool results that follow pair with them by id (toolcall_repair.py)."""
    fixed = promote_text_tool_calls(r.message, r.content, tools)
    if fixed is not None:
        r.message = fixed
        res.repaired_calls += len(fixed["tool_calls"])


def _redact_resumed(redactor: redaction.Redactor, messages: list[dict]) -> None:
    """Redact a transcript resumed from an earlier leg, in place, before the first call. A paid leg sent its tool
    outputs as read; failing over onto a free tier must not ship them there unredacted. Covers tool results, the
    assistant text that may quote them, and the call arguments (a write_file of a secret carries it verbatim).
    `messages` is dispatch._resume's deep copy, so the earlier leg's own transcript is untouched."""
    for m in messages:
        if m.get("role") in ("tool", "assistant") and isinstance(m.get("content"), str):
            m["content"] = redactor.scrub(m["content"], "earlier tool output" if m["role"] == "tool" else "earlier reply")
        for call in m.get("tool_calls") or ():
            fn = call.get("function") or {}
            if isinstance(fn.get("arguments"), str):
                try:
                    fn["arguments"] = redactor.apply(fn["arguments"])
                except redaction.RedactionBlocked:
                    fn["arguments"] = "{}"  # still valid JSON for the provider; the call's result says what it did


def _better_ahead(escape, crawling_ok=False) -> bool:
    """Whether leaving this slow leg can help: `escape` (from the route) says whether a later leg is not crawling, can
    take a call and has no open breaker. With none, the task stays: moving would trade a slow model for a crawling,
    saturated or broken one, and on 2026-09-27 one Odin refresh task left Kimi K3 at 32 s a turn that way, crossed a
    spend-blocked groq and two rate-limited Gemini legs, and ended on its cost cap. That trade is for a leg that
    answers; `crawling_ok` (a first call with no reply yet) counts a crawling leg that can take a call and is not
    broken. None (a caller that did not say) keeps the old rule: a next leg is enough."""
    return escape is None or bool(escape(crawling_ok=crawling_ok))


class SlowLeg(RuntimeError):
    """The leg answers, but too slowly to finish in time (config.SLOW_LEG_TURN_S); jobs.leg_unavailable fails it over."""


async def run_api_task(client: DeepSeekClient, task: Task, warm: asyncio.Event | None = None, is_pilot: bool = False, user_tag: str | None = None, slow_turn_s: float | None = None, resume_messages: list[dict] | None = None, job_budget: Budget | None = None, escape=None) -> tuple[Result, list[dict]]:
    res = Result(id=task.id, backend="api", model=task.model, started=now_iso())
    messages = resume_messages if resume_messages is not None else build_messages(task)
    try:
        tools, grant, redactor = _task_grant(task)
    except ValueError as e:
        res.status, res.error, res.finished = "error", str(e), now_iso()
        return res, messages
    if redactor is not None:
        messages = _redacted_messages(task, redactor, messages, resumed=resume_messages is not None)
    # The sandbox runs only what the model was offered: the privilege split holds even when an injected page
    # talks a `propose` worker into calling write_file or bash by name.
    sb = open_sandbox(task.runtime, task.cwd, roots=task.roots, envelope=task.envelope, writable=task.writable, spill_dir=config.SPILL_DIR, web_hosts=task.web_hosts, shell_grants=task.shell_grants, allowed=[t["function"]["name"] for t in tools], capability=grant, redactor=redactor)
    # The operator's Claude Code hooks, when HSWARM_API_HOOKS asks for them: a named hooks file that will not load
    # fails the task instead of running it unguarded.
    try:
        sb.hooks = toolhooks.for_task(sb.cwd, f"hswarm-{task.id}")
    except ValueError as e:
        res.status, res.error, res.finished = "error", str(e), now_iso()
        return res, messages
    usage = Usage()
    rate_wait = [0.0]
    RATE_WAIT.set(rate_wait)
    t0 = time.perf_counter()
    replayed: list[tuple[dict, str]] = []
    try:
        await asyncio.wait_for(_planned_loop(client, task, res, sb, messages, tools, usage, warm, is_pilot, user_tag, slow_turn_s, job_budget, replayed, escape),
                               timeout=task.timeout_s)
        if res.status == "ok" and task.recipe:
            plans.record(task, [c for c, _ in replayed] + plans.calls_from(messages))
    except asyncio.TimeoutError:
        res.status, res.error = "timeout", f"task exceeded {task.timeout_s}s"
    except asyncio.CancelledError:
        res.status, res.error = "cancelled", "cancelled"
        raise
    except (ApiError, SlowLeg) as e:
        res.status, res.error = "error", str(e)
    except Exception as e:  # noqa: BLE001
        res.status, res.error = "error", f"{type(e).__name__}: {e}\n" + traceback.format_exc(limit=3)
    finally:
        _close_task(task, res, sb, messages, usage, rate_wait, t0, warm, is_pilot)
    return res, messages


def _task_grant(task: Task) -> tuple[list[dict], Capability, redaction.Redactor | None]:
    """(tools offered, the grant the sandbox enforces, the leg's redactor). A ValueError ends the task readably."""
    tools = specs_for(task.tools)
    # Any sandbox tool can produce a capped or cleared output, so any worker with one can page it back.
    if tools and SPILL_TOOL not in {t["function"]["name"] for t in tools}:
        tools += specs_for([SPILL_TOOL])
    tools += [submit_result_spec(task.schema)] if task.schema else []
    # The grant the sandbox enforces: the task's capability, or the one its tools preset has always meant.
    grant = Capability.from_dict(task.capability) if isinstance(task.capability, dict) else capability.from_tools(task.tools)
    # Decided per LEG, not per task: a failover from a paid leg onto a free tier turns the machine switch on.
    # Raised inside run_api_task's try so a bad HSWARM_REDACT_FREE_TIER ends the task with a readable error, not a crash.
    redactor = redaction.for_task(task.redact, config.free_tier(task.model))
    return tools, grant, redactor


def _redacted_messages(task: Task, redactor: redaction.Redactor, messages: list[dict], resumed: bool) -> list[dict]:
    if not resumed:
        return build_messages(task, redactor)  # inlined task.files reach the provider too: redact them
    _redact_resumed(redactor, messages)
    return messages


async def _planned_loop(client: DeepSeekClient, task: Task, res: Result, sb: Sandbox, messages: list[dict], tools: list[dict], usage: Usage,
                        warm: asyncio.Event | None, is_pilot: bool, user_tag: str | None, slow_turn_s: float | None,
                        job_budget: Budget | None, replayed: list[tuple[dict, str]], escape=None) -> None:
    # A recipe task replays its cached plan first (plans.py): the reads its last passing run made land in the
    # user turn before the first model call, so the model answers instead of planning them again.
    replayed[:], res.plan = await plans.replay(task, sb)
    if replayed:
        messages[1]["content"] += "\n\n" + plans.replay_block(task.recipe, replayed)
    await _loop(client, task, res, sb, messages, tools, usage, warm, is_pilot, user_tag, slow_turn_s, job_budget, escape)


def _close_task(task: Task, res: Result, sb: Sandbox, messages: list[dict], usage: Usage, rate_wait: list[float], t0: float,
                warm: asyncio.Event | None, is_pilot: bool) -> None:
    """Everything run_api_task does however the task ended: close the sandbox, release the pilot, fill the result."""
    sb.close()  # a background job (bash_start) never outlives its task, however the task ended
    if warm is not None and is_pilot:
        warm.set()  # a pilot that failed must still release the others
    res.usage = usage.as_dict()
    res.seconds = round(time.perf_counter() - t0, 3)
    res.rested_s = round(min(rate_wait[0], res.seconds), 3)
    res.tool_calls = sb.tool_calls
    res.files_changed = sorted(set(sb.files_changed))
    res.proposals = list(sb.proposals)
    res.edit_snapshot = survival.snapshot(sb.originals)  # journalled by jobs._journal, scored later by survival.score_due
    res.web_approvals = list(sb.web.approvals)
    _judge_task(task, res, sb)
    res.finished = now_iso()
    if res.status in ("timeout", "error", "loop") and not res.answer:
        res.answer = partial_evidence(messages)  # the turns it spent are not thrown away with the task
    if sb.redactor is not None:
        res.redactions = dict(sb.redactor.counts)
    # After the receipt check, which matches the answer against the redacted outputs the model saw. The answer
    # and data stay on this machine: hand the caller real values, not tags it cannot map. Unconditional, since a
    # non-redacting leg can still echo tags an earlier leg of the same task left in the transcript.
    res.answer = redaction.restore_deep(res.answer)
    res.data = redaction.restore_deep(res.data)


def _judge_task(task: Task, res: Result, sb: Sandbox) -> None:
    """The receipt verdict and the acceptance criteria; a bug in either drops its verdict, never the result."""
    try:
        check_receipts(task, res, sb)
    except Exception as e:  # noqa: BLE001 - a verdict bug drops the verdict, never the finished result
        res.citations = {"verdict": "error", "resolved": 0, "receipts": len(sb.receipts), "error": f"{type(e).__name__}: {e}"}
    if task.acceptance:  # decided against the disk and the receipt ledger, never the worker's own claim
        try:
            res.acceptance = decide_acceptance(task.acceptance, sb, res.files_changed, sb.receipts)
        except Exception as e:  # noqa: BLE001 - a checker bug leaves every criterion UNVERIFIED, never the result lost
            res.acceptance = [{"criterion": c, "verdict": "UNVERIFIED", "detail": f"checker error {type(e).__name__}: {e}"} for c in task.acceptance]


def _note_upstream(res: Result, r: ChatResult) -> None:
    """Who served this turn, and how long the provider itself took. A swarm task spends most of its wall
    clock in local tool work, so comparing providers on task seconds compares the disk, not the provider."""
    res.api_seconds = round(res.api_seconds + r.seconds, 3)
    who = (r.raw or {}).get("provider")
    if who and who not in res.upstream:
        res.upstream.append(str(who))


def _note_truncation(res: Result, r: ChatResult) -> None:
    """A reply cut at its output-token limit may read as complete and is not: taint T, whatever came after it."""
    if r.finish_reason == "length":
        res.add_taint("T")


def _fill_ask(res: Result, r: ChatResult, want_data: bool) -> None:
    if want_data and r.tool_calls:
        res.data = json.loads((r.tool_calls[0].get("function") or {}).get("arguments") or "{}")
        res.answer = json.dumps(res.data, ensure_ascii=False)
    else:
        res.answer = r.content.strip()
    res.model, res.usage, res.cost_usd, res.turns, res.status = r.model, r.usage.as_dict(), r.cost_usd, 1, "ok"
    _note_upstream(res, r)
    _note_truncation(res, r)


_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}


def image_part(image: str) -> dict:
    """One OpenAI-style image content part: a data: or http(s) URL passes through; a local file path is read and
    base64-encoded by its extension (png, jpg, webp, gif). Anything else is refused by name - a wrong path must not
    arrive at the model as an empty picture that scores fine."""
    s = str(image)
    if s.startswith(("data:", "http://", "https://")):
        return {"type": "image_url", "image_url": {"url": s}}
    p = Path(s)
    mime = _IMAGE_MIME.get(p.suffix.lower())
    if not mime:
        raise ValueError(f"not an image I can send: {s} (png, jpg, jpeg, webp, gif, or a data:/http URL)")
    if not p.is_file():
        raise FileNotFoundError(f"image not found: {s}")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"}}


def user_content(prompt: str, images: list[str] | None = None) -> str | list[dict]:
    """The user turn: the plain string when there are no images (the shape every provider accepts), else the text
    part followed by one image part per image (the OpenAI-compatible shape Gemini's endpoint reads)."""
    if not images:
        return prompt
    return [{"type": "text", "text": prompt}] + [image_part(i) for i in images]


async def ask(client: DeepSeekClient, prompt: str, system: str | None = None, model: str | None = None, schema: dict | None = None, thinking: bool | None = None, reasoning_effort: str | None = None, max_tokens: int = 16_000, temperature: float | None = None, images: list[str] | None = None) -> Result:
    """A single tool-free call. Cheapest possible second opinion / classification / rewrite. `images` (paths or
    data:/http URLs) ride as content parts on the user turn - a vision-capable model must be named or routed."""
    res = Result(id="ask", backend="api", model=model or "", started=now_iso())
    # Every provider call carries the safety charter (guard.py), an ask with no system prompt of its own included.
    messages = [{"role": "system", "content": with_charter(system)}, {"role": "user", "content": user_content(prompt, images)}]
    t0 = time.perf_counter()
    try:
        tools = [submit_result_spec(schema)] if schema else None
        # tool_choice=required forces the schema path: the reply IS the submit_result call.
        #
        # x DeepSeek REFUSES tool_choice=required while thinking is on - HTTP 400, "Thinking mode
        # does not support this tool_choice" - so `ask(prompt, schema=...)` on the defaults was a
        # hard error rather than an answer, which is the shape a caller reaches for precisely when
        # they want data back. A schema therefore turns thinking off unless the caller asked for it
        # explicitly, in which case the provider's own refusal is theirs to see.
        if schema and thinking is None and not config.MODELS.get(model, {}).get("benchmark_slug"):
            thinking = False
        if thinking is None:
            thinking = config.MODELS.get(model, {}).get("default_thinking")
        choice = "required" if schema else None
        # Direct DeepSeek and Anthropic both refuse a forced tool_choice in thinking mode (Anthropic: HTTP 400
        # "tool_choice: type tool and any are not supported for this model"), and a benchmarked route keeps its
        # thinking above, so it asks for the tool instead. That 400 on claude-sonnet-5-5-low failed Dredd's drafter and
        # its design score on Lift's round 7 hearing (2026-09-29).
        if schema and thinking is True and config.provider_of(model) in ("deepseek", "anthropic"):
            choice = "auto"
        r = await client.chat(messages, model=model or res.model, tools=tools, tool_choice=choice, max_tokens=max_tokens, thinking=thinking, reasoning_effort=reasoning_effort, temperature=temperature, cache_turns=False)
        _fill_ask(res, r, bool(schema))
        if schema:
            if res.data is None and res.answer:
                try:
                    res.data = json.loads(res.answer)
                except ValueError:
                    pass
            errors = ["(root): not an object"] if not isinstance(res.data, dict) else schema_errors(schema, res.data)
            if errors:
                # One call, no second turn to push back on: a payload that breaks the schema is an error ask_selected
                # fails over on, never an ok (jobs 20260925-143537-e2e8, -143658-29b0). An empty answer the schema
                # allows stays ok here: a caller for whom empty is wrong says so with minItems / minProperties.
                res.status, res.error = "error", "InvalidStructuredAnswer: " + "; ".join(errors)[:400]
    except Exception as e:  # noqa: BLE001 - ApiError included; the caller reads status/error
        res.status, res.error = "error", str(e) if isinstance(e, ApiError) else f"{type(e).__name__}: {e}"
    res.seconds = round(time.perf_counter() - t0, 3)
    res.finished = now_iso()
    return res
