"""Offline: the shared server restarts itself onto the code on disk, once, safely; and its log is rotated."""
from __future__ import annotations

import os
import types

import pytest

from hswarm import shared

NOW = 1_000_000.0
T0 = int((NOW - 86_400) * 1e9)  # what the server loaded: a day old


def _ns(age_s: float) -> int:
    return int((NOW - age_s) * 1e9)


@pytest.fixture
def server(monkeypatch):
    """A server up for an hour whose dispatch.py was rewritten on disk ten minutes ago, committed and importable, with
    no job running: every gate open. A test closes one."""
    world = types.SimpleNamespace(disk={"dispatch.py": _ns(600), "agent.py": T0}, committed=True, importable=True, running=0, imports=0)

    def importable():
        world.imports += 1
        return world.importable

    monkeypatch.setattr(shared, "LOADED", {"dispatch.py": T0, "agent.py": T0})
    monkeypatch.setattr(shared, "_sources", lambda: dict(world.disk))
    monkeypatch.setattr(shared, "_committed", lambda: world.committed)
    monkeypatch.setattr(shared, "_importable", importable)
    monkeypatch.setattr(shared, "_running_jobs", lambda: world.running)
    world.state = {"started": NOW - 3600}
    return world


# Contract: a shared server on older code than the disk hands over to a successor, and only onto code that is finished:
# committed, quiet for SETTLE_S, importable. Regression: pid 43908 ran 2026-09-30 code for 48 h and $319.04 of tasks
# while five fixes sat on disk, because nothing acted on `behind` (before 2026-10-02 there was no watcher at all); and
# the unsafe fixes: a restart onto a half-saved edit, or onto a tree that cannot start, takes every chat's server down.
def test_a_server_behind_the_disk_restarts_only_onto_finished_code(server):
    assert shared._restart_due(server.state, NOW)

    server.disk = dict(shared.LOADED)
    assert not shared._restart_due({"started": NOW - 3600}, NOW)  # the code on disk is the code loaded

    server.disk = {"dispatch.py": _ns(10), "agent.py": T0}  # saved ten seconds ago: someone is still editing
    state = {"started": NOW - 3600}
    assert not shared._restart_due(state, NOW)
    assert shared._restart_due(state, NOW + shared.SETTLE_S)  # the same file, left alone since

    server.committed = False  # quiet, but not committed
    assert not shared._restart_due({"started": NOW - 3600}, NOW + shared.SETTLE_S)


def test_code_that_cannot_be_imported_is_never_restarted_onto_and_is_asked_about_once(server):
    server.importable = False
    assert not shared._restart_due(server.state, NOW)
    assert not shared._restart_due(server.state, NOW + 60) and server.imports == 1  # the same disk state: not imported again
    server.disk = {"dispatch.py": _ns(600) + 1, "agent.py": T0}  # the fix for it lands
    server.importable = True
    assert shared._restart_due(server.state, NOW + 120) and server.imports == 2


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
    assert not shared._restart_due(server.state, NOW + shared.BUSY_HOLD_S - 1)
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
