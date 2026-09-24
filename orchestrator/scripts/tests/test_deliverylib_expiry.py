"""A staged reply now has an END: a shelf life, a deferral ceiling, and a void premise.

Found 2026-09-07, reproduced 09-09, fixed 09-10. The queue held 37 staged rows, the oldest
5.9 days, and three of them were migration notices reading exactly backwards after their
chats were migrated back the other way - arming the tray would have delivered a batch of
statements that were no longer true. Alongside them sat 42 `failed` rows, 41 with a single
attempt, nearly all of them a closed target app or a dropped socket: deliveries that never
happened, recorded as deliveries that went wrong.

The rule these tests hold down: a staged reply is never SILENTLY dropped (that is what
_prune deliberately refuses to do), but it does not live forever either - it ends in
`expired`, readable, with the reason on the row.
"""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import deliverylib  # noqa: E402

SID = "eeee1111-2222-3333-4444-555566667777"
EVIDENCE = "Here is the state of it. Shall I carry on with the next step?"


class StagedReplyExpiryTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(self._state.cleanup)
        self.addCleanup(lambda: os.environ.pop("ORCHESTRATOR_STATE_DIR", None))

    def _stage(self, **kw):
        return deliverylib.stage(SID, kw.pop("text", "Carry on."), title="A chat",
                                 instance="temp1", evidence=EVIDENCE, **kw)

    def test_a_fresh_row_is_pending_and_a_stale_one_is_not(self):
        now = int(time.time() * 1000)
        fresh = self._stage()
        stale = deliverylib.stage(SID, "an old decision", title="A chat", instance="temp1",
                                  evidence=EVIDENCE,
                                  now_ms=now - (deliverylib.STAGED_TTL_SECS + 60) * 1000)
        ids = [r["id"] for r in deliverylib.pending(now_ms=now)]
        self.assertIn(fresh["id"], ids)
        self.assertNotIn(stale["id"], ids)

    def test_an_expired_row_is_KEPT_and_carries_its_reason(self):
        """Never a delete: _prune leaves staged rows alone precisely so a decision nobody acted
        on cannot silently disappear, and expiry must not become a back door to the same thing."""
        now = int(time.time() * 1000)
        stale = deliverylib.stage(SID, "an old decision", title="A chat", instance="temp1",
                                  evidence=EVIDENCE,
                                  now_ms=now - (deliverylib.STAGED_TTL_SECS + 60) * 1000)
        deliverylib.pending(now_ms=now)
        row = deliverylib.get(stale["id"])
        self.assertIsNotNone(row)
        self.assertEqual(row["state"], "expired")
        self.assertIn("shelf life", row["lastError"])
        self.assertEqual(row["text"], "an old decision")   # the decision itself is still readable

    def test_expiry_never_touches_a_settled_row(self):
        now = int(time.time() * 1000)
        done = deliverylib.stage(SID, "already sent", title="A chat", instance="temp1",
                                 evidence=EVIDENCE,
                                 now_ms=now - (deliverylib.STAGED_TTL_SECS + 60) * 1000)
        deliverylib.mark_delivered(done["id"])
        deliverylib.pending(now_ms=now)
        self.assertEqual(deliverylib.get(done["id"])["state"], "delivered")

    def test_a_deferral_keeps_the_row_staged_and_counts(self):
        """The 409/10054 shape. `failed` burned the row and the next cycle staged a new one -
        a headstone per closed app instead of one row retried."""
        e = self._stage()
        deliverylib.defer(e["id"], "HTTP 409 instance 'temp1' is not running")
        row = deliverylib.get(e["id"])
        self.assertEqual(row["state"], "staged")
        self.assertEqual(row["deferrals"], 1)
        self.assertIn("not running", row["lastError"])
        self.assertIn(e["id"], [r["id"] for r in deliverylib.pending()])

    def test_deferrals_stop_at_the_ceiling_and_expire_with_the_reason(self):
        e = self._stage()
        for _ in range(deliverylib.MAX_DEFERRALS):
            deliverylib.defer(e["id"], "HTTP 409 instance 'temp1' is not running")
        row = deliverylib.get(e["id"])
        self.assertEqual(row["state"], "expired")
        self.assertIn("deferred", row["lastError"])
        self.assertNotIn(e["id"], [r["id"] for r in deliverylib.pending()])

    def test_requeue_restarts_the_clock_or_it_is_a_silent_no_op(self):
        """A row keeps its original stagedAt, so a requeue that did not reset it would be
        expired again by the very next pending() - the person told "requeued", nothing sent."""
        now = int(time.time() * 1000)
        old = deliverylib.stage(SID, "an old decision", title="A chat", instance="temp1",
                                evidence=EVIDENCE,
                                now_ms=now - (deliverylib.STAGED_TTL_SECS + 60) * 1000)
        deliverylib.pending(now_ms=now)                      # expires it
        self.assertEqual(deliverylib.get(old["id"])["state"], "expired")
        deliverylib.requeue(old["id"], now_ms=now)
        self.assertIn(old["id"], [r["id"] for r in deliverylib.pending(now_ms=now)])

    def test_requeue_clears_the_deferral_count(self):
        e = self._stage()
        for _ in range(3):
            deliverylib.defer(e["id"], "HTTP 409 instance 'temp1' is not running")
        deliverylib.mark_failed(e["id"], "gave up")
        deliverylib.requeue(e["id"])
        self.assertEqual(deliverylib.get(e["id"])["deferrals"], 0)

    def test_requeue_refuses_a_delivered_row(self):
        e = self._stage()
        deliverylib.mark_delivered(e["id"])
        self.assertIsNone(deliverylib.requeue(e["id"]))

    def test_expire_refuses_a_row_that_is_no_longer_staged(self):
        """A person's cancel, or a delivery that landed, outranks a sweep planning from an
        older read - the same only_from discipline every other transition uses."""
        e = self._stage()
        deliverylib.mark_delivered(e["id"])
        self.assertIsNone(deliverylib.expire(e["id"], "too old"))
        self.assertEqual(deliverylib.get(e["id"])["state"], "delivered")


if __name__ == "__main__":
    unittest.main()
