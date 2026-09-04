"""The incident ledger: signature stability, dedup count, reopen-on-changed-error, ack/resolve,
the wiring from ledgerlib.note/annotate, and the sweep.py shared-cause breaker."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import incidentlib, ledgerlib  # noqa: E402


class IncidentLibTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_signature_is_stable_for_the_same_scope_key_and_error(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "boom: connection refused")
        id2, _ = incidentlib.upsert_incident("archive", "s1", "boom: connection refused")
        self.assertEqual(id1, id2)

    def test_signature_differs_by_scope(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "boom")
        id2, _ = incidentlib.upsert_incident("migrate", "s1", "boom")
        self.assertNotEqual(id1, id2)

    def test_signature_differs_by_key(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "boom")
        id2, _ = incidentlib.upsert_incident("archive", "s2", "boom")
        self.assertNotEqual(id1, id2)

    def test_signature_ignores_whitespace_and_case(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "Boom:  Connection\nRefused")
        id2, _ = incidentlib.upsert_incident("archive", "s1", "boom: connection refused")
        self.assertEqual(id1, id2)

    def test_repeat_dedups_into_one_row_and_counts_occurrences(self):
        for _ in range(4):
            incidentlib.upsert_incident("archive", "s1", "same cause")
        rows = incidentlib.list_incidents()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["count"], 4)

    def test_second_upsert_is_not_new(self):
        _, is_new1 = incidentlib.upsert_incident("archive", "s1", "boom")
        _, is_new2 = incidentlib.upsert_incident("archive", "s1", "boom")
        self.assertTrue(is_new1)
        self.assertFalse(is_new2)

    def test_a_changed_error_mints_a_new_incident_reopen_by_new_cause(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "cause A")
        incidentlib.resolve_incident(id1)
        # a DIFFERENT cause on the same (scope, key) is a fresh incident, open by default -
        # this is how a resolved signature "reopens": not the old id coming back, a new one
        id2, is_new = incidentlib.upsert_incident("archive", "s1", "cause B")
        self.assertNotEqual(id1, id2)
        self.assertTrue(is_new)
        self.assertEqual(incidentlib.get_incident(id2)["state"], "open")
        # and the old one is untouched - still resolved
        self.assertEqual(incidentlib.get_incident(id1)["state"], "resolved")

    def test_resolved_incident_stays_resolved_on_the_same_recurring_cause(self):
        id1, _ = incidentlib.upsert_incident("archive", "s1", "cause A")
        incidentlib.resolve_incident(id1)
        id2, is_new = incidentlib.upsert_incident("archive", "s1", "cause A")
        self.assertEqual(id1, id2)
        self.assertFalse(is_new)
        self.assertEqual(incidentlib.get_incident(id1)["state"], "resolved")

    def test_ack_transitions_open_to_acked(self):
        incident_id, _ = incidentlib.upsert_incident("archive", "s1", "boom")
        self.assertTrue(incidentlib.ack_incident(incident_id))
        self.assertEqual(incidentlib.get_incident(incident_id)["state"], "acked")

    def test_ack_is_a_noop_when_already_acked(self):
        incident_id, _ = incidentlib.upsert_incident("archive", "s1", "boom")
        incidentlib.ack_incident(incident_id)
        self.assertFalse(incidentlib.ack_incident(incident_id))

    def test_ack_refused_once_resolved(self):
        incident_id, _ = incidentlib.upsert_incident("archive", "s1", "boom")
        incidentlib.resolve_incident(incident_id)
        self.assertFalse(incidentlib.ack_incident(incident_id))
        self.assertEqual(incidentlib.get_incident(incident_id)["state"], "resolved")

    def test_resolve_unknown_id_is_false_not_a_crash(self):
        self.assertFalse(incidentlib.resolve_incident("no-such-id"))

    def test_list_incidents_filters_by_state(self):
        a, _ = incidentlib.upsert_incident("archive", "s1", "boom a")
        b, _ = incidentlib.upsert_incident("archive", "s2", "boom b")
        incidentlib.ack_incident(b)
        open_only = incidentlib.list_incidents("open")
        self.assertEqual([r["id"] for r in open_only], [a])
        acked_only = incidentlib.list_incidents("acked")
        self.assertEqual([r["id"] for r in acked_only], [b])

    def test_count_incidents_by_state(self):
        incidentlib.upsert_incident("archive", "s1", "boom a")
        incidentlib.upsert_incident("archive", "s2", "boom b")
        self.assertEqual(incidentlib.count_incidents("open"), 2)
        self.assertEqual(incidentlib.count_incidents("resolved"), 0)
        self.assertEqual(incidentlib.count_incidents(), 2)

    def test_record_is_the_thin_wrapper_call_shape(self):
        incident_id = incidentlib.record(scope="archive", key="s1", error="boom")
        self.assertIsInstance(incident_id, str)
        self.assertIsNotNone(incidentlib.get_incident(incident_id))

    def test_classify_failure_type_recognizes_common_causes(self):
        self.assertEqual(incidentlib.classify_failure_type("HTTP 429 rate limit hit"), "rate_limit")
        self.assertEqual(incidentlib.classify_failure_type("request timed out"), "timeout")
        self.assertEqual(incidentlib.classify_failure_type("some novel thing nobody has seen"), "unknown")

    def test_redact_masks_obvious_secrets(self):
        stored = incidentlib._redact_error("Authorization: Bearer sk-abcdefghijklmnop failed")
        self.assertNotIn("sk-abcdefghijklmnop", stored)

    def test_corrupt_ledger_reads_as_empty_not_crash(self):
        p = Path(self._tmp.name) / "incidents.json"
        p.write_text("{ not json", encoding="utf-8")
        self.assertEqual(incidentlib.list_incidents(), [])

    def test_error_fingerprint_ignores_scope_and_key(self):
        # The breaker's question ("do these DIFFERENT chats share one cause?") needs a
        # signature that does NOT vary with key - the opposite of _error_signature().
        fp1 = incidentlib.error_fingerprint("daemon connection refused")
        fp2 = incidentlib.error_fingerprint("daemon connection refused")
        self.assertEqual(fp1, fp2)

    def test_error_fingerprint_differs_for_different_causes(self):
        fp1 = incidentlib.error_fingerprint("daemon connection refused")
        fp2 = incidentlib.error_fingerprint("ambiguous title collision")
        self.assertNotEqual(fp1, fp2)


class LedgerWiringTest(unittest.TestCase):
    """ledgerlib.note()/annotate() file an incident for genuine failures and stamp the
    ledger row with the incident id, so the two can be joined."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_deterministic_note_files_an_incident_and_stamps_the_row(self):
        ledgerlib.note("archive", "s1", deterministic=True, note="two rows share this title")
        rows = ledgerlib._load()
        self.assertEqual(len(rows), 1)
        incident_id = rows[0]["incident"]
        self.assertIsNotNone(incident_id)
        incident = incidentlib.get_incident(incident_id)
        self.assertEqual(incident["scope"], "archive")
        self.assertEqual(incident["key"], "s1")
        self.assertIn("two rows share this title", incident["error"])

    def test_ordinary_note_files_no_incident(self):
        ledgerlib.note("archive", "s1", note="attempting archive of 'x'")
        rows = ledgerlib._load()
        self.assertIsNone(rows[0]["incident"])
        self.assertEqual(incidentlib.list_incidents(), [])

    def test_ordinary_note_with_explicit_error_files_one(self):
        ledgerlib.note("deliver", "s1", error="courier: verify snippet not found")
        rows = ledgerlib._load()
        self.assertIsNotNone(rows[0]["incident"])
        self.assertEqual(len(incidentlib.list_incidents()), 1)

    def test_annotate_without_failure_flag_files_no_incident(self):
        ledgerlib.note("migrate", "s1", note="attempt")
        ledgerlib.annotate("migrate", "s1", "stopped idle engine pid 123 after waiting 4s")
        rows = ledgerlib._load()
        self.assertIsNone(rows[0].get("incident"))
        self.assertEqual(incidentlib.list_incidents(), [])

    def test_annotate_with_failure_flag_files_an_incident_and_stamps_the_row(self):
        ledgerlib.note("deliver", "s1", note="attempt")
        ledgerlib.annotate("deliver", "s1", "verify-snippet not found: could not confirm chat",
                           failure=True)
        rows = ledgerlib._load()
        incident_id = rows[0]["incident"]
        self.assertIsNotNone(incident_id)
        incident = incidentlib.get_incident(incident_id)
        self.assertEqual(incident["scope"], "deliver")
        self.assertIn("verify-snippet", incident["error"])

    def test_repeated_deterministic_failures_on_the_same_chat_dedup_to_one_incident(self):
        ledgerlib.note("archive", "s1", deterministic=True, note="ambiguous title")
        ledgerlib.note("archive", "s1", deterministic=True, note="ambiguous title")
        ledgerlib.note("archive", "s1", deterministic=True, note="ambiguous title")
        self.assertEqual(len(incidentlib.list_incidents()), 1)
        self.assertEqual(incidentlib.list_incidents()[0]["count"], 3)


class SweepBreakerTest(unittest.TestCase):
    """sweep.execute()'s shared-cause breaker: halts a lane after N consecutive same-signature
    failures, never on differing signatures, and files one incident naming every chat it left
    behind."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import sweep

        self.sweep = sweep

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def _fake_batch(self, n, prefix="s"):
        rows = [{"sessionId": f"{prefix}{i}", "title": f"chat {prefix}{i}", "argv": [f"{prefix}{i}"]}
                for i in range(n)]
        return {"lanes": {"moves": {"rows": rows, "overCap": 0}}}

    def test_three_consecutive_same_cause_failures_halt_the_lane(self):
        calls = []

        def always_same_cause(argv):
            calls.append(argv[0])
            print("daemon connection refused")
            return 1

        batch = self._fake_batch(5)
        import archive_chat
        import migrate_chat
        import unittest.mock as mock

        with mock.patch.object(migrate_chat, "main", side_effect=always_same_cause):
            result = self.sweep.execute(batch, ["moves"], breaker_threshold=3)
        # only the first 3 rows were ever attempted - the breaker halted before rows 4-5
        self.assertEqual(calls, ["s0", "s1", "s2"])
        self.assertEqual(len(result["results"]), 3)
        self.assertEqual(len(result["breakerHalts"]), 1)
        halt = result["breakerHalts"][0]
        self.assertEqual(halt["lane"], "moves")
        self.assertEqual(halt["count"], 3)
        self.assertEqual(halt["skipped"], 2)
        self.assertEqual({c["sessionId"] for c in halt["chats"]}, {"s0", "s1", "s2"})
        # and ONE incident was filed for the whole halt
        from lib import incidentlib

        incident = incidentlib.get_incident(halt["incident"])
        self.assertIsNotNone(incident)
        self.assertEqual(incident["scope"], "sweep-breaker")

    def test_different_signatures_never_accumulate_and_never_halt(self):
        outputs = iter(["cause A", "cause B", "cause A", "cause B", "cause A"])

        def varying_cause(argv):
            print(next(outputs))
            return 1

        batch = self._fake_batch(5)
        import migrate_chat
        import unittest.mock as mock

        with mock.patch.object(migrate_chat, "main", side_effect=varying_cause):
            result = self.sweep.execute(batch, ["moves"], breaker_threshold=3)
        # every row was attempted - no streak ever reached 3 of the SAME signature
        self.assertEqual(len(result["results"]), 5)
        self.assertEqual(result["breakerHalts"], [])

    def test_an_ok_row_resets_the_streak(self):
        script = iter([(1, "same cause"), (1, "same cause"), (0, "verified"),
                       (1, "same cause"), (1, "same cause")])

        def scripted(argv):
            code, out = next(script)
            print(out)
            return code

        batch = self._fake_batch(5)
        import migrate_chat
        import unittest.mock as mock

        with mock.patch.object(migrate_chat, "main", side_effect=scripted):
            result = self.sweep.execute(batch, ["moves"], breaker_threshold=3)
        # 2 failures, then a success resets the streak, then only 2 more failures follow -
        # the streak of "same cause" never reaches 3 in a row, so nothing halts
        self.assertEqual(len(result["results"]), 5)
        self.assertEqual(result["breakerHalts"], [])

    def test_below_threshold_failures_never_halt(self):
        def always_same_cause(argv):
            print("same cause")
            return 1

        batch = self._fake_batch(2)
        import migrate_chat
        import unittest.mock as mock

        with mock.patch.object(migrate_chat, "main", side_effect=always_same_cause):
            result = self.sweep.execute(batch, ["moves"], breaker_threshold=3)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["breakerHalts"], [])


if __name__ == "__main__":
    unittest.main()
