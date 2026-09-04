"""chats.py: the account-grouped chat list and the move-between-accounts path."""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

import chats  # noqa: E402
from lib import hydralib  # noqa: E402


from util import run_cli  # noqa: E402


class ChatsTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "alpha", "dir": "c:\\i\\alpha", "isRunning": True, "signedIn": True,
             "account": {"email": "a@x.com", "planLabel": "Max 20×"}},
            {"num": 2, "name": "beta", "dir": "c:\\i\\beta", "isRunning": False, "signedIn": True,
             "account": {"email": "b@x.com", "planLabel": "Pro"}},
        ]}
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s1", "title": "RoloDexter coverage", "instance": "alpha",
             "archived": False, "last_activity_at": 300},
            {"session_id": "s2", "title": "Postal split", "instance": "beta",
             "archived": False, "last_activity_at": 200},
            {"session_id": "s3", "title": "An archived one", "instance": "alpha",
             "archived": True, "last_activity_at": 100},
            {"session_id": "s4", "title": "A console stray", "instance": None,
             "archived": False, "last_activity_at": 50},
        ]

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_lists_visible_chats_with_their_accounts(self):
        rows = chats.collect(False, None, None, None, False)
        self.assertEqual({r["sessionId"] for r in rows}, {"s1", "s2", "s4"})
        by = {r["sessionId"]: r for r in rows}
        self.assertEqual(by["s1"]["email"], "a@x.com")
        self.assertTrue(by["s1"]["appRunning"])
        self.assertEqual(by["s2"]["plan"], "Pro")
        self.assertEqual(by["s4"]["origin"], "console")
        self.assertIsNone(by["s4"]["email"])

    def test_filters(self):
        self.assertEqual([r["sessionId"] for r in chats.collect(False, "a@x.com", None, None, False)], ["s1"])
        self.assertEqual([r["sessionId"] for r in chats.collect(False, None, "beta", None, False)], ["s2"])
        self.assertEqual([r["sessionId"] for r in chats.collect(False, None, None, "rolodexter", False)], ["s1"])
        self.assertEqual([r["sessionId"] for r in chats.collect(False, None, None, None, True)], ["s4"])
        self.assertEqual(len(chats.collect(True, None, None, None, False)), 4)  # --all includes archived

    def test_move_plan_names_a_closed_target_and_skips_chats_already_there(self):
        rows = chats.collect(False, None, None, None, False)
        plan = chats.move(rows, "beta", act=False, cap=10)
        self.assertEqual(plan["target"]["instance"], "beta")
        self.assertFalse(plan["target"]["isRunning"])   # surfaced so a closed target is visible
        self.assertEqual({p["sessionId"] for p in plan["planned"]}, {"s1", "s4"})
        self.assertEqual(plan["alreadyThere"], 1)       # s2 is already in beta
        self.assertEqual(plan["results"], [])           # plan only

    def test_unknown_target_is_refused_with_the_known_list(self):
        rows = chats.collect(False, None, None, None, False)
        plan = chats.move(rows, "nope", act=False, cap=10)
        self.assertIn("unknown target", plan["error"])
        self.assertIn("alpha", plan["error"])

    def test_move_runs_through_migrate_chats_own_rails(self):
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", return_value=0) as m:
            plan = chats.move(rows, "beta", act=True, cap=10)
        # --stop-idle matches the sweep's move and land lanes (it only ever stops an engine the
        # gate calls SAFELY IDLE; a working or stuck one still refuses). --json is how the
        # outcome is read from the child's PAYLOAD rather than guessed from its exit code.
        # What must stay absent is --force: holds, the naming door, the breaker and the
        # live-writer refusal all still apply to a move made from here, and --force is a
        # person's word for ONE act - never a batch flag.
        m.assert_called_once_with(["s1", "--to", "beta", "--stop-idle", "--json"])
        self.assertNotIn("--force", m.call_args.args[0])
        self.assertNotIn("--idle-wait", m.call_args.args[0])  # opt-in; --yes never implies it
        self.assertTrue(plan["results"][0]["ok"])

    def test_idle_wait_is_forwarded_only_when_asked_for(self):
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", return_value=0) as m:
            chats.move(rows, "beta", act=True, cap=10, idle_wait=330)
        argv = m.call_args.args[0]
        self.assertIn("--idle-wait", argv)
        self.assertEqual(argv[argv.index("--idle-wait") + 1], "330")

    def test_exit_zero_without_a_landing_is_a_no_op_not_a_move(self):
        """migrate_chat exits 0 for 'it already lives there'. That is not a landing, and
        counting it as one is how a headline claims chats moved that never did."""
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", return_value=0):
            plan = chats.move(rows, "beta", act=True, cap=10)
        row = plan["results"][0]
        self.assertTrue(row["ok"])          # the child did not fail...
        self.assertFalse(row["landed"])     # ...but nothing moved, and the count reads this
        self.assertIn("no-op", row["outcome"])

    def _child_payload(self, payload):
        """A stand-in migrate_chat.main that answers with a --json payload, the way the batch
        loop actually reads its children."""
        def child(argv):
            print(json.dumps(payload))
            return 0
        return child

    def test_a_landing_that_leaves_the_source_row_visible_is_NOT_a_clean_move(self):
        """A MOVE IS A MOVE (live, 2026-09-04): nine chats landed, every one left its source
        row visible, migrate_chat said so nine times - and this loop printed nine ticks,
        because it read only `landed`. The operator believed a clean move and found the
        duplicates later, so a twin has to fail the row AND the exit code."""
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", side_effect=self._child_payload(
                {"landed": True, "sourceRow": "visible", "report": "twin on screen"})):
            plan = chats.move(rows, "beta", act=True, cap=10)
        row = plan["results"][0]
        self.assertTrue(row["landed"])
        self.assertFalse(row["ok"])
        self.assertIn("still visible", row["outcome"])
        self.assertEqual(chats._move_exit_code(plan, True), 2)

    def test_a_source_row_retired_by_the_weaker_disk_flag_still_counts_as_moved(self):
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", side_effect=self._child_payload(
                {"landed": True, "sourceRow": "flagged", "report": "flag written"})):
            plan = chats.move(rows, "beta", act=True, cap=10)
        row = plan["results"][0]
        self.assertTrue(row["ok"])
        self.assertIn("landed and verified", row["outcome"])
        self.assertEqual(chats._move_exit_code(plan, True), 0)

    def test_a_refusal_is_named_not_swallowed(self):
        rows = chats.collect(False, None, None, "rolodexter", False)
        with mock.patch("migrate_chat.main", return_value=6):
            plan = chats.move(rows, "beta", act=True, cap=10)
        self.assertFalse(plan["results"][0]["ok"])
        self.assertIn("HELD", plan["results"][0]["outcome"])

    def test_cap_bounds_a_bulk_move(self):
        rows = chats.collect(False, None, None, None, False)
        plan = chats.move(rows, "beta", act=False, cap=1)
        self.assertEqual(len(plan["planned"]), 1)
        self.assertEqual(plan["overCap"], 1)

    def test_cli_plan_only_and_json(self):
        with mock.patch("migrate_chat.main") as m:
            code, out, _ = run_cli(chats.main, ["--move-to", "beta"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("PLAN ONLY", out)
        code, out, _ = run_cli(chats.main, ["--json"])
        self.assertEqual(len(json.loads(out)["chats"]), 3)

    def test_daemon_failure_exits_1(self):
        self.stub.routes["/api/sessions"] = (500, {"error": "down"})
        self.assertEqual(run_cli(chats.main, [])[0], 1)


if __name__ == "__main__":
    unittest.main()
