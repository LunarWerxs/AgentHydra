"""stage_reply --list must answer 'what is waiting to go out', not 'everything ever'.

⛔ THE DEFECT (found 2026-09-12, while diagnosing a migration whose resume never arrived).
`--list --json` returned EVERY delivery record the machine had ever held: 178,575 characters
over 120+ rows across 15 instances, mostly `expired` and `cancelled` rows belonging to other
accounts, each carrying its full reply body plus up to 600 characters of `evidence`. It blew
the caller's token cap and was refused outright - so the single fact anyone wanted (which of
three just-migrated chats got its reply) could NOT be read from the tool that owns it, and had
to be recovered by parsing a spilled result file with a throwaway script.

Two independent things made it unreadable, so both are pinned here: the ROW COUNT (every state,
forever) and the ROW SIZE (the whole record, including fields only one row's detail view wants).
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
os.environ.setdefault("AGENTHYDRA_TEST", "1")

import stage_reply  # noqa: E402


def row(rid: str, state: str, *, instance: str = "acct", staged_at: int = 0, **extra) -> dict:
    base = {
        "id": rid,
        "session": f"sid-{rid}",
        "title": f"chat {rid}",
        "instance": instance,
        "state": state,
        "by": "ai",
        "stagedAt": staged_at,
        "text": "x" * 4000,
        "evidence": "e" * 600,
        "verifyText": "v" * 80,
        "attempts": 0,
        "deliveredAt": None,
        "lastError": None,
    }
    base.update(extra)
    return base


class DefaultsAreTheFix(unittest.TestCase):
    """The defaults ARE the fix - a default that silently widens again is the bug returning."""

    def setUp(self):
        self.rows = [
            row("a", "staged", staged_at=300),
            row("b", "failed", staged_at=200),
            row("c", "delivered", staged_at=100),
            row("d", "cancelled", staged_at=90),
            row("e", "expired", staged_at=80),
        ]

    def test_the_default_is_the_actionable_states_only(self):
        got, total = stage_reply.select_rows(self.rows, None, None, None)
        self.assertEqual([r["id"] for r in got], ["a", "b"])
        self.assertEqual(total, 2)
        self.assertEqual(set(stage_reply.ACTIONABLE_STATES), {"staged", "failed"})

    def test_history_is_still_reachable_but_only_when_asked_for(self):
        got, total = stage_reply.select_rows(self.rows, list(stage_reply._ALL_STATES), None, None)
        self.assertEqual(total, 5)

    def test_newest_first_so_a_cap_keeps_what_matters(self):
        got, _ = stage_reply.select_rows(self.rows, list(stage_reply._ALL_STATES), None, None)
        self.assertEqual([r["id"] for r in got], ["a", "b", "c", "d", "e"])

    def test_an_instance_filter_scopes_to_one_account(self):
        rows = [row("a", "staged", instance="another_meh"), row("b", "staged", instance="temp1")]
        got, total = stage_reply.select_rows(rows, None, "another_meh", None)
        self.assertEqual([r["id"] for r in got], ["a"])
        self.assertEqual(total, 1)

    def test_the_cap_is_applied_but_the_true_count_is_still_reported(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(40)]
        got, total = stage_reply.select_rows(rows, None, None, 5)
        self.assertEqual(len(got), 5)
        self.assertEqual(total, 40, "a reader that cannot see the real count cannot trust the list")

    def test_there_is_a_default_cap_at_all(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(500)]
        got, total = stage_reply.select_rows(rows, None, None, None)
        self.assertEqual(total, 500)
        self.assertLessEqual(len(got), stage_reply._DEFAULT_LIST_LIMIT)
        self.assertGreater(len(got), 0)

    def test_limit_zero_means_no_cap_for_a_caller_that_really_wants_everything(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(100)]
        got, _ = stage_reply.select_rows(rows, None, None, 0)
        self.assertEqual(len(got), 100)


class RowSizeIsBounded(unittest.TestCase):
    """Trimming the count was not enough: 50 whole records were still 67KB."""

    def test_a_list_row_drops_the_bulky_single_row_fields(self):
        got = stage_reply._trim(row("a", "staged"))
        self.assertNotIn("evidence", got, "600 chars of the chat's words belong to one row's detail")
        self.assertNotIn("verifyText", got)

    def test_the_reply_body_is_truncated_and_says_so(self):
        got = stage_reply._trim(row("a", "staged"))
        self.assertEqual(len(got["text"]), stage_reply._LIST_TEXT_CHARS)
        self.assertTrue(got["textTruncated"])

    def test_a_short_body_is_not_marked_truncated(self):
        got = stage_reply._trim(row("a", "staged", text="short"))
        self.assertEqual(got["text"], "short")
        self.assertNotIn("textTruncated", got)

    def test_the_fields_a_reader_acts_on_survive(self):
        got = stage_reply._trim(row("a", "failed", lastError="z" * 900))
        for key in ("id", "session", "title", "instance", "state", "stagedAt"):
            self.assertIn(key, got)
        self.assertLessEqual(len(got["lastError"]), 200,
                             "an error still has to be readable without being the whole payload")

    def test_a_full_page_of_rows_stays_within_a_callers_budget(self):
        """The regression in one number: 20 projected rows must not approach the 178KB that was
        refused. Serialised size is the thing that actually broke, so measure that."""
        import json

        rows = [row(str(i), "staged", staged_at=i) for i in range(stage_reply._DEFAULT_LIST_LIMIT)]
        picked, _ = stage_reply.select_rows(rows, None, None, None)
        payload = json.dumps([stage_reply._trim(r) for r in picked])
        self.assertLess(len(payload), 20_000, f"a default --list came to {len(payload)} chars")


if __name__ == "__main__":
    unittest.main()
