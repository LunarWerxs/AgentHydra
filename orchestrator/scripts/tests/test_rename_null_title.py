"""Regression test for docs/todo/TODO.md's 'Overnight orchestration run' item 2, first half.

rename_chat.py used to forward the dossier's title verbatim as `-Title`: a freshly imported chat
lands with title: null on disk, `str(None or "")` collapsed that to an empty string, and the
actuator's mandatory `-Title` refused it before ever looking for a row ("-Title is required").
The running app itself renders a titleless import as 'Untitled', so that is the name the
actuator must be asked for - this pins that the fallback lands, without driving any real UIA
actuator (the drive is stubbed, exactly like RenameTest in test_migrate_rename.py)."""

import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

SID = "cccc1111-2222-3333-4444-555566667777"


class NullDiskTitleReachesActuatorAsUntitledTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        from lib import hydralib

        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {
            "instances": [
                {"num": 5, "name": "5claude", "dir": "c:\\i\\5claude",
                 "ref": "desktop:c:\\i\\5claude", "isRunning": True},
            ]
        }

        def dossier_route(method, path, query, body):
            # Answer BY the query, like the real daemon - a null-titled row has no title
            # fragment to be found by, so the only route in is the session id.
            if dossier_query(query) != SID:
                return {"matches": []}
            return {
                "matches": [
                    {
                        "instance": "5claude",
                        "chatId": "local_untitled",
                        "cliSessionId": SID,
                        "lineageIds": [SID],
                        "title": None,  # exactly what a freshly imported chat's dossier carries
                        "archived": False,
                        "lastActivityAt": "T1",
                        "live": None,
                    }
                ]
            }

        self.stub.routes["/api/chats/dossier"] = dossier_route

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_null_disk_title_still_reaches_the_actuator_as_untitled(self):
        import rename_chat

        calls = []

        def fake_drive(instance, old_title, new_title):
            calls.append((instance, old_title, new_title))
            # The actuator drive itself is out of scope here (it needs a live UIA element,
            # forbidden in a unit test) - only the title rename_chat forwards matters.
            return 1, "stub: never actually drove the actuator"

        with mock.patch.object(rename_chat, "_drive_rename", side_effect=fake_drive):
            code = rename_chat.main([SID, "--to", "Real name"])
        self.assertEqual(code, 1)  # the stub always fails the drive; irrelevant to this bug
        self.assertEqual(calls, [("5claude", "Untitled", "Real name")])


if __name__ == "__main__":
    unittest.main()
