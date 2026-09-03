"""smoke.py against the stub (pass AND fail paths - a smoke that cannot fail is decoration),
plus open_instance.py / quit_instance.py including the live-writer refusal."""

import json
import os
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402
import open_instance  # noqa: E402
import quit_instance  # noqa: E402
import smoke  # noqa: E402

SID = "dddd1111-2222-3333-4444-555566667777"


from util import run_cli  # noqa: E402


def full_wiring(stub, tmpdir, live=None):
    tp = Path(tmpdir) / "t.jsonl"
    tp.write_text(
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}) + "\n",
        encoding="utf-8",
    )
    old = time.time() - 60
    os.utime(tp, (old, old))
    stub.routes["/api/health"] = {"ok": True, "version": "t", "distribution": "test"}
    stub.routes["/api/fleet"] = {
        "instances": [{"num": 1, "name": "a", "dir": "c:\\i\\a", "ref": "desktop:c:\\i\\a", "isRunning": True}]
    }
    stub.routes["/api/sessions"] = [
        {"session_id": SID, "archived": False, "title": "T", "instance": "a",
         "transcript_path": str(tp), "last_activity_at": 5}
    ]
    stub.routes["/api/chats/dossier"] = {
        "matches": [{"instance": "a", "chatId": "c", "cliSessionId": SID, "archived": False,
                     "lineageIds": [SID], "live": live}]
    }


class SmokeTest(unittest.TestCase):
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

    def test_all_green_exits_0_and_never_posts(self):
        full_wiring(self.stub, self._tmp.name)
        code, out, _ = run_cli(smoke.main, [])
        self.assertEqual(code, 0)
        self.assertIn("6/6 passed", out)
        self.assertEqual(self.stub.posts, [])  # READ-ONLY is a hard property, assert it

    def test_a_broken_read_fails_loudly_not_quietly(self):
        full_wiring(self.stub, self._tmp.name)
        self.stub.routes["/api/fleet"] = (500, {"error": "down"})
        code, out, _ = run_cli(smoke.main, [])
        self.assertEqual(code, 1)
        self.assertIn("FAIL", out)
        self.assertIn("NOT trustworthy", out)

    def test_missing_field_in_shape_is_caught(self):
        full_wiring(self.stub, self._tmp.name)
        self.stub.routes["/api/sessions"] = [{"session_id": SID}]  # rows lack required fields
        code, out, _ = run_cli(smoke.main, [])
        self.assertEqual(code, 1)


class InstancesTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.dir_a = "c:\\i\\a"
        self.quit_path = f"/api/instances/{urllib.parse.quote(self.dir_a, safe='')}/quit"
        self.open_path = f"/api/instances/{urllib.parse.quote(self.dir_a, safe='')}/open"

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_open_resolves_by_num_and_posts(self):
        full_wiring(self.stub, self._tmp.name)
        self.stub.routes[self.open_path] = {"ok": True, "action": "open", "message": "opened"}
        code, out, _ = run_cli(open_instance.main, ["1"])
        self.assertEqual(code, 0)
        self.assertEqual([p for p, _ in self.stub.posts], [self.open_path])

    def test_open_unknown_instance_is_deterministic_exit_3(self):
        full_wiring(self.stub, self._tmp.name)
        code, _, err = run_cli(open_instance.main, ["zz"])
        self.assertEqual(code, 3)
        self.assertIn("no instance matches", err)
        self.assertEqual(self.stub.posts, [])

    def test_quit_refuses_while_a_chat_has_a_live_writer(self):
        full_wiring(self.stub, self._tmp.name, live={"pid": 7, "name": "w"})
        code, _, err = run_cli(quit_instance.main, ["a"])
        self.assertEqual(code, 2)
        self.assertIn("LIVE writers", err)
        self.assertEqual(self.stub.posts, [])

    def test_quit_force_overrides_the_writer_check(self):
        full_wiring(self.stub, self._tmp.name, live={"pid": 7, "name": "w"})
        self.stub.routes[self.quit_path] = {"ok": True, "message": "quit"}
        code, _, _ = run_cli(quit_instance.main, ["a", "--force"])
        self.assertEqual(code, 0)
        self.assertEqual([p for p, _ in self.stub.posts], [self.quit_path])

    def test_quit_idle_instance_posts_and_passes_confirm_external(self):
        full_wiring(self.stub, self._tmp.name, live=None)
        self.stub.routes[self.quit_path] = {"ok": True, "message": "quit"}
        code, _, _ = run_cli(quit_instance.main, ["a", "--confirm-external"])
        self.assertEqual(code, 0)
        self.assertEqual(self.stub.posts[-1][1], {"confirmExternal": True})

    def test_quit_refuses_writer_even_when_session_id_rolled(self):
        # After a compaction roll the dossier's cliSessionId differs from the sessions row's
        # id - the live writer must still be seen (an exact-id match silently missed it).
        full_wiring(self.stub, self._tmp.name)
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"instance": "a", "chatId": "c", "cliSessionId": "rolled-new-id",
                         "archived": False, "lineageIds": [], "live": {"pid": 8, "name": "w"}}]
        }
        code, _, err = run_cli(quit_instance.main, ["a"])
        self.assertEqual(code, 2)
        self.assertIn("LIVE writers", err)
        self.assertEqual(self.stub.posts, [])

    def test_list_instances_survives_half_registered_row(self):
        import list_instances

        self.stub.routes["/api/fleet"] = {
            "instances": [
                {"num": None, "name": None, "isRunning": False, "dir": "d0"},
                {"num": 1, "name": "a", "isRunning": True, "signedIn": True, "dir": "d1"},
            ]
        }
        code, out, _ = run_cli(list_instances.main, [])
        self.assertEqual(code, 0)
        self.assertIn("(unnamed)", out)
        self.assertIn("1 open of 2 listed", out)

    def test_quit_not_running_changes_nothing(self):
        full_wiring(self.stub, self._tmp.name)
        self.stub.routes["/api/fleet"] = {
            "instances": [{"num": 1, "name": "a", "dir": self.dir_a, "isRunning": False}]
        }
        code, out, _ = run_cli(quit_instance.main, ["a"])
        self.assertEqual(code, 0)
        self.assertIn("nothing to do", out)
        self.assertEqual(self.stub.posts, [])


if __name__ == "__main__":
    unittest.main()
