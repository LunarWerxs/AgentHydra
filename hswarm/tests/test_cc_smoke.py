"""Smoke: a real headless Claude Code process, launched with the cc backend's own argv, against an in-process
fake Anthropic endpoint on localhost - no provider is called and nothing is spent. It proves what the argv
unit tests cannot: that Claude Code itself denies what the allowlist leaves out and skips the task folder's
hooks and MCP servers when a task is isolated. Marked live, like test_live: it spawns the real CLI, so it runs
only on request (`-m live`), and is skipped on a machine with no `claude` on PATH."""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import cc, claude_env  # noqa: E402
from hswarm.spec import Task  # noqa: E402

pytestmark = [pytest.mark.live, pytest.mark.skipif(not shutil.which("claude"), reason="no claude binary on PATH")]


class _FakeAnthropic(BaseHTTPRequestHandler):
    """Turn 1 calls the scripted tools; once they come back as tool_results it says done. Every request is kept."""

    tools: list[dict] = []
    seen: list[dict] = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        type(self).seen.append(body)
        last = (body.get("messages") or [{}])[-1].get("content")
        answered = isinstance(last, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in last)
        calls = [] if answered else [{"type": "tool_use", "id": f"tu_{i}", **t} for i, t in enumerate(type(self).tools)]
        if not body.get("stream"):
            data = json.dumps({"id": "m", "type": "message", "role": "assistant", "model": "fake", "stop_reason": "end_turn",
                               "content": [{"type": "text", "text": "done"}], "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        blocks = calls or [{"type": "text", "text": "done"}]
        events = [{"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "fake", "content": [],
                                                        "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 1}}}]
        for i, b in enumerate(blocks):
            if b["type"] == "text":
                events += [{"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}},
                           {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}}]
            else:
                events += [{"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}},
                           {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])}}]
            events.append({"type": "content_block_stop", "index": i})
        events += [{"type": "message_delta", "delta": {"stop_reason": "tool_use" if calls else "end_turn"}, "usage": {"output_tokens": 1}},
                   {"type": "message_stop"}]
        for ev in events:
            self.wfile.write(f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n".encode())
        self.wfile.flush()


def _marker_hook(marker: Path) -> dict:
    py = sys.executable.replace("\\", "/")
    return {"SessionStart": [{"hooks": [{"type": "command", "command": f'"{py}" -c "open(r\'{marker.as_posix()}\', \'w\').close()"'}]}]}


def test_an_isolated_read_only_worker_denies_unlisted_tools_and_skips_the_folders_hooks(tmp_path, monkeypatch):
    repo, marks = tmp_path / "repo", tmp_path / "marks"
    (repo / ".claude").mkdir(parents=True)
    marks.mkdir()
    (repo / "hello.txt").write_text("HELLO-CONTENT", encoding="utf-8")
    # The task folder brings a hook and an MCP server of its own; isolation must keep both out.
    (repo / ".claude" / "settings.json").write_text(json.dumps({"hooks": _marker_hook(marks / "project_hook"), "enableAllProjectMcpServers": True}), encoding="utf-8")
    mcp = {"command": sys.executable, "args": ["-c", f"open(r'{(marks / 'mcp').as_posix()}', 'w').close()"]}
    (repo / ".mcp.json").write_text(json.dumps({"mcpServers": {"probe": mcp}}), encoding="utf-8")
    # The worker's own config (hswarm's) keeps its hooks: proof that hooks run at all in this setup.
    monkeypatch.setattr(claude_env, "SHIELD", tmp_path / "no-shield.py")  # or every run re-asserts the shield over this hook
    cfg = claude_env.ensure_cc_config()
    settings = json.loads((cfg / "settings.json").read_text(encoding="utf-8"))
    settings.update({"hooks": _marker_hook(marks / "worker_hook"), "enableAllProjectMcpServers": True})
    (cfg / "settings.json").write_text(json.dumps(settings), encoding="utf-8")

    _FakeAnthropic.seen = []
    _FakeAnthropic.tools = [{"name": "Read", "input": {"file_path": str(repo / "hello.txt")}},
                            {"name": "WebFetch", "input": {"url": "http://127.0.0.1:9/x", "prompt": "p"}},
                            {"name": "Write", "input": {"file_path": str(repo / "pwned.txt"), "content": "x"}}]
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _FakeAnthropic)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base_env = cc.cc_env

    def local_env(api_key, model=None, **kw):
        return {**base_env(api_key, model, **kw), "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{srv.server_address[1]}"}

    monkeypatch.setattr(cc, "cc_env", local_env)
    try:
        task = Task.from_dict({"prompt": "go", "cwd": str(repo), "backend": "cc", "tools": "read", "isolated": True, "max_turns": 4, "timeout_s": 180}, {}, 0)
        _, transcript = asyncio.run(cc.run_cc_task(task, "sk-fake-not-a-key"))
    finally:
        srv.shutdown()

    blocks = [c for b in _FakeAnthropic.seen for m in b.get("messages") or [] if isinstance(m.get("content"), list)
              for c in m["content"] if isinstance(c, dict) and c.get("type") == "tool_result"]
    assert blocks, f"the worker never sent a tool result back: {transcript}"
    by_id = {c.get("tool_use_id"): c for c in blocks}
    assert "HELLO-CONTENT" in str(by_id["tu_0"].get("content")) and not by_id["tu_0"].get("is_error")  # Read allowed
    # WebFetch, a tool no denylist named, is refused. Judged on the protocol's is_error flag plus any of the words
    # a refusal has used (a tool left off --tools answers 'No such tool available'), not one exact CLI sentence: the fetch target is dead anyway, so is_error
    # alone would also pass for an allowed fetch that failed.
    web = by_id["tu_1"]
    assert web.get("is_error") is True and any(w in str(web.get("content")).lower() for w in ("denied", "permission", "not allowed", "no such tool"))
    assert not (repo / "pwned.txt").exists()
    assert (marks / "worker_hook").exists()
    assert not (marks / "project_hook").exists() and not (marks / "mcp").exists()
