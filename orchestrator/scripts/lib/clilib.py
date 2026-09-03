"""clilib - HOW A SCRIPT RUNS: the entry-point rituals every runnable script shares.

Three of them:

  use_utf8_console()  what a script does to its OWN stdout before it prints anything
  run_text()          how a script reads ANOTHER PROGRAM's output without losing it
  capture()           what a script does to run ANOTHER script's main() as a step

Every act script is a CLI first (the --help/Usage/Exit contract), so when a lane script
(sweep, reconcile, interview, chats --move, audit --restore, the drill) executes one as a
step, it calls capture(): the child's printed report becomes data, its exit code the
verdict, and the child never learns it was not run from a terminal. This was the same six
lines pasted into seven scripts until the 2026-08-31 standardization pass.

Deliberately tiny: exit-code -> outcome WORDING stays with each caller, because those words
are per-act vocabulary the tests pin ("restored-and-verified" is an audit word, "landed and
verified" a migrate word) - sharing the mechanism, not the message.
"""

from __future__ import annotations

import contextlib
import io
import subprocess
import sys
import traceback


def use_utf8_console() -> None:
    """Make stdout/stderr encode UTF-8 with errors="replace". Call it FIRST in main().

    THE BUG THIS EXISTS FOR (2026-09-02). On Windows, Python only gives stdout the console's
    UTF-8-capable encoding when stdout IS a console. The moment output is piped or redirected
    - `orch.py --help | cat`, or `call :main >> log`, which is how EVERY scheduled task in
    schedule_jobs.py runs - stdout falls back to the cp1252 locale codec. cp1252 cannot encode
    the no-entry sign, the checkmark, the cross or the warning triangle this repo uses to mark
    hard rules, so printing a docstring that carries one raises UnicodeEncodeError and kills
    the process. 14 module docstrings carry such a glyph, so `--help` - the one command that is
    supposed to work everywhere, offline, touching nothing - died down a pipe.

    THE CALL SITE IS main(), NOT IMPORT TIME, and that is the whole point. lib/__init__.py has
    reconfigured on import since 2026-09-01, which covers a script that says `from lib import
    ...` at module level and silently covers NOTHING else: orch.py imports lib only lazily
    inside its subcommands, so the driver - the toolbox's front door - crashed on its own
    --help for a day while the guard was believed to be repo-wide. main() is the one place
    every runnable script genuinely reaches, however it was started and whatever it imports.

    errors="replace" is the belt: an unmappable character degrades to a marker instead of
    taking the run down with it. Do NOT "fix" this by deleting glyphs from the docstrings -
    they are the repo's house style for hard rules, and the crash returns with the next one.

    Idempotent and never fatal. A stream with no codec at all (io.StringIO, which is what
    capture() above hands a child, and what a redirect_stdout test uses) has no reconfigure()
    and needs none - it accepts any character already.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass  # already wrapped, or not reconfigurable - never fatal


def _oem_encoding() -> str:
    """The codec a Windows CONSOLE child writes its output in - the OEM code page.

    Asked of the OS rather than of this process's locale, because the two disagree exactly
    where it matters: `locale.getpreferredencoding()` here is cp1252 (ANSI) or, under UTF-8
    mode, utf-8, while a console child writes cp437 (OEM). Falls back to the locale answer
    off Windows or if the call is unavailable."""
    try:
        import ctypes

        cp = int(ctypes.windll.kernel32.GetOEMCP())  # type: ignore[attr-defined]
        if cp:
            return f"cp{cp}"
    except Exception:  # noqa: BLE001 - not Windows, or no ctypes: the locale answer will do
        pass
    import locale

    return locale.getpreferredencoding(False) or "utf-8"


def decode_console(raw: bytes | None) -> str:
    """A console child's bytes as text, by a route that CANNOT raise and CANNOT mangle.

    UTF-8 first and strict, because pwsh 7 and every program we write emit UTF-8 and getting
    that right matters more than being lenient; on failure, the OEM code page with
    errors='replace', which is what Windows PowerShell 5.1 and the built-in console tools
    (schtasks, tasklist, taskkill) actually write. Either way a byte we cannot name becomes a
    marker, never an exception."""
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode(_oem_encoding(), errors="replace")


def run_text(args, **kwargs) -> subprocess.CompletedProcess:
    """subprocess.run(capture_output=True) whose output can never be lost to a codec.

    ⛔ USE THIS, NEVER `text=True`, FOR ANY WINDOWS PROGRAM (2026-09-03). `text=True` decodes
    with `locale.getpreferredencoding(False)`, and this toolbox runs under two different
    answers to that question:

      - from a terminal it is cp1252, which maps nearly every byte, so a PowerShell actuator's
        cp437 output silently becomes MOJIBAKE rather than failing;
      - under the DAEMON - which is how every scheduled lane and every MCP call runs these
        scripts - server/src/orchestrator.ts spawns python with PYTHONUTF8=1, so it is utf-8,
        and the first non-ASCII byte raises UnicodeDecodeError *inside subprocess's reader
        thread*. Python prints that traceback and hands the caller EMPTY OUTPUT.

    The second is the dangerous one and it was live: audit_twins lost three actuator replies
    that way, and this repo's own rule 4 is "never claim an act landed without checking" -
    every one of those checks reads `r.stdout`, so a blanked read is a verdict computed from
    nothing. Bytes are captured and decoded here instead, by decode_console.
    """
    kwargs.pop("text", None)
    kwargs.pop("encoding", None)
    kwargs.pop("errors", None)
    kwargs["capture_output"] = True
    r = subprocess.run(args, **kwargs)  # noqa: S603 - callers pass an argv list, never a shell
    return subprocess.CompletedProcess(
        r.args, r.returncode, decode_console(r.stdout), decode_console(r.stderr)
    )


def capture(fn, argv: list[str]) -> tuple[int, str]:
    """Run a script's main(argv) with stdout captured; return (exit code, stripped output).

    Exception-safe on purpose: this is the ONE chokepoint every lane script (reconcile.retry,
    audit_archived.restore, name_chats.name_pass, saturate.execute, ...) calls to run a step,
    so a bug in one child's main() must not take down the caller's whole sweep - one bad row
    stops that row, not the loop it is in. An unhandled exception is reported exactly like a
    failing exit code: nonzero, with the reason in the message, never propagated.
    """
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = fn(argv)
    except Exception as err:  # noqa: BLE001 - deliberately broad, see docstring
        tail = traceback.format_exc().strip().splitlines()[-1]
        who = f"{getattr(fn, '__module__', '?')}.{getattr(fn, '__name__', repr(fn))}"
        return 1, f"unhandled exception in {who}: {err} ({tail})"
    return code, buf.getvalue().strip()
