"""The grep tool's two engines: ripgrep when present, a pure-Python walk when not.

ripgrep is the fast path (2.5 s vs 51 s of CPU on a 22k-file tree, measured 2026-09-05); the
Python fallback exists so a fresh machine without `rg` still gets correct answers, just slower.
Both return raw `path:line:text` lines; `relative_hits` makes the paths worker-relative.
"""
from __future__ import annotations

import fnmatch
import re
from pathlib import Path
from typing import Callable

from . import walk
from .procs import run_hidden
from .toolspecs import IGNORED_DIRS

# ripgrep and the fallback both print `path:line:text`; Windows paths carry a drive colon, hence the lazy `.+?`.
GREP_LINE_RX = re.compile(r"^(.+?):(\d+):(.*)$")


async def rg_lines(rg: str, cwd: Path, pattern: str, root: Path, glob: str | None, ignore_case: bool) -> list[str] | str:
    # --threads 2: one worker's grep must not fan across every core of a shared box; the process gate bounds how many run at once.
    cmd = [rg, "--line-number", "--no-heading", "--color", "never", "--no-messages", "--threads", "2", "-e", pattern]
    if ignore_case:
        cmd.append("-i")
    if glob:
        cmd += ["-g", glob]
    for d in IGNORED_DIRS:
        cmd += ["-g", f"!{d}"]
    code, out, _err = await run_hidden(cmd + [str(root)], cwd, 60)
    # rg exits 1 for "no matches", which is an answer, not an error.
    return out.splitlines() if code in (0, 1) else f"ERROR: rg exit {code}"


def py_grep(pattern: str, root: Path, glob: str | None, ignore_case: bool, limit: int) -> list[str]:
    """Blocking: call it on a thread. Raises walk.WalkStopped carrying the hits so far when the walk's minute is up."""
    rx = re.compile(pattern, re.I if ignore_case else 0)
    lines: list[str] = []
    try:
        for folder, entry in walk.files(root):
            if glob and not fnmatch.fnmatch(entry.name, glob):
                continue
            p = folder / entry.name
            try:
                for i, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                    if rx.search(line):
                        lines.append(f"{p}:{i}:{line}")
                        if len(lines) >= limit:
                            return lines
            except OSError:
                continue
    except walk.WalkStopped as stop:
        stop.found = lines
        raise
    return lines


def relative_hits(rel: Callable[[Path], str], lines: list[str], root: Path) -> list[str]:
    """Rewrite each hit's path relative to the worker's cwd so answers cite `src/a.py:12`, not `D:\\...`."""
    out = []
    for line in lines:
        m = GREP_LINE_RX.match(line)
        if not m:
            out.append(line)
            continue
        pth = Path(m.group(1))
        out.append(f"{rel((pth if pth.is_absolute() else root / pth).resolve())}:{m.group(2)}:{m.group(3)}")
    return out
