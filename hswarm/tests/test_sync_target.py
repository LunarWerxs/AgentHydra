"""The fleet sync branch never lands in HSwarm's own repo: that repo is public and a shard carries project paths,
session ids and labels."""
from __future__ import annotations

import subprocess
from pathlib import Path

from hswarm import utilization


# Pins: with HSWARM_SYNC_REPO unset, or naming a clone of HSwarm's own repo, sync reports itself off and runs no git
# write anywhere. The ZSwarm copy derived the target from the package's parent, which in AgentHydra is the public repo.
def test_sync_never_writes_to_hswarms_own_repo(monkeypatch, tmp_path):
    own = "https://github.com/example/public-hswarm.git"
    calls = []

    def git(cwd, *args, check=False, input_text=None):
        calls.append((Path(cwd), args))
        if args[:1] != ("remote",):
            raise AssertionError(f"sync ran git {args} in {cwd}")
        return subprocess.CompletedProcess(["git", *args], 0, stdout=own + "\n", stderr="")

    monkeypatch.setattr(utilization, "_git", git)
    monkeypatch.delenv("HSWARM_SYNC_REPO", raising=False)
    rep = utilization.sync(push=True)
    assert not rep["pushed"] and any("sync is off" in n for n in rep["notes"]), rep

    clone = tmp_path / "clone"
    (clone / ".git").mkdir(parents=True)
    monkeypatch.setenv("HSWARM_SYNC_REPO", str(clone))  # another checkout whose origin is the same public repo
    rep = utilization.sync(push=True)
    assert not rep["pushed"] and any("own (public) repo" in n for n in rep["notes"]), rep
