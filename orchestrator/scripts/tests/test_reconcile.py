"""reconcile.py: did the pending-restart archives land? The four verdicts, and the rule that
success clears the ledger while a revert stays counted."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402
import reconcile  # noqa: E402


from util import run_cli  # noqa: E402


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        self.chats = {}  # sid -> (instance, archived)
        stub = self.stub

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            if sid not in self.chats:
                return {"matches": []}
            inst, archived = self.chats[sid]
            return {"matches": [{"instance": inst, "chatId": f"c-{sid}", "cliSessionId": sid,
                                 "lineageIds": [sid], "title": f"chat {sid}",
                                 "archived": archived, "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "closed", "dir": "c:\\i\\closed", "isRunning": False},
            {"num": 2, "name": "open", "dir": "c:\\i\\open", "isRunning": True},
        ]}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_landed_clears_the_ledger(self):
        self.chats["s1"] = ("closed", True)
        ledgerlib.note("archive", "s1", note="archive 'x'")
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "landed")
        self.assertEqual(ledgerlib._load(), [])  # success clears - the brake is for futility

    def test_reverted_is_flagged_and_stays_counted(self):
        self.chats["s1"] = ("closed", False)  # asked to archive; disk says visible
        ledgerlib.note("archive", "s1", note="archive 'x'")
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "reverted")
        self.assertIn("did NOT stick", r["rows"][0]["why"])
        self.assertEqual(len(ledgerlib._load()), 1)  # still counted: the loop must be bounded

    def test_running_app_rows_are_unconfirmed_and_actionable(self):
        # The owner never restarts the apps, so 'wait for the restart' is not a state this
        # tool may have: a running-app row is UNCONFIRMED and --retry settles it via the
        # app's own control.
        self.chats["s1"] = ("open", False)
        ledgerlib.note("archive", "s1", note="archive 'x'")
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "unconfirmed-on-screen")
        self.assertIn("never restarts", r["rows"][0]["why"])
        self.assertEqual(len(r["reverted"]), 1)  # actionable, not parked
        self.assertEqual(len(ledgerlib._load()), 1)

    def test_retry_re_runs_the_original_direction_not_blindly_archive(self):
        # Adversarial review, 2026-08-31: a reverted UNARCHIVE used to be retried as an
        # ARCHIVE - re-burying the exact chat the owner had just restored.
        import unittest.mock as mock

        with mock.patch("archive_chat.main", return_value=0) as m:
            out = reconcile.retry([{"sessionId": "x", "state": "reverted", "wantedArchived": False}])
        m.assert_called_once_with(["x", "--unarchive"])
        self.assertIn("restored (unarchived)", out[0]["outcome"])
        # a re-archive passes --no-preserve: the chat was already preserved on its first archive.
        with mock.patch("archive_chat.main", return_value=0) as m2:
            out2 = reconcile.retry([{"sessionId": "y", "state": "reverted", "wantedArchived": True}])
        m2.assert_called_once_with(["y", "--no-preserve"])
        self.assertIn("re-archived", out2[0]["outcome"])

    def test_a_failed_dossier_read_is_unsettled_never_all_clear(self):
        # Adversarial review, 2026-08-31: "unknown" rows were invisible to both the exit
        # code and --retry, so a failed read printed as a clean reconcile.
        ledgerlib.note("archive", "s1", note="archive 'x'")
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "down"})
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "unknown")
        self.assertEqual(len(r["reverted"]), 1)  # unsettled -> exit 2 and --retry both see it

    def test_gone_chat_clears_the_ledger(self):
        ledgerlib.note("archive", "ghost", note="archive 'x'")
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "gone")
        self.assertEqual(ledgerlib._load(), [])

    def test_unarchive_attempts_are_judged_in_the_right_direction(self):
        self.chats["s1"] = ("closed", False)  # asked to UNarchive; visible = landed
        ledgerlib.note("archive", "s1", note="unarchive 'x'")
        r = reconcile.reconcile()
        self.assertEqual(r["rows"][0]["state"], "landed")

    def test_exit_codes(self):
        self.chats["s1"] = ("closed", True)
        ledgerlib.note("archive", "s1", note="archive 'x'")
        self.assertEqual(run_cli(reconcile.main, [])[0], 0)
        ledgerlib.note("archive", "s2", note="archive 'y'")
        self.chats["s2"] = ("closed", False)
        self.assertEqual(run_cli(reconcile.main, [])[0], 2)

    def test_retry_runs_the_full_rails(self):
        import unittest.mock as mock

        self.chats["s1"] = ("closed", False)
        ledgerlib.note("archive", "s1", note="archive 'x'")
        with mock.patch("archive_chat.main", return_value=0) as m:
            code, out, _ = run_cli(reconcile.main, ["--retry"])
        self.assertEqual(code, 0)
        # no --force (a hold or breaker still stops it); --no-preserve (already preserved once)
        m.assert_called_once_with(["s1", "--no-preserve"])
        self.assertIn("re-archived and verified", out)

    def test_retry_without_an_armed_window_refuses_and_retries_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --retry alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        import unittest.mock as mock

        armlib.disarm()
        self.chats["s1"] = ("closed", False)
        ledgerlib.note("archive", "s1", note="archive 'x'")
        with mock.patch("archive_chat.main") as m:
            code, out, _ = run_cli(reconcile.main, ["--retry"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)


if __name__ == "__main__":
    unittest.main()
