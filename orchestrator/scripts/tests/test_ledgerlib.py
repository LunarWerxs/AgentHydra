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

    # --- never claim an act landed without checking (orchestrator rule 4) -----------------

    def test_verify_true_marks_the_latest_row_confirmed(self):
        ledgerlib.note("archive", "s1", now_ms=T0)
        ledgerlib.verify("archive", "s1", True, now_ms=T0 + 1)
        rows = ledgerlib._load()
        self.assertEqual(rows[-1]["verified"], True)
        self.assertNotIn(("archive", "s1"), {(r["kind"], r["session"]) for r in ledgerlib.unverified(now_ms=T0 + 2)})

    def test_verify_false_is_recorded_and_counts_as_a_failed_attempt(self):
        # A read-back that DISAGREES: the row note() already opened gets the verdict, not a
        # second row (that would trip the breaker at half its intended count).
        ledgerlib.note("rename", "s1", now_ms=T0)
        ledgerlib.verify("rename", "s1", False, note="dossier still shows the old title", now_ms=T0 + 1)
        rows = ledgerlib._load()
        self.assertEqual(len(rows), 1)  # no second row
        self.assertEqual(rows[-1]["verified"], False)
        self.assertEqual(rows[-1]["verify_note"], "dossier still shows the old title")
        uq = ledgerlib.unverified(now_ms=T0 + 2)
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["status"], "false")

    def test_verify_unknown_never_reads_as_success_and_surfaces_in_the_judgment_queue(self):
        # The read-back itself could not be performed - genuinely unknown, never a confirmed
        # disagreement and never silently treated as success either.
        ledgerlib.note("migrate", "s1", now_ms=T0)
        ledgerlib.verify("migrate", "s1", None, note="verify read-back failed: daemon down", now_ms=T0 + 1)
        rows = ledgerlib._load()
        self.assertIsNone(rows[-1]["verified"])
        uq = ledgerlib.unverified(now_ms=T0 + 2)
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["kind"], "migrate")
        self.assertEqual(uq[0]["status"], "unknown")
        self.assertIn("daemon down", uq[0]["verify_note"])

    def test_an_act_that_never_calls_verify_is_also_unknown(self):
        # No read-back path at all (verify() never called): absence of positive evidence is
        # not evidence of success. Must show up in the judgment queue exactly like an explicit
        # verified=None, not silently pass as if nothing needed checking.
        ledgerlib.note("compact", "s1", now_ms=T0)
        uq = ledgerlib.unverified(now_ms=T0 + 2)
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["status"], "unknown")

    def test_verify_never_retries_by_itself_and_unknown_outlives_a_confirmed_neighbour(self):
        # verify(None, ...) must never call clear() or otherwise reset the breaker - that would
        # be silently re-arming a retry on an outcome nobody confirmed.
        for i in range(ledgerlib.ATTEMPT_CAP):
            ledgerlib.note("archive", "s1", now_ms=T0 + i)
        ledgerlib.verify("archive", "s1", None, now_ms=T0 + ledgerlib.ATTEMPT_CAP)
        v = ledgerlib.check("archive", "s1", now_ms=T0 + ledgerlib.ATTEMPT_CAP + 1)
        self.assertTrue(v["suppressed"])  # still suppressed - verify() alone changed nothing here

    def test_verify_on_a_kind_with_no_open_row_still_gets_recorded(self):
        # A caller that verifies something note() never opened a row for (a legitimate shape:
        # some acts may only ever call verify()) must not have the unknown verdict silently
        # dropped - that is exactly the outcome this doctrine cares most about preserving.
        ledgerlib.verify("archive", "s9", None, note="no prior attempt row", now_ms=T0)
        uq = ledgerlib.unverified(now_ms=T0 + 1)
        self.assertEqual(len(uq), 1)
        self.assertEqual(uq[0]["session"], "s9")

    def test_verify_rejects_unknown_kind(self):
        with self.assertRaises(ValueError):
            ledgerlib.verify("frobnicate", "s1", True, now_ms=T0)

    def test_verify_rejects_non_bool_non_none(self):
        with self.assertRaises(TypeError):
            ledgerlib.verify("archive", "s1", "yes", now_ms=T0)  # type: ignore[arg-type]

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
