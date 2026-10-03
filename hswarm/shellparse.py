"""Split a bash command line into the simple commands it would run.

WHY: the bash tool's git gate used to be one regex over the raw string, and chaining, quoting and substitution
walk past a regex (`g'i't checkout`, `echo "$(git stash)"`, `a && b | c`). This reads the line the way bash
would: quotes removed, `$(...)`, backticks and `<(...)` opened as commands of their own, here-doc bodies and
redirect targets skipped as data. A here-doc or here-string is kept on its command as stdin text, and a
pipe into a command is noted, because `bash <<EOF`, `sh <<< '...'` and `... | sh` run their stdin as a script.
So a rule sees each command that actually runs. It is a gate against a
worker's retry, not a full bash parser: a word whose value only exists at run time ($VAR, $(...), `...`) is
marked dynamic, so the policy can refuse what it cannot read instead of guessing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_DEPTH = 8  # nested substitutions and sh -c layers; deeper than this is refused, never followed
_VAR = re.compile(r"[A-Za-z_]\w*|[0-9?@*#$!-]")


@dataclass
class Command:
    argv: list[str] = field(default_factory=list)
    dynamic: list[bool] = field(default_factory=list)  # per word: its value is only known at run time
    path_program: bool = False  # argv[0] was spelled as a path (./x, /usr/bin/x), set by shellcanon
    stdin: list[str] = field(default_factory=list)  # here-doc bodies and here-strings fed to it, as written
    piped: bool = False  # its stdin is the previous command's output, only known at run time


def split(line: str, depth: int = 0) -> list[Command]:
    """Every simple command `line` runs, in the order bash starts them (a substitution before its user)."""
    return _Lexer(line, depth).run()


class _Lexer:
    def __init__(self, line: str, depth: int):
        if depth > MAX_DEPTH:
            raise ValueError(f"the command nests more than {MAX_DEPTH} levels of $(...) / sh -c deep; split it up")
        self.s, self.i, self.depth = line, 0, depth
        self.out: list[Command] = []
        self.cmd = Command()
        self.word: list[str] = []
        self.in_word = self.dyn = self.drop_next = self.herestring = False
        # (command, delimiter, tabs stripped, body expanded) for each here-doc whose body starts at the next newline
        self.heredocs: list[tuple[Command, str, bool, bool]] = []

    def run(self) -> list[Command]:
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r":
                self.end_word()
                self.i += 1
            elif c == "\n":
                self.end_command()
                self.i += 1
                self.skip_heredocs()
            elif c == "#" and not self.in_word:
                while self.i < len(s) and s[self.i] != "\n":
                    self.i += 1
            elif c in "<>" or s.startswith("&>", self.i):
                self.redirect()
            elif c in ";&|()":
                self.end_command()
                if s.startswith(("||", "&&"), self.i):
                    self.i += 2
                elif c == "|":  # `|` and `|&` feed the next command's stdin
                    self.i += 2 if s.startswith("|&", self.i) else 1
                    self.cmd.piped = True
                else:
                    self.i += 1
            else:
                self.word_part(quoted=False)
        self.end_command()
        return self.out

    def end_word(self) -> None:
        if self.in_word:
            if self.herestring:  # `<<< word`: the word is the command's stdin, not an argument
                self.cmd.stdin.append("".join(self.word))
                self.herestring = self.drop_next = False
            elif self.drop_next:
                self.drop_next = False
            else:
                self.cmd.argv.append("".join(self.word))
                self.cmd.dynamic.append(self.dyn)
        self.word, self.in_word, self.dyn = [], False, False

    def end_command(self) -> None:
        self.end_word()
        if self.cmd.argv:
            self.out.append(self.cmd)
        self.cmd, self.drop_next, self.herestring = Command(), False, False

    def append(self, text: str, dynamic: bool = False) -> None:
        self.word.append(text)
        self.in_word = True
        self.dyn = self.dyn or dynamic

    def nested(self, body: str) -> None:
        self.out.extend(split(body, self.depth + 1))

    def redirect(self) -> None:
        s = self.s
        if s.startswith(("<(", ">("), self.i):  # process substitution: a command, not a file
            end = _closing_paren(s, self.i + 2)
            self.nested(s[self.i + 2:end])
            self.append(s[self.i:end + 1], dynamic=True)
            self.i = end + 1
            return
        if self.in_word and "".join(self.word).isdigit():  # `2>`: the digits name a descriptor, not an argument
            self.word, self.in_word = [], False
        self.end_word()
        op_start = self.i
        while self.i < len(s) and s[self.i] in "<>&|":
            self.i += 1
        op = s[op_start:self.i]
        if op == "<<":
            self.read_heredoc_delimiter()
        elif op == "<<<":
            self.herestring = True
        else:
            self.drop_next = True  # the file (or `&1`) after the operator is data

    def read_heredoc_delimiter(self) -> None:
        s = self.s
        strip = self.i < len(s) and s[self.i] == "-"
        self.i += strip
        while self.i < len(s) and s[self.i] in " \t":
            self.i += 1
        start = self.i
        while self.i < len(s) and s[self.i] not in " \t\r\n;&|()<>":
            self.i += 1
        word = s[start:self.i]
        self.heredocs.append((self.cmd, re.sub(r"[\"'\\]", "", word), bool(strip), not re.search(r"[\"'\\]", word)))

    def skip_heredocs(self) -> None:
        """Read past each pending here-doc body: it is its command's stdin, and an unquoted one still runs its $(...)."""
        s = self.s
        for cmd, delimiter, strip, expanded in self.heredocs:
            body: list[str] = []
            while self.i < len(s):
                end = s.find("\n", self.i)
                end = len(s) if end < 0 else end
                line = s[self.i:end].rstrip("\r")
                self.i = end + 1
                if (line.lstrip("\t") if strip else line) == delimiter:
                    break
                body.append(line)
            cmd.stdin.append("\n".join(body))
            if expanded:
                self.substitutions("\n".join(body))
        self.heredocs = []

    def substitutions(self, text: str) -> None:
        """The $(...) and backtick commands in text bash expands but does not split (an unquoted here-doc body)."""
        j = 0
        while j < len(text):
            if text[j] == "\\":
                j += 2
            elif text.startswith("$(", j):
                end = _closing_paren(text, j + 2)
                self.nested(text[j + 2:end])
                j = end + 1
            elif text[j] == "`":
                end = j + 1
                while end < len(text) and text[end] != "`":
                    end += 2 if text[end] == "\\" else 1
                self.nested(text[j + 1:end].replace("\\`", "`"))
                j = end + 1
            else:
                j += 1

    def word_part(self, quoted: bool) -> None:
        s, c = self.s, self.s[self.i]
        if c == "\\":
            if s.startswith("\\\n", self.i):  # line continuation
                self.i += 2
                return
            self.append(s[self.i + 1:self.i + 2])
            self.i += 2
        elif c == "'" and not quoted:
            end = s.find("'", self.i + 1)
            end = len(s) if end < 0 else end
            self.append(s[self.i + 1:end])
            self.i = end + 1
        elif c == '"' and not quoted:
            self.double_quoted()
        elif c == "$":
            self.dollar(quoted)
        elif c == "`":
            end = self.i + 1
            while end < len(s) and s[end] != "`":
                end += 2 if s[end] == "\\" else 1
            self.nested(s[self.i + 1:end].replace("\\`", "`"))
            self.append(s[self.i:end + 1], dynamic=True)
            self.i = end + 1
        else:
            self.append(c)
            self.i += 1

    def double_quoted(self) -> None:
        s = self.s
        self.i += 1
        self.append("")  # "" is still a word
        while self.i < len(s) and s[self.i] != '"':
            if s[self.i] == "\\" and s[self.i + 1:self.i + 2] not in ('"', "\\", "$", "`", "\n"):
                self.append("\\")  # inside double quotes a backslash only escapes those five
                self.i += 1
            else:
                self.word_part(quoted=True)
        self.i += 1

    def dollar(self, quoted: bool) -> None:
        s, i = self.s, self.i
        nxt = s[i + 1:i + 2]
        if nxt == "(":
            end = _closing_paren(s, i + 2)
            self.nested(s[i + 2:end])
            self.append(s[i:end + 1], dynamic=True)
            self.i = end + 1
        elif nxt == "{":
            end = s.find("}", i)
            end = len(s) if end < 0 else end
            self.append(s[i:end + 1], dynamic=True)
            self.i = end + 1
        elif nxt == "'" and not quoted:  # $'...' decodes escapes, so `$'\x67it'` spells git: unknown when it has any
            end = s.find("'", i + 2)
            end = len(s) if end < 0 else end
            self.append(s[i + 2:end], dynamic="\\" in s[i + 2:end])
            self.i = end + 1
        elif (m := _VAR.match(s, i + 1)) is not None:
            self.append(s[i:m.end()], dynamic=True)
            self.i = m.end()
        elif nxt == '"' and not quoted:  # $"..." is a translated string: the quotes are what matter
            self.i += 1
        else:
            self.append("$")
            self.i += 1


def _closing_paren(s: str, start: int) -> int:
    """The index of the `)` closing a `(` opened just before `start`, skipping quoted text; len(s) when unclosed."""
    depth, j = 1, start
    while j < len(s):
        c = s[j]
        if c == "\\":
            j += 2
            continue
        if c in "'\"":
            close = s.find(c, j + 1)
            j = len(s) if close < 0 else close + 1
            continue
        depth += {"(": 1, ")": -1}.get(c, 0)
        if depth == 0:
            return j
        j += 1
    return len(s)
