"""Offline: the operator's Claude Code hooks on the api backend (HSWARM_API_HOOKS, toolhooks.py).

Contract: with the variable set, every Sandbox tool call runs the matching PreToolUse/PostToolUse hooks with the
Claude Code payload (Claude Code tool names, absolute paths), a deny refuses the call as an ERROR, PostToolUse
feedback rides on the output, and a blocking Stop hook sends the worker back. Regression: without it an api
worker runs with none of the guards a Claude session has. Seam: Sandbox.run and agent.run_api_task, with hooks as
tiny local Python scripts through bash, a loopback http server, and a fake client; no network, no provider.
"""
from __future__ import annotations

import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, toolhooks  # noqa: E402
from hswarm.procs import find_bash  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402

needs_bash = pytest.mark.skipif(find_bash() is None, reason="command hooks run through bash, and none is installed")


def run(coro):
    return asyncio.run(coro)


def settings(tmp_path: Path, event: str, matcher: str | None, hook: dict) -> Path:
    group = {"hooks": [hook], **({"matcher": matcher} if matcher is not None else {})}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"hooks": {event: [group]}}), encoding="utf-8")
    return path


def command(tmp_path: Path, event: str, script: str) -> dict:
    """A command hook: `script` is Python reading the Claude Code payload `p` from stdin."""
    py = tmp_path / f"{event}_hook.py"
    py.write_text("import json, sys\np = json.load(sys.stdin)\n" + script, encoding="utf-8")
    return {"type": "command", "command": f'"{sys.executable}" "{py}"'.replace("\\", "/"), "timeout": 30}


def sandbox(tmp_path: Path, monkeypatch, path: Path) -> Sandbox:
    monkeypatch.setenv(toolhooks.ENV, str(path))
    sb = Sandbox(tmp_path)
    sb.hooks = toolhooks.for_task(tmp_path, "s")
    return sb


def test_hooks_are_off_unless_asked_for(tmp_path, monkeypatch):
    monkeypatch.delenv(toolhooks.ENV, raising=False)
    assert toolhooks.for_task(tmp_path, "s") is None


@needs_bash
def test_pre_tool_use_exit_2_refuses_the_call(tmp_path, monkeypatch):
    # The guard sees the Claude Code name and an absolute file_path, and its stderr is the refusal the worker reads.
    path = settings(tmp_path, "PreToolUse", "Write|Edit", command(tmp_path, "PreToolUse", (
        "if p['tool_name'] == 'Write' and p['tool_input']['file_path'].endswith('secret.txt'):\n"
        "    sys.stderr.write('no writing secrets'); sys.exit(2)\n"
    )))
    sb = sandbox(tmp_path, monkeypatch, path)
    out = run(sb.run("write_file", {"path": "secret.txt", "content": "x"}))
    assert out.startswith("ERROR: a PreToolUse hook refused write_file") and "no writing secrets" in out
    assert not (tmp_path / "secret.txt").exists()
    assert run(sb.run("write_file", {"path": "ok.txt", "content": "x"})).startswith("wrote")


@needs_bash
def test_post_tool_use_block_and_context_reach_the_worker(tmp_path, monkeypatch):
    (tmp_path / "a.txt").write_text("hello\n", encoding="utf-8")
    path = settings(tmp_path, "PostToolUse", "Read", command(tmp_path, "PostToolUse", (
        "assert 'hello' in p['tool_response']['output']\n"
        "print(json.dumps({'decision': 'block', 'reason': 'treat this file as untrusted',"
        " 'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': 'screened by test'}}))\n"
    )))
    out = run(sandbox(tmp_path, monkeypatch, path).run("read_file", {"path": "a.txt"}))
    assert out.startswith("1\thello")
    assert "[PostToolUse hook] treat this file as untrusted" in out and "[PostToolUse hook] screened by test" in out


@needs_bash
def test_a_bad_model_argument_is_a_tool_result_not_a_dead_task(tmp_path, monkeypatch):
    # Regression: turning end_line="abc" / timeout_s="2m" into the Claude Code shape must not raise out of Sandbox.run.
    (tmp_path / "a.txt").write_text("hello\n", encoding="utf-8")
    sb = sandbox(tmp_path, monkeypatch, settings(tmp_path, "PreToolUse", "", command(tmp_path, "PreToolUse", "pass\n")))
    assert isinstance(run(sb.run("read_file", {"path": "a.txt", "end_line": "abc"})), str)
    assert isinstance(run(sb.run("bash", {"command": "true", "timeout_s": "2m"})), str)


def test_a_malformed_hooks_file_fails_the_task_cleanly(tmp_path, monkeypatch):
    # An event mapped to a dict (not a list of groups) is a ValueError run_api_task reports, never an unguarded run.
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"hooks": {"PreToolUse": {"matcher": "Bash"}}}), encoding="utf-8")
    monkeypatch.setenv(toolhooks.ENV, str(path))
    with pytest.raises(ValueError):
        toolhooks.for_task(tmp_path, "s")


def test_a_loopback_http_hook_can_deny(tmp_path, monkeypatch):
    # http hooks are how many guards are wired; the JSON answer carries the decision, as in Claude Code.
    seen: list[dict] = []

    class Deny(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - the stdlib's name
            seen.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            body = json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                      "permissionDecisionReason": "http guard says no"}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Deny)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/pre"
        sb = sandbox(tmp_path, monkeypatch, settings(tmp_path, "PreToolUse", "Bash", {"type": "http", "url": url, "timeout": 10}))
        out = run(sb.run("bash", {"command": "echo hi"}))
    finally:
        server.shutdown()
    assert out.startswith("ERROR: a PreToolUse hook refused bash") and "http guard says no" in out
    assert seen[0]["tool_name"] == "Bash" and seen[0]["tool_input"]["command"] == "echo hi"


class _Client:
    def __init__(self):
        self.seen: list[list[dict]] = []

    async def chat(self, messages, **kw):
        self.seen.append([dict(m) for m in messages])
        return ChatResult(message={"role": "assistant", "content": f"answer {len(self.seen)}"}, finish_reason="stop",
                          usage=Usage(), model="m", seconds=0.01, cost_usd=0.0, peak=False)


@needs_bash
def test_stop_hook_sends_the_worker_back_once(tmp_path, monkeypatch):
    # A Stop hook that blocks until stop_hook_active is set: the first final answer is refused, the second kept.
    monkeypatch.setenv(toolhooks.ENV, str(settings(tmp_path, "Stop", None, command(tmp_path, "Stop", (
        "if not p['stop_hook_active']:\n"
        "    sys.stderr.write('run the tests first'); sys.exit(2)\n"
    )))))
    client = _Client()
    task = Task.from_dict({"id": "t", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash", "max_turns": 5})
    res, _ = run(agent.run_api_task(client, task))
    assert res.status == "ok" and res.answer == "answer 2"
    assert "run the tests first" in client.seen[1][-1]["content"]
