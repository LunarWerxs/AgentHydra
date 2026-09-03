"""clilib - HOW A SCRIPT RUNS: the entry-point rituals every runnable script shares.

Two of them, and only two:

  use_utf8_console()  what a script does to its OWN stdout before it prints anything
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
