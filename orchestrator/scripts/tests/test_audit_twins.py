"""audit_twins.py: two different kinds of duplicate chat, and the report/--fix contract.

find_twins() catches a chat visible in two DESKTOP RECORDS at once (a re-import artefact);
find_same_task() catches the SAME TASK started in two separate real chats (owner, 2026-09-01:
two identical review chats, 30 minutes apart, both running). Neither ever deletes anything -
find_twins's stale copy is archived (reversible), find_same_task's later chat is only HELD.
"""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import audit_twins  # noqa: E402
from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402

from util import run_cli  # noqa: E402

# A real task signature: long enough (>= 60 chars) to clear find_same_task's own 40-char floor
# after normalization, and nowhere near any boilerplate prefix.
TASK_A = ("Please refactor the payment retry logic so failed charges are retried with backoff "
          "and logged clearly for support to review later")
# The launcher prepends the working folder before the prompt it fires (measured 2026-09-01):
# same task, same chat in spirit, a different literal string.
TASK_B_PREFIXED = "D:\\x\\app " + TASK_A
TASK_C_DIFFERENT = ("Investigate why the nightly export job silently drops rows over ten "
                     "thousand and fix the pagination bug end to end")
# The toolbox's own sweep opener - identical text sent to many chats on purpose, never a
# duplicate of itself (is_boilerplate_task must catch it before same_task ever compares text).
SWEEP_OPENER = ("ultracode\n\n/orchestrate The standing sweep opened this session because there "
                "is queued work waiting for you to pick up and finish carefully")


class FindSameTaskTest(unittest.TestCase):
    """find_same_task / fix_same_task / main()'s text report over that lane."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)  # so --fix (and fix_same_task) act instead of refusing
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot", "dir": str(self.root / "hot"),
             "isRunning": True, "signedIn": True},
            {"num": 2, "name": "cool", "dir": str(self.root / "cool"),
             "isRunning": True, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/sessions"] = []
        self.stub.routes["/api/chats/dossier"] = {"matches": []}
        # store_roots() also globs a "default" AppData store off Path.home() - keep the test
        # off this machine's real desktop chats entirely.
        self._home = mock.patch("pathlib.Path.home", return_value=self.root / "nohome")
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _row(self, sid, instance, text, created_at, title="Chat"):
        tp = self.root / f"{sid}.jsonl"
        tp.write_text(json.dumps({"type": "user", "message": {"content": text}}) + "\n",
                      encoding="utf-8")
        return {"session_id": sid, "title": title, "instance": instance, "archived": False,
                "transcript_path": str(tp), "createdAt": created_at}

    def test_find_same_task_groups_the_prefixed_duplicate_only(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup, 30min later)"),
            self._row("s-c", "cool", TASK_C_DIFFERENT, 1_002_000, "A different task"),
            self._row("s-d", "hot", SWEEP_OPENER, 1_003_000, "Sweep opener 1"),
            self._row("s-e", "cool", SWEEP_OPENER, 1_003_100, "Sweep opener 2"),
        ]
        groups = audit_twins.find_same_task()
        self.assertEqual(len(groups), 1)
        g = groups[0]
        self.assertEqual(g["keep"]["sessionId"], "s-a")  # the earlier createdAt
        self.assertEqual([c["sessionId"] for c in g["later"]], ["s-b"])
        grouped = {c["sessionId"] for grp in groups for c in grp["chats"]}
        self.assertNotIn("s-c", grouped)  # genuinely different task
        self.assertNotIn("s-d", grouped)  # boilerplate sweep opener
        self.assertNotIn("s-e", grouped)  # ditto, even though identical to s-d

    def test_fix_same_task_holds_the_later_chat_and_never_archives(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup)"),
        ]
        meta_dir = self.root / "cool" / "claude-code-sessions" / "p" / "c"
        meta_dir.mkdir(parents=True, exist_ok=True)
        meta_path = meta_dir / "local_s-b.json"
        meta_path.write_text(json.dumps(
            {"cliSessionId": "s-b", "isArchived": False, "title": "Task B (dup)"}),
            encoding="utf-8")

        from lib import holdlib

        done = audit_twins.fix_same_task(audit_twins.find_same_task())
        self.assertEqual(len(done), 1)
        self.assertIn("HELD as a duplicate", done[0]["outcome"])
        self.assertIn("DUPLICATE TASK", holdlib.why_blocked("s-b"))
        self.assertFalse(json.loads(meta_path.read_text(encoding="utf-8"))["isArchived"])

        # a second pass over the same groups must not re-hold - it recognizes the hold already
        # in place and says so, rather than acting again.
        done2 = audit_twins.fix_same_task(audit_twins.find_same_task())
        self.assertEqual(len(done2), 1)
        self.assertEqual(done2[0]["outcome"], "already held")
        self.assertFalse(json.loads(meta_path.read_text(encoding="utf-8"))["isArchived"])

    def test_main_dry_run_reports_and_fix_holds_and_says_HELD(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-a", "hot", TASK_A, 1_000_000, "Task A"),
            self._row("s-b", "cool", TASK_B_PREFIXED, 1_001_800, "Task B (dup)"),
        ]
        code, out, _ = run_cli(audit_twins.main, [])
        self.assertEqual(code, 2)
        self.assertIn("task(s) started MORE THAN ONCE", out)
        self.assertIn("KEEP", out)
        self.assertIn("DUP", out)

        code2, out2, _ = run_cli(audit_twins.main, ["--fix"])
        self.assertEqual(code2, 0)
        self.assertIn("HELD as a duplicate", out2)

    def test_main_with_nothing_duplicated_prints_that_and_exits_0(self):
        self.stub.routes["/api/sessions"] = [
            self._row("s-only", "hot", TASK_A, 1_000_000, "Solo task"),
        ]
        code, out, _ = run_cli(audit_twins.main, [])
        self.assertEqual(code, 0)
        self.assertIn("nothing duplicated", out)


class FindTwinsLineageTest(unittest.TestCase):
    """find_twins(): two desktop records with DIFFERENT cli ids but one lineage are one twin."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.home_inst = "home_inst"
        self.other_inst = "other_inst"
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": self.home_inst, "dir": str(self.root / "home"),
             "isRunning": True, "signedIn": True},
            {"num": 2, "name": self.other_inst, "dir": str(self.root / "other"),
             "isRunning": True, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self._home = mock.patch("pathlib.Path.home", return_value=self.root / "nohome")
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _meta(self, instance_dir_name, cli_id, created_at=1_000_000, title="Twin chat"):
        d = self.root / instance_dir_name / "claude-code-sessions" / "p" / "c"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"local_{cli_id}.json").write_text(json.dumps(
            {"cliSessionId": cli_id, "isArchived": False, "title": title,
             "createdAt": created_at}), encoding="utf-8")

    def test_lineage_merge_makes_one_twin_group_and_keeps_the_home_copy(self):
        a_id, b_id = "cli-aaaa", "cli-bbbb"
        self._meta("home", a_id, created_at=1_000_000)
        self._meta("other", b_id, created_at=1_005_000)
        # the daemon says A's cli id now belongs to the home instance.
        self.stub.routes["/api/sessions"] = [
            {"session_id": a_id, "instance": self.home_inst, "archived": False}]

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            if q == a_id:
                return {"matches": [{"cliSessionId": a_id, "lineageIds": [a_id, b_id]}]}
            if q == b_id:
                return {"matches": [{"cliSessionId": b_id, "lineageIds": [b_id]}]}
            return {"matches": []}

        self.stub.routes["/api/chats/dossier"] = dossier_route

        twins = audit_twins.find_twins()
        self.assertEqual(len(twins), 1)
        t = twins[0]
        self.assertEqual(len(t["copies"]), 2)
        self.assertIsNotNone(t["keep"])
        self.assertEqual(t["keep"]["instance"], self.home_inst)
        self.assertEqual(t["keep"]["stem"], f"local_{a_id}")
        self.assertEqual(len(t["stale"]), 1)
        self.assertEqual(t["stale"][0]["instance"], self.other_inst)


if __name__ == "__main__":
    unittest.main()
