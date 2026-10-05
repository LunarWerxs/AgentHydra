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

    def __init__(self, route="subscription", worker=None, delay=0.0, decide_status=200):
        self.route, self.delay, self.decide_status = route, delay, decide_status
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
                self._send(404, {})

            def do_GET(self):
                if self.path == "/api/corch/workers/w1":
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
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _run(tmp_path, tools="read", schema=None, timeout_s=30):
    api = _Api()
    spec = {"id": "t0", "prompt": "look at it", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "timeout_s": timeout_s}
    if schema:
        spec["schema"] = schema

    async def go():
        return await JobManager(client=api).run_batch([Task.from_dict(spec, {}, 0)], concurrency=1)

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
    assert d["api"]["model"] == "deepseek-flash" and d["api"]["provider"] == "deepseek"
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["provider"] == "climayte" and row["climayte_worker"] == "w1" and row["route_why"] == "cheaper on the plan"


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
