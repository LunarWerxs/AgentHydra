"""courier --only is a PERSON's delivery: several ids in one run, no tray icon, no share cap.

WHY THESE EXIST (2026-09-06). Draining two accounts by hand meant six staged resume prompts,
and delivering them took: one courier run that was refused as DISARMED, one that skipped two
rows for the per-account fair share, a --help read to find --force and --cap-exempt, and then
SIX separate runs because --only took one id. The owner's ruling: "the fair share rule is just
when you're orchestrating, aka auto managing; I'm manually managing, it does not apply." So a
NAMED delivery is now a hand-run - and the shape of that must be pinned, because every gate
it steps around exists for a reason and an UNNAMED run must keep all of them.
"""

import contextlib
import io
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import courier  # noqa: E402
from lib import armlib  # noqa: E402
from lib import deliverylib  # noqa: E402

DISARMED = {"armed": False, "why": "the tray icon is not running", "paused": False}
ARMED = {"armed": True, "why": "", "paused": False}


class ParseOnlyTest(unittest.TestCase):
    def test_only_accepts_repeats_and_comma_lists(self):
        a = courier._parse_args(["--yes", "--only", "aaa", "--only", "bbb,ccc", "--only", " ddd "])
        self.assertEqual(a.only, {"aaa", "bbb", "ccc", "ddd"})
        self.assertTrue(a.hand_run)

    def test_no_only_is_not_a_hand_run(self):
        with mock.patch.object(armlib, "status", return_value=ARMED):
            a = courier._parse_args(["--yes"])
        self.assertIsNone(a.only)
        self.assertFalse(a.hand_run)

    def test_a_named_delivery_acts_while_disarmed(self):
        """The tray icon gates the UNATTENDED lanes. A person naming a row is not one."""
        with mock.patch.object(armlib, "status", return_value=DISARMED):
            a = courier._parse_args(["--yes", "--only", "aaa"])
        self.assertTrue(a.act)

    def test_an_unnamed_delivery_still_needs_the_icon(self):
        """The rail that must NOT have moved: the standing courier is still gated."""
        with mock.patch.object(armlib, "status", return_value=DISARMED), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            a = courier._parse_args(["--yes"])
        self.assertFalse(a.act)
        self.assertIn("DISARMED", out.getvalue())

    def test_a_dangling_only_is_a_usage_error(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(courier._parse_args(["--yes", "--only"]), 2)


class HandRunPlanningTest(unittest.TestCase):
    """run() with hand_run: the queue is the named rows, all of them, with the share gate and
    the machine-wide cap switched off - and with hand_run False every one of those is back."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _stage(self, sid: str, title: str) -> dict:
        return deliverylib.stage(sid, "carry on", title=title, instance="temp1",
                                 evidence="the chat's own last words, long enough to verify")

    def _plan(self, only, hand_run: bool):
        """Plan (act=False) against a machine that is AT its cap, with one account holding
        far more than its share - the exact state in which an unattended run defers."""
        seen: dict[str, dict] = {}

        def fake_deliverable(entry, **kw):
            seen[entry["id"]] = kw
            return True, "", {"instance": "temp1", "title": entry["title"], "wakes": True}

        with mock.patch.object(courier, "deliverable", fake_deliverable), \
             mock.patch.object(courier.hydralib, "running_count",
                               return_value=courier.hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(courier.hydralib, "sessions", return_value=[]), \
             mock.patch.object(courier.hydralib, "running_by_instance",
                               return_value=(set(), {"temp1": 99})), \
             mock.patch.object(courier.hydralib, "fleet",
                               return_value={"instances": [{"name": "temp1", "isRunning": True}]}), \
             mock.patch.object(courier.bandlib, "snapshot", return_value={}), \
             mock.patch.object(courier.holdlib, "_load", return_value={}), \
             mock.patch.object(courier.ledgerlib, "_load", return_value=[]):
            report = courier.run(1, only, act=False, hand_run=hand_run)
        return report, seen

    def test_named_rows_only_and_all_of_them_even_past_max(self):
        a = self._stage("s1", "one")
        b = self._stage("s2", "two")
        c = self._stage("s3", "three")
        report, seen = self._plan({a["id"], b["id"]}, hand_run=True)
        self.assertEqual({p["id"] for p in report["planned"]}, {a["id"], b["id"]},
                         "both named rows are planned although --max was 1")
        self.assertNotIn(c["id"], seen, "an unnamed row is never touched by a hand-run")
        self.assertEqual(report["skipped"], [])

    def test_hand_run_switches_off_the_share_gate(self):
        a = self._stage("s1", "one")
        _, seen = self._plan({a["id"]}, hand_run=True)
        self.assertIsNone(seen[a["id"]]["_share"], "no per-account share for a person's delivery")

    def test_unattended_run_keeps_the_cap(self):
        """The machine is at MAX_RUNNING_CHATS: an unattended wake must still defer."""
        self._stage("s1", "one")
        report, seen = self._plan(None, hand_run=False)
        self.assertEqual(report["planned"], [])
        self.assertEqual(seen, {}, "the cheap half of the cap refuses before the gate is paid")
        self.assertTrue(any("concurrency cap" in s["why"] for s in report["skipped"]))

    def test_a_string_only_still_works_for_older_callers(self):
        a = self._stage("s1", "one")
        report, _ = self._plan(a["id"], hand_run=True)
        self.assertEqual([p["id"] for p in report["planned"]], [a["id"]])


if __name__ == "__main__":
    unittest.main()
