"""Offline: capability files (hswarm/capability.py) - the grant a task names is the grant its sandbox enforces."""
from __future__ import annotations

import asyncio
import json

import pytest

from hswarm import capability
from hswarm.capability import Capability
from hswarm.spec import Task
from hswarm.tools import Sandbox

DOCS_WRITER = {
    "identifier": "docs-writer",
    "permissions": ["read", {"identifier": "write_file", "allow": ["docs/**"]}],
    "deny": [".secrets/**", "**/.env", "private/**"],
}


def run(coro):
    return asyncio.run(coro)


def _tree(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "src").mkdir()
    (tmp_path / ".secrets").mkdir()
    (tmp_path / "src" / "a.py").write_text("TOKEN = 1\n")
    (tmp_path / ".secrets" / "keys").write_text("TOKEN = sk-x\n")
    (tmp_path / ".env").write_text("TOKEN=abc\n")
    # Not hidden, so rg searches it by default: only the grant's filter can keep its line out of grep.
    (tmp_path / "private").mkdir()
    (tmp_path / "private" / "notes.txt").write_text("TOKEN = hush\n")
    return Sandbox(tmp_path, capability=Capability.from_dict(DOCS_WRITER))


def test_a_scoped_write_lands_inside_its_glob_and_is_refused_outside(tmp_path):
    sb = _tree(tmp_path)
    assert run(sb.run("write_file", {"path": "docs/guide.md", "content": "x"})).startswith("wrote")
    out = run(sb.run("write_file", {"path": "src/a.py", "content": "pwned"}))
    assert out.startswith("ERROR: PermissionError") and "docs-writer" in out
    assert (tmp_path / "src" / "a.py").read_text() == "TOKEN = 1\n"


def test_deny_beats_allow_on_every_path_tool(tmp_path):
    sb = _tree(tmp_path)
    assert run(sb.run("read_file", {"path": "src/a.py"})).startswith("1\t")
    assert run(sb.run("read_file", {"path": ".env"})).startswith("ERROR: PermissionError")
    assert "keys" not in run(sb.run("list_dir", {"path": ".", "depth": 2}))
    assert run(sb.run("list_dir", {"path": ".secrets"})).startswith("ERROR: PermissionError")
    grep = run(sb.run("grep", {"pattern": "TOKEN"}))
    assert "src/a.py:1:" in grep and "sk-x" not in grep and "abc" not in grep and "hush" not in grep
    assert ".env" not in run(sb.run("glob", {"pattern": "**/*", "path": "."}))


def test_a_tool_the_grant_leaves_out_is_refused_even_when_the_model_calls_it(tmp_path):
    sb = Sandbox(tmp_path, capability=capability.from_tools("read"))
    out = run(sb.run("write_file", {"path": "x.txt", "content": "x"}))
    assert out.startswith("ERROR: tool write_file is not granted") and not (tmp_path / "x.txt").exists()


def test_deny_tool_removes_a_preset_grant_and_bash_cannot_ride_a_path_scope():
    assert "bash" not in Capability.from_dict({"permissions": ["all", "deny-bash"]}).tools
    assert Capability.from_dict({"permissions": ["none"]}).tools == ()  # the empty preset grants nothing, not a tool "none"
    with pytest.raises(ValueError, match="bash"):
        Capability.from_dict({"permissions": ["all"], "deny": [".secrets/**"]})
    with pytest.raises(ValueError, match="unknown permission"):
        Capability.from_dict({"permissions": ["teleport"]})


def test_generated_allow_and_deny_identifiers_cover_every_tool():
    from hswarm.toolspecs import SPECS

    known = capability.known_permissions()
    assert all(f"allow-{t}" in known and f"deny-{t}" in known for t in SPECS)


def test_the_documented_example_is_a_valid_grant():
    from pathlib import Path

    example = Path(__file__).resolve().parent.parent / "docs" / "capability.example.json"
    cap = capability.resolve(str(example), str(example.parent))
    assert "bash" not in cap.tools and cap.scopes["write_file"].allow == ("docs/**",)


def test_a_worker_cannot_rewrite_a_capability_file(tmp_path):
    (tmp_path / "work").mkdir()
    (tmp_path / "extra").mkdir()
    sb = Sandbox(tmp_path / "work", roots=[tmp_path / "extra"], capability=capability.from_tools("edit"))
    out = run(sb.run("write_file", {"path": ".hswarm/capabilities/docs-writer.json", "content": "{}"}))
    assert out.startswith("ERROR: PermissionError")
    # An extra root holds grants too: its capabilities folder is refused, not only the cwd's.
    other = (tmp_path / "extra" / ".hswarm" / "capabilities" / "docs-writer.json").as_posix()
    assert run(sb.run("write_file", {"path": other, "content": "{}"})).startswith("ERROR: PermissionError")


def test_a_task_names_a_workspace_capability_file_and_records_the_grant(tmp_path):
    folder = tmp_path / ".hswarm" / "capabilities"
    folder.mkdir(parents=True)
    (folder / "docs-writer.json").write_text(json.dumps(DOCS_WRITER))
    t = Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "tools": "all", "capability": "docs-writer"})
    assert t.tools == "read_file,list_dir,glob,grep,outline,unfold,write_file"  # the grant replaced the preset
    assert t.capability["identifier"] == "docs-writer"
    again = Capability.from_dict(t.capability)  # job.json round-trips to the same grant
    assert again.as_dict() == t.capability and again.scopes["write_file"].allow == ("docs/**",)
    with pytest.raises(ValueError, match="not found"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "capability": "nobody"})
    with pytest.raises(ValueError, match="cc backend"):
        Task.from_dict({"prompt": "p", "cwd": str(tmp_path), "backend": "cc", "capability": "docs-writer"})
