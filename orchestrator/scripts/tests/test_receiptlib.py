"""receiptlib: the fan-out task receipt, classified from transcript bytes.

Contract: `classify` tells delivered / wrong-task / no-echo / never-started / wrong-chat /
pending apart from the transcript alone. Regression it catches: a chat holding our prompt as an
unanswered turn read as a healthy spawn. Seam: the transcript JSONL the app writes; fan_out's
own suite pins what is done with each verdict. Also pinned: a stamped prompt is still the SAME
task to the fleet duplicate check (the receipt's fresh token must not hide a duplicate).
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import gatelib, receiptlib  # noqa: E402

TASK = "Lint every plane under this folder and write the findings to lint-report.md please"


class ReceiptlibTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.rec = receiptlib.make("fo-x#2", "D:/work/plane-a", "lint-report.md")
        self.prompt = receiptlib.stamp(TASK, self.rec)

    def _t(self, *turns):
        p = Path(self._tmp.name) / "t.jsonl"
        rows = []
        for role, text in turns:
            if role == "tool":
                rows.append({"type": "user", "message": {"role": "user", "content": [
                    {"type": "tool_result", "content": text}]}})
            else:
                rows.append({"type": role, "message": {"role": role,
                                                       "content": [{"type": "text", "text": text}]}})
        p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
        return str(p)

    def state(self, *turns):
        return receiptlib.classify(self._t(*turns), self.rec)["state"]

    def test_the_whole_echo_is_delivered(self):
        self.assertEqual(self.state(("user", self.prompt),
                                    ("assistant", receiptlib.line(self.rec) + "\nStarting.")),
                         "delivered")

    def test_an_echo_missing_a_field_is_the_wrong_task(self):
        partial = f"RECEIPT {self.rec['token']} | repo: plane-b | task: fo-x#2"
        self.assertEqual(self.state(("user", self.prompt), ("assistant", partial)), "wrong-task")

    def test_an_answer_without_the_echo_is_no_echo(self):
        self.assertEqual(self.state(("user", self.prompt), ("assistant", "On it.")), "no-echo")

    def test_our_prompt_with_nothing_after_it_never_started(self):
        self.assertEqual(self.state(("user", self.prompt)), "never-started")

    def test_a_tool_result_is_not_the_first_prompt_and_a_foreign_first_turn_is_wrong_chat(self):
        self.assertEqual(self.state(("tool", "x"), ("user", "another task"),
                                    ("assistant", receiptlib.line(self.rec))), "wrong-chat")

    def test_no_transcript_is_pending(self):
        self.assertEqual(receiptlib.classify(None, self.rec)["state"], "pending")

    def test_a_stamped_prompt_is_still_the_same_task_and_strips_back_to_it(self):
        self.assertEqual(receiptlib.strip(self.prompt), TASK)
        self.assertTrue(gatelib.same_task(self.prompt, TASK))
        other = receiptlib.stamp(TASK, receiptlib.make("fo-y#0", "D:/work/plane-a"))
        self.assertTrue(gatelib.same_task(self.prompt, other))


if __name__ == "__main__":
    unittest.main()
