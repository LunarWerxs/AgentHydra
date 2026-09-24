"""unblock_prompts TARGETING: --session narrows the scan to named chats, --min-wait moves the
quiet gate, and the argv contract that makes a VERSION SKEW loud instead of fleet-wide.

The last one is the reason this file exists rather than a couple of extra cases elsewhere. The
script reads argv by lookup, so a copy that predates --session IGNORES it; with --yes attached
that turns "clear the chat I named" into "press every stuck prompt in the fleet". Two things
prevent it and both are pinned here: an unknown flag is a refusal (exit 3), and --json names
the flags the build understands (`supports`) so a caller can refuse before acting.
"""

import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import unblock_prompts  # noqa: E402
from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import stamplib  # noqa: E402

from util import run_cli  # noqa: E402

LONG_SENTENCE = (
    "I have finished reviewing the configuration and am now deploying the artifact to the "
    "staging cluster, please hold on while this completes."
)


def _row(sid, **extra):
    base = {"sessionId": sid, "instance": "inst1", "title": f"chat {sid}",
            "quietMins": 5.0, "eligible": True, "held": False, "verify": "hi",
            "instanceDir": "C:/x", "mode": stamplib.BYPASS, "toolName": "Bash",
            "command": "ls -la", "verdict": "approve", "verdictReason": "read-only"}
    base.update(extra)
    return base


class ArgvContractTest(unittest.TestCase):
    """The three argv readers, alone."""

    def test_sessions_parse_from_repeats_and_comma_lists_and_dedupe(self):
        self.assertEqual(unblock_prompts._requested_sessions([]), [])
        self.assertEqual(
            unblock_prompts._requested_sessions(["--session", "a", "--session", "b"]), ["a", "b"])
        self.assertEqual(unblock_prompts._requested_sessions(["--session", "a, b ,c"]),
                         ["a", "b", "c"])
        self.assertEqual(
            unblock_prompts._requested_sessions(["--session", "a", "--session", "a"]), ["a"])

    def test_a_trailing_session_flag_with_no_value_is_not_a_crash(self):
        self.assertEqual(unblock_prompts._requested_sessions(["--session"]), [])

    def test_min_wait_defaults_to_zero_when_targeted_and_to_the_sweep_floor_otherwise(self):
        self.assertEqual(unblock_prompts._resolve_min_wait([], False),
                         (float(unblock_prompts.MIN_WAIT_SECS), None))
        self.assertEqual(unblock_prompts._resolve_min_wait([], True), (0.0, None))

    def test_an_explicit_min_wait_wins_over_either_default(self):
        for targeted in (True, False):
            self.assertEqual(unblock_prompts._resolve_min_wait(["--min-wait", "90"], targeted),
                             (90.0, None))

    def test_a_bad_min_wait_is_an_error_not_a_silent_zero(self):
        for bad in ("soon", "-5"):
            _, err = unblock_prompts._resolve_min_wait(["--min-wait", bad], True)
            self.assertTrue(err, bad)

    def test_a_known_flags_value_is_never_reported_as_unknown(self):
        argv = ["--json", "--yes", "--force", "--max", "3", "--session", "a", "--min-wait", "0"]
        self.assertEqual(unblock_prompts._unknown_args(argv), [])

    def test_an_unrecognised_word_is_reported(self):
        self.assertEqual(unblock_prompts._unknown_args(["--sesion", "abc"]), ["--sesion", "abc"])


class MainTargetingTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)  # armed, so --yes acts

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def test_an_unknown_flag_refuses_before_anything_is_scanned_or_pressed(self):
        # THE WHOLE POINT: a typo of the flag that NARROWS must never fall through to a
        # fleet-wide press. Nothing is scanned either - find_stuck is not even called.
        with mock.patch.object(unblock_prompts, "find_stuck") as scan, \
             mock.patch.object(unblock_prompts, "press") as pressed:
            code, _, err = run_cli(unblock_prompts.main, ["--sesion", "abc", "--yes"])
        self.assertEqual(code, 3)
        scan.assert_not_called()
        pressed.assert_not_called()
        self.assertIn("--sesion", err)

    def test_named_sessions_reach_find_stuck_as_a_filter_with_a_zero_wait(self):
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[]) as scan:
            run_cli(unblock_prompts.main, ["--session", "a", "--session", "b", "--json"])
        self.assertEqual(scan.call_args.kwargs["only"], {"a", "b"})
        self.assertEqual(scan.call_args.kwargs["min_wait_secs"], 0.0)

    def test_a_sweep_passes_no_filter_and_keeps_the_quiet_floor(self):
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[]) as scan:
            run_cli(unblock_prompts.main, ["--json"])
        self.assertIsNone(scan.call_args.kwargs["only"])
        self.assertEqual(scan.call_args.kwargs["min_wait_secs"],
                         float(unblock_prompts.MIN_WAIT_SECS))

    def test_the_json_payload_names_the_flags_this_build_understands(self):
        # A caller reads this to tell "narrowed to my chat" from "an older copy swept the fleet".
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[]):
            _, out, _ = run_cli(unblock_prompts.main, ["--session", "a", "--json"])
        import json as _json
        payload = _json.loads(out)
        self.assertIn("session", payload["supports"])
        self.assertIn("min-wait", payload["supports"])
        self.assertEqual(payload["requested"], ["a"])

    def test_a_named_chat_that_is_not_stuck_is_named_not_silently_absent(self):
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[_row("a")]):
            _, out, _ = run_cli(unblock_prompts.main, ["--session", "a", "--session", "ghost",
                                                       "--json"])
        import json as _json
        payload = _json.loads(out)
        self.assertEqual([r["sessionId"] for r in payload["notFound"]], ["ghost"])

    def test_the_text_report_says_so_too_even_when_nothing_at_all_was_stuck(self):
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=[]):
            _, out, _ = run_cli(unblock_prompts.main, ["--session", "ghost"])
        self.assertIn("ghost", out)

    def test_naming_a_chat_is_not_consent_an_ineligible_row_is_still_not_pressed(self):
        # --session says WHICH chat, never "press it regardless": the structural rails survive.
        rows = [_row("a", eligible=False, mode="default",
                     ineligibleWhy="", held=False)]
        with mock.patch.object(unblock_prompts, "find_stuck", return_value=rows), \
             mock.patch.object(unblock_prompts, "press") as pressed:
            run_cli(unblock_prompts.main, ["--session", "a", "--yes"])
        pressed.assert_not_called()


class FindStuckFilterTest(unittest.TestCase):
    """`only` really narrows the scan, and `min_wait_secs` really moves the gate - proven over
    the same store/transcript fixture the sweep is proven over, not over a mocked find_stuck."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.root = Path(self._tmp.name)

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()
        self._tmp.cleanup()

    def _fixture(self, age_secs):
        """Two live, bypass-stamped chats, both sitting on an unanswered tool call."""
        import json as _json
        events = [{"type": "user", "message": {"content": "please deploy this"}},
                  {"type": "assistant",
                   "message": {"content": [{"type": "text", "text": LONG_SENTENCE}]}},
                  {"type": "assistant",
                   "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}}]
        paths = {}
        for sid in ("sid-one", "sid-two"):
            p = self.root / f"{sid}.jsonl"
            p.write_text("\n".join(_json.dumps(e) for e in events) + "\n", encoding="utf-8")
            old = time.time() - age_secs
            os.utime(p, (old, old))
            paths[sid] = p
        store_root = self.root / "inst1" / "claude-code-sessions"
        store = {"instance": "inst1", "root": store_root, "isRunning": True}
        metas = [(store_root / "a" / f"local_{sid}.json",
                  {"cliSessionId": sid, "title": f"chat {sid}",
                   "permissionMode": stamplib.BYPASS, "isArchived": False})
                 for sid in paths]
        return paths, store, metas

    def _scan(self, paths, store, metas, **kwargs):
        live = {"sessions": [{"sessionId": sid} for sid in paths]}
        with mock.patch.object(hydralib, "fleet", return_value={}), \
             mock.patch.object(hydralib, "api_get", return_value=live), \
             mock.patch.object(stamplib, "store_roots", return_value=[store]), \
             mock.patch.object(stamplib, "iter_metas", return_value=metas), \
             mock.patch.object(stamplib, "transcript_index", return_value=paths):
            return unblock_prompts.find_stuck(**kwargs)

    def test_only_narrows_to_the_named_chat(self):
        paths, store, metas = self._fixture(unblock_prompts.MIN_WAIT_SECS + 60)
        rows = self._scan(paths, store, metas)
        self.assertEqual({r["sessionId"] for r in rows}, {"sid-one", "sid-two"})

        rows = self._scan(paths, store, metas, only={"sid-two"})
        self.assertEqual([r["sessionId"] for r in rows], ["sid-two"])

    def test_a_fresh_stall_is_invisible_to_the_sweep_and_visible_with_a_zero_wait(self):
        # The gap that made "clear this stall NOW" unusable: a chat stuck 30 seconds ago is
        # below MIN_WAIT_SECS, so the sweep reports nothing at all.
        paths, store, metas = self._fixture(30)
        self.assertEqual(self._scan(paths, store, metas), [])
        rows = self._scan(paths, store, metas, only={"sid-one"}, min_wait_secs=0)
        self.assertEqual([r["sessionId"] for r in rows], ["sid-one"])


if __name__ == "__main__":
    unittest.main()
