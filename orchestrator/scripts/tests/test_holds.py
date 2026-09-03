"""holdlib + hold_chat.py + the hold rails in archive/migrate/sweep: a person's hands-off
switch, its laws (reason required, outranks verdicts and the breaker, never blocks a direct
request, keeps the chat visible), and its expiry."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402

T0 = 1_788_000_000_000
SID = "hhhh1111-2222-3333-4444-555566667777"
DONE = "Done.\n## Am I 100% done?\n- Yes"


from util import run_cli  # noqa: E402


class HoldLibTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_hold_demands_a_reason(self):
        with self.assertRaises(ValueError):
            holdlib.hold("s1", "   ")

    def test_hold_check_release_roundtrip(self):
        self.assertIsNone(holdlib.check("s1"))
        holdlib.hold("s1", "I am working this one", now_ms=T0)
        entry = holdlib.check("s1", now_ms=T0 + 5)
        self.assertEqual(entry["reason"], "I am working this one")
        self.assertIn("I am working this one", holdlib.why_blocked("s1", now_ms=T0 + 5))
        self.assertTrue(holdlib.release("s1"))
        self.assertIsNone(holdlib.check("s1"))
        self.assertFalse(holdlib.release("s1"))

    def test_expiry_lapses_and_prunes(self):
        holdlib.hold("s1", "for an hour", until_ms=T0 + 3600_000, now_ms=T0)
        self.assertIsNotNone(holdlib.check("s1", now_ms=T0 + 60_000))
        self.assertIsNone(holdlib.check("s1", now_ms=T0 + 3600_001))
        self.assertEqual(holdlib.held(now_ms=T0 + 3600_001), [])

    def test_check_is_strictly_read_only(self):
        # Adversarial review, 2026-08-31: check() used to prune-and-SAVE on a read, letting
        # a dashboard refresh racing a fresh hold rewrite holds.json without it. A read must
        # never write; pruning happens only inside hold()/release(), under the mutex.
        holdlib.hold("expired", "past", until_ms=T0 + 1, now_ms=T0)
        raw_before = holdlib._holds_path().read_text(encoding="utf-8")
        self.assertIsNone(holdlib.check("expired", now_ms=T0 + 10))
        self.assertEqual(holdlib._holds_path().read_text(encoding="utf-8"), raw_before)
        # ...and the next WRITE prunes it while owning the file.
        holdlib.hold("fresh", "current", now_ms=T0 + 20)
        self.assertNotIn("expired", holdlib._load())

    def test_held_listing_is_loud(self):
        holdlib.hold("s1", "reason one", now_ms=T0)
        holdlib.hold("s2", "reason two", now_ms=T0 + 1)
        rows = holdlib.held(now_ms=T0 + 10)
        self.assertEqual({r["session"] for r in rows}, {"s1", "s2"})

    def test_corrupt_file_reads_as_no_holds(self):
        (Path(self._tmp.name) / "holds.json").write_text("{ not json", encoding="utf-8")
        self.assertIsNone(holdlib.check("s1"))


class HoldRailTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        tp = Path(self._tmp.name) / "t.jsonl"
        tp.write_text(json.dumps({"type": "assistant",
                                  "message": {"content": [{"type": "text", "text": DONE}]}}) + "\n",
                      encoding="utf-8")
        old = time.time() - 600
        os.utime(tp, (old, old))
        stub = self.stub
        self.archived = {"v": False}

        def dossier_route(method, path, query, body):
            if dossier_query(query) not in (SID, "T"):
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": "c1", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "T",
                                 "archived": self.archived["v"], "lastActivityAt": "T1",
                                 "live": None}]}

        def archive_route(method, path, query, body):
            self.archived["v"] = body.get("archived", True)
            return {"ok": True, "hits": [{"profile": "cold", "wasRunning": False, "changed": True}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = archive_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "T", "instance": "cold",
             "transcript_path": str(tp), "last_activity_at": 1}
        ]
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True,
             "account": {"email": "c@x.com", "planLabel": "Max 20×"}},
            {"num": 2, "name": "warm", "dir": "c:\\i\\warm", "isRunning": True, "signedIn": True,
             "account": {"email": "w@x.com", "planLabel": "Max 20×"}}]}
        stub.routes["/api/usage/survey"] = {"rows": []}
        stub.routes["/api/usage/cache"] = {"cache": {}}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def acted(self):
        return any(p.endswith("/desktop-archive") for p, _ in self.stub.posts)

    def test_hold_blocks_the_unattended_archive_and_force_overrides(self):
        import archive_chat

        holdlib.hold(SID, "the owner is mid-review here")
        code, out, _ = run_cli(archive_chat.main, [SID])
        self.assertEqual(code, 6)
        self.assertIn("HELD by owner", out)
        self.assertFalse(self.acted())
        # --no-preserve: this test is about the hold rail (force overrides a hold), not the
        # separately-tested docs-preservation cycle.
        code, _, _ = run_cli(archive_chat.main, [SID, "--force", "--no-preserve"])
        self.assertEqual(code, 0)
        self.assertTrue(self.acted())

    def test_hold_blocks_migrate_too(self):
        import migrate_chat

        holdlib.hold(SID, "hands off")
        code, out, _ = run_cli(migrate_chat.main, [SID, "--to", "warm"])
        self.assertEqual(code, 6)
        self.assertEqual(self.stub.posts, [])

    def test_dashboard_plan_labels_held_chats_and_sweep_excludes_them(self):
        import dashboard
        import sweep

        holdlib.hold(SID, "leave this one to me")
        plan = dashboard.build_plan()
        row = next(c for c in plan["chats"] if c["sessionId"] == SID)
        self.assertEqual(row["decision"]["kind"], "on-hold")
        self.assertIn("leave this one to me", row["decision"]["detail"])
        # holding is not hiding: the chat is still on the board
        self.assertEqual(plan["scanned"], 1)
        batch = sweep.build_batch(allow_pending=False, max_per_lane=5)
        self.assertEqual([h["sessionId"] for h in batch["onHold"]], [SID])
        self.assertEqual(batch["lanes"]["archive"]["rows"], [])

    def test_hold_cli_requires_reason_and_lists(self):
        import hold_chat

        code, _, err = run_cli(hold_chat.main, [SID])
        self.assertEqual(code, 3)
        self.assertIn("DEMANDS a reason", err)
        code, out, _ = run_cli(hold_chat.main, [SID, "--reason", "mine for now"])
        self.assertEqual(code, 0)
        code, out, _ = run_cli(hold_chat.main, ["--list"])
        self.assertIn("mine for now", out)
        code, out, _ = run_cli(hold_chat.main, [SID, "--release"])
        self.assertIn("released", out)
        code, out, _ = run_cli(hold_chat.main, ["--list"])
        self.assertIn("no chat is held", out)


if __name__ == "__main__":
    unittest.main()
