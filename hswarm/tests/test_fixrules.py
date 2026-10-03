"""Offline: the error-output-to-fix rules a failed worker bash call is run through. No network, no model."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.fixrules import suggest  # noqa: E402
from hswarm.tools import Sandbox, fix_note  # noqa: E402

GIT_TYPO = "git: 'stauts' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus\n"
NO_UPSTREAM = (
    "fatal: The current branch topic has no upstream branch.\n"
    "To push the current branch and set the remote as upstream, use\n\n"
    "    git push --set-upstream origin topic\n"
)


def test_rules_turn_recognised_failures_into_ready_commands(tmp_path):
    # Contract: a recognised (command, output) yields the corrected command, best first.
    assert suggest("git -C repo stauts --short", GIT_TYPO, tmp_path)[0].command == "git -C repo status --short"
    (tmp_path / "hswarm").mkdir()
    assert suggest("python tests/x.py", "ModuleNotFoundError: No module named 'hswarm.tools'", tmp_path)[0].command == (
        "PYTHONPATH=. python tests/x.py"
    )
    out = "mkdir: cannot create directory 'a/b': No such file or directory"
    assert suggest("mkdir a/b && touch a/b/c", out, tmp_path)[0].command == "mkdir -p a/b && touch a/b/c"
    assert suggest("grep TODO src", "grep: src: Is a directory", tmp_path)[0].command == "grep -r TODO src"
    assert suggest("echo hi", "some unrelated failure", tmp_path) == []


def test_fix_note_never_offers_a_git_write_the_sandbox_refuses(tmp_path, monkeypatch):
    # Regression: the push fix is correct for a person but refused for a worker, so offering it wastes the turn.
    monkeypatch.delenv("HSWARM_ALLOW_GIT_WRITES", raising=False)
    assert suggest("git push", NO_UPSTREAM, tmp_path)[0].command == "git push --set-upstream origin topic"
    assert fix_note("git push", NO_UPSTREAM, tmp_path) == ""
    monkeypatch.setenv("HSWARM_ALLOW_GIT_WRITES", "1")
    assert "[likely fix] git push --set-upstream origin topic" in fix_note("git push", NO_UPSTREAM, tmp_path)


def test_failed_bash_call_carries_the_fix_in_its_tool_result(tmp_path):
    # Seam: the worker's bash tool itself, so a misspelled cd comes back with the retry already written.
    (tmp_path / "fixtures").mkdir()
    sb = Sandbox(tmp_path)
    out = asyncio.run(sb.run("bash", {"command": "cd fixtuers && ls"}))
    assert not out.startswith("exit=0")
    assert "[likely fix] cd fixtures && ls" in out
    assert "[likely fix]" not in asyncio.run(sb.run("bash", {"command": "cd fixtures && ls"}))
