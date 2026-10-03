"""Offline: `hswarm prefix` - the loopback sink and the prefix analyzer. No claude process is spawned."""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import prefix  # noqa: E402


def _tool(name: str, pad: int) -> dict:
    return {"name": name, "description": "x" * pad, "input_schema": {"type": "object", "properties": {}}}


def test_the_prefix_is_split_by_part_and_mcp_tools_are_charged_to_their_server():
    # The whole point of the verb: which MCP server's schemas dominate a spawn. A tool named
    # mcp__<server>__<tool> must land on that server (server names carry underscores), never on builtin.
    body = {
        "model": "deepseek-flash",
        "system": [{"type": "text", "text": "s" * 100}, {"type": "text", "text": "t" * 50}],
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [_tool("Read", 10), _tool("mcp__agent_hydra__list_usage", 500), _tool("mcp__agent_hydra__fan_out", 400), _tool("mcp__hswarm__hswarm_run", 300)],
    }
    r = prefix.analyze(body, top=2)
    assert r["system_chars"] == 150
    assert r["context_chars"] == len(json.dumps(body["messages"], separators=(",", ":")))
    assert r["tools"] == 4 and r["builtin"]["tools"] == 1 and r["mcp"] == {"tools": 3, "chars": r["tool_chars"] - r["builtin"]["chars"], "servers": 2}
    assert [s["server"] for s in r["servers"]] == ["agent_hydra", "hswarm", "builtin"]
    assert r["dominant_mcp"] == "agent_hydra"
    assert [h["name"] for h in r["heaviest"]] == ["mcp__agent_hydra__list_usage", "mcp__agent_hydra__fan_out"]
    assert r["total_chars"] == r["system_chars"] + r["context_chars"] + r["tool_chars"]


def test_the_sink_answers_a_streamed_messages_turn_and_the_tool_heaviest_capture_is_the_prefix():
    # Claude Code streams its first turn and also sends small tool-less side calls; the sink must end the
    # turn cleanly (message_stop) and the real turn, not the side call, must be picked as the prefix.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with prefix.Sink() as sink:
        def post(body: dict) -> tuple[str, str]:
            req = urllib.request.Request(sink.url + "/v1/messages?beta=true", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            with opener.open(req, timeout=10) as resp:
                return resp.headers.get("Content-Type"), resp.read().decode()

        side = post({"model": "m", "max_tokens": 1, "messages": [{"role": "user", "content": "quota" * 50}]})
        ctype, text = post({"model": "m", "stream": True, "messages": [{"role": "user", "content": "go"}], "tools": [_tool("Read", 5), _tool("Grep", 5)]})
    assert json.loads(side[1])["content"][0]["text"] == "DONE"
    assert ctype == "text/event-stream" and '"text": "DONE"' in text and text.rstrip().endswith('data: {"type": "message_stop"}')
    assert [c["path"] for c in sink.captures] == ["/v1/messages", "/v1/messages"]
    assert len(prefix.pick_prefix(sink.captures)["body"]["tools"]) == 2
