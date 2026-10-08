"""Offline: a tool-free task goes to the owner's Free web accounts first (free_route.py), against a fake AgentHydra on a
free local port. Nothing here reaches the real daemon on 7787: conftest blanks AGENTHYDRA_URL for every test."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, free_route  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402

ACCOUNTS = [{"account": "a1", "num": 1, "provider": "claude", "signedIn": True, "busy": False, "usage": 0, "threads": 0}]


class _Api:
    def __init__(self):
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        return ChatResult(message={"role": "assistant", "content": "api route"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.01, peak=False)

    async def aclose(self):
        pass


class _Fake:
    """A fake AgentHydra: POST /api/mcp answering free_status, free_chat and free_results."""

    def __init__(self, accounts=None, reply="free answer", state="done"):
        self.accounts = ACCOUNTS if accounts is None else accounts
        self.reply, self.state = reply, state
        self.chats: list[dict] = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path != "/api/mcp":
                    return self._send(404, {})
                name, args = body["params"]["name"], body["params"]["arguments"]
                if name == "free_status":
                    out = {"ready": True, "accounts": fake.accounts, "running": 0}
                elif name == "free_chat":
                    fake.chats.append(args)
                    out = fake.batch()
                elif name == "free_results":
                    out = fake.batch()
                else:
                    return self._send(404, {})
                self._send(200, {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(out)}]}})

            def _send(self, status, doc):
                data = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def batch(self):
        one = {"task": 0, "state": self.state, "account": "a1", "chat_id": "c1", "response": self.reply, "model": "gpt-5-6-mini", "seconds": 1.0}
        return {"batch": "b1", "finished": self.state == "done", "done": 1, "tasks": [one]}

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
    made: list[_Fake] = []

    def make(**kw):
        f = _Fake(**kw)
        made.append(f)
        monkeypatch.setenv("AGENTHYDRA_URL", f.url)
        return f

    yield make
    for f in made:
        f.close()


def _task(**kw) -> Task:
    """A tool-free auto task as the planner leaves it: the plan's first concrete model AND its profile (a pinned task
    has no profile). Planning on auto needs keys, so the profile is set after a pinned build."""
    spec = {"id": "t0", "prompt": "say hi", "tools": "none", "model": "deepseek-flash", "timeout_s": 30, **kw}
    task = Task.from_dict(spec, {}, 0)
    if "model" not in kw:
        task.profile = "general"
    return task


def _consult(task):
    return asyncio.run(free_route.consult("j1", task))


def test_a_tool_free_task_is_answered_by_a_free_account(fake):
    f = fake()
    res, note = _consult(_task())
    assert note is None and res.status == "ok" and res.answer == "free answer" and res.cost_usd == 0.0
    assert res.model == "free:gpt-5-6-mini"
    assert res.selection["route"]["via"] == "free" and res.selection["route"]["account"] == "a1" and res.selection["route"]["chat_id"] == "c1"
    assert f.chats[0]["tasks"][0]["name"] == "hswarm j1 t0" and "say hi" in f.chats[0]["tasks"][0]["prompt"]


def test_only_narrow_profiles_ask_for_haiku(fake):
    f = fake()
    for profile in ("routine", "general", "research", "decision"):
        task = _task()
        task.profile = profile
        _consult(task)
    assert [c["tasks"][0].get("model") for c in f.chats] == ["haiku", "haiku", None, None]


def test_the_ledger_line_of_a_free_task_has_provider_free_and_no_cost(fake, monkeypatch):
    fake()
    api = _Api()
    monkeypatch.setattr(free_route, "eligible", lambda task: True)  # the job's task is pinned (an auto one needs keys)
    job = asyncio.run(JobManager(client=api).run_batch([_task()], concurrency=1))
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert api.calls == 0 and job.results["t0"].answer == "free answer"
    assert row["provider"] == "free" and row["cost_usd"] == 0
    assert float(row["seconds"]) == 1.0  # the account's own time on it, from free_results


def test_hswarm_ask_on_auto_is_answered_by_a_free_account(fake, monkeypatch):
    from hswarm import mcp_server

    api = _Api()
    f = fake()
    monkeypatch.setattr(mcp_server, "manager", lambda: JobManager(client=api))
    out = asyncio.run(mcp_server.hswarm_ask("say hi"))
    assert out["status"] == "ok" and out["answer"] == "free answer" and out["model"] == "free:gpt-5-6-mini"
    assert api.calls == 0, "the API route ran although a free account was idle"
    row = json.loads(config.LEDGER.read_text(encoding="utf-8").splitlines()[-1])
    assert row["provider"] == "free" and row["cost_usd"] == 0
    # A thread name is unique on its account: one fixed name refused every ask after the first (2026-10-07).
    asyncio.run(mcp_server.hswarm_ask("say hi again"))
    names = [c["tasks"][0]["name"] for c in f.chats]
    assert len(names) == 2 and len(set(names)) == 2


def test_a_decide_escalation_on_auto_is_answered_by_a_free_account(fake):
    # hswarm_decide's escalations go through ask_routed, which never tried a Free account before 2026-10-08.
    api = _Api()
    f = fake()
    res = asyncio.run(JobManager(client=api).ask_routed("pick one", config.AUTO, profile="decision"))
    assert res.model == "free:gpt-5-6-mini" and api.calls == 0 and len(f.chats) == 1


def test_a_schema_tasks_json_reply_becomes_data(fake):
    f = fake(reply='```json\n{"n": 3}\n```')
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    res, _ = _consult(_task(schema=schema))
    assert res.data == {"n": 3}
    assert free_route.SCHEMA_LINE in f.chats[0]["tasks"][0]["prompt"]


def test_a_schema_reply_that_is_not_json_falls_back(fake):
    fake(reply="sure, here you go")
    schema = {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    res, _ = _consult(_task(schema=schema))
    assert res is None


def test_an_unreachable_daemon_falls_back_without_an_error(monkeypatch):
    monkeypatch.setenv("AGENTHYDRA_URL", "http://127.0.0.1:9")
    assert _consult(_task()) == (None, None)


def test_no_idle_account_falls_back_without_calling_free_chat(fake):
    f = fake(accounts=[{**ACCOUNTS[0], "busy": True}, {**ACCOUNTS[0], "signedIn": False},
                       {**ACCOUNTS[0], "resting": "until 2026-10-08T08:00:00Z after http_rejected (x1)"}])
    assert _consult(_task()) == (None, None)
    assert f.chats == []


def test_one_process_can_fill_every_idle_account(fake, monkeypatch):
    # Its own three tasks hold three accounts, which free_status already shows busy: the three idle ones are still
    # free to take work (comparing in-flight tasks with idle accounts stopped every process at half of them).
    f = fake(accounts=[{**ACCOUNTS[0], "busy": True}] * 3 + [ACCOUNTS[0]] * 3)
    monkeypatch.setattr(free_route, "_ACTIVE", 3)
    res, _ = _consult(_task())
    assert res is not None and len(f.chats) == 1


def test_tasks_reading_one_snapshot_take_its_one_idle_account_once(fake):
    # free_status cannot show a task sent a moment ago: two tasks that both read "one idle" must not both be sent.
    f = fake(accounts=[{**ACCOUNTS[0], "busy": True}] * 5 + [ACCOUNTS[0]])

    async def both():
        return await asyncio.gather(free_route.consult("j1", _task()), free_route.consult("j2", _task(id="t1")))

    results = asyncio.run(both())
    assert len(f.chats) == 1 and sum(r is not None for r, _ in results) == 1


def test_a_failed_free_task_hands_the_task_back(fake):
    fake(state="failed", reply="")
    res, note = _consult(_task())
    assert res is None and note["via"] == "api"


@pytest.mark.parametrize("kw,after", [
    ({"tools": "read"}, {}),
    ({}, {"zdr": True}),
    ({"model": "deepseek-flash"}, {}),
    ({}, {"profile": "critical"}),
    ({}, {"purpose": "evaluation"}),
])
def test_an_ineligible_task_is_never_sent(fake, kw, after):
    f = fake()
    task = _task(**kw)
    for k, v in after.items():
        setattr(task, k, v)
    assert _consult(task) == (None, None)
    assert f.chats == []
