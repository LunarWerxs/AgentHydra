"""The one gate every child process passes (owner, Michael, 2026-09-15: "make sure we don't end up
spinning up a billion sub processes and murdering my cpu").

Three rules, enforced here so no tool or backend has to remember them:

1. At most `config.MAX_TOOL_PROCS` children per hswarm process (an asyncio semaphore): 200 workers
   can be in flight, but only a handful of ripgrep/bash/claude children exist at once.
2. At most `config.MACHINE_MAX_PROCS` children across EVERY hswarm process on the machine (one MCP
   server runs per Claude session, so several servers can be busy at once). A slot is a file under
   `~/.hswarm/procslots/` named `<pid>-<token>`; a slot whose owning pid is gone is stale and is
   cleaned by whoever looks next, so a crashed server never leaks capacity. Counting the slots is a
   directory listing of at most a few dozen names.
3. Children run at NORMAL priority (owner, 2026-09-15: "I don't need below normal priority"); the
   count is the discipline, not the niceness. Windows children are still created without a console.

A caller that has waited longer than its own timeout for a machine slot proceeds anyway: the gate is a
storm brake, not a deadlock.
"""
from __future__ import annotations

import asyncio
import os
import secrets
import sys
import time

from . import config

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
BELOW_NORMAL_PRIORITY_CLASS = 0x4000
STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

_sem: asyncio.Semaphore | None = None
_sem_size = 0
_sem_loop: asyncio.AbstractEventLoop | None = None


def _semaphore() -> asyncio.Semaphore:
    """One semaphore per event loop and per configured size (tests change both)."""
    global _sem, _sem_size, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_size != config.MAX_TOOL_PROCS or _sem_loop is not loop:
        _sem, _sem_size, _sem_loop = asyncio.Semaphore(config.MAX_TOOL_PROCS), config.MAX_TOOL_PROCS, loop
    return _sem


def pid_alive(pid: int) -> bool:
    """Is a process still running? Never signals it: on Windows os.kill would terminate it."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError):  # OverflowError: a slot name holding a pid past the C int range
        return False


def spawn_kwargs() -> dict:
    """Extra create_subprocess kwargs: a hidden window on Windows; on POSIX a session of the child's own, so
    kill_tree's process-group kill ends the child and what it started, never this process with it (in the one
    group they shared, a timed-out bash call killed the whole server). Priority stays normal."""
    if sys.platform == "win32":
        return {"creationflags": CREATE_NO_WINDOW}
    return {"start_new_session": True}


def live_slots(slots_dir=None) -> int:
    """Slots held by live processes; stale ones (dead owner) are removed on sight."""
    d = slots_dir or config.SLOTS_DIR
    try:
        names = os.listdir(d)
    except OSError:
        return 0
    n = 0
    for name in names:
        try:
            pid = int(name.split("-", 1)[0])
        except ValueError:
            continue
        if pid == os.getpid() or pid_alive(pid):
            n += 1
        else:
            try:
                os.unlink(os.path.join(d, name))
            except OSError:
                pass
    return n


class ProcSlot:
    """`async with ProcSlot(timeout):` around a child process: the per-process and machine-wide caps."""

    def __init__(self, max_wait_s: float = 60.0, per_process: bool = True):
        self.max_wait_s = max(1.0, float(max_wait_s))
        # per_process=False takes the machine slot only. A long-lived child (a background shell job)
        # must not sit on the per-process semaphore: that has no timeout, so a worker holding it
        # for a dev server would block its own next bash call, and every other worker's, forever.
        self.per_process = per_process
        self._path: str | None = None
        self.waited_s = 0.0
        self.forced = False

    async def __aenter__(self) -> "ProcSlot":
        sem = _semaphore() if self.per_process else None
        if sem is not None:
            await sem.acquire()
        try:
            await self._take_machine_slot()
        except BaseException:
            if sem is not None:
                sem.release()
            raise
        return self

    async def __aexit__(self, *exc) -> None:
        if self._path:
            try:
                os.unlink(self._path)
            except OSError:
                pass
            self._path = None
        if self.per_process:
            _semaphore().release()

    async def _take_machine_slot(self) -> None:
        d = str(config.SLOTS_DIR)
        os.makedirs(d, exist_ok=True)
        t0 = time.monotonic()
        while True:
            if live_slots(d) < config.MACHINE_MAX_PROCS:
                path = os.path.join(d, f"{os.getpid()}-{secrets.token_hex(3)}")
                try:
                    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.close(fd)
                    self._path = path
                    self.waited_s = time.monotonic() - t0
                    return
                except FileExistsError:
                    continue
                except OSError:
                    self.forced = True  # the slots dir is unusable: run rather than hang
                    return
            if time.monotonic() - t0 >= self.max_wait_s:
                self.forced = True
                self.waited_s = time.monotonic() - t0
                return
            await asyncio.sleep(0.25)


def status() -> dict:
    """What the gate would tell `doctor`: caps and live counts. Never blocks."""
    return {
        "per_process_cap": config.MAX_TOOL_PROCS,
        "machine_cap": config.MACHINE_MAX_PROCS,
        "machine_live": live_slots(),
        "slots_dir": str(config.SLOTS_DIR),
        "child_priority": "normal",
    }
