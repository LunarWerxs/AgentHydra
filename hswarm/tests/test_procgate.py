"""Offline: the process gate (per-process cap, machine-wide slots, stale-slot cleanup, priority flags)."""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, procgate  # noqa: E402
from hswarm.procs import run_hidden  # noqa: E402


def _isolate(monkeypatch, tmp_path, per_proc=2, machine=3):
    monkeypatch.setattr(config, "SLOTS_DIR", tmp_path / "procslots")
    monkeypatch.setattr(config, "MAX_TOOL_PROCS", per_proc)
    monkeypatch.setattr(config, "MACHINE_MAX_PROCS", machine)


def test_pid_alive_knows_self_and_a_dead_pid():
    assert procgate.pid_alive(os.getpid())
    assert not procgate.pid_alive(2**22 + 12345)  # no such process on any sane box
    assert not procgate.pid_alive(0)


def test_stale_slots_are_cleaned_and_live_ones_counted(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    d = config.SLOTS_DIR
    d.mkdir()
    (d / f"{os.getpid()}-aaaa").write_text("")
    (d / "4194304999-dead").write_text("")  # a pid that does not exist
    (d / "not-a-slot").write_text("")
    assert procgate.live_slots() == 1
    assert not (d / "4194304999-dead").exists() and (d / f"{os.getpid()}-aaaa").exists()


def test_per_process_cap_limits_concurrent_children(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path, per_proc=2, machine=10)
    peak = 0
    running = 0

    async def one():
        nonlocal peak, running
        async with procgate.ProcSlot(5):
            running += 1
            peak = max(peak, running)
            await asyncio.sleep(0.05)
            running -= 1

    async def go():
        await asyncio.wait_for(asyncio.gather(*[one() for _ in range(8)]), 10)

    asyncio.run(go())
    assert peak == 2
    assert procgate.live_slots() == 0  # every slot file released


def test_machine_cap_makes_a_second_process_wait_then_proceed(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path, per_proc=4, machine=2)
    d = config.SLOTS_DIR
    d.mkdir()
    # two slots held by "another live process" (this pid stands in for it)
    (d / f"{os.getpid()}-x1").write_text("")
    (d / f"{os.getpid()}-x2").write_text("")

    async def go():
        async with procgate.ProcSlot(1.0) as s:
            return s.forced, s.waited_s

    forced, waited = asyncio.run(go())
    assert forced and waited >= 0.9  # the gate is a brake, not a deadlock


def test_spawn_kwargs_hide_the_window_and_keep_normal_priority():
    kw = procgate.spawn_kwargs()
    if sys.platform == "win32":
        assert kw["creationflags"] & procgate.CREATE_NO_WINDOW
        assert not kw["creationflags"] & procgate.BELOW_NORMAL_PRIORITY_CLASS  # owner: normal priority, the cap is the discipline
    else:
        assert "preexec_fn" not in kw


def test_run_hidden_goes_through_the_gate(tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path, per_proc=1, machine=5)
    t0 = time.perf_counter()

    async def go():
        cmd = [sys.executable, "-c", "import time; time.sleep(0.3); print('ok')"]
        return await asyncio.gather(run_hidden(cmd, tmp_path, 10), run_hidden(cmd, tmp_path, 10))

    (a, b) = asyncio.run(go())
    assert a[0] == 0 and "ok" in a[1] and b[0] == 0
    assert time.perf_counter() - t0 >= 0.55  # serialized by the per-process cap of 1
    assert procgate.live_slots() == 0
