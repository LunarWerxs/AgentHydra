"""Offline: scripted-diff mode. A change is accepted only when the script it carries replays to the same tree.

Runs real git and bash on a throwaway repo under tmp_path; no network, no worker, no model call."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import scripted  # noqa: E402
from hswarm.procs import find_bash  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402

needs_git_bash = pytest.mark.skipif(shutil.which("git") is None or find_bash() is None, reason="needs git and a working bash")

RENAME = "perl -pi -e 's/old_name/new_name/g' app.py\nprintf 'new_name\\n' > NAMES.txt"


def git(repo: Path, *args: str) -> str:
    cmd = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *args]
    return subprocess.run(cmd, cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "core.autocrlf", "false")  # the throwaway repo's own config: byte-exact trees on every OS
    (repo / "app.py").write_text("def old_name():\n    return old_name\n", encoding="utf-8", newline="\n")
    git(repo, "add", "app.py")
    git(repo, "commit", "-q", "-m", "init")
    return repo


def run_script(repo: Path, script: str) -> None:
    subprocess.run([find_bash(), "-euo", "pipefail", "-c", script], cwd=repo, check=True, capture_output=True)


def commit_all(repo: Path, message: str) -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def scripted_message(title: str, script: str) -> str:
    return f"{title}\n\n{scripted.BEGIN}\n{script}\n{scripted.END}\n"


@needs_git_bash
def test_check_range_replays_scripted_commits_and_rejects_hand_edits_and_stray_markers(tmp_path):
    """Contract: `hswarm scripted check` passes a scripted-diff commit only when its script reproduces the commit's tree,
    and fails marker lines under an ordinary title. Regression: a commit that sneaks a hand edit past its script."""
    repo = make_repo(tmp_path)
    run_script(repo, RENAME)
    commit_all(repo, scripted_message("scripted-diff: rename old_name", RENAME))
    run_script(repo, "perl -pi -e 's/new_name/newer/g' app.py")
    (repo / "app.py").write_text((repo / "app.py").read_text(encoding="utf-8") + "# hand edit\n", encoding="utf-8", newline="\n")
    commit_all(repo, scripted_message("scripted-diff: rename new_name", "perl -pi -e 's/new_name/newer/g' app.py"))
    (repo / "README").write_text("x\n", encoding="utf-8")
    commit_all(repo, scripted_message("docs: add readme", "true"))

    rows = asyncio.run(scripted.check_range(repo, "HEAD~3..HEAD"))
    assert [r["status"] for r in rows] == ["ok", "failed", "failed"]
    assert "reproduce" in rows[1]["error"] and "app.py" in rows[1]["mismatch"]
    assert "not titled" in rows[2]["error"]
    assert scripted.main(["check", "HEAD~3..HEAD~2", "--repo", str(repo)]) == 0


@needs_git_bash
def test_settle_accepts_a_worker_tree_only_when_its_script_replays_to_it(tmp_path):
    """Contract: the scripted task mode keeps `ok` only when the replay of the submitted script equals the worker's
    working tree (untracked files included). Regression: a worker whose script and edits disagree passing as ok."""
    repo = make_repo(tmp_path)
    base = asyncio.run(scripted.snapshot(repo))
    run_script(repo, RENAME)  # what the worker did in its cwd; NAMES.txt is a new, untracked file
    ok = Result(id="t1", status="ok", data={"script": RENAME})
    asyncio.run(scripted.settle(ok, str(repo), base))
    assert ok.status == "ok" and ok.data["replay"]["verified"] and ok.data["replay"]["changed"]
    assert git(repo, "status", "--porcelain") != "" and "hswarm-replay" not in git(repo, "worktree", "list")  # cwd untouched, worktree gone

    (repo / "app.py").write_text("tampered\n", encoding="utf-8", newline="\n")
    bad = Result(id="t2", status="ok", data={"script": RENAME})
    asyncio.run(scripted.settle(bad, str(repo), base))
    assert bad.status == "error" and bad.error.startswith("ScriptMismatch") and not bad.data["replay"]["verified"]

    empty = Result(id="t3", status="ok", data={"summary": "no script"})
    asyncio.run(scripted.settle(empty, str(repo), base))
    assert empty.status == "error" and "no script" in empty.error


@needs_git_bash
def test_settle_refuses_scripts_that_would_reach_the_real_checkout(tmp_path, monkeypatch):
    """Contract: settle never replays a script that writes git state (the replay worktree shares refs, stash and config
    with the real repo) or names the checkout's absolute path (the replay would edit the real tree a second time).
    Regression: a `git stash` or `sed -i <abs path>` script replayed against the user's repository."""
    monkeypatch.delenv("HSWARM_ALLOW_GIT_WRITES", raising=False)
    repo = make_repo(tmp_path)
    base = asyncio.run(scripted.snapshot(repo))

    stash = Result(id="t1", status="ok", data={"script": "git stash"})
    asyncio.run(scripted.settle(stash, str(repo), base))
    assert stash.status == "error" and stash.error.startswith("ScriptedDiff:") and "stash" in stash.error

    absolute = f"printf 'x\\n' >> '{(repo / 'app.py').as_posix()}'"
    run_script(repo, absolute)
    before = (repo / "app.py").read_bytes()
    appended = Result(id="t2", status="ok", data={"script": absolute})
    asyncio.run(scripted.settle(appended, str(repo), base))
    assert appended.status == "error" and appended.error.startswith("ScriptedDiff:") and "absolute path" in appended.error
    assert (repo / "app.py").read_bytes() == before  # the real checkout was not edited a second time


def test_scripted_task_spec_forces_the_script_contract(tmp_path):
    """Contract: a scripted task returns its script through the schema, is told the replay rule, and is refused when it
    could never be verified (no bash, no git checkout, a schema of its own)."""
    checkout = tmp_path / "checkout"
    (checkout / ".git").mkdir(parents=True)
    t = Task.from_dict({"prompt": "rename x to y", "cwd": str(checkout), "tools": "all", "scripted": True}, {}, 0)
    assert t.schema == scripted.SCRIPT_SCHEMA and scripted.SCRIPTED_CLAUSE in t.system
    assert Task.from_dict(t.as_dict(), {}, 0).system.count(scripted.SCRIPTED_CLAUSE) == 1  # a re-parse does not stack the clause
    with pytest.raises(ValueError, match="bash"):
        Task.from_dict({"prompt": "p", "cwd": str(checkout), "tools": "edit", "scripted": True}, {}, 0)
    with pytest.raises(ValueError, match="schema"):
        Task.from_dict({"prompt": "p", "cwd": str(checkout), "tools": "all", "scripted": True, "schema": {"type": "object"}}, {}, 0)
    plain = tmp_path / "plain"
    plain.mkdir()
    if not any((p / ".git").exists() for p in plain.resolve().parents):  # tmp_path itself may sit in a checkout on some machines
        with pytest.raises(ValueError, match="git checkout"):
            Task.from_dict({"prompt": "p", "cwd": str(plain), "tools": "all", "scripted": True}, {}, 0)
