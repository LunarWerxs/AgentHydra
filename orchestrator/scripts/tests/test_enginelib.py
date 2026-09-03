"""enginelib: an IDLE engine may be stopped deliberately; a working or stuck one never.

Live smoke, 2026-09-01: the desktop keeps a chat's engine alive indefinitely after the turn
ends, so migrate's "live writer refuses" rule meant no desktop chat could ever move. The
owner's line is "only chats that are stopped, waiting, chilling" - so these pin exactly where
that line sits: a completed turn plus IDLE_STOP_SECS of quiet, confirmed gone by the daemon
before anyone acts; anything mid-turn, stuck, un-gateable, or merely briefly quiet stays."""

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import enginelib  # noqa: E402
from lib import gatelib  # noqa: E402
from lib import hydralib  # noqa: E402

MATCH = {"cliSessionId": "sid-1", "title": "T", "instance": "a", "live": {"pid": 4242}}


def _verdict(state="running", idle=None, stalled=None, cause="alive"):
    return {"state": state, "idle": idle, "stalled": stalled, "cause": cause, "live": {"pid": 4242}}


class IdleVerdictTest(unittest.TestCase):
    def test_no_live_block_means_nothing_to_stop(self):
        idle, why = enginelib.idle_verdict({**MATCH, "live": None})
        self.assertFalse(idle)
        self.assertIn("nothing to stop", why)

    def test_a_completed_turn_quiet_past_the_window_is_idle(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 900})):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertTrue(idle)
        self.assertIn("quiet 900s", why)

    def test_quiet_for_less_than_the_window_is_not_idle_yet(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 120})):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertFalse(idle)
        self.assertIn("giving it time", why)

    def test_a_working_engine_is_never_idle(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(cause="alive (quiet 12s)")):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertFalse(idle)
        self.assertIn("may be working", why)

    def test_a_stuck_engine_is_a_persons_call(self):
        with mock.patch.object(gatelib, "gate_match",
                               return_value=_verdict(idle={"quiet_secs": 9999}, stalled={"why": "shell call unanswered"})):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertFalse(idle)
        self.assertIn("STUCK", why)

    def test_an_ungateable_transcript_never_stops_blind(self):
        with mock.patch.object(gatelib, "gate_match", return_value=None):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertFalse(idle)
        self.assertIn("blind", why)

    def test_a_daemon_failure_never_stops_blind(self):
        with mock.patch.object(gatelib, "gate_match", side_effect=hydralib.DaemonError("/x", None, "down")):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertFalse(idle)
        self.assertIn("blind", why)


class StopIdleEngineTest(unittest.TestCase):
    def test_refuses_without_touching_the_process_when_not_idle(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 10})), \
             mock.patch.object(enginelib.subprocess, "run") as run:
            got = enginelib.stop_idle_engine(MATCH)
        self.assertFalse(got["stopped"])
        run.assert_not_called()

    def test_stops_the_tree_and_confirms_through_the_daemon(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 900})), \
             mock.patch.object(enginelib.subprocess, "run") as run, \
             mock.patch.object(hydralib, "live_for", return_value=None), \
             mock.patch.object(enginelib.time, "sleep"):
            got = enginelib.stop_idle_engine(MATCH)
        self.assertTrue(got["stopped"])
        self.assertEqual(got["pid"], 4242)
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["taskkill", "/PID", "4242"])
        self.assertIn("/T", args)

    def test_an_unconfirmed_stop_is_reported_as_not_stopped(self):
        clock = {"t": 0.0}

        def fake_time():
            clock["t"] += 5.0
            return clock["t"]

        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 900})), \
             mock.patch.object(enginelib.subprocess, "run"), \
             mock.patch.object(hydralib, "live_for", return_value={"pid": 4242}), \
             mock.patch.object(enginelib.time, "sleep"), \
             mock.patch.object(enginelib.time, "time", side_effect=fake_time):
            got = enginelib.stop_idle_engine(MATCH)
        self.assertFalse(got["stopped"])
        self.assertIn("still lists the chat as live", got["why"])


class IdleReportReasonTest(unittest.TestCase):
    """The reason CODE is the half a caller may branch on; the prose is for humans.

    --idle-wait sleeps on exactly one code (R_TOO_SOON) and must fall straight through on
    every other. If a refusal that time cannot cure ever came back wearing R_TOO_SOON, a
    waiting caller would sit on a STUCK engine for its whole budget and then refuse anyway -
    so these pin the mapping, and pin that ONLY the waitable code carries a deadline."""

    def test_too_soon_is_the_only_code_that_carries_a_deficit(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 120})):
            rep = enginelib.idle_report(MATCH)
        self.assertEqual(rep["reason"], enginelib.R_TOO_SOON)
        self.assertEqual(rep["quiet_secs"], 120)
        self.assertEqual(rep["needs_secs"], enginelib.IDLE_STOP_SECS)
        self.assertFalse(rep["idle"])

    def test_a_stuck_engine_is_never_waitable(self):
        with mock.patch.object(gatelib, "gate_match",
                               return_value=_verdict(idle={"quiet_secs": 9999},
                                                     stalled={"why": "shell call unanswered"})):
            rep = enginelib.idle_report(MATCH)
        self.assertEqual(rep["reason"], enginelib.R_STUCK)
        self.assertIsNone(rep["needs_secs"])

    def test_a_working_engine_is_never_waitable(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(cause="alive (quiet 12s)")):
            rep = enginelib.idle_report(MATCH)
        self.assertEqual(rep["reason"], enginelib.R_WORKING)
        self.assertIsNone(rep["needs_secs"])

    def test_unreadable_and_ungateable_are_their_own_codes(self):
        with mock.patch.object(gatelib, "gate_match", return_value=None):
            self.assertEqual(enginelib.idle_report(MATCH)["reason"], enginelib.R_UNGATEABLE)
        with mock.patch.object(gatelib, "gate_match", side_effect=hydralib.DaemonError("/x", None, "down")):
            self.assertEqual(enginelib.idle_report(MATCH)["reason"], enginelib.R_UNREADABLE)
        self.assertEqual(enginelib.idle_report({**MATCH, "live": None})["reason"], enginelib.R_NO_ENGINE)

    def test_idle_verdict_still_answers_the_old_two_tuple(self):
        """Every existing caller (groundskeeper, the lanes) unpacks two values."""
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 900})):
            idle, why = enginelib.idle_verdict(MATCH)
        self.assertTrue(idle)
        self.assertIn("quiet 900s", why)

    def test_a_refusal_from_stop_idle_engine_carries_the_code(self):
        with mock.patch.object(gatelib, "gate_match", return_value=_verdict(idle={"quiet_secs": 40})):
            got = enginelib.stop_idle_engine(MATCH)
        self.assertFalse(got["stopped"])
        self.assertEqual(got["reason"], enginelib.R_TOO_SOON)
        self.assertEqual(got["needs_secs"] - got["quiet_secs"], enginelib.IDLE_STOP_SECS - 40)


if __name__ == "__main__":
    unittest.main()
