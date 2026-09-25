"""livenesslib: what a stopped turn amounts to - done, moving, stalled on a plan, or blocked -
and that the gate, the decision and fan_out's member status all carry that answer."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import gatelib, livenesslib  # noqa: E402
import dashboard  # noqa: E402
import fan_out  # noqa: E402


def assistant(text=None, tool_use=None):
    content = []
    if text is not None:
        content.append({"type": "text", "text": text})
    if tool_use:
        content.append({"type": "tool_use", "name": tool_use, "input": {}})
    return {"type": "assistant", "message": {"content": content}}


def user(text):
    return {"type": "user", "message": {"content": text}}


def tool_result():
    return {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}


PLAN_REPLY = ("I'll inspect the gate first, then wire the classifier in.\n\n"
              "Next steps:\n- read gatelib._finished_evidence\n- add the field")


class ClassifyTest(unittest.TestCase):
    def test_a_plan_with_no_tool_call_is_plan_only_and_names_its_next_action(self):
        got = livenesslib.classify(PLAN_REPLY, tool_calls=0)
        self.assertEqual(got["state"], "plan_only")
        self.assertEqual(got["nextAction"], "read gatelib._finished_evidence")

    def test_a_next_steps_block_alone_is_plan_only(self):
        # Regression: a colon-ended "Next steps:" before a newline never matched PLANNING.
        got = livenesslib.classify("Findings above.\n\nNext steps:\n- run X", tool_calls=0)
        self.assertEqual(got["state"], "plan_only")
        self.assertEqual(got["nextAction"], "run X")

    def test_prose_starting_next_steps_is_not_a_next_action_header(self):
        self.assertIsNone(livenesslib.next_action("Next steps are unclear until the soak ends."))

    def test_a_done_recap_that_needs_access_control_is_completed_not_blocked(self):
        text = "Shipped the export.\nWe need access control on the admin route later.\n"
        got = livenesslib.classify(text, tool_calls=3, done_claim="yes")
        self.assertEqual(got["state"], "completed")

    def test_the_same_words_after_real_tool_calls_are_progress_not_a_plan(self):
        self.assertEqual(livenesslib.classify(PLAN_REPLY, tool_calls=3)["state"], "advanced")

    def test_a_first_person_wait_on_a_key_is_blocked(self):
        got = livenesslib.classify("I can't proceed without an API key for the staging service.",
                                   tool_calls=2)
        self.assertEqual(got["state"], "blocked")

    def test_a_fixed_auth_bug_described_in_a_done_recap_is_not_blocked(self):
        text = ("Fixed the 401 unauthorized on an invalid token; permission denied is now "
                "reported cleanly.\n## Am I 100% done?\n- Yes")
        got = livenesslib.classify(text, tool_calls=4, done_claim="yes")
        self.assertEqual(got["state"], "completed")

    def test_a_request_for_review_is_needs_approval(self):
        got = livenesslib.classify("The migration is written. Ready for your review before I run it.",
                                   tool_calls=5)
        self.assertEqual(got["state"], "needs_approval")

    def test_a_bare_reply_with_nothing_behind_it_needs_followup(self):
        got = livenesslib.classify("Looked fine to me.", tool_calls=0,
                                   open_recommendations=["rerun the soak"])
        self.assertEqual(got["state"], "needs_followup")
        self.assertEqual(got["nextAction"], "rerun the soak")


class TurnToolCallsTest(unittest.TestCase):
    def test_counts_only_the_calls_since_the_last_real_prompt(self):
        raw = "\n".join(json.dumps(e) for e in [
            user("earlier task"), assistant("x", tool_use="Bash"), tool_result(),
            assistant("done earlier"),
            user("new task"), assistant(None, tool_use="Read"), tool_result(),
            assistant(None, tool_use="Edit"), tool_result(), assistant("done now"),
        ])
        records = gatelib.parse_tail_records(raw, whole_file=True)
        self.assertEqual(livenesslib.turn_tool_calls(records), 2)


class WiredThroughTest(unittest.TestCase):
    """The classifier is reached: the gate verdict, the decision and fan_out's status carry it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        p = Path(self._tmp.name) / "t.jsonl"
        p.write_text("\n".join(json.dumps(e) for e in [user("do the task"), assistant(PLAN_REPLY)])
                     + "\n", encoding="utf-8")
        old = time.time() - 600
        os.utime(p, (old, old))
        self.path = str(p)

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_stopped_plan_reaches_the_verdict_and_the_decision(self):
        v = gatelib.gate("s", self.path, None)
        self.assertEqual(v["finished"]["liveness"]["state"], "plan_only")
        d = dashboard.decide(v, None, False)
        self.assertEqual(d["kind"], "wait-on-person")
        self.assertEqual(d["liveness"], "plan_only")
        self.assertIn("stalled on a plan", d["action"])

    def test_fan_out_status_reports_the_members_liveness(self):
        v = gatelib.gate("s", self.path, None)
        out = fan_out._finalize_gated_status({}, self.path, v)
        self.assertEqual(out["liveness"], "plan_only")
        self.assertEqual(out["nextAction"], "read gatelib._finished_evidence")


if __name__ == "__main__":
    unittest.main()
