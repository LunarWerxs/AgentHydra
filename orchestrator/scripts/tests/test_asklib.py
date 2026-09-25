"""asklib: an ask_user card that breaks its limits is reported MALFORMED, never trimmed to
fit, and an answer must cover every question with a real option."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import asklib  # noqa: E402


def _card(questions) -> str:
    return "Need a call.\n```ask_user\n" + json.dumps({"questions": questions}) + "\n```"


Q = {"id": "db", "question": "Which store?", "options": ["SQLite", "JSON file"], "allow_other": True}


class AskLibTest(unittest.TestCase):
    def test_no_fence_is_no_card(self):
        self.assertIsNone(asklib.find("Shall I use SQLite or a JSON file?"))

    def test_limits_are_refused_not_trimmed(self):
        # A card showing something the chat did not ask is worse than no card: each limit
        # breach comes back as an error, with no questions attached.
        cases = [
            [Q, dict(Q, id="b"), dict(Q, id="c"), dict(Q, id="d")],   # 4 questions
            [dict(Q, options=["only one"])],                            # 1 option
            [dict(Q, options=["a", "b", "c", "d"])],                    # 4 options
            [dict(Q, options=["x" * 81, "b"])],                         # label over 80
            [dict(Q, options=[{"label": "a", "description": "d" * 241}, "b"])],
            [Q, dict(Q)],                                               # duplicate id
        ]
        for qs in cases:
            card = asklib.find(_card(qs))
            self.assertIsNone(card["key"], qs)
            self.assertNotIn("questions", card)
        self.assertIsNone(asklib.find("```ask_user\n{not json\n```")["key"])

    def test_answer_must_cover_every_question_with_a_real_option(self):
        card = asklib.find(_card([Q, dict(Q, id="ui", allow_other=False)]))
        self.assertTrue(card["key"])
        with self.assertRaises(asklib.AskError):
            asklib.compose_reply(card, {"db": 1})                        # ui unanswered
        with self.assertRaises(asklib.AskError):
            asklib.compose_reply(card, {"db": 1, "ui": {"other": "x"}})  # ui forbids other
        with self.assertRaises(asklib.AskError):
            asklib.compose_reply(card, {"db": 3, "ui": 1})               # no option 3
        text = asklib.compose_reply(card, {"db": {"other": "Redis"}, "ui": "json FILE"})
        body = json.loads(text.split("```ask_user_answer\n", 1)[1].rsplit("\n```", 1)[0])
        self.assertEqual(body["key"], card["key"])
        self.assertEqual(body["answers"], [{"id": "db", "other": "Redis"},
                                           {"id": "ui", "choice": "JSON file"}])


if __name__ == "__main__":
    unittest.main()
