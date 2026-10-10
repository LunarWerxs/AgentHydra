"""Offline: read_file takes several files in one call (tools.py t_read_file, spec in toolspecs.py).

Drives the real Sandbox dispatch, so the same path a worker's tool call takes is what gets checked.
"""
from __future__ import annotations

import asyncio

from hswarm.tools import Sandbox
from hswarm.toolspecs import specs_for


def run(coro):
    return asyncio.run(coro)


def _tree(tmp_path):
    box = tmp_path / "box"
    box.mkdir()
    (box / "a.txt").write_text("alpha\nbeta\n", encoding="utf-8", newline="")
    (box / "b.txt").write_text("gamma\n", encoding="utf-8", newline="")
    (box / "c.txt").write_text("delta\nepsilon\nzeta\n", encoding="utf-8", newline="")
    (tmp_path / "secret.txt").write_text("TOKEN\n", encoding="utf-8", newline="")
    return box


def test_one_call_with_three_paths_returns_each_file_under_its_header(tmp_path):
    sb = Sandbox(_tree(tmp_path))
    out = run(sb.run("read_file", {"paths": ["a.txt", "b.txt", {"path": "c.txt", "start_line": 2, "end_line": 3}]}))
    assert out == "== a.txt ==\n1\talpha\n2\tbeta\n\n== b.txt ==\n1\tgamma\n\n== c.txt ==\n2\tepsilon\n3\tzeta"


def test_the_single_path_form_is_unchanged(tmp_path):
    sb = Sandbox(_tree(tmp_path))
    assert run(sb.run("read_file", {"path": "a.txt"})) == "1\talpha\n2\tbeta"
    assert run(sb.run("read_file", {"path": "c.txt", "start_line": 2, "end_line": 2})) == "2\tepsilon"


def test_an_out_of_sandbox_path_in_the_list_is_refused_like_a_single_one(tmp_path):
    sb = Sandbox(_tree(tmp_path))
    single = run(sb.run("read_file", {"path": "../secret.txt"}))
    batched = run(sb.run("read_file", {"paths": ["a.txt", "../secret.txt"]}))
    assert single.startswith("ERROR: PermissionError")
    assert batched == single  # the whole call is refused with the single call's own error; no file content leaks


def test_the_spec_the_model_sees_advertises_the_multi_file_form():
    (tool,) = specs_for(["read_file"])
    fn = tool["function"]
    assert "paths" in fn["parameters"]["properties"]
    assert fn["parameters"]["properties"]["paths"]["type"] == "array"
    assert "one call" in fn["description"]
    assert "required" not in fn["parameters"]  # path alone or paths alone: the schema requires neither
