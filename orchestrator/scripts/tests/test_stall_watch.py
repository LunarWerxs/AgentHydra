"""stall_watch + lib/stalllib: which background tasks a chat left open, and asking it about them.

The shapes pinned here are the ones the transcript actually carries (read off real chats,
2026-09-24): an Agent launch's `toolUseResult.agentId`, a Workflow's `taskId`/`runId`, a shell's
`backgroundTaskId`; an end as a <task-notification> in a queue-operation record, a queued_command
attachment or a plain user string; a TaskStop that leaves no notification at all. Case 6 is the
false positive the first live run found: a foreground command that PRINTED a launch message.
"""

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

import stall_watch  # noqa: E402
from lib import stalllib  # noqa: E402

from util import isolate_state_dir, run_cli  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


class Tx:
    """A fixture transcript: <root>/<sid>.jsonl with <root>/<sid>/subagents/ beside it."""

    def __init__(self, root: Path, sid: str = SID):
        self.path = root / f"{sid}.jsonl"
        self.sid = sid
        self.n = 0
        self.path.write_text("", encoding="utf-8")
        self.sub = root / sid / "subagents"
        self.sub.mkdir(parents=True, exist_ok=True)

    def add(self, rec: dict):
        rec.setdefault("sessionId", self.sid)
        rec.setdefault("timestamp", _iso(time.time() - 3600))
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    def launch(self, name, tur, text="", desc="a task", is_error=False, sid=None, inp=None):
        self.n += 1
        uid = f"toolu_{self.n}"
        self.add({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": uid, "name": name,
             "input": inp or {"description": desc, "command": "echo hi"}}]}})
        rec = {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": uid, "content": text, "is_error": is_error}]}}
        if tur is not None:
            rec["toolUseResult"] = tur
        if sid:
            rec["sessionId"] = sid
        self.add(rec)

    def notify(self, tid, shape="queue", status="completed"):
        body = (f"<task-notification>\n<task-id>{tid}</task-id>\n<status>{status}</status>\n"
                "<summary>done</summary>\n</task-notification>")
        if shape == "queue":
            self.add({"type": "queue-operation", "operation": "enqueue", "content": body})
        elif shape == "attachment":
            self.add({"type": "attachment", "attachment": {"type": "queued_command", "prompt": body}})
        else:
            self.add({"type": "user", "message": {"role": "user", "content": body}})

    def taskstop(self, tid, is_error=False):
        self.n += 1
        uid = f"toolu_{self.n}"
        self.add({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": uid, "name": "TaskStop", "input": {"task_id": tid}}]}})
        self.add({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": uid, "content": "stopped", "is_error": is_error}]}})

    def open_ids(self):
        tasks, _ = stalllib.scan(self.path)
        return sorted(t["id"] for t in tasks)


def _agent(aid):
    return {"isAsync": True, "status": "async_launched", "agentId": aid, "description": "Drive Sue"}


class ScanTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.tx = Tx(Path(self._d.name))

    def test_launches_of_every_kind_are_open(self):
        self.tx.launch("Agent", _agent("a1"))
        self.tx.launch("Workflow", {"status": "async_launched", "taskId": "w1",
                                    "taskType": "local_workflow", "runId": "wf_abc", "workflowName": "audit"})
        self.tx.launch("Bash", {"stdout": "", "backgroundTaskId": "b1"},
                       text="Command running in background with ID: b1. Output is being written to: "
                            "C:\\x\\tasks\\b1.output. You will be notified")
        self.assertEqual(self.tx.open_ids(), ["a1", "b1", "w1"])

    def test_every_notification_shape_ends_its_task(self):
        for tid, shape in (("a1", "queue"), ("a2", "attachment"), ("a3", "user")):
            self.tx.launch("Agent", _agent(tid))
            self.tx.notify(tid, shape)
        self.tx.launch("Agent", _agent("a4"))
        self.tx.notify("a4", "queue", status="stopped")
        self.assertEqual(self.tx.open_ids(), [])

    def test_a_quoted_notification_ends_nothing(self):
        self.tx.launch("Agent", _agent("a1"))
        quoted = ("<task-notification><task-id>a1</task-id><status>completed</status>"
                  "</task-notification>")
        self.tx.launch("Bash", {"stdout": quoted}, text=quoted)
        self.tx.add({"type": "assistant", "message": {"content": [{"type": "text", "text": quoted}]}})
        self.assertEqual(self.tx.open_ids(), ["a1"])

    def test_taskstop_ends_it_only_when_it_succeeded(self):
        self.tx.launch("Agent", _agent("a1"))
        self.tx.launch("Agent", _agent("a2"))
        self.tx.taskstop("a1")
        self.tx.taskstop("a2", is_error=True)
        self.assertEqual(self.tx.open_ids(), ["a2"])

    def test_a_launch_from_a_previous_process_of_a_resumed_chat_is_not_open(self):
        self.tx.launch("Agent", _agent("old"), sid="99999999-0000-0000-0000-000000000000")
        self.tx.launch("Agent", _agent("new"))
        self.assertEqual(self.tx.open_ids(), ["new"])

    def test_a_foreground_command_that_printed_a_launch_message_is_not_a_launch(self):
        # Found on the first live run: a probe printed transcript samples.
        printed = "--- result-Bash\nCommand running in background with ID: bvunvqaf5. Output ..."
        self.tx.launch("Bash", {"stdout": printed, "stderr": ""}, text=printed)
        self.tx.launch("Bash", None, text="some output\n" + printed)
        self.tx.launch("Agent", None, text="notes: agentId: abc async stuff")
        self.assertEqual(self.tx.open_ids(), [])

    def test_the_text_fallback_still_reads_a_real_launch_message(self):
        self.tx.launch("Bash", None, text="Command running in background with ID: b9. Output is "
                                          "being written to: C:\\t\\b9.output. You will be notified")
        self.assertEqual(self.tx.open_ids(), ["b9"])

    def test_an_errored_launch_is_not_open(self):
        self.tx.launch("Agent", _agent("a1"), is_error=True)
        self.assertEqual(self.tx.open_ids(), [])

    def test_incremental_scan_reads_only_what_was_appended(self):
        self.tx.launch("Agent", _agent("a1"))
        tasks, cache = stalllib.scan(self.tx.path)
        self.assertEqual([t["id"] for t in tasks], ["a1"])
        self.tx.notify("a1")
        tasks, cache2 = stalllib.scan(self.tx.path, cache)
        self.assertEqual(tasks, [])
        self.assertGreater(cache2["offset"], 0)

    def test_a_rewritten_shorter_file_is_read_from_the_start(self):
        for i in range(5):
            self.tx.launch("Agent", _agent(f"a{i}"))
        _, cache = stalllib.scan(self.tx.path)
        self.tx.path.write_text("", encoding="utf-8")
        self.tx.launch("Agent", _agent("fresh"))
        tasks, _ = stalllib.scan(self.tx.path, cache)
        self.assertEqual([t["id"] for t in tasks], ["fresh"])


class ActivityTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.tx = Tx(Path(self._d.name))
        self.now = time.time()

    def _one(self):
        tasks, _ = stalllib.scan(self.tx.path)
        self.assertEqual(len(tasks), 1)
        t = tasks[0]
        return t, stalllib.activity(t, self.tx.path, self.now)

    def _touch(self, p: Path, ago: float):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}\n", encoding="utf-8")
        os.utime(p, (self.now - ago, self.now - ago))

    def test_an_agent_is_judged_on_its_own_transcript(self):
        self.tx.launch("Agent", _agent("a1"))
        self._touch(self.tx.sub / "agent-a1.jsonl", 25 * 60)
        t, a = self._one()
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "stalled")
        self._touch(self.tx.sub / "agent-a1.jsonl", 60)
        t, a = self._one()
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "active")

    def test_a_workflow_names_the_agent_that_started_and_never_returned(self):
        self.tx.launch("Workflow", {"status": "async_launched", "taskId": "w1", "runId": "wf_r1",
                                    "taskType": "local_workflow", "workflowName": "audit"})
        wdir = self.tx.sub / "workflows" / "wf_r1"
        wdir.mkdir(parents=True)
        (wdir / "journal.jsonl").write_text("\n".join(json.dumps(r) for r in [
            {"type": "launched"},
            {"type": "started", "agentId": "x1", "label": "map:fast"},
            {"type": "started", "agentId": "x2", "label": "map:hung"},
            {"type": "result", "agentId": "x1", "result": {}},
            # `failed` settles a key, and a retry reuses the key under a new agentId
            {"type": "started", "key": "k3", "agentId": "x3", "label": "map:failed"},
            {"type": "failed", "key": "k3", "agentId": "x3"},
            {"type": "started", "key": "k4", "agentId": "x4a", "label": "map:retried"},
            {"type": "started", "key": "k4", "agentId": "x4b", "label": "map:retried"},
            {"type": "result", "key": "k4", "agentId": "x4b", "result": {}},
        ]) + "\n", encoding="utf-8")
        os.utime(wdir / "journal.jsonl", (self.now - 1800, self.now - 1800))
        self._touch(wdir / "agent-x1.jsonl", 1800)
        self._touch(wdir / "agent-x2.jsonl", 2400)
        t, a = self._one()
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "stalled")
        self.assertEqual([s["label"] for s in a["stuckAgents"]], ["map:hung"])
        self.assertIn('agent "map:hung"', stalllib.describe(t, a))

    def test_one_hung_agent_stalls_a_workflow_whose_siblings_are_still_busy(self):
        # Measured live: folder written 15 min ago, one agent silent 15 HOURS.
        self.tx.launch("Workflow", {"status": "async_launched", "taskId": "w1", "runId": "wf_r2",
                                    "taskType": "local_workflow", "workflowName": "sweep"})
        wdir = self.tx.sub / "workflows" / "wf_r2"
        wdir.mkdir(parents=True)
        (wdir / "journal.jsonl").write_text("\n".join(json.dumps(r) for r in [
            {"type": "started", "agentId": "busy", "label": "fresh"},
            {"type": "started", "agentId": "hung", "label": "hung-one"},
            {"type": "started", "agentId": "queued", "label": "not-started-yet"},
        ]) + "\n", encoding="utf-8")
        self._touch(wdir / "agent-busy.jsonl", 60)
        self._touch(wdir / "agent-hung.jsonl", 15 * 3600)
        t, a = self._one()
        self.assertLess(a["silentSecs"], 1200)
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "stalled")
        # a queued agent (no transcript yet) never counts as hung
        self._touch(wdir / "agent-hung.jsonl", 60)
        t, a = self._one()
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "active")

    def test_a_file_written_after_now_is_active_not_negative(self):
        self.tx.launch("Agent", _agent("a1"))
        self._touch(self.tx.sub / "agent-a1.jsonl", -5)
        t, a = self._one()
        self.assertEqual(a["silentSecs"], 0)

    def test_a_shell_is_judged_on_age_not_silence(self):
        self.tx.launch("Bash", {"backgroundTaskId": "b1"})
        t, a = self._one()
        # launched an hour ago (the fixture timestamp) with no output file at all
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=3600), "stalled")
        self.assertEqual(stalllib.verdict(t, a, silent_secs=1200, shell_secs=7200), "active")

    def test_the_question_carries_the_exact_commands(self):
        self.tx.launch("Workflow", {"status": "async_launched", "taskId": "w1", "runId": "wf_r1",
                                    "taskType": "local_workflow", "workflowName": "audit"})
        t, a = self._one()
        text = stalllib.nudge_text([(t, a)])
        self.assertIn("TaskStop", text)
        self.assertIn("resumeFromRunId", text)
        self.assertIn("w1", text)
        self.assertIn("Is it stuck?", text)


class LaneTest(unittest.TestCase):
    """stall_watch.run over a stubbed fleet: who is asked, who is left alone, and when."""

    def setUp(self):
        isolate_state_dir(self)
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.tx = Tx(Path(self._d.name))
        self.tx.launch("Agent", _agent("a1"))
        p = self.tx.sub / "agent-a1.jsonl"
        p.write_text("{}\n", encoding="utf-8")
        old = time.time() - 3 * 3600
        os.utime(p, (old, old))
        self.asked = []
        self.idle = True
        self.quiet = 60
        patches = [
            mock.patch.object(stall_watch.hydralib, "api_get", lambda path: {"sessions": [
                {"sessionId": SID, "transcriptPath": str(self.tx.path), "name": "chat", "pid": 1}]}),
            mock.patch.object(stall_watch.hydralib, "visible_chats", lambda: [
                {"session_id": SID, "title": "Stuck chat", "instance": "inst1"}]),
            mock.patch.object(stall_watch.gatelib, "gate", lambda sid, tp, live: (
                {"state": "running", "quiet_secs": self.quiet, "idle": {"quiet_secs": self.quiet}}
                if self.idle else {"state": "running", "quiet_secs": self.quiet})),
            mock.patch.object(stall_watch, "ask", self._ask),
        ]
        for p_ in patches:
            p_.start()
            self.addCleanup(p_.stop)

    def _ask(self, chat, items):
        self.asked.append((chat["sessionId"], [t["id"] for t, _ in items]))
        return True, "delivered"

    def _run(self, *argv):
        return stall_watch.run(list(argv))

    def test_plan_only_names_the_chat_and_types_nothing(self):
        payload, code = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(self.asked, [])
        self.assertEqual(payload["stalledChats"], 1)
        self.assertEqual(payload["chats"][0]["action"], "would ask")

    def test_it_asks_once_then_waits_out_the_renudge_window(self):
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [(SID, ["a1"])])
        self.assertTrue(payload["chats"][0]["action"].startswith("asked"))
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(payload["chats"][0]["action"], "already asked recently")

    def test_a_chat_that_is_writing_is_reported_not_interrupted(self):
        self.idle = False
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [])
        self.assertIn("working", payload["chats"][0]["action"])

    def test_a_chat_whose_own_turn_went_quiet_is_asked_even_mid_turn(self):
        # Measured live: "running" per the gate, silent 3.8 h, last records two unanswered
        # completion notices - a hung turn, not a working one.
        self.idle = False
        self.quiet = stall_watch.SILENT_SECS + 60
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [(SID, ["a1"])])

    def test_a_held_chat_is_left_alone(self):
        with mock.patch.object(stall_watch.holdlib, "why_blocked", lambda sid, _holds=None: "held by owner"):
            payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [])
        self.assertIn("held", payload["chats"][0]["action"])

    def test_after_max_nudges_it_becomes_an_incident_and_stops_asking(self):
        recorded = []
        with mock.patch.object(stall_watch, "RENUDGE_SECS", 0), \
             mock.patch.object(stall_watch.incidentlib, "record",
                               lambda scope, key, error, **kw: recorded.append((scope, key)) or "inc-1"):
            for _ in range(stall_watch.MAX_NUDGES + 2):
                payload, _ = self._run("--yes", "--force")
        self.assertEqual(len(self.asked), stall_watch.MAX_NUDGES)
        self.assertEqual(recorded, [("stall_watch", f"{SID}:a1")])
        self.assertEqual(payload["chats"][0]["action"], "incident already filed")

    def test_a_finished_task_is_never_asked_about(self):
        self.tx.notify("a1")
        payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [])
        self.assertEqual(payload["stalledChats"], 0)

    def test_the_policy_switch_turns_acting_off(self):
        with mock.patch.object(stall_watch.configlib, "get",
                               lambda key, fallback=None: False if key == "stallwatch.enabled" else fallback):
            payload, _ = self._run("--yes", "--force")
        self.assertEqual(self.asked, [])
        self.assertFalse(payload["acting"])

    def test_an_unknown_flag_is_refused_before_anything_is_read(self):
        code, _out, _err = run_cli(stall_watch.main, ["--yes", "--sesion", SID])
        self.assertEqual(code, 3)
        self.assertEqual(self.asked, [])


if __name__ == "__main__":
    unittest.main()
