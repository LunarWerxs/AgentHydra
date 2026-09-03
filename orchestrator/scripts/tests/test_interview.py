"""interview.py: the callout protocol - self-contained questions out, decisions in, rails
executing every answer."""

import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import interview  # noqa: E402
from lib import deliverylib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402

SID = "abcd1111-2222-3333-4444-555566667777"
WAITING = "I finished part one.\n## Am I 100% done?\n- No, part two is open.\nShall I continue?"


from util import run_cli  # noqa: E402


class InterviewTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        tp = Path(self._tmp.name) / "t.jsonl"
        tp.write_text(json.dumps({"type": "assistant",
                                  "message": {"content": [{"type": "text", "text": WAITING}]}}) + "\n",
                      encoding="utf-8")
        old = time.time() - 600
        os.utime(tp, (old, old))
        stub = self.stub

        def dossier_route(method, path, query, body):
            if dossier_query(query) not in (SID, "T"):
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": "c1", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "A waiting chat",
                                 "archived": False, "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/sessions"] = [
            {"session_id": SID, "archived": False, "title": "A waiting chat", "instance": "cold",
             "transcript_path": str(tp), "last_activity_at": 1}
        ]
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True,
             "account": {"email": "a@x.com", "planLabel": "Max 20×"}}]}
        stub.routes["/api/usage/survey"] = {"rows": []}
        stub.routes["/api/usage/cache"] = {"cache": {}}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_ask_emits_self_contained_questions_with_the_chats_own_words(self):
        q = interview.build_questions(cap=10)
        self.assertEqual(len(q["questions"]), 1)
        x = q["questions"][0]
        self.assertEqual(x["sessionId"], SID)
        self.assertIn("Shall I continue?", x["lastWords"])
        self.assertIn("reply", x["question"])
        self.assertIn("answers", q["answerFormat"])

    def test_reply_answer_stages_for_the_courier(self):
        results = interview.apply_answers(
            {"answers": [{"sessionId": SID, "decision": "reply", "text": "Yes - do part two."}]})
        self.assertTrue(results[0]["ok"])
        pend = deliverylib.pending()
        self.assertEqual(len(pend), 1)
        self.assertEqual(pend[0]["text"], "Yes - do part two.")
        # evidence-derived proof: the snippet is one of THIS chat's own lines
        self.assertIn(pend[0]["verifyText"], WAITING)
        self.assertGreaterEqual(len(pend[0]["verifyText"]), 10)

    def test_hold_answer_places_a_real_hold_and_demands_a_reason(self):
        results = interview.apply_answers(
            {"answers": [{"sessionId": SID, "decision": "hold", "reason": "owner is mid-review"}]})
        self.assertTrue(results[0]["ok"])
        self.assertIsNotNone(holdlib.check(SID))
        bad = interview.apply_answers({"answers": [{"sessionId": SID, "decision": "hold"}]})
        self.assertFalse(bad[0]["ok"])

    def test_archive_answer_runs_the_real_rails_with_the_persons_word(self):
        with mock.patch("archive_chat.main", return_value=0) as m:
            results = interview.apply_answers({"answers": [{"sessionId": SID, "decision": "archive"}]})
        m.assert_called_once_with([SID, "--force"])
        self.assertTrue(results[0]["ok"])

    def test_a_refused_archive_is_named_not_swallowed(self):
        with mock.patch("archive_chat.main", return_value=4):
            results = interview.apply_answers({"answers": [{"sessionId": SID, "decision": "archive"}]})
        self.assertFalse(results[0]["ok"])
        self.assertIn("exit 4", results[0]["outcome"])

    def test_skip_records_and_unknown_decisions_are_rejected(self):
        results = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "skip", "reason": "waiting on the MCP work"},
            {"sessionId": SID, "decision": "yeet"},
        ]})
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])

    def test_malformed_answers_file_is_exit_3(self):
        p = Path(self._state.name) / "answers.json"
        p.write_text("{ not json", encoding="utf-8")
        code, _, err = run_cli(interview.main, ["--apply", str(p)])
        self.assertEqual(code, 3)


if __name__ == "__main__":
    unittest.main()
