"""clilib.run_text - a console child's output must survive the trip, or the verdict is a lie.

THE BUG (found live 2026-09-03, running audit_twins through the daemon). Every actuator call in
this toolbox used `subprocess.run(..., text=True)`, which decodes with
`locale.getpreferredencoding(False)` - and this toolbox runs under two different answers:

  - from a terminal that is cp1252, which maps nearly every byte, so a PowerShell actuator's
    cp437 output silently became MOJIBAKE;
  - under the DAEMON, which is how every scheduled lane and every MCP call runs these scripts,
    server/src/orchestrator.ts spawns python with PYTHONUTF8=1, so it is utf-8, and the first
    non-ASCII byte raised UnicodeDecodeError INSIDE subprocess's reader thread. Python printed
    the traceback and handed the caller EMPTY OUTPUT.

The second is the dangerous one: this repo's rule 4 is "never claim an act landed without
checking", every one of those checks reads r.stdout, and a blanked read is a verdict computed
from nothing. audit_twins lost three actuator replies that way in one run.

These tests drive REAL child processes emitting REAL non-UTF-8 bytes under a REAL UTF-8-mode
environment - the conditions the bug needs. Asserting on a mocked subprocess would have passed
against the broken code, which is the whole reason the bug lived: nothing ever raised where a
person could see it.
"""

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import clilib  # noqa: E402

# 0xFA is the byte that took audit_twins down: a middle dot in cp437, undecodable as UTF-8.
OEM_BYTES = b"archived \xfa done"
# A child that writes raw bytes to stdout, bypassing any text-layer encoding of its own.
EMIT = "import sys; sys.stdout.buffer.write({!r}); sys.stdout.buffer.flush()"


def emit(raw: bytes, code: int = 0) -> list[str]:
    return [sys.executable, "-c", EMIT.format(raw) + f"; sys.exit({code})"]


class RunTextTest(unittest.TestCase):
    def test_non_utf8_output_survives_instead_of_blanking_the_caller(self):
        # THE REGRESSION. Under text=True in UTF-8 mode this child's output came back EMPTY
        # (the reader thread died); the caller then read "" and decided from it.
        r = clilib.run_text(emit(OEM_BYTES), timeout=30)
        self.assertEqual(r.returncode, 0)
        self.assertIn("archived", r.stdout)
        self.assertIn("done", r.stdout)

    def test_the_old_way_really_does_lose_it_here(self):
        # The proof that the test above is testing something: the same child, read the old way,
        # in UTF-8 mode. It must NOT come back intact - if this ever passes, the environment has
        # stopped reproducing the bug and the test above has stopped meaning anything.
        #
        # And the loss is worse than an empty string: the reader thread dies, so stdout is None.
        # Callers wrote `(r.stdout or "")`, which turns that into "" without a murmur - a
        # verdict computed from nothing, which is exactly how this survived unnoticed.
        env = {**__import__("os").environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        proc = subprocess.run(
            [sys.executable, "-c",
             "import subprocess, sys;"
             f"r = subprocess.run({emit(OEM_BYTES)!r}, capture_output=True, text=True);"
             "print('GOT:' + repr(r.stdout))"],
            capture_output=True, env=env, timeout=60,
        )
        got = clilib.decode_console(proc.stdout).strip()
        self.assertNotIn("archived", got)
        self.assertIn(got.removeprefix("GOT:"), ("None", "''", '""'))

    def test_utf8_output_is_decoded_as_utf8_not_guessed_at(self):
        # Our own scripts and pwsh 7 emit UTF-8; getting that right matters more than leniency.
        r = clilib.run_text(emit("chat 'Café' archived ✓".encode()), timeout=30)
        self.assertIn("Café", r.stdout)
        self.assertIn("✓", r.stdout)

    def test_stderr_is_decoded_too_and_the_exit_code_is_untouched(self):
        argv = [sys.executable, "-c",
                "import sys; sys.stderr.buffer.write(b'bad \\xfa byte'); sys.exit(3)"]
        r = clilib.run_text(argv, timeout=30)
        self.assertEqual(r.returncode, 3)
        self.assertIn("bad", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_a_caller_passing_text_or_encoding_cannot_reintroduce_the_bug(self):
        # The helper owns the decoding. A caller that copies `text=True` from an old call site
        # must not get the old behaviour back.
        r = clilib.run_text(emit(OEM_BYTES), timeout=30, text=True, encoding="utf-8")
        self.assertIn("archived", r.stdout)

    def test_empty_and_missing_output_are_plain_empty_strings(self):
        self.assertEqual(clilib.decode_console(None), "")
        self.assertEqual(clilib.decode_console(b""), "")


class NoCallerDecodesItsOwnChildTest(unittest.TestCase):
    """The rule, enforced: no script may go back to `text=True`. A single call site that does
    is a silent hole of exactly the shape above, and it would be found the same way this one
    was - by a lane quietly deciding from output it never received."""

    def test_no_script_uses_text_true_on_a_subprocess(self):
        root = Path(__file__).resolve().parents[1]
        offenders = []
        for path in sorted(root.rglob("*.py")):
            if "tests" in path.parts or path.name == "clilib.py":
                continue
            src = path.read_text(encoding="utf-8")
            if "text=True" in src or "subprocess.run(" in src:
                offenders.append(str(path.relative_to(root)))
        self.assertEqual(offenders, [], "use clilib.run_text, never subprocess.run/text=True")


if __name__ == "__main__":
    unittest.main()
