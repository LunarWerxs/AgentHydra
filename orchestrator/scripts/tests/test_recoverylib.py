"""lib/recoverylib: the closed recipe table, ONE automatic attempt per (kind, subject), and the
ledger that answers "why did this escalate to me".

What is pinned here is the brake itself - the thing that stops a retry loop: a spent attempt is
never run again until a success clears it, a failed attempt escalates by the recipe's own policy
(alert-human files an incident; the others do not), a kind with no safe step never runs one, and
a step that crashes is a failed attempt rather than a traceback.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import incidentlib, recoverylib  # noqa: E402

from util import isolate_state_dir  # noqa: E402


class Step:
    """A recipe step that records how often it ran and answers a fixed outcome."""

    def __init__(self, ok: bool, detail: str = "tried"):
        self.ok, self.detail, self.calls = ok, detail, 0

    def __call__(self):
        self.calls += 1
        return self.ok, self.detail


class RecoveryLibTest(unittest.TestCase):
    def setUp(self):
        isolate_state_dir(self)

    def test_the_one_attempt_is_spent_and_never_run_again(self):
        step = Step(False, "still refused")
        first = recoverylib.attempt_recovery("delivery-failed", "fanout:g:0", step)
        self.assertEqual(step.calls, 1)
        self.assertTrue(first["attempted"])
        self.assertEqual(first["outcome"], "escalated")
        second = recoverylib.attempt_recovery("delivery-failed", "fanout:g:0", step)
        self.assertEqual(step.calls, 1)  # the retry loop this file exists to stop
        self.assertFalse(second["attempted"])
        self.assertIn("already spent", second["detail"])
        # another subject has its own attempt
        recoverylib.attempt_recovery("delivery-failed", "fanout:g:1", step)
        self.assertEqual(step.calls, 2)

    def test_a_success_clears_the_attempt(self):
        ok = Step(True, "delivered")
        row = recoverylib.attempt_recovery("delivery-failed", "s", ok)
        self.assertEqual(row["outcome"], "recovered")
        self.assertNotIn("escalation", row)
        self.assertEqual(recoverylib.attempts_used("delivery-failed", "s"), 0)
        again = Step(False)
        recoverylib.attempt_recovery("delivery-failed", "s", again)
        self.assertEqual(again.calls, 1)

    def test_a_delivered_stall_question_stays_spent_until_cleared(self):
        # asking is not recovering: without this, every recover asks a still-stalled chat again
        ok = Step(True, "asked")
        row = recoverylib.attempt_recovery("chat-stalled", "s", ok)
        self.assertEqual(row["outcome"], "asked")
        self.assertNotIn("escalation", row)
        again = recoverylib.attempt_recovery("chat-stalled", "s", ok)
        self.assertEqual(ok.calls, 1)
        self.assertEqual(again["outcome"], "escalated")
        self.assertIsNotNone(recoverylib.clear("chat-stalled", "s", "working again"))
        recoverylib.attempt_recovery("chat-stalled", "s", ok)
        self.assertEqual(ok.calls, 2)
        self.assertIsNone(recoverylib.clear("chat-stalled", "never-tried"))

    def test_alert_human_files_an_incident_and_log_and_continue_does_not(self):
        row = recoverylib.attempt_recovery("chat-stalled", "fanout:g:2", Step(False, "not asked"))
        self.assertEqual(row["escalation"], recoverylib.ALERT_HUMAN)
        incidents = incidentlib.list_incidents()
        self.assertEqual([i["id"] for i in incidents], [row["incident"]])
        self.assertEqual(incidents[0]["scope"], "recovery")
        cap = recoverylib.attempt_recovery("account-at-cap", "fanout:g:3", Step(False))
        self.assertEqual(cap["escalation"], recoverylib.LOG_AND_CONTINUE)
        self.assertNotIn("incident", cap)
        self.assertEqual(len(incidentlib.list_incidents()), 1)

    def test_a_kind_with_no_safe_step_never_runs_one_and_repeats_fold_into_one_row(self):
        step = Step(True)
        for _ in range(3):
            row = recoverylib.attempt_recovery("tray-not-armed", "stall_watch", step,
                                               context="the tray icon is down")
            self.assertEqual(row["escalation"], recoverylib.ABORT)
        self.assertEqual(step.calls, 0)
        rows = recoverylib.ledger()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["count"], 3)
        self.assertIn("the tray icon is down", rows[0]["detail"])

    def test_a_crashing_step_is_a_failed_attempt_not_a_traceback(self):
        def boom():
            raise RuntimeError("socket closed")
        row = recoverylib.attempt_recovery("delivery-failed", "x", boom)
        self.assertEqual(row["outcome"], "escalated")
        self.assertIn("socket closed", row["detail"])

    def test_the_table_is_closed(self):
        with self.assertRaises(ValueError):
            recoverylib.attempt_recovery("made-up", "x", Step(True))
        self.assertEqual(sorted(recoverylib.RECIPES),
                         ["account-at-cap", "chat-stalled", "delivery-failed", "tray-not-armed"])
        self.assertTrue(all(r["escalation"] in recoverylib.ESCALATIONS
                            for r in recoverylib.RECIPES.values()))

    def test_ledger_filters_by_subject_prefix(self):
        recoverylib.attempt_recovery("account-at-cap", "fanout:a:0", Step(False))
        recoverylib.attempt_recovery("account-at-cap", "fanout:b:0", Step(False))
        self.assertEqual([r["subject"] for r in recoverylib.ledger("fanout:a:")], ["fanout:a:0"])


if __name__ == "__main__":
    unittest.main()
