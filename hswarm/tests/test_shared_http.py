"""The ONE-PER-MACHINE MCP server (hswarm/shared.py): `hswarm.py mcp --http` serves every chat from one process,
so nothing a tool does may lean on the server's own environment or working folder - both belong to whoever
started the server, not to the chat calling it. Offline except the end-to-end test, which starts a real
server on a free loopback port and talks to it with the mcp SDK's streamable-http client."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import caller, config, shared  # noqa: E402
from hswarm.spec import Task  # noqa: E402

REPO = Path(__file__).resolve().parent.parent


def _server_env(monkeypatch):
    """The environment of the chat that happened to start the shared server - never the caller's."""
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "starter0-0000-4000-8000-000000000000")
    monkeypatch.setenv("CLAUDE_CODE_HOST_SESSION_ID", "local_chat_starter")
    monkeypatch.setenv("CLAUDE_CODE_EXECPATH", "C:\\Users\\x\\.claude-instances\\starter\\claude-code\\2.1.270\\claude.exe")


@pytest.fixture
def shared_mode(monkeypatch):
    monkeypatch.setattr(shared, "ACTIVE", True)
    yield


def test_stdio_stamp_still_reads_the_environment(monkeypatch):
    _server_env(monkeypatch)
    c = caller.detect("x")
    assert c["session_id"].startswith("starter0") and c["cwd"] == os.getcwd()


def test_shared_stamp_comes_from_the_request_not_the_server_env(monkeypatch, shared_mode, tmp_path):
    _server_env(monkeypatch)
    token = shared.REQUEST.set({"session": "callr123-0000", "chat": "local_chat_caller", "instance": "temp9",
                                "cwd": str(tmp_path), "mcp_session": "abc"})
    try:
        c = caller.detect("lbl")
    finally:
        shared.REQUEST.reset(token)
    assert c["session_id"] == "callr123-0000" and c["chat_id"] == "local_chat_caller" and c["instance"] == "temp9"
    assert c["cwd"] == str(tmp_path) and c["entrypoint"] == "mcp-http" and c["label"] == "lbl"
    assert "starter" not in repr(c)


def test_shared_stamp_without_headers_invents_nothing(monkeypatch, shared_mode):
    _server_env(monkeypatch)
    c = caller.detect()
    assert c["session_id"] == "" and c["chat_id"] == "" and c["instance"] == "" and c["cwd"] == ""
    assert c["parent_pid"] == 0 and "starter" not in repr(c)


def test_connect_prints_the_chats_own_headers(monkeypatch, capsys):
    """The headersHelper: the chat's folder and stamp, percent-encoded, and the server decodes them back."""
    _server_env(monkeypatch)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "D:\\Proj ects\\é")
    monkeypatch.setattr(shared, "ensure", lambda port, wait_s=0: {"ok": True, "state": "running"})
    assert shared.connect(7793) == 0
    headers = json.loads(capsys.readouterr().out)
    assert headers["x-hswarm-instance"] == "starter" and headers["x-hswarm-chat"] == "local_chat_starter"
    seen = {}

    class Ctx:
        request = type("R", (), {"headers": headers})()

    async def call_next(_ctx):
        seen.update(shared.REQUEST.get())

    asyncio.run(shared._request_headers(Ctx(), call_next))
    assert seen["cwd"] == "D:\\Proj ects\\é" and seen["session"].startswith("starter0")


def test_connect_fails_the_connection_with_the_reason(monkeypatch, capsys):
    monkeypatch.setattr(shared, "ensure", lambda port, wait_s=0: {"ok": False, "error": "port 7793 answers but it is not hswarm"})
    assert shared.connect(7793) == 1
    assert "not hswarm" in capsys.readouterr().err


def test_shared_task_without_cwd_is_refused_by_name(shared_mode):
    with pytest.raises(ValueError, match="cwd"):
        Task.from_dict({"prompt": "hi", "tools": "read"}, {}, 0)
    with pytest.raises(ValueError, match="cwd"):  # files resolve under cwd, so a tool-free task with files needs one too
        Task.from_dict({"prompt": "hi", "tools": "none", "files": ["a.txt"]}, {}, 0)


def test_shared_tool_free_task_needs_no_cwd_and_never_gets_the_servers(shared_mode, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    t = Task.from_dict({"prompt": "hi", "tools": "none"}, {}, 0)
    assert t.cwd != str(tmp_path.resolve())


def test_shared_task_takes_the_callers_cwd_header(shared_mode, tmp_path):
    token = shared.REQUEST.set({"cwd": str(tmp_path)})
    try:
        t = Task.from_dict({"prompt": "hi", "tools": "none"}, {}, 0)
    finally:
        shared.REQUEST.reset(token)
    assert t.cwd == str(tmp_path.resolve())


def test_shared_relative_cwd_joins_the_callers_folder_never_the_servers(shared_mode, monkeypatch, tmp_path):
    server_dir, chat_dir = tmp_path / "server", tmp_path / "chat"
    (chat_dir / "sub").mkdir(parents=True)
    server_dir.mkdir()
    monkeypatch.chdir(server_dir)
    token = shared.REQUEST.set({"cwd": str(chat_dir)})
    try:
        assert Task.from_dict({"prompt": "hi", "tools": "read", "cwd": "."}, {}, 0).cwd == str(chat_dir.resolve())
        assert Task.from_dict({"prompt": "hi", "tools": "read", "cwd": "sub"}, {}, 0).cwd == str((chat_dir / "sub").resolve())
    finally:
        shared.REQUEST.reset(token)
    with pytest.raises(ValueError, match="relative"):  # no header: the only folder left to resolve against is the server's
        Task.from_dict({"prompt": "hi", "tools": "read", "cwd": "."}, {}, 0)


def test_stdio_task_without_cwd_still_uses_the_process_cwd():
    t = Task.from_dict({"prompt": "hi", "tools": "none"}, {}, 0)
    assert t.cwd == str(Path(os.getcwd()).resolve())


def test_ensure_returns_at_once_when_the_server_answers(monkeypatch):
    monkeypatch.setattr(shared, "probe", lambda port, timeout=0.5: {"hswarm": True, "pid": 4242})
    monkeypatch.setattr(shared, "_spawn", lambda port: pytest.fail("must not start a second server"))
    out = shared.ensure(7793)
    assert out["ok"] and out["state"] == "running" and out["pid"] == 4242


def test_ensure_refuses_a_port_someone_else_holds(monkeypatch):
    monkeypatch.setattr(shared, "probe", lambda port, timeout=0.5: {"hswarm": False})
    monkeypatch.setattr(shared, "_spawn", lambda port: pytest.fail("must not start on a foreign port"))
    out = shared.ensure(7793)
    assert not out["ok"] and "not hswarm" in out["error"]


def test_ensure_starts_once_and_a_held_lock_blocks_a_second_start(monkeypatch):
    state = {"up": False, "spawned": 0}
    monkeypatch.setattr(shared, "probe", lambda port, timeout=0.5: {"hswarm": True, "pid": 7} if state["up"] else None)

    def spawn(port):
        state["spawned"] += 1
        state["up"] = True
        return 7

    monkeypatch.setattr(shared, "_spawn", spawn)
    lock = shared.lock_path(7793)
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("other caller")  # a fresh lock: another caller is starting it right now
    state_before = shared.ensure(7793, wait_s=0.3)
    assert state["spawned"] == 0 and not state_before["ok"] and "starting" in state_before["error"]
    lock.unlink()
    out = shared.ensure(7793, wait_s=5)
    assert out["ok"] and out["state"] == "started" and state["spawned"] == 1 and not lock.exists()


def test_a_stale_lock_is_taken_over(monkeypatch):
    state = {"up": False}
    monkeypatch.setattr(shared, "probe", lambda port, timeout=0.5: {"hswarm": True, "pid": 9} if state["up"] else None)
    monkeypatch.setattr(shared, "_spawn", lambda port: state.update(up=True) or 9)
    lock = shared.lock_path(7793)
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("crashed caller")
    old = time.time() - shared.LOCK_STALE_S - 5
    os.utime(lock, (old, old))
    assert shared.ensure(7793, wait_s=5)["state"] == "started"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_one_http_server_serves_two_clients_at_once(tmp_path):
    """End to end: a real `hswarm.py mcp --http` process, two streamable-http clients at the same time."""
    from mcp import ClientSession
    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

    port = _free_port()
    env = dict(os.environ, HSWARM_HOME=str(tmp_path / "home"), PYTHONPATH=str(REPO.parent))
    proc = subprocess.Popen([sys.executable, "-m", "hswarm", "mcp", "--http", "--port", str(port)],
                            cwd=str(tmp_path), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 30
        while time.time() < deadline and not shared.probe(port):
            time.sleep(0.2)
        health = shared.probe(port)
        assert health and health["hswarm"] and health["pid"] == proc.pid

        async def one_client(cwd: str):
            # Each chat's own folder rides on its own requests; a folder that does not exist makes hswarm_run refuse
            # the task by that folder's name before any worker starts, which proves the header reached the tool.
            http = create_mcp_http_client(headers={"X-Hswarm-Cwd": cwd})
            async with http, streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http) as (read, write, *_):
                async with ClientSession(read, write) as s:
                    init = await s.initialize()
                    assert "ABSOLUTE cwd" in (init.instructions or "")  # the shared server asks for the folder it cannot see
                    names = {t.name for t in (await s.list_tools()).tools}
                    jobs = await s.call_tool("hswarm_jobs", {"limit": 3})
                    run = await s.call_tool("hswarm_run", {"tasks": ["hi"], "wait": False})
                    return names, jobs.is_error, run.structured_content or json.loads(run.content[0].text)

        async def both():
            return await asyncio.gather(one_client(str(tmp_path / "chat-a")), one_client(str(tmp_path / "chat-b")))

        for (names, is_error, run), chat in zip(asyncio.run(both()), ("chat-a", "chat-b")):
            assert {"hswarm_run", "hswarm_jobs", "hswarm_doctor"} <= names and not is_error
            assert chat in run.get("error", "") and "not a directory" in run["error"]
    finally:
        proc.terminate()
        proc.wait(10)


def test_the_server_binds_loopback_only():
    assert shared.HOST == "127.0.0.1"
    assert config.HOME  # the lock and log live under the hswarm home


def test_only_the_shared_server_tells_chats_to_pass_an_absolute_cwd():
    from hswarm.mcp_server import mcp
    assert "ABSOLUTE cwd" not in (mcp._lowlevel_server.instructions or "")  # stdio chats default to their own folder
    assert "ABSOLUTE cwd" in shared.SHARED_NOTE  # the HTTP half is asserted end to end in the two-client test


@pytest.mark.skipif(os.name != "nt", reason="the proactor event loop is Windows-only")
def test_a_client_dropped_mid_accept_does_not_close_the_listener(monkeypatch):
    # CPython's proactor serving loop closes the LISTENING socket on any accept error; one client that vanished
    # mid-accept (WinError 64) left the shared server alive, running jobs, and deaf (2026-09-27).
    from asyncio import windows_events

    real, calls = windows_events.IocpProactor.accept, []

    def first_client_vanishes(self, listener):
        calls.append(1)
        if len(calls) == 1:
            f = self._loop.create_future()
            f.set_exception(OSError(22, "The specified network name is no longer available", None, 64))
            return f
        return real(self, listener)

    monkeypatch.setattr(windows_events.IocpProactor, "accept", first_client_vanishes)
    shared.keep_listening_through_dropped_clients()

    async def go():
        served = asyncio.Event()

        async def on_client(reader, writer):
            served.set()
            writer.close()

        server = await asyncio.start_server(on_client, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        _, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 5)
        await asyncio.wait_for(served.wait(), 5)
        w.close()
        server.close()

    asyncio.run(go())
    assert len(calls) >= 2  # the vanished client's accept was retried, and the next client was served


def test_a_process_whose_sources_changed_on_disk_says_it_runs_the_older_code(monkeypatch):
    """Job 20260925-210332-1928 lost four read-only tasks to a bug 80de4e9 had fixed 2.5 hours before: the shared server
    still ran the code it started with, nothing said so, and the failure was filed as open against fixed code."""
    monkeypatch.setattr(shared, "LOADED", shared._sources())
    assert shared.behind() is None  # the code on disk is the code loaded
    older = dict(shared.LOADED, **{"dispatch.py": shared.LOADED["dispatch.py"] - 1})  # dispatch.py rewritten since
    older.pop("agent.py")  # agent.py new since
    monkeypatch.setattr(shared, "LOADED", older)
    note = shared.behind()
    assert note and "2 source file(s) changed" in note and "agent.py" in note and "dispatch.py" in note, note
