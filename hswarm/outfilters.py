"""Declarative output filters for a worker's shell commands.

Why it exists: shell output is the largest share of what a worker reads (53% of all tool-result tokens
in the owner's own sessions), and `tools._cap` keeps a blind head and tail of it, so a long install log
or a wall of passing tests pushes the one failing line out of the window the worker sees. A filter
matched on the COMMAND strips the known noise before the cap runs and leaves the failures in.

The idea (a TOML table of per-command filters that carry their own tests) is rtk-ai/rtk's
(Apache-2.0); this module is written fresh for hswarm, no code copied.

A filter is one TOML table under [filters.<name>]:

    match_command         regex searched in the bash command (required)
    description           one line, shown by `hswarm filters`
    strip_ansi            drop colour codes and collapse carriage-return progress redraws (default true)
    replace               [{pattern, replacement}] regex substitutions over the whole text
    match_output          [{pattern, message, unless}] the first pattern found (and `unless` not found)
                          replaces the whole output with message: the short-circuit for "all fine"
    strip_lines_matching  drop every line matching any of these
    keep_lines_matching   keep only lines matching any of these (not both with strip_lines_matching)
    truncate_lines_at     cut each line to N chars
    head_lines/tail_lines keep the first H and last T lines, with a count of what was cut between
    max_lines             hard cap on the lines left
    on_empty              the message when nothing is left

Every filter carries inline tests, [[tests.<name>]] with name, input and expected. A filter with no
tests, a bad regex, or a test it fails is REJECTED at load and never applied; `hswarm filters` lists
the rejects. Lookup, first match wins: <cwd>/.hswarm/filters.toml (project), then
~/.hswarm/filters.toml (user), then the built-in outfilters.toml beside this file; a project or user
filter with a built-in's name replaces it. A result that is not shorter than the raw output is thrown
away, so a filter can never make a worker's output worse.

    hswarm filters [--cwd DIR]                 # every filter in effect there, its source and its tests
    hswarm filters --apply "pytest -q" < log   # run the matching filter over stdin, for authoring one
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from . import config

BUILTIN = Path(__file__).with_name("outfilters.toml")
PROJECT_REL = Path(".hswarm") / "filters.toml"
# A worker that needs the unfiltered output prefixes its command with this. The sandbox strips it before bash runs:
# left in, bash reads it as an env assignment, which is a syntax error in front of `for`, `if` or `(`.
RAW_MARKER = "HSWARM_RAW=1"

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
_KNOWN_KEYS = {
    "match_command", "description", "strip_ansi", "replace", "match_output", "strip_lines_matching",
    "keep_lines_matching", "truncate_lines_at", "head_lines", "tail_lines", "max_lines", "on_empty",
}


@dataclass
class OutputFilter:
    name: str
    source: str
    match_command: re.Pattern
    strip_ansi: bool = True
    replace: list[tuple[re.Pattern, str]] = field(default_factory=list)
    match_output: list[tuple[re.Pattern, str, re.Pattern | None]] = field(default_factory=list)
    strip_lines: list[re.Pattern] = field(default_factory=list)
    keep_lines: list[re.Pattern] = field(default_factory=list)
    truncate_lines_at: int = 0
    head_lines: int = 0
    tail_lines: int = 0
    max_lines: int = 0
    on_empty: str = ""
    description: str = ""
    tests: int = 0

    def apply(self, text: str) -> str:
        """The filtered text. Pure: no note, no never-worse check (filter_output adds both)."""
        if self.strip_ansi:
            text = _ANSI_RE.sub("", text)
            # A progress bar redraws its line with \r; only the last redraw is what a terminal would show.
            text = "\n".join(line.rstrip("\r").rsplit("\r", 1)[-1] for line in text.split("\n"))
        for pattern, replacement in self.replace:
            text = pattern.sub(replacement, text)
        for pattern, message, unless in self.match_output:
            if pattern.search(text) and not (unless and unless.search(text)):
                return message
        lines = text.split("\n")
        if self.strip_lines:
            lines = [ln for ln in lines if not any(p.search(ln) for p in self.strip_lines)]
        if self.keep_lines:
            lines = [ln for ln in lines if any(p.search(ln) for p in self.keep_lines)]
        if self.truncate_lines_at:
            lines = [ln if len(ln) <= self.truncate_lines_at else ln[: self.truncate_lines_at] + "..." for ln in lines]
        if (self.head_lines or self.tail_lines) and len(lines) > self.head_lines + self.tail_lines:
            cut = len(lines) - self.head_lines - self.tail_lines
            lines = lines[: self.head_lines] + [f"... {cut} lines omitted ..."] + (lines[-self.tail_lines:] if self.tail_lines else [])
        if self.max_lines and len(lines) > self.max_lines:
            lines = lines[: self.max_lines] + [f"... {len(lines) - self.max_lines} more lines"]
        out = "\n".join(lines).strip("\n")
        return out if out.strip() else self.on_empty


def _regex(value, where: str) -> re.Pattern:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{where} must be a non-empty regex string")
    try:
        return re.compile(value)
    except re.error as e:
        raise ValueError(f"{where}: bad regex {value!r}: {e}") from None


def _count(spec: dict, key: str) -> int:
    value = spec.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def build_filter(name: str, spec: dict, tests: list, source: str) -> OutputFilter:
    """One validated filter that passes its own inline tests, or ValueError saying why it is rejected."""
    if not isinstance(spec, dict):
        raise ValueError("must be a table")
    unknown = set(spec) - _KNOWN_KEYS
    if unknown:
        raise ValueError(f"unknown key(s) {sorted(unknown)}")
    if spec.get("strip_lines_matching") and spec.get("keep_lines_matching"):
        raise ValueError("strip_lines_matching and keep_lines_matching are exclusive; use one")
    f = OutputFilter(
        name=name, source=source, match_command=_regex(spec.get("match_command"), "match_command"),
        strip_ansi=bool(spec.get("strip_ansi", True)),
        replace=[(_regex(r.get("pattern"), "replace.pattern"), str(r.get("replacement", ""))) for r in spec.get("replace", [])],
        match_output=[(_regex(m.get("pattern"), "match_output.pattern"), str(m.get("message", "")),
                       _regex(m["unless"], "match_output.unless") if m.get("unless") else None) for m in spec.get("match_output", [])],
        strip_lines=[_regex(p, "strip_lines_matching") for p in spec.get("strip_lines_matching", [])],
        keep_lines=[_regex(p, "keep_lines_matching") for p in spec.get("keep_lines_matching", [])],
        truncate_lines_at=_count(spec, "truncate_lines_at"), head_lines=_count(spec, "head_lines"),
        tail_lines=_count(spec, "tail_lines"), max_lines=_count(spec, "max_lines"),
        on_empty=str(spec.get("on_empty", "")), description=str(spec.get("description", "")),
    )
    # The rule rtk enforces at build time, enforced here at load: a filter nobody tested never touches a worker's output.
    if not tests:
        raise ValueError("has no inline tests ([[tests.<name>]] with input and expected)")
    for i, case in enumerate(tests, 1):
        label = case.get("name") or f"test {i}"
        if not isinstance(case.get("input"), str) or not isinstance(case.get("expected"), str):
            raise ValueError(f"{label}: needs string input and expected")
        got = f.apply(case["input"]).strip("\n")
        if got != case["expected"].strip("\n"):
            raise ValueError(f"fails its test {label!r}: expected {case['expected'].strip()!r}, got {got!r}")
    f.tests = len(tests)
    return f


_cache: dict[Path, tuple[int, list[OutputFilter], list[tuple[str, str, str]]]] = {}


def load_file(path: Path, source: str) -> tuple[list[OutputFilter], list[tuple[str, str, str]]]:
    """(filters, rejects) from one TOML file, cached on its mtime. A missing file is empty; rejects are (source, name, why)."""
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return [], []
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    filters: list[OutputFilter] = []
    rejects: list[tuple[str, str, str]] = []
    try:
        doc = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        rejects.append((source, "*", f"{path}: {e}"))
        doc = {}
    tests = doc.get("tests", {}) if isinstance(doc.get("tests"), dict) else {}
    for name, spec in (doc.get("filters", {}) if isinstance(doc.get("filters"), dict) else {}).items():
        try:
            filters.append(build_filter(name, spec, tests.get(name) or [], source))
        except (ValueError, TypeError, AttributeError) as e:
            rejects.append((source, name, str(e)))
    _cache[path] = (mtime, filters, rejects)
    return filters, rejects


def load_filters(cwd: str | os.PathLike | None = None) -> tuple[list[OutputFilter], list[tuple[str, str, str]]]:
    """Every filter in effect for a worker in cwd, in lookup order (project, user, built-in), and every reject."""
    layers = [(config.HOME / "filters.toml", "user"), (BUILTIN, "builtin")]
    if cwd:
        layers.insert(0, (Path(cwd) / PROJECT_REL, "project"))
    filters: list[OutputFilter] = []
    rejects: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for path, source in layers:
        got, bad = load_file(path, source)
        rejects += bad
        for f in got:
            if f.name not in seen:
                seen.add(f.name)
                filters.append(f)
    return filters, rejects


def match(command: str, cwd: str | os.PathLike | None = None) -> OutputFilter | None:
    return next((f for f in load_filters(cwd)[0] if f.match_command.search(command or "")), None)


def strip_raw(command: str) -> tuple[str, bool]:
    """(the command bash should run, whether the worker asked for raw output with the RAW_MARKER prefix)."""
    head = (command or "").lstrip()
    rest = head[len(RAW_MARKER):]
    if head.startswith(RAW_MARKER) and (not rest or rest[0].isspace() or rest[0] == ";"):
        return rest.lstrip().lstrip(";").lstrip(), True
    return command, False


def filter_output(command: str, text: str, cwd: str | os.PathLike | None = None) -> str:
    """The text a worker reads for this command's output: filtered when a filter matches and that is shorter, else raw."""
    if not text or strip_raw(command)[1] or os.environ.get("HSWARM_OUTPUT_FILTERS") == "0":
        return text
    f = match(command, cwd)
    if f is None:
        return text
    try:
        body = f.apply(text)
    except Exception:  # a filter is an optimisation: whatever it trips on, the worker still gets the raw output
        return text
    total = len(text.rstrip("\n").split("\n"))
    shown = len(body.split("\n")) if body else 0
    note = f'[hswarm output filter "{f.name}": {shown} of {total} lines shown; prefix the command with {RAW_MARKER} for the raw output]'
    out = f"{body}\n{note}" if body else note
    # Never worse: the rule rtk's guard.rs keeps. A filter that saves nothing costs the worker the raw lines for no gain.
    return out if len(out) < len(text) else text


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="hswarm filters", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cwd", default=".", help="the worker's directory: its .hswarm/filters.toml is the project layer")
    ap.add_argument("--apply", metavar="COMMAND", help="filter stdin as the output of COMMAND and print what a worker would read")
    a = ap.parse_args(argv)
    cwd = Path(a.cwd).resolve()
    if a.apply is not None:
        sys.stdout.write(filter_output(a.apply, sys.stdin.read(), cwd) + "\n")
        return 0
    filters, rejects = load_filters(cwd)
    for f in filters:
        print(f"{f.source:8} {f.name:16} {f.tests} test(s) ok  /{f.match_command.pattern}/  {f.description}")
    for source, name, why in rejects:
        print(f"{source:8} {name:16} REJECTED: {why}")
    return 1 if rejects else 0
