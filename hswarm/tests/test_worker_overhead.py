"""Offline: what a worker's tool output costs on every later turn - read_file's page, the answer to a repeated
identical call, the context trigger of a leg with no cache discount, and a one-shot ask's cache write. Each cut must
leave the worker a way to the data: a page names the call that reads on, and a repeat is answered with a pointer
only while nothing it reads can have changed. No network."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent  # noqa: E402
from hswarm.client import ChatClient  # noqa: E402
from hswarm.context import ContextEditor  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from hswarm.worker import run_tools  # noqa: E402


def _call(name: str, args: dict, call_id: str = "c1") -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def test_a_large_read_comes_back_in_pages_that_end_on_a_line_and_lose_nothing(tmp_path):
    # Contract: an unranged read of a ~40k-char file is at most a 12k page, and following each page's own
    # continuation call returns every line once, in order. Before: ~30k chars, head and tail, the middle cut out.
    (tmp_path / "big.txt").write_text("".join(f"line {i:05d}\n" for i in range(2500)), encoding="utf-8", newline="")
    sb = Sandbox(tmp_path)
    got: list[str] = []
    args: dict = {"path": "big.txt"}
    for _ in range(10):
        out = asyncio.run(sb.run("read_file", args))
        assert len(out) <= 12_200
        body, _, marker = out.partition("\n... [")
        got += body.split("\n")
        more = re.search(r'continues: read_file\(path="big\.txt", start_line=(\d+)\)', marker)
        if not more:
            break
        args = {"path": "big.txt", "start_line": int(more.group(1))}
    assert got == [f"{i + 1}\tline {i:05d}" for i in range(2500)]


def test_a_repeated_read_points_at_its_first_receipt_until_the_file_changes_or_the_result_was_cleared(tmp_path):
    # Contract: the second identical read_file of an untouched file is a short pointer citing the first receipt and is
    # not run. It runs again once the earlier result is no longer in what the model is sent, and once the file changed.
    (tmp_path / "a.txt").write_text("alpha\n" * 200, encoding="utf-8")
    sb = Sandbox(tmp_path)
    state: dict = {}
    read = _call("read_file", {"path": "a.txt"})
    (first,), _ = asyncio.run(run_tools(sb, [read], None, state))
    (again,), _ = asyncio.run(run_tools(sb, [read], None, state))
    assert "alpha" in first and "alpha" not in again
    assert len(again) < 300 and "[r1 read_file]" in again and len(sb.receipts) == 1

    state["cleared"] = {"c1": "[stale read_file output cleared to save context]"}  # what agent._loop shares from the editor
    (recalled,), _ = asyncio.run(run_tools(sb, [_call("read_file", {"path": "a.txt"}, "c2")], None, state))
    assert "alpha" in recalled

    (tmp_path / "a.txt").write_text("beta\n" * 50, encoding="utf-8")
    (fresh,), _ = asyncio.run(run_tools(sb, [_call("read_file", {"path": "a.txt"}, "c3")], None, state))
    assert "beta" in fresh


def test_a_repeated_tree_walk_runs_again_after_the_worker_wrote_something(tmp_path):
    # Contract: glob/grep/list_dir repeat as a pointer only while this sandbox made no write since; a new file changes
    # their answer without touching any earlier hit, so after a write the walk really runs and shows it.
    (tmp_path / "a.txt").write_text("x", encoding="utf-8")
    sb = Sandbox(tmp_path)
    state: dict = {}
    walk = _call("glob", {"pattern": "*.txt"})
    (first,), _ = asyncio.run(run_tools(sb, [walk], None, state))
    (again,), _ = asyncio.run(run_tools(sb, [walk], None, state))
    assert "a.txt" in first and "a.txt" not in again and "[r1 glob]" in again

    asyncio.run(run_tools(sb, [_call("write_file", {"path": "b.txt", "content": "y"}, "c2")], None, state))
    (after,), _ = asyncio.run(run_tools(sb, [walk], None, state))
    assert "a.txt" in after and "b.txt" in after


def _history(n_results: int, size: int) -> list[dict]:
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
    for i in range(n_results):
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "grep", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * size})
    return msgs


@pytest.mark.parametrize("spec, clears", [
    ({"model": "rank:qwen3-8-27b:groq"}, True),  # priced, hit == miss: every re-sent token is full price
    ({"model": "rank:claude-opus-5-5:direct"}, False),  # a cache read costs a twentieth; a pass re-writes the cache
    ({"model": "rank:glm-5-3:nvidia"}, False),  # free, and 87.8% of its input is read from the cache
    ({"model": "rank:qwen3-8-27b:groq", "context_trigger": 0}, False),  # the caller's own setting is never changed
])
def test_only_a_default_task_on_a_leg_with_no_cache_discount_clears_from_16k_tokens(tmp_path, spec, clears):
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", **spec})
    sent = ContextEditor.for_leg(task).view(_history(10, 12_000))  # ~30k tokens: past 16k, well short of 60k
    assert any(m["content"].startswith("[stale grep output cleared") for m in sent if m["role"] == "tool") == clears


def test_a_one_shot_ask_writes_only_the_shared_system_prompt_to_the_cache():
    # Contract: agent.ask has no next turn to read a cache write, so its Messages request carries a breakpoint on the
    # system block (shared by a batch) and none on the user turn, which was written at 1.25x for nothing.
    sent: list[httpx.Request] = []

    def reply(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
                                         "usage": {"input_tokens": 10, "output_tokens": 5}})

    client = ChatClient(api_keys=["sk-test-a"], provider="anthropic")
    client._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(reply))

    async def one_ask():
        await agent.ask(client, "Classify this.", system="You are a classifier.", model="rank:claude-opus-5-5:direct")
        await client.aclose()

    asyncio.run(one_ask())
    assert len(sent) == 1
    body = json.loads(sent[0].content)
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in json.dumps(body["messages"])
