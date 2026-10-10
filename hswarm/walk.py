"""The one folder walk behind list_dir, glob and the rg-less grep: it never goes into IGNORED_DIRS or a folder link,
and it stops at a deadline.

On 2026-10-09 a 60-task run in a 177,674-folder repo sat for twelve hours with one thread at a full core: pathlib's
glob and list_dir walked the tree on the run's only event loop, so no task timeout fired and nothing checkpointed. A
walk on a thread is no cure by itself: a thread cannot be cancelled, so a walk that never ends keeps the process alive
after its job is done. So every walk here ends: rg's own minute (grep.py) is the budget, and a folder link is listed
but not entered. On Windows a junction is not a symlink to os.path.islink, and os.walk and pathlib both go through one;
a junction loop sent each of them 65 folders deep in a test, and a junction that reaches a loop twice doubles the
walk at every turn."""
from __future__ import annotations

import os
import stat
import time
from pathlib import Path

from .toolspecs import IGNORED_DIRS

WALK_S = 60.0  # one walk's wall-clock budget, the same minute grep gives rg


class WalkStopped(Exception):
    """A walk ran out of WALK_S. `found` carries what the walker had gathered, for a caller that keeps it."""

    def __init__(self, found: list | None = None):
        super().__init__(f"... the walk stopped after {WALK_S:g}s before reaching every folder; give a narrower `path`")
        self.found = found


def deadline() -> float:
    return time.monotonic() + WALK_S


def scan(folder: Path, until: float) -> list[os.DirEntry]:
    """One folder's entries (none when it cannot be read); WalkStopped once `until` has passed."""
    if time.monotonic() > until:
        raise WalkStopped
    try:
        with os.scandir(folder) as it:
            return list(it)
    except OSError:
        return []


def enters(entry: os.DirEntry) -> bool:
    """Whether a walk goes into this entry: a real folder outside IGNORED_DIRS, never a symlink or a junction (which
    can loop back or repeat a tree that lives elsewhere; rg does not follow links either)."""
    if entry.name in IGNORED_DIRS:
        return False
    try:
        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
            return False
        # Windows: scandir's own record carries the reparse tag, so this costs no extra call.
        return os.name != "nt" or entry.stat(follow_symlinks=False).st_reparse_tag != stat.IO_REPARSE_TAG_MOUNT_POINT
    except OSError:
        return False


def files(base: Path, reach: int | None = None, until: float | None = None):
    """(folder, file entry) for each file under `base`, folder by folder, down to `reach` levels (1: `base` alone;
    None: all). Raises WalkStopped once `until` (default: WALK_S from the first step) has passed."""
    until = deadline() if until is None else until
    stack = [(base, 1)]
    while stack:
        folder, level = stack.pop()
        deeper = []
        for entry in scan(folder, until):
            if enters(entry):
                if reach is None or level < reach:
                    deeper.append((Path(entry.path), level + 1))
            elif entry.is_file():  # a link to a file counts; a folder link is neither walked nor matched
                yield folder, entry
        stack.extend(reversed(deeper))
