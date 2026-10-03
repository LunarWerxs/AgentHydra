"""Offline: the frontier loop against a real probe script and a fake job manager.

Pins the hswarm_loop contract: the loop finds its own next target from the probe, sends FIX workers (one per listed
failure) at a failing stage and a PORT worker at a missing one, stops when the frontier is null, stops on a stall
instead of paying for the same guess again, and keeps a Status+Log file that a later loop on the same path resumes.
No provider is called: the fake manager "fixes" a stage by editing the probe's state file.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import loop as frontier  # noqa: E402

PROBE = """import json
state = json.load(open("state.json"))
print("parity harness: checking stages")  # noise before the JSON, as a real harness prints
per = {name: s for name, s in state}
first = next(((n, s) for n, s in state if s != "pass"), None)
if first is None:
    print(json.dumps({"frontier": None, "perStage": per}))
elif first[1] == "missing":
    print(json.dumps({"frontier": first[0], "perStage": per}))
else:
    print(json.dumps({"frontier": {"stage": first[0], "failures": ["case-a", "case-b"]}, "perStage": per}))
"""


class _FakeManager:
    """Stands in for JobManager: records each batch; with fixes=True every batch makes its stage pass."""

    def __init__(self, cwd: Path, fixes: bool = True):
        self.cwd, self.fixes, self.batches = cwd, fixes, []

    def submit(self, tasks, concurrency=None, label="", budget_usd=None):
        mode, stage = label.split(":")[-2:]
        self.batches.append((mode, stage, len(tasks)))
        if self.fixes:
            state = json.loads((self.cwd / "state.json").read_text())
            (self.cwd / "state.json").write_text(json.dumps([[n, "pass" if n == stage else s] for n, s in state]))
        self.last = SimpleNamespace(id=f"job{len(self.batches)}", results={t.id: SimpleNamespace(status="ok") for t in tasks}, cost=lambda: 0.01)
        return self.last

    async def wait(self, job_id, timeout_s):
        return self.last


def _setup(tmp_path: Path, state: list) -> str:
    (tmp_path / "state.json").write_text(json.dumps(state))
    (tmp_path / "probe.py").write_text(PROBE)
    return f'"{sys.executable}" probe.py'


def _run(lp, m):
    return asyncio.run(lp.run(m))


def test_loop_fixes_then_ports_the_frontier_until_the_probe_says_done(tmp_path):
    probe = _setup(tmp_path, [["parse", "fail"], ["lower", "missing"], ["emit", "pass"]])
    log = tmp_path / "loop.md"
    lp = frontier.build(probe, str(tmp_path), str(log), task_defaults={"tools": "none", "model": "deepseek-flash"})
    m = _FakeManager(tmp_path)
    out = _run(lp, m)
    assert out["state"] == "done" and out["frontier"] is None, out
    # FIX a failing stage with one worker per listed failure, then PORT the missing one with a single worker.
    assert m.batches == [("fix", "parse", 2), ("port", "lower", 1)], m.batches
    assert out["jobs"] == ["job1", "job2"] and abs(out["cost_usd"] - 0.02) < 1e-9
    text = log.read_text(encoding="utf-8")
    assert "## Status" in text and "- state: done" in text and "## Log" in text
    assert "round 1: FIX parse" in text and "round 2: PORT lower" in text and "STOP done" in text


def test_a_round_that_changes_nothing_stalls_the_loop_and_the_log_resumes(tmp_path):
    probe = _setup(tmp_path, [["parse", "fail"]])
    log = tmp_path / "loop.md"
    lp = frontier.build(probe, str(tmp_path), str(log), stall_rounds=2, max_rounds=10, task_defaults={"tools": "none", "model": "deepseek-flash"})
    m = _FakeManager(tmp_path, fixes=False)
    out = _run(lp, m)
    assert out["state"] == "stalled" and out["round"] == 2, out  # two rounds left it unchanged, not all ten
    kept = log.read_text(encoding="utf-8").count("\n- 20")
    again = frontier.build(probe, str(tmp_path), str(log), max_rounds=1, task_defaults={"tools": "none", "model": "deepseek-flash"})
    assert len(again.log) == kept and any("STOP stalled" in ln for ln in again.log)


def test_probe_that_prints_no_frontier_stops_the_loop_with_its_reason(tmp_path):
    lp = frontier.build(f'"{sys.executable}" -c "print(42)"', str(tmp_path), str(tmp_path / "loop.md"), task_defaults={"tools": "none", "model": "deepseek-flash"})
    out = _run(lp, _FakeManager(tmp_path))
    assert out["state"] == "probe_failed" and "frontier" in out["reason"] and out["round"] == 0
