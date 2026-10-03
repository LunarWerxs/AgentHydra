"""The remote read_file pages exactly like the local one (Sandbox._read_page), never the shared head+tail cap."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_runtimes import Recording, run  # noqa: E402

from hswarm.remote_tools import RemoteSandbox  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402


def _sandbox(text: str) -> RemoteSandbox:
    rt = Recording("docker", "c", [])
    object.__setattr__(rt, "answer", (0, f"{len(text)}\n{text}", ""))
    return RemoteSandbox(rt, "/work")


def test_big_unsliced_read_returns_one_page_with_continues_marker():
    text = "x" * 400 + "\n"  # 100 401-char lines = 40,100 chars over the wire
    body = run(_sandbox(text * 100).t_read_file("big.log"))
    assert len(body) <= Sandbox.READ_PAGE_CHARS
    assert body.endswith('... [lines 1-29 of 100 shown; continues: read_file(path="big.log", start_line=30)]')
    assert body.startswith("1\t") and "\n29\t" in body and "30\t" not in body


def test_small_file_comes_back_whole():
    text = "\n".join(f"line {i}" for i in range(1, 201))  # 1,689 chars, under the page
    body = run(_sandbox(text).t_read_file("small.log"))
    assert len(text) < Sandbox.READ_PAGE_CHARS
    assert body == "\n".join(f"{i}\tline {i}" for i in range(1, 201))
    assert "continues" not in body
