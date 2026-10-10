"""Offline: a routed task fails over to its next leg when a leg is UNAVAILABLE, and only then.

A strictly pinned OpenRouter leg (one host, no fallbacks) is only as available as that host, and an
OpenRouter key's account can be unable to reach a host at all (a privacy policy excluding it answered
404 on two of three real keys, 2026-09-17). Failover is what keeps either from failing every task routed
there. It must never fire on the task's OWN failure - a worker's FAILED, a turn budget, a timeout, or a
400 after the leg served a turn - because re-running that on another provider doubles the spend for the same
answer. A 400 before the leg served anything spent nothing: that route refused the request, and the next may not.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, jobs  # noqa: E402
from hswarm.jobs import JobManager, leg_unavailable  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402


def _err(msg: str) -> Result:
    return Result(id="t", status="error", error=msg)


@pytest.mark.parametrize("msg", [
    'openrouter API 404: {"error":{"message":"0 endpoints out of 1 requested are available matching your guardrail restrictions"}}',
    "openrouter API 402: insufficient credits",
    "deepseek API 503: service unavailable",
    "openrouter API 502: bad gateway",
    "NoUsableKey: every one of the 16 deepseek keys is disabled: out of credit (402)",
    "SlowLeg: gemini-3.8-flash averaged 58s a turn over 3 turns (budget 30s) - failing over while the task still has time",
    "ConnectError: [Errno 11001] getaddrinfo failed",
    "openrouter API 404: No endpoints found for deepseek/deepseek-v4.1-flash.",
    'deepseek API 400: {"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
    "gemini API 429: RESOURCE_EXHAUSTED Quota exceeded",  # a free tier spent for the day must down-route
    # the MODEL's bad sample, still bad after the client's resamples: Dredd's drafter died on it (2026-09-26)
    'groq API 400: {"error":{"message":"Tool call validation failed: attempted to call tool \'search\' which was not in request.tools","code":"tool_use_failed"}}',
    # Claude Code's renderings, from a cc worker (2026-09-17: the DeepSeek keys will not be topped up again)
    "claude exit 1: API Error: 503 upstream connect error",
    "NoUsableKey: no key to run on: every key in the pool is disabled; top up and run `hswarm keys probe`",
    "API Error: 402 Insufficient Balance (key 1234abcd disabled as out of credit; NoUsableKey: no key with credit left to retry on: every key in the pool is disabled)",
    # groq's account out of spend, sent as a 400 (board #4291, 2026-09-27: job 20260927-133050-c247 lost all 5 tasks
    # on it with the gemini leg behind groq never tried)
    'groq API 400: {"error":{"message":"Organization has blocked API access because a spend alert threshold was met. '
    'Please visit https://console.groq.com/settings/billing to manage your spend alerts.","type":"invalid_request_error",'
    '"code":"spend_limit_reached"}}',
    # nothing usable after the worker's own empty-answer nudges: the next model may answer (Kimi K3, 2026-09-27)
    "empty answer (finish_reason=stop)",
    # a key the provider refuses, reaching the job only once no other key in the pool could take the call: job
    # 20260928-110346-6218 lost 2 of 32 tasks on a suspended Gemini key with gemini-3.5-flash-lite never tried
    'gemini API 403: [{"error": {"code": 403, "message": "Permission denied: Consumer \'api_key:x\' has been suspended.", '
    '"status": "PERMISSION_DENIED", "details": [{"reason": "CONSUMER_SUSPENDED"}]}}]',
    'openrouter API 401: {"error":{"message":"User not found.","code":401}}',
    # NVIDIA's model function down, sent as a 400: 52 tasks died on it from 2026-09-23 to 09-28, on the leg where they
    # landed, with the legs behind it never tried (found by hswarm history, 2026-10-02)
    'nvidia API 400: {"status":400,"title":"Bad Request","detail":"Function id \'1586112a-925c-48af-8631-7c815dbd749c\': '
    'DEGRADED function cannot be invoked"}',
    # a route refusing the request's shape before it served anything (nothing billed, no turn): from 23:43Z on
    # 2026-10-07 every schema task auto routed to gpt-6-luna-high on OpenAI ended on this with its other legs untried
    'openai API 400: {"error":{"message":"Function tools with reasoning_effort are not supported for gpt-6-luna in '
    '/v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.",'
    '"type":"invalid_request_error","param":"reasoning_effort","code":null}}',
    # the same refusal as a 422, Mistral's status for a request field it will not take (magistral 0/24, 2026-09-20)
    'mistral API 422: {"detail":[{"type":"extra_forbidden","loc":["body","user"],"msg":"Extra inputs are not permitted"}]}',
])
def test_these_mean_the_leg_could_not_serve(msg):
    assert leg_unavailable(_err(msg))


@pytest.mark.parametrize("msg", [
    "FAILED: the premise is wrong, four functions are uncalled",
    "turn budget exhausted without a final answer",
    "task exceeded 600s",
    "openrouter API 4040: not a real status",
    "the worker could not find endpoint handlers for the 404 page",
])
def test_these_are_the_tasks_own_failure(msg):
    assert not leg_unavailable(_err(msg))


@pytest.mark.parametrize("msg", [
    'deepseek API 400: {"error":{"message":"Invalid tool_choice"}}',
    "claude exit 1: API Error: 400 invalid tool schema",
])
def test_a_400_after_the_leg_served_a_turn_is_the_tasks_own_failure(msg):
    # The leg answered and billed a turn first: a re-run elsewhere would pay for that work again. Before any served
    # turn the same status is the route refusing the request, and fails over (test_these_mean_the_leg_could_not_serve).
    assert not leg_unavailable(Result(id="t", status="error", error=msg, turns=2, cost_usd=0.004))


def test_an_ok_result_is_never_unavailable():
    assert not leg_unavailable(Result(id="t", status="ok", error="openrouter API 404"))


SLOWS: list = []  # the slow-leg budget each scripted leg was handed, in call order
RESUMED: list = []  # the conversation each scripted leg was handed to continue, in call order


def _job_with(monkeypatch, tmp_path, outcomes: dict, plan: list[str]):
    """A JobManager whose route plan and api runner are scripted: `outcomes[model]` is the Result a leg yields."""
    calls: list[str] = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        calls.append(task.model)
        SLOWS.append(slow_turn_s)
        RESUMED.append(resume_messages)
        r = outcomes[task.model]
        out = Result(id=task.id, backend="api", model=task.model, status=r.status, error=r.error, answer=r.answer,
                     cost_usd=r.cost_usd, turns=r.turns, seconds=r.seconds, usage=dict(r.usage))
        if warm is not None and is_pilot:
            warm.set()
        # an NVIDIA-shaped reply: `refusal` is a field the next host may refuse, so a handoff must not carry it
        return out, (resume_messages or [{"role": "user", "content": task.prompt}]) + [
            {"role": "assistant", "content": f"{task.model} got here", "refusal": None}]

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: list(plan))
    monkeypatch.setattr(m, "client_for", lambda model: object())

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    return m, calls


def _run(m, task):
    async def go():
        job = m.submit([task])
        return await asyncio.wait_for(m.wait(job.id, None), 10)
    return asyncio.run(go())


def test_an_unavailable_leg_fails_over_and_its_spend_is_kept(monkeypatch, tmp_path):
    dead = Result(id="t", status="error", error="openrouter API 404: 0 endpoints ... are available", cost_usd=0.001, turns=1, seconds=1.5,
                  usage={"in_hit": 0, "in_miss": 10, "out": 0, "reasoning": 0})
    good = Result(id="t", status="ok", answer="42", cost_usd=0.002, turns=2, seconds=2.0, usage={"in_hit": 5, "in_miss": 5, "out": 3, "reasoning": 1})
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash-or": dead, "deepseek-flash": good}, ["deepseek-flash-or", "deepseek-flash"])
    job = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}))
    r = job.results["t1"]
    assert calls == ["deepseek-flash-or", "deepseek-flash"]
    assert r.status == "ok" and r.answer == "42" and r.model == "deepseek-flash"
    assert r.failover == ["deepseek-flash-or"]
    assert r.cost_usd == pytest.approx(0.003) and r.turns == 3 and r.usage["in_miss"] == 15  # the dead leg was billed
    import json
    row = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()][-1]
    assert row["failover"] == "deepseek-flash-or" and row["model"] == "deepseek-flash"


def test_a_pinned_routes_next_leg_continues_the_dead_legs_conversation(monkeypatch, tmp_path):
    # Until 2026-09-27 each leg of a pinned route began again from the prompt: the crawled leg's work was lost, and its
    # file edits were made a second time. The next leg now continues, carrying only fields every host accepts.
    slow = Result(id="t", status="error", error="SlowLeg: deepseek-flash-or averaged 50s a turn over 3 turns", turns=3, cost_usd=0.0)
    good = Result(id="t", status="ok", answer="42", turns=1, cost_usd=0.0)
    RESUMED.clear()
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash-or": slow, "deepseek-flash": good}, ["deepseek-flash-or", "deepseek-flash"])
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    assert calls == ["deepseek-flash-or", "deepseek-flash"] and r.status == "ok"
    assert RESUMED[0] is None
    assert [(msg["role"], msg["content"]) for msg in RESUMED[1]] == [("user", "x"), ("assistant", "deepseek-flash-or got here")]
    assert all("refusal" not in msg for msg in RESUMED[1])


def test_the_tasks_own_failure_is_not_retried_elsewhere(monkeypatch, tmp_path):
    own = Result(id="t", status="error", error="FAILED: the premise is wrong", cost_usd=0.001)
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash-or": own, "deepseek-flash": own}, ["deepseek-flash-or", "deepseek-flash"])
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    assert calls == ["deepseek-flash-or"] and r.failover == [] and r.error.startswith("FAILED")


def test_every_leg_down_returns_the_last_legs_error(monkeypatch, tmp_path):
    down = Result(id="t", status="error", error="deepseek API 503: unavailable")
    m, calls = _job_with(monkeypatch, tmp_path, {"a": down, "b": down}, ["a", "b"])
    config.MODELS["a"] = config.MODELS["b"] = {"provider": "deepseek"}
    try:
        r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    finally:
        config.MODELS.pop("a", None), config.MODELS.pop("b", None)
    assert calls == ["a", "b"] and r.status == "error" and r.failover == ["a"] and r.model == "b"


def test_a_prompt_too_large_for_a_legs_limit_fails_over_and_too_large_for_all_says_so(monkeypatch, tmp_path):
    """2026-09-24: 25 of 32 pilot tasks over ~8k tokens died on groq's free-tier 413 with `failover: []`,
    though the tool-free chain has a cerebras leg behind it. The request, not the leg, is too big there."""
    big = 'groq API 413: {"error":{"message":"Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 13666"}}'
    also = 'cerebras API 413: {"message":"Request too large: context length exceeded"}'
    m, calls = _job_with(monkeypatch, tmp_path, {"groq-gpt-oss-120b": _err(big), "cerebras-gpt-oss-120b": _err(also)},
                         ["groq-gpt-oss-120b", "cerebras-gpt-oss-120b"])
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    assert calls == ["groq-gpt-oss-120b", "cerebras-gpt-oss-120b"] and r.failover == ["groq-gpt-oss-120b"]
    assert r.status == "error" and r.error.startswith("PromptTooLarge:") and "every tool-free leg" in r.error


def test_a_pinned_task_never_fails_over(monkeypatch, tmp_path):
    """route=False (the bench) means exactly this model, even when it is down."""
    down = Result(id="t", status="error", error="deepseek API 503: unavailable")
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash": down}, ["deepseek-flash-or", "deepseek-flash"])
    # The model is named EXPLICITLY: this test is about pinning, not about whatever the default is. Since
    # 2026-09-20 an unnamed model is AUTO and resolves by tools (tools:"none" -> the tool-free default).
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", "route": False})).results["t1"]
    assert calls == ["deepseek-flash"] and r.failover == [] and r.status == "error"


def test_a_stalled_leg_fails_over_and_the_ledger_names_the_stall(monkeypatch, tmp_path):
    """client._post's read-timeout retry raises `... API 504: stalled: ...`, which leg_unavailable already
    treats like any other unavailable leg (see test_these_mean_the_leg_could_not_serve above) - this pins
    that a task recovering on its next leg still records WHICH leg stalled, in both the Result and the
    ledger row, not just the ones that ran out of legs and ended the whole task in "error"."""
    stalled = Result(id="t", status="error", error="deepseek API 504: stalled: no reply within 180s (read timeout, retried once)",
                      cost_usd=0.001, turns=2, seconds=360.0, usage={"in_hit": 0, "in_miss": 10, "out": 0, "reasoning": 0})
    good = Result(id="t", status="ok", answer="42", cost_usd=0.002, turns=1, seconds=2.0, usage={"in_hit": 5, "in_miss": 5, "out": 3, "reasoning": 1})
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash-or": stalled, "deepseek-flash": good}, ["deepseek-flash-or", "deepseek-flash"])
    job = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}))
    r = job.results["t1"]
    assert calls == ["deepseek-flash-or", "deepseek-flash"]
    assert r.status == "ok" and r.failover == ["deepseek-flash-or"] and r.stalled == ["deepseek-flash-or"]
    import json
    row = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()][-1]
    assert row["stalled"] == "deepseek-flash-or" and row["failover"] == "deepseek-flash-or"


def test_a_task_that_stalls_out_on_every_leg_names_the_stall_too(monkeypatch, tmp_path):
    stalled_a = Result(id="t", status="error", error="deepseek API 504: stalled: no reply within 180s (read timeout, retried once)")
    stalled_b = Result(id="t", status="error", error="openrouter API 504: stalled: no reply within 180s (read timeout, retried once)")
    m, calls = _job_with(monkeypatch, tmp_path, {"a": stalled_a, "b": stalled_b}, ["a", "b"])
    config.MODELS["a"] = config.MODELS["b"] = {"provider": "deepseek"}
    try:
        r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    finally:
        config.MODELS.pop("a", None), config.MODELS.pop("b", None)
    assert calls == ["a", "b"] and r.status == "error" and r.failover == ["a"] and r.stalled == ["a", "b"]


def test_a_leg_with_no_key_at_all_fails_over(monkeypatch, tmp_path):
    good = Result(id="t", status="ok", answer="ok")
    m, calls = _job_with(monkeypatch, tmp_path, {"deepseek-flash": good}, ["deepseek-flash-or", "deepseek-flash"])

    def client_for(model):
        if model == "deepseek-flash-or":
            raise RuntimeError("No openrouter API key found.")
        return object()

    monkeypatch.setattr(m, "client_for", client_for)
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})).results["t1"]
    assert calls == ["deepseek-flash"] and r.status == "ok" and r.failover == ["deepseek-flash-or"]


def test_an_ask_hands_its_whole_budget_to_the_route_walk(monkeypatch):
    # Dredd's board secretary asked for 300 s and every leg still got a share of 120 (ask_selected's default): the
    # door took no budget, and two Lift boards sat for nothing on 2026-09-29 while NVIDIA crawled.
    import hswarm.mcp_server as ms

    seen = {}

    class _Mgr:
        async def ask_routed(self, prompt, model, **kw):
            seen.update(kw)
            return Result(id="ask", model="m", status="ok", answer="ok", cost_usd=0.0, seconds=0.1)

    async def _no_booking(results, kind):
        return {}

    monkeypatch.setattr(ms, "manager", lambda: _Mgr())
    monkeypatch.setattr(ms, "_book_asks", _no_booking)
    asyncio.run(ms.hswarm_ask("q", timeout_s=300))
    assert seen["timeout_s"] == 300.0
    seen.clear()
    asyncio.run(ms.hswarm_ask("q"))
    assert "timeout_s" not in seen  # no budget given: the walk keeps its own default


def test_a_one_shot_ask_fails_over_the_same_way(monkeypatch, tmp_path):
    """hswarm_ask and `hswarm ask` route and fail over like a job task: only on an unavailable path."""
    import hswarm.agent as agent

    seen = []

    async def fake_ask(client, prompt, model=None, **kw):
        seen.append(model)
        if model == "deepseek-flash-hf":
            return Result(id="ask", model=model, status="error", error="huggingface API 503: overloaded", cost_usd=0.0, seconds=0.5)
        return Result(id="ask", model=model, status="ok", answer="391", cost_usd=0.00001, seconds=1.0)

    monkeypatch.setattr(agent, "ask", fake_ask)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash-hf", "deepseek-flash-or"])
    monkeypatch.setattr(m, "client_for", lambda model: object())
    r = asyncio.run(m.ask_routed("17*23?", "deepseek-flash"))
    assert seen == ["deepseek-flash-hf", "deepseek-flash-or"] and r.status == "ok"
    assert r.failover == ["deepseek-flash-hf"] and r.seconds == pytest.approx(1.5)
    # route=False: exactly the model, no plan consulted
    seen.clear()
    r = asyncio.run(m.ask_routed("17*23?", "deepseek-flash-hf", route=False))
    assert seen == ["deepseek-flash-hf"] and r.status == "error" and r.failover == []
    # the caller's own mistake is not retried: every leg of a typed-only model refuses a chat the same way (a one-shot
    # ask's 400 is no such thing: it comes before anything was served, so the next leg gets it)
    async def own_fail(client, prompt, model=None, **kw):
        seen.append(model)
        return Result(id="ask", model=model, status="error", error="ValueError: rank:jev answers typed questions only "
                      "(pick one, yes/no, rate on a scale); ask it through hswarm_decide, and give a task a chat model")
    seen.clear()
    monkeypatch.setattr(agent, "ask", own_fail)
    r = asyncio.run(m.ask_routed("x", "deepseek-flash"))
    assert seen == ["deepseek-flash-hf"] and r.failover == []


# --- cc tasks fail over too (2026-09-17: the DeepSeek keys will not be topped up again) ---------------------


def _cc_job(monkeypatch, tmp_path, plan, pools):
    from types import SimpleNamespace

    used: list[tuple[str, str]] = []

    async def fake_cc(task, api_key, after=None):
        used.append((task.model, api_key))
        return Result(id=task.id, backend="cc", model=task.model, status="ok", answer="done", cost_usd=0.01), {"exit": 0}

    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    monkeypatch.setattr(jobs, "run_cc_task", fake_cc)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model, backend="api": list(plan))
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=pools[model]))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    return m, used


def test_a_cc_task_fails_over_to_hugging_face_when_no_deepseek_key_is_left(monkeypatch, tmp_path):
    from hswarm.client import KeyPool

    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    ds, hf = KeyPool(["sk-ds-1"]), KeyPool(["hf_tok_1"], provider="huggingface")
    ds.broke("sk-ds-1")
    m, used = _cc_job(monkeypatch, tmp_path, ["deepseek-flash", "deepseek-flash-hf", "deepseek-flash-or"],
                      {"deepseek-flash": ds, "deepseek-flash-hf": hf})
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", "tools": "none", "model": "deepseek-flash"})).results["t1"]
    assert used == [("deepseek-flash-hf", "hf_tok_1")]  # the disabled DeepSeek key never launched a process
    assert r.status == "ok" and r.model == "deepseek-flash-hf" and r.failover == ["deepseek-flash"], r.as_dict()


def test_a_cc_route_skips_a_provider_claude_code_cannot_talk_to(monkeypatch, tmp_path):
    from hswarm.client import KeyPool

    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    ds = KeyPool(["sk-ds-1"])
    ds.broke("sk-ds-1")
    config.MODELS["x-no-anthropic"] = {"provider": "moonshot"}  # an OpenAI-only endpoint
    try:
        m, used = _cc_job(monkeypatch, tmp_path, ["deepseek-flash", "x-no-anthropic"], {"deepseek-flash": ds})
        r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", "tools": "none", "model": "deepseek-flash"})).results["t1"]
    finally:
        config.MODELS.pop("x-no-anthropic", None)
    assert used == [] and r.status == "error" and "NoUsableKey" in (r.error or "") and r.failover == [], r.as_dict()


def test_a_cc_worker_on_hugging_face_gets_its_endpoint_its_bearer_token_and_the_pinned_model(monkeypatch, tmp_path):
    from hswarm import claude_env

    monkeypatch.setattr(config, "CC_CONFIG_DIR", tmp_path / "cc")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "the-operators-own")
    env = claude_env.cc_env("hf_tok", "deepseek-flash-hf")
    assert env["ANTHROPIC_BASE_URL"] == "https://router.huggingface.co"
    assert env["ANTHROPIC_AUTH_TOKEN"] == "hf_tok" and "ANTHROPIC_API_KEY" not in env  # the operator's key never leaks in
    pinned = "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra"
    assert env["ANTHROPIC_MODEL"] == env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == env["ANTHROPIC_SMALL_FAST_MODEL"] == pinned
    assert claude_env.cc_model_id("deepseek-flash-hf") == pinned
    orr = claude_env.cc_env("sk-or", "deepseek-flash-or")
    assert orr["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api" and orr["ANTHROPIC_MODEL"] == "deepseek/deepseek-v4.1-flash"
    # DeepSeek itself is exactly as before.
    ds = claude_env.cc_env("sk-ds")
    assert ds["ANTHROPIC_BASE_URL"] == config.PROVIDERS["deepseek"]["anthropic_url"] and ds["ANTHROPIC_API_KEY"] == "sk-ds" and "ANTHROPIC_AUTH_TOKEN" not in ds
    assert ds["ANTHROPIC_MODEL"] == "deepseek-flash" and claude_env.cc_model_id("deepseek-flash") == "deepseek-flash"
    config.MODELS["x-no-anthropic"] = {"provider": "moonshot"}
    try:
        with pytest.raises(RuntimeError, match="cannot run cc"):
            claude_env.cc_env("k", "x-no-anthropic")
    finally:
        config.MODELS.pop("x-no-anthropic", None)


def test_a_cc_worker_gets_no_operator_credential_even_when_the_allowlist_is_widened(monkeypatch, tmp_path):
    # cc_env used to copy os.environ minus only CLAUDE_*/ANTHROPIC_*: a DeepSeek-driven Claude Code with a
    # shell got every other provider key and cloud credential. Widening to everything must not undo that.
    from hswarm import claude_env

    monkeypatch.setattr(config, "CC_CONFIG_DIR", tmp_path / "cc")
    monkeypatch.setenv("GITHUB_TOKEN", "leak")
    monkeypatch.setenv("GEMINI_API_KEY", "leak")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "leak")
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://operator.example")
    env = claude_env.cc_env("sk-ds")
    assert "leak" not in env.values() and env["ANTHROPIC_API_KEY"] == "sk-ds" and "PATH" in {k.upper() for k in env}
    monkeypatch.setenv("HSWARM_CHILD_ENV_ALLOW", ".*")
    monkeypatch.setenv("SOME_TOOL_DIR", "/opt/tool")
    widened = claude_env.cc_env("sk-ds")
    assert "leak" not in widened.values() and "CLAUDECODE" not in {k.upper() for k in widened}
    assert widened["ANTHROPIC_BASE_URL"] == config.PROVIDERS["deepseek"]["anthropic_url"] and "/opt/tool" in widened.values()


def test_a_crawling_leg_fails_over_and_only_a_leg_with_somewhere_to_go_is_timed(monkeypatch, tmp_path):
    """2026-09-22: at concurrency 48 the free gemini leg answered at ~60 s a turn and 47 of 48 tasks timed out on it."""
    SLOWS.clear()
    slow = Result(id="t", status="error", error="SlowLeg: gemini-3.8-flash averaged 58s a turn over 3 turns (budget 30s)", cost_usd=0.0, turns=3, seconds=174.0)
    good = Result(id="t", status="ok", answer="done", cost_usd=0.001, turns=2, seconds=10.0)
    m, calls = _job_with(monkeypatch, tmp_path, {"gemini-3.8-flash": slow, "deepseek-flash-or": good}, ["gemini-3.8-flash", "deepseek-flash-or"])
    r = _run(m, Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "gemini-3.8-flash"})).results["t1"]
    assert calls == ["gemini-3.8-flash", "deepseek-flash-or"] and r.status == "ok" and r.failover == ["gemini-3.8-flash"]
    assert SLOWS == [config.SLOW_LEG_TURN_S, None], "the last leg has nowhere to go, so it is never timed"
    assert r.turns == 5 and r.seconds == pytest.approx(184.0)  # the slow leg's turns and time are kept


def test_a_route_cut_short_by_missing_credit_fails_fast_with_one_message(monkeypatch, tmp_path):
    """2026-09-24, job 20260924-200352-b60d: every OpenRouter key out of credit left gemini-3.8-flash as the tool
    route's only leg, and the last leg was never timed, so 105 of 140 tasks sat the full 600 s. Its next leg is
    the caller's own model now: the leg is timed, the first trip stops its siblings, and a later job does not call it."""
    calls: list[str] = []

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        calls.append(task.model)
        if slow_turn_s is None:  # untimed, the crawl runs into the task's own budget
            return Result(id=task.id, backend="api", model=task.model, status="timeout", error="task exceeded 600s"), []
        if not is_pilot:
            await warm.wait()
            await asyncio.sleep(3600)  # crawling; only a trip ends this
        await asyncio.sleep(0.05)
        return Result(id=task.id, backend="api", model=task.model, status="error", turns=3,
                      error="SlowLeg: gemini-3.8-flash averaged 58s a turn over 3 turns (budget 30s)"), []

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    monkeypatch.setattr(jobs, "_TRIPS", {}, raising=False)
    monkeypatch.setattr(jobs.keys, "has_credit", lambda provider: provider != "openrouter")
    monkeypatch.setattr(jobs.keys, "pool_for", lambda provider: None)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["gemini-3.8-flash"])  # deepseek-flash-or dropped: no credit
    monkeypatch.setattr(m, "client_for", lambda model: object())

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    tasks = [Task.from_dict({"id": f"t{i}", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "gemini-3.8-flash"}, {}, i) for i in range(3)]

    async def go():
        first = m.submit(tasks)
        await asyncio.wait_for(m.wait(first.id, None), 5)
        with pytest.raises(ValueError) as refused:  # a later job is refused at submit, before any task runs
            m.submit([Task.from_dict({"id": "u", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "gemini-3.8-flash"})])
        return first, str(refused.value)

    job, later = asyncio.run(go())
    errors = {r.error for r in job.results.values()}
    assert [r.status for r in job.results.values()] == ["error"] * 3 and len(errors) == 1
    msg = errors.pop()
    assert msg.startswith("NoCreditLeft:") and "deepseek-flash-or" in msg and job.summary()["error"] == msg
    # Only the pilot ever calls the leg: its siblings wait for the pilot before taking a gate slot (jobs._run_legs),
    # so the trip reaches them before their first call, and the later job is refused at submit.
    assert later.startswith("NoCreditLeft:") and "tripped" in later and calls == ["gemini-3.8-flash"], "a tripped leg is not called again"


def test_a_pinned_task_whose_route_gives_out_goes_on_by_its_profile(monkeypatch, tmp_path):
    """Owner, 2026-09-25: hswarm deals with dead keys itself. 15 of 67 builders pinned to gemini-3.8-flash died
    PoolSaturated with "no other leg" while the same work on the code profile ran; a pinned model is a preference,
    so a routed task goes on by its profile. A strict pin (route=False, an A/B arm) still reports its own leg."""
    import hswarm.agent as agent
    from hswarm import dispatch

    async def pinned_leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.01, turns=1,
                      error="gemini API 429: PoolSaturated: every gemini key is rate-limited and the task has no other leg"), []

    async def profile_leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="done", cost_usd=0.02, turns=2), []

    monkeypatch.setattr(jobs, "run_api_task", pinned_leg)
    monkeypatch.setattr(agent, "run_api_task", profile_leg)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {
        "profile": task.profile, "candidates": [{"model": m, "reasoning_effort": "high", "thinking": True}
                                                for m in ("rank:glm-5-3",) if m not in task.exclude_models]})
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["gemini-3.8-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=None))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    spec = {"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "gemini-3.8-flash"}
    tasks = [Task.from_dict({**spec, "id": "routed"}, {}, 0), Task.from_dict({**spec, "id": "strict", "route": False}, {}, 1)]

    async def go():
        job = m.submit(tasks)
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    job = asyncio.run(go())
    routed, strict = job.results["routed"], job.results["strict"]
    assert routed.status == "ok" and routed.model == "rank:glm-5-3" and "gemini-3.8-flash" in routed.failover
    assert routed.selection["unpinned_from"] == "gemini-3.8-flash" and abs(routed.cost_usd - 0.03) < 1e-9
    assert strict.status == "error" and "PoolSaturated" in strict.error and strict.model == "gemini-3.8-flash"


def test_a_task_every_route_failed_rests_and_runs_again(monkeypatch, tmp_path):
    """Owner, 2026-09-25: "rerun them if they're dead." A task whose whole ladder could not serve comes back only
    after hswarm has rested and tried it again with the budget it has left, and the time its calls sat on 429s is
    not taken off that budget (job 20260926-003426-92c1: 13 builders' run clocks spent on Gemini 429s)."""
    import hswarm.agent as agent
    from hswarm import dispatch

    outcomes = iter(["down", "ok"])

    async def leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        if next(outcomes) == "down":
            # Its whole clock went on rate-limited waits. (A 413 from its only leg is no longer this case: that
            # prompt fits no leg, so it fails at once as PromptTooLarge; see the test below.)
            return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.01, turns=1,
                          seconds=task.timeout_s, rested_s=task.timeout_s - 5,
                          error='groq API 429: {"error":{"message":"Rate limit reached for model qwen3"}}'), []
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="done", cost_usd=0.02, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", leg)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {
        "profile": task.profile, "candidates": [{"model": "rank:glm-5-3", "reasoning_effort": "high", "thinking": True}]})
    monkeypatch.setattr(config, "DEAD_RERUN_PATIENCE_S", 60.0)
    monkeypatch.setattr(config, "DEAD_RERUN_REST_S", 0.0)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=None))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    res = asyncio.run(go()).results["t"]
    assert res.status == "ok" and res.selection["dead_reruns"] == 1 and abs(res.cost_usd - 0.03) < 1e-9


def test_a_413_over_one_keys_org_limit_is_served_by_another_key_without_the_dead_rerun_rest(monkeypatch, tmp_path):
    """Jobs 20260926-050510-e32e and three siblings: Groq answered 413 "Request too large ... in organization ...
    on tokens per minute" for one key's org while keys of other orgs served the same size. The client raised it at
    once, the one-leg profile route came back dead, and every such task slept the dead-rerun rest in its job's
    concurrency slot, past its own timeout, at turns 0."""
    import httpx

    from hswarm import dispatch
    from hswarm.client import DeepSeekClient

    small_org, big_org = "sk-orgsmall0000xxxx", "sk-orgbig00000xxxx"
    seen: list[str] = []

    def handler(request):
        key = request.headers["Authorization"].removeprefix("Bearer ")
        seen.append(key)
        if key == small_org:
            return httpx.Response(413, json={"error": {
                "message": "Request too large for model `qwen/qwen3.8-27b` in organization `org_small` service tier "
                           "`on_demand` on tokens per minute (TPM): Limit 6000, Requested 9120, please reduce your message size",
                "type": "tokens", "code": "rate_limit_exceeded"}})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "done"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 9120, "completion_tokens": 1}, "model": "deepseek-flash"})

    c = DeepSeekClient(api_keys=[small_org, big_org])
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {
        "profile": task.profile, "candidates": [{"model": "deepseek-flash", "reasoning_effort": None, "thinking": None}]})
    # Production's rerun timings: the old code sleeps 150 s here, far past the wait below.
    monkeypatch.setattr(config, "DEAD_RERUN_PATIENCE_S", 3 * 3600.0)
    monkeypatch.setattr(config, "DEAD_RERUN_REST_S", 150.0)
    m = JobManager(client=c)

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "none"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    try:
        res = asyncio.run(go()).results["t"]
    except TimeoutError:
        pytest.fail(f"the task went to the dead-rerun rest instead of the other key (keys tried: {seen})")
    assert seen == [small_org, big_org], seen
    assert res.status == "ok" and res.answer == "done" and "dead_reruns" not in (res.selection or {}), res
    assert c.pool.available() == 2  # the small org's key is fine for a smaller request: neither rested nor disabled


def test_run_api_task_gives_up_a_crawling_leg_after_the_minimum_turns(tmp_path):
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    class Crawl:
        async def chat(self, messages, **kw):
            return ChatResult(message={"role": "assistant", "content": ""}, finish_reason="stop", usage=Usage(), model="slow",
                              seconds=40.0, cost_usd=0.0, peak=False)

    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(Crawl(), task, slow_turn_s=30.0))
    assert res.status == "error" and res.error.startswith("SlowLeg:") and res.turns == config.SLOW_LEG_MIN_TURNS
    assert leg_unavailable(res)
    # With no next leg (slow_turn_s None) the same crawl runs on to its own end - a slow answer beats none.
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(Crawl(), task))
    assert not (res.error or "").startswith("SlowLeg") and res.turns > config.SLOW_LEG_MIN_TURNS - 1


def test_a_reply_with_no_message_is_never_sent_back(tmp_path):
    """2026-09-27, jobs 20260927-211430-8b33 / -214105-1b87: gemini-3-8-flash answered one turn with a choice carrying
    no message; the loop appended it as `{}` (no role) ahead of its empty-answer nudge, and the next call died on gemini
    400 INVALID_ARGUMENT with the task's turns lost. The empty reply stays out of the transcript and the nudge joins the
    turn's user message, so the next call is well formed and the worker answers."""
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    class NothingThenAnswer:
        def __init__(self):
            self.replies, self.seen = [{}, {"role": "assistant", "content": "done"}], []

        async def chat(self, messages, **kw):
            self.seen.append([dict(m) for m in messages])
            return ChatResult(message=self.replies.pop(0), finish_reason="stop", usage=Usage(), model="m",
                              seconds=0.01, cost_usd=0.0, peak=False)

    fake = NothingThenAnswer()
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(fake, task))
    assert res.status == "ok" and res.answer == "done", res
    resent = fake.seen[1]
    assert all(m.get("role") for m in resent), resent
    assert not any(a["role"] == b["role"] == "user" for a, b in zip(resent, resent[1:])), resent
    assert agent.EMPTY_NUDGE in resent[-1]["content"]


def test_a_slow_call_marks_its_model_and_a_hung_call_to_a_marked_model_is_cut(monkeypatch, tmp_path):
    # The turn average only judges turns that ended, so hung calls held their tasks for the provider's own timeout
    # three times over (DeepSeek V4.1 Flash on NVIDIA, 120-300 s a call, 2026-09-27). One slow turn now marks the
    # model for every task at once, and a call to a marked model on a leg with somewhere to go is cut and resent by the
    # next leg. A slow call to an unmarked model that has already answered on this leg is left to finish: a healthy
    # model writing a large file can take that long. Its FIRST call is cut like a marked one (2026-09-28: a pilot's first
    # call to Kimi K3 on NVIDIA sat 190 s unanswered): a model that has not answered once has shown nothing to wait for.
    import hswarm.agent as agent
    from hswarm import selection
    from hswarm.usage import ChatResult, Usage

    (tmp_path / "evidence.txt").write_text("x\n", encoding="utf-8")

    class Slow:
        def __init__(self, wait, first=None):
            self.wait, self.first, self.turns = wait, wait if first is None else first, 0

        async def chat(self, messages, **kw):
            self.turns += 1
            if self.turns == 1 and self.first != self.wait:
                await asyncio.sleep(self.first)
                call = {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "evidence.txt"}'}}
                return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                                  usage=Usage(), model="m", seconds=self.first, cost_usd=0.0, peak=False)
            await asyncio.sleep(self.wait)
            return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(), model="m",
                              seconds=self.wait, cost_usd=0.0, peak=False)

    monkeypatch.setattr(config, "SLOW_LEG_CALL_S", 0.05)
    task = Task.from_dict({"prompt": "the question", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(Slow(0.2, first=0.0), task, slow_turn_s=30.0))
    assert res.status == "ok" and res.answer == "done"  # unmarked and answered before: it finished
    assert selection.crawling("deepseek-flash")  # and its slow turn is news for everyone
    res, transcript = asyncio.run(agent.run_api_task(Slow(30), task, slow_turn_s=30.0))
    assert res.status == "error" and res.error.startswith("SlowLeg:") and "gave no reply" in res.error and leg_unavailable(res)
    assert any("the question" in str(m.get("content")) for m in transcript)
    selection.reset_load()
    res, _ = asyncio.run(agent.run_api_task(Slow(30), task, slow_turn_s=30.0))
    assert res.status == "error" and "gave no reply" in res.error  # unmarked, but its first call: cut all the same


def test_a_model_another_task_marked_crawling_is_left_after_one_slow_turn(tmp_path):
    # A job's tasks on a crawling model move together, instead of each paying SLOW_LEG_MIN_TURNS slow turns first.
    import hswarm.agent as agent
    from hswarm import selection
    from hswarm.usage import ChatResult, Usage

    class Crawl:
        async def chat(self, messages, **kw):
            return ChatResult(message={"role": "assistant", "content": ""}, finish_reason="stop", usage=Usage(), model="slow",
                              seconds=40.0, cost_usd=0.0, peak=False)

    selection.note_speed("deepseek-flash", SimpleNamespace(status="error", error="SlowLeg: another task", api_seconds=0, seconds=0, turns=1))
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(Crawl(), task, slow_turn_s=30.0))
    assert res.status == "error" and "marked crawling" in res.error and res.turns == 1
    # With nothing better ahead (every later leg crawling, saturated or broken) it stays and runs on: one Odin refresh
    # task left Kimi K3 at 32 s a turn, crossed a spend-blocked groq and two rate-limited Gemini legs, and died on its cap.
    res, _ = asyncio.run(agent.run_api_task(Crawl(), task, slow_turn_s=30.0, escape=lambda crawling_ok=False: False))
    assert not (res.error or "").startswith("SlowLeg") and res.turns > 1


def test_a_task_leaving_a_slow_leg_skips_the_legs_marked_crawling_since_it_started(monkeypatch, tmp_path):
    import hswarm.agent as agent
    from hswarm import dispatch, selection

    ran = []

    async def leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        ran.append(task.model)
        if task.model == "rank:glm-5-3-flash:nvidia":
            selection.note_crawl("rank:glm-5-3:nvidia")  # another task saw the next leg crawl meanwhile
            return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.0, turns=1,
                          error="SlowLeg: rank:glm-5-3-flash:nvidia averaged 40s a turn over 1 turns"), []
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="done", cost_usd=0.0, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", leg)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {"profile": "general", "candidates": [
        {"model": m, "provider": "nvidia", "free": True} for m in ("rank:glm-5-3-flash:nvidia", "rank:glm-5-3:nvidia", "rank:kimi-k3:nvidia")]})
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [])
    m = JobManager(client=object())
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=None))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "general"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    res = asyncio.run(go()).results["t"]
    assert ran == ["rank:glm-5-3-flash:nvidia", "rank:kimi-k3:nvidia"] and res.status == "ok", ran


def test_a_first_call_with_no_reply_leaves_even_when_every_later_leg_is_marked_crawling(monkeypatch, tmp_path):
    """2026-10-02, friction 8902b651ea37: the first-call cut asked for a later leg NOT marked crawling, so with every
    later leg marked it never fired, and tasks sat on GLM 5.3 Flash on NVIDIA with no reply until their own timeout
    (235 routed tasks, 2,017 minutes over 7 days, scripts/first_reply_wait.py). A crawling leg answers; this one has
    not, so the task moves at SLOW_LEG_CALL_S and the next leg resends the turn."""
    import hswarm.agent as agent  # noqa: F401 - the real worker loop runs both legs
    from hswarm import dispatch, selection
    from hswarm.usage import ChatResult, Usage

    class Hung:
        pool = None

        async def chat(self, messages, **kw):
            await asyncio.sleep(30)

    class Answers:
        pool = None

        def __init__(self):
            self.seen = []

        async def chat(self, messages, **kw):
            self.seen.append([dict(m) for m in messages])
            return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(),
                              model="m", seconds=0.01, cost_usd=0.0, peak=False)

    first, second = "rank:glm-5-3-flash:nvidia", "rank:glm-5-3:nvidia"
    later = Answers()
    clients = {first: Hung(), second: later}
    monkeypatch.setattr(config, "SLOW_LEG_CALL_S", 0.05)
    selection.note_crawl(second)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {"profile": "general", "candidates": [
        {"model": m, "provider": "nvidia", "free": True} for m in (first, second)]})
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [])
    monkeypatch.setattr(dispatch, "_memo_wake", lambda: (lambda provider: 0.0))  # the NVIDIA pool can take a call now
    m = JobManager(client=object())
    monkeypatch.setattr(m, "client_for", lambda model: clients[model])

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "the question", "cwd": str(tmp_path), "tools": "none", "profile": "general"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    res = asyncio.run(go()).results["t"]
    assert res.status == "ok" and res.model == second and res.failover == [first], res
    assert "gave no reply" in res.selection["attempts"][0]["error"]
    assert any("the question" in str(msg.get("content")) for msg in later.seen[0])


def test_a_task_replying_every_turn_is_never_listed_quiet_and_a_silent_one_is(monkeypatch, tmp_path):
    """2026-10-03: each reply stamped only the leg's own Result, never the job's row that status reads, so every task
    running past QUIET_TASK_S read as quiet however often it answered, and a chat cancelled a healthy 7-task job
    (20261003-002117-1fa4) at 374 s on it."""
    from hswarm import dispatch
    from hswarm.usage import ChatResult, Usage

    for n in range(8):
        (tmp_path / f"f{n}.txt").write_text(f"{n}", encoding="utf-8")

    class Steady:
        pool = None

        def __init__(self):
            self.turns = 0

        async def chat(self, messages, **kw):
            await asyncio.sleep(0.15)
            self.turns += 1
            if self.turns <= 8:
                call = {"id": f"c{self.turns}", "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path": "f%d.txt"}' % (self.turns - 1)}}
                return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                                  usage=Usage(), model="m", seconds=0.15, cost_usd=0.0, peak=False)
            return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(),
                              model="m", seconds=0.15, cost_usd=0.0, peak=False)

    class Silent:
        pool = None

        async def chat(self, messages, **kw):
            await asyncio.sleep(30)

    # Replies 0.15 s apart against a 1 s quiet bar: quiet ages round to 0.1 s, so 0.05 s against 0.2 s left a busy box
    # one 0.1 s scheduling stall from a false "quiet" (seen under a loaded full-suite run, 2026-10-03).
    monkeypatch.setattr(config, "QUIET_TASK_S", 1.0)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {"profile": "general", "candidates": [
        {"model": "rank:glm-5-3:nvidia", "provider": "nvidia", "free": True}]})
    monkeypatch.setattr(dispatch, "rescue_legs", lambda task, plan: [])
    m = JobManager(client=object())
    fake = [None]
    monkeypatch.setattr(m, "client_for", lambda model: fake[0])

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def watch(client, for_s):
        fake[0] = client
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "general"}, {}, 0)])
        loop = asyncio.get_running_loop()
        start, samples = loop.time(), []
        while loop.time() - start < for_s and job.results["t"].status in ("pending", "running"):
            if job.results["t"].status == "running":
                samples.append((loop.time() - start, job.quiet_running()))
            await asyncio.sleep(0.02)
        if job.results["t"].status == "running" and isinstance(client, Silent):
            m.cancel(job.id)
        else:
            # A hang guard only: nine 0.15 s turns finish in about 2 s alone, but a loaded full-suite run (2026-10-09)
            # was still on them 10 s in.
            await asyncio.wait_for(m.wait(job.id, None), 60)
        return job, samples

    job, samples = asyncio.run(watch(Steady(), 5))
    assert job.results["t"].status == "ok" and job.results["t"].turns == 9, job.results["t"]
    assert any(t > 1.1 for t, _ in samples), samples  # it ran past QUIET_TASK_S
    assert not any(q for _, q in samples), samples  # and replying all the while, it was never quiet
    _, samples = asyncio.run(watch(Silent(), 1.4))
    assert "t" in samples[-1][1], samples  # no reply at all: quiet


def test_a_task_whose_own_routes_crawl_moves_one_profile_down_and_keeps_its_transcript(monkeypatch, tmp_path):
    """Owner, 2026-09-27: a check crawling on a slow model moves to another model and loses nothing. The code
    profile's only live route was its LAST leg, which ran untimed: 18 refresh tasks sat on GLM 5.3 for 17 minutes."""
    import hswarm.agent as agent
    from hswarm import dispatch

    seen = []

    async def leg(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, resume_messages=None, **kw):
        seen.append((task.model, slow_turn_s, resume_messages))
        if task.model == "rank:glm-5-3:nvidia":
            return Result(id=task.id, backend="api", model=task.model, status="error", cost_usd=0.0, turns=3, seconds=150.0,
                          error="SlowLeg: rank:glm-5-3:nvidia averaged 50s a turn over 3 turns"), [
                {"role": "user", "content": "x"}, {"role": "assistant", "content": "halfway"}]
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="done", cost_usd=0.0, turns=1), []

    monkeypatch.setattr(agent, "run_api_task", leg)
    monkeypatch.setattr(dispatch, "plan_for", lambda task, explain=False: {
        "profile": "code", "candidates": [{"model": "rank:glm-5-3:nvidia", "provider": "nvidia", "free": True}]})
    monkeypatch.setattr(dispatch, "_plan_here", lambda profile, **kw: {
        "profile": profile, "candidates": [{"model": "rank:kimi-k3:nvidia", "provider": "nvidia", "free": True}]})
    m = JobManager(client=object())
    monkeypatch.setattr(m, "client_for", lambda model: SimpleNamespace(pool=None))

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)

    async def go():
        job = m.submit([Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "code"}, {}, 0)])
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    res = asyncio.run(go()).results["t"]
    assert res.status == "ok" and res.model == "rank:kimi-k3:nvidia" and res.failover == ["rank:glm-5-3:nvidia"], res
    assert res.selection["below_floor"] == "general"
    (_, own_timer, _), (_, _, resumed) = seen
    assert own_timer == config.SLOW_LEG_TURN_S  # timed now: a leg follows it
    assert [msg["content"] for msg in resumed] == ["x", "halfway"]


def test_a_task_whose_own_routes_fail_walks_every_profile_below_to_the_bottom(monkeypatch, tmp_path):
    """Owner, 2026-09-28: "always move on to the next model that is still capable ... until you've hit the bottom of
    the barrel". The rescue went one profile down, so a critical task with a live critical route never reached
    general's Gemini and Kimi routes; tool work still stops above routine, which is tool-free only."""
    from hswarm import dispatch

    legs = {"critical": ["rank:claude-opus-5-5"], "code": ["rank:glm-5-3:nvidia"],
            "general": ["rank:glm-5-3:nvidia", "rank:kimi-k3:nvidia", "rank:gemini-3-8-flash:direct"],
            "routine": ["rank:gpt-oss-120b:groq"]}
    monkeypatch.setattr(dispatch, "_plan_here", lambda profile, **kw: {"profile": profile, "candidates": [
        {"model": m, "provider": config.provider_of(m), "free": False} for m in legs[profile]]})
    task = Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "critical"}, {}, 0)
    rescue = dispatch.rescue_legs(task, {"profile": "critical", "candidates": [{"model": "rank:claude-opus-5-5"}]})
    assert [(c["model"], c["rescue"]) for c in rescue] == [
        ("rank:glm-5-3:nvidia", "code"), ("rank:kimi-k3:nvidia", "general"), ("rank:gemini-3-8-flash:direct", "general")]


def test_a_task_that_hits_its_wall_hands_back_what_it_gathered(tmp_path):
    """2026-09-24, job 20260924-234903-1c5b: 20 tasks timed out after ~9 turns and 11 tool calls each and came
    back with an empty answer. The turns it spent now come back as a PARTIAL answer; the status stays timeout."""
    import hswarm.agent as agent
    from hswarm.usage import ChatResult, Usage

    (tmp_path / "evidence.txt").write_text("the line that matters\n", encoding="utf-8")

    class ThenHang:
        turns = 0

        async def chat(self, messages, **kw):
            self.turns += 1
            if self.turns > 1:
                await asyncio.sleep(3600)
            call = {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "evidence.txt"}'}}
            return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                              usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)

    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash"})
    task.timeout_s = 0.5
    res, _ = asyncio.run(agent.run_api_task(ThenHang(), task))
    assert res.status == "timeout" and res.answer.startswith("PARTIAL")
    assert "read_file" in res.answer and "the line that matters" in res.answer



def test_a_pilot_that_fails_before_its_first_reply_does_not_strand_the_job(monkeypatch, tmp_path):
    """Every api task but the pilot waits for the pilot's first reply (it lands the shared prefix in the cache).
    The real agent loop sets that event only after a SUCCESSFUL reply, so a pilot that failed first (an error,
    no key, every leg down) left the rest of the job waiting until each task's own timeout, with 0 calls made -
    the 900 s zero-call gemini timeouts seen on 2026-09-24. A finished pilot must release the others either way."""

    async def fake_run(client, task, warm=None, is_pilot=False, user_tag=None, slow_turn_s=None, **kw):
        if warm is not None and not is_pilot:
            await warm.wait()  # what agent._loop does before its first call
        if is_pilot:  # fails before any reply, so, like the real loop, it never sets `warm`
            return Result(id=task.id, backend="api", model=task.model, status="error", error="deepseek API 400: bad request"), []
        return Result(id=task.id, backend="api", model=task.model, status="ok", answer="done", turns=1), []

    monkeypatch.setattr(jobs, "run_api_task", fake_run)
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash"])
    monkeypatch.setattr(m, "client_for", lambda model: object())

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    tasks = [Task.from_dict({"id": f"t{i}", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "gemini-3.8-flash"}, {}, i) for i in range(3)]

    async def go():
        job = m.submit(tasks)
        return await asyncio.wait_for(m.wait(job.id, None), 5)

    job = asyncio.run(go())
    statuses = sorted(r.status for r in job.results.values())
    assert statuses == ["error", "ok", "ok"], statuses
