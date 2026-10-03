"""Peel wrappers off a command so a rule sees the program that really runs, and open the ones that carry a command.

WHY: GTFOBins catalogues how ordinary binaries run other commands, and every one of them walks past a gate
that reads only the first word: `env git stash`, `timeout 60 git restore .`, `find . -exec git checkout {} \\;`,
`ls | xargs git reset`, `sh -c '...'`, `bash <<EOF`, `eval ...`, `cmd //c`, `powershell -Command`, and git
itself through `-c alias.co=checkout co`. expand() turns each of those into the argv of the command that runs
(plus any command it carries), with argv[0] a bare program name, so a prefix rule written once matches every
spelling. What only exists at run time (the words xargs appends, find's `{}`, a script piped into a shell) is
a dynamic word, so the policy refuses it instead of guessing.
"""
from __future__ import annotations

import re

from .shellparse import Command, split

# wrapper -> (its options that take a separate value, positionals it reads before the command)
_WRAPPERS: dict[str, tuple[frozenset[str], int]] = {
    "env": (frozenset({"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}), 0),
    "timeout": (frozenset({"-s", "--signal", "-k", "--kill-after"}), 1),
    "nice": (frozenset({"-n", "--adjustment"}), 0),
    "ionice": (frozenset({"-c", "-n", "-p", "--class", "--classdata"}), 0),
    "stdbuf": (frozenset({"-i", "-o", "-e"}), 0),
    "nohup": (frozenset(), 0),
    "time": (frozenset({"-f", "--format", "-o", "--output"}), 0),
    "command": (frozenset(), 0),
    "builtin": (frozenset(), 0),
    "exec": (frozenset({"-a"}), 0),
    "sudo": (frozenset({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"}), 0),
    "doas": (frozenset({"-u", "-C"}), 0),
    "watch": (frozenset({"-n", "--interval"}), 0),
    "xargs": (frozenset({"-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args",
                         "--max-procs", "--max-chars"}), 0),
    "setsid": (frozenset(), 0),
    "flock": (frozenset({"-w", "--timeout", "-E", "--conflict-exit-code"}), 1),
    "busybox": (frozenset(), 0),
}
_WINDOWS_RUNNERS = frozenset({"cmd", "powershell", "pwsh"})
_KEYWORDS = frozenset({"!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"})
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"})
_FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
_RUN_TIME = "<run-time input>"  # the stand-in word for arguments or a script that only exist when the line runs
_GIT_VALUE_OPTS = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"})
_ASSIGNMENT = re.compile(r"[A-Za-z_]\w*\+?=")


def program(word: str) -> str:
    """`/usr/bin/git`, `C:\\Git\\cmd\\git.exe` and `GIT` all name git."""
    name = word.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name[:-4] if name.endswith(".exe") else name


def expand(line: str, depth: int = 0) -> list[Command]:
    """Every command `line` runs, canonical: wrappers peeled, carried commands opened, argv[0] a bare program name."""
    out: list[Command] = []
    for cmd in split(line, depth):
        out.extend(_canonical(cmd.argv, cmd.dynamic, depth, cmd))
    return out


def _canonical(argv: list[str], dyn: list[bool], depth: int, source: Command | None = None) -> list[Command]:
    """`source` is the parsed command whose stdin (here-doc, here-string, pipe) a shell at the end of the chain reads."""
    carried: list[Command] = []
    while argv:
        name = argv[0] if dyn[0] else program(argv[0])
        if name in _KEYWORDS or (not dyn[0] and _ASSIGNMENT.match(argv[0])):
            skip = 1
        elif name in _WRAPPERS:
            skip = _command_start(name, argv, carried, depth)
            if name == "xargs":
                argv, dyn = _xargs(argv, dyn, skip)
                continue
        else:
            break
        argv, dyn = argv[skip:], dyn[skip:]
    if not argv:
        return carried
    head = Command([argv[0] if dyn[0] else program(argv[0])] + argv[1:], list(dyn),
                   path_program=not dyn[0] and ("/" in argv[0] or "\\" in argv[0]))
    name = head.argv[0]
    if name in _SHELLS:
        carried += _shell_script(argv, depth, source)
    elif name in _WINDOWS_RUNNERS:
        carried += _windows_runner(name, argv, depth)
    elif name == "script":
        carried += _option_script(argv, ("-c", "--command"), depth)
    elif name == "eval":
        carried += expand(" ".join(argv[1:]), depth + 1)
    elif name == "find":
        carried += _find_exec(argv, dyn, depth)
    elif name == "git":
        head, more = _git(head, depth)
        carried += more
    return [head] + carried


def _command_start(name: str, argv: list[str], carried: list[Command], depth: int) -> int:
    """Where the wrapped command starts in a wrapper's argv; `env -S '...'` carries a whole command line."""
    value_opts, positionals = _WRAPPERS[name]
    if name == "flock" and (c := next((k for k, a in enumerate(argv) if a in ("-c", "--command")), 0)):
        carried.extend(expand(argv[c + 1], depth + 1) if c + 1 < len(argv) else [])
        return len(argv)  # `flock <lockfile> -c '<command>'`: the command is that string, run by a shell
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--":
            i += 1
            break
        if a in value_opts:
            if name == "env" and a in ("-S", "--split-string") and i + 1 < len(argv):
                carried.extend(expand(argv[i + 1], depth + 1))
            i += 2
        elif a.startswith("-") or (name == "env" and _ASSIGNMENT.match(a)):
            i += 1
        else:
            break
    return i + positionals


def _xargs(argv: list[str], dyn: list[bool], skip: int) -> tuple[list[str], list[bool]]:
    """The command xargs runs: its input lands in the -I replacement string, or else as words after the last one."""
    replace = None
    for i, a in enumerate(argv[1:skip], 1):
        if a == "-I" and i + 1 < skip:
            replace = argv[i + 1]
        elif a.startswith("-I") or (a.startswith("-i") and not a.startswith("--")):
            replace = a[2:] or "{}"
        elif a == "--replace" or a.startswith("--replace="):
            replace = a.partition("=")[2] or "{}"
    words, flags = argv[skip:], dyn[skip:]
    if not words:
        return [], []  # bare `xargs` runs echo
    if replace:
        return words, [d or replace in w for w, d in zip(words, flags)]
    return words + [_RUN_TIME], flags + [True]


def _shell_script(argv: list[str], depth: int, source: Command | None) -> list[Command]:
    """`bash -lc 'script'` runs the script: its commands. `bash file.sh` runs a file, which is not read here. With
    neither (or -s), the shell runs its stdin: a here-doc or here-string is opened like -c, a pipe is only known at
    run time."""
    saw_c = saw_s = False
    i = 1
    while i < len(argv) and argv[i].startswith(("-", "+")):
        a = argv[i]
        i += 1
        if a == "--":
            break
        if not a.startswith("--"):
            saw_c, saw_s = saw_c or "c" in a[1:], saw_s or "s" in a[1:]
        if a in ("-o", "+o", "-O", "+O"):
            i += 1
    if saw_c:
        return expand(argv[i], depth + 1) if i < len(argv) else []
    if (i < len(argv) and not saw_s) or source is None:
        return []
    if source.stdin:
        return [c for text in source.stdin for c in expand(text, depth + 1)]
    return [Command([_RUN_TIME], [True])] if source.piped else []


def _windows_runner(name: str, argv: list[str], depth: int) -> list[Command]:
    """`cmd //c ...`, `powershell -Command ...`, `pwsh -c ...`: the rest of the line is a command, read as bash would
    (close enough for a prefix rule). An -EncodedCommand is base64, so it is only known at run time."""
    for i, a in enumerate(argv[1:], 1):
        lo = a.lower()
        lo = "-" + lo.lstrip("/") if lo.startswith("/") else lo
        if name == "cmd" and lo in ("-c", "-k", "-r"):
            return expand(" ".join(argv[i + 1:]), depth + 1)
        if name != "cmd" and (lo in ("-e", "-ec") or (lo.startswith("-en") and "-encodedcommand".startswith(lo))):
            return [Command([_RUN_TIME], [True])]
        if name != "cmd" and lo.startswith("-c") and "-command".startswith(lo):
            return expand(" ".join(argv[i + 1:]), depth + 1)
    return []


def _option_script(argv: list[str], opts: tuple[str, ...], depth: int) -> list[Command]:
    """A program that runs the command line given to one of its options (`script -c 'git stash' log`)."""
    for i, a in enumerate(argv[1:-1], 1):
        if a in opts:
            return expand(argv[i + 1], depth + 1)
    return []


def _find_exec(argv: list[str], dyn: list[bool], depth: int) -> list[Command]:
    """The commands after `-exec`/`-execdir`/`-ok`, each up to its `;` or `+`; `{}` is a found path, known at run time."""
    out: list[Command] = []
    i = 0
    while i < len(argv):
        if argv[i] in _FIND_EXEC:
            end = next((j for j in range(i + 1, len(argv)) if argv[j] in (";", "+")), len(argv))
            words = argv[i + 1:end]
            out += _canonical(words, [d or "{}" in w for w, d in zip(words, dyn[i + 1:end])], depth + 1)
            i = end
        i += 1
    return out


def _git(cmd: Command, depth: int) -> tuple[Command, list[Command]]:
    """`git [global options] <sub> ...` as ["git", sub, ...], with any alias defined on the line (-c alias.x=y) opened."""
    argv, dyn = cmd.argv, cmd.dynamic
    aliases: dict[str, str | None] = {}  # None: --config-env, the value is only in the environment
    i = 1
    while i < len(argv) and argv[i].startswith("-"):
        opt, eq, attached = argv[i].partition("=")
        takes_value = opt in _GIT_VALUE_OPTS and not eq
        value = argv[i + 1] if takes_value and i + 1 < len(argv) else attached
        if opt in ("-c", "--config-env") and value.lower().startswith("alias."):
            key, _, val = value.partition("=")
            aliases[key[6:].lower()] = val if opt == "-c" else None
        i += 2 if takes_value else 1
    if i >= len(argv):
        return Command(["git"], [False], cmd.path_program), []
    words, flags = argv[i:], dyn[i:]
    carried: list[Command] = []
    for _ in range(4):  # an alias may name another alias
        if flags[0] or words[0].lower() not in aliases:
            break
        value = aliases.pop(words[0].lower())
        if value is None:
            flags = [True] + flags[1:]
            break
        if value.startswith("!"):  # a shell alias: git runs the line, so the line is what gets checked
            carried += expand(value[1:], depth + 1)
            break
        parsed = split(value, depth + 1)
        alias_argv = parsed[0].argv if parsed else []
        words, flags = alias_argv + words[1:], [False] * len(alias_argv) + flags[1:]
        if not words:
            break
    return Command(["git"] + words, [False] + flags, cmd.path_program), carried
