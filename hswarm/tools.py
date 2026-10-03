"""Worker tools for the `api` backend, sandboxed to the task's roots.

Every path is resolved and must fall under one of the sandbox roots; a worker cannot read or
write outside the directory it was given; inside them, bash and the write tools also ask the
optional out-of-process permission broker (broker.py) first. A task's `writable` globs narrow what write_file and
edit_file may change inside those roots (the bash tool is not path-guarded). The tool catalogue (presets, schemas) is
toolspecs.py, the subprocess runner is procs.py, the grep engines are grep.py.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

from . import shelljobs
from . import shellpolicy
from .broker import broker_from_env
from .fixrules import suggest
from .fuzzyedit import fuzzy_replace, pick_nearest
from .capability import Capability
from .grep import GREP_LINE_RX, py_grep, relative_hits, rg_lines
from .guard import restore
from .outfilters import filter_output, strip_raw
from .redaction import RESTORE_TOOLS, Redactor, restore as restore_tags
from . import config, receipts
from .procs import CREATE_NO_WINDOW, TIMEOUT_EXIT, find_bash, kill_tree, run_hidden, scrubbed_env  # noqa: F401 - re-exported
from .survival import MAX_BYTES, read_text
from .outline import LANGS, language_of, render_outline, render_unfold
from .outline import MAX_BYTES as OUTLINE_MAX_BYTES
from .toolhooks import ToolHooks
from .toolspecs import IGNORED_DIRS, PRESETS, SPECS, specs_for  # noqa: F401 - re-exported for callers and tests
from .web import WebSession

ENVELOPE_VAR = "HSWARM_ENVELOPE"  # envelope.ENV_VAR, spelled here so the sandbox stays free of the ledger's imports

# Older call sites and tests use the private names; keep them as aliases.
_run = run_hidden
_kill_tree = kill_tree


# A worker could read and send the live keys: <home>/secrets/<provider>_api_keys (config.SECRETS_DIR), the user's
# providers/*.toml (config.PROVIDERS_DIR), and any checkout's .secrets/ folder. No
# capability, grant or preset lifts this deny (idea from CopilotKit/OpenBot .github/workflows/ci.yml:556-570 and
# CopilotKit/OpenTag agent/coding/sandbox.py:114, MIT, 2026-10-03).
def is_key_path(path: Path) -> bool:
    """Whether a resolved path is a `.secrets` component (casefolded) or inside the user's secrets or providers folder."""
    if any(part.casefold() == ".secrets" for part in path.parts):
        return True
    for folder in (config.SECRETS_DIR, config.PROVIDERS_DIR):
        try:
            held = folder.resolve()
        except OSError:
            continue
        if path == held or held in path.parents:
            return True
    return False


# A worker's shell runs in the CALLER'S working tree, and on a shared checkout other sessions commit
# straight off disk. On 2026-09-21 a worker told to write one fixture ran `git checkout <base> -- <detector>`
# "to test the old bytes": the stale detector sat in the tree AND the index until the orchestrator
# noticed, one peer sweep away from being landed. That gate was one regex, which `env git stash`,
# `find . -exec git checkout ...` or `sh -c '...'` walked past; the policy is now shellpolicy.py over
# the rules in shell_rules.toml, applied to every command the line would run. A task that genuinely owns
# the checkout opts back in with HSWARM_ALLOW_GIT_WRITES=1, or with a per-task `shell_grants` prefix.
def git_write_refusal(command: str) -> str | None:
    """The refusal text for a shell command the worker shell policy forbids, or None when it is allowed."""
    return shellpolicy.refusal(command)


# A worker told "make this test pass" whose roots cover the test can pass by editing the test. A task's
# `writable` globs freeze everything else: the worker still READS the judge (tests, fixtures, the metric)
# but write_file/edit_file refuse any resolved path no glob covers. Idea from karpathy/autoresearch,
# where the agent may edit only train.py and the file holding the metric is read-only.
def _glob_regex(pattern: str) -> re.Pattern:
    """One absolute posix glob as a regex: `**/` spans zero or more folders, `*` and `?` stay inside one,
    and a glob that names a folder also covers everything under it."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"(?:/.*)?\Z", re.IGNORECASE if os.name == "nt" else 0)


def writable_rule(pattern: str, cwd: Path) -> re.Pattern:
    """A writable glob anchored where it lands: its literal head is resolved against cwd (so `..`, symlinks
    and a relative or absolute spelling are judged by the real folder), the wildcard tail is kept as written."""
    parts = Path(str(pattern).replace("\\", "/")).parts
    cut = next((i for i, part in enumerate(parts) if any(ch in part for ch in "*?")), len(parts))
    head = Path(*parts[:cut])
    head = (head if head.is_absolute() else cwd / head).resolve()
    tail = "/".join(parts[cut:])
    return _glob_regex(head.as_posix().rstrip("/") + ("/" + tail if tail else ""))


def fix_note(command: str, output: str, cwd: str | os.PathLike) -> str:
    """The best rule-made retry for a failed bash call, as a line to append, or "" when no rule fits.

    WHY: a worker otherwise spends a whole model turn working out a retry a rule already knows.
    A fix the shell policy would refuse is never offered: it would only fail again.
    """
    fix = next((f for f in suggest(command, output, cwd) if git_write_refusal(f.command) is None), None)
    return f"\n[likely fix] {fix.command}\n(rule {fix.rule}: check it matches what you meant, then run it)" if fix else ""



def spill(text: str, spill_dir: Path | None) -> str | None:
    """Write `text` to the spill directory and return its handle, or None when there is no directory or the write fails.

    WHY: a capped output used to lose its middle for good, so a worker that needed the one error line in the gap had to
    re-run the command. The handle is the content hash, so the same output always gets the same handle and the same
    preview bytes, which keeps the provider's prompt cache warm across turns and tasks. The file holds _spilled(text),
    and the handle is the hash of that, so a file is always read in the coordinates its marker was written in."""
    if spill_dir is None:
        return None
    data = _spilled(text).encode("utf-8", "replace")
    handle = hashlib.sha256(data).hexdigest()[:16]
    try:
        spill_dir.mkdir(parents=True, exist_ok=True)
        path = spill_dir / f"{handle}.txt"
        if path.exists():
            os.utime(path)  # retention counts from the last use: a task still paging this output keeps it
        else:
            path.write_bytes(data)
    except OSError:
        return None  # a failed spill falls back to the lossy preview, never to a failed tool call
    return handle


def _spilled(text: str) -> str:
    """`text` as the spill file holds it: whole up to config.SPILL_MAX_BYTES, else its first and last windows around a
    note naming the span that was not kept. fetch_output offsets are positions in THIS text."""
    data = text.encode("utf-8", "replace")
    if len(data) <= config.SPILL_MAX_BYTES:
        return text
    half = (config.SPILL_MAX_BYTES - 200) // 2  # 200: room for the note, so the file never passes the cap
    head, tail = data[:half].decode("utf-8", "ignore"), data[-half:].decode("utf-8", "ignore")  # ignore: a char cut in half
    return (f"{head}\n... [not kept: chars {len(head)}-{len(text) - len(tail)} of this {len(text)} char output, it was over "
            f"the spill size; narrow the call and run it again to see them] ...\n{tail}")


def _cap(text: str, limit: int, spill_dir: Path | None = None) -> str:
    """Keep the head and the tail of an over-long tool output: both ends carry the useful part. With a spill
    directory the text is kept there too (up to config.SPILL_MAX_BYTES of it), and the marker names the fetch_output
    call that returns the middle, in the spill file's own coordinates."""
    if len(text) <= limit:
        return text
    head = text[: limit * 2 // 3]
    tail = text[-(limit // 3):]
    kept = _spilled(text) if spill_dir else text
    handle = spill(kept, spill_dir)
    # A cap wider than the spill's own windows (a max_output_chars in the hundreds of thousands) has no honest offsets.
    if handle is None or not (kept.startswith(head) and kept.endswith(tail)):
        return f"{head}\n... [{len(text) - limit} chars omitted] ...\n{tail}"
    returns = "returns them" if kept is text else "returns what the spill kept of them (its own note names the rest)"
    return (f"{head}\n... [omitted {len(text) - len(head) - len(tail)} chars of {len(text)}: "
            f"fetch_output(id=\"{handle}\", start={len(head)}, end={len(kept) - len(tail)}) {returns}] ...\n{tail}")


def _to_crlf(text: str) -> str:
    """The same text with LF line endings rewritten as CRLF (CRLF input stays CRLF; bare CR is left alone)."""
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def _file_newline(text: str) -> str | None:
    """The file's line ending when every ending agrees, else None (mixed endings, or no newline at all)."""
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    if crlf and not lf:
        return "\r\n"
    if lf and not crlf:
        return "\n"
    return None
def _hit_path(line: str, cwd: Path) -> Path:
    """The file one raw grep hit (`path:line:text`, as rg or py_grep printed it) came from."""
    m = GREP_LINE_RX.match(line)
    pth = Path(m.group(1) if m else line)
    return (pth if pth.is_absolute() else cwd / pth).resolve()


class Sandbox:
    def __init__(self, cwd: str | os.PathLike, roots: list[str | os.PathLike] | None = None, max_read_bytes: int = 200_000, max_output_chars: int = 30_000,
                 allowed: list[str] | set[str] | None = None, shell_grants: list[str] | None = None,
                 capability: Capability | None = None, web_hosts: list[str] | None = None, spill_dir: str | os.PathLike | None = None,
                 writable: list[str] | None = None, envelope: dict | None = None, read_gate: bool = True,
                 redactor: Redactor | None = None):
        self.cwd = Path(cwd).resolve()
        # The tools this sandbox will run, or None for every t_ method. A worker's sandbox gets exactly the specs
        # it was offered: a model talked into calling a tool outside its preset (write_file under `propose`) is
        # refused here, not trusted to have been shown only the safe specs.
        self.allowed = None if allowed is None else set(allowed)
        self.shell_grants = [shellpolicy.parse_grant(g) for g in (shell_grants or [])]
        # The task's spawn envelope: bash hands THIS on (never the process's own), so a hswarm the shell starts is
        # admitted one level deeper in the task's tree, the way cc_env does it for a cc worker.
        self.envelope = envelope
        self.roots = [self.cwd] + [Path(r).resolve() for r in (roots or [])]
        # None: every path under the roots is writable (the old behaviour). A list, even an empty one, is the whole writable set.
        self.writable = None if writable is None else list(writable)
        self._writable_rules = [writable_rule(g, self.cwd) for g in (self.writable or [])]
        self.max_read_bytes = max_read_bytes
        self.max_output_chars = max_output_chars
        # The grant (capability.py). None keeps the old behaviour for direct callers: every tool, anywhere under the roots.
        self.capability = capability
        # Outside the roots on purpose: a spill file in the caller's tree would be one more file a peer session commits.
        self.spill_dir = Path(spill_dir) if spill_dir else None
        self.files_changed: list[str] = []
        # Each changed file as it was before this worker's first write (None: it created the file), so the
        # edit-survival pass (survival.py) can tell later whether the edit was kept, reworked or rolled back.
        self.originals: dict[str, str | None | bool] = {}
        # Every file read_file opened, resolved: a review's coverage receipt is checked against it (review.unread_gap),
        # so a worker cannot list a path from its prompt that it never looked at.
        self.files_read: set[Path] = set()
        self._read_marks: dict[Path, str] = {}  # path -> sha256 of the version this worker last read or wrote
        # False only for a caller that is not a worker writing from what it saw: proposals.review_task applies a
        # change the judge already passed, from a fresh Sandbox that has read nothing.
        self.read_gate = read_gate
        self.tool_calls = 0
        self.proposals: list[dict] = []  # the `propose` tool's queue: changes asked for, never made here
        self.jobs = shelljobs.JobTable()
        self.web = WebSession(list(web_hosts or []))  # read_url's host gate: the batch allowlist and the approvals it asked for
        self.receipts: list[dict] = []  # r1..rN, one per call in call order
        # PII/secret redaction of every tool output before it reaches the provider (redaction.py); None sends it as read.
        self.redactor = redactor

    def spill(self, text: str) -> str | None:
        """Keep `text` where fetch_output can return it; the handle, or None with no spill directory."""
        return spill(text, self.spill_dir)

    def resolve(self, p: str | os.PathLike | None, must_exist: bool = False, tool: str | None = None) -> Path:
        raw = Path(p) if p not in (None, "", ".") else self.cwd
        path = (raw if raw.is_absolute() else (self.cwd / raw)).resolve()
        # resolve() first, then compare: `..` and symlinks are judged by where they land, not how they are spelled.
        if not any(path == root or root in path.parents for root in self.roots):
            raise PermissionError(f"path {path} is outside the sandbox roots {[str(r) for r in self.roots]}")
        if is_key_path(path):
            raise PermissionError(f"{self.rel(path)}: key files are never readable by a worker")
        if tool and self.capability and not self.capability.permits(tool, path, self.cwd, self.roots):
            raise PermissionError(f"{tool} on {self.rel(path)} is outside capability {self.capability.identifier!r}'s path scope")
        if must_exist and not path.exists():
            raise FileNotFoundError(str(path))
        return path

    def resolve_root(self, p: str | os.PathLike | None, tool: str) -> Path:
        """A directory a walking tool starts from: only a DENIED root is refused, since what it finds is filtered hit by hit."""
        path = self.resolve(p, must_exist=True)
        if self.capability and self.capability.denies(tool, path, self.cwd):
            raise PermissionError(f"{tool} on {self.rel(path)} is denied by capability {self.capability.identifier!r}")
        return path

    def shown(self, tool: str, path: Path) -> bool:
        """Whether one hit of a walking tool (list_dir, glob, grep) may be shown to the worker."""
        if is_key_path(path):
            return False  # skipped silently, the way IGNORED_DIRS entries are
        return self.capability is None or self.capability.permits(tool, path, self.cwd)
    async def permit(self, permission: str, value: str) -> str | None:
        """The refusal text when the permission broker denies this action, or None when it may run.

        The policy lives in a separate process (broker.py) so the code it governs cannot reach it. A deny
        goes back to the model as the tool's answer; a broker that cannot answer raises BrokerUnavailable,
        which run() does not catch, so the worker aborts rather than acting unchecked.
        """
        broker = broker_from_env()
        if broker is None:
            return None
        allowed, reason = await asyncio.to_thread(broker.check, permission, value, str(self.cwd))
        if allowed:
            return None
        return f"ERROR: the permission broker denied {permission} {value!r}: {reason or 'no reason given'}"
    def check_writable(self, path: Path) -> None:
        """Refuse a write to a resolved path outside the task's writable globs; run() reports it as an ERROR string."""
        if self.writable is None or any(rule.match(path.as_posix()) for rule in self._writable_rules):
            return
        raise PermissionError(
            f"refused write to {self.rel(path)} - it is read-only for this task, which may write only {self.writable}. "
            "Read it as often as you like; the files that judge your work are frozen, so change the code under test instead."
        )

    def rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.cwd).as_posix()
        except ValueError:
            return path.as_posix()

    # The operator's Claude Code hooks (toolhooks.py, opt-in via HSWARM_API_HOOKS), set by agent.run_api_task.
    # A class default rather than an __init__ argument: None keeps every other caller's sandbox exactly as it was.
    hooks: ToolHooks | None = None

    def unredact(self, name: str, args: dict) -> tuple[dict, str | None]:
        """The call's arguments with hash tags mapped back to their real values, and the refusal text when a write
        would persist a placeholder that cannot be mapped back (redact/mask), else None. Restores even with no
        redactor on this leg: a failover leg inherits tags an earlier, redacting leg put in the transcript."""
        if name in RESTORE_TOOLS:
            args = {k: restore_tags(v) if isinstance(v, str) else v for k, v in args.items()}
        if self.redactor is None:
            return args, None
        if name in ("write_file", "edit_file"):
            stuck = self.redactor.unrestorable(str(args.get("content") or "") + str(args.get("new_string") or ""))
            if stuck:
                return args, (f"ERROR: refused {name} - the text carries the redaction placeholder {stuck}, which cannot be mapped "
                              "back to the original, so the file would lose the real value. Edit around it, leaving that span untouched.")
        return args, None

    def redacted(self, name: str, out: str) -> str:
        """`out` with every detected span rewritten, or the block strategy's refusal. Runs BEFORE the cap, so a
        span the cap cuts in half cannot slip through as an unmatched fragment, and the spill file holds no originals.
        Also scrubs exact-value API keys that may have been read from ~/.hswarm/secrets/ or ~/.hswarm/providers/."""
        if self.redactor is None:
            result = out
        else:
            result = self.redactor.scrub(out, f"output of {name}")
        # Always scrub exact-value keys, even if redaction is off (layer 3 defense)
        from .redaction import scrub_keys
        return scrub_keys(result)

    async def run(self, name: str, args: dict) -> str:
        """Dispatch one tool call by name; every failure becomes an ERROR string the model can read."""
        return (await self.run_receipted(name, args))[1]

    async def run_receipted(self, name: str, args: dict) -> tuple[dict, str]:
        """run(), stamped on the receipt ledger (receipts.py): the worker's claims are checked against it."""
        rec = receipts.open_receipt(self.receipts, name, args)
        out = await self._dispatch(name, args)
        receipts.close_receipt(rec, out)
        return rec, out

    async def _dispatch(self, name: str, args: dict) -> str:
        self.tool_calls += 1
        if self.allowed is not None and name not in self.allowed:
            return f"ERROR: tool {name} is not in this task's preset (allowed: {', '.join(sorted(self.allowed)) or 'none'})"
        fn = getattr(self, "t_" + name, None)
        if fn is None:
            return f"ERROR: unknown tool {name}"
        # Tool output reaches the model with frame markers escaped (guard.neutralize); text it copies back
        # into a call is un-escaped here, so a write or an edit carries the bytes it read.
        args = {k: restore(v) if isinstance(v, str) else v for k, v in (args or {}).items()}
        args, refusal = self.unredact(name, args)
        if refusal:
            return refusal
        # A model can name a tool it was never offered (some providers pass that through); the grant, not the menu, decides.
        # fetch_output only pages back this worker's own spilled output, so every grant carries it (agent.run_api_task).
        if self.capability and name != "fetch_output" and not self.capability.grants(name):
            return f"ERROR: tool {name} is not granted by capability {self.capability.identifier!r} (granted: {', '.join(self.capability.tools) or 'none'})"
        if self.hooks is not None:
            refusal = await self._pre_hooks(name, args)
            if refusal:
                return self.redacted(name, refusal)
        try:
            out = await fn(**args)
        except TypeError as e:
            return f"ERROR: bad arguments for {name}: {e}"
        except (PermissionError, FileNotFoundError, IsADirectoryError, UnicodeDecodeError, ValueError, OSError, NotImplementedError) as e:
            # NotImplementedError: pathlib's answer to a pattern shape it cannot glob; it used to kill the whole task.
            return f"ERROR: {type(e).__name__}: {e}"
        text = _cap(self.redacted(name, out if isinstance(out, str) else str(out)), self.max_output_chars, self.spill_dir)
        # Hook text reaches the model too, so it is scrubbed like the tool output it follows.
        return text if self.hooks is None else text + self.redacted(name, await self._post_hooks(name, args, text))

    # A guard that cannot judge a call (a bad argument, a malformed hook entry) refuses it as an ERROR the model can
    # retry: it must neither let the call through unchecked nor raise out of run_tools and kill the whole task.
    async def _pre_hooks(self, name: str, args: dict) -> str | None:
        """The PreToolUse refusal for this call as its ERROR output, or None when the hooks let it run."""
        try:
            refusal = await self.hooks.pre(name, args)
        except Exception as e:  # noqa: BLE001 - see above
            refusal = f"the hooks could not check this call: {type(e).__name__}: {e}"
        return f"ERROR: a PreToolUse hook refused {name}: {refusal}" + self.hooks.take_errors() if refusal else None

    async def _post_hooks(self, name: str, args: dict, text: str) -> str:
        """PostToolUse feedback and any hook failures, to append to a tool output that already ran."""
        try:
            notes = await self.hooks.post(name, args, text)
        except Exception as e:  # noqa: BLE001 - the tool has run; a failed hook is a note, never a lost output
            notes = f"\n\n[PostToolUse hook] error: {type(e).__name__}: {e}"
        return notes + self.hooks.take_errors()

    # ---- files ---------------------------------------------------------------

    # Read-before-write gate. Many edit-preset workers can share one checkout, and write_file used to overwrite blind: a worker
    # could replace a file it never looked at, or clobber a sibling's (or the user's) edit made after its
    # own read. Each read_file stamps the sha256 of the bytes the worker was shown; write_file on an
    # existing file needs a stamp, and write_file / edit_file refuse when the file no longer hashes to it,
    # so a silent lost update becomes an ERROR the worker fixes by reading again. A new file needs no read,
    # and every write_file / edit_file re-stamps, so a file this worker created or already changed never
    # needs one either. Check and write run with no await between them (after the broker's permit), so
    # two workers in this process cannot interleave there; the gate fails open when it cannot hash the file.

    def _mark(self, p: Path, data: bytes) -> None:
        self._read_marks[p] = hashlib.sha256(data).hexdigest()

    def _check_fresh(self, p: Path, need_read: bool, data: bytes | None = None) -> bool:
        """Raise when p changed since this worker read it (or, with need_read, was never read); True if a mark exists."""
        if not self.read_gate:
            return False
        mark = self._read_marks.get(p)
        if mark is None:
            if need_read:
                raise ValueError(f"{self.rel(p)} already exists and you have not read it; read_file it first, then write")
            return False
        try:
            current = hashlib.sha256(p.read_bytes() if data is None else data).hexdigest()
        except OSError:
            return True
        if current != mark:
            raise ValueError(
                f"{self.rel(p)} changed since you read it or last wrote it with write_file/edit_file "
                "(on disk: a bash command, another worker or the user); "
                "read_file it again and redo your change against what is there now"
            )
        return True

    # read_file's own page, well under the cap every tool shares: a read rides every later turn of the leg. Measured
    # 2026-10-02 (outs2.py): read_file was 55% of the tool chars re-sent, 54% of reads named no range, 8,447 were 10k+
    # chars. A page ends on a line and names the call that reads on; the shared cap's head and tail would hide the
    # middle of a 12-30k source file from a reviewer. At most 28% of read_file chars saved, less what is paged back.
    READ_PAGE_CHARS = 12_000

    async def t_read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> str:
        p = self.resolve(path, must_exist=True, tool="read_file")
        if p.is_dir():
            raise IsADirectoryError(str(p))
        # A big file read whole would blow the worker's context; force a slice instead of silently truncating.
        if p.stat().st_size > self.max_read_bytes and not (start_line or end_line):
            raise ValueError(f"file is {p.stat().st_size} bytes; read a slice with start_line/end_line")
        self.files_read.add(p)
        data = p.read_bytes()
        self._mark(p, data)  # a slice counts: a big file can only be read in slices
        return self._read_page(p, data.decode("utf-8", errors="replace").splitlines(), start_line, end_line)

    def _read_page(self, p: Path, lines: list[str], start_line: int | None, end_line: int | None) -> str:
        """Page already-read file lines the same way for local and remote reads."""
        lo = max(1, int(start_line or 1))
        hi = min(len(lines), int(end_line or len(lines)))
        rows: list[str] = []
        used = 0
        for i, text in enumerate(lines[lo - 1 : hi], lo):
            row = f"{i}\t{text}"
            if rows and used + len(row) + 1 > self.READ_PAGE_CHARS:
                break  # never before the first line: a single over-long line still comes back (the shared cap trims it)
            rows.append(row)
            used += len(row) + 1
        body = "\n".join(rows)
        last = lo + len(rows) - 1
        if rows and last < hi:
            rest = f"start_line={last + 1}" + (f", end_line={hi}" if end_line else "")
            # outline only where this worker has it and it knows the language: a hint that errors costs a turn.
            hint = "; run outline first on a large file" if (self.allowed is None or "outline" in self.allowed) and language_of(p) else ""
            body += f"\n... [lines {lo}-{last} of {len(lines)} shown; continues: read_file(path=\"{self.rel(p)}\", {rest}){hint}]"
        return body if body else f"(empty; file has {len(lines)} lines)"

    def _remember(self, p: Path) -> None:
        """Keep the pre-task text of `p` once, before the first write touches it (False: not readable as text)."""
        key = str(p)
        if key not in self.originals:
            text = read_text(p) if p.exists() else None
            self.originals[key] = None if not p.exists() else (text if text is not None else False)

    # newline="" on every read and write below: Python's default universal-newline mode rewrites "\n"
    # as os.linesep on write, so on Windows a worker's LF edit came back CRLF - measured 2026-09-18,
    # 12 of 12 files a swarm touched in an LF repo landed with every line ending flipped, which is a
    # whole-file diff and a prettier failure over a one-line change. With newline="" the bytes the
    # worker sees are the bytes on disk, and the bytes it writes are the bytes it wrote.
    async def t_write_file(self, path: str, content: str) -> str:
        p = self.resolve(path, tool="write_file")
        self.check_writable(p)
        refusal = await self.permit("write", str(p))
        if refusal:
            return refusal
        if p.is_file():
            self._check_fresh(p, need_read=True)
        self._remember(p)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8", newline="")
        self._mark(p, content.encode("utf-8"))
        self.files_changed.append(self.rel(p))
        return f"wrote {len(content)} chars to {self.rel(p)}"

    async def t_edit_file(self, path: str, old_string: str, new_string: str, replace_all: bool = False, near_line: int | None = None) -> str:
        p = self.resolve(path, must_exist=True, tool="edit_file")
        self.check_writable(p)
        refusal = await self.permit("write", str(p))
        if refusal:
            return refusal
        data = p.read_bytes()
        # An exact old_string is its own proof of the bytes it replaces, so an unread file may take one;
        # a file read or written earlier must still be that version. Only a file the worker has actually
        # read gets the near match below: an exact edit shows it one span, not the file.
        self._check_fresh(p, need_read=False, data=data)
        was_read = p in self.files_read
        text = data.decode("utf-8")
        self.originals.setdefault(str(p), text if len(text.encode("utf-8")) <= MAX_BYTES else False)
        n = text.count(old_string)
        old = old_string
        if n == 0 and "\n" in old_string:
            # read_file reports LF whatever the file holds, so an old_string copied out of it could never
            # match a CRLF file and every such edit failed. Retry the same text in CRLF, but only after the
            # literal string matched nothing: an exact hit is never reinterpreted, so a file with mixed
            # endings (or one whose CRLF block the worker quoted exactly) keeps the old byte-exact behaviour.
            normalized = _to_crlf(old_string)
            crlf_n = text.count(normalized) if normalized != old_string else 0
            if crlf_n:
                old, n = normalized, crlf_n
        note = f"{n} replacement{'s' if n != 1 else ''}"
        if n == 0:
            if replace_all or not was_read:
                hint = "" if was_read else "; read_file it first and a near match (indent/whitespace drift) can be located"
                raise ValueError(f"old_string not found in file (match must be exact, including whitespace){hint}")
            # No exact or CRLF hit in a file the worker has read: find the block it meant despite whitespace
            # drift. fuzzy_replace writes the file's own line ending itself.
            new_text, how = fuzzy_replace(text, old_string, new_string, int(near_line) if near_line else None)
            note = f"1 replacement, {how}"
        else:
            if old != old_string or _file_newline(text) == "\r\n":
                # The match sits in CRLF text (or the whole file is uniformly CRLF) and the replacement came out
                # of read_file as LF: insert CRLF so a multiline replacement does not leave lone LFs behind. This
                # also covers replacing one CRLF line with several. An LF file is written back byte for byte.
                new_string = _to_crlf(new_string)
            if n > 1 and not replace_all:
                # An ambiguous match would silently edit the wrong site; near_line may name the one meant.
                starts = [m.start() for m in re.finditer(re.escape(old), text)]
                at_lines = [text.count("\n", 0, at) + 1 for at in starts]
                chosen = pick_nearest(at_lines, int(near_line) if near_line else None)
                if chosen is None or not old:
                    raise ValueError(f"old_string occurs {n} times; include more context to make it unique, pass near_line, or set replace_all")
                at = starts[chosen]
                new_text = text[:at] + new_string + text[at + len(old):]
                note = f"1 replacement, the occurrence at line {at_lines[chosen]} nearest near_line"
            else:
                new_text = text.replace(old, new_string, -1 if replace_all else 1)
        p.write_text(new_text, encoding="utf-8", newline="")
        self._mark(p, new_text.encode("utf-8"))  # its own edit: a later write_file here needs no read first
        self.files_changed.append(self.rel(p))
        return f"edited {self.rel(p)} ({note})"

    async def t_list_dir(self, path: str = ".", depth: int = 1) -> str:
        root = self.resolve_root(path, "list_dir")
        depth = max(1, min(int(depth or 1), 3))
        out: list[str] = []

        def walk(d: Path, level: int) -> None:
            try:
                entries = sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
            except PermissionError:
                return
            for e in entries:
                # A denied entry is hidden and never walked; .secrets entries are also skipped silently.
                if e.name in IGNORED_DIRS or (self.capability and self.capability.denies("list_dir", e, self.cwd)) or not self.shown("list_dir", e):
                    continue
                out.append(f"{'  ' * (level - 1)}{e.name}{'/' if e.is_dir() else ''}")
                if e.is_dir() and level < depth:
                    walk(e, level + 1)
                if len(out) > 2000:
                    return

        walk(root, 1)
        return "\n".join(out) or "(empty)"

    async def t_glob(self, pattern: str, path: str = ".") -> str:
        if Path(pattern).is_absolute():
            # pathlib refuses an absolute glob ("Non-relative patterns are unsupported"); workers write them all the time.
            # Split at the first wildcard: the literal head is the root (sandbox-checked), the rest globs under it.
            parts = Path(pattern).parts
            cut = next((i for i, part in enumerate(parts) if any(ch in part for ch in "*?[")), len(parts))
            path, pattern = str(Path(*parts[:cut])), "/".join(parts[cut:]) or "*"
        root = self.resolve_root(path, "glob")
        hits = []
        for p in root.glob(pattern):
            if any(part in IGNORED_DIRS for part in p.relative_to(root).parts[:-1]) or not p.is_file() or not self.shown("glob", p):
                continue
            try:
                hits.append((p.stat().st_mtime, p))
            except OSError:
                pass
            if len(hits) > 5000:
                break
        hits.sort(key=lambda t: -t[0])  # newest first: the file just edited is usually the one wanted
        return "\n".join(self.rel(p) for _, p in hits[:500]) or "(no matches)"

    MAX_PROPOSALS = 50

    async def t_propose(self, kind: str, path: str, reason: str, content: str | None = None, old_string: str | None = None,
                        new_string: str | None = None, replace_all: bool = False) -> str:
        """Queue a change instead of making it. Checked now with the same rules the apply step uses (inside the
        roots, an edit's old_string present and unique), so a bad proposal is fixed by the worker while it still
        has the file open, not refused later."""
        if len(self.proposals) >= self.MAX_PROPOSALS:
            raise ValueError(f"proposal limit reached ({self.MAX_PROPOSALS}); finish with what is queued")
        p = self.resolve(path)
        item: dict = {"n": len(self.proposals) + 1, "kind": kind, "path": self.rel(p), "reason": str(reason or "").strip()}
        if kind == "write_file":
            if content is None:
                raise ValueError("kind write_file needs content")
            item["content"] = content
        elif kind == "edit_file":
            if old_string is None or new_string is None:
                raise ValueError("kind edit_file needs old_string and new_string")
            with self.resolve(path, must_exist=True).open(encoding="utf-8", newline="") as f:  # read_text(newline=) is 3.13+
                text = f.read()
            n = text.count(old_string)
            if n == 0:
                raise ValueError("old_string not found in file (match must be exact, including whitespace)")
            if n > 1 and not replace_all:
                raise ValueError(f"old_string occurs {n} times; include more context to make it unique or set replace_all")
            item.update(old_string=old_string, new_string=new_string, replace_all=bool(replace_all))
        else:
            raise ValueError("kind must be write_file or edit_file")
        self.proposals.append(item)
        return f"queued proposal {item['n']}: {kind} {item['path']} - NOT applied; it is screened and applied after the task"
    async def t_fetch_output(self, id: str, start: int = 0, end: int | None = None) -> str:  # noqa: A002 - the name the model sees
        """A char range of a spilled output (a capped tool result or a cleared stale one), never more than the cap."""
        handle = str(id or "").strip().strip('"')
        if self.spill_dir is None or not re.fullmatch(r"[0-9a-f]{16}", handle):
            raise ValueError(f"no spilled output {handle!r}; use the id from an 'omitted' or 'cleared' marker")
        path = self.spill_dir / f"{handle}.txt"
        if not path.is_file():
            raise FileNotFoundError(f"spilled output {handle} is gone (kept {config.SPILL_RETENTION_S // 3600} h); run the call again")
        with path.open(encoding="utf-8", errors="replace", newline="") as f:  # read_text(newline=) is 3.13+
            text = f.read()
        lo = max(0, min(int(start or 0), len(text)))
        hi = len(text) if end is None else max(lo, min(int(end), len(text)))
        # Leave room for the continuation note so _cap never spills a fetch again.
        room = max(1, self.max_output_chars - 200)
        if hi - lo <= room:
            return text[lo:hi] or f"(empty range; the output is {len(text)} chars)"
        return text[lo:lo + room] + f"\n... [continues: fetch_output(id=\"{handle}\", start={lo + room}, end={hi})]"

    # ---- symbols: outline a file, unfold one symbol ------------------------------
    # A worker that reads a 2,000-line file whole to find one function pays for all of it on every
    # later turn; the outline is a few hundred tokens and unfold returns only the lines it wanted.

    def _code_file(self, path: str, tool: str) -> tuple[Path, str, str]:
        # tool= so a capability's path scope binds outline/unfold exactly as it binds read_file. Not added to
        # files_read: a symbol map is not the whole-file read a review's coverage receipt asks for.
        p = self.resolve(path, must_exist=True, tool=tool)
        if p.is_dir():
            raise IsADirectoryError(str(p))
        lang = language_of(p)
        if lang is None:
            known = " ".join(sorted(LANGS))
            raise ValueError(f"no outliner for {p.suffix or p.name!r} files (known: {known}); use grep and read_file slices")
        if p.stat().st_size > OUTLINE_MAX_BYTES:
            raise ValueError(f"file is {p.stat().st_size} bytes, over the {OUTLINE_MAX_BYTES} outline limit; use grep and read_file slices")
        return p, lang, p.read_text(encoding="utf-8", errors="replace")

    async def t_outline(self, path: str) -> str:
        p, lang, text = self._code_file(path, "outline")
        return render_outline(self.rel(p), text, lang)

    async def t_unfold(self, path: str, symbol: str) -> str:
        p, lang, text = self._code_file(path, "unfold")
        return render_unfold(self.rel(p), text, lang, symbol)

    # ---- search and shell -------------------------------------------------------

    async def t_grep(self, pattern: str, path: str = ".", glob: str | None = None, ignore_case: bool = False, max_results: int = 200) -> str:
        root = self.resolve_root(path, "grep")
        max_results = max(1, min(int(max_results or 200), 1000))
        rg = shutil.which("rg")
        lines = await rg_lines(rg, self.cwd, pattern, root, glob, ignore_case) if rg else py_grep(pattern, root, glob, ignore_case, max_results)
        if isinstance(lines, str):
            return lines
        lines = [ln for ln in lines if self.shown("grep", _hit_path(ln, self.cwd))]  # file contents only from allowed paths, never key files
        total = len(lines)
        body = "\n".join(relative_hits(self.rel, lines[:max_results], root)) or "(no matches)"
        if total > max_results:
            body += f"\n... {total - max_results} more matches not shown"
        return body

    async def t_read_url(self, url: str) -> str:
        return await self.web.read(url)
    def bash_env(self) -> dict:
        """This process's environment with its HSWARM_ENVELOPE replaced by the task's. Inheriting it as-is let a
        hswarm started from bash run at the parent's depth (max_depth never advanced) or, at a root job, with no
        envelope at all (outside the tree); the shared server's own belongs to nobody."""
        env = scrubbed_env()  # the child-env scrub first (procs.py): no provider keys, no cloud credentials
        env.pop(ENVELOPE_VAR, None)
        if self.envelope:
            env[ENVELOPE_VAR] = json.dumps(self.envelope, separators=(",", ":"))
        return env

    async def t_bash(self, command: str, timeout_s: int = 120) -> str:
        refusal = shellpolicy.refusal(command, self.shell_grants) or await self.permit("run", command)
        if refusal:
            return refusal
        sh = find_bash()
        if not sh:
            return "ERROR: no working bash found (Git Bash expected on Windows; the WSL stub does not count)"
        timeout_s = max(1, min(int(timeout_s or 120), 900))
        runnable, raw = strip_raw(command)
        # bash_env() starts from procs.scrubbed_env(), so `env` here shows no keys; it only adds the task's envelope.
        code, out, err = await run_hidden([sh, "-lc", runnable], self.cwd, timeout_s, env=self.bash_env())
        text = out + (("\n[stderr]\n" if out else "[stderr]\n") + err if err else "")
        # Filter before run() caps: a known-noisy command loses its noise, not its failures (outfilters.py).
        if not raw:
            text = filter_output(runnable, text, self.cwd)
        result = f"exit={code}\n{text}" if text else f"exit={code} (no output)"
        # A timeout has nothing to correct; any other failure gets the rules' best retry at the tail,
        # which _cap keeps when it trims a long output.
        if code not in (0, TIMEOUT_EXIT) and text:
            result += fix_note(runnable, text, self.cwd)
        return result

    # ---- background jobs (shelljobs.py) -------------------------------------------
    # bash blocks the whole turn and returns raw bytes; these start a command, hand back a job id,
    # and read its sanitized output in bounded windows while the worker keeps going.

    async def t_bash_start(self, command: str, stdin: bool = False) -> str:
        refusal = shellpolicy.refusal(command, self.shell_grants) or await self.permit("run", command)  # the same checks as t_bash
        if refusal:
            return refusal
        sh = find_bash()
        if not sh:
            return "ERROR: no working bash found (Git Bash expected on Windows; the WSL stub does not count)"
        # stdin stays closed unless asked for: an open pipe nobody writes makes some CLIs wait forever.
        job = await self.jobs.start([sh, "-lc", command], command, self.cwd, keep_stdin=bool(stdin))
        return f"job_id={job.id} started. job_wait reads its new output (bounded wait); job_tail reads a window; job_kill stops it."

    async def t_job_wait(self, job_id: str, timeout_s: int = 30) -> str:
        job = self.jobs.get(job_id)
        timeout_s = max(0, min(int(timeout_s if timeout_s is not None else 30), shelljobs.MAX_WAIT_S))
        try:
            await asyncio.wait_for(job.done.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            pass
        fresh, job.cursor = shelljobs.since(job.streams["all"], job.cursor)
        return f"job {job.id}: {job.status()}\n{fresh}" if fresh else f"job {job.id}: {job.status()} (no new output)"

    async def t_job_tail(self, job_id: str, lines: int = 50, offset: int | None = None, stream: str = "all") -> str:
        job = self.jobs.get(job_id)
        if stream not in job.streams:
            raise ValueError(f"stream must be one of {sorted(job.streams)}")
        s = job.streams[stream]
        text, start, after = shelljobs.window(s, offset, lines or 50)
        head = f"job {job.id}: {job.status()}; {stream} chars {start}-{after} of {s.end}"
        if after < s.end:
            head += f"; more from offset={after}"
        return f"{head}\n{text}" if text else f"{head} (empty)"

    async def t_job_input(self, job_id: str, text: str, close: bool = False) -> str:
        job = self.jobs.get(job_id)
        pipe = job.proc.stdin
        if pipe is None:
            raise ValueError(f"job {job.id} was started without stdin; start it with stdin=true to send input")
        if job.ended is not None or pipe.is_closing():
            raise ValueError(f"job {job.id} no longer takes input ({job.status()})")
        pipe.write(text.encode("utf-8"))
        await pipe.drain()
        if close:
            pipe.close()
        return f"sent {len(text)} chars to job {job.id}" + (" and closed its stdin" if close else "")

    async def t_job_kill(self, job_id: str) -> str:
        job = self.jobs.get(job_id)
        job.kill()
        try:
            await asyncio.wait_for(job.done.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass
        return f"job {job.id}: {job.status()}"

    def close(self) -> None:
        """Kill every background job still running: none may outlive the task that started it."""
        self.jobs.kill_all()


def open_sandbox(runtime: str | None, cwd: str | os.PathLike, **kwargs) -> Sandbox:
    """The sandbox a task's tools run in: this host by default, or the container / ssh host its `runtime` names.

    WHY: Sandbox confines paths, but its bash is this machine's shell. A runtime (runtimes.py) runs every tool
    inside an isolate instead, behind the same tool specs, so a worker on an untrusted repo gets real isolation."""
    from .runtimes import parse_runtime

    rt = parse_runtime(runtime)
    if rt is None:
        return Sandbox(cwd, **kwargs)
    from .remote_tools import RemoteSandbox  # remote_tools subclasses Sandbox, so it imports this module

    return RemoteSandbox(rt, cwd, **kwargs)
