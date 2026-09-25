"""goal_watch + lib/goallib: continuing a chat's standing goal, and auditing that it moves.

The goal file's shape is the one the /goal command writes (GOAL, STATUS: IN PROGRESS, DONE, NEXT
as a `- [ ]` checklist, TOUCHED, UPDATED). The lane cases pin who is prompted (the goal's owner,
turn ended and quiet), with what (a continuation, or a wrap-up near the account's limit), and when
it stops (the goal file unchanged across continuations becomes an incident).
"""

import json
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import goal_watch  # noqa: E402
from lib import goallib  # noqa: E402

from util import isolate_state_dir, run_cli  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"
OTHER = "66666666-7777-8888-9999-000000000000"


def _goal(status="IN PROGRESS", open_items=("wire the lane", "write the tests"), done=("read the code",)):
    return ("GOAL\nShip the goal lane.\n\n"
            f"STATUS: {status}\n\nDONE\n" + "".join(f"- [x] {d}\n" for d in done)
            + "\nNEXT\n" + "".join(f"- [ ] {o}\n" for o in open_items)
            + "\nTOUCHED\n- a.py\n\nUPDATED\n2026-09-24T10:00Z\n")


class GoalFileTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.repo = Path(self._d.name) / "repo"
        (self.repo / ".git").mkdir(parents=True)
        (self.repo / "tmp" / "handoff").mkdir(parents=True)
        self.goal = self.repo / "tmp" / "handoff" / "GOAL.md"

    def test_the_status_and_checklist_are_read_in_every_markup_the_command_produces(self):
        for text in (_goal(), _goal().replace("STATUS: IN PROGRESS", "**STATUS:** IN PROGRESS"),
                     _goal().replace("STATUS: IN PROGRESS", "## STATUS\nIN PROGRESS")):
            with self.subTest(text=text[:60]):
                self.goal.write_text(text, encoding="utf-8")
                g = goallib.parse(self.goal)
                self.assertTrue(g["inProgress"])
                self.assertEqual((g["open"], g["done"]), (2, 1))
                self.assertEqual(g["firstOpen"], "wire the lane")

    def test_a_status_line_inside_the_goal_text_does_not_win(self):
        self.goal.write_text("GOAL\nStatus: page must load in 2s\n\n" + _goal("DONE"), encoding="utf-8")
        g = goallib.parse(self.goal)
        self.assertEqual(g["status"], "DONE")
        self.assertFalse(g["inProgress"])

    def test_the_file_is_found_from_a_subfolder_but_never_above_the_repo_root(self):
        self.goal.write_text(_goal(), encoding="utf-8")
        sub = self.repo / "server" / "src"
        sub.mkdir(parents=True)
        self.assertEqual(goallib.find_goal_file(str(sub)), self.goal)
        inner = self.repo / "vendor" / "lib"
        (inner / ".git").mkdir(parents=True)
        self.assertIsNone(goallib.find_goal_file(str(inner)))

    def test_only_a_transcript_that_named_the_file_owns_it_and_reads_are_incremental(self):
        tp = Path(self._d.name) / f"{SID}.jsonl"
        tp.write_text(json.dumps({"type": "user", "message": {"content": "fix the bug"}}) + "\n",
                      encoding="utf-8")
        owns, cache = goallib.mentions_goal(str(tp))
        self.assertFalse(owns)
        with open(tp, "a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {
                "content": "Write the goal to D:\\x\\tmp\\handoff\\GOAL.md"}}) + "\n")
        owns, cache = goallib.mentions_goal(str(tp), cache)
        self.assertTrue(owns)
        self.assertEqual(cache["offset"], tp.stat().st_size)

    def test_the_continuation_carries_the_audit_rules(self):
        self.goal.write_text(_goal(), encoding="utf-8")
        text = goallib.continuation_text(goallib.parse(self.goal), rel_path="tmp/handoff/GOAL.md",
                                         unchanged_for=2)
        for rule in ("PROGRESS:", "VERIFIED WAIT:", "NO PROGRESS:", "A timeout is not an ending",
                     "one blocker", "Do not shrink the goal", "STATUS: BLOCKED",
                     "not changed since the last 2 goal check"):
            self.assertIn(rule, text)

    def test_the_wrapup_keeps_the_goal_open(self):
        self.goal.write_text(_goal(), encoding="utf-8")
        text = goallib.wrapup_text(goallib.parse(self.goal), rel_path="tmp/handoff/GOAL.md",
                                   pct=83, wrapup_pct=80)
        self.assertIn("Do not start new work", text)
        self.assertIn("keep STATUS: IN PROGRESS", text)
        self.assertIn("83%", text)


class LaneTest(unittest.TestCase):
    """goal_watch.run over a stubbed fleet: who is prompted, with what, and when it stops."""

    def setUp(self):
        isolate_state_dir(self)
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        root = Path(self._d.name)
        self.repo = root / "repo"
        (self.repo / ".git").mkdir(parents=True)
        (self.repo / "tmp" / "handoff").mkdir(parents=True)
        self.goal = self.repo / "tmp" / "handoff" / "GOAL.md"
        self.goal.write_text(_goal(), encoding="utf-8")
        self.tp = root / f"{SID}.jsonl"
        self.tp.write_text(json.dumps({"type": "user", "message": {
            "content": "Write the goal to `tmp/handoff/GOAL.md`"}}) + "\n", encoding="utf-8")
        self.bystander = root / f"{OTHER}.jsonl"
        self.bystander.write_text(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n",
                                  encoding="utf-8")
        self.sent = []
        self.ended = True
        self.quiet = goal_watch.QUIET_SECS + 60
        self.pct = 30
        live = [{"sessionId": SID, "transcriptPath": str(self.tp), "cwd": str(self.repo), "pid": 1},
                {"sessionId": OTHER, "transcriptPath": str(self.bystander), "cwd": str(self.repo),
                 "pid": 2}]
        patches = [
            mock.patch.object(goal_watch.hydralib, "api_get", lambda path: {"sessions": live}),
            mock.patch.object(goal_watch.hydralib, "visible_chats", lambda: [
                {"session_id": SID, "title": "Goal chat", "instance": "inst1"},
                {"session_id": OTHER, "title": "Other chat", "instance": "inst1"}]),
            mock.patch.object(goal_watch.gatelib, "gate", lambda sid, tp, row: (
                {"state": "running", "quiet_secs": self.quiet, "idle": {"quiet_secs": self.quiet}}
                if self.ended else {"state": "running", "quiet_secs": self.quiet})),
            mock.patch.object(goal_watch.bandlib, "snapshot", lambda: {
                "bands": {"inst1": "ok"},
                "accounts": [{"peakPct": self.pct, "band": "ok", "instances": [{"name": "inst1"}]}]}),
            mock.patch.object(goal_watch, "send", self._send),
        ]
        for p_ in patches:
            p_.start()
            self.addCleanup(p_.stop)

    def _send(self, chat, text):
        self.sent.append((chat["sessionId"], text))
        return True, "delivered"

    def _run(self, *argv):
        return goal_watch.run(list(argv))

    def test_plan_only_names_the_owner_and_types_nothing(self):
        payload, code = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(self.sent, [])
        self.assertEqual([c["sessionId"] for c in payload["chats"]], [SID])
        self.assertTrue(payload["chats"][0]["action"].startswith("would continue"))

    def test_the_owner_is_continued_once_and_the_bystander_never(self):
        self._run("--yes", "--force")
        self.assertEqual([s for s, _ in self.sent], [SID])
        self.assertIn("NO PROGRESS:", self.sent[0][1])
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(payload["chats"][0]["action"], "continued recently")

    def test_a_done_goal_is_left_alone(self):
        self.goal.write_text(_goal("DONE", open_items=()), encoding="utf-8")
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.sent, [])
        self.assertIn("left alone", payload["chats"][0]["action"])

    def test_a_chat_mid_turn_or_just_stopped_is_not_talked_over(self):
        self.ended = False
        self._run("--yes", "--force")
        self.ended, self.quiet = True, 60
        self._run("--yes", "--force")
        self.assertEqual(self.sent, [])

    def test_a_held_chat_is_left_alone(self):
        with mock.patch.object(goal_watch.holdlib, "why_blocked", lambda sid, _holds=None: "held by owner"):
            payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.sent, [])
        self.assertIn("held", payload["chats"][0]["action"])

    def test_an_unchanged_goal_file_is_named_then_filed_as_an_incident(self):
        recorded = []
        with mock.patch.object(goal_watch, "RENUDGE_SECS", 0), \
             mock.patch.object(goal_watch.incidentlib, "record",
                               lambda scope, key, error, **kw: recorded.append(scope) or "inc-1"):
            for _ in range(goal_watch.MAX_UNCHANGED + 2):
                payload, _ = self._run("--yes", "--force")
        self.assertEqual(len(self.sent), goal_watch.MAX_UNCHANGED)
        self.assertIn("has not changed since the last 1 goal check", self.sent[1][1])
        self.assertEqual(recorded, ["goal_watch"])
        self.assertIn("incident already filed", payload["chats"][0]["action"])

    def test_a_goal_file_that_moves_resets_the_audit(self):
        with mock.patch.object(goal_watch, "RENUDGE_SECS", 0), \
             mock.patch.object(goal_watch.incidentlib, "record", lambda *a, **kw: "inc-1"):
            for i in range(goal_watch.MAX_UNCHANGED + 2):
                self.goal.write_text(_goal(open_items=(f"step {i}",)), encoding="utf-8")
                self._run("--yes", "--force")
        self.assertEqual(len(self.sent), goal_watch.MAX_UNCHANGED + 2)
        self.assertTrue(all("has not changed" not in t for _, t in self.sent))

    def test_near_the_limit_the_wrapup_goes_instead_and_only_once(self):
        self.pct = goal_watch.WRAPUP_PCT + 1
        with mock.patch.object(goal_watch, "RENUDGE_SECS", 0):
            self._run("--yes", "--force")
            self._run("--yes", "--force")
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Do not start new work", self.sent[0][1])
        self.assertNotIn("NO PROGRESS:", self.sent[0][1])

    def test_the_policy_switch_turns_acting_off(self):
        with mock.patch.object(goal_watch.configlib, "get",
                               lambda key, fallback=None: False if key == "goalwatch.enabled" else fallback):
            payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.sent, [])
        self.assertFalse(payload["acting"])

    def test_an_unknown_flag_is_refused_before_anything_is_read(self):
        code, _out, _err = run_cli(goal_watch.main, ["--yes", "--sesion", SID])
        self.assertEqual(code, 3)
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
