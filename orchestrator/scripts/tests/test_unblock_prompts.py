"""unblock_prompts: find_stuck()'s new verify/instanceDir/eligible fields, and press()
passing -Instance/-VerifyText through to the actuator."""

import json
import os
import sys
import tempfile
import time
import types
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import unblock_prompts  # noqa: E402
from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402
from lib import stamplib  # noqa: E402

from util import run_cli  # noqa: E402


def _user(text):
    return {"type": "user", "message": {"content": text}}


def _assistant_text(text):
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}


def _assistant_tool(name):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": {}}]}}


def _write_jsonl(path: Path, events: list) -> None:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")


class FindStuckTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.root = Path(self._tmp.name)

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()
        self._tmp.cleanup()

    def _transcript(self, name: str, events: list, age_secs: float) -> Path:
        p = self.root / name
        _write_jsonl(p, events)
        old = time.time() - age_secs
        os.utime(p, (old, old))
        return p

    def test_pending_row_carries_verify_instanceDir_and_is_eligible(self):
        sid_ok = "sid-with-verify"
        sid_short = "sid-short-verify"
        long_sentence = (
            "I have finished reviewing the configuration and am now deploying the "
            "artifact to the staging cluster, please hold on while this completes."
        )
        t_ok = self._transcript("ok.jsonl", [
            _user("please deploy this"),
            _assistant_text(long_sentence),
            _assistant_tool("Bash"),
        ], age_secs=unblock_prompts.MIN_WAIT_SECS + 60)
        t_short = self._transcript("short.jsonl", [
            _user("ok"),
            _assistant_text("Ok."),
            _assistant_tool("Bash"),
        ], age_secs=unblock_prompts.MIN_WAIT_SECS + 60)

        store_root = self.root / "inst1" / "claude-code-sessions"
        store = {"instance": "inst1", "root": store_root, "isRunning": True}
        meta_ok = {"cliSessionId": sid_ok, "title": "chat one",
                  "permissionMode": stamplib.BYPASS, "isArchived": False}
        meta_short = {"cliSessionId": sid_short, "title": "chat two",
                     "permissionMode": stamplib.BYPASS, "isArchived": False}

        with mock.patch.object(hydralib, "fleet", return_value={}), \
             mock.patch.object(hydralib, "api_get",
                               return_value={"sessions": [{"sessionId": sid_ok},
                                                          {"sessionId": sid_short}]}), \
             mock.patch.object(stamplib, "store_roots", return_value=[store]), \
             mock.patch.object(stamplib, "iter_metas",
                               return_value=[(store_root / "a" / "b" / "local_1.json", meta_ok),
                                            (store_root / "a" / "b" / "local_2.json", meta_short)]), \
             mock.patch.object(stamplib, "transcript_index",
                               return_value={sid_ok: t_ok, sid_short: t_short}), \
             mock.patch.object(stamplib, "is_bypass", return_value=True):
            rows = unblock_prompts.find_stuck()

        by_sid = {r["sessionId"]: r for r in rows}
        self.assertEqual(set(by_sid), {sid_ok, sid_short})

        row_ok = by_sid[sid_ok]
        self.assertEqual(row_ok["instanceDir"], str(store_root.parent))
        self.assertTrue(row_ok["verify"])
        self.assertTrue(row_ok["eligible"])
        self.assertEqual(row_ok["ineligibleWhy"], "")

        row_short = by_sid[sid_short]
        self.assertEqual(row_short["verify"], "")
        self.assertFalse(row_short["eligible"])
        self.assertTrue(row_short["ineligibleWhy"])

    def test_a_recent_spawned_row_grants_eligibility_but_a_stale_one_does_not(self):
        # A chat whose permissionMode is NOT bypass is normally a person's call - UNLESS the
        # toolbox itself spawned it with bypass promised (ledger kind 'spawned') less than 24h
        # ago. An older promise (here: 2 days) must not count.
        sid_fresh = "sid-spawned-fresh"
        sid_stale = "sid-spawned-stale"
        long_sentence = (
            "I have finished reviewing the configuration and am now deploying the "
            "artifact to the staging cluster, please hold on while this completes."
        )
        t_fresh = self._transcript("fresh.jsonl", [
            _user("please deploy this"),
            _assistant_text(long_sentence),
            _assistant_tool("Bash"),
        ], age_secs=unblock_prompts.MIN_WAIT_SECS + 60)
        t_stale = self._transcript("stale.jsonl", [
            _user("please deploy this too"),
            _assistant_text(long_sentence),
            _assistant_tool("Bash"),
        ], age_secs=unblock_prompts.MIN_WAIT_SECS + 60)

        store_root = self.root / "inst2" / "claude-code-sessions"
        store = {"instance": "inst2", "root": store_root, "isRunning": True}
        meta_fresh = {"cliSessionId": sid_fresh, "title": "born by toolbox",
                     "permissionMode": "acceptEdits", "isArchived": False}
        meta_stale = {"cliSessionId": sid_stale, "title": "promise expired",
                     "permissionMode": "acceptEdits", "isArchived": False}

        now_ms = int(time.time() * 1000)
        # ledgerlib.note() refuses kind "spawned" - it is not in VALID_KINDS (a real production
        # bug, see report) - so the fixture writes the ledger row directly via _save() rather
        # than through note(), which is exactly what a fixed spawn_chat.py would have produced.
        ledgerlib._save([
            {"kind": "spawned", "session": sid_fresh, "at": now_ms - 3600_000,
             "deterministic": False, "note": "spawn_chat: fresh"},
            {"kind": "spawned", "session": sid_stale, "at": now_ms - 2 * 24 * 3600_000,
             "deterministic": False, "note": "spawn_chat: stale"},
        ])

        with mock.patch.object(hydralib, "fleet", return_value={}), \
             mock.patch.object(hydralib, "api_get",
                               return_value={"sessions": [{"sessionId": sid_fresh},
                                                          {"sessionId": sid_stale}]}), \
             mock.patch.object(stamplib, "store_roots", return_value=[store]), \
             mock.patch.object(stamplib, "iter_metas",
                               return_value=[(store_root / "a" / "b" / "local_3.json", meta_fresh),
                                            (store_root / "a" / "b" / "local_4.json", meta_stale)]), \
             mock.patch.object(stamplib, "transcript_index",
                               return_value={sid_fresh: t_fresh, sid_stale: t_stale}):
            rows = unblock_prompts.find_stuck()

        by_sid = {r["sessionId"]: r for r in rows}
        self.assertEqual(set(by_sid), {sid_fresh, sid_stale})

        row_fresh = by_sid[sid_fresh]
        self.assertTrue(row_fresh["spawnedByToolbox"])
        self.assertTrue(row_fresh["eligible"])
        self.assertIn("bypass promised", row_fresh["why"])

        row_stale = by_sid[sid_stale]
        self.assertFalse(row_stale["spawnedByToolbox"])
        self.assertFalse(row_stale["eligible"])
        self.assertEqual(row_stale["why"], "")


class PressTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _run_result(self, returncode=0):
        return types.SimpleNamespace(returncode=returncode, stdout="ok", stderr="")

    def test_press_passes_instance_and_verify_to_the_actuator(self):
        row = {"title": "chat one", "instance": "inst1", "instanceDir": "C:/x/inst1",
              "verify": "Deploying the artifact now, hold on.", "quietMins": 5.0}
        with mock.patch.object(unblock_prompts.clilib, "run_text",
                               return_value=self._run_result()) as run_mock:
            got = unblock_prompts.press(row)
        args = run_mock.call_args.args[0]
        self.assertIn("-Instance", args)
        self.assertEqual(args[args.index("-Instance") + 1], "C:/x/inst1")
        self.assertIn("-VerifyText", args)
        self.assertEqual(args[args.index("-VerifyText") + 1], row["verify"])
        self.assertTrue(got["ok"])

    def test_press_omits_verifytext_when_verify_is_empty(self):
        row = {"title": "chat two", "instance": "inst2", "instanceDir": "C:/x/inst2",
              "verify": "", "quietMins": 5.0}
        with mock.patch.object(unblock_prompts.clilib, "run_text",
                               return_value=self._run_result()) as run_mock:
            unblock_prompts.press(row)
        args = run_mock.call_args.args[0]
        self.assertIn("-Instance", args)
        self.assertNotIn("-VerifyText", args)


class ReportWhyTest(unittest.TestCase):
    """The 'why not eligible' line (bug found on review, 2026-09-01): its app IS running and
    its mode IS bypassPermissions, but the verify-snippet check failed - the old code fell
    through every other branch to "its app is not running", which is simply false. The report
    must read the already-computed ineligibleWhy first."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_a_failed_verify_snippet_is_reported_as_such_not_as_app_not_running(self):
        row = {"sessionId": "s1", "instance": "inst1", "title": "chat one",
               "quietMins": 5.0, "eligible": False, "held": False,
               "mode": stamplib.BYPASS, "appRunning": True, "verify": "",
               "ineligibleWhy": "no distinctive last words to prove the pane - never pressed blind"}
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[row]):
            code, out, _ = run_cli(unblock_prompts.main, [])
        self.assertIn("no distinctive last words", out)
        self.assertNotIn("its app is not running", out)


class MainGateTest(unittest.TestCase):
    """THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not press a prompt unless
    a person opened a window (`python orch.py arm`) or passed --force."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _stuck_row(self):
        return {"sessionId": "s1", "instance": "inst1", "title": "chat one",
                "quietMins": 5.0, "eligible": True, "held": False,
                "mode": stamplib.BYPASS, "verify": "hi", "instanceDir": "C:/x",
                # tri-state verdict fields (approvallib.classify) - a plain "git status" so
                # this fixture keeps testing the ARMED WINDOW gate, not the verdict split
                # (that has its own tests, see test_approvallib.py / test_unblock_tristate.py).
                "verdict": "approve", "verdictReason": "read-only git inspection",
                "toolName": "Bash", "command": "git status"}

    def test_yes_without_an_armed_window_refuses_and_presses_nothing(self):
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[self._stuck_row()]), \
             mock.patch.object(unblock_prompts, "press") as m:
            code, out, _ = run_cli(unblock_prompts.main, ["--yes"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)

    def test_yes_with_an_armed_window_presses_as_before(self):
        armlib.arm(3600)
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[self._stuck_row()]), \
             mock.patch.object(unblock_prompts, "press",
                               return_value={"ok": True, "instance": "inst1", "title": "chat one",
                                             "quietMins": 5.0, "outcome": "pressed"}) as m:
            code, out, _ = run_cli(unblock_prompts.main, ["--yes"])
        m.assert_called_once()
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)


if __name__ == "__main__":
    unittest.main()
