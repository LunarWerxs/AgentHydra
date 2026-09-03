"""The live soak of 2026-09-01 (icon up, every lane ticking) found four things the tests had
not: the groundskeeper shuffled the same stopped chats between accounts pass after pass;
evacuations kept landing (and booting engines) with 29 processes alive against the cap of
18; nothing ever brought that count down; and the aim rail refused a slash-command chat on
its raw prompt. These pin the fixes: a rebalance cooldown, a landing that defers at the cap,
the idle-engine reaper, and pane-rendered verify words."""

import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import groundskeeper  # noqa: E402
import overlord  # noqa: E402
from lib import enginelib  # noqa: E402
from lib import gatelib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402


class RebalanceCooldownTest(unittest.TestCase):
    def test_a_chat_migrated_inside_the_window_is_not_moved_again(self):
        now = int(time.time() * 1000)
        rows = [{"kind": "migrate", "session": "s1", "at": now - 3600 * 1000}]
        self.assertTrue(groundskeeper._moved_recently("s1", rows, now))

    def test_an_old_move_or_another_kind_does_not_count(self):
        now = int(time.time() * 1000)
        rows = [{"kind": "migrate", "session": "s1",
                 "at": now - (groundskeeper.REBALANCE_COOLDOWN_SECS + 60) * 1000},
                {"kind": "deliver", "session": "s2", "at": now - 1000}]
        self.assertFalse(groundskeeper._moved_recently("s1", rows, now))
        self.assertFalse(groundskeeper._moved_recently("s2", rows, now))


class LandingAtTheCapTest(unittest.TestCase):
    def test_an_evacuation_is_deferred_when_the_machine_is_at_its_cap(self):
        plan = {"evacuate": [{"sessionId": "s1", "title": "T", "to": "work", "toIsOpen": True}],
                "archive": []}
        with mock.patch.object(hydralib, "running_count", return_value=hydralib.MAX_RUNNING_CHATS), \
             mock.patch.object(groundskeeper.clilib, "capture") as cap:
            got = groundskeeper.execute(plan, do_reap=False)
        cap.assert_not_called()
        self.assertEqual(len(got), 1)
        self.assertIn("running cap", got[0]["outcome"])
        self.assertTrue(got[0]["ok"])

    def test_an_evacuation_runs_when_there_is_room(self):
        plan = {"evacuate": [{"sessionId": "s1", "title": "T", "to": "work", "toIsOpen": True}],
                "archive": []}
        with mock.patch.object(hydralib, "running_count", return_value=3), \
             mock.patch.object(groundskeeper.clilib, "capture", return_value=(0, "landed")) as cap:
            got = groundskeeper.execute(plan, do_reap=False)
        cap.assert_called_once()
        self.assertEqual(got[0]["outcome"], "moved to work")


class ReaperTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.addCleanup(self._state.cleanup)

    def _live(self, n):
        return {"count": n, "sessions": [{"sessionId": f"s{i}", "pid": 100 + i} for i in range(n)]}

    def test_nothing_is_reaped_under_the_cap(self):
        with mock.patch.object(hydralib, "_live_endpoint", return_value=self._live(hydralib.MAX_RUNNING_CHATS)), \
             mock.patch.object(hydralib, "sessions", return_value=[]), \
             mock.patch.object(enginelib, "stop_idle_engine") as stop:
            got = groundskeeper.reap_idle_engines()
        self.assertEqual(got, [])
        stop.assert_not_called()

    def test_the_longest_idle_engines_are_stopped_until_the_count_is_at_the_cap(self):
        n = hydralib.MAX_RUNNING_CHATS + 2
        quiet = {f"s{i}": (i + 1) * 100 for i in range(n)}  # s{n-1} is the longest idle

        def verdict(match, min_quiet):
            q = quiet[match["cliSessionId"]]
            return (q >= min_quiet, f"idle: finished its turn and quiet {q}s")

        stopped = []
        with mock.patch.object(hydralib, "_live_endpoint", return_value=self._live(n)), \
             mock.patch.object(hydralib, "sessions", return_value=[]), \
             mock.patch.object(overlord, "protected_session_ids", return_value=set()), \
             mock.patch.object(enginelib, "idle_verdict", side_effect=verdict), \
             mock.patch.object(enginelib, "stop_idle_engine",
                               side_effect=lambda m, s: (stopped.append(m["cliSessionId"]) or
                                                         {"stopped": True, "pid": 1, "why": "idle"})):
            got = groundskeeper.reap_idle_engines()
        self.assertEqual(len(got), 2)
        self.assertEqual(stopped, [f"s{n - 1}", f"s{n - 2}"])
        self.assertTrue(all(r["ok"] for r in got))

    def test_the_manager_and_held_chats_are_never_reaped(self):
        n = hydralib.MAX_RUNNING_CHATS + 1
        holdlib.hold("s0", "mine")
        with mock.patch.object(hydralib, "_live_endpoint", return_value=self._live(n)), \
             mock.patch.object(hydralib, "sessions", return_value=[]), \
             mock.patch.object(overlord, "protected_session_ids", return_value={f"s{i}" for i in range(1, n)}), \
             mock.patch.object(enginelib, "idle_verdict", return_value=(True, "idle: quiet 9999s")), \
             mock.patch.object(enginelib, "stop_idle_engine") as stop:
            got = groundskeeper.reap_idle_engines()
        stop.assert_not_called()
        self.assertEqual(got, [])

    def test_a_working_engine_is_never_reaped(self):
        n = hydralib.MAX_RUNNING_CHATS + 1
        with mock.patch.object(hydralib, "_live_endpoint", return_value=self._live(n)), \
             mock.patch.object(hydralib, "sessions", return_value=[]), \
             mock.patch.object(overlord, "protected_session_ids", return_value=set()), \
             mock.patch.object(enginelib, "idle_verdict", return_value=(False, "may be working")), \
             mock.patch.object(enginelib, "stop_idle_engine") as stop:
            got = groundskeeper.reap_idle_engines()
        stop.assert_not_called()
        self.assertEqual(got, [])


class ReportPrinterTest(unittest.TestCase):
    """The 20:35 tick on 2026-09-01 reaped 11 engines and then died printing the report -
    a reap row lacked 'why'. The printer must never take down a report of acts already done."""

    def test_main_prints_reap_rows_and_rows_missing_fields(self):
        import io
        import contextlib
        from lib import armlib

        state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = state.name
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.addCleanup(state.cleanup)
        armlib.arm(600)
        plan = {"running": 20, "perAccountShare": 4, "runningPerInstance": {"work": 20},
                "evacuate": [], "archive": [], "stale": [],
                "stuck": [], "activeOnBurnt": [], "errored": [], "strandedLeftBehind": 0,
                "perInstance": {}, "accounts": []}
        results = [{"duty": "reap", "sessionId": "s9", "title": "Idle one", "instance": "work",
                    "from": "work", "to": None, "why": "over the running cap by 2: idle 900s",
                    "exit": 0, "ok": True, "outcome": "stopped idle engine pid 1"},
                   {"duty": "archive", "title": "No why here", "instance": "p2",
                    "exit": 0, "ok": True, "outcome": "archived"}]
        buf = io.StringIO()
        with mock.patch.object(groundskeeper, "build_plan", return_value=plan), \
             mock.patch.object(groundskeeper, "execute", return_value=results), \
             contextlib.redirect_stdout(buf):
            code = groundskeeper.main(["--yes"])
        out = buf.getvalue()
        self.assertEqual(code, 0, out)
        self.assertIn("[reap] Idle one (work): over the running cap by 2", out)
        self.assertIn("[archive] No why here", out)


class PaneWordsAndTimestampsTest(unittest.TestCase):
    def test_pane_words_strips_a_slash_command_to_its_arguments(self):
        self.assertEqual(gatelib.pane_words("/orchestrate standing manager chat"), "standing manager chat")
        self.assertEqual(gatelib.pane_words("plain words"), "plain words")
        self.assertEqual(gatelib.pane_words("/compact"), "/compact")

    def test_ms_of_reads_the_dossiers_iso_timestamp(self):
        self.assertEqual(overlord._ms_of("1970-01-01T00:00:01Z"), 1000)
        self.assertEqual(overlord._ms_of(None), 0)
        self.assertEqual(overlord._ms_of("not a date"), 0)


if __name__ == "__main__":
    unittest.main()
