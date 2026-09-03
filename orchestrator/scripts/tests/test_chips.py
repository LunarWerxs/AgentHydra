"""chips.py - the suggested-task chips lane: plan and act, never blind.

The actuator (scripts/actuator/chip.ps1) is proven live; here it is a fake. What these pin:
a chip whose task is already open is DISMISSED, not started twice; a chip on a held chat is
left; a start is deferred at the running cap; a start is confirmed through the sessions index
and noted on the ledger; nothing acts without the icon."""

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

import chips  # noqa: E402
from lib import armlib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402

INST = {"num": 1, "name": "hot", "dir": "c:\\i\\hot", "isRunning": True, "signedIn": True}


class ChipsTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.addCleanup(self._state.cleanup)
        self.stub = StubDaemon()
        self.addCleanup(self.stub.close)
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [INST]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.sessions = [{"session_id": "parent-1", "title": "Parent chat", "instance": "hot",
                          "archived": False, "transcript_path": "", "last_activity_at": 1,
                          "cwd": "D:\\NEWProjects"}]
        self.stub.routes["/api/sessions"] = lambda m, p, q, b: self.sessions
        armlib.arm(600)
        self.calls = []

    def _fake_run(self, scan_found=True, start_code=0):
        def run(args, timeout=90):
            self.calls.append(args)
            if "-Scan" in args:
                return (0, json.dumps({"found": scan_found, "title": "Fix the leak", "description": "cleans up",
                                       "chat": "Parent chat"})) if scan_found else (3, '{"found": false}')
            if "-StartLocally" in args:
                return start_code, "STARTED LOCALLY: 'Fix the leak' -> new chat row 'Running Fix the leak'"
            if "-Dismiss" in args:
                return 0, "dismissed the suggestion 'Fix the leak'"
            return 1, "?"
        return run

    def test_a_chip_in_the_open_chat_is_planned_to_start_locally(self):
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]):
            rows = chips.plan(hydralib.fleet())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["action"], "start")
        self.assertEqual(rows[0]["title"], "Fix the leak")

    def test_a_chip_whose_task_is_already_open_is_dismissed_not_started(self):
        self.sessions.append({"session_id": "already-1", "title": "Fix the leak", "instance": "hot",
                              "archived": False, "transcript_path": "", "last_activity_at": 2})
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()) as run, \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(chips.time, "sleep"):
            rows = chips.plan(hydralib.fleet())
            self.assertEqual(rows[0]["action"], "dismiss")
            results = chips.execute(rows)
        self.assertTrue(results[0]["ok"])
        self.assertTrue(any("-Dismiss" in c for c in self.calls))
        self.assertFalse(any("-StartLocally" in c for c in self.calls))

    def test_a_chip_on_a_held_chat_is_left_alone(self):
        holdlib.hold("parent-1", "mine")
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]):
            rows = chips.plan(hydralib.fleet())
            results = chips.execute(rows)
        self.assertEqual(rows[0]["action"], "leave")
        self.assertEqual(results[0]["outcome"], "left")
        self.assertFalse(any("-StartLocally" in c for c in self.calls))

    def test_a_start_is_deferred_at_the_running_cap(self):
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(hydralib, "running_count", return_value=hydralib.MAX_RUNNING_CHATS):
            results = chips.execute(chips.plan(hydralib.fleet()))
        self.assertTrue(results[0]["ok"])
        self.assertIn("cap", results[0]["outcome"])
        self.assertFalse(any("-StartLocally" in c for c in self.calls))

    def test_a_chip_is_spawned_through_the_toolbox_in_the_parents_folder_then_dismissed(self):
        # owner, 2026-09-01: "just create a new chat using the prompt it gave you, then
        # dismiss the chip" - the spawner carries the rails the app's start menu does not.
        import spawn_chat
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(hydralib, "running_count", return_value=3), \
             mock.patch.object(spawn_chat, "spawn", return_value={
                 "ok": True, "instance": "hot", "sessionId": "new-1", "started": "running (first turn)",
                 "modeSet": "set"}) as spawn:
            results = chips.execute(chips.plan(hydralib.fleet()))
        self.assertTrue(results[0]["ok"], results[0]["outcome"])
        folder, prompt, inst = spawn.call_args.args
        self.assertEqual(folder, "D:\\NEWProjects")
        self.assertTrue(prompt.startswith("Fix the leak"))
        self.assertIn("cleans up", prompt)
        self.assertEqual(inst, "hot")
        self.assertEqual(results[0]["newSessionId"], "new-1")
        self.assertTrue(any(r.get("kind") == "spawned" and r.get("session") == "new-1" for r in ledgerlib._load()))
        self.assertTrue(any("-Dismiss" in c for c in self.calls), "the chip is dismissed after the spawn")
        self.assertFalse(any("-StartLocally" in c for c in self.calls), "never the app's start menu")

    def test_the_spawners_duplicate_guard_dismisses_the_chip(self):
        import spawn_chat
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(hydralib, "running_count", return_value=3), \
             mock.patch.object(spawn_chat, "spawn", return_value={
                 "ok": False, "duplicateOf": [{"title": "Fix the leak"}], "why": "a chat for this exact task already exists"}):
            results = chips.execute(chips.plan(hydralib.fleet()))
        self.assertTrue(results[0]["ok"])
        self.assertIn("already open", results[0]["outcome"])
        self.assertTrue(any("-Dismiss" in c for c in self.calls))

    def test_an_unconfirmed_spawn_is_reported_not_claimed(self):
        import spawn_chat
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(hydralib, "running_count", return_value=3), \
             mock.patch.object(spawn_chat, "spawn", return_value={
                 "ok": True, "instance": "hot", "sessionId": "new-2", "started": "not confirmed", "modeSet": "set"}):
            results = chips.execute(chips.plan(hydralib.fleet()))
        self.assertFalse(results[0]["ok"])
        self.assertIn("NOT confirmed", results[0]["outcome"])

    def test_a_refused_spawn_is_a_failure_and_the_chip_stays(self):
        import spawn_chat
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(hydralib, "running_count", return_value=3), \
             mock.patch.object(spawn_chat, "spawn", return_value={"ok": False, "why": "window busy"}):
            results = chips.execute(chips.plan(hydralib.fleet()))
        self.assertFalse(results[0]["ok"])
        self.assertFalse(any("-Dismiss" in c for c in self.calls))

    def test_disarmed_plans_only(self):
        armlib.disarm()
        with mock.patch.object(chips, "_run", side_effect=self._fake_run()), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]):
            code = chips.main(["--yes"])
        self.assertEqual(code, 0)
        self.assertFalse(any("-StartLocally" in c for c in self.calls))

    def test_a_recorded_chip_from_the_doctrine_pass_is_acted_on(self):
        chips.record("hot", "Parent chat", "Fix the leak", "cleans up")
        with mock.patch.object(chips, "_run", side_effect=self._fake_run(scan_found=False)), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]):
            rows = chips.plan(hydralib.fleet())
        self.assertEqual([r["source"] for r in rows], ["recorded"])
        self.assertEqual(rows[0]["action"], "start")


if __name__ == "__main__":
    unittest.main()
