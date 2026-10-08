"""Offline, on a throwaway git repo: the shared server runs what the clone COMMITTED (hswarm/livecode.py).

Contract: a production start serves an export of the clone's last commit, never its working tree; a commit that cannot
be imported is never served, and the last one that could keeps serving; the daemon's `python -m hswarm mcp --http`
runs that copy, while a server started by hand runs its own code. Regression it catches (2026-10-07): the server ran the
working tree, so its restart waited for a moment with no uncommitted edit, which never came on a busy day; pid 68140 ran
22:38Z code for hours while 11 hswarm commits landed, the 400 failover and the schema routing fix among them.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from hswarm import livecode
from hswarm.procgate import pid_alive
from hswarm.procs import kill_tree

# The stand-in package's __main__ has the real one's shape: the daemon's start goes through serve_committed first. A
# copy that started yet another copy would count a third hop and fail, instead of starting copies for ever.
MAIN = """import os, pathlib, sys, time
hops = int(os.environ.get("TEST_HOPS", "0")) + 1
os.environ["TEST_HOPS"] = str(hops)
if hops > 2:
    sys.exit(4)
from hswarm.livecode import serve_committed
if (code := serve_committed(sys.argv[1:])) is not None:
    sys.exit(code)
pathlib.Path(sys.argv[-1]).write_text(f"{__file__}\\n{os.getpid()}", encoding="utf-8")
time.sleep(float(os.environ.get("TEST_SERVE_S", "0")))
sys.exit(3)
"""


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.email=owner@example.test", "-c", "user.name=Example Owner", "-C", str(repo), *args],
                   check=True, capture_output=True)


def _commit(repo: Path, files: dict[str, str]) -> None:
    for name, text in files.items():
        (repo / "hswarm" / name).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "x")


@pytest.fixture
def clone(tmp_path, monkeypatch):
    """A clone whose committed `hswarm` is a stand-in package with the real livecode: the import check is `import
    hswarm` (the real start path needs the whole real package), and head() is read afresh every time."""
    repo = tmp_path / "clone"
    (repo / "hswarm").mkdir(parents=True)
    _git(repo, "init", "-q")
    _commit(repo, {"__init__.py": "X = 1\n", "__main__.py": MAIN,
                   "livecode.py": Path(livecode.__file__).read_text(encoding="utf-8")})
    monkeypatch.setattr(livecode, "START_IMPORTS", "import hswarm")
    monkeypatch.setattr(livecode, "HEAD_FRESH_S", 0.0)
    monkeypatch.setattr(livecode, "source", lambda: repo)
    monkeypatch.delenv("TEST_HOPS", raising=False)
    return repo


def _x(copy: Path) -> str:
    return (copy / "hswarm" / "__init__.py").read_text(encoding="utf-8").strip()


def test_the_server_runs_what_the_clone_committed_never_its_working_tree(clone):
    (clone / "hswarm" / "__init__.py").write_text("X = (  # another session, half-way through an edit\n", encoding="utf-8")
    copy = livecode.target()
    assert copy and _x(copy) == "X = 1"
    assert json.loads((copy / livecode.MARKER).read_text(encoding="utf-8"))["tree"] == livecode.head(clone)["tree"]


def test_a_commit_that_cannot_be_imported_is_never_served_and_the_last_good_one_keeps_serving(clone, monkeypatch):
    good = livecode.target()
    checks = []
    real = livecode._imports
    monkeypatch.setattr(livecode, "_imports", lambda dest: checks.append(dest) or real(dest))
    _commit(clone, {"__init__.py": "X = (\n"})
    assert livecode.target() == good and livecode.target() == good
    assert len(checks) == 1  # a commit is import-checked once, not at every start or watcher look
    # Regression (2026-10-07 review): a failed check barred its commit for good, though one that ran out of time on a
    # machine at 100% CPU says nothing about the commit; it is run again after RECHECK_S.
    monkeypatch.setattr(livecode, "RECHECK_S", 0.0)
    assert livecode.target() == good and len(checks) == 2
    _commit(clone, {"__init__.py": "X = 3\n"})  # the fix for it lands
    assert _x(livecode.target()) == "X = 3"


# Regression: prune's rmtree stops at a file something still holds open and leaves the folder without its marker;
# that folder then refused the tree's export, so the server never moved onto that commit again. And the 2026-10-07
# review's race: a young marker-less folder may be another start's export landing between the check and the removal.
def test_a_copy_prune_could_not_finish_removing_blocks_its_commit_only_briefly(clone):
    left = livecode.code_root() / livecode.head(clone)["tree"][:12] / "hswarm"
    left.mkdir(parents=True)
    (left / "__init__.py").write_text("X = 'half removed'\n", encoding="utf-8")
    assert livecode.target() is None and left.is_dir()  # young: left alone, and the last good copy (none here) serves
    old = time.time() - 2 * livecode.LEFTOVER_S
    os.utime(left.parent, (old, old))
    assert _x(livecode.target()) == "X = 1"


class _Exec(BaseException):
    """POSIX's os.execv stand-in: the start would become the copy's server, which would end this test run."""


def test_the_daemons_start_serves_the_committed_copy_and_a_hand_start_serves_its_own(clone, monkeypatch, tmp_path):
    def execv(exe, cmd):
        raise _Exec(subprocess.run(cmd).returncode)

    monkeypatch.setattr(livecode.os, "execv", execv)
    out = tmp_path / "ran-from.txt"
    monkeypatch.delenv("HSWARM_SUPERVISED", raising=False)
    assert livecode.serve_committed(["mcp", "--http", str(out)]) is None  # by hand: this process serves its own code
    monkeypatch.setenv("HSWARM_SUPERVISED", "1")
    try:
        code = livecode.serve_committed(["mcp", "--http", str(out)])
    except _Exec as e:
        code = e.args[0]
    assert code == 3  # the copy's server ran (itself, not a further copy), and its exit is the start's
    assert Path(out.read_text(encoding="utf-8").splitlines()[0]).parent.parent == livecode.target()


# Contract: ending the start the daemon supervises ends the server it started (Windows: a kill-on-close job; POSIX: exec,
# one pid). Regression: a broken job (its ctypes layout or flags) leaves the copy's server holding the port after the
# daemon ends its start, and every later start fails to bind.
def test_ending_the_daemons_start_ends_the_server_it_started(clone, tmp_path):
    copy = livecode.target()  # exported and import-checked here, against the stand-in's import list
    out = tmp_path / "ran-from.txt"
    env = dict(os.environ, HSWARM_SUPERVISED="1", HSWARM_HOME=str(livecode.home()), TEST_SERVE_S="120")
    start = subprocess.Popen([sys.executable, "-m", "hswarm", "mcp", "--http", str(out)], cwd=str(clone), env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=livecode.CREATE_NO_WINDOW)
    pid = None
    try:
        deadline = time.monotonic() + 60
        while len(out.read_text(encoding="utf-8").splitlines() if out.exists() else []) < 2:
            assert start.poll() is None and time.monotonic() < deadline
            time.sleep(0.1)
        ran_from, pid = out.read_text(encoding="utf-8").splitlines()
        assert Path(ran_from).parent.parent == copy
        start.kill()  # the daemon ends its start alone, not a process tree
        start.wait(10)
        deadline = time.monotonic() + 10
        while pid_alive(int(pid)) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not pid_alive(int(pid))
    finally:
        start.kill()
        if pid and pid_alive(int(pid)):
            kill_tree(int(pid))


def test_prune_keeps_every_copy_a_process_may_still_run_and_removes_the_rest(monkeypatch):
    # A server imports some modules late: a pruned folder under a live server breaks it mid-run, for every chat.
    root = livecode.code_root()
    old = time.time() - 2 * livecode.KEEP_S
    for day, name in enumerate(["e1", "e2", "e3", "e4", "e5"], start=1):  # e5 exported last
        d = root / name
        (d / "hswarm").mkdir(parents=True)
        (d / livecode.MARKER).write_text(json.dumps({"exported_at": f"2026-01-0{day}T00:00:00Z"}), encoding="utf-8")
        if name != "e3":  # e3's marker was written just now (an import re-check): a helper may still run it
            os.utime(d / livecode.MARKER, (old, old))
    (root / "half-removed" / "hswarm").mkdir(parents=True)  # a copy an earlier prune left without its marker
    (root / "landing" / "hswarm").mkdir(parents=True)  # marker-less but young: an export may be landing right now
    (root / ".e6.4242.tmp").mkdir()  # a start exporting right now
    (root / ".e0.4242.tmp").mkdir()  # a start that crashed mid-export
    for p in (root / "half-removed", root / ".e0.4242.tmp"):
        os.utime(p, (old, old))
    (root / "current.json").write_text(json.dumps({"dir": str(root / "e4")}), encoding="utf-8")
    monkeypatch.setattr(livecode, "PACKAGE", root / "e1" / "hswarm")  # this server runs the oldest
    livecode.prune(keep=1)
    # e5 is the last exported though e3's marker is newer; e2 is the only old copy nobody may run
    assert sorted(p.name for p in root.iterdir() if p.is_dir()) == [".e6.4242.tmp", "e1", "e3", "e4", "e5", "landing"]
