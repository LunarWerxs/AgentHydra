"""Console-lane hardening (review 2026-09-01): three defects found by inspection, each pinned
here so it cannot silently come back.

  1. cli_spawn.spawn() could fork a transcript: a `--resume` was launched without ever asking
     whether the chat already had a live engine, and a daemon read failure was not distinguished
     from "definitely not live".
  2. cli_saturate.execute() and saturate.execute() died on the first crashing candidate,
     leaving every candidate AFTER it un-attempted for that whole sweep.
  3. cli_sessions.chats() reported a DORMANT chat's cwd as the encoded project-directory name
     (lossy, usually not a real folder) instead of recovering the real path from the
     transcript - and cli_saturate could hand that fabricated folder straight to cli_spawn.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import cli_accounts  # noqa: E402
import cli_saturate  # noqa: E402
import cli_sessions  # noqa: E402
import cli_spawn  # noqa: E402
import saturate  # noqa: E402
from lib import bandlib  # noqa: E402
from lib import deliverylib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import peerlib  # noqa: E402


class SpawnResumeLiveEngineTest(unittest.TestCase):
    """A `--resume` must never launch against a chat that already has a live engine - that
    forks the transcript both processes then append to."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.folder = self._tmp.name
        self.acct_dir = str(Path(self._tmp.name) / "acct")

    def tearDown(self):
        self._tmp.cleanup()

    def _accounts(self):
        return [{"name": "acct", "configDir": self.acct_dir, "loggedIn": True,
                 "why": "signed in"}]

    def test_a_live_engine_refuses_before_building_the_terminal_command(self):
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(hydralib, "live_for", return_value={"pid": 4242}), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen:
            got = cli_spawn.spawn(self.folder, None, None, None, "resume-id")
        self.assertFalse(got["ok"])
        self.assertIn("live engine", got["why"])
        self.assertIn("4242", got["why"])
        popen.assert_not_called()

    def test_a_daemon_error_on_the_live_check_refuses_rather_than_guessing(self):
        # Unknown must never read as "not live" - the same policy compact_chat.py applies
        # before touching a transcript.
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(hydralib, "live_for",
                               side_effect=hydralib.DaemonError("/x", None, "down")), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen:
            got = cli_spawn.spawn(self.folder, None, None, None, "resume-id")
        self.assertFalse(got["ok"])
        self.assertIn("cannot tell", got["why"])
        popen.assert_not_called()

    def test_a_session_already_live_on_the_target_account_refuses(self):
        # hydralib says not-live (e.g. its identity has not registered with the daemon yet),
        # but the account's OWN peer registry already shows a live process for this id - the
        # second, cheaper door still catches it.
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(hydralib, "live_for", return_value=None), \
             mock.patch.object(peerlib, "live_sessions",
                               return_value=[{"sessionId": "resume-id", "pid": 1}]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen:
            got = cli_spawn.spawn(self.folder, None, None, None, "resume-id")
        self.assertFalse(got["ok"])
        self.assertIn("live engine", got["why"])
        popen.assert_not_called()

    def test_a_genuinely_dead_resume_still_launches(self):
        with mock.patch.object(cli_accounts, "accounts", return_value=self._accounts()), \
             mock.patch.object(bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": [], "source": "test"}), \
             mock.patch.object(hydralib, "live_for", return_value=None), \
             mock.patch.object(peerlib, "live_sessions", return_value=[]), \
             mock.patch.object(cli_spawn.subprocess, "Popen") as popen, \
             mock.patch.object(cli_spawn, "START_WAIT_SECS", 0):
            got = cli_spawn.spawn(self.folder, None, None, None, "resume-id")
        popen.assert_called_once()
        self.assertIsNone(got["sessionId"])  # no record registers in this test, that's fine


class CliSaturateCrashResilienceTest(unittest.TestCase):
    """One crashing candidate must not stop the sweep - the loop keeps going, and the crash
    is noted so the attempt cap can eventually retire a candidate that only ever crashes."""

    def test_a_crashing_candidate_is_recorded_and_the_loop_continues(self):
        plan = {"planned": [
            {"sessionId": "s1", "cwd": "D:/w1", "onAccount": "a", "name": "c1", "why": "x"},
            {"sessionId": "s2", "cwd": "D:/w2", "onAccount": "b", "name": "c2", "why": "x"},
        ]}
        with mock.patch.object(cli_saturate.cli_spawn, "spawn",
                               side_effect=[RuntimeError("boom"), {"ok": True}]), \
             mock.patch.object(cli_saturate.ledgerlib, "note") as note:
            out = cli_saturate.execute(plan)
        self.assertEqual(len(out), 2)  # the second candidate was still attempted
        self.assertFalse(out[0]["ok"])
        self.assertIn("crashed: boom", out[0]["outcome"])
        self.assertTrue(out[1]["ok"])
        # every attempt is noted, including the crash, so the ledger's attempt cap sees it
        noted_sessions = [c.args[1] for c in note.call_args_list]
        self.assertEqual(noted_sessions, ["s1", "s2"])
        crash_note = note.call_args_list[0].kwargs.get("note", "")
        self.assertIn("crashed: boom", crash_note)


class SaturateCrashResilienceTest(unittest.TestCase):
    """The desktop-side twin of the same fix: saturate.execute() must survive one candidate
    blowing up partway through the delivery machinery."""

    def test_a_crashing_candidate_is_recorded_and_the_loop_continues(self):
        plan = {"planned": [
            {"sessionId": "s1", "staged": False, "title": "c1", "instance": "a",
             "transcript": "", "why": "x"},
            {"sessionId": "s2", "staged": True, "deliveryId": "d2", "title": "c2",
             "instance": "b", "why": "x"},
        ]}
        with mock.patch.object(deliverylib, "recent_delivery",
                               side_effect=RuntimeError("boom")), \
             mock.patch.object(saturate.clilib, "capture", return_value=(0, "done")):
            out = saturate.execute(plan)
        self.assertEqual(len(out), 2)
        self.assertFalse(out[0]["ok"])
        self.assertIn("crashed: boom", out[0]["outcome"])
        self.assertTrue(out[1]["ok"])
        self.assertEqual(out[1]["outcome"], "woken")


class CliSessionsCwdRecoveryTest(unittest.TestCase):
    """A DORMANT chat's cwd must come from the transcript's own records, never from the
    encoded project-directory name (lossy, and usually not a real path at all)."""

    def _write(self, path: Path, lines: list[dict]):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(l) for l in lines), encoding="utf-8")

    def test_transcript_cwd_reads_the_first_line_that_carries_one(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            tp = Path(tmp.name) / "sess.jsonl"
            self._write(tp, [
                {"type": "summary"},
                {"type": "user", "cwd": r"D:\real\folder", "message": {}},
                {"type": "assistant", "cwd": r"D:\real\folder", "message": {}},
            ])
            self.assertEqual(cli_sessions._transcript_cwd(str(tp)), r"D:\real\folder")
        finally:
            tmp.cleanup()

    def test_transcript_cwd_is_none_when_nothing_carries_one(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            tp = Path(tmp.name) / "sess.jsonl"
            self._write(tp, [{"type": "summary"}, {"type": "user", "message": {}}])
            self.assertIsNone(cli_sessions._transcript_cwd(str(tp)))
        finally:
            tmp.cleanup()

    def test_transcript_cwd_is_none_for_a_missing_file(self):
        self.assertIsNone(cli_sessions._transcript_cwd("D:/does/not/exist.jsonl"))

    def test_a_dormant_chat_reports_the_recovered_cwd_not_the_encoded_folder_name(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            cfg = Path(tmp.name)
            tp = cfg / "projects" / "D--real-folder" / "sess1.jsonl"
            self._write(tp, [{"type": "user", "cwd": r"D:\real\folder", "message": {}}])
            acct = [{"name": "a", "configDir": str(cfg), "loggedIn": True, "why": "signed in"}]
            with mock.patch.object(cli_accounts, "accounts", return_value=acct), \
                 mock.patch.object(cli_sessions, "_console_owned", return_value={"sess1"}), \
                 mock.patch.object(cli_sessions.peerlib, "live_sessions", return_value=[]), \
                 mock.patch.object(cli_sessions.holdlib, "why_blocked", return_value=None), \
                 mock.patch.object(cli_sessions.gatelib, "gate",
                                   return_value={"state": "finished",
                                                 "finished": {"lane": "needs-input-review"},
                                                 "cause": ""}):
                rows = cli_sessions.chats(recent_days=None)
        finally:
            tmp.cleanup()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cwd"], r"D:\real\folder")
        self.assertNotEqual(rows[0]["cwd"], "D--real-folder")

    def test_a_dormant_chat_with_no_recoverable_cwd_reports_none(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            cfg = Path(tmp.name)
            tp = cfg / "projects" / "D--mystery" / "sess1.jsonl"
            self._write(tp, [{"type": "summary"}])
            acct = [{"name": "a", "configDir": str(cfg), "loggedIn": True, "why": "signed in"}]
            with mock.patch.object(cli_accounts, "accounts", return_value=acct), \
                 mock.patch.object(cli_sessions, "_console_owned", return_value={"sess1"}), \
                 mock.patch.object(cli_sessions.peerlib, "live_sessions", return_value=[]), \
                 mock.patch.object(cli_sessions.holdlib, "why_blocked", return_value=None), \
                 mock.patch.object(cli_sessions.gatelib, "gate",
                                   return_value={"state": "crashed", "cause": ""}):
                rows = cli_sessions.chats(recent_days=None)
        finally:
            tmp.cleanup()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["cwd"])


class CliSaturateNoCwdSkipTest(unittest.TestCase):
    """cli_saturate must never hand cli_spawn a fabricated folder - a candidate whose cwd
    could not be recovered is skipped, visibly, rather than planned."""

    def test_a_candidate_with_no_recoverable_cwd_is_skipped_not_planned(self):
        chats = [
            {"sessionId": "s1", "account": "a", "running": False, "held": None,
             "state": "finished", "lane": "needs-input-review", "cwd": None,
             "name": "no-cwd-chat", "ageDays": 1.0},
            {"sessionId": "s2", "account": "a", "running": False, "held": None,
             "state": "finished", "lane": "needs-input-review", "cwd": "D:/real",
             "name": "good-chat", "ageDays": 1.0},
        ]
        accts = [{"name": "a", "configDir": "C:/a", "loggedIn": True, "why": "signed in"}]
        with mock.patch.object(cli_saturate.cli_sessions, "chats", return_value=chats), \
             mock.patch.object(cli_saturate.cli_accounts, "accounts", return_value=accts), \
             mock.patch.object(cli_saturate.bandlib, "snapshot",
                               return_value={"bands": {}, "accounts": []}):
            plan = cli_saturate.build_plan(floor=4)
        planned_ids = [p["sessionId"] for p in plan["planned"]]
        self.assertNotIn("s1", planned_ids)
        self.assertIn("s2", planned_ids)
        no_cwd_ids = [r["sessionId"] for r in plan["noCwd"]]
        self.assertEqual(no_cwd_ids, ["s1"])
        self.assertIn("cwd", plan["noCwd"][0]["why"])


if __name__ == "__main__":
    unittest.main()
