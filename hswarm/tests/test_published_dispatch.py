"""run_selected/ask_selected/decide with published plans: fake plan, fake legs, no network."""
from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace

from hswarm import agent, decisions as d, dispatch, selection, typesafe
from hswarm.job import Job
from hswarm.spec import Result, Task


def _plan(models):
    return {"profile": "code", "candidates": [{"model": m, "reasoning_effort": "high", "thinking": True,
                                               "benchmark_slug": m} for m in models]}


class _Mgr:
    def client_for(self, leg):
        return SimpleNamespace(pool=None)

    async def _park_broke_keys(self, c):
        pass

    def _gate_for(self, leg, c):
        return None

    gate_wait = 0.0

    async def _gated(self, job, gate, run):
        await asyncio.sleep(self.gate_wait)
        return await run


def _setup(monkeypatch, tmp_path, legs):
    models = [m for m, _ in legs]
    monkeypatch.setattr(selection, "plan", lambda *a, **k: _plan(models))
    seen = []
    outcomes = iter(legs)

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        seen.append({"model": task.model, "effort": task.reasoning_effort, "resume": resume_messages,
                     "max_turns": task.max_turns, "max_cost": task.max_cost_usd,
                     "timeout": task.timeout_s})
        _, kind = next(outcomes)
        msgs = (resume_messages or [{"role": "user", "content": task.prompt}]) + [
            {"role": "assistant", "tool_calls": [{"id": f"c{len(seen)}"}], "reasoning_content": "secret"},
            {"role": "tool", "tool_call_id": f"c{len(seen)}", "content": "done"}]
        if kind == "down":
            return Result(id=task.id, backend="api", model=task.model, status="error", error="API Error: 503 no endpoints",
                          cost_usd=0.3, turns=3, tool_calls=1), msgs
        if kind == "saturated":
            return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.01, turns=1,
                          error="gemini API 429: PoolSaturated: every gemini key is rate-limited"), msgs
        if kind == "wrong":
            return Result(id=task.id, backend="api", model=task.model, status="error", error="tests failed: 2 assertions",
                          cost_usd=0.2, turns=2), msgs
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok", cost_usd=0.1, turns=1), msgs

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    t = Task(id="t", prompt="do", cwd=str(tmp_path), tools="all", model=models[0], max_turns=10, max_cost_usd=1.0)
    t.profile = "code"
    job = Job(id="j", tasks=[t]) if "tasks" in Job.__dataclass_fields__ else Job(id="j")
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    return t, job, seen


def test_unavailable_first_leg_continues_same_transcript_with_shared_limits(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "down"), ("rank:glm-5-3", "ok")])
    res, extra = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "ok" and res.model == "rank:glm-5-3" and res.failover == ["rank:deepseek-v4-pro"]
    assert [s["model"] for s in seen] == ["rank:deepseek-v4-pro", "rank:glm-5-3"]
    resumed = seen[1]["resume"]
    assert any(m.get("role") == "tool" and m["tool_call_id"] == "c1" for m in resumed), "completed tool calls kept"
    assert all("reasoning" not in m and m.get("reasoning_content") in (None, "") for m in resumed)
    assert seen[1]["max_turns"] == 7 and abs(seen[1]["max_cost"] - 0.7) < 1e-9
    assert seen[1]["effort"] == "high"
    assert abs(res.cost_usd - 0.4) < 1e-9 and res.turns == 4 and res.tool_calls == 1
    assert [a["model"] for a in res.selection["attempts"]] == ["rank:deepseek-v4-pro", "rank:glm-5-3"]


def test_exhausted_cost_stops_escalation(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "down"), ("rank:glm-5-3", "ok")])
    t.max_cost_usd = 0.3
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "error" and "budget exhausted" in res.error and len(seen) == 1
    assert abs(res.cost_usd - 0.3) < 1e-9


def test_success_is_not_replayed(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "ok"), ("rank:glm-5-3", "ok")])
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.model == "rank:deepseek-v4-pro" and len(seen) == 1


def test_semantic_error_stops_retries(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "wrong"), ("rank:glm-5-3", "ok")])
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "error" and "tests failed" in res.error and len(seen) == 1
    assert res.model == "rank:deepseek-v4-pro" and res.failover == []


def test_gate_wait_does_not_spend_the_run_clock(monkeypatch, tmp_path):
    """Job 20260925-143635-e3f6: 23 tasks at width 24 spent their 600 s queued (dead legs, a ramping gate) and
    ended `task timeout exhausted` with zero turns. The clock is run time; the queue spends none of it."""
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "down"), ("rank:glm-5-3", "ok")])
    t.timeout_s = 0.2
    mgr = _Mgr()
    mgr.gate_wait = 0.3
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    assert res.status == "ok" and len(seen) == 2
    assert seen[0]["timeout"] == 0.2 and seen[1]["timeout"] == 0.2, "queue time is not run time"


class _DeadPool:
    provider = "deepseek"

    def __len__(self):
        return 3

    def disabled(self):
        return ["a", "b", "c"]


def test_a_leg_whose_keys_are_all_disabled_is_skipped_without_running(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "ok"), ("rank:glm-5-3", "ok")])
    mgr = _Mgr()
    mgr.client_for = lambda leg: SimpleNamespace(pool=_DeadPool() if "deepseek" in leg else None)
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    assert res.status == "ok" and res.model == "rank:glm-5-3" and res.failover == ["rank:deepseek-v4-pro"]
    assert [s["model"] for s in seen] == ["rank:glm-5-3"]


def test_an_open_breaker_puts_its_leg_last_and_the_job_budget_rides_on_every_leg(monkeypatch, tmp_path):
    # An AUTO task runs here, not through jobs._run_legs: the circuit breaker's order and the job's budget_usd ceiling
    # must hold on this path too, or a default task times out on a host its siblings already found down.
    from hswarm import breaker
    from hswarm.budget import Budget

    for _ in range(breaker.THRESHOLD):
        breaker.record("rank:deepseek-v4-pro", Result(id="x", status="error", error="deepseek API 503: service unavailable"), True)
    monkeypatch.setattr(selection, "plan", lambda *a, **k: _plan(["rank:deepseek-v4-pro", "rank:glm-5-3"]))
    seen = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, job_budget=None, **kw):
        seen.append((task.model, slow_turn_s, job_budget))
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="ok", cost_usd=0.1, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", fake_run)
    t = Task(id="t", prompt="do", cwd=str(tmp_path), tools="all", model="rank:deepseek-v4-pro", max_turns=10, max_cost_usd=1.0)
    t.profile = "code"
    job = Job(id="j", tasks=[t]) if "tasks" in Job.__dataclass_fields__ else Job(id="j")
    job.results[t.id] = Result(id=t.id, backend="api", model=t.model)
    mgr, ceiling = _Mgr(), Budget(5.0, "job budget (budget_usd)")
    mgr._budgets = {"j": ceiling}
    res, _ = asyncio.run(dispatch.run_selected(mgr, job, t, None, True))
    # The healthy leg moved ahead of the open one is the route's real last leg, so it runs untimed (no SlowLeg).
    assert res.status == "ok" and seen == [("rank:glm-5-3", None, ceiling)]
    assert breaker.state("rank:deepseek-v4-pro") == "open" and breaker.state("rank:glm-5-3") == "closed"


def test_a_saturated_last_leg_queues_again_instead_of_failing(monkeypatch, tmp_path):
    """Job 20260925-145240-b39d: 19 of 23 tasks died `PoolSaturated` on Gemini, the only route left."""
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:gemini-3-8-flash", "saturated"), ("rank:gemini-3-8-flash", "ok")])
    monkeypatch.setattr(selection, "plan", lambda *a, **k: _plan(["rank:gemini-3-8-flash"]))
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "ok" and len(seen) == 2 and res.failover == []
    assert any(m.get("tool_call_id") == "c1" for m in seen[1]["resume"]), "the requeued task keeps its transcript"


def test_every_leg_of_an_ask_gets_its_turn_inside_the_budget_when_the_first_ones_crawl(monkeypatch):
    """2026-09-27: GLM 5.3 Flash on NVIDIA was alive but took every Dredd boardroom seat's whole 120 s, so each seat
    ended `ask timeout exhausted` with healthy legs behind it never tried."""
    monkeypatch.setattr(dispatch, "_plan", lambda *a, **k: _plan(["crawls", "crawls-too", "answers"]))

    async def fake_ask(client, prompt, model=None, **kw):
        if model.startswith("crawls"):
            await asyncio.sleep(10)
        return Result(id="ask", backend="api", model=model, status="ok", answer=model, cost_usd=0.0)

    monkeypatch.setattr(agent, "ask", fake_ask)
    res = asyncio.run(dispatch.ask_selected(_Mgr(), "q", timeout_s=0.6))
    assert res.status == "ok" and res.answer == "answers" and res.failover == ["crawls", "crawls-too"]


def test_a_leg_marked_crawling_gets_a_short_try_and_the_healthy_legs_share_the_budget(monkeypatch):
    """2026-09-29: with NVIDIA crawling, every board seat split its budget evenly over twenty legs, too little for the
    healthy legs behind to write a seat's turn, and two Lift boards sat for nothing."""
    from hswarm import config

    # The crawling leg is starred, so it keeps its place ahead of the healthy legs (selection.rebias: a star orders
    # first; since 2026-10-02 being free no longer keeps a crawling leg ahead of them).
    plan = _plan(["crawls", "answers", "backup"])
    monkeypatch.setattr(config, "PRIORITY", {"crawls": 1})
    monkeypatch.setattr(dispatch, "_plan", lambda *a, **k: plan)
    monkeypatch.setattr(config, "CRAWLING_LEG_TRY_S", 0.05)
    selection.reset_load()
    selection.note_crawl("crawls")

    async def fake_ask(client, prompt, model=None, **kw):
        await asyncio.sleep({"crawls": 10, "answers": 0.4}.get(model, 0))
        return Result(id="ask", backend="api", model=model, status="ok", answer=model, cost_usd=0.0)

    monkeypatch.setattr(agent, "ask", fake_ask)
    try:
        res = asyncio.run(dispatch.ask_selected(_Mgr(), "q", timeout_s=1.0))
    finally:
        selection.reset_load()
    assert res.status == "ok" and res.answer == "answers" and res.failover == ["crawls"]


def test_no_candidates_is_explicit_failure(monkeypatch, tmp_path):
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:deepseek-v4-pro", "ok")])
    monkeypatch.setattr(selection, "plan", lambda *a, **k: _plan([]))
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "error" and "NoCapableSwarmRoute" in res.error and seen == []


def test_a_handoff_into_gemini_signs_the_tool_calls_it_did_not_make():
    """2026-09-25: 12 of 12 SUE donors failed over Cerebras (429) and Groq (413) into Gemini, which 400s on an earlier
    tool call without a thought_signature. Calls from another model get Google's documented bypass; Gemini's own keep theirs."""
    msgs = [{"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "x"},
            {"role": "assistant", "tool_calls": [{"id": "c2", "extra_content": {"google": {"thought_signature": "real"}}}]}]
    out = dispatch._resume(msgs, "gemini")
    assert out[0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "skip_thought_signature_validator"
    assert out[2]["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "real"
    assert "extra_content" not in msgs[0]["tool_calls"][0], "the caller's transcript is not changed"


def test_a_handoff_out_of_gemini_drops_its_signatures():
    """2026-09-27: 58 of 62 research tasks failed over from Gemini to Cerebras, which 400s on the `extra_content`
    Gemini had put in its own tool calls. Every other provider gets the call without it."""
    msgs = [{"role": "assistant", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "read_url", "arguments": "{}"},
                                                  "extra_content": {"google": {"thought_signature": "real"}}}]}]
    for provider in ("cerebras", "groq", "deepseek", "openrouter"):
        assert dispatch._resume(msgs, provider)[0]["tool_calls"][0] == {"id": "c1", "type": "function", "function": {"name": "read_url", "arguments": "{}"}}
    assert dispatch._resume(msgs, "gemini")[0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "real"


def test_a_handoff_into_anthropic_rewrites_call_ids_it_would_refuse():
    """2026-09-30: research tasks that failed over from Kimi K3 (NVIDIA) to Claude Opus direct died on their first
    Anthropic turn with 400 "tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'": Kimi names its calls
    like `functions.read_url:0`. Anthropic gets a legal id, the same one on the call and on its result."""
    msgs = [{"role": "assistant", "tool_calls": [{"id": "functions.read_url:0", "type": "function", "function": {"name": "read_url", "arguments": "{}"}},
                                                 {"id": "c_1", "type": "function", "function": {"name": "grep", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "functions.read_url:0", "content": "page"},
            {"role": "tool", "tool_call_id": "c_1", "content": "hits"}]
    out = dispatch._resume(msgs, "anthropic")
    ids = [c["id"] for c in out[0]["tool_calls"]]
    assert all(re.fullmatch(r"[a-zA-Z0-9_-]+", i) for i in ids)
    assert ids[1] == "c_1", "a legal id is kept as it is"
    assert [out[1]["tool_call_id"], out[2]["tool_call_id"]] == ids, "each result still answers its own call"
    assert msgs[0]["tool_calls"][0]["id"] == "functions.read_url:0", "the caller's transcript is not changed"
    assert dispatch._resume(msgs, "groq")[0]["tool_calls"][0]["id"] == "functions.read_url:0", "other providers keep the id"


def test_a_profile_out_of_keys_steps_down_to_the_next_models_instead_of_stopping(monkeypatch, tmp_path):
    """Owner, 2026-09-25: out of keys means the next model in the list, never a stop. Code had no usable route
    (DeepSeek spent, OpenRouter 402), so the task runs on general's models, marked below its floor."""
    t, job, seen = _setup(monkeypatch, tmp_path, [("rank:qwen3-8-27b:groq", "ok")])
    monkeypatch.setattr(selection, "plan", lambda profile, *a, **k: _plan(["rank:qwen3-8-27b:groq"] if profile == "general" else []))
    res, _ = asyncio.run(dispatch.run_selected(_Mgr(), job, t, None, True))
    assert res.status == "ok" and [s["model"] for s in seen] == ["rank:qwen3-8-27b:groq"]
    assert res.selection["profile"] == "code" and res.selection["below_floor"] == "general"


class _Jev:
    usable = True

    async def ask(self, state, questions, model=typesafe.MODEL):
        return {"status": "ok", "answers": {q: {"type": "choice", "choice": "a", "probabilities": {"a": .5, "b": .5},
                                                "confidence": .2} for q in questions},
                "secs": .1, "in": 1, "out": 1, "model": "jev", "cost_usd": 0.0}


class _DeadMgr:
    def __init__(self):
        self.kw = []

    async def ask_routed(self, prompt, model, **kw):
        self.kw.append((model, kw))
        return SimpleNamespace(status="error", answer=None, model=model, cost_usd=0.0,
                               error="NoCapableSwarmRoute: routes exhausted")


def test_jev_fallback_exhaustion_is_unanswered_not_low_confidence_jev(monkeypatch):
    mgr = _DeadMgr()
    item = {"id": "x", "state": "s", "question": "Pick", "options": {"a": "A", "b": "B"}}
    out = asyncio.run(d.decide([item], mgr, jev=_Jev(), escalate_below=0.7))
    [a] = out["answers"]
    assert a["answer"] is None and a["source"] == "none"
    assert mgr.kw[0][0] == "auto" and mgr.kw[0][1].get("profile") == "decision"
