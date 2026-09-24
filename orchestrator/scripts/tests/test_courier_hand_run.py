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
import json
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

from util import run_cli  # noqa: E402

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


class NamedRowNotStagedTest(unittest.TestCase):
    """⛔ A NAMED ID MUST NEVER VANISH FROM THE REPORT (found live 2026-09-12).

    run()'s queue is deliverylib.pending() - STAGED rows only - filtered to the --only ids, so
    a named row in ANY other state simply fell out of the list and the report printed the
    generic "nothing staged - the courier has nothing to deliver". Over a row that had just
    been burned to `failed` on one refusal, that reads as "already delivered", which is the
    opposite of the truth; a `delivered` row and a typo'd id printed it too, and those three
    need three different answers. The state is named outright now, and it is an exit-2 answer.

    These run with an EMPTY queue on purpose, so run() never reaches a daemon call.
    """

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _stage(self, sid: str = "s1", title: str = "A waiting chat") -> dict:
        return deliverylib.stage(sid, "carry on", title=title, instance="temp1",
                                 evidence="the chat's own last words, long enough to verify")

    def _only(self, *ids):
        """Plan the named ids with every daemon read stubbed out.

        ⛔ NO TEST HERE MAY TOUCH A DAEMON. Most of these run with an EMPTY queue, so run()
        never enters its planning loop and reaches nothing - but the two that stage a
        deliverable row do, and an unmocked hydralib.sessions() then goes to the network:
        green against the LIVE daemon on a developer's machine, and a hard error in CI or
        after CourierRailTest, which points hydralib.BASE at a stub it has already closed.
        Same stack as HandRunPlanningTest._plan, which is where this shape comes from.
        """
        with mock.patch.object(courier, "deliverable",
                               lambda entry, **kw: (True, "", {"instance": "temp1",
                                                               "title": entry["title"],
                                                               "wakes": False})), \
             mock.patch.object(courier.hydralib, "running_count", return_value=0), \
             mock.patch.object(courier.hydralib, "sessions", return_value=[]), \
             mock.patch.object(courier.hydralib, "running_by_instance",
                               return_value=(set(), {})), \
             mock.patch.object(courier.hydralib, "fleet",
                               return_value={"instances": [{"name": "temp1",
                                                            "isRunning": True}]}), \
             mock.patch.object(courier.bandlib, "snapshot", return_value={}), \
             mock.patch.object(courier.holdlib, "_load", return_value={}), \
             mock.patch.object(courier.ledgerlib, "_load", return_value=[]):
            return courier.run(5, set(ids), act=False, hand_run=True)

    def test_a_failed_row_is_named_with_its_state_its_attempts_and_its_reason(self):
        e = self._stage()
        deliverylib.note_attempt(e["id"])
        deliverylib.mark_failed(e["id"], "peer channel did not confirm on a chat mid-turn")
        report = self._only(e["id"])
        self.assertEqual(report["staged"], 0)
        self.assertEqual([n["id"] for n in report["notStaged"]], [e["id"]])
        got = report["notStaged"][0]
        self.assertEqual(got["state"], "failed")
        self.assertEqual(got["title"], "A waiting chat")
        self.assertIn("failed after 1 attempt(s)", got["why"])
        self.assertIn("mid-turn", got["why"], "the reason is the whole point of saying failed")

    def test_a_delivered_row_says_delivered_rather_than_nothing_staged(self):
        e = self._stage()
        deliverylib.mark_delivered(e["id"])
        got = self._only(e["id"])["notStaged"][0]
        self.assertEqual(got["state"], "delivered")
        self.assertIn("already delivered", got["why"])

    def test_a_cancelled_row_says_a_person_withdrew_it(self):
        e = self._stage()
        deliverylib.cancel(e["id"])
        got = self._only(e["id"])["notStaged"][0]
        self.assertEqual(got["state"], "cancelled")
        self.assertIn("cancelled", got["why"])

    def test_an_expired_row_carries_the_reason_it_ended(self):
        e = self._stage()
        deliverylib.expire(e["id"], "its premise went void - the chat changed accounts")
        got = self._only(e["id"])["notStaged"][0]
        self.assertEqual(got["state"], "expired")
        self.assertIn("premise went void", got["why"])

    def test_an_id_that_does_not_exist_says_so_instead_of_nothing_staged(self):
        got = self._only("deadbeef0000")["notStaged"][0]
        self.assertIsNone(got["state"])
        self.assertEqual(got["why"], "no such delivery id")

    def test_a_staged_row_is_in_the_queue_and_never_in_notStaged(self):
        e = self._stage()
        report = self._only(e["id"])
        self.assertEqual(report["notStaged"], [])
        self.assertEqual(report["staged"], 1)

    def test_one_named_row_missing_beside_one_deliverable_reports_both(self):
        good = self._stage("s1", "one")
        gone = self._stage("s2", "two")
        deliverylib.mark_failed(gone["id"], "the composer refused")
        report = self._only(good["id"], gone["id"])
        self.assertEqual(report["staged"], 1)
        self.assertEqual([n["id"] for n in report["notStaged"]], [gone["id"]])

    def test_an_unnamed_run_never_reports_notStaged(self):
        """`only` is None: nothing was named, so nothing can be missing."""
        e = self._stage()
        deliverylib.mark_failed(e["id"], "the composer refused")
        self.assertEqual(courier.run(5, None, act=False)["notStaged"], [])


class NamedRowNotStagedCliTest(unittest.TestCase):
    """The same defect at the layer a PERSON actually meets it: the printed line and the code.

    `courier --yes --only <id>` on a burned row exited 0 with the words "nothing staged",
    which is success in this CLI's own contract (see the module docstring's Exit line).
    """

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _stage(self) -> dict:
        return deliverylib.stage("s1", "carry on", title="A waiting chat", instance="temp1",
                                 evidence="the chat's own last words, long enough to verify")

    def test_the_generic_nothing_staged_line_is_replaced_by_the_real_state(self):
        e = self._stage()
        deliverylib.note_attempt(e["id"])
        deliverylib.mark_failed(e["id"], "peer channel did not confirm on a chat mid-turn")
        code, out, _ = run_cli(courier.main, ["--yes", "--only", e["id"]])
        self.assertEqual(code, 2, "a named row that did not land is never exit 0")
        self.assertIn("NOT STAGED", out)
        self.assertIn("failed after 1 attempt(s)", out)
        self.assertNotIn("nothing staged", out)

    def test_a_typod_id_is_refused_by_name(self):
        code, out, _ = run_cli(courier.main, ["--yes", "--only", "deadbeef0000"])
        self.assertEqual(code, 2)
        self.assertIn("no such delivery id", out)
        self.assertNotIn("nothing staged", out)

    def test_a_genuinely_empty_queue_still_says_nothing_staged(self):
        """The rail that must NOT have moved: with nothing named, the old line is correct."""
        code, out, _ = run_cli(courier.main, [])
        self.assertEqual(code, 0)
        self.assertIn("nothing staged", out)

    def test_the_json_report_carries_notStaged_for_a_scripted_caller(self):
        e = self._stage()
        deliverylib.mark_delivered(e["id"])
        code, out, _ = run_cli(courier.main, ["--yes", "--only", e["id"], "--json"])
        self.assertEqual(code, 2)
        got = json.loads(out)["notStaged"]
        self.assertEqual([n["state"] for n in got], ["delivered"])


if __name__ == "__main__":
    unittest.main()
