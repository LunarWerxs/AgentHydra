"""The attempt ledger: cap, window, deterministic fast-stop, success-clears, loud suppression."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import ledgerlib  # noqa: E402

T0 = 1_788_000_000_000  # an arbitrary fixed 'now', ms


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_fresh_chat_is_not_suppressed(self):
        v = ledgerlib.check("archive", "s1", now_ms=T0)
        self.assertFalse(v["suppressed"])
        self.assertEqual(v["attempts"], 0)

    def test_cap_suppresses_at_four_and_says_why(self):
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
            # one row per attempt even in the same millisecond-ish burst
        v = ledgerlib.check("archive", "s1", now_ms=T0 + 10)
        self.assertTrue(v["suppressed"])
        self.assertEqual(v["attempts"], ledgerlib.ATTEMPT_CAP)
        self.assertIn("without sticking", v["why"])
        self.assertEqual(v["retry_after"], T0 + ledgerlib.ATTEMPT_WINDOW_MS)

    def test_below_cap_is_allowed(self):
        for i in range(ledgerlib.ATTEMPT_CAP - 1):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        self.assertFalse(ledgerlib.check("archive", "s1", now_ms=T0 + 10)["suppressed"])

    def test_window_slides_old_attempts_out(self):
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        later = T0 + ledgerlib.ATTEMPT_WINDOW_MS + 1000
        self.assertFalse(ledgerlib.check("archive", "s1", now_ms=later)["suppressed"])

    def test_deterministic_refusal_stops_after_one(self):
        ledgerlib.note("archive", "s1", deterministic=True, note="two rows share this title", now_ms=T0)
        v = ledgerlib.check("archive", "s1", now_ms=T0 + 1)
        self.assertTrue(v["suppressed"])
        self.assertTrue(v["deterministic"])
        self.assertIn("two rows share this title", v["why"])

    def test_success_clears_the_count(self):
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        ledgerlib.clear("archive", "s1")
        self.assertFalse(ledgerlib.check("archive", "s1", now_ms=T0 + 10)["suppressed"])

    def test_kinds_and_sessions_are_independent(self):
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        self.assertFalse(ledgerlib.check("archive", "s2", now_ms=T0 + 10)["suppressed"])
        self.assertFalse(ledgerlib.check("rename", "s1", now_ms=T0 + 10)["suppressed"])

    def test_unknown_kind_refused(self):
        with self.assertRaises(ValueError):
            ledgerlib.note("frobnicate", "s1", now_ms=T0)

    def test_suppressed_listing_is_loud(self):
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        ledgerlib.note("rename", "s2", deterministic=True, now_ms=T0)
        rows = ledgerlib.suppressed(now_ms=T0 + 10)
        keys = {(r["kind"], r["session"]) for r in rows}
        self.assertEqual(keys, {("archive", "s1"), ("rename", "s2")})

    def test_corrupt_ledger_reads_as_empty_not_crash(self):
        p = Path(self._tmp.name) / "attempts.json"
        p.write_text("{ not json", encoding="utf-8")
        self.assertFalse(ledgerlib.check("archive", "s1", now_ms=T0)["suppressed"])

    def test_deterministic_refusal_outlives_the_window(self):
        # An ambiguous title does not stop being ambiguous because six hours passed - the row
        # leaves the ledger only through clear() (success, or a person's word).
        ledgerlib.note("archive", "s1", deterministic=True, note="title collision", now_ms=T0)
        much_later = T0 + 3 * ledgerlib.ATTEMPT_WINDOW_MS
        v = ledgerlib.check("archive", "s1", now_ms=much_later)
        self.assertTrue(v["suppressed"])
        self.assertTrue(v["deterministic"])
        # and note() pruning must not silently drop it either
        ledgerlib.note("rename", "other", now_ms=much_later)
        self.assertTrue(ledgerlib.check("archive", "s1", now_ms=much_later)["suppressed"])
        ledgerlib.clear("archive", "s1")
        self.assertFalse(ledgerlib.check("archive", "s1", now_ms=much_later)["suppressed"])

    def test_check_refuses_unknown_kind_instead_of_answering_zero(self):
        with self.assertRaises(ValueError):
            ledgerlib.check("achive", "s1", now_ms=T0)  # the typo'd read must not un-count

    def test_try_locked_default_stale_window_is_unchanged(self):
        # A held lock younger than the default 30s window is a LIVE holder's - a concurrent
        # try_locked() must back off, not steal it.
        path = ledgerlib._state_dir() / ".lock-x"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        try:
            with ledgerlib.try_locked("x") as ours:
                self.assertFalse(ours)
        finally:
            path.unlink(missing_ok=True)

    def test_try_locked_custom_stale_secs_widens_the_live_window(self):
        # An act that holds this lock for its whole duration (archive_chat's UI actuator runs
        # up to 240s) needs a wider live window than the 30s default, or a second concurrent
        # invocation decides the first one crashed and steals the lock mid-act - the exact
        # double-run the lock exists to prevent (adversarial review, 2026-09-01).
        import os as _os
        import time as _time

        path = ledgerlib._state_dir() / ".lock-y"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        stale_at = _time.time() - 60  # 60s old: stale under the 30s default...
        _os.utime(path, (stale_at, stale_at))
        try:
            # ...but a caller that knows its own act can run 300s must NOT treat 60s as dead.
            with ledgerlib.try_locked("y", stale_secs=300) as ours:
                self.assertFalse(ours)
        finally:
            path.unlink(missing_ok=True)
        # and the default (30s) still reclaims that same lock, unchanged behaviour otherwise
        path.write_bytes(b"")
        _os.utime(path, (stale_at, stale_at))
        with ledgerlib.try_locked("y") as ours:
            self.assertTrue(ours)


if __name__ == "__main__":
    unittest.main()
