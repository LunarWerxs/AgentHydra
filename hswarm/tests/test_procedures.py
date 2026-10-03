"""Offline tests for the procedure miner: path-free signatures, the cross-session floor, write-once staging."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.procedures import mine, session_steps, tool_signature, write_candidates  # noqa: E402


def _session(path: Path, calls: list[tuple[str, dict]]) -> Path:
    """A Claude Code transcript: one assistant tool_use per message, each answered by a 2k-token result."""
    recs = [{"type": "user", "timestamp": "2026-09-2%sT10:00:00Z" % path.stem[-1], "message": {"content": "go"}}]
    for i, (name, inp) in enumerate(calls):
        recs.append({"type": "assistant", "message": {"id": f"m{i}", "usage": {"output_tokens": 100},
                                                      "content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}})
        recs.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": "x" * 8000}]}})
    path.write_text("\n".join(json.dumps(r) for r in recs), encoding="utf-8")
    return path


def _test_loop(tag: str) -> list[tuple[str, dict]]:
    return [("Read", {"file_path": f"C:/private/{tag}/app.py"}),
            ("Bash", {"command": f'cd "C:/private/{tag}" && python -m pytest -q tests/test_{tag}.py'}),
            ("Edit", {"file_path": f"C:/private/{tag}/app.py", "old_string": "a", "new_string": "b"})]


def _commit_loop(tag: str) -> list[tuple[str, dict]]:
    return [("Grep", {"pattern": tag}), ("Write", {"file_path": f"C:/private/{tag}/NOTES.md"}),
            ("Bash", {"command": f"git -C C:/private/{tag} commit -m {tag}"})]


def test_signatures_drop_paths_and_arguments():
    assert tool_signature({"name": "Read", "input": {"file_path": "C:/private/x/main.GO"}}) == "Read(*.go)"
    assert tool_signature({"name": "Bash", "input": {"command": 'cd "C:/p" && FOO=1 python -m pytest -q'}}) == "Bash(pytest)"
    assert tool_signature({"name": "Bash", "input": {"command": "git status --short"}}) == "Bash(git status)"
    assert tool_signature({"name": "Bash", "input": {"command": 'git -C "C:/p q" -c a=b log -1'}}) == "Bash(git log)"
    assert tool_signature({"name": "Bash", "input": {"command": '"C:/Program Files/x/tool.exe" --secret-path C:/p'}}) == "Bash(tool)"


def test_mines_only_procedures_recurring_across_enough_sessions(tmp_path):
    # The test loop recurs in 3 sessions; the commit loop only in 2, so it must not be mined.
    paths = [_session(tmp_path / "sess1", _test_loop("a") + _commit_loop("a")),
             _session(tmp_path / "sess2", _test_loop("b") + _commit_loop("b")),
             _session(tmp_path / "sess3", _test_loop("c"))]
    cands = mine([session_steps(p) for p in paths])
    assert [c["steps"] for c in cands] == [["Read(*.py)", "Bash(pytest)", "Edit(*.py)"]]
    c = cands[0]
    assert c["sessions"] == 3 and c["runs"] == 3 and c["rederive_tokens"] == 3 * 3 * (100 + 2000)
    assert c["last_seen"] == "2026-09-23"

    written = write_candidates(tmp_path / "staging", cands)
    assert len(written) == 1
    doc = written[0].read_text(encoding="utf-8")
    assert "trust: unreviewed" in doc and "`Bash(pytest)`" in doc and "private" not in doc
    assert write_candidates(tmp_path / "staging", cands) == []  # write-once
    # Still write-once after triage moved it and after a newer session moved last_seen on.
    (tmp_path / "staging" / "keep").mkdir()
    written[0].rename(tmp_path / "staging" / "keep" / written[0].name)
    assert write_candidates(tmp_path / "staging", [dict(c, last_seen="2026-10-01")]) == []

    # Below the token floor a recurring procedure is not worth banking.
    assert mine([session_steps(p) for p in paths], min_tokens=10**6) == []


def test_rotations_of_one_loop_are_one_candidate(tmp_path):
    # An edit-test cycle repeated in each session yields (Read,Bash,Edit), (Bash,Edit,Read), ... windows.
    paths = [_session(tmp_path / f"sess{i}", _test_loop(t) * 3) for i, t in enumerate("abc", 1)]
    assert len(mine([session_steps(p) for p in paths])) == 1
