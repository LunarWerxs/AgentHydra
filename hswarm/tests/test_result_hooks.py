"""Offline: the cc one-file result loop - the three hooks run as the processes Claude Code would spawn,
and the cc backend's wiring and post-run read. No claude process is started."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import cc, result_hooks  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402

SCHEMA = {"type": "object", "properties": {"verdict": {"type": "string", "enum": ["ok", "bad"]}, "count": {"type": "integer"}}, "required": ["verdict", "count"]}


def _spec(tmp_path, schema=SCHEMA) -> Path:
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"result_file": str(tmp_path / "out" / "result.json"), "schema": schema, "log": str(tmp_path / "writes.log")}), encoding="utf-8")
    return spec


def _hook(phase: str, spec: Path, event) -> subprocess.CompletedProcess:
    stdin = event if isinstance(event, str) else json.dumps(event)
    return subprocess.run([sys.executable, result_hooks.__file__, phase, str(spec)], input=stdin, capture_output=True, text=True, timeout=30)


def test_the_write_guard_allows_only_the_result_file_logs_every_try_and_fails_closed(tmp_path):
    # The rule used to be prose in the prompt; a worker that ignored it wrote wherever it liked.
    spec = _spec(tmp_path)
    ok = _hook("pre", spec, {"tool_name": "Write", "cwd": str(tmp_path), "tool_input": {"file_path": "out/result.json"}})
    assert ok.returncode == 0, ok.stderr
    other = _hook("pre", spec, {"tool_name": "Edit", "cwd": str(tmp_path), "tool_input": {"file_path": str(tmp_path / "src.py\nforged allow")}})
    assert other.returncode == 2 and "Denied" in other.stderr and "result.json" in other.stderr
    assert _hook("pre", spec, "not json").returncode == 2  # unreadable input is refused, never waved through
    assert _hook("pre", spec, {"tool_name": "Write", "tool_input": {}}).returncode == 2
    log = (tmp_path / "writes.log").read_text(encoding="utf-8").splitlines()
    assert [line.split()[1] for line in log] == ["allow", "deny", "deny", "deny"]
    assert "<unreadable>" in log[2]  # the refusal of unreadable input is logged too
    assert "forged allow" in log[1] and "?forged" in log[1]  # the newline in the path cannot start a log line of its own


def test_a_write_that_breaks_the_schema_is_told_why_and_a_valid_one_hears_nothing(tmp_path):
    spec = _spec(tmp_path)
    result = tmp_path / "out" / "result.json"
    result.parent.mkdir()
    event = {"tool_name": "Write", "cwd": str(tmp_path), "tool_input": {"file_path": str(result)}}
    result.write_text(json.dumps({"verdict": "maybe"}), encoding="utf-8")
    bad = _hook("post", spec, event)
    ctx = json.loads(bad.stdout)["hookSpecificOutput"]["additionalContext"]
    assert bad.returncode == 0 and "count" in ctx and "maybe" in ctx
    result.write_text(json.dumps({"verdict": "ok", "count": 3}), encoding="utf-8")
    good = _hook("post", spec, event)
    assert good.returncode == 0 and good.stdout == "" and good.stderr == ""


def test_stop_is_blocked_once_while_the_file_is_unpublishable_then_let_through(tmp_path):
    spec = _spec(tmp_path)
    first = _hook("stop", spec, {"stop_hook_active": False})
    assert first.returncode == 2 and "missing" in first.stderr
    assert _hook("stop", spec, {"stop_hook_active": True}).returncode == 0  # no loop
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "result.json").write_text('{"verdict": "bad", "count": 1}', encoding="utf-8")
    assert _hook("stop", spec, {"stop_hook_active": False}).returncode == 0


def test_a_valid_file_left_from_an_earlier_run_is_not_this_runs_answer(tmp_path):
    # Contract: only a file written during this run publishes. Regression: a leftover valid result_file (retry,
    # key-rotation rerun, reused harvest path) let the worker stop without writing and returned the old data as ok.
    result = tmp_path / "out" / "result.json"
    result.parent.mkdir()
    result.write_text('{"verdict": "ok", "count": 7}', encoding="utf-8")
    stamp = result_hooks.file_stamp(result)
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"result_file": str(result), "schema": SCHEMA, "stale_stamp": stamp}), encoding="utf-8")
    stop = _hook("stop", spec, {"stop_hook_active": False})
    assert stop.returncode == 2 and "earlier" in stop.stderr
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "cc", "tools": "read", "schema": SCHEMA, "result_file": "out/result.json"}, {}, 0)
    res = Result(id="t", backend="cc", status="ok")
    cc.read_result_file(res, task, stamp)
    assert res.status == "error" and "earlier" in res.error and res.data is None
    # Rewritten during the run, the same path publishes.
    os.utime(result, ns=(stamp + 10**9, stamp + 10**9))
    res = Result(id="t", backend="cc", status="ok")
    cc.read_result_file(res, task, stamp)
    assert res.status == "ok" and res.data == {"verdict": "ok", "count": 7}
    assert _hook("stop", spec, {"stop_hook_active": False}).returncode == 0


def test_a_cc_result_file_task_is_wired_to_the_hooks_and_published_from_the_file(tmp_path, monkeypatch):
    task = Task.from_dict({"prompt": "review", "cwd": str(tmp_path), "backend": "cc", "tools": "read", "schema": SCHEMA, "result_file": "out/result.json"}, {}, 0)
    hook_dir = cc._hook_dir(task)
    try:
        cmd = cc._command(task, hook_dir / "settings.json")
        denied = cmd[cmd.index("--disallowedTools") + 1].split(",")
        assert "Write" not in denied and "Bash" in denied and "Edit" in denied  # read-only, bar the one guarded file
        assert cmd[cmd.index("--settings") + 1] == str(hook_dir / "settings.json")
        hooks = json.loads((hook_dir / "settings.json").read_text(encoding="utf-8"))["hooks"]
        assert set(hooks) == {"PreToolUse", "PostToolUse", "Stop"}
        assert "result_hooks.py" in hooks["PreToolUse"][0]["hooks"][0]["command"] and "Write" in hooks["PreToolUse"][0]["matcher"]
    finally:
        cc.shutil.rmtree(hook_dir, ignore_errors=True)
    assert "out/result.json" in cc._prompt(task)

    # A reply that LOOKS like the answer does not publish: only the file does.
    res = Result(id="t", backend="cc", status="ok", data={"verdict": "ok", "count": 9})
    cc.read_result_file(res, task)
    assert res.status == "error" and "result file" in res.error and res.data is None
    Path(task.result_file).parent.mkdir()
    Path(task.result_file).write_text('{"verdict": "ok", "count": 2}', encoding="utf-8")
    res = Result(id="t", backend="cc", status="ok")
    cc.read_result_file(res, task)
    assert res.status == "ok" and res.data == {"verdict": "ok", "count": 2}


def test_result_file_is_refused_on_the_api_backend(tmp_path):
    with pytest.raises(ValueError, match="result_file"):
        Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "backend": "api", "tools": "read", "result_file": "r.json"}, {}, 0)
