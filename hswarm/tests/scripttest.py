"""A small script-test engine: a CLI end-to-end test is one text file, not a page of harness code.

WHY: every CLI regression used to need hand-written Python (build a namespace, capture stdout, assert). A script
file is about fifteen lines a reviewer can read and an agent can write cheaply, fixture files included.

The format follows Go's cmd/go script tests (src/cmd/internal/script) and its txtar archive
(golang.org/x/tools/txtar), both BSD-3-Clause, The Go Authors. Ideas only: this engine is written fresh for hswarm.

A script file is a txtar archive. Its leading comment is the script; every `-- name --` section after it is a
file written into a fresh work directory before the first line runs. Each script line is

    [cond]... [!|?] command arg...

- `!` the command must FAIL (a non-zero exit, a pattern that does not match, a file that is absent);
  `?` it may fail either way. With no prefix it must succeed.
- `[cond]` runs the line only when the condition holds; `[!cond]` negates it. Built in: windows, unix, exec:NAME.
- Words split on spaces; 'single quotes' keep spaces and disable expansion ('' inside is a literal quote).
  $NAME and ${NAME} expand from the script's environment, where $WORK is the work directory. `#` starts a comment.

Built-in commands (a caller adds its own, e.g. the CLI under test):

    stdout [-count=N] PATTERN   the last command's stdout matches the regexp (multiline mode)
    stderr [-count=N] PATTERN   the same for stderr
    grep [-count=N] PATTERN FILE
    cmp A B                     A and B hold the same text; either may be `stdout` or `stderr`
    exists FILE...              every FILE exists
    env KEY=VALUE...            set environment variables for the rest of the script
    cd DIR                      change the working directory
    skip [MESSAGE]              stop here and report the script as skipped
"""
from __future__ import annotations

import difflib
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

_MARKER = re.compile(r"^-- (.+?) --$")
_VAR = re.compile(r"\$(?:\{(\w+)\}|(\w+))")


class ScriptError(AssertionError):
    """A command failed: what `!` expects and `?` tolerates."""


class UsageError(Exception):
    """The script itself is wrong (bad regexp, unknown command, missing argument): never excused by `!` or `?`."""


class Skip(Exception):
    """The script asked to be skipped (`skip`), usually behind a condition."""


@dataclass
class Archive:
    comment: str
    files: list[tuple[str, str]] = field(default_factory=list)


def parse_txtar(text: str) -> Archive:
    """Split a txtar archive into its comment and its files. A marker line is exactly `-- name --`; a file's data
    runs to the next marker. Line endings are normalised so a CRLF checkout reads the same as an LF one."""
    lines = text.replace("\r\n", "\n").split("\n")
    comment: list[str] = []
    files: list[tuple[str, list[str]]] = []
    for line in lines:
        m = _MARKER.match(line)
        if m:
            files.append((m.group(1).strip(), []))
        elif files:
            files[-1][1].append(line)
        else:
            comment.append(line)
    out = Archive("\n".join(comment))
    for name, body in files:
        data = "\n".join(body)
        out.files.append((name, data if not data or data.endswith("\n") else data + "\n"))
    return out


@dataclass
class State:
    """What the lines of one script share: where it runs, its environment, and the last command's output."""
    workdir: Path
    env: dict[str, str]
    stdout: str = ""
    stderr: str = ""

    def path(self, name: str) -> Path:
        return Path(os.getcwd()) / name

    def text(self, name: str) -> str:
        if name == "stdout":
            return self.stdout
        if name == "stderr":
            return self.stderr
        p = self.path(name)
        if not p.is_file():
            raise ScriptError(f"{name}: no such file")
        return p.read_text(encoding="utf-8").replace("\r\n", "\n")


Command = Callable[[State, list[str]], None]


def split_words(line: str, env: dict[str, str]) -> list[str]:
    """Go's script quoting: spaces split words, single quotes keep spaces and stop expansion, `#` begins a comment."""
    words: list[str] = []
    cur: list[str] = []
    have = False
    i = 0
    while i < len(line):
        c = line[i]
        if c == "'":
            j = i + 1
            while True:
                k = line.find("'", j)
                if k < 0:
                    raise UsageError("unterminated quote")
                cur.append(line[j:k])
                if line.startswith("''", k):
                    cur.append("'")
                    j = k + 2
                    continue
                i = k + 1
                break
            have = True
            continue
        if c.isspace():
            if have:
                words.append("".join(cur))
                cur, have = [], False
            i += 1
            continue
        if c == "#" and not have:
            break
        m = _VAR.match(line, i) if c == "$" else None
        if m:
            cur.append(env.get(m.group(1) or m.group(2), ""))
            i = m.end()
        else:
            cur.append(c)
            i += 1
        have = True
    if have:
        words.append("".join(cur))
    return words


def _count(args: list[str]) -> tuple[int | None, list[str]]:
    if args and args[0].startswith("-count="):
        n = args[0].split("=", 1)[1]
        if not n.isdigit():
            # A malformed count is a broken script, reported like the engine's other usage errors.
            raise UsageError(f"-count wants a non-negative integer, got {n!r}")
        return int(n), args[1:]
    return None, args


def _match(what: str, text: str, args: list[str]) -> None:
    n, args = _count(args)
    if len(args) != 1:
        raise UsageError(f"usage: {what} [-count=N] PATTERN")
    try:
        rx = re.compile(args[0], re.MULTILINE)
    except re.error as e:
        raise UsageError(f"bad pattern {args[0]!r}: {e}") from None
    found = len(rx.findall(text))
    if n is None and not found:
        raise ScriptError(f"no match for {args[0]!r} in {what}")
    if n is not None and found != n:
        raise ScriptError(f"{found} matches for {args[0]!r} in {what}, want {n}")


def _stdout(st: State, args: list[str]) -> None:
    _match("stdout", st.stdout, args)


def _stderr(st: State, args: list[str]) -> None:
    _match("stderr", st.stderr, args)


def _grep(st: State, args: list[str]) -> None:
    if len(args) < 2:
        raise UsageError("usage: grep [-count=N] PATTERN FILE")
    _match(args[-1], st.text(args[-1]), args[:-1])


def _cmp(st: State, args: list[str]) -> None:
    if len(args) != 2:
        raise UsageError("usage: cmp A B")
    a, b = st.text(args[0]), st.text(args[1])
    if a != b:
        diff = "".join(difflib.unified_diff(a.splitlines(True), b.splitlines(True), args[0], args[1]))
        raise ScriptError(f"{args[0]} and {args[1]} differ:\n{diff}")


def _exists(st: State, args: list[str]) -> None:
    if not args:
        raise UsageError("usage: exists FILE...")
    missing = [a for a in args if not st.path(a).exists()]
    if missing:
        raise ScriptError(f"missing: {', '.join(missing)}")


def _env(st: State, args: list[str]) -> None:
    for kv in args:
        if "=" not in kv:
            raise UsageError(f"env: {kv!r} is not KEY=VALUE")
        k, v = kv.split("=", 1)
        st.env[k] = v
        os.environ[k] = v


def _cd(st: State, args: list[str]) -> None:
    if len(args) != 1:
        raise UsageError("usage: cd DIR")
    os.chdir(st.path(args[0]))


def _skip(_st: State, args: list[str]) -> None:
    raise Skip(" ".join(args) or "skipped by the script")


BUILTINS: dict[str, Command] = {"stdout": _stdout, "stderr": _stderr, "grep": _grep, "cmp": _cmp,
                                "exists": _exists, "env": _env, "cd": _cd, "skip": _skip}


def _holds(cond: str, extra: dict[str, Callable[[], bool]]) -> bool:
    neg = cond.startswith("!")
    name = cond[1:] if neg else cond
    if name in extra:
        ok = bool(extra[name]())
    elif name == "windows":
        ok = os.name == "nt"
    elif name == "unix":
        ok = os.name != "nt"
    elif name.startswith("exec:"):
        ok = shutil.which(name[5:]) is not None
    else:
        raise UsageError(f"unknown condition [{name}]")
    return ok != neg


def _clip(s: str, n: int = 1500) -> str:
    return s if len(s) <= n else s[:n] + f"... ({len(s) - n} more chars)"


def run(script: Path, workdir: Path, commands: dict[str, Command] | None = None,
        conditions: dict[str, Callable[[], bool]] | None = None) -> None:
    """Run one script file in `workdir`. Raises AssertionError naming the file, the line and the output so far
    when a line fails, UsageError when the script is malformed, Skip when it skips itself. The process cwd
    and environment are restored afterwards, whatever happened."""
    arc = parse_txtar(script.read_text(encoding="utf-8"))
    workdir.mkdir(parents=True, exist_ok=True)
    root = workdir.resolve()
    for name, data in arc.files:
        p = (root / name).resolve()
        if root not in p.parents:
            raise UsageError(f"{script.name}: archive file {name!r} escapes the work directory")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(data, encoding="utf-8", newline="\n")
    cmds = {**BUILTINS, **(commands or {})}
    st = State(workdir=root, env={"WORK": str(root)})
    saved_cwd, saved_env = os.getcwd(), dict(os.environ)
    trace: list[str] = []
    os.chdir(root)
    try:
        for n, raw in enumerate(arc.comment.split("\n"), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            where = f"{script.name}:{n}: {line}"
            skipped = False
            while line.startswith("["):
                end = line.find("]")
                if end < 0:
                    raise UsageError(f"{where}: unterminated condition")
                if not _holds(line[1:end].strip(), conditions or {}):
                    skipped = True
                    break
                line = line[end + 1:].lstrip()
            if skipped:
                continue
            want = "ok"
            if line[:1] in ("!", "?") and line[1:2].isspace():
                want, line = ("fail" if line[0] == "!" else "any"), line[2:].lstrip()
            words = split_words(line, st.env)
            if not words or words[0] not in cmds:
                raise UsageError(f"{where}: unknown command {words[0] if words else ''!r}")
            trace.append(f"> {line}")
            try:
                cmds[words[0]](st, words[1:])
                err = None
            except ScriptError as e:
                err = e
            if want == "ok" and err is not None:
                raise AssertionError(f"{where}\n  FAIL: {err}\n{_report(trace, st)}")
            if want == "fail" and err is None:
                raise AssertionError(f"{where}\n  FAIL: unexpected success\n{_report(trace, st)}")
    finally:
        os.chdir(saved_cwd)
        os.environ.clear()
        os.environ.update(saved_env)


def _report(trace: list[str], st: State) -> str:
    return ("  lines run:\n    " + "\n    ".join(trace)
            + f"\n  last stdout:\n{_clip(st.stdout)}\n  last stderr:\n{_clip(st.stderr)}")
