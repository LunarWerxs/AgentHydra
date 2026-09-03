"""archive_chat.py against a stub daemon: every refusal rail, the pending-restart honesty,
and the verified success path. These are the regression tests for both postmortem bugs."""

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
from util import run_cli  # noqa: E402

DONE_RECAP = "Done.\n## Am I 100% done?\n- Yes\n## Do I recommend anything else?\n- nothing"
GHOST_RECAP = "Done.\n## Am I 100% done?\n- Yes\n\nSay the word and I start burning item 1."

SID = "aaaa1111-2222-3333-4444-555566667777"


def transcript_with(tmpdir: str, text: str) -> str:
    p = Path(tmpdir) / "t.jsonl"
    p.write_text(
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n",
        encoding="utf-8",
    )
    old = time.time() - 600
    os.utime(p, (old, old))
    return str(p)


class ArchiveChatTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        from lib import hydralib

        hydralib.BASE = self.stub.url
        import archive_chat
        from lib import ledgerlib

        self.archive_chat = archive_chat
        self.ledgerlib = ledgerlib
        # The real daemon always answers /api/fleet; a missing route would now read as a
        # DaemonError (the app-running read no longer swallows failures into "closed").
        self.stub.routes["/api/fleet"] = {"instances": []}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def wire(self, recap=DONE_RECAP, live=None, archived=False, activity="T1", flip_after_post=True,
             was_running=False):
        """Standard happy wiring: one chat, resolvable, transcript on disk."""
        tp = transcript_with(self._tmp.name, recap)
        stub = self.stub

        def dossier_route(method, path, query, body):
            # Answer BY the query, the way the real daemon does: a stub that returns the same
            # match no matter what was asked is blind to a script querying the wrong id.
            q = dossier_query(query)
            if q != SID and q not in "T":
                return {"matches": []}
            posted = any(p[0].endswith("/desktop-archive") for p in stub.posts)
            return {
                "matches": [
                    {
                        "instance": "temp1",
                        "chatId": "local_x",
                        "cliSessionId": SID,
                        "lineageIds": [SID],
                        "title": "T",
                        "archived": (not archived) if (posted and flip_after_post) else archived,
                        "lastActivityAt": activity,
                        "live": live,
                    }
                ]
            }

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": archived, "title": "T", "instance": "temp1",
             "transcript_path": tp, "last_activity_at": 1}
        ]
        hits = [{"profile": "temp1", "wasRunning": was_running, "changed": True}]
        resp = {"ok": True, "hits": hits}
        if was_running:
            resp["visibleNow"] = False
            resp["note"] = "the flag is written, but that app is RUNNING..."
        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = resp
        return tp

    def acted(self):
        return any(p[0].endswith("/desktop-archive") for p in self.stub.posts)

    def test_success_path_archives_verifies_and_clears_ledger(self):
        self.wire()
        code = self.archive_chat.main([SID, "--no-preserve"])
        self.assertEqual(code, 0)
        self.assertTrue(self.acted())
        posts = [b for p, b in self.stub.posts if p.endswith("/desktop-archive")]
        self.assertEqual(posts, [{"archived": True}])
        self.assertFalse(self.ledgerlib.check("archive", SID)["suppressed"])
        self.assertEqual(len(self.ledgerlib._load()), 0)  # success cleared the attempt

    def test_ghost_case_is_refused_by_the_gate(self):
        # THE bug that killed v2: done-yes + "say the word" + no '?' must NOT archive.
        self.wire(recap=GHOST_RECAP)
        code = self.archive_chat.main([SID, "--no-preserve"])
        self.assertEqual(code, 2)
        self.assertFalse(self.acted())

    def test_force_is_a_persons_word_and_overrides_the_gate(self):
        self.wire(recap=GHOST_RECAP)
        self.assertEqual(self.archive_chat.main([SID, "--force", "--no-preserve"]), 0)
        self.assertTrue(self.acted())

    def test_live_writer_refuses_even_with_force(self):
        self.wire(live={"pid": 99, "name": "w"})
        self.assertEqual(self.archive_chat.main([SID, "--force", "--no-preserve"]), 4)
        self.assertFalse(self.acted())

    def test_breaker_suppresses_after_cap_and_force_overrides(self):
        self.wire()
        for _ in range(self.ledgerlib.ATTEMPT_CAP):
            self.ledgerlib.note("archive", SID)
        self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 5)
        self.assertFalse(self.acted())
        self.assertEqual(self.archive_chat.main([SID, "--force", "--no-preserve"]), 0)
        self.assertTrue(self.acted())

    def _wire_running_app(self):
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "temp1", "dir": "c:\\i\\t1", "isRunning": True, "signedIn": True}]}

    def test_running_app_archives_through_the_apps_own_control(self):
        # Rule 4, the running-app way: NEVER a disk flag, NEVER wait for a restart (the owner
        # never restarts the apps) - drive the app's own archive control and verify.
        import unittest.mock as mock

        self.wire()
        self._wire_running_app()
        with mock.patch.object(self.archive_chat, "_ui_archive",
                               return_value=(0, "Archive done for 'T'")) as ui:
            code = self.archive_chat.main([SID, "--no-preserve"])
        # the actuator was driven; the daemon's flag endpoint was NOT touched
        ui.assert_called_once_with("temp1", "T", False)
        self.assertFalse(self.acted())
        # verify happens via the dossier; our stub flips archived after ANY desktop-archive
        # POST, which never came - so verify honestly fails and nothing is overclaimed
        self.assertEqual(code, 1)

    def test_running_app_ui_failure_is_exit_7_and_ambiguity_is_deterministic(self):
        import unittest.mock as mock

        self.wire()
        self._wire_running_app()
        with mock.patch.object(self.archive_chat, "_ui_archive",
                               return_value=(3, "FAIL: 'T' not rendered in any searched running instance")):
            self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 7)
        self.assertFalse(self.acted())
        with mock.patch.object(self.archive_chat, "_ui_archive",
                               return_value=(1, "AMBIGUOUS: 2 rendered chats end with 'T'")):
            self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 7)
        self.assertTrue(self.ledgerlib.check("archive", SID)["deterministic"])

    def test_already_archived_with_unreadable_fleet_is_never_nothing_to_do(self):
        # Adversarial review, 2026-08-31: the app-running read used to swallow a failed
        # fleet read into "closed", turning an unverifiable state into a bare exit-0
        # "nothing to do". Unknown must fail loudly instead.
        self.wire(archived=True)
        del self.stub.routes["/api/fleet"]
        code, out_text, _ = run_cli(self.archive_chat.main, [SID])
        self.assertEqual(code, 1)
        self.assertIn("UNKNOWN", out_text)

    def test_app_opening_mid_act_is_reported_not_claimed(self):
        # Fleet says closed, but the POST lands under a freshly-opened app (the race window):
        # honest exit 7, pointing at an immediate re-run through the UI path.
        self.wire(was_running=True, flip_after_post=True)
        code = self.archive_chat.main([SID, "--no-preserve"])
        self.assertEqual(code, 7)
        self.assertTrue(self.acted())
        # the attempt STAYS on the ledger - a repeat pass must count toward the cap
        self.assertEqual(len(self.ledgerlib._load()), 1)

    def test_verify_failure_is_reported_not_swallowed(self):
        self.wire(flip_after_post=False)  # daemon says ok but dossier never flips
        self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 1)
        self.assertEqual(len(self.ledgerlib._load()), 1)  # attempt kept

    def test_movement_between_deciding_and_acting_aborts(self):
        tp = transcript_with(self._tmp.name, DONE_RECAP)
        stub = self.stub
        calls = {"n": 0}

        def dossier_route(method, path, query, body):
            calls["n"] += 1
            return {
                "matches": [
                    {"instance": "temp1", "chatId": "local_x", "cliSessionId": SID,
                     "lineageIds": [SID], "title": "T", "archived": False,
                     "lastActivityAt": f"T{calls['n']}",  # moves on every read
                     "live": None}
                ]
            }

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "T", "instance": "temp1",
             "transcript_path": tp, "last_activity_at": 1}
        ]
        self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 2)
        self.assertFalse(self.acted())

    def test_ambiguous_title_is_deterministic_and_recorded(self):
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [
                {"instance": "a", "chatId": "1", "cliSessionId": "s1", "title": "Same", "archived": False},
                {"instance": "b", "chatId": "2", "cliSessionId": "s2", "title": "Same", "archived": False},
            ]
        }
        self.assertEqual(self.archive_chat.main(["Same"]), 3)
        self.assertFalse(self.acted())
        self.assertTrue(self.ledgerlib.check("archive", "s1")["deterministic"])

    def test_already_archived_changes_nothing(self):
        self.wire(archived=True)
        self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 0)
        self.assertFalse(self.acted())

    def test_already_archived_under_running_app_is_settled_through_the_ui(self):
        # Flag on disk + app running: the screen may disagree, so the app's own control
        # settles it. Row absent (actuator exit 3) = screen and disk agree = settled.
        import unittest.mock as mock

        self.wire(archived=True)
        self.stub.routes["/api/fleet"] = {
            "instances": [{"num": 1, "name": "temp1", "dir": "c:\\i\\t1", "isRunning": True}]
        }
        with mock.patch.object(self.archive_chat, "_ui_archive", return_value=(3, "not rendered")):
            self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 0)
        # Row still there (actuator archived it now, exit 0) = it WAS on screen, now settled.
        with mock.patch.object(self.archive_chat, "_ui_archive", return_value=(0, "Archive done")):
            self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 0)
        # Actuator could not answer = honest exit 7, never a silent claim.
        with mock.patch.object(self.archive_chat, "_ui_archive", return_value=(1, "FAIL: window busy")):
            self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 7)
        self.assertFalse(self.acted())

    def test_recheck_not_found_is_deterministic_and_recorded(self):
        # resolve by title works; re-check by session id deterministically finds nothing -
        # that refusal must be RECORDED or it gets retried forever (v2's shape).
        tp = transcript_with(self._tmp.name, DONE_RECAP)

        def dossier_route(method, path, query, body):
            from stubdaemon import dossier_query

            if dossier_query(query) == "T":
                return {"matches": [{"instance": "temp1", "chatId": "local_x", "cliSessionId": SID,
                                     "lineageIds": [SID], "title": "T", "archived": False,
                                     "lastActivityAt": "T1", "live": None}]}
            return {"matches": []}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        self.stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "T", "instance": "temp1",
             "transcript_path": tp, "last_activity_at": 1}
        ]
        self.assertEqual(self.archive_chat.main(["T"]), 3)
        self.assertFalse(self.acted())
        self.assertTrue(self.ledgerlib.check("archive", SID)["deterministic"])

    def test_reports_say_what_changed_not_what_exists(self):
        # Rule 6: the human-facing report is a contract too.
        import contextlib
        import io

        self.wire()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.archive_chat.main([SID, "--no-preserve"])
        self.assertIn("VERIFIED", buf.getvalue())
        self.stub.posts.clear()
        self.wire(recap=GHOST_RECAP)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.archive_chat.main([SID, "--no-preserve"])
        out = buf.getvalue()
        self.assertIn("REFUSED by the gate", out)
        self.assertIn("OFFERS TO CARRY ON", out)

    def test_unarchive_skips_gate_and_verifies(self):
        self.wire(recap=GHOST_RECAP, archived=True)  # gate would refuse archiving; unarchive is fine
        self.assertEqual(self.archive_chat.main([SID, "--unarchive"]), 0)
        posts = [b for p, b in self.stub.posts if p.endswith("/desktop-archive")]
        self.assertEqual(posts, [{"archived": False}])

    # -- KNOWLEDGE PRESERVATION (owner rule, 2026-09-01) ------------------------------------
    def test_phase1_defers_and_asks_the_chat_to_update_its_docs(self):
        self.wire()
        # the message endpoint accepts the preserve prompt
        self.stub.routes[f"/api/sessions/{SID}/message"] = {"ok": True, "delivered": True, "route": "peer"}
        code = self.archive_chat.main([SID])  # no --no-preserve: preservation is ON
        self.assertEqual(code, 8)  # DEFERRED, not archived
        # it asked the chat, and did NOT archive yet
        msgs = [b for p, b in self.stub.posts if p.endswith("/message")]
        self.assertEqual(len(msgs), 1)
        self.assertIn("markdown", msgs[0]["text"].lower())
        self.assertFalse(self.acted())
        self.assertIsNotNone(self.ledgerlib._newest_preserve(SID)
                             if hasattr(self.ledgerlib, "_newest_preserve") else
                             next((r for r in self.ledgerlib._load() if r.get("kind") == "preserve"), None))

    def test_phase2_archives_once_the_transcript_grew_after_the_request(self):
        tp = self.wire()
        self.stub.routes[f"/api/sessions/{SID}/message"] = {"ok": True, "delivered": True, "route": "peer"}
        self.assertEqual(self.archive_chat.main([SID]), 8)  # phase 1
        # the chat runs its preservation turn: the transcript grows, and it still ends on a
        # clean done-recap (the 3-header footer), so it stays an archive candidate.
        with open(tp, "a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text",
                    "text": "Updated README and NOTES.\n" + DONE_RECAP}]}}) + "\n")
        code = self.archive_chat.main([SID])  # phase 2
        self.assertEqual(code, 0)
        self.assertTrue(self.acted())

    def test_no_preserve_archives_immediately(self):
        self.wire()
        self.assertEqual(self.archive_chat.main([SID, "--no-preserve"]), 0)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/message")], [])
        self.assertTrue(self.acted())

    def test_preserve_post_passes_an_explicit_timeout_past_confirm_secs(self):
        # hydralib's generic TIMEOUT_SECS (30s) suits a plain read, not an endpoint that
        # WATCHES for confirm_secs before answering - courier.py and spawn_chat.py both pass
        # their own timeout for exactly this shape; the preserve POST must too, or the HTTP
        # call can time out before the endpoint itself even replies "not confirmed".
        import unittest.mock as mock

        with mock.patch.object(self.archive_chat.hydralib, "api_post",
                                return_value={"delivered": True, "route": "peer"}) as m:
            ok, how = self.archive_chat._request_preservation(SID)
        self.assertTrue(ok)
        self.assertEqual(how, "peer")
        self.assertEqual(m.call_count, 1)
        _args, kwargs = m.call_args
        self.assertIn("timeout", kwargs)
        self.assertGreater(kwargs["timeout"], 30)  # past hydralib's generic 30s default
        self.assertEqual(kwargs["timeout"],
                         self.archive_chat.PRESERVE_CONFIRM_SECS + 60)

    def test_preserve_row_survives_a_failed_act_and_clears_only_on_success(self):
        # 2026-09-01 review: the preserve ledger row used to clear before the act, so any
        # transient act failure re-sent the whole doc-update prompt to a chat that had
        # already written its docs. It must survive a failed act and clear only on success.
        tp = transcript_with(self._tmp.name, DONE_RECAP)
        stub = self.stub
        state = {"archived": False}

        def dossier_route(method, path, query, body):
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [
                {"instance": "temp1", "chatId": "local_x", "cliSessionId": SID,
                 "lineageIds": [SID], "title": "T", "archived": state["archived"],
                 "lastActivityAt": "T1", "live": None}
            ]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "T", "instance": "temp1",
             "transcript_path": tp, "last_activity_at": 1}
        ]
        stub.routes[f"/api/sessions/{SID}/message"] = {"ok": True, "delivered": True, "route": "peer"}

        # phase 1: ask the chat to update its docs, defer
        self.assertEqual(self.archive_chat.main([SID]), 8)

        # the chat runs its preservation turn: the transcript grows past the recorded size,
        # and still ends on a clean done-recap - the preserve condition is now satisfied.
        with open(tp, "a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Updated NOTES.\n" + DONE_RECAP}]}}) + "\n")

        # the archive act itself fails
        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = {"ok": False, "reason": "disk busy"}
        code = self.archive_chat.main([SID])
        self.assertEqual(code, 1)
        self.assertFalse(state["archived"])
        preserve_rows = [r for r in self.ledgerlib._load() if r.get("kind") == "preserve"]
        self.assertEqual(len(preserve_rows), 1)  # SURVIVES the failed act

        # now the act succeeds
        def desktop_archive(method, path, query, body):
            state["archived"] = True
            return {"ok": True, "hits": [{"profile": "temp1", "wasRunning": False, "changed": True}]}

        stub.routes[f"/api/sessions/{SID}/desktop-archive"] = desktop_archive
        code = self.archive_chat.main([SID])
        self.assertEqual(code, 0)
        self.assertTrue(state["archived"])
        preserve_rows = [r for r in self.ledgerlib._load() if r.get("kind") == "preserve"]
        self.assertEqual(preserve_rows, [])  # cleared ONLY on success

    def test_a_second_concurrent_archive_run_is_deferred(self):
        # 2026-09-01 review: the groundskeeper's lane and the /orchestrate sweep can both
        # derive the same archive candidate on the same 5-minute clock. The second run must
        # defer (exit 8), never send the preserve prompt or the act twice.
        self.wire()
        lock = self.ledgerlib._state_dir() / f".lock-archive-{SID}"
        lock.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        try:
            code, out_text, _ = run_cli(self.archive_chat.main, [SID, "--no-preserve"])
        finally:
            try:
                os.unlink(lock)
            except OSError:
                pass
        self.assertEqual(code, 8)
        self.assertIn("another archive run holds", out_text)
        self.assertFalse(self.acted())

    def test_grace_elapsed_archives_even_without_a_preservation_turn(self):
        import time as _t
        self.wire()
        self.stub.routes[f"/api/sessions/{SID}/message"] = (404, {"error": "no desktop chat"})
        self.assertEqual(self.archive_chat.main([SID]), 8)  # phase 1 (delivery unconfirmed, still deferred)
        # backdate the preserve record beyond the grace window; transcript never grew
        rows = self.ledgerlib._load()
        for r in rows:
            if r.get("kind") == "preserve":
                r["at"] = int(_t.time() * 1000) - (self.archive_chat.PRESERVE_GRACE_MIN + 5) * 60_000
        self.ledgerlib._save(rows)
        code = self.archive_chat.main([SID])  # grace elapsed -> archive anyway
        self.assertEqual(code, 0)
        self.assertTrue(self.acted())


if __name__ == "__main__":
    unittest.main()
