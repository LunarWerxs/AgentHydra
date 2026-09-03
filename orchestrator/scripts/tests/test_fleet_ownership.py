"""Which fleet owns a chat - the boundary between the desktop and console orchestrators.

Both fleets leave transcripts in the same shape and both register under sessions/ while
running, so nothing about those files says whose chat it is. Getting this wrong went both ways
on 2026-09-01: the desktop lane spent its breaker composer-delivering to a console probe, and
the console floor lane listed every desktop chat as something to `claude --resume` in a
terminal. The rule is POSITIVE EVIDENCE ONLY, and these tests pin both proofs and the refusal.
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

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402
from lib import peerlib  # noqa: E402


class ConsoleOwnershipTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.default = self.root / "dotclaude"
        self.accounts = self.root / "cli-instances"
        (self.default / "sessions").mkdir(parents=True)
        (self.accounts / "acct-a" / "projects" / "p").mkdir(parents=True)
        self._env = {k: os.environ.get(k) for k in ("CLAUDE_CONFIG_DIR", "ORCH_CLI_ACCOUNTS")}
        os.environ["CLAUDE_CONFIG_DIR"] = str(self.default)
        os.environ["ORCH_CLI_ACCOUNTS"] = str(self.accounts)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._tmp.cleanup()

    def _register(self, pid, sid, entrypoint):
        (self.default / "sessions" / f"{pid}.json").write_text(json.dumps(
            {"pid": str(pid), "sessionId": sid, "cwd": "D:/x", "startedAt": "1",
             "entrypoint": entrypoint}), encoding="utf-8")

    def test_a_transcript_under_a_console_account_dir_is_console_born(self):
        (self.accounts / "acct-a" / "projects" / "p" / "c-1.jsonl").write_text("{}", encoding="utf-8")
        self.assertIn("c-1", hydralib.console_session_ids())

    def test_a_registry_record_started_by_the_cli_is_console_born(self):
        self._register(11, "c-2", "cli")
        self.assertIn("c-2", hydralib.console_session_ids())

    def test_a_registry_record_started_by_the_desktop_app_is_NOT(self):
        self._register(12, "d-1", "claude-desktop")
        self.assertNotIn("d-1", hydralib.console_session_ids())

    def test_a_dormant_transcript_under_the_default_dir_is_claimed_by_nobody(self):
        # The daemon imports console sessions into desktop stores on its own, so a bare
        # ~/.claude transcript is ambiguous - and ambiguity resolves to "leave it alone".
        (self.default / "projects" / "p").mkdir(parents=True)
        (self.default / "projects" / "p" / "amb-1.jsonl").write_text("{}", encoding="utf-8")
        self.assertNotIn("amb-1", hydralib.console_session_ids())


class DesktopVisibilityTest(unittest.TestCase):
    """visible_chats drops only what the console side can PROVE is its own."""

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "t1", "dir": "c:\\i\\t1", "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions"] = [
            {"session_id": "desk-1", "instance": "t1", "archived": False, "title": "Desktop"},
            {"session_id": "con-1", "instance": "t1", "archived": False, "title": "Console"},
        ]

    def tearDown(self):
        self.stub.close()

    def test_a_proven_console_session_is_not_a_desktop_chat(self):
        with mock.patch.object(hydralib, "console_session_ids", return_value={"con-1"}):
            ids = [r["session_id"] for r in hydralib.visible_chats()]
        self.assertIn("desk-1", ids)
        self.assertNotIn("con-1", ids)

    def test_with_no_proof_every_daemon_row_stays_visible(self):
        # The earlier "no desktop meta => console" heuristic blinded the desktop lanes on any
        # machine whose regular app store exists while the fleet's dirs do not (every test).
        with mock.patch.object(hydralib, "console_session_ids", return_value=set()):
            ids = [r["session_id"] for r in hydralib.visible_chats()]
        self.assertEqual(sorted(ids), ["con-1", "desk-1"])


if __name__ == "__main__":
    unittest.main()
