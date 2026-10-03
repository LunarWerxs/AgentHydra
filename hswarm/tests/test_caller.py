"""Offline: the caller stamp (who submitted a job) and the usage report built from it."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import caller, config  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.ledger import usage_report  # noqa: E402
from hswarm.spec import Task  # noqa: E402


class _FakeClient:
    def __init__(self, cost: float = 0.01):
        self.cost = cost

    async def chat(self, messages, **kw):
        await asyncio.sleep(0.01)
        return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=self.cost, peak=False)

    async def aclose(self):
        pass


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(config, "ROUTING", tmp_path / "routing.jsonl")


def _claude_env(monkeypatch, instance="temp2", session="abcdef12-0000-4000-8000-000000000000"):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", session)
    monkeypatch.setenv("CLAUDE_CODE_HOST_SESSION_ID", "local_chat_" + instance)
    monkeypatch.setenv("CLAUDE_CODE_EXECPATH", f"C:\\Users\\x\\.claude-instances\\{instance}\\claude-code\\2.1.270\\claude.exe")
    monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "claude-desktop")


def test_detect_reads_the_calling_session(monkeypatch):
    _claude_env(monkeypatch)
    c = caller.detect("my-label")
    assert c["instance"] == "temp2" and c["session_id"].startswith("abcdef12") and c["chat_id"] == "local_chat_temp2"
    assert c["entrypoint"] == "claude-desktop" and c["label"] == "my-label" and c["argv"] == ""
    assert caller.key(c) == "temp2 / abcdef12 / " + Path.cwd().name
    assert caller.ledger_fields(c) == {"caller_instance": "temp2", "caller_session": "abcdef12", "caller_cwd": str(Path.cwd()), "caller_model": ""}


def test_detect_outside_claude_records_argv_and_invents_nothing(monkeypatch):
    for k in ("CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_EXECPATH", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT"):
        monkeypatch.delenv(k, raising=False)
    c = caller.detect(argv=["hswarm.py", "run", "tasks.json"])
    assert c["instance"] == "" and c["session_id"] == "" and c["entrypoint"] == "cli" and c["argv"] == "hswarm.py run tasks.json"
    assert caller.key(c).startswith("- / - / ")


def test_job_and_ledger_carry_the_caller(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    _claude_env(monkeypatch, instance="funzypops")

    async def go():
        m = JobManager(client=_FakeClient())
        tasks = [Task.from_dict({"id": f"t{i}", "prompt": "x", "cwd": str(tmp_path), "tools": "none"}, {}, i) for i in range(2)]
        return await m.run_batch(tasks, label="unit-batch")

    job = asyncio.run(go())
    assert job.caller["instance"] == "funzypops" and job.caller["label"] == "unit-batch"
    on_disk = json.loads((config.JOBS_DIR / job.id / "job.json").read_text(encoding="utf-8"))
    assert on_disk["caller"]["instance"] == "funzypops" and on_disk["summary"]["caller"].startswith("funzypops / abcdef12 / ")
    rows = [json.loads(line) for line in (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2 and all(r["caller_instance"] == "funzypops" and r["caller_session"] == "abcdef12" for r in rows)


def test_usage_report_groups_by_caller_and_reads_the_routing_log(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    import datetime as dt

    ts = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    (config.JOBS_DIR / "job-a").mkdir(parents=True)
    (config.JOBS_DIR / "job-a" / "job.json").write_text(json.dumps({"summary": {"label": "copy-cut-pass1"}}), encoding="utf-8")
    lines = [
        {"ts": ts, "job": "job-a", "task": "t1", "backend": "api", "model": "deepseek-flash", "status": "ok", "cost_usd": 0.01, "caller_instance": "temp2", "caller_session": "aaaaaaaa", "caller_cwd": "D:/x/Connections"},
        {"ts": ts, "job": "job-a", "task": "t2", "backend": "api", "model": "deepseek-flash", "status": "error", "cost_usd": 0.02, "caller_instance": "temp2", "caller_session": "aaaaaaaa", "caller_cwd": "D:/x/Connections"},
        {"ts": ts, "job": "ask", "task": "ask", "backend": "api", "model": "deepseek-flash", "status": "ok", "cost_usd": 0.001, "caller_instance": "work", "caller_session": "bbbbbbbb", "caller_cwd": "D:/x/MG_AI"},
        {"ts": ts, "job": "job-old", "task": "t1", "backend": "api", "model": "deepseek-flash", "status": "ok", "cost_usd": 0.005},
    ]
    config.LEDGER.write_text("\n".join(json.dumps(row) for row in lines) + "\n", encoding="utf-8")
    routing = [
        {"ts": ts, "session_id": "cccccccc-1", "instance": "temp2", "cwd": "D:/x/Connections", "tool": "Agent", "model": "sonnet", "agents": 1, "mechanical": "find every", "reason": "", "decision": "blocked"},
        {"ts": ts, "session_id": "cccccccc-1", "instance": "temp2", "cwd": "D:/x/Connections", "tool": "Workflow", "model": "opus", "agents": 3, "mechanical": "summarize each", "reason": "", "decision": "reminded"},
        {"ts": ts, "session_id": "dddddddd-2", "instance": "work", "cwd": "D:/x/MG_AI", "tool": "Agent", "model": "sonnet", "agents": 1, "mechanical": "", "reason": "needs the MCP", "decision": "allowed"},
    ]
    config.ROUTING.write_text("\n".join(json.dumps(r) for r in routing) + "\n", encoding="utf-8")

    rep = usage_report(hours=1)
    sw = rep["swarm"]
    assert sw["tasks"] == 4 and abs(sw["cost_usd"] - 0.036) < 1e-9
    by = {g["caller"]: g for g in sw["callers"]}
    a = by["temp2 / aaaaaaaa / Connections"]
    assert a["jobs"] == 1 and a["tasks"] == 2 and a["ok"] == 1 and a["error"] == 1 and a["labels"] == ["copy-cut-pass1"] and a["stamped"]
    b = by["work / bbbbbbbb / MG_AI"]
    assert b["asks"] == 1 and b["jobs"] == 0
    old = by["- / - / -"]
    assert not old["stamped"] and old["tasks"] == 1
    cf = rep["claude_fanouts"]
    assert cf["decisions"] == 3 and cf["blocked"] == 1 and cf["allowed"] == 1 and cf["reminded"] == 1
    assert [m["mechanical"] for m in cf["mechanical_but_claude"]] == ["summarize each"]
    assert cf["by_session"]["cccccccc"]["blocked"] == 1 and cf["by_session"]["cccccccc"]["agents"] == 3
    assert cf["by_session"]["dddddddd"]["allowed"] == 1


def test_usage_report_with_no_ledger_is_empty_not_fatal(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    rep = usage_report(hours=8)
    assert rep["swarm"]["tasks"] == 0 and rep["swarm"]["callers"] == [] and rep["claude_fanouts"]["decisions"] == 0
