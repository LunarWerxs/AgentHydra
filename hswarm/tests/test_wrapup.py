"""Offline: a task that is about to hit a wall hands its work back instead of dying with it.

WHY these tests: over 7 days to 2026-10-02, 1,214 tasks were killed at their cost cap ($403.83) and 970 timed out
after at least one turn, most of them never asked to wrap up: the reservation priced a cached prompt as a miss, the
checkpoint read only a fixed share of the money, nothing read the clock, and the last turn of a schema task took
submit_result away. Each test below fails on that code."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, config  # noqa: E402
from hswarm.budget import MIN_TURN_TOKENS, Budget, checkpoint_due, plan_turn, prompt_tokens, top_rates  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.context import ContextEditor  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402

OPUS = "rank:claude-opus-5-5:direct"  # a leg whose cache-hit rate is a fraction of its miss and write rates


class _Worker:
    """Reads a file every turn (a new slice each time, so loopguard sees progress) until `final` hands it the
    message to end on. `final(messages, tool names offered)` returns that message, or None to keep reading."""

    def __init__(self, final, turn_s: float = 0.0):
        self.final, self.turn_s, self.turns = final, turn_s, 0

    async def chat(self, messages, tools=None, **kw):
        self.turns += 1
        await asyncio.sleep(self.turn_s)
        message = self.final(messages, [t["function"]["name"] for t in tools or []])
        if message is None:
            args = f'{{"path": "evidence.txt", "end_line": {self.turns + 1}}}'
            call = {"id": f"c{self.turns}", "type": "function", "function": {"name": "read_file", "arguments": args}}
            message = {"role": "assistant", "content": "", "tool_calls": [call]}
        return ChatResult(message=message, finish_reason="tool_calls" if message.get("tool_calls") else "stop",
                          usage=Usage(), model="deepseek-flash", seconds=0.001, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


def _task(tmp_path, **extra) -> Task:
    (tmp_path / "evidence.txt").write_text("the line that matters\n", encoding="utf-8")
    spec = {"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash", "route": False, **extra}
    return Task.from_dict(spec, {}, 0)


def _auto(monkeypatch) -> None:
    """AUTO resolves without this machine's keys, as in test_spec."""
    from hswarm import dispatch, selection

    monkeypatch.setattr(selection, "plan", lambda *a, **k: {"candidates": [{"model": "deepseek-flash"}]})
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {"candidates": [{"model": "deepseek-flash"}]})


def test_a_reported_cached_prefix_is_reserved_at_the_hit_rate():
    # Contract: the tokens the last reply reported as cached are held at the hit rate, so a turn that will bill a few
    # cents is sent; with nothing reported the whole prompt is still held at the top rate and refused.
    # Regression: a 40k-token Opus prompt was held at the write rate ($0.20) against $0.15 left and never sent.
    assert top_rates(OPUS) is not None
    messages = [{"role": "user", "content": "x" * 120_000}]
    cap = Budget(0.25, "cost budget (max_cost_usd)")
    cap.settle(0.0, 0.10)
    assert isinstance(asyncio.run(plan_turn(OPUS, messages, None, 16_000, [cap])), str)
    tokens, hold = asyncio.run(plan_turn(OPUS, messages, None, 16_000, [cap], cached=38_000))
    assert tokens >= MIN_TURN_TOKENS and 0 < hold <= cap.unspent() + 1e-9


@pytest.mark.parametrize("model, exhausted, cleared, sent", [
    (OPUS, False, False, True),  # one key per task, same prefix: the discount lets the turn out
    (OPUS, True, False, False),  # the last turn changes the tool list and thinking: a certain miss
    (OPUS, False, True, False),  # a clearing pass rewrote old tool results since the last reply
    ("deepseek-flash", False, False, False),  # a round-robin pool: the next key may hold none of the prefix
])
def test_the_cache_discount_is_given_only_where_the_next_turn_reads_that_cache(tmp_path, model, exhausted, cleared, sent):
    # Contract: with half a full-price prompt left under the cap, a turn goes out only when the prefix the last reply
    # reported will be read again; otherwise it is held at the top rate and refused unsent, with nothing spent.
    # Regression: all four were held at the hit rate and sent, and a miss billed many times its hold past the cap.
    task = _task(tmp_path)
    task.model = model
    messages = [{"role": "user", "content": "x" * 2_000_000}]
    rates, tokens = top_rates(model), prompt_tokens(messages, None)
    task.max_cost_usd = tokens * max(rates["miss"], rates.get("write", 0.0)) / 1_000_000.0 / 2
    budget, editor = agent._TurnBudget(task, None), ContextEditor(0, 0)
    budget.seen(ChatResult(message={}, finish_reason="stop", usage=Usage(hit=tokens), model=model, seconds=0.001,
                           cost_usd=0.0, peak=False), editor.passes)
    editor.passes += cleared
    client = _Worker(lambda m, names: {"role": "assistant", "content": "done"})
    res = Result(id=task.id, model=model)
    r = asyncio.run(agent._call_turn(client, task, res, editor, messages, [], budget, exhausted, None, None))
    assert (r is not None, client.turns) == (sent, int(sent)), res.error


def test_an_image_part_is_estimated_per_image_not_per_base64_character():
    # Regression: a 3 MB inlined screenshot read as a million prompt tokens, and 228 tasks of one image job were
    # refused at turn 0 with nothing spent.
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 3_000_000}}
    assert prompt_tokens([{"role": "user", "content": [{"type": "text", "text": "what is this?"}, image]}], None) < 10_000


def test_the_checkpoint_comes_while_one_more_turn_still_fits():
    # Contract: the wrap-up is due at checkpoint_at of the cap OR once less than two worst-case turns are unspent.
    # Regression: at 45% spent with a next turn worth 40% of the cap, 0.8 was never reached and the turn after was refused.
    cap = Budget(0.20, "cost budget (max_cost_usd)")
    cap.settle(0.0, 0.09)
    assert checkpoint_due(cap, None, 0.8, 0.08) == pytest.approx(0.45)
    assert checkpoint_due(cap, None, 0.8, 0.01) is None  # plenty of turns left: not yet
    assert checkpoint_due(cap, None, 0, 0.08) is None  # checkpoint_at 0 still turns it off


@pytest.mark.parametrize("priced", [True, False])
def test_a_task_short_on_time_is_asked_to_wrap_up_before_timeout(tmp_path, monkeypatch, priced):
    # Contract: at checkpoint_at of timeout_s the worker is asked once to finish, on a leg that costs nothing and on
    # one with no price on record alike, and its answer comes back ok. Regression: the checkpoint read only money
    # spent, so this worker kept reading until asyncio.wait_for ended it as status timeout.
    if not priced:
        monkeypatch.setattr(agent, "top_rates", lambda model: None)

    def final(messages, names):
        asked = any(m.get("role") == "user" and "Budget checkpoint" in str(m.get("content")) for m in messages)
        return {"role": "assistant", "content": "wrapped up: the line that matters"} if asked else None

    client = _Worker(final, turn_s=0.3)
    res, _ = asyncio.run(agent.run_api_task(client, _task(tmp_path, timeout_s=5, max_turns=50, checkpoint_at=0.5)))
    assert res.status == "ok" and res.answer.startswith("wrapped up"), (res.status, res.error)
    assert client.turns > 2  # it worked until the clock said stop, not from the first turn


def test_a_schema_task_keeps_submit_result_on_its_last_turn(tmp_path):
    # Contract: when the turn budget runs out, a schema task is still offered submit_result (and only that), so it
    # can hand in its data. Regression: the last turn carried no tools, the worker could only write prose, and the
    # task ended InvalidStructuredAnswer.
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}

    def final(messages, names):
        if "read_file" in names:
            return None
        if names == ["submit_result"]:
            call = {"id": "s1", "type": "function", "function": {"name": "submit_result", "arguments": '{"n": 1}'}}
            return {"role": "assistant", "content": "", "tool_calls": [call]}
        return {"role": "assistant", "content": "I ran out of turns before I could submit."}

    res, _ = asyncio.run(agent.run_api_task(_Worker(final), _task(tmp_path, max_turns=3, schema=schema)))
    assert res.status == "ok" and res.data == {"n": 1}, (res.status, res.error)


def test_a_schema_task_that_writes_prose_on_its_last_turn_ends_on_its_turn_budget(tmp_path):
    # Contract: prose on the last turn is the turn budget ending (the task's own failure), not InvalidStructuredAnswer,
    # which jobs.leg_unavailable fails over on. Regression: a pinned route ran another leg over the whole transcript.
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    final = lambda messages, names: None if "read_file" in names else {"role": "assistant", "content": "I ran out of turns."}  # noqa: E731
    res, _ = asyncio.run(agent.run_api_task(_Worker(final), _task(tmp_path, max_turns=2, schema=schema)))
    assert res.status == "error" and res.error.startswith("turn budget exhausted"), res.error


def test_an_unnamed_cap_is_sized_for_tool_work_and_stays_small_without_tools(tmp_path, monkeypatch):
    # Contract: a code or research task WITH tools gets a default cap above the runaway guard; the same profile with
    # no tools keeps the guard. Regression: both got $0.25, which killed 343 code/research tasks in 7 days.
    _auto(monkeypatch)
    base = {"cwd": str(tmp_path)}
    guard = config.DEFAULT_MAX_COST_FALLBACK_USD
    assert Task.from_dict({"prompt": "x", "profile": "code", "tools": "edit"}, base, 0).max_cost_usd >= 1.0
    assert Task.from_dict({"prompt": "x", "profile": "research", "tools": "read"}, base, 1).max_cost_usd >= 1.5
    assert Task.from_dict({"prompt": "x", "profile": "code", "tools": "none"}, base, 2).max_cost_usd == guard


def test_limits_are_coerced_and_a_zero_is_refused_not_read_as_unlimited(tmp_path):
    # Contract: a numeric limit written as a string is coerced, and one that is zero, negative or not a number is
    # refused by name at parse time. Regression: max_cost_usd 0 switched the cap off, '1.5' raised TypeError after the
    # first paid turn, and max_turns 0 / timeout_s 0 quietly became 1 turn and 5 s.
    base = {"prompt": "x", "cwd": str(tmp_path), "model": "deepseek-flash", "route": False}
    task = Task.from_dict({**base, "max_cost_usd": "1.5", "timeout_s": "60"}, {}, 0)
    assert task.max_cost_usd == 1.5 and isinstance(task.max_cost_usd, float) and task.timeout_s == 60
    for bad in ({"max_cost_usd": 0}, {"max_cost_usd": -1}, {"max_cost_usd": "lots"}, {"max_tokens": 0}, {"max_turns": 0},
                {"timeout_s": 0}, {"checkpoint_at": "soon"}):
        with pytest.raises(ValueError, match=next(iter(bad))):
            Task.from_dict({**base, **bad}, {}, 1)
