"""Offline, but across the real process boundary: run_cc_task spawns the replay mock in place of
`claude` (tests/mocks/bin/claude.py), feeds it the prompt on stdin and parses what it streams back.
test_cc.py pins the parser on strings; these pin the spawn, the pipes and the parse together."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import cc, config  # noqa: E402
from hswarm.spec import Task  # noqa: E402

KEY = "sk-mock-not-a-real-key"


def _task(tmp_path, **kw) -> Task:
    repo = tmp_path / "repo"
    repo.mkdir(exist_ok=True)
    return Task.from_dict({"prompt": "set notes.md status to final", "cwd": str(repo), "backend": "cc", "model": config.DEFAULT_MODEL, "tools": "all", "confirm_write": True, "timeout_s": 60, **kw}, {}, 0)


def test_a_replayed_session_crosses_the_process_boundary_and_parses_end_to_end(tmp_path, mock_claude):
    capture = mock_claude("edit-session")
    task = _task(tmp_path)
    res, transcript = asyncio.run(cc.run_cc_task(task, KEY))

    assert res.status == "ok", res.error
    assert res.answer == "notes.md:2 status set to final" and res.turns == 3
    assert res.tool_calls == 3 and res.files_changed == ["notes.md"]  # Read, Grep, Edit; only the Edit changed a file
    # Cost is recomputed from usage at the serving rates, never Claude Code's own total_cost_usd (0.0215).
    assert res.usage == {"in_hit": 800, "in_miss": 500, "out": 150, "reasoning": 0, "in_write": 100}
    assert res.cost_usd == config.cost_usd(task.model, 800, 500, 150, write=100) and res.cost_usd != 0.0215
    assert transcript["exit"] == 0

    seen = json.loads(capture.read_text(encoding="utf-8"))
    assert seen["stdin"].startswith("set notes.md status to final")  # the prompt rides stdin, not argv
    assert seen["argv"][seen["argv"].index("--output-format") + 1] == "stream-json" and "--verbose" in seen["argv"]
    assert KEY not in json.dumps(seen["argv"])
    assert "ANTHROPIC_API_KEY" in seen["anthropic_env"] and seen["base_url"] == config.PROVIDERS[config.DEFAULT_PROVIDER]["anthropic_url"]
    assert Path(seen["cwd"]).resolve() == Path(task.cwd).resolve()


def test_a_replayed_turn_cap_exit_reads_as_the_turn_cap_not_stderr_noise(tmp_path, mock_claude):
    mock_claude("max-turns")
    res, transcript = asyncio.run(cc.run_cc_task(_task(tmp_path, max_turns=3), KEY))
    assert res.status == "error" and transcript["exit"] == 1
    assert "max_turns=3" in res.error and "permissions.allow" not in res.error, res.error


def test_a_replayed_402_is_recognised_as_out_of_balance(tmp_path, mock_claude):
    mock_claude("out-of-balance")
    res, _ = asyncio.run(cc.run_cc_task(_task(tmp_path), KEY))
    assert res.status == "error" and cc.out_of_balance(res), res.error
    # Claude Code says num_turns 1 for a request the key refused: no model call was made, so the next key's run gets
    # the task's whole max_turns (2026-10-08: dead keys left a 4-turn live task 2 turns, and it stopped at that cap).
    assert res.turns == 0
