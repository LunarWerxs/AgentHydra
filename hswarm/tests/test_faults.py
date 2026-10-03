"""Offline: an armed fault (hswarm/faults.py) fails exactly the call it names, before any request is sent,
and a routed ask walks to its next leg on it.

Contract: `nth=N` fails the Nth matching call and no other; the failure is raised inside ChatClient.chat before
the HTTP request, so the fake transport never sees it; an unavailable-shaped fault (503) fails a routed ask over
to the next leg, while a 400-shaped one (the task's own failure) does not. Regression it catches: the hook
dropped from ChatClient.chat, or a counter that fires on every call instead of the Nth.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import faults  # noqa: E402
from hswarm.client import ChatClient  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402


def _client(provider: str, sent: list[str]) -> ChatClient:
    def handler(req: httpx.Request):
        sent.append(provider)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 2}})

    c = ChatClient(api_keys=["sk-test-1"], provider=provider)
    c._http = httpx.AsyncClient(base_url=c.spec["base_url"], transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def test_nth_fails_exactly_that_call_before_the_request_is_sent():
    sent: list[str] = []
    c = _client("deepseek", sent)
    f = faults.arm(provider="deepseek", nth=2)
    msgs = [{"role": "user", "content": "x"}]
    asyncio.run(c.chat(msgs, model="deepseek-flash"))
    with pytest.raises(ApiError) as e:
        asyncio.run(c.chat(msgs, model="deepseek-flash"))
    assert e.value.status == 503 and "injected fault" in str(e.value)
    asyncio.run(c.chat(msgs, model="deepseek-flash"))
    assert sent == ["deepseek", "deepseek"] and (f.calls, f.failed) == (3, 1)


def test_the_env_spec_is_parsed_and_a_bad_one_is_loud(monkeypatch):
    monkeypatch.setenv(faults.ENV, "provider=openrouter,nth=3,times=2,status=429;probability=0.5,seed=7")
    armed = faults.armed()
    assert [(a["provider"], a["nth"], a["times_left"], a["status"]) for a in armed] == [("openrouter", 3, 2, 429), ("*", 0, 1, 503)]
    with pytest.raises(ValueError):
        faults.parse("provider=groq,nht=2")


def test_a_bad_env_spec_stays_loud_on_every_call(monkeypatch):
    # Regression: the value was marked seen before it parsed, so only the first reader got the ValueError and every
    # later check()/armed() ran silently on the previous specs - no drill, and doctor showed nothing.
    monkeypatch.setenv(faults.ENV, "provider=groq,nht=2")
    for _ in range(2):
        with pytest.raises(ValueError):
            faults.armed()
    with pytest.raises(ValueError):
        faults.check("groq", "groq-gpt-oss-120b")
    monkeypatch.setenv(faults.ENV, "provider=groq,nth=2,seed=7")
    assert [(a["provider"], a["nth"], a["seed"]) for a in faults.armed()] == [("groq", 2, 7)]


def _routed(monkeypatch, sent):
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: ["deepseek-flash", "deepseek-flash-or"])
    clients = {"deepseek-flash": _client("deepseek", sent), "deepseek-flash-or": _client("openrouter", sent)}
    monkeypatch.setattr(m, "client_for", lambda model: clients[model])
    return m


def test_an_injected_unavailable_leg_fails_a_routed_ask_over(monkeypatch):
    sent: list[str] = []
    m = _routed(monkeypatch, sent)
    faults.arm(provider="deepseek", nth=1)
    r = asyncio.run(m.ask_routed("17*23?", "deepseek-flash"))
    assert r.status == "ok" and r.failover == ["deepseek-flash"] and sent == ["openrouter"]


def test_an_injected_unavailable_leg_fails_a_job_task_over(monkeypatch, tmp_path):
    # The job path (JobManager._run_api_legs -> agent.run_api_task), not only ask_routed: the drill's real target.
    sent: list[str] = []
    m = _routed(monkeypatch, sent)

    async def no_probe(client):
        return None

    monkeypatch.setattr(m, "_park_broke_keys", no_probe)
    faults.arm(provider="deepseek", nth=1)

    async def go():
        job = m.submit([Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})])
        return await asyncio.wait_for(m.wait(job.id, None), 10)

    r = asyncio.run(go()).results["t1"]
    assert r.status == "ok" and r.failover == ["deepseek-flash"] and r.model == "deepseek-flash-or" and sent == ["openrouter"]


def test_an_injected_own_failure_is_not_failed_over(monkeypatch):
    sent: list[str] = []
    m = _routed(monkeypatch, sent)
    faults.arm(provider="deepseek", status=400)
    r = asyncio.run(m.ask_routed("17*23?", "deepseek-flash"))
    assert r.status == "error" and r.failover == [] and sent == []
