"""Offline: the outline and unfold worker tools, through the sandbox's own dispatch. No network.

Each test pins the line ranges a worker is told and the exact lines unfold hands back, so a regression
in the ranges (a brace inside a string closing a block, a Rust lifetime read as a quote, a decorator
dropped) shows up as the wrong source, which is what a worker would act on.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.capability import Capability  # noqa: E402
from hswarm.tools import PRESETS, Sandbox  # noqa: E402

PY = '''import os


class Store:
    """Keeps things."""

    def __init__(self):
        self.items = []

    @property
    def size(self):
        return len(self.items)


async def main():
    return Store()
'''

TS = '''// function commented() {}
export class Parser {
  private depth = 0;

  parse(src: string): Node {
    if (src === "{") {
      return { kind: "brace" };
    }
    const s = `}` + "}";
    return this.walk(src);
  }

  walk(src: string) {
    return null;
  }
}

export const helper = async (x: number) => {
  return x * 2;
};

function top(a: number,
             b: number) {
  for (const k of [a, b]) {
    console.log(k);
  }
}
'''

RS = '''/// A span.
pub struct Span<'a> {
    text: &'a str,
}

impl<'a> Span<'a> {
    pub fn new(text: &'a str) -> Self {
        let open = '{';
        Span { text }
    }
}

impl fmt::Display for Span<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "}}")
    }
}
'''

GO = '''package store

type Server struct {
	addr string
}

func (s *Server) Handle(path string) error {
	if path == "}" {
		return nil
	}
	return nil
}
'''

MD = '''# Title
intro
## Install
run it
```bash
# not a heading
```
## Use
done
'''


def tool(tmp_path: Path, name: str, text: str, call: str, **args) -> list[str]:
    (tmp_path / name).write_text(text, encoding="utf-8")
    return asyncio.run(Sandbox(tmp_path).run(call, {"path": name, **args})).splitlines()


def test_read_preset_offers_outline_and_unfold():
    assert {"outline", "unfold"} <= set(PRESETS["read"])


def test_python_outline_nests_methods_and_unfold_keeps_the_decorator(tmp_path):
    out = tool(tmp_path, "store.py", PY, "outline")
    assert out[0].startswith("store.py: 16 lines")
    assert out[1:] == ["L4-12 class Store:", "  L7-8 def __init__(self):", "  L10-12 def size(self):", "L15-16 async def main():"]
    assert tool(tmp_path, "store.py", PY, "unfold", symbol="Store.size") == [
        "store.py L10-12 Store.size", "10\t    @property", "11\t    def size(self):", "12\t        return len(self.items)"]
    assert tool(tmp_path, "store.py", PY, "unfold", symbol="size")[0] == "store.py L10-12 Store.size"
    missing = tool(tmp_path, "store.py", PY, "unfold", symbol="nope")
    assert missing[0].startswith("ERROR") and "Store.size" in missing[0]


def test_typescript_braces_in_strings_and_control_flow_do_not_move_ranges(tmp_path):
    out = tool(tmp_path, "p.ts", TS, "outline")
    assert out[1:] == [
        "L2-16 export class Parser {",
        "  L5-11 parse(src: string): Node {",
        "  L13-15 walk(src: string) {",
        "L18-20 export const helper = async (x: number) => {",
        "L22-27 function top(a: number,",
    ]
    assert tool(tmp_path, "p.ts", TS, "unfold", symbol="Parser.walk")[1:] == [
        "13\t  walk(src: string) {", "14\t    return null;", "15\t  }"]
    assert tool(tmp_path, "p.ts", TS, "unfold", symbol="top")[-1] == "27\t}"


def test_rust_lifetimes_and_go_receivers(tmp_path):
    assert tool(tmp_path, "s.rs", RS, "outline")[1:] == [
        "L2-4 pub struct Span<'a> {",
        "L6-11 impl<'a> Span<'a> {",
        "  L7-10 pub fn new(text: &'a str) -> Self {",
        "L13-17 impl fmt::Display for Span<'_> {",
        "  L14-16 fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {",
    ]
    span = tool(tmp_path, "s.rs", RS, "unfold", symbol="Span")
    assert span[:2] == ["s.rs L1-4 Span", "1\t/// A span."] and span[-1] == "(also: L6-11 Span; L13-17 Span)"
    assert tool(tmp_path, "s.rs", RS, "unfold", symbol="fmt")[0] == "s.rs L14-16 Span.fmt"
    assert tool(tmp_path, "g.go", GO, "outline")[1:] == ["L3-5 type Server struct {", "L7-12 func (s *Server) Handle(path string) error {"]
    assert tool(tmp_path, "g.go", GO, "unfold", symbol="Server.Handle")[-1] == "12\t}"
    assert tool(tmp_path, "notes.txt", "x\n", "outline")[0].startswith("ERROR: ValueError: no outliner")


def test_a_capability_path_deny_binds_outline_and_unfold_like_read_file(tmp_path):
    # outline/unfold hand back source, so a grant that keeps read_file out of private/** must keep them out too.
    (tmp_path / "private").mkdir()
    (tmp_path / "private" / "keys.py").write_text(PY, encoding="utf-8")
    cap = Capability.from_dict({"identifier": "reader", "permissions": ["read"], "deny": ["private/**"]})
    sb = Sandbox(tmp_path, capability=cap)
    for call, args in (("outline", {}), ("unfold", {"symbol": "main"})):
        out = asyncio.run(sb.run(call, {"path": "private/keys.py", **args}))
        assert out.startswith("ERROR: PermissionError") and "Store" not in out


def test_markdown_headings_skip_fenced_code(tmp_path):
    assert tool(tmp_path, "r.md", MD, "outline")[1:] == ["L1-9 # Title", "  L3-7 ## Install", "  L8-9 ## Use"]
    assert tool(tmp_path, "r.md", MD, "unfold", symbol="install")[0] == "r.md L3-7 Install"
