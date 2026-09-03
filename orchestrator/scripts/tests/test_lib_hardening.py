"""Hardening pins for the `lib` group's 2026-09-01 fixes.

clilib.capture() is the one chokepoint every lane script (reconcile.retry,
audit_archived.restore, name_chats.name_pass, saturate.execute, ...) calls to run a child
script's main() as a step - it must never let a bug in that child take the caller's whole
sweep down with it. deliverylib's deliveries.json never pruned settled rows, so it grew
forever and every stage/mark/cancel rewrote the whole file.
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import clilib  # noqa: E402
from lib import deliverylib  # noqa: E402

SID = "cccc9999-1111-2222-3333-444455556666"
DONE_WAITING = ("Here is what I found.\n"
                 "## Am I 100% done?\n- No, the deploy step is still open.\n"
                 "Shall I go ahead and run it?")


class CaptureIsExceptionSafeTest(unittest.TestCase):
    def test_raising_fn_returns_nonzero_with_message(self):
        def boom(argv):
            raise RuntimeError("kaboom")

        code, out = clilib.capture(boom, ["--whatever"])
        self.assertNotEqual(code, 0)
        self.assertIn("unhandled exception", out)
        self.assertIn("boom", out)  # names the offending fn, not just "something broke"
        self.assertIn("kaboom", out)

    def test_normal_fn_is_unaffected(self):
        def ok(argv):
            print("all good")
            return 0

        code, out = clilib.capture(ok, [])
        self.assertEqual(code, 0)
        self.assertEqual(out, "all good")


class DeliverylibPruneTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def _row(self, state, *, staged_at, delivered_at=None, session=SID):
        return {
            "id": f"row-{state}-{staged_at}",
            "session": session,
            "title": "t",
            "instance": "i",
            "text": "hi",
            "verifyText": "hi",
            "evidence": "",
            "by": "ai",
            "stagedAt": staged_at,
            "state": state,
            "attempts": 0,
            "deliveredAt": delivered_at,
            "lastError": None,
        }

    def test_old_settled_rows_are_pruned_on_save(self):
        now_ms = int(time.time() * 1000)
        old = now_ms - (deliverylib.PRUNE_AFTER_SECS + 3600) * 1000
        recent = now_ms - 3600 * 1000
        rows = [
            self._row("delivered", staged_at=old - 1000, delivered_at=old),
            self._row("failed", staged_at=old),  # never got a deliveredAt
            self._row("cancelled", staged_at=old),
            self._row("delivered", staged_at=recent - 1000, delivered_at=recent),
            self._row("staged", staged_at=old),  # ancient but STILL staged - never pruned
        ]
        deliverylib._save(rows)

        kept_states = sorted(r["state"] for r in deliverylib._load())
        self.assertEqual(kept_states, ["delivered", "staged"])

    def test_prune_does_not_disturb_recent_delivery_lookups(self):
        e = deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        deliverylib.mark_delivered(e["id"])
        # A second, unrelated save (e.g. another chat's stage) must not prune the row we just
        # delivered a second ago - it is nowhere near PRUNE_AFTER_SECS old.
        deliverylib.stage("other-session", "go", evidence=DONE_WAITING)
        self.assertIsNotNone(
            deliverylib.recent_delivery(SID, within_secs=overlord_recent_secs())
        )

    def test_save_is_atomic_no_tmp_left_behind(self):
        deliverylib.stage(SID, "go", evidence=DONE_WAITING)
        state_dir = Path(self._tmp.name)
        leftovers = list(state_dir.glob("deliveries.json.*.tmp"))
        self.assertEqual(leftovers, [])
        self.assertTrue((state_dir / "deliveries.json").exists())
        # and the file is valid JSON, i.e. os.replace landed a whole write, not a partial one
        json.loads((state_dir / "deliveries.json").read_text(encoding="utf-8"))


def overlord_recent_secs() -> int:
    # Mirrors overlord.RECENT_DELIVERY_SECS without importing overlord (out of this group's
    # file list) - the value is small (180s) and pinned there; this test just needs "recent".
    return 180


if __name__ == "__main__":
    unittest.main()
