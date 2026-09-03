"""waiting_scan.py: classification over real transcript files + dossier liveness, and the
honesty rails (ungated chats named, per-chat daemon failures never silently shrink the fleet)."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402
import waiting_scan  # noqa: E402

DONE = "Done.\n## Am I 100% done?\n- Yes\n- nothing else."
OFFER = "Done.\n## Am I 100% done?\n- Yes\n\nSay the word and I start item 2."


def write_transcript(dirname, name, text=None, dangling_user=False, age_secs=600):
    p = Path(dirname) / f"{name}.jsonl"
    events = []
    if text is not None:
        events.append({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
    if dangling_user:
        events.append({"type": "user", "message": {"content": "do more"}})
    p.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    old = time.time() - age_secs
    os.utime(p, (old, old))
    return str(p)


class WaitingScanTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def wire(self, rows, live_by_sid=None):
        live_by_sid = live_by_sid or {}
        self.stub.routes["/api/sessions"] = rows
        stub = self

        def dossier_route(method, path, query, body):
            sid = query.split("q=")[-1]
            import urllib.parse

            sid = urllib.parse.unquote(sid)
            return {
                "matches": [
                    {"cliSessionId": sid, "lineageIds": [sid], "live": live_by_sid.get(sid)}
                ]
            }

        self.stub.routes["/api/chats/dossier"] = dossier_route

    def test_full_classification(self):
        d = self._tmp.name
        rows = [
            {"session_id": "done", "archived": False, "title": "Done chat", "instance": "i",
             "transcript_path": write_transcript(d, "done", DONE)},
            {"session_id": "offer", "archived": False, "title": "Offer chat", "instance": "i",
             "transcript_path": write_transcript(d, "offer", OFFER)},
            {"session_id": "crash", "archived": False, "title": "Crashed chat", "instance": "i",
             "transcript_path": write_transcript(d, "crash", DONE, dangling_user=True)},
            {"session_id": "idle", "archived": False, "title": "Idle live chat", "instance": "i",
             "transcript_path": write_transcript(d, "idle", OFFER)},
            {"session_id": "busy", "archived": False, "title": "Busy live chat", "instance": "i",
             "transcript_path": write_transcript(d, "busy", DONE, age_secs=5)},
            {"session_id": "ghostless", "archived": False, "title": "No transcript", "instance": "i",
             "transcript_path": str(Path(d) / "missing.jsonl")},
            {"session_id": "arch", "archived": True, "title": "Archived - excluded", "instance": "i",
             "transcript_path": write_transcript(d, "arch", OFFER)},
        ]
        self.wire(rows, live_by_sid={"idle": {"pid": 1, "name": "x"}, "busy": {"pid": 2, "name": "y"}})
        r = waiting_scan.scan()
        self.assertEqual(r["scanned"], 6)  # archived row excluded
        waiting_ids = {w["sessionId"] for w in r["waitingOnAPerson"]}
        # 'offer' finished+offers; 'idle' live-but-idle with an offer; 'done' is a clean finish
        self.assertEqual(waiting_ids, {"offer", "idle"})
        self.assertEqual([c["sessionId"] for c in r["crashed"]], ["crash"])
        self.assertEqual([u["sessionId"] for u in r["ungated"]], ["ghostless"])
        self.assertEqual([w["sessionId"] for w in r["working"]], ["busy"])
        self.assertEqual(
            r["counts"],
            {"finished": 2, "running": 2, "crashed": 1, "no-transcript": 1, "dossier-failed": 0},
        )
        idle_row = next(w for w in r["waitingOnAPerson"] if w["sessionId"] == "idle")
        self.assertTrue(idle_row["offersToContinue"])
        self.assertIn("idleSecs", idle_row)

    def test_live_process_found_through_lineage_not_just_exact_id(self):
        d = self._tmp.name
        rows = [{"session_id": "s1", "archived": False, "title": "T", "instance": "i",
                 "transcript_path": write_transcript(d, "s1", DONE, age_secs=5)}]
        self.stub.routes["/api/sessions"] = rows

        def dossier_route(method, path, query, body):
            # the dossier answers with a DIFFERENT cliSessionId (a newer hop) but the queried
            # id is in the lineage - liveness must still be attributed
            return {"matches": [{"cliSessionId": "s2", "lineageIds": ["s1", "s2"],
                                 "live": {"pid": 9, "name": "w"}}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        r = waiting_scan.scan()
        self.assertEqual(r["counts"]["running"], 1)
        self.assertEqual(r["counts"]["crashed"], 0)  # NOT misread as a dead chat

    def test_per_chat_dossier_failure_is_ungated_and_incomplete_never_silent(self):
        # A liveness read failing must not let a running chat read as crashed, and the scan
        # must stop claiming completeness.
        d = self._tmp.name
        rows = [{"session_id": "s1", "archived": False, "title": "T", "instance": "i",
                 "transcript_path": write_transcript(d, "s1", DONE, dangling_user=True)}]
        self.stub.routes["/api/sessions"] = rows
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "flaky"})
        r = waiting_scan.scan()
        self.assertFalse(r["complete"])
        self.assertEqual(r["counts"]["dossier-failed"], 1)
        self.assertEqual(r["counts"]["crashed"], 0)  # NOT misfiled as a crash
        self.assertEqual([u["sessionId"] for u in r["ungated"]], ["s1"])
        self.assertIn("liveness unknown", r["ungated"][0]["why"])

    def test_single_match_liveness_trusted_even_without_id_overlap(self):
        d = self._tmp.name
        rows = [{"session_id": "s1", "archived": False, "title": "T", "instance": "i",
                 "transcript_path": write_transcript(d, "s1", DONE, age_secs=5)}]
        self.stub.routes["/api/sessions"] = rows
        self.stub.routes["/api/chats/dossier"] = {
            "matches": [{"cliSessionId": "rolled-id", "lineageIds": [], "priorCliSessionIds": [],
                         "live": {"pid": 3, "name": "w"}}]
        }
        r = waiting_scan.scan()
        self.assertEqual(r["counts"]["running"], 1)

    def test_whole_scan_fails_loudly_when_sessions_read_fails(self):
        self.stub.routes["/api/sessions"] = (500, {"error": "x"})
        with self.assertRaises(hydralib.DaemonError):
            waiting_scan.scan()

    def test_scan_reports_complete_true_because_full_tails_were_read(self):
        self.wire([])
        self.assertTrue(waiting_scan.scan()["complete"])


if __name__ == "__main__":
    unittest.main()
