"""mutationlib + undo.py: the before/after mutation ledger and its undo path.

Covers the library in isolation (record/list/get/mark_undone, the undoable=False contract,
the closed kind set), undo.py's pure dispatch table (the argv it builds per kind from a
before-image, and its refusals when that before-image is incomplete), and a full rail test
through the real hold_chat.py / undo.py pair against a stub daemon - proving an undo actually
lands through the SAME acting script, is verified by that script's OWN fresh mutation row (not
trusted on exit code alone), and that a no-op release records nothing misleading."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import mutationlib  # noqa: E402
from lib import hydralib  # noqa: E402

from util import run_cli  # noqa: E402

T0 = 1_788_000_000_000
SID = "mmmm1111-2222-3333-4444-555566667777"


class MutationLibTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_record_list_get_roundtrip(self):
        mid = mutationlib.record(
            "archive", "s1", instance="cold", title="T",
            before={"archived": False}, after={"archived": True}, now_ms=T0,
        )
        row = mutationlib.get(mid)
        self.assertEqual(row["kind"], "archive")
        self.assertEqual(row["before"], {"archived": False})
        self.assertEqual(row["after"], {"archived": True})
        self.assertTrue(row["undoable"])
        self.assertIsNone(row["undoneAt"])
        rows = mutationlib.list_mutations()
        self.assertEqual([r["id"] for r in rows], [mid])

    def test_a_staged_act_records_its_first_phase_and_advances_through_the_rest(self):
        """THE ARCHIVE SWEEP, 2026-09-13. A migrate is four acts, and only the first pair was
        ever written down, so a batch killed mid-flight left 14 chats imported-but-unsettled
        with nothing on the machine saying which. The row carries how far it got now."""
        mid = mutationlib.record("migrate", "s1", before={"instance": "a"},
                                 after={"instance": "b"}, phase="imported", now_ms=T0)
        self.assertEqual(mutationlib.get(mid)["phase"], "imported")
        self.assertTrue(mutationlib.advance_phase(mid, "settle-settled", now_ms=T0 + 5))
        self.assertTrue(mutationlib.advance_phase(mid, "stamped", now_ms=T0 + 9))
        row = mutationlib.get(mid)
        self.assertEqual(row["phase"], "stamped")
        self.assertEqual(row["phaseAt"], T0 + 9)
        self.assertEqual([h["phase"] for h in row["phaseHistory"]],
                         ["imported", "settle-settled", "stamped"],
                         "every step keeps its timestamp: 'settled at 21:04' is the evidence")

    def test_advancing_an_unknown_id_answers_false_rather_than_inventing_a_row(self):
        self.assertFalse(mutationlib.advance_phase("nosuchid", "stamped"))
        self.assertEqual(mutationlib.list_mutations(), [])

    def test_a_row_recorded_without_a_phase_carries_none_at_all(self):
        """Every other act is ONE act. A phase field on those would be noise, and a reader
        must not mistake its absence for 'finished' - see migrate_reconcile."""
        mid = mutationlib.record("archive", "s1", before={}, after={}, now_ms=T0)
        self.assertNotIn("phase", mutationlib.get(mid))
        # ...and it can still be given one later without losing the history it never had.
        self.assertTrue(mutationlib.advance_phase(mid, "settled-verified", now_ms=T0 + 1))
        self.assertEqual([h["phase"] for h in mutationlib.get(mid)["phaseHistory"]],
                         ["settled-verified"])

    def test_list_is_newest_first_and_filters_by_session_and_kind(self):
        mutationlib.record("archive", "s1", before={}, after={}, now_ms=T0)
        mutationlib.record("rename", "s1", before={}, after={}, now_ms=T0 + 1)
        mutationlib.record("archive", "s2", before={}, after={}, now_ms=T0 + 2)
        all_rows = mutationlib.list_mutations()
        self.assertEqual([r["at"] for r in all_rows], [T0 + 2, T0 + 1, T0])
        self.assertEqual(len(mutationlib.list_mutations(session_id="s1")), 2)
        self.assertEqual(len(mutationlib.list_mutations(kind="archive")), 2)
        self.assertEqual(len(mutationlib.list_mutations(session_id="s1", kind="rename")), 1)

    def test_get_unknown_id_is_none(self):
        self.assertIsNone(mutationlib.get("nope"))

    def test_unknown_kind_refused(self):
        with self.assertRaises(ValueError):
            mutationlib.record("frobnicate", "s1", before={}, after={})

    def test_undoable_false_demands_a_reason(self):
        # never fabricate a reason - a caller that says undoable=False must say WHY.
        with self.assertRaises(ValueError):
            mutationlib.record("rename", "s1", before={}, after=None, undoable=False)

    def test_undoable_false_reason_is_kept_verbatim(self):
        mid = mutationlib.record(
            "rename", "s1", before={"title": "old"}, after=None, undoable=False,
            why_not="verify failed - unconfirmed",
        )
        self.assertEqual(mutationlib.get(mid)["whyNot"], "verify failed - unconfirmed")

    def test_compact_is_never_undoable_even_if_the_caller_says_so(self):
        # compaction is lossy BY DESIGN - no inverse exists, so undoable is forced False and
        # the reason is filled in automatically even when a caller mistakenly passes True.
        mid = mutationlib.record(
            "compact", "s1", before={"contextTokens": 200000}, after={"contextTokens": 90000},
            undoable=True,
        )
        row = mutationlib.get(mid)
        self.assertFalse(row["undoable"])
        self.assertIn("no inverse", row["whyNot"])

    def test_mark_undone_links_both_rows_and_is_one_shot(self):
        original = mutationlib.record("archive", "s1", before={"archived": False},
                                      after={"archived": True}, now_ms=T0)
        undoing = mutationlib.record("unarchive", "s1", before={"archived": True},
                                     after={"archived": False}, now_ms=T0 + 10)
        self.assertTrue(mutationlib.mark_undone(original, undoing, now_ms=T0 + 11))
        orig_row = mutationlib.get(original)
        self.assertEqual(orig_row["undoneAt"], T0 + 11)
        self.assertEqual(orig_row["undoneBy"], undoing)
        self.assertEqual(mutationlib.get(undoing)["undoes"], original)
        # one-shot: undoing an already-undone row is refused, not silently re-stamped.
        self.assertFalse(mutationlib.mark_undone(original, "someone-else", now_ms=T0 + 20))
        self.assertEqual(mutationlib.get(original)["undoneBy"], undoing)  # unchanged

    def test_mark_undone_unknown_id_is_false(self):
        self.assertFalse(mutationlib.mark_undone("nope", "also-nope"))

    def test_corrupt_file_reads_as_no_mutations(self):
        (Path(self._tmp.name) / "mutations.json").write_text("{ not json", encoding="utf-8")
        self.assertEqual(mutationlib.list_mutations(), [])


class UndoDispatchTest(unittest.TestCase):
    """undo._dispatch: pure, no daemon, no state - the argv it builds per kind."""

    def test_archive_and_unarchive_are_inverse_argv(self):
        import undo

        name, argv = undo._dispatch("archive", "s1", {}, force=False)
        self.assertEqual(name, "archive_chat")
        self.assertIn("--unarchive", argv)
        name, argv = undo._dispatch("unarchive", "s1", {}, force=False)
        self.assertEqual(name, "archive_chat")
        self.assertNotIn("--unarchive", argv)

    def test_rename_uses_the_before_images_title(self):
        import undo

        name, argv = undo._dispatch("rename", "s1", {"title": "Old Name"}, force=True)
        self.assertEqual(name, "rename_chat")
        self.assertEqual(argv, ["s1", "--to", "Old Name", "--force"])

    def test_an_incomplete_before_image_or_an_unroutable_kind_refuses(self):
        import undo

        # rename needs the captured title, migrate the source, release the reason; compact has
        # no dispatch route at all.
        for kind in ("rename", "migrate", "release", "compact"):
            with self.subTest(kind), self.assertRaises(undo.UndoRefusal):
                undo._dispatch(kind, "s1", {}, force=False)

    def test_migrate_uses_the_before_images_instance(self):
        import undo

        name, argv = undo._dispatch("migrate", "s1", {"instance": "cold"}, force=False)
        self.assertEqual(name, "migrate_chat")
        self.assertEqual(argv, ["s1", "--to", "cold"])

    def test_hold_and_release_are_inverse_argv(self):
        import undo

        name, argv = undo._dispatch("hold", "s1", {}, force=False)
        self.assertEqual((name, argv), ("hold_chat", ["s1", "--release"]))
        name, argv = undo._dispatch("release", "s1", {"reason": "back to you"}, force=False)
        self.assertEqual((name, argv), ("hold_chat", ["s1", "--reason", "back to you"]))


class UndoRailTest(unittest.TestCase):
    """undo.py end to end, through the real hold_chat.py, against a stub daemon."""

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

        def dossier_route(method, path, query, body):
            if dossier_query(query) not in (SID, "T"):
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": "c1", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "T",
                                 "archived": False, "lastActivityAt": "T1", "live": None}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_undo_a_hold_releases_it_and_links_the_mutation(self):
        import hold_chat
        import undo

        code, _, _ = run_cli(hold_chat.main, [SID, "--reason", "reviewing this one"])
        self.assertEqual(code, 0)
        holds = mutationlib.list_mutations(session_id=SID, kind="hold")
        self.assertEqual(len(holds), 1)
        original_id = holds[0]["id"]
        self.assertTrue(holds[0]["undoable"])

        code, out, _ = run_cli(undo.main, [original_id])
        self.assertEqual(code, 0, out)
        self.assertIn("UNDONE", out)

        original = mutationlib.get(original_id)
        self.assertIsNotNone(original["undoneAt"])
        releases = mutationlib.list_mutations(session_id=SID, kind="release")
        self.assertEqual(len(releases), 1)
        self.assertEqual(releases[0]["undoes"], original_id)
        self.assertEqual(original["undoneBy"], releases[0]["id"])

    def test_undo_an_unknown_mutation_id_is_a_deterministic_refusal(self):
        import undo

        code, out, err = run_cli(undo.main, ["does-not-exist"])
        self.assertEqual(code, 3)
        self.assertIn("REFUSED (deterministic)", out + err)

    def test_undo_twice_refuses_the_second_time(self):
        import hold_chat
        import undo

        run_cli(hold_chat.main, [SID, "--reason", "reviewing"])
        original_id = mutationlib.list_mutations(session_id=SID, kind="hold")[0]["id"]
        code, _, _ = run_cli(undo.main, [original_id])
        self.assertEqual(code, 0)
        code, out, err = run_cli(undo.main, [original_id])
        self.assertEqual(code, 3)
        self.assertIn("already undone", out + err)

    def test_a_no_op_release_records_no_misleading_mutation(self):
        # Nothing is held, so hold_chat.py --release finds nothing to do and MUST NOT write
        # a mutation row claiming a release happened - a refusal/no-op before or without a
        # real change records nothing here (the ledgerlib attempt count is a separate story).
        import hold_chat

        code, out, _ = run_cli(hold_chat.main, [SID, "--release"])
        self.assertEqual(code, 0)
        self.assertIn("nothing to do", out)
        self.assertEqual(mutationlib.list_mutations(session_id=SID, kind="release"), [])

    def test_compact_mutation_is_never_undoable_through_undo_py(self):
        import undo

        mid = mutationlib.record(
            "compact", SID, before={"contextTokens": 200000}, after={"contextTokens": 90000},
        )
        code, out, err = run_cli(undo.main, [mid])
        self.assertEqual(code, 3)
        self.assertIn("not undoable", out + err)


class ArchiveAndRenameMutationRailTest(unittest.TestCase):
    """archive_chat.py and rename_chat.py through the real undo.py path - the two acting
    scripts a mutation is most likely to need reversed. The instance is CLOSED (isRunning
    False) so archive takes the disk-flag route and never spawns the PowerShell actuator;
    rename's actuator call is monkeypatched, matching test_migrate_rename.py's own convention
    for the same reason (no real desktop window in a unit test)."""

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # The policy file lives in the temp state too: the machine's own config.json (where the
        # owner may have switched archive.enabled OFF) must not decide what this test sees.
        from lib import configlib
        self.addCleanup(setattr, configlib, "CONFIG_PATH", configlib.CONFIG_PATH)
        self.addCleanup(setattr, configlib, "_CACHE", configlib._CACHE)
        configlib.CONFIG_PATH = Path(self._state.name) / "config.json"
        configlib._CACHE = None
        self.archived = {"v": False}
        self.title = {"v": "Old Title"}

        # A DONE, stale transcript so the gate classifies this chat as an archive-candidate
        # (archive_chat.py's rule 1) - same fixture shape as test_holds.py's HoldRailTest.
        import json as _json
        import time as _time
        done = 'Done.\n## Am I 100% done?\n- Yes'
        tp = Path(self._tmp.name) / "t.jsonl"
        tp.write_text(_json.dumps({"type": "assistant",
                                   "message": {"content": [{"type": "text", "text": done}]}}) + "\n",
                      encoding="utf-8")
        old = _time.time() - 600
        os.utime(tp, (old, old))

        def dossier_route(method, path, query, body):
            if dossier_query(query) not in (SID, "T"):
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": "c1", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": self.title["v"],
                                 "archived": self.archived["v"], "lastActivityAt": "T1",
                                 "live": None}]}

        def archive_route(method, path, query, body):
            self.archived["v"] = body.get("archived", True)
            return {"ok": True, "hits": [{"profile": "cold", "wasRunning": False, "changed": True}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        self.stub.routes[f"/api/sessions/{SID}/desktop-archive"] = archive_route
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "T", "instance": "cold",
             "transcript_path": str(tp), "last_activity_at": 1}
        ]
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True,
             "account": {"email": "c@x.com", "planLabel": "Max 20x"}}]}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_archive_records_a_mutation_and_undo_unarchives_it(self):
        import archive_chat
        import undo

        code, _, _ = run_cli(archive_chat.main, [SID, "--no-preserve"])
        self.assertEqual(code, 0)
        self.assertTrue(self.archived["v"])
        archives = mutationlib.list_mutations(session_id=SID, kind="archive")
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0]["before"], {"archived": False, "instance": "cold", "live": False})
        self.assertEqual(archives[0]["after"], {"archived": True})
        original_id = archives[0]["id"]

        code, out, _ = run_cli(undo.main, [original_id])
        self.assertEqual(code, 0, out)
        self.assertFalse(self.archived["v"])
        unarchives = mutationlib.list_mutations(session_id=SID, kind="unarchive")
        self.assertEqual(len(unarchives), 1)
        self.assertEqual(unarchives[0]["undoes"], original_id)
        self.assertIsNotNone(mutationlib.get(original_id)["undoneAt"])

    def test_rename_records_a_mutation_and_undo_renames_it_back(self):
        import rename_chat
        import undo
        from unittest import mock

        def fake_drive(instance, old_title, new_title):
            self.title["v"] = new_title
            return 0, "renamed"

        with mock.patch.object(rename_chat, "_drive_rename", side_effect=fake_drive):
            code, _, _ = run_cli(rename_chat.main, [SID, "--to", "New Title"])
        self.assertEqual(code, 0)
        self.assertEqual(self.title["v"], "New Title")
        renames = mutationlib.list_mutations(session_id=SID, kind="rename")
        self.assertEqual(len(renames), 1)
        self.assertEqual(renames[0]["before"], {"title": "Old Title"})
        original_id = renames[0]["id"]

        with mock.patch.object(rename_chat, "_drive_rename", side_effect=fake_drive):
            code, out, _ = run_cli(undo.main, [original_id])
        self.assertEqual(code, 0, out)
        self.assertEqual(self.title["v"], "Old Title")
        after_undo = mutationlib.list_mutations(session_id=SID, kind="rename")
        self.assertEqual(len(after_undo), 2)
        self.assertEqual(after_undo[0]["undoes"], original_id)  # newest first
        self.assertIsNotNone(mutationlib.get(original_id)["undoneAt"])


if __name__ == "__main__":
    unittest.main()
