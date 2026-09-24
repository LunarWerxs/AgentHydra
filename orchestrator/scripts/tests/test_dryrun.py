"""dryrun.py: the harness that proves the loop works has to be provable itself.

The flap detector is the part worth testing hardest. It is the whole reason to run fifty loops
instead of one, and it has exactly one job that a naive version gets wrong: tell a verdict that
MOVED (the fleet went forward) from a verdict that FLAPPED (the same chat changed and changed
back, so some lane's answer depends on timing). Only the second is a bug, and a detector that
called every change a flap would bury it in noise on a live fleet.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import dryrun  # noqa: E402


def row(decisions: dict, secs=1.0, exit_code=0, timings=None):
    return {"ok": exit_code == 0, "exit": exit_code, "secs": secs, "why": "",
            "stages": {"decisions": decisions,
                       "gate": {"scanned": len(decisions), "complete": True},
                       "lanes": {k: {"would": 0, "overCap": 0}
                                 for k in ("archive", "moves", "landConsole", "deliver")},
                       "judgmentQueue": [], "onHold": [], "timings": timings or {"buildPlan": secs}}}


class FlapTest(unittest.TestCase):
    def test_a_stable_fleet_has_no_flaps(self):
        rows = [row({"a": "archive", "b": "leave-alone"}) for _ in range(5)]
        self.assertEqual(dryrun.find_flaps(rows), [])

    def test_a_legitimate_change_is_not_a_flap(self):
        """A chat that starts running, finishes, or gets archived legitimately changes lane -
        once, in one direction, possibly through several lanes; and new chats start mid-run
        all the time on a live fleet. Calling any of that a bug would make the detector useless."""
        cases = {
            "moves once and stays": [row({"a": "leave-alone"}), row({"a": "leave-alone"}),
                                     row({"a": "archive"}), row({"a": "archive"})],
            "monotone walk through three lanes": [row({"a": "resume"}), row({"a": "judgment"}),
                                                  row({"a": "archive"})],
            "appears partway through": [row({"a": "archive"}),
                                        row({"a": "archive", "b": "judgment"}),
                                        row({"a": "archive", "b": "judgment"})],
        }
        for name, rows in cases.items():
            with self.subTest(name):
                self.assertEqual(dryrun.find_flaps(rows), [])

    def test_a_verdict_that_changes_and_changes_back_IS_a_flap(self):
        rows = [row({"a": "archive"}), row({"a": "judgment"}), row({"a": "archive"})]
        flaps = dryrun.find_flaps(rows)
        self.assertEqual(len(flaps), 1)
        self.assertEqual(flaps[0]["sessionId"], "a")
        self.assertIn("archive@0", flaps[0]["path"])
        self.assertIn("judgment@1", flaps[0]["path"])

    def test_a_three_way_cycle_is_a_flap_too(self):
        rows = [row({"a": "archive"}), row({"a": "judgment"}),
                row({"a": "resume"}), row({"a": "judgment"})]
        self.assertEqual(len(dryrun.find_flaps(rows)), 1)


class SummaryTest(unittest.TestCase):
    def test_a_crashed_run_is_counted_not_swallowed(self):
        rows = [row({"a": "archive"}),
                {"ok": False, "exit": None, "secs": 900.0, "why": "TIMED OUT", "stages": None}]
        s = dryrun.summarize(rows)
        self.assertEqual(s["runs"], 2)
        self.assertEqual(s["completed"], 1)
        self.assertEqual(s["crashed"], 1)
        self.assertTrue(any("TIMED OUT" in p["why"] for p in s["problems"]))

    def test_exit_two_is_a_finding_not_a_harness_fault(self):
        """The loop's own 'something failed' code. It must be reported as a run that
        COMPLETED and as a problem - counting it as a crash would hide what it found."""
        bad = row({"a": "archive"}, exit_code=2)
        bad["ok"] = False
        bad["why"] = "the chat read was INCOMPLETE"
        s = dryrun.summarize([row({"a": "archive"}), bad])
        self.assertEqual(s["completed"], 2)
        self.assertEqual(s["crashed"], 0)
        self.assertEqual(s["exitTwo"], 1)

    def test_count_ranges_show_movement_without_calling_it_a_failure(self):
        a, b = row({"a": "x"}), row({"a": "x", "b": "y"})
        s = dryrun.summarize([a, b])
        self.assertEqual(s["countRange"]["chats"], (1, 2))

    def test_stage_timings_are_aggregated_across_runs(self):
        rows = [row({"a": "x"}, timings={"buildPlan": 2.0, "balance": 1.0}),
                row({"a": "x"}, timings={"buildPlan": 4.0, "balance": 1.0})]
        s = dryrun.summarize(rows)
        self.assertEqual(s["stageSecs"]["buildPlan"]["max"], 4.0)
        self.assertEqual(s["stageSecs"]["balance"]["median"], 1.0)

    def test_render_never_raises_on_an_empty_run_set(self):
        self.assertIn("DRY RUN HARNESS", dryrun.render(dryrun.summarize([])))


class MatrixSpecTest(unittest.TestCase):
    def test_every_variant_names_only_real_knobs(self):
        from lib import configlib
        for spec in dryrun.MATRIX:
            for key in spec["overrides"]:
                with self.subTest(spec["name"], key=key):
                    self.assertIn(key, configlib.BY_KEY)

    def test_a_variant_either_expects_something_or_says_why_it_cannot(self):
        """⛔ THE RULE THE FIRST VERSION BROKE. A variant with no expectation and no
        explanation is a variant that passes for free, which is how natural drift got read as
        proof the policy was wired."""
        for spec in dryrun.MATRIX:
            if spec["name"] == "baseline":
                continue
            with self.subTest(spec["name"]):
                if spec.get("sees_plan"):
                    self.assertTrue(callable(spec.get("expect")),
                                    "a plan-visible variant must declare what it changes")
                else:
                    self.assertIn("Covered by", spec.get("why", ""),
                                  "a variant the dry loop cannot see must name the test that "
                                  "covers it instead")

    def test_every_variant_explains_itself(self):
        for spec in dryrun.MATRIX:
            if spec["name"] != "baseline":
                self.assertGreater(len(spec.get("why", "")), 30, spec["name"])


def view(decisions=None, dissent=None, shown=0, over=0):
    return {"counts": {"landConsole": shown, "landConsoleOver": over},
            "decisions": decisions or {}, "dissent": dissent or {}}


class MatrixExpectationTest(unittest.TestCase):
    """⛔ An expectation that an INERT knob can satisfy is worth nothing. The second version of
    the matrix had two: a cap passed when the lane "stayed where it was", and a signal passed
    when archive candidates stayed "the same or more". Each case below is an inert knob, and
    each must fail or say it cannot tell."""

    def test_a_cap_nothing_reads_fails(self):
        # 46 waiting, default cap 5 still in force: an inert cap of 1 shows 5.
        ok, said = dryrun._expect_lane_cap("landConsole", 1)(None, view(shown=5, over=41))
        self.assertIs(ok, False, said)

    def test_a_wired_cap_passes(self):
        check = dryrun._expect_lane_cap("landConsole", 1)
        self.assertIs(check(None, view(shown=1, over=45))[0], True)
        self.assertIs(dryrun._expect_lane_cap("landConsole", 25)(None, view(shown=25, over=21))[0],
                      True)
        self.assertIs(dryrun._expect_lane_cap("landConsole", 25)(None, view(shown=5, over=41))[0],
                      False)

    def test_a_cap_with_too_little_waiting_is_inconclusive_not_a_pass(self):
        ok, said = dryrun._expect_lane_cap("landConsole", 25)(None, view(shown=3, over=0))
        self.assertIsNone(ok, said)
        self.assertIsNone(dryrun._expect_lane_cap("landConsole", 1)(None, view(shown=1))[0])

    def test_a_signal_nothing_reads_fails(self):
        base = view({"a": "wait-on-person", "b": "wait-on-person"},
                    {"a": ["offer"], "b": ["done_claim", "offer"]})
        inert = view({"a": "wait-on-person", "b": "wait-on-person"})
        ok, said = dryrun._expect_signals_release("offer")(base, inert)
        self.assertIs(ok, False)
        self.assertIn("STILL WAITING", said)

    def test_a_wired_signal_releases_exactly_the_chats_it_alone_held(self):
        base = view({"a": "wait-on-person", "b": "wait-on-person"},
                    {"a": ["offer"], "b": ["done_claim", "offer"]})
        wired = view({"a": "archive", "b": "wait-on-person"})
        ok, said = dryrun._expect_signals_release("offer")(base, wired)
        self.assertIs(ok, True, said)
        self.assertIn("1 of 1", said)

    def test_the_breaker_holding_a_released_chat_still_counts_as_released(self):
        base = view({"a": "wait-on-person"}, {"a": ["question"]})
        self.assertIs(dryrun._expect_signals_release("question")(
            base, view({"a": "held-back"}))[0], True)

    def test_a_chat_the_fleet_moved_is_not_blamed_on_the_knob(self):
        base = view({"a": "wait-on-person", "b": "wait-on-person"},
                    {"a": ["offer"], "b": ["offer"]})
        got = view({"a": "archive", "b": "leave-alone"})  # b was woken between the runs
        self.assertIs(dryrun._expect_signals_release("offer")(base, got)[0], True)

    def test_nothing_to_release_is_inconclusive_not_a_pass(self):
        base = view({"a": "wait-on-person"}, {"a": ["done_claim"]})
        ok, said = dryrun._expect_signals_release("offer")(base, view({"a": "wait-on-person"}))
        self.assertIsNone(ok, said)

    def test_the_slow_path_names_every_disagreement(self):
        ok, said = dryrun._expect_same_liveness(
            view({"a1234567x": "archive", "b": "leave-alone"}),
            view({"a1234567x": "leave-alone", "b": "leave-alone"}))
        self.assertTrue(ok)
        self.assertIn("1 decision(s) differ", said)
        self.assertIn("a1234567 archive->leave-alone", said)



class FlapSeverityTest(unittest.TestCase):
    """A flap between the two LIVE states is expected; anything else is a defect.

    Found live 2026-09-17: the first 50-run pass flagged exactly one chat, and it turned out
    to be writing to its transcript every few seconds and simply pausing past the 180s idle
    window twice. Both 'leave-alone' and 'judgment' mean a writer is alive, so neither can
    archive or move anything - calling that a bug would make the harness red on every pass
    with a busy chat on the fleet, and a harness that is always red is one nobody reads."""

    def _flap(self, kinds):
        return dryrun.find_flaps([row({"a": k}) for k in kinds])[0]

    def test_idle_oscillation_on_a_live_chat_is_not_serious(self):
        f = self._flap(["leave-alone", "judgment", "leave-alone"])
        self.assertFalse(f["serious"])
        self.assertIn("idle threshold", f["why"])

    def test_anything_touching_an_acting_verdict_is_serious(self):
        for kinds in (["archive", "judgment", "archive"],
                      ["wait-on-person", "archive", "wait-on-person"],
                      ["resume", "leave-alone", "resume"]):
            with self.subTest(kinds=kinds):
                self.assertTrue(self._flap(kinds)["serious"])

    def test_a_benign_flap_alone_does_not_fail_the_run(self):
        s = dryrun.summarize([row({"a": "leave-alone"}), row({"a": "judgment"}),
                              row({"a": "leave-alone"})])
        self.assertTrue(s["flaps"])
        self.assertFalse([f for f in s["flaps"] if f["serious"]])
        text = dryrun.render(s)
        self.assertIn("expected, not a defect", text)
        self.assertNotIn("FLAPPED on a verdict that can ACT", text)

    def test_a_serious_flap_is_shouted_about(self):
        s = dryrun.summarize([row({"a": "archive"}), row({"a": "judgment"}),
                              row({"a": "archive"})])
        self.assertIn("FLAPPED on a verdict that can ACT", dryrun.render(s))

if __name__ == "__main__":
    unittest.main()
