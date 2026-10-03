"""Offline: the api loop's tool-loop guard - reminders a repeating worker reads, and the stop that ends a
worker whose repeats return nothing new as status `loop` instead of letting it burn max_turns.

Cheap models re-read the same file or re-run the same grep until the turn budget is gone; before the guard
that task failed only at max_turns or timeout, after spending every turn. See hswarm/loopguard.py.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, loopguard  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.loopguard import LoopGuard  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def _notes(guard: LoopGuard, calls: list[tuple[str, dict | str, str]]) -> list[tuple[str, object]]:
    return [guard.observe(name, args, out) for name, args, out in calls]


def test_reordered_arguments_are_the_same_call_and_earn_a_reminder_at_three():
    g = LoopGuard()
    out = _notes(g, [("grep", '{"pattern": "x", "path": "src"}', "hit"), ("grep", '{"path": "src", "pattern": "x"}', "hit"),
                     ("grep", {"path": "src", "pattern": "x"}, "hit")])
    assert [n for n, _ in out[:2]] == ["", ""]
    assert out[2][0].startswith("[loop guard]") and "grep" in out[2][0] and "3 times" in out[2][0]
    assert all(stop is None for _, stop in out) and g.warnings == 1


def test_a_repeat_whose_result_changes_is_nudged_but_never_stopped():
    """A re-run build or a file being edited returns something new each time: advice only, at 3, 5 and 8."""
    g = LoopGuard()
    out = _notes(g, [("bash", {"cmd": "pytest"}, f"run {i}") for i in range(30)])
    assert all(stop is None for _, stop in out)
    assert [i + 1 for i, (n, _) in enumerate(out) if n] == list(loopguard.REPEAT_WARN) and g.warnings == 3
    assert "identical result" not in out[4][0], "a changing result is not called no-progress"


def test_identical_results_in_a_row_stop_the_task_as_no_progress():
    g = LoopGuard()
    out = _notes(g, [("read_file", {"path": "a.py"}, "same body")] * loopguard.NO_PROGRESS_STOP)
    assert all(stop is None for _, stop in out[:-1])
    stop = out[-1][1]
    assert stop.detector == "no_progress" and stop.error.startswith("loop: no_progress") and "a.py" in stop.error
    assert "identical result" in out[4][0], "the detailed reminder says the outcome never changed"


def test_an_a_b_cycle_with_unchanged_results_warns_then_stops_as_ping_pong():
    g = LoopGuard()
    ab = [("read_file", {"path": "a"}, "A"), ("read_file", {"path": "b"}, "B")]
    out = _notes(g, ab * (loopguard.PING_PONG_STOP // 2))
    warned = [i + 1 for i, (n, _) in enumerate(out) if n]
    assert warned == list(loopguard.PING_PONG_WARN) and "alternating" in out[warned[0] - 1][0]
    assert all(stop is None for _, stop in out[:-1]) and out[-1][1].detector == "ping_pong"


def test_a_longer_cycle_trips_the_global_breaker():
    g = LoopGuard()
    abc = [("list_dir", {"path": p}, p.upper()) for p in ("a", "b", "c")]
    stops = [stop for _, stop in _notes(g, abc * loopguard.GLOBAL_STOP) if stop]
    assert stops and stops[0].detector == "global"


def test_submit_result_is_transparent():
    g = LoopGuard()
    out = _notes(g, [("submit_result", {"a": 1}, "result accepted")] * 20)
    assert all(n == "" and stop is None for n, stop in out) and g.history == []


class _Rereader:
    """A worker that re-reads the same file every turn, never answering."""

    def __init__(self):
        self.turns = 0

    async def chat(self, messages, **kw):
        self.turns += 1
        call = {"id": f"c{self.turns}", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "same.txt"}'}}
        return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                          usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


def test_a_rereading_worker_ends_as_loop_before_its_turn_budget_and_the_ledger_says_why(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    (tmp_path / "same.txt").write_text("nothing new here\n", encoding="utf-8")
    client = _Rereader()

    async def go():
        task = Task.from_dict({"id": "t0", "prompt": "x", "cwd": str(tmp_path), "tools": "read", "model": "deepseek-flash", "max_turns": 24}, {}, 0)
        return await JobManager(client=client).run_batch([task], concurrency=1)

    res = asyncio.run(go()).results["t0"]
    # One turn more than the stop: the first read returns the file, every repeat the same short pointer to it
    # (worker._earlier), and it is those identical pointers the guard counts.
    assert res.status == "loop" and res.loop == "no_progress" and res.turns == loopguard.NO_PROGRESS_STOP + 1 < 24
    assert res.loop_warnings == len(loopguard.REPEAT_WARN) and res.answer.startswith("PARTIAL")
    row = json.loads((tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    assert row["status"] == "loop" and row["loop"] == "no_progress" and row["loop_warnings"] == 3
    assert client.turns == loopguard.NO_PROGRESS_STOP + 1, "a loop is the work failing, not the leg: no failover re-run"
