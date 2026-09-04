"""dashboard.py: the decision mapping, the data endpoints, and the property that matters
most - the dashboard is read-only BY CONSTRUCTION (no POST handler exists at all)."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import dashboard  # noqa: E402
from lib import hydralib  # noqa: E402

DONE = "Done.\n## Am I 100% done?\n- Yes"
OFFER = "Done.\n## Am I 100% done?\n- Yes\n\nSay the word and I start item 2."


def gate_verdict(state, **kw):
    """A minimal verdict dict of the given shape, for decide() unit tests."""
    base = {"session_id": "sid1", "state": state, "cause": "test", "quiet_secs": 0,
            "live": None, "crashed": None, "finished": None, "stalled": None, "idle": None}
    base.update(kw)
    return base


class DecideTest(unittest.TestCase):
    def test_ungateable(self):
        d = dashboard.decide(None, None, False, "no transcript on disk")
        self.assertEqual(d["kind"], "cannot")
        self.assertIsNone(d["command"])

    def test_running_working_is_leave_alone(self):
        d = dashboard.decide(gate_verdict("running"), None, True)
        self.assertEqual(d["kind"], "leave-alone")
        self.assertIsNone(d["command"])  # nothing to do = no command to hand out

    def test_running_stalled_is_judgment(self):
        v = gate_verdict("running", stalled={"tool": "Bash", "quiet_secs": 2000, "why": "w"})
        d = dashboard.decide(v, None, True)
        self.assertEqual(d["kind"], "judgment")
        self.assertIn("STUCK", d["action"])

    def test_running_idle_is_judgment_never_archive(self):
        v = gate_verdict("running", idle={"quiet_secs": 600, "done_claim": "yes",
                                          "ends_with_question": False, "recap_present": True,
                                          "last_assistant_text": DONE})
        d = dashboard.decide(v, None, True)
        self.assertEqual(d["kind"], "judgment")
        self.assertIn("Never archive", d["detail"])

    def test_crashed_kinds_are_resume(self):
        for kind in ("mid-turn", "usage-limit", "overload", "refused", "error"):
            v = gate_verdict("crashed", crashed={"kind": kind})
            d = dashboard.decide(v, None, False)
            self.assertEqual(d["kind"], "resume", kind)
            self.assertIn(kind, d["action"])

    def test_finished_lanes(self):
        fin = {"lane": "human", "recap_present": False, "done_claim": "unknown",
               "ends_with_question": False, "offers_to_continue": False, "interrupted": True,
               "last_assistant_text": ""}
        self.assertEqual(dashboard.decide(gate_verdict("finished", finished=fin), None, False)["kind"], "human")
        fin = {**fin, "lane": "needs-input-review", "offers_to_continue": True, "interrupted": False}
        d = dashboard.decide(gate_verdict("finished", finished=fin), None, False)
        self.assertEqual(d["kind"], "wait-on-person")
        self.assertIn("OFFERS TO CARRY ON", d["detail"])

    def test_archive_candidate_paths(self):
        fin = {"lane": "archive-candidate", "recap_present": True, "done_claim": "yes",
               "ends_with_question": False, "offers_to_continue": False, "interrupted": False,
               "last_assistant_text": DONE}
        v = gate_verdict("finished", finished=fin)
        plain = dashboard.decide(v, {"suppressed": False}, False)
        self.assertEqual(plain["kind"], "archive")
        self.assertIn("archive_chat.py", plain["command"])
        held = dashboard.decide(v, {"suppressed": True, "why": "4 tries"}, False)
        self.assertEqual(held["kind"], "held-back")
        running = dashboard.decide(v, None, True)
        self.assertEqual(running["kind"], "archive")
        self.assertIn("app's own control", running["action"])


    def test_a_manager_chat_is_left_alone_whatever_its_recap_says(self):
        # 2026-09-04: the archive lane filed the standing manager on its own "done" recap,
        # the claim died with it, and the watchdog reborn another on a different account.
        fin = {"lane": "archive-candidate", "recap_present": True, "done_claim": "yes",
               "ends_with_question": False, "offers_to_continue": False, "interrupted": False,
               "last_assistant_text": DONE}
        v = gate_verdict("finished", finished=fin)
        d = dashboard.decide(v, {"suppressed": False}, True, manager=True)
        self.assertEqual(d["kind"], "leave-alone")
        self.assertIn("manager", d["action"])
        held = dashboard.decide(v, None, True, hold_why="owner said so", manager=True)
        self.assertEqual(held["kind"], "on-hold")  # a person's hold still outranks it


class PlanAndServerTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.wire()

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def transcript(self, name, text, age=600):
        p = Path(self._tmp.name) / f"{name}.jsonl"
        p.write_text(json.dumps({"type": "assistant",
                                 "message": {"content": [{"type": "text", "text": text}]}}) + "\n",
                     encoding="utf-8")
        old = time.time() - age
        os.utime(p, (old, old))
        return str(p)

    def wire(self):
        self.stub.routes["/api/health"] = {"ok": True, "version": "t", "distribution": "test"}
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "closed1", "dir": "c:\\i\\c1", "isRunning": False, "signedIn": True,
             "account": {"email": "a@x.com", "planLabel": "Max 20x"}},
            {"num": 2, "name": "open2", "dir": "c:\\i\\o2", "isRunning": True, "signedIn": True,
             "account": {"email": "b@x.com", "planLabel": "Pro"}},
        ]}
        self.stub.routes["/api/sessions"] = [
            {"session_id": "s-done", "archived": False, "title": "Done chat", "instance": "closed1",
             "transcript_path": self.transcript("done", DONE), "last_activity_at": 3},
            {"session_id": "s-offer", "archived": False, "title": "Offer chat", "instance": "closed1",
             "transcript_path": self.transcript("offer", OFFER), "last_activity_at": 2},
            {"session_id": "s-live", "archived": False, "title": "Live chat", "instance": "open2",
             "transcript_path": self.transcript("live", DONE, age=5), "last_activity_at": 1},
            {"session_id": "s-arch", "archived": True, "title": "Archived", "instance": "closed1",
             "transcript_path": self.transcript("arch", DONE), "last_activity_at": 0},
        ]

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            live = {"pid": 5, "name": "w"} if sid == "s-live" else None
            return {"matches": [{"cliSessionId": sid, "lineageIds": [sid], "live": live}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route

    def test_plan_classifies_and_attributes_accounts_and_touches_nothing(self):
        plan = dashboard.build_plan()
        by_id = {c["sessionId"]: c for c in plan["chats"]}
        self.assertEqual(plan["scanned"], 3)  # archived excluded
        self.assertTrue(plan["complete"])
        self.assertEqual(by_id["s-done"]["decision"]["kind"], "archive")
        self.assertEqual(by_id["s-offer"]["decision"]["kind"], "wait-on-person")
        self.assertIn(by_id["s-live"]["decision"]["kind"], ("leave-alone", "judgment"))
        self.assertEqual(by_id["s-done"]["account"]["email"], "a@x.com")
        self.assertFalse(by_id["s-done"]["account"]["appRunning"])
        self.assertTrue(by_id["s-live"]["account"]["appRunning"])
        self.assertEqual(self.stub.posts, [])  # READ-ONLY: the whole plan sent zero POSTs

    def test_a_standing_manager_chat_never_enters_the_archive_or_judgment_lanes(self):
        import overlord

        with mock.patch.object(overlord, "protected_session_ids", return_value={"s-done", "s-offer"}):
            plan = dashboard.build_plan()
        by_id = {c["sessionId"]: c for c in plan["chats"]}
        self.assertEqual(by_id["s-done"]["decision"]["kind"], "leave-alone")   # not archive
        self.assertEqual(by_id["s-offer"]["decision"]["kind"], "leave-alone")  # not judgment
        self.assertIn("overlord.py", by_id["s-done"]["decision"]["command"])

    def test_the_server_cannot_act_by_construction(self):
        self.assertFalse(hasattr(dashboard.Handler, "do_POST"))

    def test_http_layer(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(f"{base}/") as r:
                self.assertEqual(r.status, 200)
                self.assertIn("text/html", r.headers["content-type"])
                self.assertIn(b"decision dashboard", r.read())
            with urllib.request.urlopen(f"{base}/data/plan") as r:
                plan = json.loads(r.read())
                self.assertEqual(plan["scanned"], 3)
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"{base}/data/nope")
            self.assertEqual(ctx.exception.code, 404)
            # POST anything -> 501 from the base class: acting is structurally impossible
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(urllib.request.Request(f"{base}/data/plan", data=b"{}", method="POST"))
            self.assertEqual(ctx.exception.code, 501)
            # a dead daemon must surface as an error, never as an empty fleet
            self.stub.routes["/api/sessions"] = (500, {"error": "down"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"{base}/data/plan")
            self.assertEqual(ctx.exception.code, 502)
        finally:
            server.shutdown()
            server.server_close()

    def test_scripts_panel_describes_every_script_from_its_own_docstring(self):
        d = dashboard.build_scripts()
        names = {s["name"] for s in d["scripts"]}
        # every script in the toolbox is described - a new one cannot silently go undocumented
        import glob
        import os

        root = dashboard.HTML_PATH.parent
        on_disk = {os.path.basename(p)
                   for p in glob.glob(str(root / "*.py")) + glob.glob(str(root / "lib" / "*.py"))
                   if not os.path.basename(p).startswith("test_")
                   and os.path.basename(p) != "__init__.py"}
        self.assertEqual(names, on_disk)
        by_name = {s["name"]: s for s in d["scripts"]}
        self.assertEqual(by_name["census.py"]["kind"], "observe")
        self.assertEqual(by_name["archive_chat.py"]["kind"], "act")
        self.assertEqual(by_name["gatelib.py"]["kind"], "lib")
        # summaries come from the real docstrings, never a hand-kept copy
        self.assertIn("fleet", by_name["census.py"]["summary"].lower())
        self.assertTrue(by_name["archive_chat.py"]["usage"].startswith("Usage:"))
        self.assertTrue(all(s["summary"] for s in d["scripts"]))

    def test_svg_diagram_numbers_match_the_live_constants(self):
        # The logic-tree SVG hard-codes threshold text; this pins it to the constants so a
        # tuned threshold cannot leave the drawn tree silently lying (review finding).
        from lib import gatelib
        from lib import ledgerlib

        html = dashboard.HTML_PATH.read_text(encoding="utf-8")
        self.assertIn(f"quiet ≥{gatelib.STALL_QUIET_SECS // 60} min", html)
        self.assertIn(f"quiet ≥{gatelib.IDLE_AFTER_SECS // 60} min", html)
        self.assertIn(f"≥{ledgerlib.ATTEMPT_CAP} attempts in {ledgerlib.ATTEMPT_WINDOW_MS // 3600_000} h", html)

    def test_instances_view_counts_visible_chats(self):
        data = dashboard.build_instances()
        by_name = {i["name"]: i for i in data["instances"]}
        self.assertEqual(by_name["closed1"]["visibleChats"], 2)
        self.assertEqual(by_name["open2"]["visibleChats"], 1)
        # open instances sort first
        self.assertTrue(data["instances"][0]["isRunning"])


if __name__ == "__main__":
    unittest.main()
