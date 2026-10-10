"""The worker tools inside a container or over ssh: RemoteSandbox, the runtime half of Sandbox (tools.py).

Every tool is a small POSIX sh script run through Runtime.run (runtimes.py), so any image or host with a
shell works: file content travels on stdin, paths are POSIX paths inside the isolate, and the answers keep
the host tools' shapes, so a worker cannot tell the runtimes apart except by the paths. Everything that is
not a file or shell tool (the dispatch, receipts, grants, the broker, spill pages, read_url) is Sandbox's own.
"""
from __future__ import annotations

import posixpath
import re
import shlex
import tempfile
from pathlib import PurePosixPath

from . import shellpolicy
from .capability import GRANT_FILES, WRITE_TOOLS
from .grep import GREP_LINE_RX
from .outfilters import filter_output, strip_raw
from .outline import LANGS, language_of, render_outline, render_unfold
from .outline import MAX_BYTES as OUTLINE_MAX_BYTES
from .procs import TIMEOUT_EXIT
from .runtimes import Runtime, posix_abs
from .tools import Sandbox, _file_newline, _glob_regex, _to_crlf, glob_regex
from .toolspecs import IGNORED_DIRS

FILE_OP_TIMEOUT_S = 60

# Exit codes the scripts below use to say which Python error the tool should raise.
_MISSING, _IS_DIR = 2, 21
_IGNORED = " ".join(shlex.quote(d) for d in sorted(IGNORED_DIRS))
_PRUNE = "'(' " + " -o ".join(f"-name {shlex.quote(d)}" for d in sorted(IGNORED_DIRS)) + " ')' -prune -o"

_READ = (
    '[ -d "$1" ] && { echo "is a directory: $1" >&2; exit 21; }; '
    '[ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }; '
    'n=$(( $(wc -c < "$1") + 0 )); echo "$n"; '
    'if [ "$n" -le "$2" ]; then cat -- "$1"; fi'
)
_CAT = '[ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }; cat -- "$1"'
_WRITE = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"'
_DIR_OR_FAIL = '[ -d "$1" ] || { echo "no such directory: $1" >&2; exit 2; }; cd -- "$1" || exit 2; '
_LIST = (
    _DIR_OR_FAIL
    + f'find . -mindepth 1 -maxdepth "$2" {_PRUNE} -type d -print | sed "s|^|d |"; '
    + f'find . -mindepth 1 -maxdepth "$2" {_PRUNE} ! -type d -print | sed "s|^|f |"'
)
_GLOB = _DIR_OR_FAIL + f"find . {_PRUNE} -type f -print"
# ripgrep when the isolate has it, else grep -E (POSIX ERE, so a Python-only regex feature may not match).
_GREP = (
    'p=$1; r=$2; g=$3; ic=$4; '
    'if command -v rg >/dev/null 2>&1; then '
    'set -- rg --line-number --with-filename --no-heading --color never --no-messages --threads 2; '
    '[ "$ic" = 1 ] && set -- "$@" -i; [ -n "$g" ] && set -- "$@" -g "$g"; '
    f'for d in {_IGNORED}; do set -- "$@" -g "!$d"; done; '
    'else set -- grep -rsnHE; '
    '[ "$ic" = 1 ] && set -- "$@" -i; [ -n "$g" ] && set -- "$@" --include="$g"; '
    f'for d in {_IGNORED}; do set -- "$@" --exclude-dir="$d"; done; fi; '
    'exec "$@" -e "$p" -- "$r"'
)


def _posix_writable_rule(pattern: str, cwd: PurePosixPath) -> re.Pattern:
    """tools.writable_rule for a path in the isolate: the literal head is joined and normalised lexically (it cannot
    be resolved from this side), and the match is case-sensitive, as a Linux or macOS path is."""
    parts = PurePosixPath(str(pattern).replace("\\", "/")).parts
    cut = next((i for i, part in enumerate(parts) if any(ch in part for ch in "*?")), len(parts))
    head = posix_abs(posixpath.join(str(cwd), *parts[:cut]) if parts[:cut] else str(cwd))
    tail = "/".join(parts[cut:])
    return re.compile(_glob_regex(str(head).rstrip("/") + ("/" + tail if tail else "")).pattern)


def _edit_text(text: str, old_string: str, new_string: str, replace_all: bool) -> tuple[str, int]:
    """Sandbox.t_edit_file's matching rule on text read from the isolate: exact first, then the CRLF spelling of a
    multiline old_string, an ambiguous match refused, and a CRLF file kept CRLF."""
    n, old = text.count(old_string), old_string
    if n == 0 and "\n" in old_string:
        normalized = _to_crlf(old_string)
        crlf_n = text.count(normalized) if normalized != old_string else 0
        if crlf_n:
            old, n = normalized, crlf_n
    if n == 0:
        raise ValueError("old_string not found in file (match must be exact, including whitespace)")
    if n > 1 and not replace_all:
        raise ValueError(f"old_string occurs {n} times; include more context to make it unique or set replace_all")
    if old != old_string or _file_newline(text) == "\r\n":
        new_string = _to_crlf(new_string)
    return text.replace(old, new_string, -1 if replace_all else 1), n


class RemoteSandbox(Sandbox):
    """The Sandbox tools, run inside a container or over ssh. The isolate is the boundary; the root check here is
    lexical (a symlink in the isolate cannot be followed from this side), which keeps the tools aimed at the task."""

    def __init__(self, runtime: Runtime, cwd: str | PurePosixPath, roots: list | None = None, writable: list[str] | None = None, **kwargs):
        # The base sets up everything that lives on THIS host (grants, broker, spill, receipts, the web gate) around a
        # host temp dir; the task's own paths are then replaced with the POSIX paths they are inside the isolate.
        super().__init__(tempfile.gettempdir(), **kwargs)
        self.runtime = runtime
        self.cwd = posix_abs(cwd)
        self.roots = [self.cwd] + [posix_abs(r) for r in (roots or [])]
        self.writable = None if writable is None else list(writable)
        self._writable_rules = [_posix_writable_rule(g, self.cwd) for g in (self.writable or [])]

    def resolve(self, p, must_exist: bool = False, tool: str | None = None) -> PurePosixPath:  # must_exist: checked by the scripts
        raw = str(p).replace("\\", "/") if p not in (None, "", ".") else str(self.cwd)
        path = posix_abs(raw if raw.startswith("/") else posixpath.join(str(self.cwd), raw))
        if not any(path == root or root in path.parents for root in self.roots):
            raise PermissionError(f"path {path} is outside the sandbox roots {[str(r) for r in self.roots]}")
        if tool and self.capability and not self.capability.permits(tool, path, self.cwd, self.roots):
            raise PermissionError(f"{tool} on {self.rel(path)} is outside capability {self.capability.identifier!r}'s path scope")
        # capability.is_grant_file compares host paths; a grant folder inside the isolate is guarded here instead.
        grant_dirs = [root / GRANT_FILES for root in self.roots]
        if tool in WRITE_TOOLS and any(path == d or d in path.parents for d in grant_dirs):
            raise PermissionError(f"{tool} on {self.rel(path)}: capability grant files are never writable by a worker")
        return path

    async def _sh(self, script: str, *args: str, stdin_text: str | None = None, timeout_s: int = FILE_OP_TIMEOUT_S) -> tuple[int, str, str]:
        return await self.runtime.run(script, list(args), str(self.cwd), timeout_s, stdin_text=stdin_text)

    def _raise_for(self, code: int, err: str, path: PurePosixPath) -> None:
        if code == 0:
            return
        if code == _MISSING:
            raise FileNotFoundError(str(path))
        if code == _IS_DIR:
            raise IsADirectoryError(str(path))
        if code == TIMEOUT_EXIT:
            raise TimeoutError(f"{self.runtime.spec} did not answer within the file-op timeout")
        raise OSError(f"{self.runtime.spec} exit {code}: {err.strip()[:500]}")

    async def read_one(self, path: str, start_line: int | None = None, end_line: int | None = None) -> str:  # t_read_file batches on top
        p = self.resolve(path, tool="read_file")
        sliced = bool(start_line or end_line)
        # Unsliced, the isolate sends only the size of an over-cap file, never its bytes.
        code, out, err = await self._sh(_READ, str(p), str(10**15 if sliced else self.max_read_bytes))
        self._raise_for(code, err, p)
        size, _, text = out.partition("\n")
        if int(size or 0) > self.max_read_bytes and not sliced:
            raise ValueError(f"file is {size} bytes; read a slice with start_line/end_line")
        self.files_read.add(p)
        return self._read_page(p, text.splitlines(), start_line, end_line)

    # The host's outline/unfold read the file from THIS disk; here the text comes from the isolate, the same checks around it.
    async def _code_text(self, path: str, tool: str) -> tuple[PurePosixPath, str, str]:
        p = self.resolve(path, tool=tool)
        lang = language_of(p)
        if lang is None:
            known = " ".join(sorted(LANGS))
            raise ValueError(f"no outliner for {p.suffix or p.name!r} files (known: {known}); use grep and read_file slices")
        code, out, err = await self._sh(_READ, str(p), str(OUTLINE_MAX_BYTES))
        self._raise_for(code, err, p)
        size, _, text = out.partition("\n")
        if int(size or 0) > OUTLINE_MAX_BYTES:
            raise ValueError(f"file is {size} bytes, over the {OUTLINE_MAX_BYTES} outline limit; use grep and read_file slices")
        return p, lang, text

    async def t_outline(self, path: str) -> str:
        p, lang, text = await self._code_text(path, "outline")
        return render_outline(self.rel(p), text, lang)

    async def t_unfold(self, path: str, symbol: str) -> str:
        p, lang, text = await self._code_text(path, "unfold")
        return render_unfold(self.rel(p), text, lang, symbol)

    # No self._remember: edit survival (survival.py) re-reads files on THIS host, where an isolate's paths mean nothing.
    async def t_write_file(self, path: str, content: str) -> str:
        p = self.resolve(path, tool="write_file")
        self.check_writable(p)
        refusal = await self.permit("write", str(p))
        if refusal:
            return refusal
        code, _out, err = await self._sh(_WRITE, str(p), stdin_text=content)
        self._raise_for(code, err, p)
        self.files_changed.append(self.rel(p))
        return f"wrote {len(content)} chars to {self.rel(p)}"

    # near_line is accepted so the shared spec works, but only an exact, unique old_string edits here: no near match.
    async def t_edit_file(self, path: str, old_string: str, new_string: str, replace_all: bool = False,
                          near_line: int | None = None) -> str:
        p = self.resolve(path, tool="edit_file")
        self.check_writable(p)
        refusal = await self.permit("write", str(p))
        if refusal:
            return refusal
        code, text, err = await self._sh(_CAT, str(p))
        self._raise_for(code, err, p)
        # The transport decodes with errors='replace', so a non-UTF-8 byte arrives as U+FFFD and writing the text
        # back would destroy it. Refuse, as the host's strict read does.
        if "�" in text:
            raise ValueError(f"{self.rel(p)} is not valid UTF-8 (or already holds U+FFFD); edit refused so no byte is lost, "
                             "use bash for this file")
        edited, n = _edit_text(text, old_string, new_string, replace_all)
        code, _out, err = await self._sh(_WRITE, str(p), stdin_text=edited)
        self._raise_for(code, err, p)
        self.files_changed.append(self.rel(p))
        return f"edited {self.rel(p)} ({n} replacement{'s' if n != 1 else ''})"

    async def t_list_dir(self, path: str = ".", depth: int = 1) -> str:
        root = self.resolve_root(path, "list_dir")
        depth = max(1, min(int(depth or 1), 3))
        code, out, err = await self._sh(_LIST, str(root), str(depth))
        self._raise_for(code, err, root)
        children: dict[tuple, list[tuple[str, bool]]] = {}
        for line in out.splitlines():
            kind, _, rel = line.partition(" ")
            parts = PurePosixPath(rel).parts
            if parts:
                children.setdefault(parts[:-1], []).append((parts[-1], kind == "d"))
        lines: list[str] = []

        def walk(prefix: tuple, level: int) -> None:
            for name, is_dir in sorted(children.get(prefix, []), key=lambda e: (not e[1], e[0].lower())):
                # A denied entry is hidden and never walked, as on the host.
                if self.capability and self.capability.denies("list_dir", root.joinpath(*prefix, name), self.cwd):
                    continue
                lines.append(f"{'  ' * (level - 1)}{name}{'/' if is_dir else ''}")
                if is_dir:
                    walk(prefix + (name,), level + 1)
                if len(lines) > 2000:
                    return

        walk((), 1)
        return "\n".join(lines) or "(empty)"

    async def t_glob(self, pattern: str, path: str = ".") -> str:
        if pattern.replace("\\", "/").startswith("/"):
            parts = PurePosixPath(pattern.replace("\\", "/")).parts
            cut = next((i for i, part in enumerate(parts) if any(ch in part for ch in "*?[")), len(parts))
            path, pattern = str(PurePosixPath(*parts[:cut])), "/".join(parts[cut:]) or "*"
        root = self.resolve_root(path, "glob")
        code, out, err = await self._sh(_GLOB, str(root))
        self._raise_for(code, err, root)
        rx = glob_regex(pattern)
        # Path order, not newest-first as on the host: mtime needs `stat`, whose flags differ between GNU and BSD.
        rels = sorted(line[2:] if line.startswith("./") else line for line in out.splitlines())
        hits = [root / r for r in rels if rx.fullmatch(r) and self.shown("glob", root / r)]
        return "\n".join(self.rel(h) for h in hits[:500]) or "(no matches)"

    async def t_propose(self, *args, **kwargs) -> str:
        raise NotImplementedError(f"propose queues changes that are applied on this host after the task; runtime "
                                  f"{self.runtime.spec} has no tree here, so use write_file/edit_file inside it")

    async def t_grep(self, pattern: str, path: str = ".", glob: str | None = None, ignore_case: bool = False, max_results: int = 200) -> str:
        root = self.resolve_root(path, "grep")
        max_results = max(1, min(int(max_results or 200), 1000))
        code, out, err = await self._sh(_GREP, pattern, str(root), glob or "", "1" if ignore_case else "0")
        # grep and rg both exit 1 for "no matches", which is an answer, not an error. Both also exit 2 when any one
        # file was unreadable (common in containers) even though they found hits: keep the hits then.
        if code not in (0, 1) and not (code == 2 and out.strip()):
            return f"ERROR: grep exit {code} in {self.runtime.spec}: {err.strip()[:500]}"
        hits = [self._hit(line, root) for line in out.splitlines()]
        if self.capability and self.capability.scoped:
            hits = [(p, line) for p, line in hits if p is None or self.shown("grep", p)]  # file contents only from allowed paths
        body = "\n".join(line for _p, line in hits[:max_results]) or "(no matches)"
        if len(hits) > max_results:
            body += f"\n... {len(hits) - max_results} more matches not shown"
        return body

    def _hit(self, line: str, root: PurePosixPath) -> tuple[PurePosixPath | None, str]:
        """One raw hit as (its file, the line citing that file relative to cwd)."""
        m = GREP_LINE_RX.match(line)
        if not m:
            return None, line
        hit = posix_abs(m.group(1) if m.group(1).startswith("/") else posixpath.join(str(root), m.group(1)))
        return hit, f"{self.rel(hit)}:{m.group(2)}:{m.group(3)}"

    async def t_bash(self, command: str, timeout_s: int = 120) -> str:
        # The same policy and broker as the host: a container often bind-mounts the shared checkout the policy protects.
        refusal = shellpolicy.refusal(command, self.shell_grants) or await self.permit("run", command)
        if refusal:
            return refusal
        timeout_s = max(1, min(int(timeout_s or 120), 900))
        runnable, raw = strip_raw(command)
        code, out, err = await self._sh(self.runtime.shell_script, runnable, timeout_s=timeout_s)
        text = out + (("\n[stderr]\n" if out else "[stderr]\n") + err if err else "")
        # No per-project filter file and no fix rules: both read this host's tree, not the isolate's.
        if not raw:
            text = filter_output(runnable, text, None)
        return f"exit={code}\n{text}" if text else f"exit={code} (no output)"

    async def t_bash_start(self, command: str, stdin: bool = False) -> str:
        # Killing a local `docker exec` or ssh client does not reliably kill what it started in the isolate, so a
        # background job there could outlive its task. Refused until that kill can be guaranteed.
        raise NotImplementedError(f"background jobs are host-only; in runtime {self.runtime.spec} use bash with a timeout_s")
