"""THE CLI CONTRACT, enforced across every script rather than trusted per script.

The owner's rule (2026-08-31): "all of our individual scripts should be able to use
arguments". So every runnable script must answer --help with its own docstring and exit 0,
without touching the daemon, the fleet, or any state. A script that cannot explain itself
offline is a script nobody can use from a terminal or an MCP tool.

AND IT MUST SURVIVE A PIPE, which is the half this file used to miss (2026-09-02). These
assertions captured --help into an io.StringIO. A StringIO has NO codec: it accepts every
character, so the test passed green over a crash that a real pipe hit every single time.
On Windows Python only gives stdout a UTF-8-capable encoding when stdout IS a console; pipe
it or redirect it to a log - which is how every scheduled task in schedule_jobs.py runs - and
stdout is cp1252, which cannot encode the no-entry sign 14 of these docstrings carry. So
`python orch.py --help | cat` died with UnicodeEncodeError while this file reported a clean
CLI contract. A test that cannot reproduce the bug is not a test, so --help is now captured
through a REAL cp1252 stream (see _cp1252_stdout) that raises exactly as the pipe does."""

import contextlib
import importlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


def runnable_scripts() -> list[str]:
    return sorted(p.stem for p in SCRIPTS.glob("*.py") if not p.stem.endswith("lib"))


# No script is exempt any more. schedule_jobs.py briefly was: it guards its console at IMPORT
# time and, while that covers the way it really runs (a standalone process writing into a
# `>> log` redirect), it did NOT cover a stream handed to it after import - clilib.capture(),
# orch.py's dispatch, these in-process rails. It now calls clilib.use_utf8_console() in main()
# like everything else, so the exemption is gone. Do not reintroduce one: a script that opts
# out of this check is a script whose --help can die in a log nobody reads.
IMPORT_TIME_ONLY: set[str] = set()


def _cp1252_stdout() -> io.TextIOWrapper:
    """A stdout that encodes like Windows hands it to a piped process: cp1252, strict.

    The point is that this is a real TextIOWrapper over a real byte buffer, so writing an
    unmappable character RAISES here exactly as it does down a pipe - unlike io.StringIO,
    which has no codec and silently accepts anything. It is also reconfigurable, so a script
    that does its job (clilib.use_utf8_console) switches this stream to UTF-8 and the write
    lands; a script that does not, dies on its own docstring.
    """
    return io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict", newline="")


def _help_through_a_pipe(mod, flag: str) -> tuple[int, str]:
    """Run mod.main([flag]) with stdout as a cp1252 pipe; return (exit code, decoded output)."""
    stream = _cp1252_stdout()
    with contextlib.redirect_stdout(stream):
        code = mod.main([flag])
        stream.flush()
    # Decode by whatever the script left the stream set to - UTF-8 once it has fixed itself.
    return code, stream.buffer.getvalue().decode(stream.encoding, errors="replace")


class CliContractTest(unittest.TestCase):
    def setUp(self):
        # Point every script at a throwaway state dir and an unreachable daemon: --help must
        # work with neither available.
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name
        os.environ["AGENTHYDRA_URL"] = "http://127.0.0.1:9"  # discard port; nothing listens

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        os.environ.pop("AGENTHYDRA_URL", None)
        self._tmp.cleanup()

    def test_every_script_has_a_main_taking_argv(self):
        for name in runnable_scripts():
            mod = importlib.import_module(name)
            self.assertTrue(hasattr(mod, "main"), f"{name} has no main()")

    def test_every_script_answers_help_offline_with_its_own_docstring(self):
        for name in runnable_scripts():
            mod = importlib.import_module(name)
            for flag in ("--help", "-h"):
                with self.subTest(script=name, flag=flag):
                    # A cp1252 pipe, not a StringIO: see this module's docstring.
                    code, out = _help_through_a_pipe(mod, flag)
                    self.assertEqual(code, 0, f"{name} {flag} exited {code}")
                    self.assertIn(f"{name}.py", out,
                                  f"{name} {flag} did not print its own docstring")
                    self.assertTrue(len(out.strip()) > 80,
                                    f"{name} {flag} printed almost nothing")

    def test_help_survives_a_cp1252_pipe_even_when_the_docstring_is_not_ascii(self):
        """The regression rail, aimed at the 14 docstrings that carry a non-ASCII glyph.

        Named separately from the contract test above so a failure says WHY: the script prints
        the right words, it just cannot get them through a pipe. Scripts whose docstring is
        pure ASCII cannot exercise this, so they are skipped rather than counted as proof.
        """
        proved = []
        for name in runnable_scripts():
            mod = importlib.import_module(name)
            doc = mod.__doc__ or ""
            if all(ord(c) < 128 for c in doc):
                continue
            with self.subTest(script=name):
                code, out = _help_through_a_pipe(mod, "--help")  # raises if unfixed
                self.assertEqual(code, 0)
                self.assertIn(f"{name}.py", out)
                proved.append(name)
        self.assertTrue(proved, "no non-ASCII docstring found - has the rail stopped testing?")

    def test_every_script_documents_its_usage_and_exit_codes(self):
        for name in runnable_scripts():
            doc = importlib.import_module(name).__doc__ or ""
            self.assertIn("Usage:", doc, f"{name} does not document a Usage line")
            self.assertIn("Exit:", doc, f"{name} does not document its exit codes")

    def test_help_never_touches_the_daemon(self):
        # AGENTHYDRA_URL points at a dead port; if a script reached out, --help would hang or
        # raise rather than return 0. The assertions above cover it, so this documents intent
        # and pins the environment the others rely on.
        from lib import hydralib

        importlib.reload(hydralib)
        self.assertIn(":9", hydralib.BASE)


class CliSendTargetingTest(unittest.TestCase):
    """cli_send.py: the argv contract for --text (review 2026-09-01 - its value does not
    start with '--', so it used to count as a second positional and the documented
    invocation always failed with exit 3) and the console-only filter on _targets()."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_valid_argv_with_no_console_sessions_returns_3_with_an_honest_why(self):
        import unittest.mock as mock

        import cli_accounts
        import cli_send
        from util import run_cli

        with mock.patch.object(cli_accounts, "accounts", return_value=[]):
            code, out, err = run_cli(cli_send.main, ["abc123", "--text", "hello world"])
        self.assertEqual(code, 3)
        self.assertIn("no RUNNING console session", err)
        self.assertNotIn("Usage:", err)  # argv parsed fine - this is send()'s own refusal

    def test_a_missing_text_value_returns_3_without_crashing(self):
        import cli_send
        from util import run_cli

        code, out, err = run_cli(cli_send.main, ["abc123", "--text"])
        self.assertEqual(code, 3)

    def test_targets_skips_registry_records_owned_by_the_desktop_app(self):
        import unittest.mock as mock

        import cli_accounts
        import cli_send
        from lib import peerlib

        with mock.patch.object(cli_accounts, "accounts",
                               return_value=[{"name": "acct1", "configDir": "/tmp/acct1"}]), \
             mock.patch.object(peerlib, "live_sessions", return_value=[
                 {"sessionId": "s1", "entrypoint": "claude-desktop-electron", "token": "t1"},
                 {"sessionId": "s2", "entrypoint": "cli", "token": "t2"},
             ]):
            rows = cli_send._targets()
        self.assertEqual([r["sessionId"] for r in rows], ["s2"])
        self.assertEqual(rows[0]["account"], "acct1")


if __name__ == "__main__":
    unittest.main()
