"""Offline: the shared server restarts itself onto the clone's newest commit, once, safely; and its log is rotated."""
from __future__ import annotations

import os
import types
from pathlib import Path

import pytest

from hswarm import livecode, shared

NOW = 1_000_000.0


@pytest.fixture
def server(monkeypatch):
    """A server up for an hour that runs commit c0's copy, while the clone's newest commit (c1, ten minutes old) changed
    hswarm and imports, with no job running: every gate open. A test closes one."""
    world = types.SimpleNamespace(head={"commit": "c1" * 20, "tree": "t1", "at": NOW - 600}, imports=True, running=0, readied=[],
                                  mine={"commit": "c0" * 20, "tree": "t0", "source": "C:/Users/me/clone"})

    def ready(src, head):
        world.readied.append(head["tree"])
        return Path("C:/Users/me/.hswarm/code") / head["tree"] if world.imports else None

    monkeypatch.setattr(livecode, "running", lambda: world.mine)
    monkeypatch.setattr(livecode, "head", lambda src: world.head)
    monkeypatch.setattr(livecode, "ready", ready)
    monkeypatch.setattr(shared, "_running_jobs", lambda: world.running)
    world.state = {"started": NOW - 3600}
    return world


# Contract: a shared server on an older commit than the clone's hands over to a successor, and only onto a commit that
# is quiet for SETTLE_S and imports. Regression: pid 43908 ran 2026-09-30 code for 48 h and $319.04 of tasks while five
# fixes sat on disk, because nothing acted on `behind` (before 2026-10-02 there was no watcher at all); and the unsafe
# fixes: a restart onto a tree that cannot start takes every chat's server down. What is NOT committed never counts:
# that is livecode's own test (test_livecode), since a server only ever sees the clone's commits.
def test_a_server_behind_the_clones_last_commit_restarts_onto_it_once_that_commit_is_quiet(server):
    assert shared._restart_due(server.state, NOW)

    server.head = dict(server.head, tree="t0")
    assert not shared._restart_due({"started": NOW - 3600}, NOW)  # the newest commit did not change hswarm

    server.head = {"commit": "c2" * 20, "tree": "t2", "at": NOW - 10}  # committed ten seconds ago: a fix-up may follow
    state = {"started": NOW - 3600}
    assert not shared._restart_due(state, NOW)
    assert shared._restart_due(state, NOW + shared.SETTLE_S)  # the same commit, left alone since


# Contract: every chat's server ends up on committed code. One on a clone's working tree (started by hand, or by a chat
# whose connect predates the copies: 2026-10-07, such chats stay open for days) moves onto that clone's commit; an
# install with no clone beside it has nothing to follow and never restarts.
def test_a_server_on_a_working_tree_moves_onto_its_clones_commit_and_an_install_never_restarts(server, monkeypatch):
    monkeypatch.setattr(livecode, "running", lambda: None)
    monkeypatch.setattr(livecode, "source", lambda: Path("C:/Users/me/clone"))
    assert shared._restart_due(server.state, NOW) and server.readied == ["t1"]
    monkeypatch.setattr(livecode, "source", lambda: None)
    assert not shared._restart_due({"started": NOW - 3600}, NOW + 86_400)


def test_a_commit_that_cannot_be_imported_is_never_restarted_onto_and_is_asked_about_again_only_later(server):
    server.imports = False
    assert not shared._restart_due(server.state, NOW)
    assert not shared._restart_due(server.state, NOW + 60) and server.readied == ["t1"]  # not at every look
    # Regression (2026-10-07 review): a failed check barred its commit for good, though one that ran out of time on a
    # machine at 100% CPU says nothing about the commit.
    assert not shared._restart_due(server.state, NOW + livecode.RECHECK_S) and server.readied == ["t1", "t1"]
    server.head = {"commit": "c2" * 20, "tree": "t2", "at": NOW - 600}  # the fix for it lands
    server.imports = True
    assert shared._restart_due(server.state, NOW + livecode.RECHECK_S + 60) and server.readied == ["t1", "t1", "t2"]


# Contract: a restart cannot loop. A successor that still finds the disk different from what it loaded (a file written
# while it was starting) does not restart again inside MIN_UP_S, so restarts are at most one per half hour.
def test_a_server_that_just_started_does_not_restart_again(server):
    assert not shared._restart_due({"started": NOW - shared.MIN_UP_S + 1}, NOW)
    assert shared._restart_due({"started": NOW - shared.MIN_UP_S}, NOW)


# Contract: a restart re-runs every task in flight, so a due restart waits for a moment with no running job, and no
# longer than BUSY_HOLD_S: on this machine the idle moment may never come (memory restarting-the-shared-server-is-safe).
def test_a_due_restart_waits_for_running_jobs_but_not_for_ever(server):
    server.running = 2
    assert not shared._restart_due(server.state, NOW)
    # Regression (2026-10-07): on a busy day a newer commit lands inside the hold; it restarted the hold, so a server that
    # always had a job running never moved.
    server.head = {"commit": "c2" * 20, "tree": "t2", "at": NOW - 600}
    assert not shared._restart_due(server.state, NOW + shared.BUSY_HOLD_S - 1) and server.readied == ["t1", "t2"]
    assert shared._restart_due(server.state, NOW + shared.BUSY_HOLD_S)
    server.running = 0
    assert shared._restart_due({"started": NOW - 3600}, NOW)  # nothing running: at once


# Contract: two triggers never start two servers. The hand-over takes the start lock ensure() starts servers under and
# keeps it for the helper; while a chat holds it (it is starting a server right now) the hand-over starts nothing.
def test_the_hand_over_holds_the_start_lock_and_yields_to_a_chat_that_has_it(monkeypatch):
    started = []
    monkeypatch.setattr(shared, "_detached", lambda argv, out: started.append(argv) or 99)
    lock = shared.lock_path(7793)
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("a chat starting the server")
    assert not shared._hand_over(7793) and started == []
    lock.unlink()
    assert shared._hand_over(7793) and len(started) == 1
    assert started[0][-2:] == ["7793", str(os.getpid())]  # the helper is told which port, and which process to outlive
    assert lock.exists()  # held for the helper: a chat connecting mid-switch waits instead of starting its own
    assert not shared._hand_over(7793) and len(started) == 1


# Contract: the helper starts the successor only once the old server is gone (one process holds the port), and always
# releases the start lock, so a failed switch is repaired by the next chat's ensure() instead of blocking it.
def test_the_helper_starts_the_successor_only_after_the_old_server_is_gone(monkeypatch):
    spawned = []
    monkeypatch.setattr(shared, "_spawn", lambda port: spawned.append(port) or 77)
    monkeypatch.setattr(shared, "_wait", lambda port, wait_s: {"hswarm": True, "pid": 77})
    lock = shared.lock_path(7793)
    lock.parent.mkdir(parents=True, exist_ok=True)

    lock.write_text("the old server")
    monkeypatch.setattr(shared, "pid_alive", lambda pid: True)  # the old server will not die
    shared.succeed(7793, 4242, wait_s=0.3)
    assert spawned == [] and not lock.exists()
    assert "4242 did not exit" in shared.log_path(7793).read_text(encoding="utf-8")

    lock.write_text("the old server")
    monkeypatch.setattr(shared, "pid_alive", lambda pid: False)
    shared.succeed(7793, 4242, wait_s=0.3)
    assert spawned == [7793] and not lock.exists()


# Contract: the server log does not grow for ever (113 MB in 6.4 days, 2026-10-02): a start finds it over the limit and
# keeps it as .1. A rename Windows refuses (a busy or deaf server still holds the log open) must not stop the start.
def test_spawn_rotates_a_big_log_and_still_starts_when_the_rename_is_refused(monkeypatch):
    monkeypatch.setattr(shared, "LOG_ROTATE_BYTES", 10)
    monkeypatch.setattr(livecode, "target", lambda: None)
    monkeypatch.setattr(shared.subprocess, "Popen", lambda argv, **kw: types.SimpleNamespace(pid=4242))
    log = shared.log_path(7793)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_bytes(b"x" * 11)
    assert shared._spawn(7793) == 4242
    assert log.with_name(log.name + ".1").read_bytes() == b"x" * 11 and log.read_bytes() == b""

    log.write_bytes(b"y" * 11)

    def refused(src, dst):
        raise PermissionError(13, "The process cannot access the file because it is being used by another process")

    monkeypatch.setattr(shared.os, "replace", refused)
    assert shared._spawn(7793) == 4242
    assert log.read_bytes() == b"y" * 11  # appended to, as before


# Contract: a chat connecting from another clone or a worktree is told the server is behind only by the commits of the
# clone that server follows (its /health package), never by its own checkout's.
def test_a_connect_from_another_checkout_judges_the_server_by_the_clone_it_follows(monkeypatch):
    trees = {"C:/Users/me/clone": "t1", "C:/Users/me/worktree": "t9"}
    monkeypatch.setattr(livecode, "head", lambda src: {"commit": "c1" * 20, "tree": trees[src.as_posix()], "at": NOW})
    monkeypatch.setattr(livecode, "source", lambda: Path("C:/Users/me/worktree"))
    h = {"hswarm": True, "pid": 4242, "package": "C:/Users/me/clone", "tree": "t1", "commit": "c1c1c1c1c1c1"}
    assert "behind" not in shared._answer(h, 7793, "running")
    assert "C:/Users/me/clone has committed" in shared._answer(dict(h, tree="t0"), 7793, "running")["behind"]


# Contract: a server a chat's connect or a restart hand-over starts runs the clone's committed copy, not the starter's
# own folder. Regression: with the starter's folder, a connect from a clone another session is half-way through editing
# loads that edit into every chat's server, and a hand-over helper (it runs the copy being replaced) restarts the
# server onto the same old commit for ever.
def test_a_started_server_runs_the_committed_copy(monkeypatch, tmp_path):
    seen = {}
    copy = tmp_path / "code" / "615b0cacff15"
    monkeypatch.setattr(livecode, "target", lambda: copy)
    monkeypatch.setattr(shared.subprocess, "Popen", lambda argv, **kw: seen.update(argv=argv, env=kw["env"]) or types.SimpleNamespace(pid=4242))
    assert shared._spawn(7793) == 4242
    assert seen["argv"][-5:] == [str(copy), "mcp", "--http", "--port", "7793"]
    assert seen["env"]["PYTHONPATH"].split(os.pathsep)[0] == str(copy)
