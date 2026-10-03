"""Offline: context hygiene for the api worker - spilled tool output, fetch_output, and stale-result clearing. No network."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent, config  # noqa: E402
from hswarm.context import ContextEditor  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402


def _numbered(n: int) -> str:
    return "".join(f"line {i:05d}\n" for i in range(n))


def test_a_capped_output_can_be_fetched_back_whole(tmp_path):
    # Contract: the middle _cap cuts out is recoverable, byte for byte, through the marker's own fetch_output call.
    (tmp_path / "big.txt").write_text(_numbered(3000), encoding="utf-8", newline="")
    sb = Sandbox(tmp_path, max_output_chars=2000, spill_dir=tmp_path / "spill")
    out =asyncio.run(sb.run("read_file", {"path": "big.txt", "start_line": 1, "end_line": 3000}))
    marker = out[out.index("fetch_output("):]
    handle = marker.split('id="')[1].split('"')[0]
    start = int(marker.split("start=")[1].split(",")[0])
    end = int(marker.split("end=")[1].split(")")[0])
    full = asyncio.run(sb.t_read_file("big.txt", 1, 3000))
    got, lo = "", start
    while lo < end:  # page it back the way a worker would, following each continuation marker
        part = asyncio.run(sb.run("fetch_output", {"id": handle, "start": lo, "end": end}))
        assert len(part) <= 2000, "a fetch must never itself be capped and spilled"
        piece = part.split("\n... [continues: ")[0]
        got += piece
        lo += len(piece)
    assert out.startswith(full[:start]) and out.endswith(full[end:]) and got == full[start:end]
    # The same output gets the same handle, so the preview bytes (and the provider's cached prefix) repeat exactly.
    assert asyncio.run(sb.run("read_file", {"path": "big.txt", "start_line": 1, "end_line": 3000})) == out


def test_without_a_spill_dir_the_cap_is_the_old_lossy_preview(tmp_path):
    (tmp_path / "big.txt").write_text(_numbered(3000), encoding="utf-8", newline="")
    sb = Sandbox(tmp_path, max_output_chars=2000)
    out = asyncio.run(sb.run("read_file", {"path": "big.txt", "start_line": 1, "end_line": 3000}))
    assert "chars omitted]" in out and "fetch_output" not in out
    assert asyncio.run(sb.run("fetch_output", {"id": "0123456789abcdef"})).startswith("ERROR:")


def _history(n_results: int, size: int) -> list[dict]:
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
    for i in range(n_results):
        msgs.append({"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "type": "function", "function": {"name": "grep", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "x" * size})
    return msgs


def test_stale_results_clear_past_the_trigger_and_the_last_three_stay():
    msgs = _history(6, 4000)  # ~6k tokens of tool output
    before = json.dumps(msgs)
    ed = ContextEditor(trigger=3000, clear_at_least=1000, spill=lambda text: "0123456789abcdef")
    sent = ed.view(msgs)
    tools = [m["content"] for m in sent if m["role"] == "tool"]
    assert all(t.startswith("[stale grep output cleared") and 'fetch_output(id="0123456789abcdef")' in t for t in tools[:3])
    assert all(t.startswith("result ") for t in tools[3:]), "the last 3 results stay whole"
    assert json.dumps(msgs) == before, "the transcript itself is never edited"
    # A cleared result goes out with the same bytes on every later turn: the new prefix caches again at once.
    msgs += [{"role": "assistant", "content": "", "tool_calls": [{"id": "c9", "type": "function", "function": {"name": "grep", "arguments": "{}"}}]},
             {"role": "tool", "tool_call_id": "c9", "content": "result 9"}]
    first_three = {"c0", "c1", "c2"}
    assert [m for m in ed.view(msgs) if m.get("tool_call_id") in first_three] == [m for m in sent if m.get("tool_call_id") in first_three]


def test_a_pass_that_cannot_free_clear_at_least_waits():
    msgs = _history(4, 4000)  # one clearable result, ~1k tokens, but the pass must free 5k
    ed = ContextEditor(trigger=1000, clear_at_least=5000)
    assert ed.view(msgs) is msgs and ed.passes == 0
    assert ContextEditor(trigger=0, clear_at_least=0).view(msgs) is msgs, "trigger 0 turns it off"


def test_the_worker_loop_sends_cleared_results_and_keeps_the_transcript(tmp_path, monkeypatch):
    # Seam: agent._loop hands the editor's view to the provider, and the worker is given fetch_output.
    monkeypatch.setattr(config, "SPILL_DIR", tmp_path / "spill")
    for n in range(1, 6):  # a file per turn: a repeat read of an unchanged file is answered with a pointer, not the file
        (tmp_path / f"f{n}.txt").write_text(_numbered(400), encoding="utf-8", newline="")

    class Reader:
        def __init__(self):
            self.seen, self.tools = [], None

        async def chat(self, messages, tools=None, **kw):
            self.seen.append([dict(m) for m in messages])
            self.tools = self.tools or [t["function"]["name"] for t in tools or []]
            n = len(self.seen)
            msg = ({"role": "assistant", "content": "", "tool_calls": [{"id": f"c{n}", "type": "function",
                    "function": {"name": "read_file", "arguments": json.dumps({"path": f"f{n}.txt"})}}]}
                   if n <= 5 else {"role": "assistant", "content": "done"})
            return ChatResult(message=msg, finish_reason="stop", usage=Usage(), model="m", seconds=0.1, cost_usd=0.0, peak=False)

    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash",
                           "context_trigger": 2000, "context_clear_at_least": 500})
    client = Reader()
    res, transcript = asyncio.run(agent.run_api_task(client, task))
    assert res.status == "ok" and "fetch_output" in client.tools
    last_sent = [m["content"] for m in client.seen[-1] if m["role"] == "tool"]
    # A kept result is the whole read inside its <scan_data> frame, under its receipt header (injection-defense, receipts).
    assert last_sent[0].startswith("[stale read_file output cleared") and "\n1\tline 00000\n" in last_sent[-1]
    assert all("\n1\tline 00000\n" in m["content"] and "line 00399" in m["content"] for m in transcript if m["role"] == "tool")
