"""orch.py arm / disarm / armed - THE switch is the tray icon (owner order, 2026-09-01: "it
can't be running without the status bar icon, so I can terminate it if I want"). `arm` starts
the icon and waits for its heartbeat; `disarm` kills it and pauses the eyes; `armed` reads the
beat. The icon, taskkill and schedule_jobs are all mocked: these tests never touch the real
tray, the real tasks, or any process."""

import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # orch.py lives at the repo root
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import orch  # noqa: E402
import schedule_jobs  # noqa: E402
from lib import armlib  # noqa: E402
from util import run_cli  # noqa: E402


class OrchArmTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.calls: list[list[str]] = []
        self.killed: list[list[str]] = []
        self.launched: list[list[str]] = []
        self._patches = [
            mock.patch.object(schedule_jobs, "main",
                              side_effect=lambda argv: self.calls.append(argv) or 0),
            mock.patch.object(orch.subprocess, "run",
                              side_effect=lambda argv, **kw: self.killed.append(argv) or
                              mock.MagicMock(returncode=0)),
            mock.patch.object(orch, "ARM_WAIT_SECS", 2),
            # the beat's pid is checked against the OS: our own pid is alive, 1 is not ours
            mock.patch.object(armlib, "_pid_alive", side_effect=lambda pid: int(pid) == os.getpid()),
            # the task registry: every lane registered unless a test says otherwise
            mock.patch.object(schedule_jobs, "registered", side_effect=lambda: {
                n: {} for job, spec in schedule_jobs.JOBS.items() for n in schedule_jobs.task_names(job, spec)}),
            mock.patch.object(schedule_jobs, "apply_jobs",
                              side_effect=lambda jobs: self.applied.append(sorted(jobs)) or
                              [{"ok": True, "task": j} for j in jobs]),
        ]
        self.applied: list[list[str]] = []
        for p in self._patches:
            p.start()

    def test_arm_registers_lanes_that_are_missing_on_this_machine(self):
        # owner, 2026-09-02: "/orchestrate should spin up the orchestrator service, so I
        # don't have to find the script" - arm is the whole start, lanes included.
        with mock.patch.object(schedule_jobs, "registered", return_value={}), self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 0)
        self.assertEqual(self.applied, [sorted(schedule_jobs.JOBS)])
        self.assertIn("registered", out)
        self.assertIn("ARMED", out)

    def test_arm_registers_nothing_when_every_lane_exists(self):
        with self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 0)
        self.assertEqual(self.applied, [])

    def tearDown(self):
        for p in self._patches:
            p.stop()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _fake_tray(self, beats: bool):
        # A stand-in for `powershell -File tray.ps1`: records the launch and, when told to,
        # writes the heartbeat the real icon would.
        def popen(argv, **kw):
            self.launched.append(argv)
            if beats:
                armlib.write_heartbeat(os.getpid())
            return mock.MagicMock()
        return mock.patch.object(orch.subprocess, "Popen", side_effect=popen)

    def test_the_default_is_disarmed_and_names_the_icon(self):
        code, out, _ = run_cli(orch.main, ["armed"])
        self.assertEqual(code, 3)
        self.assertIn("DISARMED", out)
        self.assertIn("tray icon", out)
        self.assertEqual(self.calls, [])

    def test_arm_starts_the_icon_and_reports_when_it_beats(self):
        with self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 0)
        self.assertIn("ARMED", out)
        self.assertEqual(len(self.launched), 1)
        self.assertIn("tray.ps1", str(self.launched[0][-1]))
        self.assertTrue(armlib.armed())
        code, out, _ = run_cli(orch.main, ["armed"])
        self.assertEqual(code, 0)
        self.assertIn("tray icon is up", out)

    def test_arm_that_never_beats_is_an_honest_failure(self):
        with self._fake_tray(beats=False):
            code, out, err = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 3)
        self.assertIn("did not start", err)
        self.assertFalse(armlib.armed())

    def test_arm_that_never_beats_but_finds_a_running_tray_says_so(self):
        # A tray.ps1 already running but silently not beating (a crash mid-write, or a race
        # between two arms) is a DIFFERENT failure than nothing having started at all - the
        # fix is `disarm` first, not another `arm`, and the message must say that explicitly.
        with self._fake_tray(beats=False), \
             mock.patch.object(orch.subprocess, "run",
                               return_value=mock.MagicMock(returncode=0, stdout="4242\n", stderr="")):
            code, out, err = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 3)
        self.assertIn("pid 4242", err)
        self.assertIn("disarm", err)
        self.assertNotIn("did not start", err)
        self.assertFalse(armlib.armed())

    def test_arm_with_the_icon_already_up_launches_nothing(self):
        armlib.write_heartbeat(os.getpid())
        with self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 0)
        self.assertIn("already ARMED", out)
        self.assertEqual(self.launched, [])

    def test_a_paused_icon_reads_as_disarmed_and_arm_says_so(self):
        # PAUSED IS THE NORMAL ARMED STATE since 2026-09-02 (the icon starts paused), so `arm`
        # on a paused icon is a no-op success that points at `resume` - not the exit-3 fault it
        # used to be. What must NOT change: a paused icon still reads DISARMED to armlib, so
        # every acting script refuses; and arm must never launch a second tray.
        armlib.write_heartbeat(os.getpid(), paused=True)
        self.assertFalse(armlib.armed())
        with self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm"])
        self.assertEqual(code, 0)
        self.assertIn("PAUSED", out)
        self.assertIn("resume", out)
        self.assertEqual(self.launched, [])

    def test_arm_starts_the_tray_paused_and_arm_now_starts_it_running(self):
        # THE HEART OF THE 2026-09-02 CHANGE (owner: "it should probably launch on pause so
        # that it doesn't just immediately start working"). Arming must put the icon on screen
        # WITHOUT -Resumed, so the lanes stay silent; only the explicit --now passes it.
        with self._fake_tray(beats=True):
            run_cli(orch.main, ["arm"])
        self.assertEqual(len(self.launched), 1)
        self.assertNotIn("-Resumed", self.launched[0])

        self.launched.clear()
        armlib.clear_heartbeat()
        with self._fake_tray(beats=True):
            code, out, _ = run_cli(orch.main, ["arm", "--now"])
        self.assertEqual(code, 0)
        self.assertEqual(len(self.launched), 1)
        self.assertIn("-Resumed", self.launched[0])
        self.assertIn("RUNNING", out)

    def test_a_stale_beat_or_a_dead_pid_is_disarmed(self):
        # Killed tray: the file stays, the process is gone.
        armlib.write_heartbeat(1)
        self.assertFalse(armlib.armed())
        self.assertIn("not alive", armlib.status()["why"])
        # Crashed tray: the process id is ours but the beat is old.
        armlib.write_heartbeat(os.getpid(), now_ms=int((time.time() - 3600) * 1000))
        self.assertFalse(armlib.armed())
        self.assertIn("heartbeat", armlib.status()["why"])

    def test_disarm_kills_the_icon_clears_the_beat_and_pauses_the_eyes(self):
        armlib.write_heartbeat(os.getpid())
        code, out, _ = run_cli(orch.main, ["disarm"])
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)
        self.assertEqual(self.killed[0][:2], ["taskkill", "/PID"])
        self.assertFalse(armlib.heartbeat_path().exists())
        self.assertFalse(armlib.armed())
        self.assertEqual(self.calls, [["--pause"]])

    def test_quiet_is_silent_while_armed(self):
        armlib.write_heartbeat(os.getpid())
        code, out, _ = run_cli(orch.main, ["armed", "--quiet"])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "")


if __name__ == "__main__":
    unittest.main()
