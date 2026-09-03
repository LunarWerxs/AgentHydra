"""audit_archived.py: the was-this-archive-right classifier."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import audit_archived  # noqa: E402


def finished(lane="archive-candidate", offers=False, question=False, done="yes", interrupted=False):
    return {
        "state": "finished", "crashed": None,
        "finished": {"lane": lane, "offers_to_continue": offers, "ends_with_question": question,
                     "done_claim": done, "interrupted": interrupted, "recap_present": True,
                     "last_assistant_text": "x"},
    }


class ClassifyTest(unittest.TestCase):
    def test_live_under_archived_flag_is_the_owners_contradiction(self):
        status, why = audit_archived.classify(None, {"pid": 5}, "")
        self.assertEqual(status, "live-contradiction")
        self.assertIn("owner untangles", why)

    def test_clean_candidate_was_correctly_archived(self):
        self.assertEqual(audit_archived.classify(finished(), None)[0], "correct")

    def test_offer_question_notdone_interrupted_crashed_all_flag_wrong(self):
        cases = [
            (finished(lane="needs-input-review", offers=True), "wrong-waiting"),
            (finished(lane="needs-input-review", question=True), "wrong-waiting"),
            (finished(lane="needs-input-review", done="no"), "wrong-not-done"),
            (finished(lane="human", interrupted=True), "wrong-interrupted"),
            ({"state": "crashed", "crashed": {"kind": "usage-limit"}, "finished": None}, "wrong-crashed"),
        ]
        for verdict, want in cases:
            self.assertEqual(audit_archived.classify(verdict, None)[0], want, want)

    def test_unreadable_transcript_is_reported_never_guessed(self):
        status, why = audit_archived.classify(None, None, "unsupported transcript format (x.db)")
        self.assertEqual(status, "ungateable")
        self.assertIn("x.db", why)


if __name__ == "__main__":
    unittest.main()
