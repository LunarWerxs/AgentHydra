"""Native-first routing with inert daemon replies; no windows, processes, or real state."""

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import archive_chat  # noqa: E402
import migrate_chat  # noqa: E402
from lib import hydralib, nativearchivelib  # noqa: E402


SID = "aaaa1111-2222-3333-4444-555566667777"
SOURCE = {"name": "source", "dir": "D:\\profiles\\source", "isRunning": True}
TARGET = {"name": "target", "dir": "D:\\profiles\\target", "isRunning": True}
FLEET = {"instances": [SOURCE, TARGET]}
MATCH = {"instance": "source", "title": "Disposable chat", "cliSessionId": SID,
         "archived": False, "live": None}


class NativeArchivePathsTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.calls = []
        self.status = 200
        self.reply = {"available": True, "ok": True, "verified": True,
                      "dispatch": "sent", "changed": True, "route": "native"}
        base = "inproc://native-archive-path-tests"
        self.stack.enter_context(mock.patch.object(hydralib, "BASE", base))
        self.stack.enter_context(mock.patch.dict(hydralib.INPROC, {base: self.handle}))
        self.stack.enter_context(mock.patch("urllib.request.urlopen",
                                           side_effect=AssertionError("network is forbidden")))
        self.lock = self.patch(archive_chat.windowlib, "instance_lock",
                               side_effect=AssertionError("native path must not lock a window"))
        self.placement = self.patch(archive_chat.windowlib, "keep_placement",
                                    side_effect=AssertionError("native path must not drive a window"))
        self.actuator = self.patch(archive_chat.clilib, "run_text",
                                   side_effect=AssertionError("native path must not run PowerShell"))
        self.patch(archive_chat, "ACTUATOR", new=mock.Mock(exists=lambda: True))
        self.dossier = self.patch(hydralib, "resolve_one",
                                  side_effect=AssertionError("native proof must not be reverified on disk"))
        self.legacy_verify = self.patch(archive_chat, "_verify_archive",
                                        side_effect=AssertionError("legacy verify must not run"))
        self.disk = self.patch(migrate_chat, "_archive_source_on_disk",
                               side_effect=AssertionError("native result must not fall back to a disk flag"))
        self.disk_read = self.patch(migrate_chat, "_source_still_visible",
                                    side_effect=AssertionError("native proof must not poll disk"))
        self.tombstone = self.patch(migrate_chat, "_tombstone_source_session_file",
                                    return_value="fixture-tombstone")
        for name in ("note", "verify", "clear", "annotate"):
            self.patch(archive_chat.ledgerlib, name)
        self.record = self.patch(archive_chat.mutationlib, "record")

    def patch(self, owner, name, **kwargs):
        return self.stack.enter_context(mock.patch.object(owner, name, **kwargs))

    def handle(self, method, path, data):
        body = json.loads(data) if data is not None else None
        self.calls.append((method, path, body))
        if method == "GET" and path == "/api/fleet":
            return 200, json.dumps(FLEET).encode()
        if method == "POST" and path == f"/api/sessions/{SID}/native-archive":
            self.assertEqual(body, {"instance_ref": "desktop:" + SOURCE["dir"]})
            return self.status, json.dumps(self.reply).encode()
        raise AssertionError(f"Unexpected daemon request: {method} {path}")

    def native_posts(self):
        return [call for call in self.calls if call[0] == "POST"]

    def capture(self, function, *args, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = function(*args, **kwargs)
        return code, json.loads(output.getvalue())

    def assert_no_legacy(self):
        self.lock.assert_not_called()
        self.placement.assert_not_called()
        self.actuator.assert_not_called()
        self.dossier.assert_not_called()
        self.legacy_verify.assert_not_called()
        self.disk.assert_not_called()
        self.disk_read.assert_not_called()

    def allow_ui(self):
        self.lock.side_effect = lambda *args, **kwargs: contextlib.nullcontext(True)
        self.placement.side_effect = lambda *args, **kwargs: contextlib.nullcontext()
        self.actuator.side_effect = None
        self.actuator.return_value = SimpleNamespace(returncode=0, stdout="Archive done", stderr="")

    def test_native_archive_verification_skips_windows_powershell_and_dossier(self):
        code, output = self.capture(archive_chat._act_and_verify,
                                    SID, MATCH, False, True, "archive", MATCH["title"], False, True)
        self.assertEqual(code, 0)
        self.assertEqual(output["via"], "app-native")
        self.assertTrue(output["durable"])
        self.assertTrue(output["changed"])
        self.assertIn("native session state", output["report"])
        self.assertEqual(len(self.native_posts()), 1)
        self.assert_no_legacy()
        self.record.assert_called_once()

    def test_already_archived_native_noop_does_not_claim_a_visible_row_was_changed(self):
        self.reply.update(dispatch="not-sent", changed=False)
        match = {**MATCH, "archived": True}
        code, output = self.capture(archive_chat._handle_already_settled,
                                    match, True, "archive", MATCH["title"], True)
        self.assertEqual(code, 0)
        self.assertFalse(output["changed"])
        self.assertEqual(output["via"], "app-native")
        self.assertNotIn("screen and disk agree", output["report"])
        self.assert_no_legacy()

    def test_terminal_archive_does_not_retry_through_windows_or_disk(self):
        self.status = 409
        self.reply.update(ok=False, verified=False, dispatch="unknown", reason="reply lost")
        code, output = self.capture(archive_chat._act_and_verify,
                                    SID, MATCH, False, True, "archive", MATCH["title"], False, True)
        self.assertEqual(code, 7)
        self.assertIsNone(output["changed"])
        self.assertIsNone(output["durable"])
        self.assertIn("No UI or disk fallback", output["report"])
        self.assertEqual(len(self.native_posts()), 1)
        self.assert_no_legacy()
        self.record.assert_not_called()

    def test_migration_native_terminal_blocks_disk_fallback_and_tombstone(self):
        self.status = 409
        self.reply.update(ok=False, verified=False, dispatch="sent", reason="state unconfirmed")
        note, state = migrate_chat._settle_source_row(MATCH, TARGET, FLEET, SID, MATCH["title"])
        self.assertEqual(state, "visible")
        self.assertIn("NOT confirmed settled", note)
        self.assertIn("No UI or disk fallback", note)
        self.assertEqual(len(self.native_posts()), 1)
        self.assert_no_legacy()
        self.tombstone.assert_not_called()

    def test_verified_migration_skips_disk_confirmation_but_keeps_deliberate_tombstone(self):
        note, state = migrate_chat._settle_source_row(MATCH, TARGET, FLEET, SID, MATCH["title"])
        self.assertEqual(state, "settled")
        self.assertIn("exact native session state", note)
        self.assertIn("Source record tombstoned", note)
        self.tombstone.assert_called_once_with(SID, "source", TARGET, FLEET)
        self.assertEqual(len(self.native_posts()), 1)
        self.assert_no_legacy()

    def test_explicit_native_unavailability_uses_existing_locked_ui_paths(self):
        self.reply = {"available": False, "ok": False, "verified": False,
                      "dispatch": "not-sent", "reason": "not configured"}
        self.allow_ui()
        archive_result = archive_chat._ui_archive("source", MATCH["title"], False, session_id=SID)
        settle_result = migrate_chat._settle_source(SOURCE["dir"], MATCH["title"], session_id=SID)
        self.assertEqual(archive_result, (0, "Archive done"))
        self.assertEqual(settle_result, (0, "Archive done"))
        self.assertEqual(len(self.native_posts()), 2)
        self.assertEqual(self.lock.call_count, 2)
        self.assertEqual(self.actuator.call_count, 2)
        self.lock.assert_any_call("source", wait_secs=60)
        self.lock.assert_any_call(SOURCE["dir"], wait_secs=60)
        for call in self.actuator.call_args_list:
            self.assertEqual(call.args[0][0], "powershell")
            self.assertIn("Archive", call.args[0])

    def test_unarchive_uses_existing_ui_without_posting_native_archive(self):
        self.allow_ui()
        result = archive_chat._ui_archive("source", MATCH["title"], True, session_id=SID)
        self.assertEqual(result, (0, "Archive done"))
        self.assertEqual(self.calls, [])
        self.lock.assert_called_once_with("source", wait_secs=60)
        self.assertIn("Unarchive", self.actuator.call_args.args[0])

    def test_legacy_direct_call_without_id_keeps_existing_ui_behavior(self):
        self.allow_ui()
        archived = archive_chat._ui_archive("source", MATCH["title"], False)
        settled = migrate_chat._settle_source(SOURCE["dir"], MATCH["title"])
        self.assertEqual(archived, (0, "Archive done"))
        self.assertEqual(settled, (0, "Archive done"))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.lock.call_count, 2)
        self.assertEqual(self.actuator.call_count, 2)

    def test_direct_native_archive_result_preserves_the_sentinel_for_callers(self):
        code, detail = archive_chat._ui_archive(SOURCE["dir"], MATCH["title"], False,
                                                session_id=SID)
        self.assertEqual(code, nativearchivelib.NATIVE_VERIFIED)
        self.assertEqual(nativearchivelib.result(detail), self.reply)
        self.assert_no_legacy()


if __name__ == "__main__":
    unittest.main()
