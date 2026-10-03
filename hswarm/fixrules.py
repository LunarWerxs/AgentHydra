"""Error-output-to-fix rules for a worker's failed bash call.

A cheap worker whose shell call fails for a reason a rule can recognise (a misspelled git subcommand,
a cd into a directory spelled wrong, `python3` on a box that only has `python`) otherwise spends a
whole model turn - a full context re-send - working out the retry. Each rule reads (command, output,
cwd) and returns corrected commands; `Sandbox.t_bash` appends the best one to the tool result, so the
retry is a copy. The contract is nvbn/thefuck's (a rule matches a failed command and returns ranked
corrections, lower priority first; MIT); the rules are written fresh for what workers hit, and none
of them installs, deletes, escalates or touches a file the worker did not name.
"""
from __future__ import annotations

import difflib
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# A command word sits at the start of the line or right after a shell separator.
_AT = r"(^|[;&|(\n]\s*)"


@dataclass(frozen=True)
class Fix:
    command: str
    rule: str
    priority: int  # lower wins, as in thefuck


@dataclass(frozen=True)
class Rule:
    name: str
    fixes: Callable[[str, str, Path], list[str]]  # (command, output, cwd) -> corrections; [] = no match
    priority: int = 1000


def _swap_word(command: str, old: str, new: str) -> str:
    """Replace the first command-position `old` with `new`."""
    return re.sub(_AT + re.escape(old) + r"(?=\s|$)", lambda m: m.group(1) + new, command, count=1)


def _git_not_command(command: str, output: str, cwd: Path) -> list[str]:
    bad = re.search(r"git: '([^']+)' is not a git command", output)
    near = re.search(r"most similar commands? (?:is|are)\s*\n((?:[ \t]+\S+\s*\n?)+)", output)
    if not (bad and near):
        return []
    typo = re.compile(r"\bgit((?:\s+-[Cc]\s+\S+)*\s+)" + re.escape(bad.group(1)) + r"\b")
    return [typo.sub(lambda m, s=s: "git" + m.group(1) + s, command, count=1) for s in near.group(1).split()]


def _git_push_upstream(command: str, output: str, cwd: Path) -> list[str]:
    hint = re.search(r"^\s+(git push --set-upstream \S+ \S+)\s*$", output, re.M)
    if "has no upstream branch" not in output or not hint:
        return []
    return [re.sub(r"\bgit push\b[^;&|\n]*", lambda m: hint.group(1), command, count=1)]


def _cargo_no_command(command: str, output: str, cwd: Path) -> list[str]:
    bad = re.search(r"no such (?:sub)?command:? [`']([\w-]+)[`']", output)
    near = re.search(r"[Dd]id you mean [`']([\w-]+)[`']", output)
    if not (bad and near and "cargo" in command):
        return []
    return [re.sub(r"\bcargo(\s+)" + re.escape(bad.group(1)) + r"\b", lambda m: "cargo" + m.group(1) + near.group(1), command, count=1)]


def _cd_correction(command: str, output: str, cwd: Path) -> list[str]:
    miss = re.search(r"cd: (.+?): No such file or directory", output)
    if not miss:
        return []
    target = Path(miss.group(1))
    parent = target.parent if target.is_absolute() else cwd / target.parent
    if not parent.is_dir():
        return []
    dirs = [p.name for p in parent.iterdir() if p.is_dir()]
    close = difflib.get_close_matches(target.name, dirs, n=1, cutoff=0.6)
    if not close:
        return []
    fixed = (target.parent / close[0]).as_posix()
    spelled = re.compile(r"\bcd\s+([\"']?)" + re.escape(miss.group(1)) + r"\1")
    return [spelled.sub(lambda m: f'cd {m.group(1)}{fixed}{m.group(1)}', command, count=1)]


def _mkdir_parents(command: str, output: str, cwd: Path) -> list[str]:
    if not re.search(r"mkdir: cannot create directory .+: No such file or directory", output):
        return []
    return [re.sub(r"\bmkdir\s+(?!-p\b)", lambda m: "mkdir -p ", command, count=1)]


def _cat_dir(command: str, output: str, cwd: Path) -> list[str]:
    return [_swap_word(command, "cat", "ls")] if re.search(r"^cat: .+: Is a directory", output, re.M) else []


def _grep_recursive(command: str, output: str, cwd: Path) -> list[str]:
    if not re.search(r"^grep: .+: Is a directory", output, re.M) or re.search(r"\bgrep\s+-\w*[rR]", command):
        return []
    return [_swap_word(command, "grep", "grep -r")]


def _script_not_executable(command: str, output: str, cwd: Path) -> list[str]:
    denied = re.search(r"(\S+\.sh): Permission denied", output)
    return [_swap_word(command, denied.group(1), "bash " + denied.group(1))] if denied else []


# Tried in order; the first alternative whose program is really on PATH wins. The WindowsApps
# python stubs are skipped: they print "Python was not found" instead of running.
_ALTERNATES = {
    "python3": ["python", "py -3"], "python": ["python3", "py -3"],
    "pip": ["python -m pip", "python3 -m pip"], "pip3": ["python -m pip", "python3 -m pip"],
    "pytest": ["python -m pytest", "python3 -m pytest"], "py.test": ["python -m pytest", "python3 -m pytest"],
}


def _real_program(name: str) -> bool:
    found = shutil.which(name)
    return bool(found) and "windowsapps" not in found.lower()


def _command_alternative(command: str, output: str, cwd: Path) -> list[str]:
    missing = re.search(r"(?:^|: )(\S+): command not found", output, re.M)
    name = missing.group(1) if missing else None
    if name is None and "Python was not found" in output:
        name = next((n for n in ("python3", "python") if re.search(_AT + re.escape(n) + r"\b", command)), None)
    return [_swap_word(command, name, alt) for alt in _ALTERNATES.get(name or "", []) if _real_program(alt.split()[0])]


def _local_module(command: str, output: str, cwd: Path) -> list[str]:
    missing = re.search(r"ModuleNotFoundError: No module named '([\w.]+)'", output)
    if not missing or "PYTHONPATH" in command:
        return []
    top = missing.group(1).split(".")[0]
    for root in (".", "src"):
        base = cwd / root
        if (base / top).is_dir() or (base / f"{top}.py").is_file():
            return [f"PYTHONPATH={root} {command}" if not re.search(r"[;&|\n]", command) else f"export PYTHONPATH={root} && {command}"]
    return []


RULES: list[Rule] = [
    Rule("git_not_command", _git_not_command, 100),
    Rule("cargo_no_command", _cargo_no_command, 100),
    Rule("command_alternative", _command_alternative, 200),
    Rule("local_module", _local_module, 300),
    Rule("cd_correction", _cd_correction, 400),
    Rule("mkdir_parents", _mkdir_parents, 500),
    Rule("grep_recursive", _grep_recursive, 500),
    Rule("cat_dir", _cat_dir, 600),
    Rule("script_not_executable", _script_not_executable, 600),
    Rule("git_push_upstream", _git_push_upstream, 700),
]


def suggest(command: str, output: str, cwd: str | Path) -> list[Fix]:
    """Every correction the rules offer for a failed command, best first; [] when none matches."""
    if len(output) > 40_000:  # the error sits at one end; a megabyte of log is not worth scanning
        output = output[:8_000] + "\n" + output[-32_000:]
    found: list[Fix] = []
    for rule in RULES:
        try:
            fixes = rule.fixes(command, output, Path(cwd))
        except (OSError, ValueError, re.error):
            continue  # a rule that cannot read the disk simply offers nothing
        for i, fixed in enumerate(fixes):
            if fixed and fixed.strip() != command.strip() and all(f.command != fixed for f in found):
                found.append(Fix(fixed, rule.name, rule.priority + i))
    return sorted(found, key=lambda f: f.priority)
