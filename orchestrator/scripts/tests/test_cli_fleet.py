"""The CONSOLE fleet: accounts, the peer channel, spawning, and the floor that spreads across
every account (owner, 2026-09-01: "please build me a CLI/console version of this as well").

These tests pin the things that make the console side WORTH having - the doctrine is a launch
flag rather than a mutable record, an account is a directory rather than a window, and a
delivery is a socket write rather than seven aiming rails - plus the two traps that already
bit once during the build: a bare executable name, and a credentials file that exists while
the account is signed out.
"""

import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import cli_accounts  # noqa: E402
import cli_spawn  # noqa: E402
from lib import bandlib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import peerlib  # noqa: E402

from stubdaemon import StubDaemon  # noqa: E402
from util import isolate_state_dir, run_cli  # noqa: E402

HOUR_MS = 3600 * 1000


class AccountRosterTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _creds(self, **oauth):
        (self.dir / ".credentials.json").write_text(
            json.dumps({"claudeAiOauth": oauth}), encoding="utf-8")

    def test_a_signed_in_account_is_ready(self):
        self._creds(accessToken="x" * 40, expiresAt=time.time() * 1000 + HOUR_MS)
        ok, why = cli_accounts.login_state(self.dir)
        self.assertTrue(ok)
        self.assertEqual(why, "signed in")

    def test_a_live_REFRESH_token_is_enough(self):
        self._creds(accessToken="x", expiresAt=0,
                    refreshToken="y" * 40, refreshTokenExpiresAt=time.time() * 1000 + HOUR_MS)
        self.assertTrue(cli_accounts.login_state(self.dir)[0])

    def test_a_credentials_file_that_EXISTS_but_is_empty_is_not_a_login(self):
        # This exact shape cost a spawn that reported success and produced nothing: the file
        # was there, both tokens were empty strings, and every terminal died on "OAuth expired".
        self._creds(accessToken="", refreshToken="", expiresAt=0, refreshTokenExpiresAt=0)
        ok, why = cli_accounts.login_state(self.dir)
        self.assertFalse(ok)
        self.assertIn("signed out", why)

    def test_an_expired_session_says_so_rather_than_looking_ready(self):
        self._creds(accessToken="x" * 40, expiresAt=1,
                    refreshToken="y" * 40, refreshTokenExpiresAt=1)
        ok, why = cli_accounts.login_state(self.dir)
        self.assertFalse(ok)
        self.assertIn("expired", why)

    def test_no_credentials_at_all(self):
        self.assertEqual(cli_accounts.login_state(self.dir)[1], "never logged in")


class PeerChannelTest(unittest.TestCase):
    """The registry read - the half that does not need a live session to test."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cfg = Path(self._tmp.name)
        (self.cfg / "sessions").mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _publish(self, pid, sid, token="tok"):
        d = self.cfg / "sessions"
        (d / f"{pid}.json").write_text(json.dumps(
            {"pid": str(pid), "sessionId": sid, "cwd": "D:/x", "startedAt": "1",
             "messagingSocketPath": r"\\.\pipe\LOCAL\cc-msg-abc"}), encoding="utf-8")
        if token:
            (d / f"{pid}.hash.key").write_text(json.dumps({"peerToken": token}),
                                               encoding="utf-8")

    def test_a_live_record_carries_its_token(self):
        self._publish(4242, "s-1")
        with mock.patch.object(peerlib, "_pid_alive", return_value=True):
            rows = peerlib.live_sessions(self.cfg)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["token"], "tok")

    def test_a_dead_process_is_not_a_live_session(self):
        # The registry is written on start and not cleaned on crash, so liveness is checked.
        self._publish(4242, "s-1")
        with mock.patch.object(peerlib, "_pid_alive", return_value=False):
            self.assertEqual(peerlib.live_sessions(self.cfg), [])

    def test_a_record_without_a_key_cannot_be_messaged_and_says_so(self):
        self._publish(99, "s-2", token=None)
        with mock.patch.object(peerlib, "_pid_alive", return_value=True):
            rec = peerlib.live_sessions(self.cfg)[0]
        ok, why = peerlib.send(rec, "hello")
        self.assertFalse(ok)
        self.assertIn("token", why)

    def test_a_record_with_no_socket_is_refused_before_any_io(self):
        ok, why = peerlib.send({"token": "t"}, "hello")
        self.assertFalse(ok)
        self.assertIn("messaging socket", why)


class SpawnTest(unittest.TestCase):
    def setUp(self):
        # spawn() reads the usage bands before it spawns; with no stub that was a live
        # /api/usage/survey call whose answer landed in the checkout's own state/ (2026-09-05).
        # A routeless stub answers 404 to everything, which the band door reads as "no band
        # known, not blocked" - exactly the neutral footing these tests assume.
        isolate_state_dir(self)
        self.stub = StubDaemon()
        self.addCleanup(self.stub.close)
        self._base = hydralib.BASE
        hydralib.BASE = self.stub.url
        self.addCleanup(setattr, hydralib, "BASE", self._base)

    def test_the_doctrine_is_on_the_command_line_not_in_a_file(self):
        # The whole reason the console side is worth trying: permissions and effort are set
        # when the process starts, so nothing can re-save over them and no chat can stop to ask.
        cmd, env = cli_spawn._terminal_cmd("C:/cfg", "D:/work",
                                           cli_spawn.DOCTRINE_ARGS, "orch:work")
        line = " ".join(cmd)
        self.assertIn("--dangerously-skip-permissions", line)
        self.assertIn("--effort", line)
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "C:/cfg")

    @unittest.skipIf(cli_spawn.claude_exe() == "claude",
                     "Claude Code is not installed here, so claude_exe() has nothing absolute to "
                     "return - the property under test cannot hold. Skipped LOUDLY rather than "
                     "failed: on a CI runner this is a fact about the machine, not the code.")
    def test_the_executable_is_absolute_never_a_bare_name(self):
        # A bare "claude" handed to a freshly opened terminal could not be resolved there; the
        # tab opened and vanished, and the spawn reported success.
        cmd, _env = cli_spawn._terminal_cmd("C:/cfg", "D:/work", ["--x"], "t")
        line = " ".join(cmd)
        self.assertNotIn('"claude"', line)
        self.assertIn(cli_spawn.claude_exe(), line)

    def test_a_bare_name_is_what_the_fallback_returns_when_nothing_is_installed(self):
        # The other half, and the one that RUNS everywhere: the test above is skipped on a
        # machine with no Claude, so without this the fallback's behaviour would be pinned
        # nowhere at all. `claude_exe` promises a usable path or the bare name - never None,
        # never a .ps1 - so a caller always has something to hand a terminal.
        with mock.patch.object(cli_spawn.shutil, "which", return_value=None), \
             mock.patch.object(cli_spawn.Path, "home", return_value=Path("Q:/nonexistent")):
            self.assertEqual(cli_spawn.claude_exe(), "claude")

    def test_it_refuses_when_no_account_is_signed_in(self):
        with mock.patch.object(cli_accounts, "accounts",
                               return_value=[{"name": "a", "configDir": "C:/x",
                                              "loggedIn": False, "why": "signed out"}]):
            got = cli_spawn.spawn("D:/work", None, None, None, None)
        self.assertFalse(got["ok"])
        self.assertIn("logged in", got["why"])

    def test_a_terminal_that_opens_but_never_registers_is_NOT_a_started_chat(self):
        acct = [{"name": "a", "configDir": "C:/x", "loggedIn": True, "why": "signed in"}]
        with mock.patch.object(cli_accounts, "accounts", return_value=acct), \
             mock.patch.object(cli_spawn.subprocess, "Popen"), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn("D:/work", None, None, None, None)
        self.assertFalse(got["ok"])
        self.assertIsNone(got["sessionId"])
        self.assertIn("no session registered", got["why"])


class ConsoleFloorTest(unittest.TestCase):
    """Spreading across EVERY account, because a console account has no window to open."""

    def test_the_floor_spreads_evenly_over_all_signed_in_accounts(self):
        import cli_saturate

        chats = [
            {"sessionId": f"s{i}", "account": "a", "running": False, "held": None,
             "state": "finished", "lane": "needs-input-review", "cwd": "D:/w",
             "name": f"chat{i}", "ageDays": 1.0}
            for i in range(4)
        ]
        accts = [{"name": n, "configDir": f"C:/{n}", "loggedIn": True, "why": "signed in"}
                 for n in ("a", "b", "c")]
        with mock.patch.object(cli_saturate.cli_sessions, "chats", return_value=chats), \
             mock.patch.object(cli_saturate.cli_accounts, "accounts", return_value=accts), \
             mock.patch.object(cli_saturate.bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": []}):
            plan = cli_saturate.build_plan(floor=4)
        self.assertEqual(len(plan["planned"]), 4)
        landed = sorted(p["onAccount"] for p in plan["planned"])
        self.assertEqual(landed, ["a", "a", "b", "c"])  # even, no account left idle

    def test_a_cooked_account_is_still_skipped(self):
        import cli_saturate

        chats = [{"sessionId": "s1", "account": "a", "running": False, "held": None,
                  "state": "crashed", "lane": None, "cwd": "D:/w", "name": "c", "ageDays": 1.0}]
        accts = [{"name": "hot", "configDir": "C:/hot", "loggedIn": True, "why": "signed in"}]
        with mock.patch.object(cli_saturate.cli_sessions, "chats", return_value=chats), \
             mock.patch.object(cli_saturate.cli_accounts, "accounts", return_value=accts), \
             mock.patch.object(cli_saturate.bandlib, "snapshot",
                               return_value={"bands": {"hot": "over-hard"}, "accounts": []}):
            plan = cli_saturate.build_plan(floor=4)
        self.assertEqual(plan["usableAccounts"], [])
        self.assertEqual(plan["planned"], [])


class CliSaturateGateTest(unittest.TestCase):
    """THE ARMED WINDOW (owner order, 2026-09-01): starting console chats is unattended
    acting - it must not run without the tray icon being up (`python orch.py arm`) or --force."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_yes_without_an_armed_window_refuses_and_starts_nothing(self):
        import cli_saturate

        plan = {"planned": [{"sessionId": "s1", "onAccount": "a"}]}
        with mock.patch.object(cli_saturate, "build_plan", return_value=plan), \
             mock.patch.object(cli_saturate, "execute") as m:
            code, out, _ = run_cli(cli_saturate.main, ["--yes", "--json"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)

    def test_yes_with_an_armed_window_starts_as_before(self):
        import cli_saturate
        from lib import armlib

        armlib.arm(3600)
        plan = {"planned": [{"sessionId": "s1", "onAccount": "a"}]}
        with mock.patch.object(cli_saturate, "build_plan", return_value=plan), \
             mock.patch.object(cli_saturate, "execute", return_value=[{"ok": True}]) as m:
            code, out, _ = run_cli(cli_saturate.main, ["--yes", "--json"])
        m.assert_called_once()
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)


class SpawnHoldAndBandTest(unittest.TestCase):
    """The two doors spawn() checks before it will open a terminal: a HELD resume (a
    person's hands-off word) and the usage bands (the same doors cli_saturate already
    gated - a direct invocation must gate them too)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        self.acctA_dir = str(Path(self._tmp.name) / "acctA")
        self.acctB_dir = str(Path(self._tmp.name) / "acctB")

    def tearDown(self):
        self._tmp.cleanup()

    def _accounts(self):
        return [{"name": "acctA", "configDir": self.acctA_dir, "loggedIn": True, "why": "signed in"},
                {"name": "acctB", "configDir": self.acctB_dir, "loggedIn": True, "why": "signed in"}]

    def test_a_held_resume_refuses_without_opening_a_terminal(self):
        with mock.patch.object(holdlib, "why_blocked",
                               return_value="HELD by owner since 2026-09-01: testing"), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen:
            got = cli_spawn.spawn(self.folder, None, None, None, "held-session-id")
        self.assertFalse(got["ok"])
        self.assertIn("HELD", got["why"])
        popen.assert_not_called()

    def test_force_proceeds_past_a_hold(self):
        with mock.patch.object(holdlib, "why_blocked",
                               return_value="HELD by owner since 2026-09-01: testing"), \
             mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {"acctA": "ok", "acctB": "ok"},
                                             "accounts": [], "source": "test"}), \
             mock.patch.object(hydralib, "live_for", return_value=None), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen, \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn(self.folder, None, None, None, "held-session-id", force=True)
        self.assertNotIn("HELD", got["why"])
        popen.assert_called_once()

    def test_an_over_soft_requested_account_is_refused(self):
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {"acctA": "over-soft", "acctB": "ok"},
                                             "accounts": [], "source": "test"}):
            got = cli_spawn.spawn(self.folder, None, "acctA", None, None)
        self.assertFalse(got["ok"])
        self.assertIn("usage target", got["why"])

    def test_no_account_requested_picks_the_non_closed_one(self):
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {"acctA": "over-soft", "acctB": "ok"},
                                             "accounts": [], "source": "test"}), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen"), \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn(self.folder, None, None, None, None)
        self.assertEqual(got["account"], "acctB")

    def test_every_account_closed_refuses_unless_forced(self):
        closed_bands = {"bands": {"acctA": "over-hard", "acctB": "over-soft"},
                        "accounts": [], "source": "test"}
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot", return_value=closed_bands):
            got = cli_spawn.spawn(self.folder, None, None, None, None)
        self.assertFalse(got["ok"])
        self.assertIn("usage target", got["why"])

        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot", return_value=closed_bands), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen, \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got2 = cli_spawn.spawn(self.folder, None, None, None, None, force=True)
        self.assertNotIn("usage target", got2["why"])
        popen.assert_called_once()


class SpawnDuplicateTaskTest(unittest.TestCase):
    """cli_spawn.spawn refuses a fresh (non-resume) prompt that a visible chat already
    carries - the console side of the same 2026-09-01 double-check spawn_chat.py enforces."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        self.acct_dir = str(Path(self._tmp.name) / "acct")

    def tearDown(self):
        self._tmp.cleanup()

    def _accounts(self):
        return [{"name": "acct", "configDir": self.acct_dir, "loggedIn": True, "why": "signed in"}]

    def test_a_duplicate_task_is_refused_before_opening_a_terminal(self):
        dup = [{"session_id": "s1", "title": "T", "instance": "acct", "live": True}]
        with mock.patch.object(hydralib, "same_task_chats", return_value=dup) as same, \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen:
            got = cli_spawn.spawn(self.folder, "review this whole codebase for correctness",
                                  None, None, None)
        self.assertFalse(got["ok"])
        self.assertEqual(got["duplicateOf"], dup)
        self.assertIn("already exists", got["why"])
        same.assert_called_once_with("review this whole codebase for correctness")
        popen.assert_not_called()

    def test_force_bypasses_the_duplicate_check(self):
        with mock.patch.object(hydralib, "same_task_chats") as same, \
             mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen, \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn(self.folder, "do the thing", None, None, None, force=True)
        same.assert_not_called()
        popen.assert_called_once()
        self.assertNotIn("duplicateOf", got)

    def test_a_resume_never_triggers_the_duplicate_check(self):
        with mock.patch.object(hydralib, "same_task_chats") as same, \
             mock.patch.object(holdlib, "why_blocked", return_value=None), \
             mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen"), \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            cli_spawn.spawn(self.folder, "do the thing", None, None, "resume-id")
        same.assert_not_called()

    def test_a_daemon_error_from_the_double_check_does_not_block_the_spawn(self):
        with mock.patch.object(hydralib, "same_task_chats",
                               side_effect=hydralib.DaemonError("/x", 500, "down")), \
             mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen, \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn(self.folder, "do the thing", None, None, None)
        popen.assert_called_once()
        self.assertNotIn("duplicateOf", got)


class SpawnMainTest(unittest.TestCase):
    def test_a_held_resume_returns_2(self):
        with mock.patch.object(holdlib, "why_blocked",
                               return_value="HELD by owner since 2026-09-01: testing"):
            code, _out, _err = run_cli(cli_spawn.main, ["--resume", "held-session-id"])
        self.assertEqual(code, 2)

    def test_force_flag_is_passed_through_to_spawn(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            fake_result = {"ok": True, "account": "a", "folder": tmp.name,
                           "terminal": "console", "sessionId": "s1", "why": ""}
            with mock.patch.object(cli_spawn, "spawn", return_value=fake_result) as spawn_mock:
                code, _out, _err = run_cli(cli_spawn.main, ["--folder", tmp.name, "--force"])
            self.assertEqual(code, 0)
            self.assertTrue(spawn_mock.call_args.kwargs.get("force"))
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
