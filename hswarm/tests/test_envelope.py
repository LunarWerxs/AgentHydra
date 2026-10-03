"""Offline: the spawn envelope narrows at every hop, and the tree ledger admits by node count and metered spend."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import claude_env, config, envelope, tools  # noqa: E402
from hswarm.cc import READ_ONLY_DISALLOWED, _command  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402


def _tasks(tmp_path, n: int, tools="read"):
    # route False: submit's route-health refusal reads this machine's key state, which is not what these tests pin
    return [Task.from_dict({"id": f"t{i}", "prompt": "x", "cwd": str(tmp_path), "tools": tools, "model": "deepseek-flash", "route": False}, {}, i)
            for i in range(n)]


def _under(monkeypatch, tmp_path, env: envelope.Envelope) -> None:
    """Run as a cc worker's own hswarm would: spawned under `env`, with the tree ledger in tmp."""
    monkeypatch.setattr(envelope, "TREES_DIR", tmp_path / "trees")
    monkeypatch.setenv(envelope.ENV_VAR, json.dumps(env.as_dict()))


def test_a_child_envelope_can_only_narrow_whatever_it_asks_for():
    parent = envelope.Envelope(root="abcdef012345", depth=1, max_depth=2, tools=("glob", "grep", "list_dir", "read_file"),
                               spend_usd=1.0, max_nodes=10, deadline=2_000_000_000.0)
    child = parent.narrow({"tools": "all", "spend_usd": 50, "max_nodes": 999, "max_depth": 9, "deadline_s": 10 ** 9})
    assert child.root == parent.root and child.depth == 2
    assert set(child.tools) == set(parent.tools)  # asking for bash and edits got the parent's read set, no more
    assert (child.spend_usd, child.max_nodes, child.max_depth, child.deadline) == (1.0, 10, 2, 2_000_000_000.0)
    tighter = parent.narrow({"tools": "grep", "spend_usd": 0.1})
    assert tighter.tools == ("grep",) and tighter.spend_usd == 0.1


def test_a_spawned_job_is_refused_past_its_depth_or_outside_its_tools(tmp_path, monkeypatch):
    _under(monkeypatch, tmp_path, envelope.Envelope(root="abcdef012345", depth=2, max_depth=2))
    with pytest.raises(ValueError, match="max_depth"):
        JobManager().submit(_tasks(tmp_path, 1))
    _under(monkeypatch, tmp_path, envelope.Envelope(root="abcdef012345", depth=0, tools=("glob", "grep", "list_dir", "read_file")))
    with pytest.raises(ValueError, match="bash"):
        envelope.admit(_tasks(tmp_path, 1, tools="all"))
    assert envelope.read_tree("abcdef012345")["nodes"] == 0  # a refused job takes no node


def test_the_tree_ledger_caps_nodes_and_stops_admitting_once_metered_spend_crosses_the_ceiling(tmp_path, monkeypatch):
    _under(monkeypatch, tmp_path, envelope.Envelope(root="abcdef012345", depth=0, spend_usd=1.0, max_nodes=5))
    first = _tasks(tmp_path, 3)
    env = envelope.admit(first)
    assert env.depth == 1 and all(t.envelope["root"] == "abcdef012345" and t.envelope["depth"] == 1 for t in first)
    assert all(t.max_cost_usd <= 1.0 for t in first)
    with pytest.raises(ValueError, match="nodes"):
        envelope.admit(_tasks(tmp_path, 3))  # 3 + 3 > 5
    envelope.record_spend(first[0], 0.9)
    later = _tasks(tmp_path, 1)
    envelope.admit(later)
    assert abs(later[0].max_cost_usd - 0.1) < 1e-9  # the default 0.25 clamped to what the tree has left
    envelope.record_spend(first[1], None)  # unpriced: charged at its own cap, never free
    with pytest.raises(ValueError, match="ceiling"):
        envelope.admit(_tasks(tmp_path, 1))


def test_no_envelope_means_no_tree_and_a_task_cannot_name_its_own(tmp_path, monkeypatch):
    monkeypatch.delenv(envelope.ENV_VAR, raising=False)
    monkeypatch.setattr(envelope, "TREES_DIR", tmp_path / "trees")
    tasks = _tasks(tmp_path, 2)
    assert envelope.admit(tasks) is None and all(t.envelope is None for t in tasks)
    assert not (tmp_path / "trees").exists()
    with pytest.raises(ValueError, match="envelope"):
        Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "envelope": {"root": "abcdef012345", "max_depth": 99}}, {}, 0)


def test_a_cc_worker_hands_its_own_envelope_on_and_never_the_servers(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CC_CONFIG_DIR", tmp_path / "claude-config")
    monkeypatch.setenv(envelope.ENV_VAR, '{"root": "ffffffffffff", "max_depth": 9}')
    mine = {"root": "abcdef012345", "depth": 1}
    assert json.loads(claude_env.cc_env("sk-x", None, mine)[envelope.ENV_VAR]) == mine
    assert envelope.ENV_VAR not in claude_env.cc_env("sk-x")


def test_an_api_workers_bash_hands_its_own_envelope_on_and_never_the_servers(tmp_path, monkeypatch):
    # bash inherited os.environ: a hswarm started from it ran at the parent's depth, or at a root job outside the tree.
    seen: list[dict | None] = []

    async def fake_run(cmd, cwd, timeout, env=None, stdin_text=None):
        seen.append(env)
        return 0, "", ""

    monkeypatch.setattr(tools, "find_bash", lambda: "bash")
    monkeypatch.setattr(tools, "run_hidden", fake_run)
    monkeypatch.setenv(envelope.ENV_VAR, '{"root": "ffffffffffff", "max_depth": 9}')
    mine = {"root": "abcdef012345", "depth": 1}
    asyncio.run(tools.Sandbox(tmp_path, envelope=mine).t_bash("true"))
    asyncio.run(tools.Sandbox(tmp_path).t_bash("true"))
    assert json.loads(seen[0][envelope.ENV_VAR]) == mine
    assert envelope.ENV_VAR not in seen[1]


def test_a_cc_task_given_read_tools_as_a_list_runs_read_only(tmp_path, monkeypatch):
    # A narrowed envelope leaves a task a LIST of tool names; the preset-name check gave that list full tools, shell included.
    monkeypatch.setattr(config, "CC_CONFIG_DIR", tmp_path / "claude-config")
    t = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", "tools": ["read_file", "grep"]}, {}, 0)
    cmd = _command(t)
    assert cmd[cmd.index("--disallowedTools") + 1] == READ_ONLY_DISALLOWED
