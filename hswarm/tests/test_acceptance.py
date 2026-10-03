"""Offline: typed acceptance criteria are decided in code, against the disk and the receipt ledger, never the worker's word."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import acceptance  # noqa: E402
from hswarm.acceptance import FAILS, HOLDS, UNVERIFIED, decide, ran_command, tally  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox, find_bash  # noqa: E402

PYTEST = ["pytest", "-q"]
PASSED = "...\n3 passed in 0.12s\n"


def verdicts(rows):
    return [r["verdict"] for r in rows]


@pytest.mark.parametrize("recorded", [
    "pytest -q",
    "CI=1 pytest -q",
    "pytest -q 2>&1",
    "pip list > /dev/null; pytest -q && echo done",
    "pytest -q;\n",
    "HSWARM_RAW=1 pytest -q",        # the raw-output marker is stripped before the parse
])
def test_a_real_run_of_the_command_matches(recorded):
    assert ran_command(recorded, PYTEST), recorded


def test_a_cd_counts_only_when_it_lands_in_the_task_cwd(tmp_path):
    # `cd tests/unit && pytest -q` runs a narrower suite than the one named, so only a cd back to the cwd is a match.
    (tmp_path / "sub").mkdir()
    sb = Sandbox(tmp_path)
    assert ran_command("cd . && pytest -q", PYTEST, sb)
    assert ran_command(f"cd '{tmp_path.as_posix()}' && pytest -q", PYTEST, sb)
    assert not ran_command("cd sub && CI=1 pytest -q", PYTEST, sb)
    assert not ran_command("cd .. && pytest -q", PYTEST, sb)
    assert not ran_command("cd . && pytest -q", PYTEST)  # no sandbox to resolve it against: never a guess


@pytest.mark.parametrize("recorded", [
    'echo "pytest -q passed"',       # mentions it, runs echo
    "echo pytest -q",                # same, unquoted
    "pytest -q | tail -5",           # tail owns the exit status
    "pytest -q || true",             # a failure becomes exit 0
    "pytest -q; echo done",          # echo's exit is the one recorded
    "true || pytest -q",             # never ran
    "(pytest -q)",                   # subshell: not judged
    "echo $(pytest -q)",             # substitution: not judged
    "cat <<EOF\npytest -q\nEOF",     # heredoc body is text, not a command
    "pytest -q -k one_test",         # a narrower run is not the named run
    "cd sub && CI=1 pytest -q",      # another directory: a different or narrower suite
    "PYTEST_ADDOPTS='-k x' pytest -q",  # narrowed through the environment
    "PATH=/tmp/fake pytest -q",      # a different pytest
])
def test_mentions_masks_and_narrowed_runs_do_not_match(recorded):
    assert not ran_command(recorded, PYTEST), recorded


def test_tests_passed_is_decided_on_the_latest_matching_record(tmp_path):
    sb = Sandbox(tmp_path)
    crit = ["tests_passed:pytest -q"]
    ok = {"id": "r2", "tool": "bash", "command": "pytest -q", "exit": 0, "tail": PASSED}
    bad = {"id": "r1", "tool": "bash", "command": "pytest -q", "exit": 1, "tail": "1 failed, 2 passed"}
    assert verdicts(decide(crit, sb, [], [bad, ok])) == [HOLDS]
    assert verdicts(decide(crit, sb, [], [ok, bad])) == [FAILS]
    assert verdicts(decide(crit, sb, [], [{"tool": "bash", "command": "pytest -q", "exit": 0, "tail": "no summary here"}])) == [UNVERIFIED]
    assert verdicts(decide(crit, sb, [], [{"tool": "bash", "command": "echo pytest -q", "exit": 0, "tail": PASSED}])) == [UNVERIFIED]
    assert verdicts(decide(crit, sb, [], None)) == [UNVERIFIED]  # cc: no record, so never a pass
    # `trap 'exit 0' EXIT; pytest -q` exits 0 on a failing suite: the tail's failure count still decides it.
    forced = {"tool": "bash", "command": "pytest -q", "exit": 0, "tail": "1 failed, 2 passed in 0.3s"}
    assert verdicts(decide(crit, sb, [], [forced])) == [FAILS]


def test_file_leaves_and_untyped_criteria(tmp_path):
    (tmp_path / "out.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "empty.txt").write_text("", encoding="utf-8")
    sb = Sandbox(tmp_path)
    rows = decide(["file:out.txt", "file:empty.txt", "file:missing.txt", "file_written:out.txt", "file:../escape.txt", "the code is clean"],
                  sb, [], [])
    assert verdicts(rows) == [HOLDS, FAILS, FAILS, FAILS, UNVERIFIED, UNVERIFIED]  # out.txt exists but this worker never wrote it
    assert verdicts(decide(["file_written:out.txt"], sb, ["out.txt"], [])) == [HOLDS]
    assert tally(rows) == "1/6 hold, 3 fails, 2 UNVERIFIED"
    # bash writes too (`cat >`, `sed -i`): with bash on record an existing file is undecided, not "never written".
    assert verdicts(decide(["file_written:out.txt"], sb, [], [{"tool": "bash", "command": "cat > out.txt"}])) == [UNVERIFIED]


@pytest.mark.skipif(find_bash() is None, reason="no working bash on this machine")
def test_tests_passed_is_decided_on_the_sandbox_receipt_ledger(tmp_path):
    # The seam: acceptance reads the receipts the bash tool really stamps (receipts.py), not a record of its own.
    sb = Sandbox(tmp_path)
    (tmp_path / "check.sh").write_text("echo '3 passed in 0.1s'\n", encoding="utf-8")
    asyncio.run(sb.run_receipted("bash", {"command": "echo 'sh check.sh'"}))  # mentions it, never runs it
    assert verdicts(decide(["tests_passed:sh check.sh"], sb, [], sb.receipts)) == [UNVERIFIED]
    asyncio.run(sb.run_receipted("bash", {"command": "sh check.sh"}))
    assert verdicts(decide(["tests_passed:sh check.sh"], sb, [], sb.receipts)) == [HOLDS]
    asyncio.run(sb.run_receipted("bash", {"command": "sh check.sh && exit 3"}))
    assert verdicts(decide(["tests_passed:sh check.sh"], sb, [], sb.receipts)) == [FAILS]  # the latest matching run exited 3


def test_a_receipt_cut_at_its_command_limit_proves_nothing():
    # A receipt keeps CLAIM_CHARS of the command: past that a hidden `|| true` could follow the visible head.
    head = "pytest -q && " + "true && " * 40
    long = {"tool": "bash", "command": head[: acceptance.CLAIM_CHARS], "exit": 0, "tail": PASSED}
    assert verdicts(decide(["tests_passed:pytest -q"], None, [], [long])) == [UNVERIFIED]


def test_task_carries_acceptance_and_refuses_a_bad_shape(tmp_path):
    t = Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "model": "deepseek-flash", "acceptance": "file:a.txt"})
    assert t.acceptance == ["file:a.txt"]
    with pytest.raises(ValueError, match="acceptance"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "model": "deepseek-flash", "acceptance": [{"file": "a"}]})
