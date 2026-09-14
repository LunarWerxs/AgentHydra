"""stage_reply --list must answer 'what is waiting to go out', not 'everything ever'.

⛔ THE DEFECT (found 2026-09-12, while diagnosing a migration whose resume never arrived).
`--list --json` returned EVERY delivery record the machine had ever held: 178,575 characters
over 120+ rows across 15 instances, mostly `expired` and `cancelled` rows belonging to other
accounts, each carrying its full reply body plus up to 600 characters of `evidence`. It blew
the caller's token cap and was refused outright - so the single fact anyone wanted (which of
three just-migrated chats got its reply) could NOT be read from the tool that owns it, and had
to be recovered by parsing a spilled result file with a throwaway script.

Two independent things made it unreadable, so both are pinned here: the ROW COUNT (every state,
forever) and the ROW SIZE (the whole record, including fields only one row's detail view wants).
"""

from __future__ import annotations

import json
import os
import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("AGENTHYDRA_TEST", "1")

import stage_reply  # noqa: E402
from lib import deliverylib  # noqa: E402

from util import isolate_state_dir, run_cli  # noqa: E402


def row(rid: str, state: str, *, instance: str = "acct", staged_at: int = 0, **extra) -> dict:
    base = {
        "id": rid,
        "session": f"sid-{rid}",
        "title": f"chat {rid}",
        "instance": instance,
        "state": state,
        "by": "ai",
        "stagedAt": staged_at,
        "text": "x" * 4000,
        "evidence": "e" * 600,
        "verifyText": "v" * 80,
        "attempts": 0,
        "deliveredAt": None,
        "lastError": None,
    }
    base.update(extra)
    return base


class DefaultsAreTheFix(unittest.TestCase):
    """The defaults ARE the fix - a default that silently widens again is the bug returning."""

    def setUp(self):
        self.rows = [
            row("a", "staged", staged_at=300),
            row("b", "failed", staged_at=200),
            row("c", "delivered", staged_at=100),
            row("d", "cancelled", staged_at=90),
            row("e", "expired", staged_at=80),
        ]

    def test_the_default_is_the_actionable_states_only(self):
        got, total = stage_reply.select_rows(self.rows, None, None, None)
        self.assertEqual([r["id"] for r in got], ["a", "b"])
        self.assertEqual(total, 2)
        self.assertEqual(set(stage_reply.ACTIONABLE_STATES), {"staged", "failed"})

    def test_history_is_still_reachable_but_only_when_asked_for(self):
        got, total = stage_reply.select_rows(self.rows, list(stage_reply._ALL_STATES), None, None)
        self.assertEqual(total, 5)

    def test_newest_first_so_a_cap_keeps_what_matters(self):
        got, _ = stage_reply.select_rows(self.rows, list(stage_reply._ALL_STATES), None, None)
        self.assertEqual([r["id"] for r in got], ["a", "b", "c", "d", "e"])

    def test_an_instance_filter_scopes_to_one_account(self):
        rows = [row("a", "staged", instance="another_meh"), row("b", "staged", instance="temp1")]
        got, total = stage_reply.select_rows(rows, None, "another_meh", None)
        self.assertEqual([r["id"] for r in got], ["a"])
        self.assertEqual(total, 1)

    def test_the_cap_is_applied_but_the_true_count_is_still_reported(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(40)]
        got, total = stage_reply.select_rows(rows, None, None, 5)
        self.assertEqual(len(got), 5)
        self.assertEqual(total, 40, "a reader that cannot see the real count cannot trust the list")

    def test_there_is_a_default_cap_at_all(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(500)]
        got, total = stage_reply.select_rows(rows, None, None, None)
        self.assertEqual(total, 500)
        self.assertLessEqual(len(got), stage_reply._DEFAULT_LIST_LIMIT)
        self.assertGreater(len(got), 0)

    def test_limit_zero_means_no_cap_for_a_caller_that_really_wants_everything(self):
        rows = [row(str(i), "staged", staged_at=i) for i in range(100)]
        got, _ = stage_reply.select_rows(rows, None, None, 0)
        self.assertEqual(len(got), 100)


class RowSizeIsBounded(unittest.TestCase):
    """Trimming the count was not enough: 50 whole records were still 67KB."""

    def test_a_list_row_drops_the_bulky_single_row_fields(self):
        got = stage_reply._trim(row("a", "staged"))
        self.assertNotIn("evidence", got, "600 chars of the chat's words belong to one row's detail")
        self.assertNotIn("verifyText", got)

    def test_the_reply_body_is_truncated_and_says_so(self):
        got = stage_reply._trim(row("a", "staged"))
        self.assertEqual(len(got["text"]), stage_reply._LIST_TEXT_CHARS)
        self.assertTrue(got["textTruncated"])

    def test_a_short_body_is_not_marked_truncated(self):
        got = stage_reply._trim(row("a", "staged", text="short"))
        self.assertEqual(got["text"], "short")
        self.assertNotIn("textTruncated", got)

    def test_the_fields_a_reader_acts_on_survive(self):
        got = stage_reply._trim(row("a", "failed", lastError="z" * 900))
        for key in ("id", "session", "title", "instance", "state", "stagedAt"):
            self.assertIn(key, got)
        self.assertLessEqual(len(got["lastError"]), 200,
                             "an error still has to be readable without being the whole payload")

    def test_a_full_page_of_rows_stays_within_a_callers_budget(self):
        """The regression in one number: 20 projected rows must not approach the 178KB that was
        refused. Serialised size is the thing that actually broke, so measure that."""
        import json

        rows = [row(str(i), "staged", staged_at=i) for i in range(stage_reply._DEFAULT_LIST_LIMIT)]
        picked, _ = stage_reply.select_rows(rows, None, None, None)
        payload = json.dumps([stage_reply._trim(r) for r in picked])
        self.assertLess(len(payload), 20_000, f"a default --list came to {len(payload)} chars")


class ListCliCountsAgreeTest(unittest.TestCase):
    """THE LAYER THAT HAD NO COVERAGE: argv -> _parse_argv -> select_rows -> the JSON printed.

    The queue reported `--list --state all --limit 200 --json` answering `deliveries: []`
    alongside `matched: 120`. That exact split could NOT be reproduced against this code and
    select_rows() is self-consistent (the class above pins it), so nothing here pretends to fix
    a bug it cannot demonstrate. What IS pinned is the INVARIANT that split violated, at the
    level a caller actually reads: the rows handed back are exactly `shown`, and `shown` is the
    true `matched` whenever the limit is not binding. Every test above stops one call short of
    the CLI, which is where the report came from; if the counts ever split again, it shows here.
    """

    STATES = ("staged", "staged", "delivered", "failed", "cancelled", "expired")

    def setUp(self):
        isolate_state_dir(self)
        for i, state in enumerate(self.STATES):
            row = deliverylib.stage(f"sid-{i}", f"reply {i}", title=f"chat {i}",
                                    instance="temp1",
                                    evidence="the chat's own last words, long enough to verify")
            if state == "delivered":
                deliverylib.mark_delivered(row["id"])
            elif state == "failed":
                deliverylib.mark_failed(row["id"], "the composer refused")
            elif state == "cancelled":
                deliverylib.cancel(row["id"])
            elif state == "expired":
                deliverylib.expire(row["id"], "its premise went void")

    def _list(self, *argv) -> dict:
        code, out, err = run_cli(stage_reply.main, ["--list", "--json", *argv])
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_the_rows_handed_back_are_exactly_the_count_reported(self):
        for argv in ([], ["--state", "all"], ["--state", "staged"],
                     ["--state", "delivered,failed"], ["--state", "all", "--limit", "200"],
                     ["--state", "all", "--limit", "2"], ["--state", "all", "--limit", "0"],
                     ["--instance", "temp1", "--state", "all"]):
            with self.subTest(argv=argv):
                got = self._list(*argv)
                self.assertEqual(len(got["deliveries"]), got["shown"])
                self.assertLessEqual(got["shown"], got["matched"])

    def test_shown_equals_matched_whenever_the_limit_is_not_binding(self):
        for argv in ([], ["--state", "all"], ["--state", "all", "--limit", "200"],
                     ["--state", "all", "--limit", "0"]):
            with self.subTest(argv=argv):
                got = self._list(*argv)
                self.assertEqual(got["shown"], got["matched"])
                self.assertGreater(got["matched"], 0, "the fixture staged rows; none came back")

    def test_every_state_is_reachable_by_name_and_answers_with_its_own_rows(self):
        for state in stage_reply._ALL_STATES:
            with self.subTest(state=state):
                got = self._list("--state", state)
                self.assertEqual(len(got["deliveries"]), got["shown"])
                self.assertEqual(got["shown"], got["matched"])
                self.assertEqual(got["matched"], self.STATES.count(state))
                self.assertTrue(all(r["state"] == state for r in got["deliveries"]))

    def test_a_binding_limit_caps_shown_and_leaves_matched_telling_the_truth(self):
        got = self._list("--state", "all", "--limit", "2")
        self.assertEqual(len(got["deliveries"]), 2)
        self.assertEqual(got["shown"], 2)
        self.assertEqual(got["matched"], len(self.STATES))

    def test_state_all_really_does_reach_every_state(self):
        got = self._list("--state", "all")
        self.assertEqual(got["matched"], len(self.STATES))
        self.assertEqual({r["state"] for r in got["deliveries"]}, set(self.STATES))


class ParseArgvTest(unittest.TestCase):
    """The two REAL defects in _parse_argv, both silent, both found 2026-09-12."""

    def test_state_All_is_case_folded_the_way_select_rows_already_was(self):
        """select_rows lower-cases what it filters on, so `--state Staged` worked - but "all"
        was matched HERE, case-sensitively, so `--state All` set states to the literal ["all"],
        matched no row, and reported an empty list beside the full match count."""
        for word in ("all", "All", "ALL"):
            with self.subTest(word=word):
                got = stage_reply._parse_argv(["--list", "--state", word])
                self.assertEqual(got.states, list(stage_reply._ALL_STATES))

    def test_an_individual_state_name_is_case_folded_too(self):
        self.assertEqual(
            stage_reply._parse_argv(["--list", "--state", "Staged,FAILED"]).states,
            ["staged", "failed"])

    def test_a_value_flag_with_no_value_never_swallows_the_next_flag(self):
        """`--state --limit 200` ate --limit as the state to filter on, which then silently
        fell back to the DEFAULT limit: two wrong answers from one typo, neither of them said."""
        got = stage_reply._parse_argv(["--list", "--state", "--limit", "200"])
        self.assertIsNotNone(got.usage_error)
        self.assertIn("--state", got.usage_error)
        self.assertIsNone(got.states, "the flag must not be half-applied on the way out")

    def test_the_guard_is_on_EVERY_value_taking_flag_not_five_of_the_six(self):
        for flag in stage_reply._VALUE_FLAGS:
            with self.subTest(flag=flag):
                self.assertIsNotNone(stage_reply._parse_argv([flag, "--json"]).usage_error)
                self.assertIsNotNone(stage_reply._parse_argv([flag]).usage_error,
                                     "a trailing flag with nothing after it counts too")

    def test_a_limit_that_is_not_a_number_is_a_typo_rather_than_the_default(self):
        got = stage_reply._parse_argv(["--list", "--limit", "2O"])  # a letter O
        self.assertIsNotNone(got.usage_error)
        self.assertIsNone(got.limit)

    def test_bad_usage_exits_3_and_names_the_flag_that_was_wrong(self):
        code, _, err = run_cli(stage_reply.main, ["--list", "--state", "--limit", "200"])
        self.assertEqual(code, 3)
        self.assertIn("--state", err)

    def test_a_well_formed_command_line_still_parses_exactly_as_before(self):
        got = stage_reply._parse_argv(
            ["A waiting chat", "--text", "Yes, go ahead.", "--by", "michael", "--json"])
        self.assertIsNone(got.usage_error)
        self.assertEqual(got.positional, ["A waiting chat"])
        self.assertEqual(got.text, "Yes, go ahead.")
        self.assertEqual(got.by, "michael")
        self.assertTrue(got.as_json)

    def test_a_well_formed_list_command_line_still_parses(self):
        got = stage_reply._parse_argv(
            ["--list", "--state", "all", "--limit", "200", "--instance", "temp1", "--json"])
        self.assertIsNone(got.usage_error)
        self.assertTrue(got.do_list)
        self.assertEqual(got.states, list(stage_reply._ALL_STATES))
        self.assertEqual(got.limit, 200)
        self.assertEqual(got.instance, "temp1")


class DedupeFlagTest(unittest.TestCase):
    """--dedupe: for the AUTOMATIC lanes, and off for everyone else.

    The daemon stages a REFUSED `move_chats` resume against each named chat rather than
    letting the text die with the 409, and a caller who re-fires that refused call must not
    end up with two staged replies - two staged replies is two wakes into one chat. A person's
    reply is never folded into someone else's row, which is why the default stays off.

    The daemon reads `id` and `reused` off the --json payload, so both are pinned here.
    """

    MATCH = {"cliSessionId": "sid-dedupe", "title": "A waiting chat", "instance": "temp1"}
    EVIDENCE = "the chat's own last words, long enough to verify"

    def setUp(self):
        isolate_state_dir(self)

    def _stage(self, *argv) -> dict:
        """Stage through the CLI with the chat resolution stubbed - no daemon, ever."""
        with mock.patch.object(stage_reply, "_resolve_target", return_value=(self.MATCH, 0)), \
             mock.patch.object(stage_reply, "gather_evidence", return_value=self.EVIDENCE):
            code, out, err = run_cli(stage_reply.main,
                                     ["A waiting chat", "--text", "carry on", "--json", *argv])
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_dedupe_reuses_the_staged_row_instead_of_writing_a_second(self):
        first = self._stage("--dedupe")
        second = self._stage("--dedupe")
        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(len(deliverylib.all_rows()), 1, "a re-fire must not add a second wake")

    def test_without_dedupe_two_stagings_are_two_rows(self):
        first = self._stage()
        second = self._stage()
        self.assertNotEqual(second["id"], first["id"])
        self.assertFalse(second["reused"])
        self.assertEqual(len(deliverylib.all_rows()), 2,
                         "a person's reply is never folded into someone else's row")

    def test_the_json_payload_carries_id_and_reused_at_the_top_level(self):
        got = self._stage("--dedupe")
        self.assertEqual(got["id"], got["staged"]["id"])
        self.assertIs(got["reused"], False)
        self.assertIs(self._stage("--dedupe")["reused"], True)

    def test_dedupe_takes_no_value_so_it_cannot_swallow_the_next_flag(self):
        got = stage_reply._parse_argv(["a chat", "--text", "go", "--dedupe", "--json"])
        self.assertIsNone(got.usage_error)
        self.assertTrue(got.dedupe)
        self.assertTrue(got.as_json, "--json must survive being the token after --dedupe")
        self.assertEqual(got.text, "go")
        self.assertEqual(got.positional, ["a chat"])
        self.assertNotIn("--dedupe", stage_reply._VALUE_FLAGS,
                         "a value-LESS flag in _VALUE_FLAGS would eat the token after it")

    def test_dedupe_is_off_unless_it_is_asked_for(self):
        self.assertFalse(stage_reply._parse_argv(["a chat", "--text", "go"]).dedupe)


if __name__ == "__main__":
    unittest.main()
