"""Background shell jobs for the `api` backend: start a command, keep working, read it later.

The bash tool blocks the worker's turn until the command ends (up to 900 s) and hands back every
byte, spinner frames and colour codes included. A build, a test watcher or a dev server wants the
opposite: start it, get a job id, then wait with a bound, read a window of its output, feed it a
line, or kill it. Output is sanitized as it streams (ANSI escapes dropped, a carriage-return
progress line collapsed to its last frame) and kept as decoded text, so every offset is a
character offset and a window can never split a UTF-8 sequence. stdout and stderr are kept both
interleaved and apart, so a machine-readable command's stdout can be read alone.

Idea adapted from dify-agent-runtime's shellctl (tmux jobs, a PTY sanitizer, offset/tail windows);
written fresh here, no code copied.
"""
from __future__ import annotations

import asyncio
import codecs
import re
import time
from pathlib import Path
from typing import Callable

from . import config
from .procgate import ProcSlot
from .procs import contain, contained_spawn_kwargs, kill_tree, release, scrubbed_env, terminate_contained

# A worker that starts jobs in a loop must not fill the process gate by itself.
MAX_JOBS = 4
# Jobs live in this server process, all tasks together; see server_cap().
_LIVE: set["Job"] = set()
# Each stream keeps its newest characters only; offsets stay absolute across the drop.
KEEP_CHARS = 1_000_000
# The most one wait/tail call returns, so a chatty job cannot flood the worker's context.
WINDOW_CHARS = 8_000
MAX_WAIT_S = 600
# After the process exits, how long its pipes may stay open: a grandchild left running in the
# background inherits them, and the job must still read as finished.
_DRAIN_S = 5

# CSI (colours, cursor moves, erase-line), OSC (window titles, hyperlinks) and every other ECMA-48
# escape: ESC, any intermediates, one final byte, so "ESC ( B" (tput sgr0), "ESC 7"/"ESC 8" and
# "ESC ="/"ESC >" are dropped whole instead of stalling the stream and then leaking "(B" or "=".
# The final byte leaves out "[" and "]": a bare "ESC ]" is an OSC still arriving, and matching
# it as complete would release the rest of a split window title as output.
_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-Z\\^-~]")
# C0 controls other than tab, newline and carriage return (a CR is handled per line), plus a stray ESC.
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def server_cap() -> int:
    """How many jobs may run at once across this server: half the machine slots, so short tools keep the rest.

    Jobs skip the per-process semaphore (see JobTable.start), so this is what stops 200 workers from
    each parking MAX_JOBS dev servers on the machine.
    """
    return max(1, config.MACHINE_MAX_PROCS // 2)


class Sanitizer:
    """Bytes in, clean text out, one chunk at a time; a sequence split across chunks is held back."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._held = ""  # an escape sequence or a CR whose meaning depends on the next chunk
        self.partial = ""  # the current unfinished line (a later CR may still redraw it)

    def feed(self, data: bytes, final: bool = False) -> str:
        """The complete lines this chunk finished, cleaned. The unfinished line waits in `partial`."""
        text = self._held + self._decoder.decode(data, final)
        self._held = ""
        if not final:
            cut = text.rfind("\x1b")
            # Hold a possibly unfinished escape, but only a short one: an unterminated OSC must not grow forever.
            if cut != -1 and len(text) - cut < 256 and not _ESCAPE_RE.match(text, cut):
                text, self._held = text[:cut], text[cut:]
            if text.endswith("\r"):
                text, self._held = text[:-1], "\r" + self._held
        text = _CONTROL_RE.sub("", _ESCAPE_RE.sub("", text)).replace("\r\n", "\n")
        lines = (self.partial + text).split("\n")
        self.partial = "" if final else lines.pop()
        if final and lines and lines[-1] == "":
            lines.pop()
        return "".join(_last_frame(line) + "\n" for line in lines)

    def pending(self) -> str:
        """The unfinished line as a terminal would show it now: a progress bar's latest frame."""
        return _last_frame(self.partial)


def _last_frame(line: str) -> str:
    """A carriage return redraws the line: keep what the last redraw left, not every frame."""
    frames = [f for f in line.split("\r") if f]
    return frames[-1] if frames else ""


class Stream:
    """Finished lines with absolute character offsets and a bounded memory, plus the live unfinished line.

    Offsets only ever point into finished text: the unfinished line can still be redrawn, so a
    reader is shown it but its cursor stops in front of it and the next read shows it again, updated.
    """

    def __init__(self, pending: Callable[[], str]) -> None:
        self.text = ""
        self.base = 0  # characters dropped from the front
        self._pending = pending

    def add(self, clean: str) -> None:
        self.text += clean
        if len(self.text) > KEEP_CHARS:
            drop = len(self.text) - KEEP_CHARS
            self.text, self.base = self.text[drop:], self.base + drop

    @property
    def end(self) -> int:
        """The offset just past the last finished line."""
        return self.base + len(self.text)

    def pending(self) -> str:
        return self._pending()


class Job:
    def __init__(self, job_id: str, command: str, proc: asyncio.subprocess.Process, slot: ProcSlot) -> None:
        self.id = job_id
        self.command = command
        self.proc = proc
        self.slot = slot
        self.started = time.monotonic()
        self.ended: float | None = None
        self.killed = False
        self.cleaners = {"stdout": Sanitizer(), "stderr": Sanitizer()}
        out, err = self.cleaners["stdout"], self.cleaners["stderr"]
        self.streams = {
            "stdout": Stream(out.pending),
            "stderr": Stream(err.pending),
            "all": Stream(lambda: "\n".join(p for p in (out.pending(), err.pending()) if p)),
        }
        self.cursor = 0  # where the last job_wait stopped reading the interleaved stream
        self.done = asyncio.Event()
        self._pumps = [asyncio.create_task(self._pump(proc.stdout, "stdout")), asyncio.create_task(self._pump(proc.stderr, "stderr"))]
        self._reaper = asyncio.create_task(self._reap())

    async def _pump(self, reader: asyncio.StreamReader | None, name: str) -> None:
        if reader is None:
            return
        cleaner = self.cleaners[name]
        while True:
            chunk = await reader.read(4096)
            clean = cleaner.feed(chunk, final=not chunk)
            self.streams[name].add(clean)
            # The interleaved stream takes whole lines only, so stdout and stderr never splice mid-line.
            self.streams["all"].add(clean)
            if not chunk:
                return

    async def _reap(self) -> None:
        try:
            await self.proc.wait()
            _, stuck = await asyncio.wait(self._pumps, timeout=_DRAIN_S)
            for pump in stuck:
                pump.cancel()
        finally:
            release(self.proc.pid)
            self.ended = time.monotonic()
            _LIVE.discard(self)
            await self.slot.__aexit__(None, None, None)
            self.done.set()

    def status(self) -> str:
        if self.ended is None:
            return f"running for {time.monotonic() - self.started:.0f}s"
        how = "killed" if self.killed else f"exit={self.proc.returncode}"
        return f"{how} after {self.ended - self.started:.0f}s"

    def kill(self) -> None:
        if self.ended is None and self.proc.returncode is None:
            self.killed = True
            # A contained job ends at once, here on the loop. Only the taskkill fallback runs in a thread:
            # it is synchronous and must not stall the event loop every other worker of the MCP server
            # shares. _reap still sees the exit.
            if not terminate_contained(self.proc.pid):
                asyncio.get_running_loop().run_in_executor(None, kill_tree, self.proc.pid)


class JobTable:
    """The background jobs one worker task owns; every one of them dies with the task."""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._next = 1

    async def start(self, argv: list[str], command: str, cwd: Path, keep_stdin: bool) -> Job:
        running = [j.id for j in self.jobs.values() if j.ended is None]
        if len(running) >= MAX_JOBS:
            raise ValueError(f"{len(running)} jobs already running ({', '.join(running)}); job_wait or job_kill one first")
        if len(_LIVE) >= server_cap():
            raise ValueError(f"{len(_LIVE)} background jobs already running across this hswarm server (cap {server_cap()}); "
                             "job_wait or job_kill one of yours, or use bash for a command that ends")
        # A job holds a machine slot for as long as it lives, but never the per-process semaphore: that
        # one has no timeout, and a job sitting on it would block every bash/grep call until it exits.
        slot = ProcSlot(max_wait_s=60, per_process=False)
        await slot.__aenter__()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, cwd=str(cwd), stdin=asyncio.subprocess.PIPE if keep_stdin else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=scrubbed_env(), **contained_spawn_kwargs(),
            )
            contain(proc.pid)
        except BaseException:
            await slot.__aexit__(None, None, None)
            raise
        job = Job(f"j{self._next}", command, proc, slot)
        _LIVE.add(job)
        self._next += 1
        self.jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(str(job_id or "").strip())
        if job is None:
            raise ValueError(f"no job {job_id!r} in this task (jobs: {', '.join(self.jobs) or 'none started'})")
        return job

    def kill_all(self) -> None:
        for job in self.jobs.values():
            job.kill()


def window(stream: Stream, offset: int | None, lines: int) -> tuple[str, int, int]:
    """(text, start, next_offset) of one read, at most WINDOW_CHARS of finished text.

    With `offset`, the finished text from there (an offset older than what is kept starts at the
    oldest kept). Without it, the last `lines` lines. The unfinished line rides along when the
    window reaches the end, and next_offset never points past finished text.
    """
    if offset is not None:
        start = min(max(int(offset), stream.base), stream.end)
        text = stream.text[start - stream.base : start - stream.base + WINDOW_CHARS]
    else:
        tail = "".join(stream.text.splitlines(keepends=True)[-max(1, int(lines)):])[-WINDOW_CHARS:]
        start, text = stream.end - len(tail), tail
    after = start + len(text)
    if after == stream.end and stream.pending():
        text += stream.pending()
    return text, start, after


def since(stream: Stream, cursor: int) -> tuple[str, int]:
    """Output after `cursor` and the new cursor; when more than a window arrived, the newest window and a note."""
    start = max(cursor, stream.base)
    fresh = stream.text[start - stream.base :]
    if len(fresh) > WINDOW_CHARS:
        fresh = f"... [{len(fresh) - WINDOW_CHARS} chars skipped: job_tail with offset={start} reads them] ...\n" + fresh[-WINDOW_CHARS:]
    return fresh + stream.pending(), stream.end
