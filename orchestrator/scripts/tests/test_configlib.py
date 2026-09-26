"""configlib + policy.py: the policy file, and the promise that installing it changed nothing.

The load-bearing test in here is `test_every_default_matches_the_constant_it_replaced`. The
whole design rests on one claim - "every default equals today's hardcoded value, so a machine
with no config file behaves exactly as it did before" - and that claim is only true for as
long as someone keeps checking it against the modules themselves.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import configlib  # noqa: E402
import policy  # noqa: E402


def run_policy(argv: list[str]) -> tuple[int, str]:
    """policy.main with BOTH streams captured. clilib.capture takes stdout only, and every
    refusal in policy.py goes to stderr by the repo's convention - a test that read stdout
    alone would assert on an empty string and pass for the wrong reason."""
    import contextlib
    import io

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        code = policy.main(argv)
    return code, buf.getvalue()


class _ConfigCase(unittest.TestCase):
    """Every test gets its own config file. The owner's real state/config.json is never read
    or written by the suite - a test that edited the live policy would be a test that changes
    the fleet."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "config.json"
        self._real_path, self._real_cache = configlib.CONFIG_PATH, configlib._CACHE
        configlib.CONFIG_PATH = self.path
        configlib._CACHE = None

    def tearDown(self):
        configlib.CONFIG_PATH, configlib._CACHE = self._real_path, self._real_cache
        self._tmp.cleanup()

    def write(self, payload: dict):
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        configlib.load(force=True)


class SpecTest(_ConfigCase):
    def test_every_knob_has_a_help_string_a_person_could_act_on(self):
        for row in configlib.SPEC:
            with self.subTest(row["key"]):
                self.assertGreater(len(row["help"]), 40,
                                   f"{row['key']}: a knob whose help is a label is a knob "
                                   "nobody can decide about")
                self.assertIn(row["group"], {g for g, _ in configlib.GROUPS},
                              f"{row['key']}: group is not in GROUPS, so the menu hides it")

    def test_the_automation_profile_ships_as_todays_doctrine(self):
        # Owner, 2026-09-24: chats AgentHydra launches may run at a cheaper effort than the
        # owner's own - but the repo is shared, so the SHIPPED desktop profile is exactly the old
        # behaviour (ultracode + xhigh). The console ships at --effort high (ruling 2026-09-24, the
        # panel Jacob delegated to, decide-43): every console chat is one the fleet started or woke.
        dflt = configlib.defaults()
        self.assertEqual((dflt["doctrine.automation_ultracode"], dflt["doctrine.automation_effort"],
                          dflt["doctrine.console_effort"]), (True, "xhigh", "high"))
        self.write({"doctrine.automation_ultracode": False, "doctrine.automation_effort": "high",
                    "doctrine.console_effort": "high"})
        self.assertEqual(configlib.problems(), [])
        self.assertEqual(configlib.get("doctrine.automation_effort"), "high")
        self.assertIs(configlib.get("doctrine.stamp_ultracode"), True)

    def test_every_default_validates_against_its_own_row(self):
        for row in configlib.SPEC:
            with self.subTest(row["key"]):
                self.assertEqual(configlib._coerce(row, row["default"]), row["default"])

    def test_no_duplicate_keys(self):
        keys = [r["key"] for r in configlib.SPEC]
        self.assertEqual(len(keys), len(set(keys)))

    def test_every_default_matches_the_constant_it_replaced(self):
        """⛔ THE PROMISE. Each pair is (config key, the live module value it now feeds). A
        failure here means installing the policy file CHANGED the fleet's behaviour on a
        machine that never chose anything, which is the one thing it must never do."""
        from lib import bandlib, gatelib, hydralib, stamplib
        import balance, courier, groundskeeper, interview, overlord, saturate
        import sweep, unblock_prompts

        pairs = [
            ("gate.idle_after_secs", gatelib.IDLE_AFTER_SECS, 180),
            ("gate.stall_quiet_secs", gatelib.STALL_QUIET_SECS, 1800),
            ("gate.evidence_cap", gatelib.EVIDENCE_CAP, 2000),
            ("archive.quiet_secs", groundskeeper.ARCHIVE_QUIET_SECS, 2700),
            ("archive.per_run", groundskeeper.ARCHIVE_PER_RUN, 3),
            ("lanes.max_per_lane", sweep.DEFAULT_MAX_PER_LANE, 5),
            ("lanes.breaker_threshold", sweep.DEFAULT_BREAKER_THRESHOLD, 3),
            ("bands.soft_target_pct", balance.SOFT_TARGET_PCT, 85),
            ("bands.hard_gate_pct", balance.HARD_GATE_PCT, 90),
            ("bands.fresh_hours", balance.FRESH_HOURS, 48),
            ("bands.max_running_chats", hydralib.MAX_RUNNING_CHATS, 18),
            ("courier.max_deliveries", courier.DEFAULT_MAX, 5),
            ("courier.confirm_secs", courier.CONFIRM_SECS, 150),
            ("unblock.max_presses", unblock_prompts.DEFAULT_MAX, 6),
            ("unblock.min_wait_secs", unblock_prompts.MIN_WAIT_SECS, 240),
            ("unblock.select_after_secs", unblock_prompts.SELECT_AFTER_SECS, 900),
            ("unblock.surface_after_failures", unblock_prompts.SURFACE_AFTER_FAILURES, 3),
            ("interview.max_questions", interview.MAX_QUESTIONS, 20),
            ("interview.evidence_chars", interview.EVIDENCE_CHARS, 900),
            ("overlord.nudge_quiet_secs", overlord.NUDGE_QUIET_SECS, 300),
            ("overlord.long_run_secs", overlord.LONG_RUN_SECS, 1800),
            ("overlord.rebirth_cooldown_secs", overlord.REBIRTH_COOLDOWN_SECS, 1800),
            ("saturate.recent_delivery_secs", overlord.RECENT_DELIVERY_SECS, 180),
            ("groundskeeper.prompt_stall_secs", groundskeeper.PROMPT_STALL_SECS, 600),
            ("groundskeeper.reap_idle_secs", groundskeeper.REAP_IDLE_SECS, 600),
            ("groundskeeper.rebalance_gap", groundskeeper.REBALANCE_GAP, 2),
            ("groundskeeper.rebalance_per_run", groundskeeper.REBALANCE_PER_RUN, 5),
            ("groundskeeper.rebalance_cooldown_secs", groundskeeper.REBALANCE_COOLDOWN_SECS, 21600),
            ("groundskeeper.open_per_run", groundskeeper.OPEN_PER_RUN, 1),
            ("groundskeeper.stale_hours", groundskeeper.STALE_HOURS, 12),
            ("doctrine.stamp_effort", stamplib.ULTRACODE_EFFORT, "xhigh"),
            ("saturate.wake_prompt", saturate.WAKE_PROMPT, None),
        ]
        dflt = configlib.defaults()
        for key, live_value, was in pairs:
            with self.subTest(key):
                self.assertEqual(dflt[key], live_value,
                                 f"{key}: the spec default and the module disagree")
                if was is not None:
                    self.assertEqual(live_value, was,
                                     f"{key}: this used to be {was!r} and is now {live_value!r} "
                                     "- a default drifted away from the behaviour it replaced")
        self.assertEqual(bandlib.per_account_share(5, 18), 4,
                         "the per-account share must still clamp the way the literals did")


class ValidationTest(_ConfigCase):
    def test_a_value_out_of_range_is_refused_by_name(self):
        row = configlib.BY_KEY["archive.per_run"]
        with self.assertRaises(configlib.ConfigError) as ctx:
            configlib._coerce(row, 9999)
        self.assertIn("archive.per_run", str(ctx.exception))

    def test_a_bad_value_on_disk_is_reported_and_the_default_is_used(self):
        """A policy file the toolbox silently ignored would be worse than none at all."""
        self.write({"archive.per_run": "not a number"})
        self.assertEqual(configlib.get("archive.per_run"), 3)
        self.assertTrue(any("archive.per_run" in p for p in configlib.problems()))

    def test_an_unknown_key_is_reported_and_the_rest_still_loads(self):
        """Loading never fails on one (a newer toolbox's key after a downgrade must not stop
        --doctor or --unset from working); the key is a problem, and it names the fix."""
        self.write({"a.key.from.the.future": 1, "archive.per_run": 4})
        self.assertEqual(configlib.get("archive.per_run"), 4)
        self.assertTrue(any("future" in p and "--unset" in p for p in configlib.problems()))

    def test_booleans_accept_the_words_a_person_types(self):
        row = configlib.BY_KEY["archive.enabled"]
        for word, want in (("on", True), ("off", False), ("yes", True), ("false", False)):
            self.assertIs(configlib._coerce(row, word), want)

    def test_str_or_null_is_unset_by_null_or_blank_and_keeps_text(self):
        row = configlib.BY_KEY["interview.brain"]
        for unset in (None, "", "  ", "null", "None"):
            self.assertIsNone(configlib._coerce(row, unset))
        self.assertEqual(configlib._coerce(row, "node brain.mjs"), "node brain.mjs")
        self.assertIsNone(configlib.defaults()["interview.brain"])
        # shown as text, never in int_or_null's "uncapped" wording
        self.assertEqual(policy._fmt(row, None), "unset")
        self.assertEqual(policy._fmt(row, "node brain.mjs"), '"node brain.mjs"')

    def test_int_or_null_accepts_null_for_uncapped(self):
        row = configlib.BY_KEY["groundskeeper.evacuate_per_run"]
        self.assertIsNone(configlib._coerce(row, "null"))
        self.assertEqual(configlib._coerce(row, "7"), 7)

    def test_an_unreadable_file_is_a_named_problem_not_a_traceback(self):
        self.path.write_text("{not json", encoding="utf-8")
        configlib.load(force=True)
        self.assertTrue(configlib.problems())
        self.assertEqual(configlib.get("archive.per_run"), 3)

    def test_a_json_true_is_not_a_number(self):
        """int(True) is 1, so `"archive.per_run": true` used to pass as 1 (review, 2026-09-17)."""
        for key in ("archive.per_run", "lanes.max_per_lane", "archive.quiet_secs",
                    "groundskeeper.evacuate_per_run"):
            with self.subTest(key), self.assertRaises(configlib.ConfigError):
                configlib._coerce(configlib.BY_KEY[key], True)

    def test_a_fraction_is_refused_not_truncated(self):
        row = configlib.BY_KEY["lanes.max_per_lane"]
        with self.assertRaises(configlib.ConfigError):
            configlib._coerce(row, 2.7)
        self.assertEqual(configlib._coerce(row, 7.0), 7)


class BlockingProblemTest(_ConfigCase):
    """⛔ A policy nobody can read must stop unattended acting: its values fall back to the
    defaults, and a default where the owner wrote the opposite undoes his decision
    (review, 2026-09-17)."""

    def test_an_unreadable_file_is_a_problem(self):
        self.path.write_text("{not json", encoding="utf-8")
        configlib.load(force=True)
        self.assertTrue(configlib.problems())

    def test_a_bad_value_is_a_problem(self):
        self.write({"archive.enabled": "nope"})
        self.assertTrue(configlib.get("archive.enabled"), "the bad value fell back to ON...")
        self.assertTrue(configlib.problems(), "...which is exactly why it must block")

    def test_a_typo_d_key_is_a_problem(self):
        """"archive.enable": false reads as "archiving is off" to whoever typed it, and
        changes nothing."""
        self.write({"archive.enable": False})
        self.assertTrue(configlib.get("archive.enabled"))
        self.assertTrue(configlib.problems())

    def test_unset_removes_an_unknown_key_even_though_writes_refuse_it(self):
        self.write({"archive.enable": False, "archive.per_run": 4})
        with self.assertRaises(configlib.ConfigError):
            configlib.set_many({"lanes.max_per_lane": 9})
        self.assertEqual(configlib.unset_many(["archive.enable"]), ["archive.enable"])
        configlib.load(force=True)
        self.assertEqual(configlib.problems(), [])
        self.assertEqual(configlib.get("archive.per_run"), 4)

    def test_a_clean_file_and_no_file_are_not_problems(self):
        configlib.load(force=True)
        self.assertEqual(configlib.problems(), [])
        self.write({"archive.per_run": 4})
        self.assertEqual(configlib.problems(), [])

    def test_the_armed_window_refuses_on_it_and_force_still_runs(self):
        from lib import armlib
        self.write({"archive.enabled": "nope"})
        with mock.patch.object(armlib, "status",
                               return_value={"armed": True, "why": "tray up"}):
            said = armlib.refuse_unless_armed([], "archiving")
            self.assertIn("POLICY FILE UNREADABLE", said)
            self.assertIsNone(armlib.refuse_unless_armed(["--force"], "archiving"))
            self.write({})
            self.assertIsNone(armlib.refuse_unless_armed([], "archiving"),
                              "armed with a clean policy must still act")


class WriteTest(_ConfigCase):
    def test_a_value_equal_to_the_default_is_not_written(self):
        """The file carries decisions, not a snapshot: a later default change must still reach
        a machine that never disagreed with it."""
        configlib.write({"archive.per_run": 3, "lanes.max_per_lane": 9})
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertNotIn("archive.per_run", on_disk)
        self.assertEqual(on_disk["lanes.max_per_lane"], 9)

    def test_set_many_merges_rather_than_replacing(self):
        configlib.write({"lanes.max_per_lane": 9})
        configlib.set_many({"archive.per_run": 7})
        configlib.load(force=True)
        self.assertEqual(configlib.get("lanes.max_per_lane"), 9)
        self.assertEqual(configlib.get("archive.per_run"), 7)

    def test_a_refused_write_changes_nothing_on_disk(self):
        configlib.write({"lanes.max_per_lane": 9})
        with self.assertRaises(configlib.ConfigError):
            configlib.write({"lanes.max_per_lane": 9, "archive.per_run": -5})
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["lanes.max_per_lane"], 9)

    def test_the_write_is_atomic_and_leaves_no_temp_file(self):
        configlib.write({"lanes.max_per_lane": 9})
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["config.json"])

    def test_a_hand_written_note_survives_a_rewrite(self):
        self.write({"_why": "turned off after the incident", "archive.enabled": False})
        configlib.set_many({"lanes.deliver": False})
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["_why"], "turned off after the incident")
        self.assertIs(on_disk["archive.enabled"], False)
        self.assertIs(on_disk["lanes.deliver"], False)

    def test_unset_many_returns_what_was_overridden(self):
        configlib.write({"lanes.max_per_lane": 9})
        self.assertEqual(configlib.unset_many(["lanes.max_per_lane", "archive.per_run"]),
                         ["lanes.max_per_lane"])
        self.assertNotIn("lanes.max_per_lane", configlib.read_file())

    def test_concurrent_set_many_calls_keep_every_change(self):
        """Two writers that each read-then-write used to drop one change (review, 2026-09-17)."""
        import threading
        keys = ["lanes.max_per_lane", "archive.per_run", "courier.max_deliveries",
                "interview.max_questions"]
        threads = [threading.Thread(target=configlib.set_many, args=({k: 7},)) for k in keys]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        on_disk = configlib.read_file()
        for k in keys:
            self.assertEqual(on_disk.get(k), 7, k)

    def test_diff_is_empty_on_a_fresh_machine(self):
        configlib.load(force=True)
        self.assertEqual(configlib.diff(), {},
                         "a machine with no policy file must report nothing changed")


class PresetTest(_ConfigCase):
    def test_every_preset_only_names_real_knobs_and_valid_values(self):
        for name, overlay in configlib.PRESETS.items():
            with self.subTest(name):
                clean, problems = configlib.validate(overlay)
                self.assertEqual(problems, [], f"preset {name} has an unusable value")
                self.assertEqual(set(clean), set(overlay))

    def test_observe_only_switches_off_every_acting_lane(self):
        """The preset's whole promise: it still SEES everything and touches nothing."""
        for key in ("archive.enabled", "lanes.archive", "lanes.moves", "lanes.deliver",
                    "saturate.enabled", "unblock.enabled"):
            self.assertIs(configlib.PRESETS["observe-only"][key], False, key)


class BrokenInputTest(_ConfigCase):
    """Commands handed a broken file or a broken answer sheet answer in words, never with a
    traceback (review, 2026-09-17)."""

    def test_doctor_reports_an_unreadable_file_instead_of_crashing(self):
        self.path.write_text("{not json", encoding="utf-8")
        configlib.load(force=True)
        code, out = run_policy(["--doctor"])
        self.assertEqual(code, 2, out)
        self.assertIn("not readable JSON", out)

    def test_unset_on_an_unreadable_file_is_refused_in_words(self):
        self.path.write_text("{not json", encoding="utf-8")
        code, out = run_policy(["--unset", "archive.per_run"])
        self.assertEqual(code, 3, out)
        self.assertIn("refused", out)

    def test_apply_skips_an_answer_that_is_not_an_object(self):
        sheet = Path(self._tmp.name) / "answers.json"
        sheet.write_text(json.dumps({"answers": ["archive.per_run", 42,
                                                 {"key": "archive.per_run", "value": 4}]}),
                         encoding="utf-8")
        code, out = run_policy(["--apply", str(sheet)])
        self.assertEqual(code, 0, out)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 4)


class WizardTest(_ConfigCase):
    """The wizard, driven with scripted answers. Its confirm step crashed on every run that had
    a change to show (KeyError on a raw spec row), so it could never write - found in review,
    2026-09-17, because nothing had ever driven it end to end."""

    def drive(self, answers):
        feed = iter(answers)

        def fake_input(_prompt=""):
            try:
                return next(feed)
            except StopIteration:
                raise EOFError from None

        with mock.patch("sys.stdin") as stdin, mock.patch("builtins.input", fake_input):
            stdin.isatty.return_value = True
            return run_policy(["--wizard"])

    def test_a_confirmed_change_is_written(self):
        # gate group: yes; idle 240, keep the other two; archive signals group: quit.
        code, out = self.drive(["y", "240", "", "", "q", "y"])
        self.assertEqual(code, 0, out)
        configlib.load(force=True)
        self.assertEqual(configlib.get("gate.idle_after_secs"), 240)
        self.assertIn("180s (3m) -> 240s (4m)", out)

    def test_no_answer_at_the_confirm_prompt_writes_nothing(self):
        code, out = self.drive(["y", "240", "", "", "q"])
        self.assertEqual(code, 0, out)
        self.assertIn("nothing written", out)
        self.assertFalse(self.path.exists())

    def test_a_typo_on_a_signal_keeps_it_on(self):
        # gate group: skip; archive signals: yes, typo on the first, keep the rest; quit; confirm.
        code, out = self.drive(["n", "y", "yse", "", "", "", "q", "y"])
        self.assertEqual(code, 0, out)
        configlib.load(force=True)
        self.assertIs(configlib.get("gate.signal_done_claim"), True)
        self.assertIn("did not understand", out)


class PolicyCommandTest(_ConfigCase):
    def test_status_list_and_explain_run_clean(self):
        from lib import clilib
        for argv in ([], ["--list"], ["--list", "gate"], ["--explain", "archive.per_run"],
                     ["--ask"], ["--doctor"], ["--json"]):
            with self.subTest(argv=argv):
                code, out = clilib.capture(policy.main, argv)
                self.assertEqual(code, 0, out)
                self.assertTrue(out.strip())

    def test_explain_names_a_near_miss_instead_of_just_refusing(self):
        code, out = run_policy(["--explain", "per_run"])
        self.assertEqual(code, 3)
        self.assertIn("archive.per_run", out)

    def test_set_then_unset_round_trips(self):
        from lib import clilib
        self.assertEqual(clilib.capture(policy.main, ["--set", "archive.per_run=7"])[0], 0)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 7)
        self.assertEqual(clilib.capture(policy.main, ["--unset", "archive.per_run"])[0], 0)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 3)

    def test_set_refuses_an_unknown_knob_without_writing(self):
        from lib import clilib
        code, out = clilib.capture(policy.main, ["--set", "nope.nope=1"])
        self.assertEqual(code, 3)
        self.assertFalse(self.path.exists(), "a refused --set must not create a policy file")

    def test_preset_is_plan_only_without_yes(self):
        from lib import clilib
        code, out = clilib.capture(policy.main, ["--preset", "conservative"])
        self.assertEqual(code, 0)
        self.assertIn("PLAN ONLY", out)
        self.assertFalse(self.path.exists())
        self.assertEqual(clilib.capture(policy.main, ["--preset", "conservative", "--yes"])[0], 0)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 1)

    def test_ask_then_apply_is_the_ai_path(self):
        from lib import clilib
        qs = policy.build_questions("archive")
        self.assertTrue(qs and all({"key", "question", "answerFormat"} <= set(q) for q in qs))
        answers = Path(self._tmp.name) / "answers.json"
        answers.write_text(json.dumps({"answers": [{"key": "archive.per_run", "value": 6}]}),
                           encoding="utf-8")
        code, out = clilib.capture(policy.main, ["--apply", str(answers)])
        self.assertEqual(code, 0, out)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 6)

    def test_apply_refuses_the_whole_file_when_one_answer_is_bad(self):
        """Atomic on purpose: a half-applied policy is a fleet nobody can describe."""
        from lib import clilib
        answers = Path(self._tmp.name) / "answers.json"
        answers.write_text(json.dumps({"answers": [{"key": "archive.per_run", "value": 6},
                                                   {"key": "lanes.max_per_lane", "value": -1}]}),
                           encoding="utf-8")
        code, out = run_policy(["--apply", str(answers)])
        self.assertEqual(code, 3)
        self.assertIn("NOTHING written", out)
        configlib.load(force=True)
        self.assertEqual(configlib.get("archive.per_run"), 3)

    def test_the_rails_are_shown_as_non_negotiable(self):
        from lib import clilib
        _code, out = clilib.capture(policy.main, [])
        self.assertIn("NOT A KNOB", out)
        self.assertIn("live-writer", out)
        for name, _why in configlib.RAILS:
            self.assertNotIn(name.replace(" ", "."), configlib.BY_KEY,
                             f"{name} is listed as a rail AND exists as a knob")


if __name__ == "__main__":
    unittest.main()


class EveryKnobIsWiredTest(unittest.TestCase):
    """⛔ A KNOB NOTHING READS IS A LIE - it tells the owner he is in control when he is not.

    This scans the toolbox's own source for each key and fails on any that no script consults.
    It is a crude check (a literal string search) and that is deliberate: it cannot be fooled
    by a clever indirection because there is none to be had - every read goes through
    `configlib.get("<key>")` with the key spelled out.

    ⛔ THE EXCLUSION LIST IS THE LOAD-BEARING PART. The first version of this scan included
    configlib.py itself, which contains every key by definition, so it reported zero unwired
    knobs while FOUR were decoration (saturate.max_wakes, doctrine.stamp_held_chats,
    groundskeeper.duty_name_stuck, overlord.enabled). A check that can only pass is not a
    check. Do not add a file here without proving it is a knob's DEFINITION and not a knob's
    consumer.
    """

    #: Files that MENTION every key by nature and so cannot count as a consumer.
    NOT_CONSUMERS = {"configlib.py", "policy.py", "dryrun.py"}

    def _source(self) -> str:
        root = Path(__file__).resolve().parents[2]
        out = []
        for p in list((root / "scripts").rglob("*.py")) + [root / "orch.py"]:
            if "tests" in p.parts or p.name in self.NOT_CONSUMERS:
                continue
            out.append(p.read_text(encoding="utf-8", errors="replace"))
        return "\n".join(out)

    def test_every_knob_is_read_by_something(self):
        src = self._source()
        unwired = [r["key"] for r in configlib.SPEC
                   # the scheduled-lane keys are read through an f-string in
                   # schedule_jobs.configured_jobs, and are covered by
                   # test_policy_wiring.ScheduledLaneTest instead
                   if not r["key"].startswith("jobs.")
                   and f'"{r["key"]}"' not in src and f"'{r['key']}'" not in src]
        self.assertEqual(unwired, [],
                         "these knobs are in the menu but nothing reads them - either wire "
                         "them or delete them, because a knob that changes nothing is worse "
                         "than an absent one")

    def test_the_scan_can_actually_fail(self):
        """The scan's own canary. If configlib.py ever creeps back into the source set, this
        fails - which is exactly what happened the first time it was written."""
        src = self._source()
        self.assertNotIn('_k("archive.enabled"', src,
                         "configlib.py is in the scanned source: the check can no longer fail")
