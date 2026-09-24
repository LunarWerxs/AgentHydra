"""The owner's standing order (2026-09-20): a chat moved off an account at 98%+ usage is killed
and moved without anyone passing --terminate-live, and a source row that is only disk-flagged
is reported as still on screen rather than as a finished move."""

from __future__ import annotations

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import migrate_batch  # noqa: E402


def _survey(label: str, sess, week, reason: str = "ok") -> dict:
    return {"rows": [{"kind": "desktop", "num": 38, "label": label,
                      "id": f"c:\\users\\x\\.claude-instances\\{label}",
                      "result": {"reason": reason, "snapshot": {"session": {"pct": sess},
                                                                "weekAll": {"pct": week}}}}]}


class _Outcome:
    def __init__(self, code: int, landing=None, payload=None) -> None:
        self.code = code
        self.landing = landing
        self.payload = payload or {"landed": False, "report": "REFUSED: live engine"}


class FullSourceTest(unittest.TestCase):
    def _full(self, sess, week, reason="ok", label="2uhmany"):
        with mock.patch.object(migrate_batch.hydralib, "resolve_one",
                               return_value={"instance": "2uhmany"}):
            return migrate_batch._full_source("q", survey=_survey(label, sess, week, reason))

    def test_session_bucket_at_100_is_full(self):
        self.assertEqual(self._full(100, 59)["sessionPct"], 100)

    def test_weekly_bucket_at_98_is_full(self):
        self.assertIsNotNone(self._full(10, 98))

    def test_97_is_not_full(self):
        self.assertIsNone(self._full(97, 97))

    def test_unreadable_usage_never_kills(self):
        self.assertIsNone(self._full(100, 100, reason="error"))
        self.assertIsNone(self._full(None, None))

    def test_other_account_is_not_matched(self):
        self.assertIsNone(self._full(100, 100, label="someone_else"))


class MoveOneTest(unittest.TestCase):
    def _run(self, full, terminate_live=False):
        landed = _Outcome(0, landing=object())
        calls = iter([_Outcome(migrate_batch._EXIT_LIVE_ENGINE), landed])
        with mock.patch.object(migrate_batch.migrate_chat, "move_only",
                               side_effect=lambda argv: next(calls)), \
             mock.patch.object(migrate_batch, "_full_source", return_value=full), \
             mock.patch.object(migrate_batch, "_terminate_for",
                               return_value={"stopped": True, "pid": 1}) as term:
            item = migrate_batch._move_one("q", [], terminate_live=terminate_live)
        return item, term

    def test_full_source_kills_without_the_flag(self):
        item, term = self._run({"num": 38, "sessionPct": 100, "weekPct": 59})
        term.assert_called_once()
        self.assertIsNotNone(item.landing)
        self.assertIn("standingOrder", item.terminated)

    def test_not_full_source_still_refuses(self):
        item, term = self._run(None)
        term.assert_not_called()
        self.assertIsNone(item.landing)


class StillShownTest(unittest.TestCase):
    def test_flagged_source_row_leads_the_report(self):
        results = [{"landed": True, "sourceRow": "flagged", "sessionId": "s1", "title": "Glimmer",
                    "chat": "s1", "to": "b", "bypassVerdict": "disk-only", "ok": True}]
        parsed = mock.Mock(dry_run=False)
        items = [mock.Mock(payload=r) for r in results]
        with mock.patch.object(migrate_batch, "_report", return_value="body"):
            payload = migrate_batch._build_batch_payload(items, parsed, "", 1.0, None)
        self.assertEqual(payload["sourceStillShown"], ["s1"])
        self.assertTrue(payload["report"].startswith("⚠ NOT FINISHED ON THE OLD ACCOUNT"))


if __name__ == "__main__":
    unittest.main()
