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
from lib import approvallib  # noqa: E402
from lib import deliverylib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402

SID = "abcd1111-2222-3333-4444-555566667777"
WAITING = "I finished part one.\n## Am I 100% done?\n- No, part two is open.\nShall I continue?"
ASK_CARD = ("```ask_user\n"
            + json.dumps({"questions": [{
                "id": "db", "question": "Which store should part two use?",
                "options": [{"label": "SQLite", "description": "already a dependency"},
                            {"label": "JSON file"}],
                "allow_other": False}]})
            + "\n```")


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

    def test_ask_also_surfaces_a_queued_approval_escalation(self):
        # THE JUDGMENT QUEUE WIRING (item 1): unblock_prompts.py's tri-state gate queues an
        # ESCALATE row here instead of pressing it - --ask must hand it back out, command and
        # all, so a person or the AI can decide.
        approvallib.queue_escalation(
            "esc-1", title="a stuck chat", instance="inst2", instance_dir="C:/y",
            verify="hi", command="npm install left-pad", tool_name="Bash",
            reason="no pattern places it")
        q = interview.build_questions(cap=10)
        self.assertEqual(len(q["approvalQuestions"]), 1)
        a = q["approvalQuestions"][0]
        self.assertEqual(a["sessionId"], "esc-1")
        self.assertIn("npm install left-pad", a["command"])
        self.assertIn("approve", a["question"])
        self.assertIn("deny", a["question"])

    def test_approvalovercap_counts_against_the_uncapped_queue(self):
        # Regression (review, 2026-09-04): approvalOverCap used to be computed AFTER the
        # escalation list was already sliced to `cap`, so `len(escalations) - cap` could
        # never be positive - a queue with more escalations than `cap` silently reported 0
        # hidden rows instead of the truth, unlike the sibling "overCap" for judgmentQueue it
        # was meant to mirror.
        for i in range(3):
            approvallib.queue_escalation(
                f"esc-cap-{i}", title=f"chat {i}", instance="inst2", instance_dir="C:/y",
                verify="hi", command="npm install left-pad", tool_name="Bash",
                reason="no pattern places it")
        q = interview.build_questions(cap=2)
        self.assertEqual(len(q["approvalQuestions"]), 2)
        self.assertEqual(q["approvalOverCap"], 1)

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

    def test_archive_answer_runs_the_real_rails_without_lifting_a_hold(self):
        """⛔ An AI's 'archive' answer used to run archive_chat --force, and --force is also the
        flag that lifts a HOLD the owner placed by hand (fixed 2026-09-17). By default it now
        runs the plain rails; only archive.ai_decision_uses_force puts --force back."""
        with mock.patch("archive_chat.main", return_value=0) as m:
            results = interview.apply_answers({"answers": [{"sessionId": SID, "decision": "archive"}]})
        m.assert_called_once_with([SID])
        self.assertTrue(results[0]["ok"])
        real_get = interview.configlib.get
        with mock.patch("archive_chat.main", return_value=0) as m, \
                mock.patch.object(interview.configlib, "get",
                                  side_effect=lambda k, *a: k == "archive.ai_decision_uses_force"
                                  or real_get(k, *a)):
            interview.apply_answers({"answers": [{"sessionId": SID, "decision": "archive"}]})
        m.assert_called_once_with([SID, "--force"])

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

    def _raise_card(self):
        """Rewrite the chat's last words so they end on an ask_user card."""
        tp = Path(self.stub.routes["/api/sessions"][0]["transcript_path"])
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": WAITING + "\n" + ASK_CARD}]}}) + "\n", encoding="utf-8")
        old = time.time() - 600
        os.utime(tp, (old, old))

    def test_ask_user_card_surfaces_and_is_answered_exactly_once(self):
        # ASK_USER (harvest, 2026-09-25): a chat that ends on a typed card gets it handed out
        # parsed, and an 'answer' by option number stages the composed reply ONCE - the second
        # answer to the same card is refused, so two answerers cannot send two replies.
        self._raise_card()
        q = interview.build_questions(cap=10)
        card = q["questions"][0]["ask"]
        self.assertEqual(card["questions"][0]["id"], "db")
        first = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "answer", "askKey": card["key"], "choices": {"db": 2}}]})
        self.assertTrue(first[0]["ok"], first[0]["outcome"])
        pend = deliverylib.pending()
        self.assertEqual(len(pend), 1)
        self.assertIn("JSON file", pend[0]["text"])
        self.assertIn("```ask_user_answer", pend[0]["text"])
        again = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "answer", "choices": {"db": "SQLite"}}]})
        self.assertFalse(again[0]["ok"])
        self.assertIn("already answered", again[0]["outcome"])
        self.assertEqual(len(deliverylib.pending()), 1)

    def test_answer_refuses_a_stale_key_an_unknown_option_and_a_chat_with_no_card(self):
        none = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "answer", "choices": {"db": 1}}]})
        self.assertFalse(none[0]["ok"])
        self._raise_card()
        stale = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "answer", "askKey": "0000", "choices": {"db": 1}}]})
        self.assertIn("stale", stale[0]["outcome"])
        bad = interview.apply_answers({"answers": [
            {"sessionId": SID, "decision": "answer", "choices": {"db": "Postgres"}}]})
        self.assertFalse(bad[0]["ok"])
        self.assertEqual(deliverylib.pending(), [])


class ApprovalEscalationApplyTest(unittest.TestCase):
    """apply_answers' 'approve'/'deny' branches - the other half of the judgment queue loop
    (item 1): a person or the AI answers a queued escalation and the decision actually
    executes, through the same actuator rails unblock_prompts.py itself uses."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        approvallib.queue_escalation(
            "esc-1", title="a stuck chat", instance="inst2", instance_dir="C:/y",
            verify="hi", command="npm install left-pad", tool_name="Bash",
            reason="no pattern places it")

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_approve_presses_through_the_actuator_and_clears_the_queue(self):
        with mock.patch("unblock_prompts.press",
                        return_value={"ok": True, "outcome": "approved - the chat carries on"}) as m:
            results = interview.apply_answers(
                {"answers": [{"sessionId": "esc-1", "decision": "approve"}]})
        m.assert_called_once()
        self.assertEqual(m.call_args.args[0]["sessionId"], "esc-1")
        self.assertTrue(results[0]["ok"])
        self.assertIsNone(approvallib.get_escalation("esc-1"))

    def test_a_failed_press_leaves_the_row_queued(self):
        with mock.patch("unblock_prompts.press",
                        return_value={"ok": False, "outcome": "did NOT clear"}):
            results = interview.apply_answers(
                {"answers": [{"sessionId": "esc-1", "decision": "approve"}]})
        self.assertFalse(results[0]["ok"])
        self.assertIsNotNone(approvallib.get_escalation("esc-1"))

    def test_deny_never_presses_and_clears_the_queue(self):
        with mock.patch("unblock_prompts.press") as m:
            results = interview.apply_answers({"answers": [
                {"sessionId": "esc-1", "decision": "deny", "reason": "looked risky"}]})
        m.assert_not_called()
        self.assertTrue(results[0]["ok"])
        self.assertIn("looked risky", results[0]["outcome"])
        self.assertIsNone(approvallib.get_escalation("esc-1"))

    def test_approve_or_deny_on_an_unqueued_session_is_rejected(self):
        results = interview.apply_answers(
            {"answers": [{"sessionId": "not-queued", "decision": "approve"}]})
        self.assertFalse(results[0]["ok"])


if __name__ == "__main__":
    unittest.main()
