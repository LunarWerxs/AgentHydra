"""armlib: the armed window that gates every unattended act (owner order, 2026-09-01) -
duration parsing, the arm/status/disarm round-trip, and refuse_unless_armed's contract."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import armlib  # noqa: E402

T0 = 1_788_000_000_000  # an arbitrary fixed 'now', ms


class ParseDurationTest(unittest.TestCase):
    def test_hours(self):
        self.assertEqual(armlib.parse_duration("4h"), 14400)

    def test_minutes(self):
        self.assertEqual(armlib.parse_duration("90m"), 5400)

    def test_days(self):
        self.assertEqual(armlib.parse_duration("2d"), 172800)

    def test_seconds(self):
        self.assertEqual(armlib.parse_duration("30s"), 30)

    def test_bare_number_is_minutes(self):
        self.assertEqual(armlib.parse_duration("15"), 900)

    def test_invalid_raises(self):
        with self.assertRaises(ValueError):
            armlib.parse_duration("not-a-duration")

    def test_zero_raises(self):
        with self.assertRaises(ValueError):
            armlib.parse_duration("0h")

    def test_negative_raises(self):
        with self.assertRaises(ValueError):
            armlib.parse_duration("-4h")


class ArmStatusDisarmTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_no_file_is_disarmed(self):
        st = armlib.status(now_ms=T0)
        self.assertFalse(st["armed"])
        self.assertEqual(st["remainingSecs"], 0)
        self.assertIn("tray icon", st["why"])  # the icon is the switch; no icon = disarmed

    def test_arm_then_status_is_armed_with_remaining_time(self):
        armlib.arm(3600, by="owner", note="go manage the fleet", now_ms=T0)
        st = armlib.status(now_ms=T0 + 10_000)
        self.assertTrue(st["armed"])
        self.assertEqual(st["remainingSecs"], 3590)
        self.assertEqual(st["by"], "owner")
        self.assertEqual(st["note"], "go manage the fleet")

    def test_armed_helper_matches_status(self):
        armlib.arm(60, now_ms=T0)
        self.assertTrue(armlib.armed(now_ms=T0 + 1000))
        self.assertFalse(armlib.armed(now_ms=T0 + 61_000))

    def test_expired_window_reads_as_disarmed_with_a_reason(self):
        armlib.arm(60, by="owner", now_ms=T0)
        st = armlib.status(now_ms=T0 + 120_000)
        self.assertFalse(st["armed"])
        self.assertIn("expired", st["why"])
        self.assertIn("owner", st["why"])

    def test_disarm_clears_an_active_window(self):
        armlib.arm(3600, now_ms=T0)
        self.assertTrue(armlib.armed(now_ms=T0 + 10))
        armlib.disarm()
        self.assertFalse(armlib.armed(now_ms=T0 + 10))

    def test_disarm_on_an_already_clear_state_is_a_no_op(self):
        st = armlib.disarm()
        self.assertFalse(st["armed"])

    def test_re_arming_replaces_the_previous_window(self):
        armlib.arm(60, by="first", now_ms=T0)
        armlib.arm(3600, by="second", now_ms=T0)
        st = armlib.status(now_ms=T0 + 61_000)
        self.assertTrue(st["armed"])
        self.assertEqual(st["by"], "second")


class RefuseUnlessArmedTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_disarmed_by_default_refuses(self):
        got = armlib.refuse_unless_armed([], "doing the thing")
        self.assertIsInstance(got, str)
        self.assertIn("DISARMED", got)
        self.assertIn("doing the thing", got)

    def test_force_bypasses_the_window(self):
        self.assertIsNone(armlib.refuse_unless_armed(["--force"], "doing the thing"))

    def test_an_open_window_allows_the_act(self):
        armlib.arm(3600)
        self.assertIsNone(armlib.refuse_unless_armed([], "doing the thing"))

    def test_an_expired_window_still_refuses(self):
        armlib.arm(1)
        import time

        time.sleep(1.1)
        got = armlib.refuse_unless_armed([], "doing the thing")
        self.assertIsInstance(got, str)
        self.assertIn("DISARMED", got)


if __name__ == "__main__":
    unittest.main()
