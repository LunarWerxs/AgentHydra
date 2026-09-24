"""archivewatchlib: a move must say so when a chat it was never given went archived.

The incident it exists for (2026-09-16): a four-chat batch off a running account settled every
chat it was given, and in the same two minutes three chats outside it went archived - one in an
account the move never named. Every rail verified the intended rows, so the move read clean.
These pin the one property that matters: a settle (or any phase) that changes a record other
than the session ids it was given is REPORTED, and the move's own rows never are.
"""

import json
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import archivewatchlib, stamplib  # noqa: E402
from lib.archivewatchlib import snapshot as real_snapshot  # noqa: E402
from util import isolate_state_dir  # noqa: E402


def rec(archived, ids, title="t", instance="a", sid=None):
    ids = set(ids)
    return {"archived": archived, "ids": ids, "title": title, "instance": instance,
            "sessionId": sid or sorted(ids)[0]}


class RecordIdsTest(unittest.TestCase):
    def test_a_record_answers_to_its_cli_id_its_priors_and_its_filename(self):
        meta = {"cliSessionId": "current", "priorCliSessionIds": ["old-1", "old-2"]}
        self.assertEqual(archivewatchlib.record_ids(Path("x/y/local_file-id.json"), meta),
                         {"current", "old-1", "old-2", "file-id"})

    def test_a_match_allows_every_id_its_chat_ever_had(self):
        match = {"cliSessionId": "c", "lineageIds": ["c", "p"], "priorCliSessionIds": ["p"],
                 "chatId": "local_f"}
        self.assertEqual(archivewatchlib.ids_for_match(match, "s"), {"c", "p", "f", "s"})
        self.assertEqual(archivewatchlib.ids_for_match(None, None), set())


class CollateralTest(unittest.TestCase):
    def test_a_bystander_that_went_archived_is_collateral(self):
        before = {"p1": rec(False, {"moved"}), "p2": rec(False, {"bystander"}, "Odin", "#55")}
        after = {"p1": rec(True, {"moved"}), "p2": rec(True, {"bystander"}, "Odin", "#55")}
        rows = archivewatchlib.collateral(before, after, {"moved"})
        self.assertEqual([r["title"] for r in rows], ["Odin"])
        self.assertEqual(rows[0]["instance"], "#55")

    def test_the_moves_own_rows_and_twins_are_never_collateral(self):
        """Archiving the source row and every other profile's copy IS the move's job - matched by
        any id, including one the chat rolled away from."""
        before = {"src": rec(False, {"moved"}), "twin": rec(False, {"new", "moved-old"})}
        after = {"src": rec(True, {"moved"}), "twin": rec(True, {"new", "moved-old"})}
        self.assertEqual(archivewatchlib.collateral(before, after, {"moved", "moved-old"}), [])

    def test_only_a_visible_to_archived_flip_counts(self):
        before = {"was-archived": rec(True, {"a"}), "unarchived": rec(True, {"b"}),
                  "unchanged": rec(False, {"c"})}
        after = {"was-archived": rec(True, {"a"}), "unarchived": rec(False, {"b"}),
                 "unchanged": rec(False, {"c"}), "landed": rec(True, {"d"})}
        self.assertEqual(archivewatchlib.collateral(before, after, set()), [],
                         "a record that did not exist before is a landing, not a bystander")

    def test_no_snapshot_is_no_claim(self):
        self.assertEqual(archivewatchlib.collateral(None, {"p": rec(True, {"x"})}, set()), [])
        self.assertEqual(archivewatchlib.collateral({"p": rec(False, {"x"})}, None, set()), [])

    def test_the_report_names_each_chat_and_the_way_back(self):
        lines = archivewatchlib.report_lines(
            [{"instance": "blaarrrggghhh", "title": "Odin production readiness scoring",
              "sessionId": "b0bcbaf3-6295", "path": "p"}], "inc-1")
        text = "\n".join(lines)
        self.assertIn("COLLATERAL", text)
        self.assertIn("'Odin production readiness scoring' in blaarrrggghhh (b0bcbaf3)", text)
        self.assertIn("Unarchive", text)
        self.assertIn("inc-1", text)
        self.assertEqual(archivewatchlib.report_lines([]), [])


class SnapshotTest(unittest.TestCase):
    def test_it_reads_every_record_in_every_store_it_is_given(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "claude-code-sessions" / "org" / "user"
            store.mkdir(parents=True)
            (store / "local_one.json").write_text(json.dumps(
                {"cliSessionId": "one", "title": "One", "isArchived": False}), encoding="utf-8")
            (store / "local_two.json").write_text(json.dumps(
                {"cliSessionId": "two", "title": "Two", "isArchived": True}), encoding="utf-8")
            roots = [{"instance": "acct", "root": Path(tmp) / "claude-code-sessions",
                      "isRunning": False}]
            with mock.patch.object(stamplib, "store_roots", return_value=roots):
                snap = real_snapshot({"instances": []})
        by_title = {v["title"]: v for v in snap.values()}
        self.assertEqual(set(by_title), {"One", "Two"})
        self.assertIs(by_title["One"]["archived"], False)
        self.assertIs(by_title["Two"]["archived"], True)
        self.assertEqual(by_title["One"]["instance"], "acct")

    def test_an_unreadable_fleet_is_no_snapshot(self):
        from lib import hydralib
        with mock.patch.object(hydralib, "fleet", side_effect=hydralib.DaemonError("/x", None, "down")):
            self.assertIsNone(real_snapshot())


class _Landing:
    match = {"cliSessionId": "moved", "lineageIds": ["moved"]}
    session_id = "moved"


class MoveReportsCollateralTest(unittest.TestCase):
    """The single-chat move: landed, but a bystander went archived -> exit 2, named, not ok."""

    def setUp(self):
        isolate_state_dir(self)

    def _main(self, after):
        before = {"src": rec(False, {"moved"}), "by": rec(False, {"other"}, "Bystander", "acct")}
        snaps = iter([before, after])
        payload = {"landed": True, "ok": True, "report": "landed and VERIFIED"}
        with mock.patch.object(migrate_chat.archivewatchlib, "snapshot",
                               side_effect=lambda *a, **k: next(snaps)), \
                mock.patch.object(migrate_chat, "move_only",
                                  return_value=migrate_chat._MoveOutcome(landing=_Landing(),
                                                                         as_json=True)), \
                mock.patch.object(migrate_chat, "finish_move", return_value=None), \
                mock.patch.object(migrate_chat, "landing_payload", return_value=payload):
            from lib import clilib
            code, out = clilib.capture(migrate_chat.main, ["moved", "--to", "2", "--json"])
        return code, json.loads(out)

    def test_collateral_makes_the_move_exit_2_and_names_the_chat(self):
        code, out = self._main({"src": rec(True, {"moved"}),
                                "by": rec(True, {"other"}, "Bystander", "acct")})
        self.assertEqual(code, 2)
        self.assertIs(out["ok"], False)
        self.assertIs(out["landed"], True, "the chat still moved - never re-report it as unmoved")
        self.assertEqual([r["title"] for r in out["collateral"]], ["Bystander"])
        self.assertTrue(out["report"].startswith("⛔ COLLATERAL"))

    def test_a_clean_move_is_untouched(self):
        code, out = self._main({"src": rec(True, {"moved"}),
                                "by": rec(False, {"other"}, "Bystander", "acct")})
        self.assertEqual(code, 0)
        self.assertNotIn("collateral", out)
        self.assertEqual(out["report"], "landed and VERIFIED")

    def test_a_dry_run_and_a_usage_error_never_read_the_stores(self):
        with mock.patch.object(migrate_chat.archivewatchlib, "snapshot") as snap, \
                mock.patch.object(migrate_chat, "move_only",
                                  return_value=migrate_chat._MoveOutcome(
                                      payload={"report": "plan", "dryRun": True}, code=0)):
            from lib import clilib
            clilib.capture(migrate_chat.main, ["moved", "--to", "2", "--dry-run"])
            self.assertEqual(clilib.capture(migrate_chat.main, ["moved", "--idle-wait", "x"])[0], 3)
        snap.assert_not_called()


if __name__ == "__main__":
    unittest.main()
