"""Offline: pluggable tool runtimes (runtimes.py, remote_tools.py). No container, no ssh, no network.

Contract: a task's `runtime` moves every tool into that isolate - the argv, the in-isolate `timeout N` with the
host guard at N + HOST_GRACE_S, content on stdin, POSIX paths - and a non-host task is validated without
touching this host's filesystem. Regressions caught: an ssh/container target read as an option
(`ssh:-oProxyCommand=...` runs a local command), a runtime task silently running on the host, a POSIX
`..` escaping the roots, a `writable` glob anchored on this host's drive instead of the isolate's path.
Seam: Task -> tools.open_sandbox -> RemoteSandbox -> Runtime.run.
"""
from __future__ import annotations

import asyncio
import shlex
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import remote_tools, runtimes  # noqa: E402
from hswarm.procs import run_hidden  # noqa: E402
from hswarm.remote_tools import RemoteSandbox, glob_regex  # noqa: E402
from hswarm.runtimes import HOST_GRACE_S, Runtime, parse_runtime  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox, open_sandbox  # noqa: E402
from hswarm.worker import build_messages  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Recording(Runtime):
    """A runtime that records each script call and answers with a canned (exit, stdout, stderr)."""

    answer = (0, "", "")

    def __init__(self, kind: str, target: str, calls: list):
        super().__init__(kind, target)
        object.__setattr__(self, "calls", calls)

    async def run(self, script, args, cwd, timeout_s, stdin_text=None):
        self.calls.append((script, args, cwd, stdin_text))
        return self.answer


def test_parse_runtime_grammar_and_option_injection():
    assert parse_runtime("") is None and parse_runtime("host") is None and parse_runtime(None) is None
    assert parse_runtime("docker-container:abc123") == Runtime("docker", "abc123")
    assert parse_runtime("podman-container:web_1").spec == "podman-container:web_1"
    assert parse_runtime("ssh:ci@mac-vm.local") == Runtime("ssh", "ci@mac-vm.local")
    for bad in ("ssh:-oProxyCommand=calc", "docker-container:--privileged", "docker:abc", "ssh:", "ssh:a b", "vm:x"):
        with pytest.raises(ValueError):
            parse_runtime(bad)


def test_argv_wraps_timeout_and_cwd_per_transport():
    inner_tail = ["sh", "-c", "echo hi", "sh", "arg one"]
    docker = Runtime("docker", "abc").argv("echo hi", ["arg one"], "/work", 30)
    assert docker[:4] == ["docker", "exec", "-i", "abc"]
    assert docker[4:7] == ["sh", "-c", runtimes._WRAP] and docker[8:10] == ["/work", "30"] and docker[10:] == inner_tail
    ssh = Runtime("ssh", "mac1").argv("echo hi", ["arg one"], "/Users/ci/repo", 30)
    assert ssh[:7] == ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "mac1"]
    # ssh hands the remote shell ONE string: it must split back into exactly the argv a container gets.
    assert len(ssh) == 8 and shlex.split(ssh[7])[4:] == ["/Users/ci/repo", "30", *inner_tail]


def test_run_guards_the_host_side_past_the_isolate_timeout(monkeypatch):
    seen = {}

    async def fake_run_hidden(cmd, cwd, timeout, env=None, stdin_text=None):
        seen.update(cmd=cmd, timeout=timeout, stdin=stdin_text)
        return 0, "", ""

    monkeypatch.setattr(runtimes, "run_hidden", fake_run_hidden)
    monkeypatch.setattr(runtimes.shutil, "which", lambda exe: f"/usr/bin/{exe}")
    run(Runtime("podman", "c1").run("cat > \"$1\"", ["/w/a"], "/w", 40, stdin_text="body"))
    assert seen["timeout"] == 40 + HOST_GRACE_S and seen["stdin"] == "body" and seen["cmd"][0] == "podman"
    monkeypatch.setattr(runtimes.shutil, "which", lambda exe: None)
    with pytest.raises(FileNotFoundError):
        run(Runtime("ssh", "gone").run(":", [], "/", 5))


def test_remote_sandbox_confines_posix_paths_and_sends_content_on_stdin():
    calls: list = []
    rt = Recording("docker", "c", calls)
    sb = RemoteSandbox(rt, "/work", roots=["/data"])
    with pytest.raises(PermissionError):
        sb.resolve("../etc/passwd")
    assert str(sb.resolve("/data/x/../y.txt")) == "/data/y.txt"
    assert run(sb.t_write_file("a/b.txt", "hello")) == "wrote 5 chars to a/b.txt"
    assert calls[-1][1:] == (["/work/a/b.txt"], "/work", "hello")
    assert sb.files_changed == ["a/b.txt"]
    # An over-cap file read whole is refused, as on the host, from the size line alone.
    object.__setattr__(rt, "answer", (0, "999999\n", ""))
    assert "read a slice" in run(sb.run("read_file", {"path": "big.log"}))
    # The shell policy answers before the isolate is reached: a container often mounts the shared checkout.
    assert not run(sb.t_bash("git reset --hard")).startswith("exit=") and len(calls) == 2


def test_remote_writable_is_anchored_in_the_isolate():
    calls: list = []
    sb = RemoteSandbox(Recording("docker", "c", calls), "/work", writable=["src/**"])
    assert "wrote" in run(sb.run("write_file", {"path": "src/pkg/a.py", "content": "x"}))
    refused = run(sb.run("write_file", {"path": "tests/test_a.py", "content": "x"}))
    assert refused.startswith("ERROR") and "read-only" in refused and len(calls) == 1


def test_remote_edit_refuses_text_the_transport_had_to_replace():
    # run_hidden decodes with errors='replace': writing that text back would turn every non-UTF-8 byte into U+FFFD.
    calls: list = []
    rt = Recording("docker", "c", calls)
    object.__setattr__(rt, "answer", (0, "caf� = 1\n", ""))
    sb = RemoteSandbox(rt, "/work")
    answer = run(sb.run("edit_file", {"path": "a.py", "old_string": "1", "new_string": "2"}))
    assert answer.startswith("ERROR") and "UTF-8" in answer
    assert [c[0] for c in calls] == [remote_tools._CAT] and sb.files_changed == []  # _WRITE never ran


def test_remote_grep_keeps_hits_when_one_file_was_unreadable():
    rt = Recording("docker", "c", [])
    object.__setattr__(rt, "answer", (2, "/work/a.py:3:hit\n", "grep: /work/secret: Permission denied\n"))
    assert run(RemoteSandbox(rt, "/work").t_grep("hit")) == "a.py:3:hit"


def test_task_runtime_is_validated_in_the_isolate_not_on_this_host(tmp_path):
    t = Task.from_dict({"prompt": "x", "cwd": "/srv/repo/../repo", "runtime": "docker-container:abc", "tools": "all"}, {}, 0)
    assert t.cwd == "/srv/repo" and t.runtime == "docker-container:abc"
    sb = open_sandbox(t.runtime, t.cwd, roots=t.roots)
    assert isinstance(sb, RemoteSandbox) and sb.runtime == Runtime("docker", "abc")
    assert "docker-container:abc" in build_messages(t)[0]["content"]
    assert type(open_sandbox("host", tmp_path)) is Sandbox
    for bad, why in (
        ({"cwd": "repo"}, "not an absolute POSIX path"),
        ({"cwd": "/r", "backend": "cc"}, "backend cc"),
        ({"cwd": "/r", "files": ["a.md"]}, "files"),
        ({"cwd": "/r", "tools": "propose"}, "propose"),
        ({"cwd": "/r", "inventory": ["a.py"]}, "inventory"),  # its coverage gate reads files on this host
        ({"cwd": "/r", "verify": {"judge": True}}, "verify.judge"),
        ({"cwd": "/r", "runtime": "ssh:-x"}, "cannot start with '-'"),
    ):
        with pytest.raises(ValueError, match=why):
            Task.from_dict({"prompt": "x", "runtime": "docker-container:abc", **bad}, {}, 1)


def test_glob_regex_matches_pathlib_shapes():
    assert glob_regex("*.py").fullmatch("a.py") and not glob_regex("*.py").fullmatch("pkg/a.py")
    assert glob_regex("**/*.py").fullmatch("a.py") and glob_regex("**/*.py").fullmatch("pkg/sub/a.py")
    assert glob_regex("src/[!t]*.?s").fullmatch("src/app.ts") and not glob_regex("src/[!t]*.?s").fullmatch("src/test.ts")


class _LocalIsolate(Runtime):
    """Runs the in-isolate half of a container argv right here: the real scripts, without a container."""

    async def run(self, script, args, cwd, timeout_s, stdin_text=None):
        argv = self.argv(script, args, cwd, timeout_s)[4:]  # drop `docker exec -i <id>`
        return await run_hidden(argv, "/", timeout_s + HOST_GRACE_S, stdin_text=stdin_text)


# Linux/macOS-only coverage: this is the one test that runs the sh scripts (_READ/_LIST/_GLOB/_GREP/_WRAP), and
# on Windows it skips, so a Windows-only gate never exercises them.
@pytest.mark.skipif(sys.platform == "win32" or not shutil.which("sh"), reason="Linux/macOS only: the in-isolate scripts need a POSIX sh and POSIX paths")
def test_remote_tools_scripts_end_to_end(tmp_path):
    # A folder of its own: tmp_path also holds the test's hswarm home, which list_dir would show.
    ws = tmp_path / "ws"
    ws.mkdir()
    sb = RemoteSandbox(_LocalIsolate("docker", "local"), ws.as_posix())
    assert "wrote" in run(sb.run("write_file", {"path": "pkg/a.py", "content": "def f():\n    return 1\n"}))
    run(sb.run("write_file", {"path": "node_modules/x.py", "content": "def f(): pass\n"}))
    assert run(sb.run("read_file", {"path": "pkg/a.py"})).splitlines() == ["1\tdef f():", "2\t    return 1"]
    assert "1 replacement" in run(sb.run("edit_file", {"path": "pkg/a.py", "old_string": "return 1", "new_string": "return 2"}))
    assert (ws / "pkg" / "a.py").read_text() == "def f():\n    return 2\n"
    assert run(sb.run("list_dir", {"path": ".", "depth": 2})).splitlines() == ["pkg/", "  a.py"]
    assert run(sb.run("glob", {"pattern": "**/*.py"})) == "pkg/a.py"
    assert run(sb.run("grep", {"pattern": "return 2"})) == "pkg/a.py:2:    return 2"
    assert "FileNotFoundError" in run(sb.run("read_file", {"path": "nope.txt"}))
    assert run(sb.run("bash", {"command": "pwd"})).splitlines() == ["exit=0", ws.as_posix()]
