"""Offline: background shell jobs (bash_start / job_wait / job_tail / job_input / job_kill) and their sanitizer."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, shelljobs  # noqa: E402
from hswarm.shelljobs import Sanitizer  # noqa: E402
from hswarm.tools import PRESETS, Sandbox, find_bash, specs_for  # noqa: E402

needs_bash = pytest.mark.skipif(find_bash() is None, reason="no working bash on this machine")


def run(coro):
    return asyncio.run(coro)


def job_id(started: str) -> str:
    assert started.startswith("job_id="), started
    return started.split()[0].split("=", 1)[1]


def test_sanitizer_strips_escapes_and_keeps_the_last_progress_frame():
    # A spinner or a coloured progress bar would otherwise fill the worker's context with every frame.
    s = Sanitizer()
    out = s.feed(b"\x1b[32mok\x1b[0m\r\n 10%\r 50%\r100%\ndone\x1b]0;title\x07\n")
    assert out == "ok\n100%\ndone\n"
    s.feed(b"half \r 20%\r 70%")
    assert s.pending() == " 70%"  # the unfinished line reads as its latest frame


def test_sanitizer_holds_sequences_split_across_chunks():
    # A read boundary can fall inside an escape, inside a CRLF or inside a UTF-8 character.
    s = Sanitizer()
    assert s.feed(b"red \x1b[3") == ""
    assert s.feed(b"1mtext\r") == ""
    assert s.feed(b"\nna\xc3") == "red text\n"
    assert s.feed(b"\xafve\n") == "naïve\n"
    assert s.feed(b"tail", final=True) == "tail\n"


def test_sanitizer_holds_a_window_title_split_across_chunks():
    # An OSC title cut by a read boundary must not leak its text once "ESC ]" alone looks complete.
    s = Sanitizer()
    assert s.feed(b"a\n\x1b]0;my ti") == "a\n"
    assert s.feed(b"tle\x07b\n") == "b\n"


def test_sanitizer_drops_charset_and_cursor_save_escapes_whole():
    # "ESC ( B" (tput sgr0), "ESC 7" and "ESC =" once went unmatched: held back until 256 chars piled
    # up, which stalled live output, then leaked "(B", "7" or "=" into the text.
    s = Sanitizer()
    assert s.feed(b"a\x1b(B\n") == "a\n"
    assert s.feed(b"\x1b7b\x1b8\x1b=\n") == "b\n"


async def wait_for_text(sb: Sandbox, jid: str, text: str) -> str:
    """job_wait until `text` shows up; a login bash can take seconds to start on a busy machine."""
    seen = ""
    for _ in range(60):
        seen += await sb.run("job_wait", {"job_id": jid, "timeout_s": 2})
        if text in seen:
            return seen
    raise AssertionError(f"{text!r} never arrived: {seen!r}")


@needs_bash
def test_bash_start_returns_at_once_and_wait_reads_only_new_output(tmp_path):
    async def go():
        sb = Sandbox(tmp_path)
        # The command blocks until the test creates `go`, so "returns at once" needs no timing guess.
        jid = job_id(await sb.run("bash_start", {"command": "echo first; while [ ! -f go ]; do sleep 0.2; done; echo second; exit 7"}))
        early = await wait_for_text(sb, jid, "first")
        assert "running" in early and "second" not in early
        (tmp_path / "go").write_text("")
        final = await sb.run("job_wait", {"job_id": jid, "timeout_s": 120})
        assert "exit=7" in final and "second" in final and "first" not in final
        assert "no new output" in await sb.run("job_wait", {"job_id": jid, "timeout_s": 0})
        assert (await sb.run("job_wait", {"job_id": "j99"})).startswith("ERROR")
    run(go())


@needs_bash
def test_job_tail_windows_and_separate_streams(tmp_path):
    async def go():
        sb = Sandbox(tmp_path)
        jid = job_id(await sb.run("bash_start", {"command": "for i in 1 2 3 4 5; do echo out$i; done; echo bad >&2"}))
        await sb.run("job_wait", {"job_id": jid, "timeout_s": 120})
        tail = await sb.run("job_tail", {"job_id": jid, "lines": 2, "stream": "stdout"})
        assert tail.splitlines()[1:] == ["out4", "out5"] and "bad" not in tail
        assert (await sb.run("job_tail", {"job_id": jid, "stream": "stderr"})).splitlines()[1:] == ["bad"]
        window = await sb.run("job_tail", {"job_id": jid, "offset": 5, "stream": "stdout"})
        assert "chars 5-25 of 25" in window and window.splitlines()[1:] == ["out2", "out3", "out4", "out5"]
    run(go())


@needs_bash
def test_job_input_reaches_stdin_only_when_asked_for(tmp_path):
    async def go():
        sb = Sandbox(tmp_path)
        jid = job_id(await sb.run("bash_start", {"command": "read name; echo hello $name", "stdin": True}))
        assert "sent" in await sb.run("job_input", {"job_id": jid, "text": "swarm\n", "close": True})
        assert "hello swarm" in await sb.run("job_wait", {"job_id": jid, "timeout_s": 120})
        closed = job_id(await sb.run("bash_start", {"command": "echo x"}))
        assert "stdin=true" in await sb.run("job_input", {"job_id": closed, "text": "y\n"})
        sb.close()
    run(go())


@needs_bash
def test_jobs_die_with_the_task_and_are_capped(tmp_path, monkeypatch):
    async def go():
        monkeypatch.setattr(shelljobs, "MAX_JOBS", 1)
        sb = Sandbox(tmp_path)
        jid = job_id(await sb.run("bash_start", {"command": "sleep 60"}))
        assert "already running" in await sb.run("bash_start", {"command": "sleep 60"})
        job = sb.jobs.get(jid)
        sb.close()  # what agent.run_api_task does in its finally
        await asyncio.wait_for(job.done.wait(), timeout=60)
        assert "killed" in job.status()
        # A slot freed by the kill is reusable, and a job killed the moment it starts always ends: taskkill's
        # one-instant tree walk missed a shell Git Bash's launcher spawned just after, 1 kill in 3 (2026-09-25).
        for _ in range(5):
            killed = job_id(await sb.run("bash_start", {"command": "sleep 60"}))
            assert "killed" in await sb.run("job_kill", {"job_id": killed})
    run(go())


@needs_bash
def test_live_jobs_leave_the_per_process_gate_to_short_tools(tmp_path, monkeypatch):
    # Jobs once held the per-process semaphore for life: on a 2-slot machine, a worker that started a
    # build and a dev server then blocked forever on its own next bash call. A server-wide cap refuses instead.
    monkeypatch.setattr(config, "MAX_TOOL_PROCS", 2)
    monkeypatch.setattr(config, "MACHINE_MAX_PROCS", 4)  # server_cap() == 2

    async def go():
        sb = Sandbox(tmp_path)
        for _ in range(2):
            job_id(await sb.run("bash_start", {"command": "sleep 60"}))
        assert "still-free" in await asyncio.wait_for(sb.run("bash", {"command": "echo still-free"}), timeout=60)
        assert "across this hswarm server" in await sb.run("bash_start", {"command": "sleep 60"})
        sb.close()
        for job in sb.jobs.jobs.values():
            await asyncio.wait_for(job.done.wait(), timeout=60)
    run(go())


def test_bash_start_refuses_git_writes(tmp_path, monkeypatch):
    # bash_start must not be a way around the shared-checkout git guard the bash tool enforces.
    monkeypatch.delenv("HSWARM_ALLOW_GIT_WRITES", raising=False)
    assert run(Sandbox(tmp_path).run("bash_start", {"command": "git stash"})).startswith("ERROR: refused `git ")


def test_jobs_preset_is_all_plus_the_job_tools_and_each_has_an_implementation():
    names = [s["function"]["name"] for s in specs_for("jobs")]
    assert names[: len(PRESETS["all"])] == PRESETS["all"]
    extra = names[len(PRESETS["all"]):]
    assert extra == ["bash_start", "job_wait", "job_tail", "job_input", "job_kill"]
    assert all(callable(getattr(Sandbox, "t_" + n, None)) for n in extra)
