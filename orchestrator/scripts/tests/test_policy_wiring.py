"""The policy file is WIRED: flipping a knob changes what the toolbox does.

A config file nothing reads is worse than no config file, because it tells the owner he is in
control when he is not. Every test here flips one knob and asserts on BEHAVIOUR, never on the
value coming back out of configlib (test_configlib.py already covers that).

Also covers hydralib.live_index, the fleet-wide liveness read that replaced one daemon call
per chat - including the lineage hole, which is the one way a fast liveness read could answer
'not live' for a chat that has a writer.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import clilib, configlib, gatelib, hydralib  # noqa: E402
import stubdaemon  # noqa: E402


class _PolicyCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._real_path, self._real_cache = configlib.CONFIG_PATH, configlib._CACHE
        configlib.CONFIG_PATH = Path(self._tmp.name) / "config.json"
        configlib._CACHE = None

    def tearDown(self):
        configlib.CONFIG_PATH, configlib._CACHE = self._real_path, self._real_cache
        self._tmp.cleanup()

    def policy(self, **pairs):
        """Set knobs for this test only. Writes the file the same way policy.py does, so the
        test exercises the real load path rather than poking the cache."""
        configlib.write(pairs)
        configlib.load(force=True)


def _finished(done="yes", question=False, offer=False, recs=None):
    return {"done_claim": done, "ends_with_question": question, "offers_to_continue": offer,
            "open_recommendations": recs or [], "recap_present": True,
            "last_assistant_text": ""}


class ArchiveSignalTest(_PolicyCase):
    """The owner's four-signal guard, one switch each. All four ON is the default and must
    behave exactly as the hardcoded version did."""

    def test_all_four_on_is_the_old_behaviour(self):
        self.assertEqual(gatelib._finished_turn_lane(_finished()), "archive-candidate")
        for kw in ({"done": "no"}, {"question": True}, {"offer": True}, {"recs": ["do X"]}):
            with self.subTest(**kw):
                self.assertEqual(gatelib._finished_turn_lane(_finished(**kw)),
                                 "needs-input-review")

    def test_switching_a_signal_off_makes_archiving_more_eager(self):
        fe = _finished(recs=["ship the thing"])
        self.assertEqual(gatelib._finished_turn_lane(fe), "needs-input-review")
        self.policy(**{"gate.signal_no_open_recommendations": False})
        self.assertEqual(gatelib._finished_turn_lane(fe), "archive-candidate",
                         "a signal switched off must stop protecting - that is the whole point")

    def test_a_disabled_signal_is_named_in_the_cause_not_silently_skipped(self):
        self.policy(**{"gate.signal_no_offer_to_continue": False})
        cause = gatelib._finished_turn_cause("archive-candidate", _finished(offer=True))
        self.assertIn("switched OFF", cause)
        self.assertIn("offer", cause)

    def test_the_other_three_still_protect_when_one_is_off(self):
        self.policy(**{"gate.signal_done_claim": False})
        self.assertEqual(gatelib._finished_turn_lane(_finished(done="no", offer=True)),
                         "needs-input-review")


class SweepLaneTest(_PolicyCase):
    def test_all_respects_the_policy(self):
        import sweep
        self.assertEqual(sweep.parse_lanes(["--all"]),
                         ["archive", "moves", "landConsole", "deliver"])
        self.policy(**{"lanes.archive": False, "lanes.deliver": False})
        self.assertEqual(sweep.parse_lanes(["--all"]), ["moves", "landConsole"])

    def test_a_lane_named_on_the_command_line_beats_the_policy(self):
        """PRECEDENCE: a flag a person typed always wins. A config that overruled a typed
        command would be a trap."""
        import sweep
        self.policy(**{"lanes.archive": False})
        self.assertEqual(sweep.parse_lanes(["--archive"]), ["archive"])

    def test_turning_a_lane_off_is_said_out_loud(self):
        import sweep
        self.policy(**{"lanes.moves": False})
        code, out = clilib.capture(lambda a: (sweep.parse_lanes(a), 0)[1], ["--all"])
        self.assertIn("moves", out)
        self.assertIn("switched OFF", out)


class ScheduledLaneTest(_PolicyCase):
    def test_a_lane_switched_off_is_not_registered(self):
        import schedule_jobs
        self.assertIn("saturate", schedule_jobs.configured_jobs())
        self.policy(**{"jobs.saturate.enabled": False})
        self.assertNotIn("saturate", schedule_jobs.configured_jobs())

    def test_a_cadence_change_reaches_the_task_definition(self):
        import schedule_jobs
        self.policy(**{"jobs.doctrine.every_minutes": 7})
        self.assertEqual(schedule_jobs.configured_jobs()["doctrine"]["schedule"],
                         ["/SC", "MINUTE", "/MO", "7"])

    def test_every_job_on_disk_has_a_knob(self):
        """A lane with no knob is a lane the owner cannot switch off - and it would be
        invisible in the menu, which is how a 'configurable' toolbox quietly stops being one."""
        import schedule_jobs
        for job in schedule_jobs.JOBS:
            key = schedule_jobs.job_key(job)
            self.assertIn(f"jobs.{key}.enabled", configlib.BY_KEY, job)
            self.assertIn(f"jobs.{key}.every_minutes", configlib.BY_KEY, job)

    def test_every_knob_points_at_a_job_that_exists(self):
        import schedule_jobs
        known = {schedule_jobs.job_key(j) for j in schedule_jobs.JOBS}
        for key in configlib.BY_KEY:
            if key.startswith("jobs."):
                self.assertIn(key.split(".")[1], known, f"{key} names no real lane")

    def test_the_default_cadences_match_what_was_registered_before(self):
        import schedule_jobs
        for job, spec in schedule_jobs.JOBS.items():
            with self.subTest(job):
                self.assertEqual(schedule_jobs.configured_jobs()[job]["schedule"],
                                 spec["schedule"])


@unittest.skipUnless(os.name == "nt", "schedule_jobs.main refuses to run off Windows")
class ScheduledLaneCommandTest(_PolicyCase):
    """What each schedule_jobs command actually sends to Task Scheduler under a policy.

    ⛔ Found in review, 2026-09-17, before it shipped: `--only reconcile --apply` unregistered
    the other ten lanes (its "switched off" set was "everything this run did not ask for"), and
    `--pause` - which is what `orch.py disarm` runs - skipped a lane the policy had switched
    off, so a lane still registered from before kept firing after a disarm."""

    def setUp(self):
        super().setUp()
        self._state = tempfile.TemporaryDirectory()
        self._old_state = os.environ.get("ORCHESTRATOR_STATE_DIR")
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        if self._old_state is None:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        else:
            os.environ["ORCHESTRATOR_STATE_DIR"] = self._old_state
        self._state.cleanup()
        super().tearDown()

    def run_main(self, *argv):
        import schedule_jobs
        calls = []

        def fake(args):
            calls.append(list(args))
            return 0, "SUCCESS"

        with mock.patch.object(schedule_jobs, "_schtasks", side_effect=fake):
            clilib.capture(schedule_jobs.main, list(argv))
        return calls

    @staticmethod
    def names(calls, verb, *extra):
        return {c[c.index("/TN") + 1] for c in calls
                if c[0] == verb and all(x in c for x in extra)}

    def test_only_one_lane_apply_touches_only_that_lane(self):
        self.policy(**{"jobs.saturate.enabled": False})
        calls = self.run_main("--only", "reconcile", "--apply")
        self.assertEqual(self.names(calls, "/Delete"), set(),
                         "naming one lane must never unregister the others")
        self.assertEqual(self.names(calls, "/Create"), {"Orchestrator-reconcile"})

    def test_a_named_lane_is_registered_at_the_policy_cadence(self):
        self.policy(**{"jobs.doctrine.every_minutes": 7})
        calls = self.run_main("--only", "doctrine", "--apply")
        create = next(c for c in calls if c[0] == "/Create")
        self.assertEqual(create[create.index("/MO") + 1], "7")

    def test_a_full_apply_unregisters_exactly_the_lanes_switched_off(self):
        self.policy(**{"jobs.saturate.enabled": False})
        calls = self.run_main("--apply")
        self.assertEqual(self.names(calls, "/Delete"), {"Orchestrator-saturate"})
        self.assertNotIn("Orchestrator-saturate", self.names(calls, "/Create"))
        self.assertIn("Orchestrator-reconcile", self.names(calls, "/Create"))

    def test_disarm_pauses_a_lane_the_policy_switched_off(self):
        self.policy(**{"jobs.saturate.enabled": False})
        calls = self.run_main("--pause")
        self.assertIn("Orchestrator-saturate", self.names(calls, "/Change", "/DISABLE"))

    def test_resume_never_wakes_a_lane_the_policy_switched_off(self):
        self.policy(**{"jobs.saturate.enabled": False})
        calls = self.run_main("--resume")
        self.assertNotIn("Orchestrator-saturate", self.names(calls, "/Change"))
        self.assertIn("Orchestrator-reconcile", self.names(calls, "/Change", "/ENABLE"))


class ForcedArchiveTest(_PolicyCase):
    """⛔ THE BUG THE OWNER REPORTED, 2026-09-17: 'the orchestrator ... forcibly archives'.
    interview.py ran every AI 'archive' answer as `archive_chat --force`, and --force is the
    one flag that lifts a HOLD placed by hand."""

    def _capture_argv(self):
        import interview
        seen = {}

        class FakeArchive:
            @staticmethod
            def main(argv):
                seen["argv"] = list(argv)
                return 0

        real = sys.modules.get("archive_chat")
        sys.modules["archive_chat"] = FakeArchive
        try:
            interview._apply_archive("sid-1")
        finally:
            if real is not None:
                sys.modules["archive_chat"] = real
            else:
                sys.modules.pop("archive_chat", None)
        return seen["argv"]

    def test_by_default_an_ai_archive_no_longer_forces(self):
        self.assertEqual(self._capture_argv(), ["sid-1"])

    def test_the_old_behaviour_is_still_available_deliberately(self):
        self.policy(**{"archive.ai_decision_uses_force": True})
        self.assertEqual(self._capture_argv(), ["sid-1", "--force"])

    def test_a_hold_refusal_is_reported_as_the_owners_word_not_a_failure(self):
        import interview

        class FakeArchive:
            @staticmethod
            def main(argv):
                return 6  # archive_chat's hold exit

        real = sys.modules.get("archive_chat")
        sys.modules["archive_chat"] = FakeArchive
        try:
            got = interview._apply_archive("sid-1")
        finally:
            if real is not None:
                sys.modules["archive_chat"] = real
            else:
                sys.modules.pop("archive_chat", None)
        self.assertIn("HOLD", got["outcome"])
        self.assertIn("ai_decision_uses_force", got["outcome"])


class LiveIndexTest(unittest.TestCase):
    """hydralib.live_index: liveness for the whole fleet in one call, and the lineage hole."""

    def setUp(self):
        self.stub = stubdaemon.StubDaemon()
        self._real_base = hydralib.BASE
        hydralib.BASE = self.stub.url

    def tearDown(self):
        hydralib.BASE = self._real_base
        self.stub.close()

    def live(self, *rows, joined=False):
        body = {"count": len(rows), "sessions": list(rows)}
        if joined:
            body["lineage"] = True
        self.stub.routes["/api/sessions/live"] = body

    @staticmethod
    def engine(pid, sid, path, lineage=None):
        row = {"pid": pid, "sessionId": sid, "name": "i", "startedAt": 1, "cwd": "D:/x",
               "transcriptPath": path}
        if lineage is not None:
            row["lineageIds"] = lineage
        return row

    def dossier_gets(self):
        return [g for g in self.stub.gets if g[0] == "/api/chats/dossier"]

    def test_one_call_answers_for_every_chat(self):
        self.live(self.engine(11, "a", "T-a", ["a"]), joined=True)
        idx = hydralib.live_index()
        self.assertEqual(hydralib.live_from_index(idx, "a")["pid"], 11)
        self.assertIsNone(hydralib.live_from_index(idx, "b", "T-b"),
                          "a chat with no live process must read as not live")
        self.assertEqual(self.stub.gets, [("/api/sessions/live", "lineage=1")],
                         "a daemon that joins lineage itself needs exactly one call")

    def test_the_daemon_joined_lineage_makes_every_alias_live(self):
        """⛔ THE HOLE, closed at the source. The engine runs as new-id; the chat's OLD
        transcript row sits under old-id, and both rows are in the plan. old-id must read
        live, from the one call, with no dossier lookup."""
        self.live(self.engine(15, "new-id", "T-new", ["new-id", "old-id", "chat-x"]),
                  joined=True)
        idx = hydralib.live_index()
        for alias in ("new-id", "old-id", "chat-x"):
            with self.subTest(alias):
                self.assertEqual(hydralib.live_from_index(idx, alias, "T-old")["pid"], 15)
        self.assertEqual(self.dossier_gets(), [])

    def test_a_rotated_identity_is_still_found_by_transcript(self):
        self.live(self.engine(12, "new-id", "T-1", ["new-id"]), joined=True)
        idx = hydralib.live_index()
        self.assertEqual(hydralib.live_from_index(idx, "old-id", "T-1")["pid"], 12)

    def test_an_older_daemon_chases_EVERY_engine_through_its_lineage(self):
        """⛔ THE HOLE AS IT FIRST SHIPPED (review, 2026-09-17). The engine's own id is a known
        row, so the first version called it 'attributed' and never looked it up - and the
        chat's OLD row, the one actually at risk, read as not live. On the live fleet that
        skip covered all 13 engines. A daemon without `?lineage=1` now gets one dossier lookup
        per engine, attributed or not."""
        self.live(self.engine(13, "live-id", "T-live"))  # no lineage flag: an older daemon
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"cliSessionId": "live-id", "lineageIds": ["ancestor"],
             "priorCliSessionIds": ["older"], "live": {"pid": 13, "name": "i"}}]}
        idx = hydralib.live_index()
        for alias in ("live-id", "ancestor", "older"):
            with self.subTest(alias):
                self.assertEqual(hydralib.live_from_index(idx, alias)["pid"], 13)
        self.assertEqual(len(self.dossier_gets()), 1)

    def test_lineage_ids_without_the_flag_are_not_trusted(self):
        """The flag is the proof the daemon joined them. A row carrying the field on an answer
        without it still gets the lookup."""
        self.live(self.engine(16, "e", "T-e", ["e"]))
        self.stub.routes["/api/chats/dossier"] = {"matches": [
            {"cliSessionId": "e", "lineageIds": ["e-old"], "live": {"pid": 16}}]}
        idx = hydralib.live_index()
        self.assertEqual(hydralib.live_from_index(idx, "e-old")["pid"], 16)
        self.assertEqual(len(self.dossier_gets()), 1)

    def test_an_engine_keeps_its_own_block_whatever_an_alias_says(self):
        self.live(self.engine(17, "p", "T-p", ["p", "q"]), self.engine(18, "q", "T-q", ["q"]),
                  joined=True)
        idx = hydralib.live_index()
        self.assertEqual(hydralib.live_from_index(idx, "q")["pid"], 18)
        self.assertEqual(hydralib.live_from_index(idx, "p")["pid"], 17)

    def test_a_failed_lineage_read_falls_back_instead_of_guessing(self):
        """Liveness we could not finish establishing is UNKNOWN, and unknown must never be
        served as 'not live'."""
        self.live(self.engine(14, "x", "T-x"))
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "boom"})
        self.assertIsNone(hydralib.live_index(),
                          "None means 'use the slow per-chat path', never 'nothing is live'")

    def test_an_older_daemon_with_no_endpoint_falls_back(self):
        self.assertIsNone(hydralib.live_index())

    def test_a_malformed_answer_raises_rather_than_reading_as_empty(self):
        self.stub.routes["/api/sessions/live"] = {"sessions": "not a list"}
        with self.assertRaises(hydralib.DaemonError):
            hydralib.live_index()


class ArchiveMasterSwitchTest(_PolicyCase):
    def test_archiving_off_refuses_before_anything_is_resolved(self):
        """The master switch must stop the act EARLY - before a daemon read, before the gate,
        before any chance of a side effect."""
        import archive_chat
        self.policy(**{"archive.enabled": False})
        code, out = clilib.capture(archive_chat.main, ["some-chat"])
        self.assertEqual(code, 2)
        self.assertIn("archive.enabled", out)

    def test_unarchiving_is_never_blocked_by_it(self):
        """The switch exists to stop work disappearing, so it must never block work coming
        back. This gets past the policy guard and fails later, on the daemon - which is the
        point: the guard did not stop it."""
        import archive_chat
        self.policy(**{"archive.enabled": False})
        code, out = clilib.capture(archive_chat.main, ["some-chat", "--unarchive"])
        self.assertNotIn("archive.enabled", out)

    def test_the_sweep_drops_the_archive_lane_even_when_named(self):
        """Running it anyway would get three identical refusals, trip the shared-cause breaker
        and file an incident for a decision the owner made on purpose (review, 2026-09-17)."""
        import sweep
        self.policy(**{"archive.enabled": False})
        code, out = clilib.capture(
            lambda a: (print(sweep.parse_lanes(a)), 0)[1], ["--archive", "--moves"])
        self.assertIn("['moves']", out)
        self.assertIn("archive.enabled", out)

    def test_the_groundskeeper_never_calls_archive_with_it_off(self):
        import groundskeeper
        self.policy(**{"archive.enabled": False})
        plan = {"evacuate": [], "archive": [{"sessionId": "s", "title": "t"}]}
        with mock.patch("archive_chat.main", return_value=0) as m:
            results = groundskeeper.execute(plan, do_evacuate=False, do_reap=False)
        m.assert_not_called()
        self.assertEqual(results, [])


class ConsoleStrayFilterTest(unittest.TestCase):
    """⛔ A SESSION THAT IS NOT A CLAUDE CHAT CAN NEVER BE LANDED (found live, 2026-09-17).

    Since AgentHydra 0.42.0 the daemon surfaces zswarm jobs, OpenCode sessions and DSH
    sessions as sessions - correct everywhere except this lane, which tried to import them
    into the desktop app. Measured on the real fleet that day: 113 'console strays', 67 of
    them job.json / opencode.db / session.v3.jsonl.zstd, so the lane sat 99 over its cap
    forever with 46 real chats queued behind rows no actuator can act on.

    build_batch is driven here with a hand-built plan and balance, so the test needs no
    daemon and asserts on the lane's contents rather than on a live fleet's counts.
    """

    def _plan(self):
        def chat(sid, kind, detail):
            return {"sessionId": sid, "title": sid, "instance": None, "origin": "console",
                    "state": "finished", "evidence": "",
                    "decision": {"kind": kind, "action": "", "detail": detail}}
        return {"complete": True, "scanned": 4, "chats": [
            chat("real-1", "wait-on-person", "it ends on a question"),
            chat("zswarm-1", "cannot",
                 "unsupported transcript format (job.json) - only Claude Code JSONL can be gated"),
            chat("opencode-1", "cannot",
                 "unsupported transcript format (opencode.db) - only Claude Code JSONL can be gated"),
            chat("nogate-1", "cannot",
                 "no transcript on disk; a thing that cannot be gated cannot be acted on"),
        ]}

    def _bal(self):
        to = {"instance": "somewhere"}
        return {"likelihood": {"level": "unlikely", "why": ""}, "moves": [], "planIncomplete": False,
                "consoleStrays": [{"sessionId": s, "title": s, "kind": "wait-on-person", "to": to}
                                  for s in ("real-1", "zswarm-1", "opencode-1", "nogate-1")]}

    def _batch(self):
        import sweep
        real_courier = sys.modules.get("courier")

        class FakeCourier:
            @staticmethod
            def run(cap, only, act, running_now=None):
                return {"planned": [], "skipped": []}

        sys.modules["courier"] = FakeCourier
        try:
            return sweep.build_batch(False, 5, plan=self._plan(), bal=self._bal())
        finally:
            if real_courier is not None:
                sys.modules["courier"] = real_courier
            else:
                sys.modules.pop("courier", None)

    def test_non_claude_sessions_never_enter_the_land_lane(self):
        rows = {r["sessionId"] for r in self._batch()["lanes"]["landConsole"]["rows"]}
        self.assertIn("real-1", rows)
        self.assertNotIn("zswarm-1", rows)
        self.assertNotIn("opencode-1", rows)

    def test_a_chat_with_no_transcript_yet_is_still_landed(self):
        """Only the UNSUPPORTED-FORMAT refusal excludes a stray. 'no transcript on disk' is a
        Claude chat the plan simply cannot read yet - landing it is how it becomes readable,
        so a filter that swallowed it would quietly stop doing the owner's mandated work."""
        rows = {r["sessionId"] for r in self._batch()["lanes"]["landConsole"]["rows"]}
        self.assertIn("nogate-1", rows)

    def test_the_exclusion_is_counted_out_loud_not_silently_dropped(self):
        """A lane that quietly shrinks is a lane nobody can audit."""
        batch = self._batch()
        self.assertEqual(batch["landNotClaude"], 2)
        self.assertIn("not Claude chats", sweep_render(batch))


def sweep_render(batch):
    import sweep
    return sweep.render(batch, None, [], refused=None)


if __name__ == "__main__":
    unittest.main()
