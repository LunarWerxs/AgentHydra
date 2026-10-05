"""Permission restoration cards: parallel transcript calls, policy, identity and stale plans.

No live app is driven. The PowerShell matcher is extracted from the shipped actuator.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import approvallib, holdlib, stamplib
import unblock_prompts as unblock


TOOL = approvallib.PERMISSION_MODE_TOOL


def call(identity, target="local_destination", mode="bypassPermissions", **extra):
    return {"type": "tool_use", "id": identity, "name": TOOL,
            "input": {"session_id": target, "mode": mode, **extra}}


def assistant(*blocks):
    return {"type": "assistant", "message": {"content": list(blocks)}}


def result(identity):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": identity, "content": "done"}]}}


class PermissionModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"ORCHESTRATOR_STATE_DIR": str(self.root / "state")})
        self.env.start()
        self.transcript = self.root / "caller.jsonl"
        self.profile = self.root / "profile"
        self.store = self.profile / "claude-code-sessions"
        self.caller_path = self.store / "org" / "project" / "local_caller.json"
        self.target_path = self.caller_path.with_name("local_destination.json")
        self.caller = {"cliSessionId": "caller", "title": "Manager", "permissionMode": stamplib.BYPASS}
        self.target = {"cliSessionId": "destination", "title": "Destination", "permissionMode": stamplib.BYPASS}
        self.metas = [(self.caller_path, self.caller), (self.target_path, self.target)]
        self.write(assistant(call("first")))

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def write(self, *events):
        self.transcript.write_text("\n".join(map(json.dumps, events)) + "\n", encoding="utf-8")

    def targets(self):
        return unblock._permission_targets(self.metas, self.caller_path)

    def classify(self, *calls, targets=None, policy=None):
        return approvallib.classify_pending({"tool_inputs": list(calls)},
                                            self.targets() if targets is None else targets, policy)

    def test_parallel_call_remains_pending_after_sibling_result_and_progress(self):
        self.write(assistant(call("first")), assistant(call("second")), result("second"),
                   {"type": "progress", "data": {"type": "waiting"}})
        pending = unblock._pending_record(self.transcript)
        self.assertEqual([c["id"] for c in pending["tool_inputs"]], ["first"])

    def test_all_siblings_resolved_means_no_pending_card(self):
        self.write(assistant(call("first"), call("second")), result("first"), result("second"))
        self.assertIsNone(unblock._pending_record(self.transcript))

    def test_a_new_user_turn_or_completed_turn_discards_old_pending_calls(self):
        for boundary in ({"type": "user", "message": {"content": "Stop that work"}},
                         {"type": "result", "result": "finished"}):
            with self.subTest(boundary=boundary):
                self.write(assistant(call("first")), boundary)
                self.assertIsNone(unblock._pending_record(self.transcript))

    def test_verified_restoration_approves_without_generic_allow_pattern(self):
        verdict, _, key = self.classify(call("first"), policy={"approve": [], "deny": []})
        self.assertEqual((verdict, key), (approvallib.APPROVE, "restore_permission_mode"))

    def test_unknown_target_other_modes_or_extra_arguments_require_a_decision(self):
        for candidate in (call("first", target="local_unknown"), call("first", mode="auto"),
                          call("first", command="git status")):
            with self.subTest(candidate=candidate):
                self.assertEqual(self.classify(candidate)[0], approvallib.ESCALATE)

    def test_deny_policy_wins_over_permission_restoration(self):
        policy = {"approve": [], "deny": [{"key": "operator", "patterns": [TOOL]}]}
        self.assertEqual(self.classify(call("first"), policy=policy)[0], approvallib.DENY)

    def test_one_approved_call_cannot_place_an_unknown_or_dangerous_sibling(self):
        for command, expected in (("npm install mystery", approvallib.ESCALATE),
                                  ("rm -rf /data", approvallib.DENY)):
            sibling = {"name": "Bash", "input": {"command": command}}
            self.assertEqual(self.classify(call("first"), sibling)[0], expected)

    def test_unknown_call_cannot_borrow_a_read_only_siblings_verdict(self):
        calls = [{"name": "Bash", "input": {"command": text}}
                 for text in ("git status", "npm install mystery")]
        self.assertEqual(self.classify(*calls)[0], approvallib.ESCALATE)

    def test_a_target_from_a_different_login_is_not_approved(self):
        foreign = self.store / "other-org" / "project" / "local_foreign.json"
        self.metas.append((foreign, {**self.target, "title": "Foreign"}))
        self.assertNotIn("local_foreign", self.targets())

    def test_stricter_archived_held_and_ambiguous_targets_are_not_restorations(self):
        self.target["permissionMode"] = "acceptEdits"
        self.assertNotIn("local_destination", self.targets())
        self.target["permissionMode"] = stamplib.BYPASS
        self.target["isArchived"] = True
        self.assertNotIn("local_destination", self.targets())
        self.target["isArchived"] = False
        with mock.patch.object(holdlib, "why_blocked", return_value="held"):
            self.assertEqual(self.targets(), {})
        self.metas.append((self.target_path.with_name("local_other.json"), dict(self.target)))
        self.assertNotIn("local_destination", self.targets())

    def scan(self):
        with mock.patch.object(unblock.hydralib, "fleet", return_value={}), \
             mock.patch.object(unblock.hydralib, "api_get", return_value={"sessions": [{"sessionId": "caller"}]}), \
             mock.patch.object(stamplib, "store_roots", return_value=[{
                 "root": self.store, "instance": "profile", "isRunning": True}]), \
             mock.patch.object(stamplib, "iter_metas", return_value=iter(self.metas)), \
             mock.patch.object(stamplib, "transcript_index", return_value={"caller": self.transcript}), \
             mock.patch.object(unblock.deliverylib, "_verify_snippet", return_value="The manager's own words prove its pane"):
            return unblock.find_stuck(only={"caller"}, min_wait_secs=0)[0]

    def test_scan_connects_structured_policy_to_the_exact_pending_card(self):
        row = self.scan()
        self.assertTrue(row["eligible"])
        self.assertEqual(row["verdict"], approvallib.APPROVE)
        self.assertTrue(row["permissionPrompt"]["complete"])
        self.assertEqual(row["permissionPrompt"]["targets"], [{
            "sessionId": "local_destination", "title": "Destination", "isSelf": False}])

    def test_no_wait_floor_finds_a_transcript_stamped_just_after_the_scan_clock(self):
        # Windows can stamp a fresh write a little after time.time(); a 0 floor must still see it.
        ahead = unblock.time.time() + 0.5
        os.utime(self.transcript, (ahead, ahead))
        self.assertEqual(self.scan()["sessionId"], "caller")

    def test_changed_transcript_or_target_prevents_an_actuator_call(self):
        row = self.scan()
        self.write(assistant(call("replacement")))
        with mock.patch.object(stamplib, "iter_metas", side_effect=lambda _: iter(self.metas)), \
             mock.patch.object(unblock.windowlib, "instance_lock") as lock, \
             mock.patch.object(unblock.clilib, "run_text") as run:
            lock.return_value.__enter__.return_value = True
            self.assertFalse(unblock.press(row)["ok"])
            run.assert_not_called()
            self.write(assistant(call("first")))
            self.target["permissionMode"] = "acceptEdits"
            self.assertFalse(unblock.press(row)["ok"])
            run.assert_not_called()

    def test_valid_press_uses_only_allow_once_and_passes_card_identity(self):
        row = self.scan()
        with mock.patch.object(stamplib, "iter_metas", return_value=iter(self.metas)), \
             mock.patch.object(unblock.windowlib, "instance_lock") as lock, \
             mock.patch.object(unblock.clilib, "run_text", return_value=mock.Mock(
                 returncode=0, stdout="APPROVED Allow once", stderr="")) as run:
            lock.return_value.__enter__.return_value = True
            self.assertTrue(unblock.press(row)["ok"])
            args = run.call_args.args[0]
            self.assertIn("-OnceOnly", args)
            self.assertEqual(json.loads(args[args.index("-PermissionTargetsJson") + 1]),
                             row["permissionPrompt"]["targets"])

    def test_escalation_round_trip_preserves_the_card_guard(self):
        prompt = self.scan()["permissionPrompt"]
        approvallib.queue_escalation("caller", title="Manager", instance="profile",
                                    instance_dir=str(self.profile), verify="words", command="mode",
                                    tool_name=TOOL, reason="review", permission_prompt=prompt)
        self.assertEqual(approvallib.get_escalation("caller")["permissionPrompt"], prompt)

    def test_explicit_decision_can_approve_a_new_increase_but_never_an_operator_deny(self):
        self.target["permissionMode"] = "acceptEdits"
        row = self.scan()
        self.assertEqual(row["verdict"], approvallib.ESCALATE)
        with mock.patch.object(stamplib, "iter_metas", side_effect=lambda _: iter(self.metas)), \
             mock.patch.object(unblock.windowlib, "instance_lock") as lock, \
             mock.patch.object(unblock.clilib, "run_text", return_value=mock.Mock(
                 returncode=0, stdout="APPROVED Allow once", stderr="")) as run:
            lock.return_value.__enter__.return_value = True
            self.assertFalse(unblock.press(row)["ok"])
            run.assert_not_called()
            self.assertTrue(unblock.press({**row, "permissionChangeApproved": True})["ok"])
            run.reset_mock()
            policy = {"approve": [], "deny": [{"key": "operator", "patterns": [TOOL]}]}
            with mock.patch.object(approvallib, "load_policy", return_value=policy):
                self.assertFalse(unblock.press({**row, "permissionChangeApproved": True})["ok"])
                run.assert_not_called()


# floor-ok: these run the shipped PowerShell matcher, so they need pwsh; CI's orchestrator job runs
# on windows-latest, which has it, so CI always runs them.
@unittest.skipUnless(shutil.which("pwsh"), "PowerShell required")
class CardMatcherTest(unittest.TestCase):
    def test_actual_matcher_accepts_only_the_right_target_and_mode(self):
        source = unblock.ACTUATOR.read_text(encoding="utf-8")
        region = source.split("# >>> PERMISSION-CARD MATCH REGION >>>", 1)[1].split(
            "# <<< PERMISSION-CARD MATCH REGION <<<", 1)[0]
        target = {"sessionId": "local_destination", "title": "Destination", "isSelf": False}
        sentence = "This one switches a session from Accept edits (acceptEdits) to Bypass permissions (bypassPermissions) mode."
        cases = [
            ([sentence, "Destination", "Allow once"], target, True),
            ([sentence, "Other chat", "Allow once"], target, False),
            ([sentence, "Destination copy", "Allow once"], target, False),
            (["Run git status", "Destination", "Allow once"], target, False),
            ([sentence.replace("Bypass permissions (bypassPermissions)", "Auto (auto)"), "Destination"], target, False),
            ([sentence.replace("a session", "this session")], {**target, "isSelf": True}, True),
            ([sentence.replace("a session", "this session")], target, False),
            ([sentence, "local_destination"], {**target, "title": ""}, True),
            ([sentence, "local_other"], {**target, "title": ""}, False),
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "cases.json").write_text(json.dumps(cases), encoding="utf-8")
            (root / "check.ps1").write_text(
                "param($CasesPath)\n$ErrorActionPreference='Stop'\n" + region +
                "\nforeach ($c in (Get-Content -Raw -LiteralPath $CasesPath | ConvertFrom-Json)) {\n"
                "  $got = Test-PermissionModeCard $c[0] @($c[1])\n"
                "  if ($got -ne $c[2]) { throw ('wrong match: ' + ($c | ConvertTo-Json -Compress)) }\n}\n",
                encoding="utf-8-sig")
            result = subprocess.run(["pwsh", "-NoProfile", "-File", str(root / "check.ps1"),
                                     str(root / "cases.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # The walk up from an Allow once button stops at the first ancestor carrying a mode sentence.
    # Before 2026-10-04 it climbed on to any of 12 ancestors, so a card naming an unverified chat
    # matched once an ancestor also held an earlier card's chip for the verified one (review of the
    # port onto main).
    def test_card_is_the_first_ancestor_with_a_sentence_and_never_borrows_outer_text(self):
        source = unblock.ACTUATOR.read_text(encoding="utf-8")
        region = source.split("# >>> PERMISSION-CARD MATCH REGION >>>", 1)[1].split(
            "# <<< PERMISSION-CARD MATCH REGION <<<", 1)[0]
        target = {"sessionId": "local_destination", "title": "Destination", "isSelf": False}
        sentence = "This one switches a session to Bypass permissions (bypassPermissions) mode."
        cases = [
            (["Allow once", "Deny"], 1, target, "climb"),
            ([sentence, "Destination", "Allow once"], 1, target, "match"),
            ([sentence, "Other", "Allow once"], 1, target, "reject"),
            ([sentence, "Destination", sentence, "Other", "Allow once"], 1, target, "reject"),
            ([sentence, "Destination", "Allow once", "Allow once"], 2, target, "reject"),
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "cases.json").write_text(json.dumps(cases), encoding="utf-8")
            (root / "check.ps1").write_text(
                "param($CasesPath)\n$ErrorActionPreference='Stop'\n" + region +
                "\nforeach ($c in (Get-Content -Raw -LiteralPath $CasesPath | ConvertFrom-Json)) {\n"
                "  $got = Get-PermissionCardLevel $c[0] $c[1] @($c[2])\n"
                "  if ($got -cne $c[3]) { throw ('wrong level ' + $got + ': ' + ($c | ConvertTo-Json -Compress)) }\n}\n",
                encoding="utf-8-sig")
            result = subprocess.run(["pwsh", "-NoProfile", "-File", str(root / "check.ps1"),
                                     str(root / "cases.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
