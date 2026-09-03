"""drill.py: subject vetting, the round-trips, and the stranded-state loudness."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

import drill  # noqa: E402
from lib import hydralib  # noqa: E402

SID = "eeee1111-2222-3333-4444-555566667777"
DONE = "Done.\n## Am I 100% done?\n- Yes"


from util import run_cli  # noqa: E402


class DrillTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def wire(self, archived=True, live=None, app_running=False, title="Junk chat",
             rename_ok=True):
        tp = Path(self._tmp.name) / "t.jsonl"
        tp.write_text(
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": DONE}]}}) + "\n",
            encoding="utf-8",
        )
        old = time.time() - 600
        os.utime(tp, (old, old))
        stub = self.stub
        state = {"archived": archived, "title": title}

        def dossier_route(method, path, query, body):
            return {"matches": [{
                "instance": "a", "chatId": "local_d", "cliSessionId": SID, "lineageIds": [SID],
                "title": state["title"], "archived": state["archived"],
                "lastActivityAt": "T1", "live": live,
            }]}

        def archive_route(method, path, query, body):
            state["archived"] = body.get("archived", True)
            return {"ok": True, "hits": [{"profile": "a", "wasRunning": app_running, "changed": True}]}

        # rename_chat drives THIS repo's sidebar actuator (2026-09-01), not the daemon's
        # /rename route: fake the drive, and log it on the stub's post list under a path
        # ending in /rename so the round-trip assertions read the same way.
        def fake_drive(instance, old_title, new_title):
            if not rename_ok:
                return 1, "FAIL: row not found"
            state["title"] = new_title
            stub.posts.append(("/actuator/rename", {"new_title": new_title, "current_title": old_title}))
            return 0, "renamed"

        import rename_chat
        import unittest.mock as _mock

        patcher = _mock.patch.object(rename_chat, "_drive_rename", side_effect=fake_drive)
        patcher.start()
        self.addCleanup(patcher.stop)

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = archive_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": archived, "title": title, "instance": "a",
             "transcript_path": str(tp), "last_activity_at": 1}
        ]
        stub.routes["/api/fleet"] = {
            "instances": [{"num": 1, "name": "a", "dir": "c:\\i\\a", "isRunning": app_running}]
        }

    def archive_posts(self):
        return [b for p, b in self.stub.posts if p.endswith("/desktop-archive")]

    def test_archive_round_trip_restores_the_fleet(self):
        self.wire(archived=True, app_running=False)
        code, out, _ = run_cli(drill.main, ["--chat", SID])
        self.assertEqual(code, 0)
        self.assertEqual(self.archive_posts(), [{"archived": False}, {"archived": True}])
        self.assertIn("as found", out)

    def test_refuses_live_writer(self):
        self.wire(live={"pid": 5, "name": "w"})
        code, out, _ = run_cli(drill.main, ["--chat", SID])
        self.assertEqual(code, 2)
        self.assertEqual(self.stub.posts, [])

    def test_refuses_unarchived_subject(self):
        self.wire(archived=False)
        code, out, _ = run_cli(drill.main, ["--chat", SID])
        self.assertEqual(code, 2)
        self.assertIn("NOT archived", out)
        self.assertEqual(self.stub.posts, [])

    def test_refuses_running_app_for_archive_drill(self):
        self.wire(archived=True, app_running=True)
        code, out, _ = run_cli(drill.main, ["--chat", SID])
        self.assertEqual(code, 2)
        self.assertIn("disk-flag", out)
        self.assertEqual(self.stub.posts, [])

    def test_stranded_restore_is_loud_with_the_fix_command(self):
        self.wire(archived=True, app_running=False)
        stub = self.stub
        state_calls = {"n": 0}
        orig = stub.routes[f"/api/sessions/{SID}/desktop-archive"]

        def archive_once_then_fail(method, path, query, body):
            state_calls["n"] += 1
            if state_calls["n"] == 1:
                return orig(method, path, query, body)
            return (500, {"error": "actuator died"})

        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = archive_once_then_fail
        code, out, _ = run_cli(drill.main, ["--chat", SID])
        self.assertEqual(code, 1)
        self.assertIn("RESTORE FAILED", out)
        self.assertIn(f"archive_chat.py {SID} --force", out)

    def test_rename_round_trip_through_the_ui_actuator(self):
        self.wire(archived=False, app_running=True, title="Junk chat")
        code, out, _ = run_cli(drill.main, ["--chat", SID, "--rename"])
        self.assertEqual(code, 0)
        renames = [b for p, b in self.stub.posts if p.endswith("/rename")]
        self.assertEqual(
            [r["new_title"] for r in renames], ["Junk chat [drill]", "Junk chat"]
        )

    def test_rename_drill_needs_a_running_app(self):
        self.wire(archived=False, app_running=False)
        code, out, _ = run_cli(drill.main, ["--chat", SID, "--rename"])
        self.assertEqual(code, 2)
        self.assertIn("not running", out)
        self.assertEqual(self.stub.posts, [])

    def test_rename_drill_refuses_archived_chat_no_row_to_click(self):
        # The UIA actuator reaches rendered sidebar rows only - an archived chat has none.
        self.wire(archived=True, app_running=True)
        code, out, _ = run_cli(drill.main, ["--chat", SID, "--rename"])
        self.assertEqual(code, 2)
        self.assertIn("no sidebar row", out)
        self.assertEqual(self.stub.posts, [])


if __name__ == "__main__":
    unittest.main()
