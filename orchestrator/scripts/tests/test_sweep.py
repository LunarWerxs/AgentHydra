"""sweep.py: one call executes the mechanical lanes through the real act scripts, never
touches the judgment queue, respects caps, and defaults to plan-only."""

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

from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402
import sweep  # noqa: E402

DONE = "Done.\n## Am I 100% done?\n- Yes"
OFFER = "Done.\n## Am I 100% done?\n- Yes\n\nSay the word and I start item 2."


from util import run_cli  # noqa: E402


def iso_now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        self.archived: dict[str, bool] = {}
        self.wire()
        # These tests exercise ARCHIVE MECHANICS, not the (separately tested) knowledge-
        # preservation cycle. Pre-satisfy preservation for the archive candidates - a
        # recorded request with size=0 that any real transcript already exceeds - so the
        # sweep's archive lane proceeds straight to the act. One test below clears this to
        # verify the deferral itself.
        from lib import ledgerlib
        for sid in ("s-done1", "s-done2"):
            ledgerlib.note("preserve", sid, note="size=0")

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def transcript(self, name, text):
        p = Path(self._tmp.name) / f"{name}.jsonl"
        p.write_text(json.dumps({"type": "assistant",
                                 "message": {"content": [{"type": "text", "text": text}]}}) + "\n",
                     encoding="utf-8")
        old = time.time() - 600
        os.utime(p, (old, old))
        return str(p)

    def wire(self):
        stub = self.stub
        self.archived = {"s-done1": False, "s-done2": False, "s-offer": False}
        stub.routes["/api/health"] = {"ok": True, "version": "t", "distribution": "test"}
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True,
             "account": {"email": "cold@x.com", "planLabel": "Max 20×"}},
        ]}
        stub.routes["/api/sessions"] = [
            {"session_id": "s-done1", "archived": False, "title": "Done one", "instance": "cold",
             "transcript_path": self.transcript("d1", DONE), "last_activity_at": 3},
            {"session_id": "s-done2", "archived": False, "title": "Done two", "instance": "cold",
             "transcript_path": self.transcript("d2", DONE), "last_activity_at": 2},
            {"session_id": "s-offer", "archived": False, "title": "Offer chat", "instance": "cold",
             "transcript_path": self.transcript("of", OFFER), "last_activity_at": 1},
        ]
        stub.routes["/api/usage/survey"] = {"rows": [{
            "kind": "desktop", "num": 1, "id": "c:\\i\\cold", "label": "cold",
            "result": {"snapshot": {
                "account": "cold <cold@x.com> · Max 20×",
                "session": {"pct": 1}, "weekAll": {"pct": 10}, "weekModel": {"pct": 10, "label": "Fable"},
                "capturedAt": iso_now()}, "cached": False, "key": "k", "reason": "ok"},
            "advice": {"severity": "normal", "bindingPct": 10, "shouldOffload": False,
                       "safeToFanOut": True, "advice": "ok"},
        }], "lastAutoRefreshAt": None}

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            if sid not in self.archived:
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": f"c-{sid}", "cliSessionId": sid,
                                 "lineageIds": [sid], "title": sid, "archived": self.archived[sid],
                                 "lastActivityAt": "T1", "live": None}]}

        def archive_route(sid):
            def route(method, path, query, body):
                self.archived[sid] = body.get("archived", True)
                return {"ok": True, "hits": [{"profile": "cold", "wasRunning": False, "changed": True}]}

            return route

        stub.routes["/api/chats/dossier"] = dossier_route
        for sid in self.archived:
            stub.routes[f"/api/sessions/{sid}/desktop-archive"] = archive_route(sid)

    def test_default_is_plan_only_and_acts_on_nothing(self):
        code, out, _ = run_cli(sweep.main, [])
        self.assertEqual(code, 0)
        self.assertIn("PLAN ONLY", out)
        self.assertIn("ARCHIVE: 2 act(s) would run", out)
        self.assertIn("JUDGMENT QUEUE - 1 chat(s)", out)  # the offer chat is the AI's
        self.assertEqual(self.stub.posts, [])

    def test_lane_flag_without_yes_still_acts_on_nothing(self):
        code, out, _ = run_cli(sweep.main, ["--archive"])
        self.assertEqual(code, 0)
        self.assertEqual(self.stub.posts, [])

    def test_yes_executes_the_archive_lane_through_the_real_rails(self):
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 0)
        self.assertIn("EXECUTED 2 act(s): 2 verified", out)
        posts = [p for p, _ in self.stub.posts if p.endswith("/desktop-archive")]
        self.assertEqual(len(posts), 2)
        self.assertTrue(self.archived["s-done1"] and self.archived["s-done2"])
        self.assertFalse(self.archived["s-offer"])  # the judgment chat was never touched

    def test_cap_bounds_the_batch(self):
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes", "--max", "1"])
        self.assertEqual(code, 0)
        posts = [p for p, _ in self.stub.posts if p.endswith("/desktop-archive")]
        self.assertEqual(len(posts), 1)
        self.assertIn("(+1 over the per-run cap)", out)

    def test_failed_act_is_named_and_exit_2(self):
        self.stub.routes["/api/sessions/s-done2/desktop-archive"] = (500, {"error": "boom"})
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 2)
        self.assertIn("EXECUTED 2 act(s): 1 verified", out)
        self.assertIn("[failed]", out)

    def test_running_app_archives_are_in_the_lane_via_the_apps_own_control(self):
        # The owner never restarts the apps, so running-app candidates are NOT skipped:
        # archive_chat drives the app's own control for them.
        import unittest.mock as mock

        import archive_chat

        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": True, "signedIn": True,
             "account": {"email": "cold@x.com", "planLabel": "Max 20×"}},
        ]}

        def fake_ui(instance, title, unarchive):
            self.archived[title] = not unarchive  # titles == sids in this fixture
            return 0, f"Archive done for '{title}'"

        with mock.patch.object(archive_chat, "_ui_archive", side_effect=fake_ui) as ui:
            code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 0)
        self.assertEqual(ui.call_count, 2)  # both candidates archived through the UI
        self.assertIn("EXECUTED 2 act(s): 2 verified", out)
        # and NEVER a disk flag under a running app
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/desktop-archive")], [])

    def test_console_archive_candidate_goes_to_the_land_lane_not_the_archive_lane(self):
        # A console chat has no desktop record to flip - archiving would 404. The owner
        # mandate lands it first; a later sweep archives it in its new home.
        tp = self.transcript("con", DONE)
        rows = list(self.stub.routes["/api/sessions"])
        rows.append({"session_id": "s-console", "archived": False, "title": "Console done",
                     "instance": None, "transcript_path": tp, "last_activity_at": 4})
        self.stub.routes["/api/sessions"] = rows
        self.archived["s-console"] = False
        code, out, _ = run_cli(sweep.main, ["--json"])
        data = json.loads(out)
        archive_ids = {r["sessionId"] for r in data["batch"]["lanes"]["archive"]["rows"]}
        land_ids = {r["sessionId"] for r in data["batch"]["lanes"]["landConsole"]["rows"]}
        self.assertNotIn("s-console", archive_ids)
        self.assertIn("s-console", land_ids)

    def test_landing_triggers_the_naming_pass_with_the_planned_titles(self):
        # Owner law: a landing is not finished until the landed chats carry real names.
        import unittest.mock as mock

        tp = self.transcript("con2", DONE)
        rows = list(self.stub.routes["/api/sessions"])
        rows.append({"session_id": "s-land", "archived": False, "title": "A real console chat",
                     "instance": None, "tool": "claude-code",
                     "transcript_path": tp, "last_activity_at": 9})
        self.stub.routes["/api/sessions"] = rows
        self.archived["s-land"] = False
        self.stub.routes["/api/sessions/s-land/import-desktop"] = {"ok": True}
        stub = self.stub

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            landed = any(p.endswith("/import-desktop") for p, _ in stub.posts)
            if sid == "s-land":
                if not landed:
                    return {"matches": []}
                return {"matches": [{"instance": "cold", "chatId": "c-land", "cliSessionId": sid,
                                     "lineageIds": [sid], "title": "A real console chat",
                                     "archived": False, "lastActivityAt": "T1", "live": None}]}
            if sid not in self.archived:
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": f"c-{sid}", "cliSessionId": sid,
                                 "lineageIds": [sid], "title": sid, "archived": self.archived[sid],
                                 "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route

        import name_chats

        with mock.patch.object(name_chats, "name_pass", return_value={
            "named": [{"sid": "s-land", "title": "A real console chat"}],
            "needsJudgment": [], "flakes": [], "remaining": [], "why": "clean",
        }) as np:
            code, out, _ = run_cli(sweep.main, ["--land-console", "--yes"])
        self.assertEqual(code, 0)
        np.assert_called_once()
        inst, = np.call_args.args
        self.assertEqual(inst, "cold")
        self.assertEqual(np.call_args.kwargs["extra_titles"], {"s-land": "A real console chat"})
        self.assertIn("NAMING PASS (cold): 1 named", out)

    def test_archive_lane_preserves_docs_first_then_archives_next_pass(self):
        # The owner rule (2026-09-01): the final act before archiving is to ask the chat to
        # update its docs. Clear the pre-seeded satisfaction so we see phase 1 for real.
        from lib import ledgerlib
        ledgerlib.clear("preserve", "s-done1")
        ledgerlib.clear("preserve", "s-done2")
        self.stub.routes["/api/sessions/s-done1/message"] = {"ok": True, "delivered": True, "route": "peer"}
        self.stub.routes["/api/sessions/s-done2/message"] = {"ok": True, "delivered": True, "route": "peer"}
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 0)  # deferral is not a failure
        # phase 1: asked both chats, archived neither yet
        msgs = [p for p, _ in self.stub.posts if p.endswith("/message")]
        self.assertEqual(len(msgs), 2)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/desktop-archive")], [])
        self.assertFalse(self.archived["s-done1"] or self.archived["s-done2"])
        self.assertIn("preserving-docs-first", out)

    def test_held_console_stray_never_enters_the_land_console_lane(self):
        from lib import holdlib

        tp = self.transcript("held-con", DONE)
        rows = list(self.stub.routes["/api/sessions"])
        rows.append({"session_id": "s-held-con", "archived": False, "title": "Held console chat",
                     "instance": None, "transcript_path": tp, "last_activity_at": 5})
        self.stub.routes["/api/sessions"] = rows
        self.archived["s-held-con"] = False
        holdlib.hold("s-held-con", "owner is triaging this one")
        code, out, _ = run_cli(sweep.main, ["--json"])
        data = json.loads(out)
        land_ids = {r["sessionId"] for r in data["batch"]["lanes"]["landConsole"]["rows"]}
        self.assertNotIn("s-held-con", land_ids)
        self.assertIn("s-held-con", {h["sessionId"] for h in data["batch"]["onHold"]})

    def test_held_chat_never_enters_the_moves_lane(self):
        # A held chat's decision is always on-hold (holds outrank every verdict) - it must
        # never queue a move, even on an account hot enough that an identical non-held chat
        # would move.
        from lib import holdlib

        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": True, "signedIn": True,
             "account": {"email": "cold@x.com", "planLabel": "Max 20×"}},
            {"num": 2, "name": "spare", "dir": "c:\\i\\spare", "isRunning": True, "signedIn": True,
             "account": {"email": "spare@x.com", "planLabel": "Max 20×"}},
        ]}
        self.stub.routes["/api/usage/survey"] = {"rows": [
            {"kind": "desktop", "num": 1, "id": "c:\\i\\cold", "label": "cold",
             "result": {"snapshot": {"account": "cold <cold@x.com> · Max 20×",
                                      "session": {"pct": 95}, "weekAll": {"pct": 95},
                                      "weekModel": {"pct": 95, "label": "Fable"},
                                      "capturedAt": iso_now()}, "cached": False, "key": "k1", "reason": "ok"},
             "advice": {"severity": "critical", "bindingPct": 95, "shouldOffload": True,
                        "safeToFanOut": False, "advice": "hot"}},
            {"kind": "desktop", "num": 2, "id": "c:\\i\\spare", "label": "spare",
             "result": {"snapshot": {"account": "spare <spare@x.com> · Max 20×",
                                      "session": {"pct": 5}, "weekAll": {"pct": 5},
                                      "weekModel": {"pct": 5, "label": "Fable"},
                                      "capturedAt": iso_now()}, "cached": False, "key": "k2", "reason": "ok"},
             "advice": {"severity": "normal", "bindingPct": 5, "shouldOffload": False,
                        "safeToFanOut": True, "advice": "ok"}},
        ], "lastAutoRefreshAt": None}
        tp = self.transcript("held-move", OFFER)
        rows = list(self.stub.routes["/api/sessions"])
        rows.append({"session_id": "s-held-move", "archived": False, "title": "Held pressured chat",
                     "instance": "cold", "transcript_path": tp, "last_activity_at": 6})
        self.stub.routes["/api/sessions"] = rows
        self.archived["s-held-move"] = False
        holdlib.hold("s-held-move", "owner is handling this personally")
        code, out, _ = run_cli(sweep.main, ["--json"])
        data = json.loads(out)
        move_ids = {m["sessionId"] for m in data["batch"]["lanes"]["moves"]["rows"]}
        self.assertNotIn("s-held-move", move_ids)
        self.assertIn("s-held-move", {h["sessionId"] for h in data["batch"]["onHold"]})

    def test_execute_reports_a_hold_placed_after_the_batch_was_built_as_ok(self):
        # Exit 6 from an act script means a hold landed AT T-0, after the batch was already
        # built (a race, not a plan mistake) - execute() must count it as ok, never a failure.
        from lib import holdlib

        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True,
             "account": {"email": "cold@x.com", "planLabel": "Max 20×"}},
            {"num": 2, "name": "warm", "dir": "c:\\i\\warm", "isRunning": True, "signedIn": True,
             "account": {"email": "warm@x.com", "planLabel": "Max 20×"}},
        ]}
        holdlib.hold("s-done1", "grabbed after the batch was built")
        row = {"sessionId": "s-done1", "title": "Done one", "argv": ["s-done1", "--to", "warm"]}
        batch = {"lanes": {"moves": {"rows": [row], "overCap": 0}}}
        result = sweep.execute(batch, ["moves"])
        self.assertEqual(result["acted"], 1)
        self.assertEqual(result["verified"], 1)
        r = result["results"][0]
        self.assertTrue(r["ok"])
        self.assertEqual(r["exit"], 6)
        self.assertIn("held-by-owner", r["outcome"])

    def test_yes_without_an_armed_window_refuses_and_acts_on_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        armlib.disarm()
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/desktop-archive")], [])
        self.assertFalse(self.archived["s-done1"] or self.archived["s-done2"])

    def test_yes_with_an_armed_window_executes_as_before(self):
        code, out, _ = run_cli(sweep.main, ["--archive", "--yes"])
        self.assertEqual(code, 0)
        self.assertIn("EXECUTED 2 act(s): 2 verified", out)
        self.assertTrue(self.archived["s-done1"] and self.archived["s-done2"])

    def test_json_shape_carries_batch_and_judgment_queue(self):
        code, out, _ = run_cli(sweep.main, ["--json"])
        data = json.loads(out)
        self.assertEqual(len(data["batch"]["lanes"]["archive"]["rows"]), 2)
        self.assertEqual(len(data["batch"]["judgmentQueue"]), 1)
        self.assertIsNone(data["executed"])


if __name__ == "__main__":
    unittest.main()
