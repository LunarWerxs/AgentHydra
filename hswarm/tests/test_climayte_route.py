"""Offline: an agentic task asks AgentHydra where to run (climayte_route.py), against a fake AgentHydra on a free
local port. Nothing here reaches the real daemon on 7787: conftest blanks AGENTHYDRA_URL for every test."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import climayte_route, config  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402


class _Api:
    """The API route: answers 'api route' and counts its calls."""

    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        return ChatResult(message={"role": "assistant", "content": "api route"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.01, peak=False)

    async def aclose(self):
        pass


class _Fake:
    """A fake AgentHydra: /api/routing/decide, POST /api/corch/workers, GET /api/corch/workers/:id."""

    def __init__(self, route="subscription", worker=None, delay=0.0, decide_status=200, enabled=True, running_for=0.0):
        self.route, self.delay, self.decide_status, self.enabled = route, delay, decide_status, enabled
        self.running_for, self.t0 = running_for, time.monotonic()
        self.cancelled: list[str] = []
        self.worker = worker or {"status": "done", "result": "worker report", "reportedModel": "claude-sonnet-5-5"}
        self.decides: list[dict] = []
        self.dispatched: list[dict] = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, doc):
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path == "/api/routing/decide":
                    fake.decides.append(body)
                    time.sleep(fake.delay)
                    return self._send(fake.decide_status, {"route": fake.route, "why": "cheaper on the plan", "apiUsd": 1, "subscriptionUsd": 0.1, "close": False})
                if self.path == "/api/corch/workers":
                    fake.dispatched.append(body)
                    return self._send(200, {"group": body.get("group"), "workers": [{"id": "w1"}]})
                if self.path == "/api/corch/cancel":
                    fake.cancelled.append(body.get("id"))
                    return self._send(200, {"ok": True})
                self._send(404, {})

            def do_GET(self):
                if self.path == "/api/routing/cost-model":
                    return self._send(200, {"settings": {"enabled": fake.enabled}})
                if self.path == "/api/corch/workers/w1":
                    if time.monotonic() - fake.t0 < fake.running_for:
                        return self._send(200, {"id": "w1", "status": "running"})
                    return self._send(200, {"id": "w1", **fake.worker})
                self._send(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(climayte_route, "POLL_S", 0.01)
    monkeypatch.setattr(climayte_route, "_LOGGED", set())
    monkeypatch.setattr(climayte_route, "_ACTIVE", 0)
    monkeypatch.setattr(climayte_route, "_SWITCH", {"at": -1e9, "on": True})
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _run(tmp_path, tools="read", schema=None, timeout_s=30, n=1):
    api = _Api()
    specs = [{"id": f"t{i}", "prompt": "look at it", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "timeout_s": timeout_s} for i in range(n)]
    if schema:
        for spec in specs:
            spec["schema"] = schema

    async def go():
        return await JobManager(client=api).run_batch([Task.from_dict(spec, {}, i) for i, spec in enumerate(specs)], concurrency=n)

    job = asyncio.run(go())
    return job, job.results["t0"], api


def test_an_eligible_task_routed_to_the_subscription_returns_the_workers_report(fake, tmp_path):
    f = fake()
    job, res, api = _run(tmp_path, tools="edit")
    assert res.status == "ok" and res.answer == "worker report" and api.calls == 0
    assert res.model == "claude-sonnet-5-5"
    assert res.selection["route"] == {"provider": "climayte", "decided": "subscription", "why": "cheaper on the plan", "worker": "w1", "via": "climayte"}
    sent = f.dispatched[0]["tasks"][0]
    assert sent["kind"] == "code" and sent["cwd"] == str(tmp_path) and "look at it" in sent["prompt"]
    d = f.decides[0]
    assert d["key"] == f"{job.id}:t0" and d["subscriptionRoom"] is True and d["listUsd"] > 0
    # AgentHydra prices the plan side at CliMayte's own pick for this kind and size (owner, 2026-10-07).
    assert d["kind"] == "code" and d["tokens"]["input"] > 0 and d["tokens"]["output"] > 0
    assert d["api"]["model"] == "deepseek-flash" and d["api"]["provider"] == "deepseek"
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["provider"] == "climayte" and row["climayte_worker"] == "w1" and row["route_why"] == "cheaper on the plan"


@pytest.mark.parametrize("extra,tools,kind", [
    ({}, "edit", "code"),
    ({}, "all", "code"),
    ({"role": "review"}, "read", "review"),
    ({"role": "judge"}, "read", "review"),
    ({"role": "refute"}, "read", "review"),
    ({}, "read", "sweep"),
    ({"role": "summarize"}, "read", "sweep"),
])
def test_the_workers_kind_follows_the_task_so_read_only_work_stays_off_opus(fake, tmp_path, extra, tools, kind):
    f = fake()
    api = _Api()
    spec = {"id": "t0", "prompt": "look at it", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "timeout_s": 30, **extra}
    asyncio.run(JobManager(client=api).run_batch([Task.from_dict(spec, {}, 0)], concurrency=1))
    assert f.dispatched[0]["tasks"][0]["kind"] == kind


# Only an AUTO task keeps its profile (a pinned model, as the routed tests use, drops it), so the profile half of
# worker_kind is checked on the task as AUTO leaves it.
@pytest.mark.parametrize("profile,kind", [("critical", "review"), ("decision", "review"), ("research", "sweep"), ("code", "sweep")])
def test_an_auto_tasks_judging_profile_asks_for_review(profile, kind):
    assert climayte_route.worker_kind(Task(prompt="look at it", tools="read", profile=profile)) == kind


def test_a_schema_task_gets_the_workers_report_parsed(fake, tmp_path):
    fake(worker={"status": "done", "result": 'Done:\n```json\n{"n": 3}\n```', "reportedModel": "claude-sonnet-5-5"})
    _, res, api = _run(tmp_path, schema={"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]})
    assert res.status == "ok" and res.data == {"n": 3} and api.calls == 0


def test_a_tool_free_task_never_asks(fake, tmp_path):
    f = fake()
    _, res, api = _run(tmp_path, tools="none")
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_inside_a_climayte_worker_it_never_asks(fake, tmp_path, monkeypatch):
    f = fake()
    monkeypatch.setenv("AGENTHYDRA_CLIMAYTE_WORKER", "w9")
    _, res, api = _run(tmp_path)
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_the_setting_off_never_asks(fake, tmp_path, monkeypatch):
    f = fake()
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE", False)
    _, res, api = _run(tmp_path)
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_the_setting_reads_from_settings_toml(tmp_path):
    config._apply_settings({"route_via_climayte": False})
    assert config.ROUTE_VIA_CLIMAYTE is False
    config.reload()
    assert config.ROUTE_VIA_CLIMAYTE is True


def test_a_decide_that_times_out_keeps_the_api_route(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(climayte_route, "DECIDE_TIMEOUT_S", 0.2)
    f = fake(delay=1.0)
    _, res, api = _run(tmp_path)
    assert len(f.decides) == 1 and f.dispatched == []
    assert res.status == "ok" and res.answer == "api route" and api.calls == 1


def test_a_decide_that_errors_keeps_the_api_route(fake, tmp_path):
    f = fake(decide_status=500)
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and res.answer == "api route" and api.calls == 1


def test_a_failed_worker_falls_back_to_the_api_route_once(fake, tmp_path):
    f = fake(worker={"status": "failed", "result": None})
    _, res, api = _run(tmp_path)
    assert len(f.dispatched) == 1 and api.calls == 1
    assert res.status == "ok" and res.answer == "api route"
    assert res.selection["route"]["via"] == "api" and res.selection["route"]["climayte_failed"] == "w1"


def test_an_api_decision_runs_the_api_route_and_says_so(fake, tmp_path):
    f = fake(route="api")
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and api.calls == 1
    assert res.selection["route"] == {"via": "api", "decided": "api", "why": "cheaper on the plan"}


def test_a_request_carrying_the_worker_header_is_never_routed(fake, tmp_path):
    from hswarm import shared

    f = fake()
    tok = shared.REQUEST.set({"climayte_worker": "1"})
    try:
        _, res, api = _run(tmp_path)
    finally:
        shared.REQUEST.reset(tok)
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_over_the_cap_a_task_takes_its_api_route_without_asking(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE_MAX", 4)
    f = fake(running_for=0.5)
    job, _, api = _run(tmp_path, n=5)
    assert len(f.decides) == 4 and len(f.dispatched) == 4 and api.calls == 1
    assert sorted(r.answer for r in job.results.values()).count("api route") == 1


def test_a_worker_still_queued_at_the_start_deadline_is_cancelled_and_the_task_falls_back(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROUTE_VIA_CLIMAYTE_START_S", 0.05)
    f = fake(worker={"status": "queued"})
    _, res, api = _run(tmp_path)
    assert f.cancelled == ["w1"] and api.calls == 1
    assert res.answer == "api route" and res.selection["route"]["climayte_not_started"] == "w1"


def test_an_unpriced_model_never_asks(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(climayte_route, "_usd", lambda model: None)
    f = fake()
    _, res, api = _run(tmp_path)
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_agenthydras_switch_off_means_no_decide_call(fake, tmp_path):
    f = fake(enabled=False)
    _, res, api = _run(tmp_path)
    assert f.decides == [] and res.answer == "api route" and api.calls == 1


def test_a_task_whose_plan_is_below_its_floor_goes_to_climayte_without_a_price_question(fake, tmp_path, monkeypatch):
    # No live route meets its bar, so the API side has nothing to weigh: Claude on the subscription takes it.
    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route meets profile critical")
    f = fake(route="api")
    _, res, api = _run(tmp_path)
    assert f.decides == [] and len(f.dispatched) == 1 and api.calls == 0
    assert res.answer == "worker report"
    assert res.selection["route"]["decided"] == "subscription" and res.selection["route"]["why"] == "no live route meets profile critical"


def test_floor_miss_reads_the_plan(monkeypatch):
    from hswarm import dispatch

    task = Task(prompt="look at it", tools="read", profile="critical")
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": [{"model": "m"}], "below_floor": "code"})
    assert "stepped down to code" in climayte_route.floor_miss(task)
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": []})
    assert climayte_route.floor_miss(task) == "no live route can take profile critical"
    monkeypatch.setattr(dispatch, "plan_for", lambda t: {"candidates": [{"model": "m"}]})
    assert climayte_route.floor_miss(task) is None


def test_submit_never_refuses_a_task_climayte_can_take(fake, tmp_path, monkeypatch):
    from hswarm import dispatch, jobs

    monkeypatch.setattr(dispatch, "unreachable", lambda t: "every key disabled")
    fake()
    agentic = Task(prompt="look at it", id="a", tools="read", cwd=str(tmp_path), profile="critical")
    toolfree = Task(prompt="look at it", id="b", tools="none", profile="critical")
    assert jobs.unservable([agentic]) is None
    refusal = jobs.unservable([agentic, toolfree])
    assert refusal.startswith("NoCapableSwarmRoute") and "climayte_run" in refusal and "your own model" not in refusal
    monkeypatch.setattr(climayte_route, "_SWITCH", {"at": -1e9, "on": False})  # the owner's routing switch is off
    assert jobs.unservable([agentic]) is not None


def test_a_below_floor_task_climayte_cannot_take_is_refused_when_its_route_is_dead(fake, tmp_path, monkeypatch):
    # The switch is off, so no slot is waited for; its own route has nothing that serves, so it fails at once.
    from hswarm import jobs

    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route can take profile critical")
    monkeypatch.setattr(jobs, "no_route_left", lambda tasks: "NoCapableSwarmRoute: every key disabled" if tasks else None)
    f = fake(enabled=False)
    _, res, api = _run(tmp_path)
    assert f.dispatched == [] and api.calls == 0
    assert res.status == "error" and res.error.startswith("NoCapableSwarmRoute")
    assert res.selection["route"]["floor_miss"] == "no live route can take profile critical"


def test_a_below_floor_task_whose_worker_failed_runs_its_live_route_and_says_so(fake, tmp_path, monkeypatch):
    from hswarm import jobs

    monkeypatch.setattr(climayte_route, "floor_miss", lambda task: "no live route meets profile critical")
    monkeypatch.setattr(jobs, "no_route_left", lambda tasks: None)
    fake(worker={"status": "failed", "result": None})
    _, res, api = _run(tmp_path)
    assert api.calls == 1 and res.answer == "api route"
    assert res.selection["route"]["floor_miss"] == "no live route meets profile critical" and res.selection["route"]["climayte_failed"] == "w1"
