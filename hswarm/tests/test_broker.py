"""Offline: the out-of-process permission broker in front of the sandbox's bash and write tools.

The broker is a real child process (a tiny Python script written per test), because the point of the
feature is the process boundary and the line protocol across it. No network.
"""
from __future__ import annotations

import asyncio
import json
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import broker as broker_mod  # noqa: E402
from hswarm.broker import BrokerUnavailable  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402

# mode "policy": deny any command mentioning "forbidden" and any write to a path containing "locked";
# mode "wrong-id": answer every request with an id it never sent; mode "silent": read and never answer.
BROKER_SCRIPT = textwrap.dedent('''
    import json, sys
    mode, log = sys.argv[1], sys.argv[2]
    for line in sys.stdin:
        req = json.loads(line)
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps(req) + "\\n")
        if mode == "silent":
            continue
        if mode == "wrong-id":
            reply = {"id": req["id"] + 100, "result": "allow"}
        elif "forbidden" in req["value"] or "locked" in req["value"]:
            reply = {"id": req["id"], "result": "deny", "reason": "policy says no"}
        else:
            reply = {"id": req["id"], "result": "allow"}
        sys.stdout.write(json.dumps(reply) + "\\n")
        sys.stdout.flush()
''')


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def use_broker(tmp_path, monkeypatch):
    """Point HSWARM_PERMISSION_BROKER at the fake broker in the given mode; returns the request log path."""
    script = tmp_path / "broker.py"
    script.write_text(BROKER_SCRIPT, encoding="utf-8")
    log = tmp_path / "requests.jsonl"

    def configure(mode: str) -> Path:
        monkeypatch.setenv(broker_mod.BROKER_ENV, f'"{sys.executable}" "{script}" {mode} "{log}"')
        return log

    yield configure
    broker_mod.close_broker()


def test_broker_denies_and_allows_bash_and_writes(tmp_path, use_broker):
    log = use_broker("policy")
    work = tmp_path / "work"
    work.mkdir()
    sb = Sandbox(work)
    denied = run(sb.run("bash", {"command": "echo forbidden > ran.txt"}))
    assert denied.startswith("ERROR: the permission broker denied run") and "policy says no" in denied
    assert not (work / "ran.txt").exists()  # refused before the shell ever started
    assert "policy says no" in run(sb.run("write_file", {"path": "locked.txt", "content": "x"}))
    assert not (work / "locked.txt").exists()
    (work / "locked-too.txt").write_text("a")
    assert "policy says no" in run(sb.run("edit_file", {"path": "locked-too.txt", "old_string": "a", "new_string": "b"}))
    assert (work / "locked-too.txt").read_text() == "a"
    assert run(sb.run("write_file", {"path": "ok.txt", "content": "fine"})).startswith("wrote")
    assert run(sb.run("bash", {"command": "echo allowed"})).startswith("exit=0")
    requests = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert [(r["permission"], r["v"]) for r in requests] == [("run", 1), ("write", 1), ("write", 1), ("write", 1), ("run", 1)]
    assert [r["id"] for r in requests] == [1, 2, 3, 4, 5]  # one broker process served every check
    assert requests[1]["value"] == str((work / "locked.txt").resolve()) and requests[0]["cwd"] == str(work.resolve())
    assert all(isinstance(r["pid"], int) and r["datetime"] for r in requests)


def test_broker_fails_closed_on_a_mismatched_id(tmp_path, use_broker):
    use_broker("wrong-id")
    sb = Sandbox(tmp_path)
    # Not an ERROR string the model could route around: the exception escapes run() and aborts the worker.
    with pytest.raises(BrokerUnavailable, match="answered id"):
        run(sb.run("write_file", {"path": "x.txt", "content": "x"}))
    assert not (tmp_path / "x.txt").exists()


def test_broker_fails_closed_when_it_never_answers(tmp_path, use_broker, monkeypatch):
    use_broker("silent")
    monkeypatch.setenv(broker_mod.TIMEOUT_ENV, "1")
    sb = Sandbox(tmp_path)
    with pytest.raises(BrokerUnavailable, match="no answer"):
        run(sb.run("bash", {"command": "echo hi > out.txt"}))
    assert not (tmp_path / "out.txt").exists()


def test_broker_fails_closed_when_it_cannot_start(tmp_path, monkeypatch):
    monkeypatch.setenv(broker_mod.BROKER_ENV, str(tmp_path / "no-such-broker-binary"))
    sb = Sandbox(tmp_path)
    try:
        with pytest.raises(BrokerUnavailable, match="could not start"):
            run(sb.run("bash", {"command": "echo hi > out.txt"}))
    finally:
        broker_mod.close_broker()
    assert not (tmp_path / "out.txt").exists()
