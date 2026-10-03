"""Offline: the optimize ratchet's keep-or-revert policy, and the loop on a real git worktree with a fake worker.
No network: the worker is a function that writes a number, the metric is `cat`."""
from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.optimize import Optimize, parse_metric, ratchet, verdict  # noqa: E402
from hswarm.procs import find_bash  # noqa: E402
from hswarm.spec import Result  # noqa: E402


def test_verdict_keeps_only_real_or_simpler_gains():
    assert verdict(10, 9, "min", 0.0, 5)[0] is True
    assert verdict(10, 11, "min", 0.0, -50)[0] is False  # worse is reverted however much it deletes
    assert verdict(10, 11, "max", 0.0, 0)[0] is True
    assert verdict(10, 10, "min", 0.0, -3)[0] is True  # simplicity rule: equal score, fewer lines
    assert verdict(10, 10, "min", 0.0, 0)[0] is False
    assert verdict(10, 9.99, "min", 0.01, 20)[0] is False  # a 0.1% gain bought with 20 added lines
    assert verdict(10, 9.99, "min", 0.01, -1)[0] is True
    assert verdict(10, None, "min", 0.0, -1)[0] is False


def test_parse_metric_reads_the_last_number_and_treats_divergence_as_none():
    assert parse_metric("step 1 loss 3.5\nstep 2 loss 2.25\n") == 2.25
    assert parse_metric("val_bpb: 0.998\ntook 12s", r"val_bpb:\s*(\S+)") == 0.998
    assert parse_metric("loss 2.0\nloss nan") is None
    assert parse_metric("nothing here") is None


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout


@pytest.mark.skipif(find_bash() is None, reason="needs a working bash for the metric command")
def test_ratchet_commits_improvements_and_resets_everything_else(tmp_path, monkeypatch):
    for k in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"):
        monkeypatch.setenv(k, "t")
    for k in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(k, "t@example.invalid")
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "value.txt").write_text("5\n")
    _git(repo, "init", "-q")
    _git(repo, "add", "value.txt")
    _git(repo, "commit", "-q", "-m", "base")
    # attempt: (value written, also write a file outside the targets?)
    plan = {"a1": (3, False), "a2": (7, False), "a3": (1, True), "a4": (2, False)}

    async def worker(task):
        value, stray = plan[task.id]
        (Path(task.cwd) / "value.txt").write_text(f"{value}\n")
        if stray:
            (Path(task.cwd) / "other.txt").write_text("not a target\n")
        return Result(id=task.id, status="ok", answer=f"set {value}", cost_usd=0.0)

    spec = Optimize(str(repo), "lower the number", ["value.txt"], "cat value.txt", attempts=4, budget_s=30)
    out = asyncio.run(ratchet(spec, worker, root=tmp_path / "runs"))
    tree = Path(out["tree"])
    assert (out["baseline"], out["best"], out["kept"], out["attempts"]) == (5, 2, 2, 4)
    assert (tree / "value.txt").read_text().strip() == "2"
    assert not (tree / "other.txt").exists()
    assert _git(tree, "status", "--porcelain").strip() == ""
    assert len(_git(repo, "log", "--oneline", out["branch"]).splitlines()) == 3  # base + the two kept attempts
    assert (repo / "value.txt").read_text().strip() == "5"  # the caller's checkout is never touched
