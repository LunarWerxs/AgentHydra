"""Acceptance criteria a task carries, decided in code after the worker stops.

Why: a task used to succeed when the worker said so. A task may now name typed leaves, and each is
checked against the sandbox and the record of what the worker actually ran, so a fan-out of
code-changing tasks comes back "status ok, 3/3 criteria hold" instead of "status ok" on trust.

    file:<path>            the file exists and is not empty
    file_written:<path>    the worker itself wrote it this run (write/edit tool), and it reads back non-empty
    tests_passed:<command> a bash call the worker made ran exactly that command, exit 0, with a test summary
                           in the tail of its output (N passed, OK, ok, test result: ok, ...)

Anything else, and anything the record cannot settle, is UNVERIFIED: never passed on a guess.
The bash record is the Sandbox's receipt ledger (receipts.py): each bash receipt keeps its command, exit
code and output tail, so nothing new is recorded here.
The idea comes from bytedance/deer-flow (MIT) backend/packages/harness/deerflow/subagents/acceptance_checks.py;
the code here is written fresh for hswarm's Sandbox and receipt ledger.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

from .outfilters import strip_raw
from .receipts import CLAIM_CHARS

if TYPE_CHECKING:
    from .tools import Sandbox

HOLDS, FAILS, UNVERIFIED = "holds", "fails", "UNVERIFIED"
KINDS = ("file", "file_written", "tests_passed")

# The last lines a test runner prints when it passed: pytest/jest/vitest "N passed", mocha "N passing",
# unittest "OK", go "ok  pkg", cargo "test result: ok.", node --test "# pass N". A count of 0 is not a pass.
_SUMMARY = re.compile(r"\b[1-9]\d* (?:passed|passing)\b|^OK\b|^ok\s+\S|test result: ok\.|^# pass [1-9]", re.M)
# Why: "1 failed, 2 passed" carries a pass count too, and `trap 'exit 0' EXIT; pytest -q` exits 0 on it.
# A tail that reports any failure or error is never a pass, whatever the exit code says.
_FAILURES = re.compile(r"\b[1-9]\d* (?:failed|failing|errors?)\b|^FAILED\b|test result: FAILED|^# fail [1-9]", re.M)
# Why: these change which binary runs or narrow the run (`PYTEST_ADDOPTS=-k x pytest -q` is not pytest -q),
# so they are kept in argv and the command then fails to match, instead of being stripped as mere environment.
_ARGV_CHANGING = {"PATH", "PYTHONPATH", "PYTEST_ADDOPTS", "PYTEST_PLUGINS", "NODE_OPTIONS", "GOFLAGS", "BASH_ENV", "ENV"}
# Why: a `cd` moves the rest of the chain to another tree, so `cd tests/unit && pytest -q` is a narrower run.
_DIR_CHANGERS = {"cd", "pushd", "popd"}

# Shell operators, longest first so "&&" is not read as "&". Redirections are consumed with their target;
# the rest split one simple command from the next.
_REDIRECTS = ("&>>", "&>", ">>", ">&", "<&", ">|", "<>", ">", "<")
_SEPARATORS = ("&&", "||", "|&", ";;", ";", "|", "&", "(", ")", "\n")
# Structure this checker will not reason about: a subshell, a heredoc (its body lines would read as
# commands), a background job, a pipe into another process that owns the exit status.
_UNJUDGED = {"(", ")", "|&", ";;", "&"}
_ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")


def parse(criterion: str) -> tuple[str, str]:
    """(kind, argument); kind is "" for a criterion with no typed prefix."""
    kind, sep, arg = str(criterion).partition(":")
    kind = kind.strip()
    return (kind, arg.strip()) if sep and kind in KINDS else ("", str(criterion).strip())


def split_commands(command: str) -> list[tuple[list[str], str | None]] | None:
    """Each simple command's argv (quotes removed, redirections dropped) and the operator after it, or
    None when the shell structure is too rich to judge. Parsed, not searched: `echo "pytest passed"` is
    one command whose argv starts with echo, so a line that only MENTIONS the command never matches."""
    sp = _Splitter(command.replace("\\\n", ""))
    while sp.i < len(sp.s):
        if not sp.step():
            return None
    return sp.finish()


class _Splitter:
    """One split_commands pass: the simple commands so far, and the argv and word being built. Each step
    consumes one character (or one operator) and returns False when the structure is too rich to judge."""

    def __init__(self, s: str) -> None:
        self.s = s
        self.segs: list[tuple[list[str], str | None]] = []
        self.argv: list[str] = []
        self.word: list[str] = []
        self.quote: str | None = None
        self.in_word = self.drop_next = False
        self.i = 0

    def flush(self) -> None:
        if self.in_word:
            if not self.drop_next:
                self.argv.append("".join(self.word))
            self.drop_next = False
        self.word, self.in_word = [], False

    def step(self) -> bool:
        c = self.s[self.i]
        if self.quote == "'":
            return self._quoted(c)
        if c == "`" or self.s.startswith("$(", self.i):
            return False  # command substitution runs code this parse cannot see
        if c == "\\" and self.i + 1 < len(self.s):
            self.word.append(self.s[self.i + 1])
            self.in_word = True
            self.i += 2
            return True
        if self.quote == '"':
            return self._quoted(c)
        return self._bare(c)

    def _quoted(self, c: str) -> bool:
        if c == self.quote:
            self.quote = None
        else:
            self.word.append(c)
        self.i += 1
        return True

    def _bare(self, c: str) -> bool:
        s, i = self.s, self.i
        if c in "'\"":
            self.quote, self.in_word = c, True
            self.i += 1
            return True
        if s.startswith("<<", i):
            return False
        redirect = next((r for r in _REDIRECTS if s.startswith(r, i)), None)
        if redirect:
            self._redirect(redirect)
            return True
        op = next((o for o in _SEPARATORS if s.startswith(o, i)), None)
        if op or c in " \t\r":
            return self._separate(op)
        self.word.append(c)
        self.in_word = True
        self.i += 1
        return True

    def _redirect(self, redirect: str) -> None:
        if self.in_word and self.word and "".join(self.word).isdigit():
            self.word, self.in_word = [], False  # "2>&1": the 2 is a file descriptor, not an argument
        self.flush()
        self.drop_next = True  # the redirect target is not an argument either
        self.i += len(redirect)

    def _separate(self, op: str | None) -> bool:
        self.flush()
        if not op:
            self.i += 1
            return True
        if op in _UNJUDGED:
            return False
        if self.argv or op not in (";", "\n"):  # a blank line is not a command
            self.segs.append((self.argv, op))
        self.argv = []
        self.i += len(op)
        return True

    def finish(self) -> list[tuple[list[str], str | None]] | None:
        if self.quote:
            return None
        self.flush()
        if self.argv:
            self.segs.append((self.argv, None))
        elif self.segs and self.segs[-1][1] in (";", "\n"):
            self.segs[-1] = (self.segs[-1][0], None)  # "pytest -q;" and a trailing newline end the list, they chain nothing
        return [(_strip_assignments(a), op) for a, op in self.segs]


def _strip_assignments(argv: list[str]) -> list[str]:
    """`CI=1 pytest -q` runs pytest -q: leading VAR=value words are environment, not the command. One that
    changes or narrows the run (_ARGV_CHANGING) stops the strip, so it stays in argv and cannot match."""
    k = 0
    while k < len(argv) and (m := _ASSIGN.match(argv[k])) and m.group(0)[:-1] not in _ARGV_CHANGING:
        k += 1
    return argv[k:]


def _stays_in_cwd(argv: list[str], sb: "Sandbox | None") -> bool:
    """Whether a `cd` segment leaves the shell in the task cwd: only `cd <dir>` whose dir resolves to it."""
    if sb is None or argv[0] != "cd" or len(argv) != 2:
        return False
    try:
        return sb.resolve(argv[1]) == sb.cwd
    except (PermissionError, OSError, ValueError):
        return False


def ran_command(recorded: str, target: list[str], sb: "Sandbox | None" = None) -> bool:
    """Whether `recorded`, exiting 0, proves `target` ran and exited 0: a simple command with exactly that
    argv, reached by `;`/`&&` (never `||` or a pipe), and followed only by `&&`, so nothing after it could
    have turned its failure into the overall exit 0. A `cd` before it counts only when it lands in the
    task cwd (resolved through `sb`); any other directory change means a different or narrower run."""
    segs = split_commands(strip_raw(recorded)[0])
    if not segs:
        return False
    for k, (argv, _) in enumerate(segs):
        if argv != target:
            continue
        if any(a and a[0] in _DIR_CHANGERS and not _stays_in_cwd(a, sb) for a, _ in segs[:k]):
            continue
        before = segs[k - 1][1] if k else None
        after = [op for _, op in segs[k:] if op is not None]
        if before in (None, ";", "\n", "&&") and all(op == "&&" for op in after):
            return True
    return False


def _tests_passed(command: str, receipts: list[dict] | None, sb: "Sandbox | None" = None) -> tuple[str, str]:
    if receipts is None:
        return UNVERIFIED, "this backend keeps no record of the commands its worker ran"
    target = split_commands(command)
    if not target or len(target) != 1 or not target[0][0]:
        return UNVERIFIED, "name ONE simple command (no pipes, chains or substitutions) to match against the record"
    argv = target[0][0]
    # A receipt keeps its command cut at CLAIM_CHARS: a cut one could have lost a trailing `|| true`, so it
    # proves nothing and is left out rather than matched on its visible head.
    runs = [r for r in receipts if r.get("tool") == "bash" and len(str(r.get("command") or "")) < CLAIM_CHARS]
    matched = [r for r in runs if ran_command(str(r.get("command") or ""), argv, sb)]
    if not matched:
        return UNVERIFIED, f"no recorded bash call ran `{command}` (of {len(runs)} recorded)"
    last = matched[-1]  # a worker that failed, fixed and re-ran is judged on its latest run
    if last.get("exit") is None:
        return UNVERIFIED, f"latest matching run ({last.get('id', '?')}) recorded no exit code"
    if last.get("exit") != 0:
        return FAILS, f"latest matching run ({last.get('id', '?')}) exited {last.get('exit')}"
    tail = str(last.get("tail") or "")
    if _FAILURES.search(tail):
        return FAILS, f"latest matching run ({last.get('id', '?')}) exited 0 but its output tail reports failures"
    if not _SUMMARY.search(tail):
        return UNVERIFIED, "the matching run exited 0 but its output tail carries no test summary"
    return HOLDS, f"{last.get('id', '?')}: exit 0 with a test summary ({len(matched)} matching run{'s' if len(matched) != 1 else ''})"


def _file(sb: "Sandbox", path: str, written: set[str] | None, runs: list[dict] | None = None) -> tuple[str, str]:
    try:
        p = sb.resolve(path)
    except PermissionError as e:
        return UNVERIFIED, str(e)
    if written is not None and sb.rel(p) not in written:
        # Why: bash writes too (`cat >`, `sed -i`, a generator) and files_changed never sees it, so an existing
        # file with bash calls on record may be this worker's: that is undecided, not a failure.
        if p.is_file() and any(r.get("tool") == "bash" for r in runs or []):
            return UNVERIFIED, "not written by a write/edit tool; a recorded bash call may have written it"
        return FAILS, "the worker did not write this file in this run"
    if not p.is_file():
        return FAILS, "missing" if not p.exists() else "not a regular file"
    try:
        size = len(p.read_bytes())  # read back, not stat: a file the worker cannot read is not delivered
    except OSError as e:
        return FAILS, f"unreadable: {e}"
    return (HOLDS, f"{size} bytes") if size else (FAILS, "empty")


def decide(criteria: list[str], sb: "Sandbox", files_changed: list[str], runs: list[dict] | None) -> list[dict]:
    """One {criterion, verdict, detail} row per criterion, in the order given. `runs` is the worker's receipt
    ledger (Sandbox.receipts; bash receipts carry {command, exit, tail}), or None for a backend that keeps none."""
    rows = []
    for c in criteria:
        kind, arg = parse(c)
        if kind == "file":
            verdict, detail = _file(sb, arg, None)
        elif kind == "file_written":
            verdict, detail = _file(sb, arg, {Path(f).as_posix() for f in files_changed}, runs)
        elif kind == "tests_passed":
            verdict, detail = _tests_passed(arg, runs, sb)
        else:
            verdict, detail = UNVERIFIED, f"not a typed criterion ({' | '.join(k + ':' for k in KINDS)}); nothing in code can decide it"
        rows.append({"criterion": c, "verdict": verdict, "detail": detail})
    return rows


def tally(rows: list[dict]) -> str:
    """"2/3 hold, 1 fails" - the line an orchestrator reads before merging anything."""
    n = {v: sum(1 for r in rows if r.get("verdict") == v) for v in (HOLDS, FAILS, UNVERIFIED)}
    extra = "".join(f", {n[v]} {v}" for v in (FAILS, UNVERIFIED) if n[v])
    return f"{n[HOLDS]}/{len(rows)} hold{extra}"


def prompt_clause(criteria: list[str]) -> str:
    """What the worker is told, so it can meet the criteria it will be judged on."""
    if not criteria:
        return ""
    lines = "\n".join(f"- {c}" for c in criteria)
    return ("\n\nAcceptance criteria, checked in code after you finish. A tests_passed criterion holds only if you ran "
            "exactly that command with the bash tool, on its own or chained with && (not piped, not || true), and it passed:\n" + lines)
