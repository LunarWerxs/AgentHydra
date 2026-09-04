"""gatelib: the deterministic gate, including regression cases for both postmortem bugs."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import gatelib  # noqa: E402
import harvest_todos  # noqa: E402


def assistant(text=None, tool_use=None, tool_result=False, api_error=False, sidechain=False):
    content = []
    if text is not None:
        content.append({"type": "text", "text": text})
    if tool_use:
        content.append({"type": "tool_use", "name": tool_use, "input": {}})
    if tool_result:
        content.append({"type": "tool_result", "content": "ok"})
    ev = {"type": "assistant", "message": {"content": content}}
    if api_error:
        ev["isApiErrorMessage"] = True
    if sidechain:
        ev["isSidechain"] = True
    return ev


def user(text):
    return {"type": "user", "message": {"content": text}}


class TranscriptCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._tmp.cleanup()

    def transcript(self, events, age_secs=600):
        p = Path(self._tmp.name) / f"t{len(os.listdir(self._tmp.name))}.jsonl"
        p.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
        old = time.time() - age_secs
        os.utime(p, (old, old))
        return str(p)


DONE_RECAP = "All done.\n\n## What I did\n- the thing\n## Am I 100% done?\n- Yes\n## Do I recommend anything else?\n- nothing"
GHOST_RECAP = (
    "Review finished.\n## Am I 100% done?\n- Yes\n## Do I recommend anything else?\n"
    "- Say the word and I start burning item 1 (conversion attribution)."
)


class PureFunctionTest(unittest.TestCase):
    def test_done_claim_yes_no_unknown(self):
        self.assertEqual(gatelib.parse_done_claim("## Am I 100% done?\n- Yes"), "yes")
        self.assertEqual(gatelib.parse_done_claim("## Am I 100% done?\n- No, X left"), "no")
        self.assertEqual(gatelib.parse_done_claim("## Am I 100% done?\n- done except tests"), "no")
        self.assertEqual(gatelib.parse_done_claim("## Am I 100% done?\n- Yes - except a nit"), "yes")
        self.assertEqual(gatelib.parse_done_claim("no recap here"), "unknown")

    def test_recap_view_strips_fences_and_quotes(self):
        faked = "look:\n```\n## Am I 100% done?\n- Yes\n```\n> ## Am I 100% done?\n> - Yes"
        self.assertEqual(gatelib.parse_done_claim(gatelib.recap_view(faked)), "unknown")

    def test_classify_limit(self):
        self.assertEqual(gatelib.classify_limit("You have hit your weekly limit"), "quota")
        self.assertEqual(gatelib.classify_limit("HTTP 429 too many requests"), "quota")
        self.assertEqual(gatelib.classify_limit("529 overloaded, try again later"), "transient")
        self.assertIsNone(gatelib.classify_limit("some ordinary text"))
        # bare-substring parity with the daemon: no word boundaries around the status codes
        self.assertEqual(gatelib.classify_limit("HTTP429"), "quota")
        self.assertEqual(gatelib.classify_limit("err529x"), "transient")

    def test_offer_catches_common_soft_signoffs(self):
        # The review's critical case: the commonest Claude sign-off carries no '?' and none of
        # v2's literal phrases - and it is a chat waiting on a person all the same.
        for phrase in [
            "Let me know if you'd like me to continue with the next phase.",
            "If you want me to keep going, I can take item 2 next.",
            "Happy to proceed with the rollout once you confirm.",
            "Just say go and I begin.",
            "When you're ready, I can start the migration.",
        ]:
            self.assertTrue(gatelib.offers_to_continue(phrase), phrase)

    def test_plain_completion_is_not_an_offer(self):
        for phrase in [
            "All tests pass and the fix is deployed.",
            "I let the maintainers know and they merged it.",
        ]:
            self.assertFalse(gatelib.offers_to_continue(phrase), phrase)

    def test_partial_read_drops_first_line(self):
        recs = gatelib.parse_tail_records('runcated"}\n' + json.dumps(assistant("hi")), False)
        self.assertEqual(len(recs), 1)

    def test_sidechain_records_are_ignored(self):
        recs = gatelib.parse_tail_records(
            json.dumps(assistant("real")) + "\n" + json.dumps(assistant("side", sidechain=True)), True
        )
        self.assertEqual([r["text"] for r in recs], ["real"])


class GateTest(TranscriptCase):
    def test_missing_transcript_is_ungateable_not_guessed(self):
        self.assertIsNone(gatelib.gate("s", str(Path(self._tmp.name) / "nope.jsonl"), None))

    def test_done_recap_is_archive_candidate(self):
        p = self.transcript([user("go"), assistant(DONE_RECAP)])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["state"], "finished")
        self.assertEqual(v["finished"]["lane"], "archive-candidate")

    def test_ghost_case_offer_to_continue_is_never_archive(self):
        # THE regression: done-yes + no '?' + "Say the word..." archived live work twice.
        p = self.transcript([user("go"), assistant(GHOST_RECAP)])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["finished"]["lane"], "needs-input-review")
        self.assertTrue(v["finished"]["offers_to_continue"])
        self.assertIn("OFFERS TO CARRY ON", v["cause"])

    def test_a_recap_header_mentioned_in_inline_code_is_not_a_claim(self):
        # Adversarial review, 2026-08-31: a chat DISCUSSING the recap format (header in
        # backticks) must not have a done-claim parsed out of the discussion.
        text = ("The recap format uses `## Am I 100% done?` as its header.\n"
                "- Yes, that is the convention we follow.")
        self.assertEqual(gatelib.parse_done_claim(gatelib.recap_view(text)), "unknown")

    def test_trailing_question_is_needs_input(self):
        p = self.transcript([assistant("Done. ## Am I 100% done?\n- Yes\n\nDeploy it too?")])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["finished"]["lane"], "needs-input-review")

    def test_no_done_claim_is_needs_input(self):
        p = self.transcript([assistant("I fixed some of it.")])
        self.assertEqual(gatelib.gate("s", p, None)["finished"]["lane"], "needs-input-review")

    def test_interrupted_is_human_lane(self):
        p = self.transcript([assistant("working"), user("[Request interrupted by user]")])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["state"], "finished")
        self.assertEqual(v["finished"]["lane"], "human")

    def test_unanswered_user_message_is_mid_turn_crash(self):
        p = self.transcript([assistant("ok"), user("now do X")])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["state"], "crashed")
        self.assertEqual(v["crashed"]["kind"], "mid-turn")

    def test_dangling_tool_call_is_mid_turn_even_with_prefacing_text(self):
        p = self.transcript([assistant("let me check", tool_use="Bash")])
        v = gatelib.gate("s", p, None)
        self.assertEqual(v["state"], "crashed")

    def test_quota_error_is_usage_limit_crash(self):
        p = self.transcript([assistant("You have reached your weekly limit", api_error=True)])
        v = gatelib.gate("s", p, None)
        self.assertEqual((v["state"], v["crashed"]["kind"]), ("crashed", "usage-limit"))

    def test_live_quiet_completed_turn_is_idle_not_archiveable(self):
        p = self.transcript([assistant(DONE_RECAP)], age_secs=600)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertEqual(v["state"], "running")  # never anything else while a writer lives
        self.assertIsNotNone(v["idle"])
        self.assertEqual(v["idle"]["done_claim"], "yes")

    def test_live_empty_dict_still_counts_as_a_writer(self):
        # Rule 2 hangs on this: {} must not be truthiness'd into "no writer".
        p = self.transcript([assistant(DONE_RECAP)], age_secs=600)
        v = gatelib.gate("s", p, {})
        self.assertEqual(v["state"], "running")

    def test_live_recent_activity_is_just_running(self):
        p = self.transcript([assistant(DONE_RECAP)], age_secs=5)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertEqual(v["state"], "running")
        self.assertIsNone(v["idle"])
        self.assertIsNone(v["stalled"])

    def test_live_unanswered_shell_call_past_threshold_is_stalled(self):
        p = self.transcript([assistant("running it", tool_use="Bash")], age_secs=31 * 60)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertEqual(v["state"], "running")
        self.assertIsNotNone(v["stalled"])
        self.assertEqual(v["stalled"]["tool"], "Bash")

    def test_live_shell_call_recorded_before_the_engine_started_is_idle_not_stalled(self):
        # 2026-09-01, the relocated manager: a migrate re-lands a chat and claude://resume
        # boots a FRESH engine, but the transcript still ends on the OLD engine's pending
        # tool call. Read as in-flight, every wake was refused and the 30-minute stall rule
        # would have migrated it again forever. A call older than the process is an orphan.
        from datetime import datetime, timezone
        rec = assistant("running it", tool_use="Bash")
        written = time.time() - 31 * 60
        rec["timestamp"] = datetime.fromtimestamp(written, timezone.utc).isoformat().replace("+00:00", "Z")
        p = self.transcript([rec], age_secs=31 * 60)
        started_ms = int((written + 120) * 1000)  # the engine came up two minutes AFTER the call
        v = gatelib.gate("s", p, {"pid": 123, "name": "x", "startedAt": started_ms})
        self.assertEqual(v["state"], "running")
        self.assertIsNone(v["stalled"])
        self.assertIsNotNone(v["idle"])
        self.assertTrue(v["idle"]["orphaned_tool_call"])
        self.assertIn("predates this engine", v["cause"])
        # the dossier's ISO form of the same start time reads the same way
        iso = datetime.fromtimestamp(written + 120, timezone.utc).isoformat().replace("+00:00", "Z")
        v2 = gatelib.gate("s", p, {"pid": 123, "name": "x", "startedAt": iso})
        self.assertIsNone(v2["stalled"])
        self.assertTrue(v2["idle"]["orphaned_tool_call"])

    def test_live_shell_call_younger_than_the_engine_is_still_a_stall(self):
        # The same shape with the engine OLDER than the call is exactly the prompt-stall the
        # rule exists for; and a record with no timestamp never reads as orphaned.
        from datetime import datetime, timezone
        rec = assistant("running it", tool_use="Bash")
        written = time.time() - 31 * 60
        rec["timestamp"] = datetime.fromtimestamp(written, timezone.utc).isoformat().replace("+00:00", "Z")
        p = self.transcript([rec], age_secs=31 * 60)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x",
                                  "startedAt": int((written - 3600) * 1000)})
        self.assertIsNotNone(v["stalled"])
        self.assertIsNone(v["idle"])
        p2 = self.transcript([assistant("running it", tool_use="Bash")], age_secs=31 * 60)
        v3 = gatelib.gate("s", p2, {"pid": 123, "name": "x", "startedAt": int(time.time() * 1000)})
        self.assertIsNotNone(v3["stalled"])  # no record timestamp: unknown is not orphaned

    def test_live_unanswered_edit_is_not_a_stall(self):
        # Narrow to shell tools on purpose - a detector that cries wolf gets ignored.
        p = self.transcript([assistant("writing", tool_use="Edit")], age_secs=31 * 60)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertIsNone(v["stalled"])


def local_command(name):
    return user(f"<command-name>/{name}</command-name>\n<command-message>{name}</command-message>"
                "\n<command-args></command-args>")


def local_output(text):
    return user(f"<local-command-stdout>{text}</local-command-stdout>")


def compact_summary():
    return {**user("This session is being continued from a previous conversation that ran out of "
                   "context. The summary below covers the earlier portion of the conversation."),
            "isCompactSummary": True}


CAVEAT = ("Caveat: The messages below were generated by the user while running local commands. DO "
          "NOT respond to these messages or otherwise consider them in your response unless the "
          "user explicitly asks you to.")


class LocalPlumbingTailTest(TranscriptCase):
    """A transcript that ENDS on local plumbing - a slash command the app answered itself, its
    printed output, the caveat banner, or the summary a compaction wrote - has not ended
    mid-turn. Found live 2026-09-03: two chats had finished their work, written their recap and
    then been `/compact`ed; their newest record was `<local-command-stdout>Compacted`, a user-role
    record no model ever answers, so the gate read them as "may be working" for ever and nothing
    could move or archive them until a person killed the engines by hand."""

    COMPACTED = [local_command("compact"), compact_summary(), local_output("Compacted ")]

    def test_a_compact_after_the_recap_is_stripped_from_the_tail(self):
        text = "\n".join(json.dumps(e) for e in [assistant(DONE_RECAP), *self.COMPACTED]) + "\n"
        recs = gatelib.parse_tail_records(text, True)
        self.assertEqual([r["type"] for r in recs], ["assistant"])

    def test_live_chat_compacted_after_its_recap_is_idle(self):
        p = self.transcript([assistant(DONE_RECAP), *self.COMPACTED], age_secs=600)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertEqual(v["state"], "running")
        self.assertIsNotNone(v["idle"])
        self.assertEqual(v["idle"]["done_claim"], "yes")

    def test_stopped_chat_compacted_after_its_recap_is_finished_not_crashed(self):
        p = self.transcript([user("go"), assistant(DONE_RECAP), *self.COMPACTED])
        v = gatelib.gate("s", p, None)
        self.assertEqual((v["state"], v["finished"]["lane"]), ("finished", "archive-candidate"))

    def test_a_local_command_the_app_answered_itself_is_not_an_unanswered_prompt(self):
        p = self.transcript([assistant(DONE_RECAP), local_command("model"),
                             local_output("Set model to `x`")])
        self.assertEqual(gatelib.gate("s", p, None)["state"], "finished")

    def test_a_slash_command_still_awaiting_the_model_is_a_real_prompt(self):
        # No output after it: the app expanded a skill and the model has not answered.
        p = self.transcript([assistant(DONE_RECAP), local_command("wutnext")])
        v = gatelib.gate("s", p, None)
        self.assertEqual((v["state"], v["crashed"]["kind"]), ("crashed", "mid-turn"))

    def test_an_auto_compaction_summary_over_an_unanswered_prompt_is_still_mid_turn(self):
        # The summary is transparent: whatever was in flight before it is still in flight.
        p = self.transcript([assistant("ok"), user("now do X"), compact_summary()])
        self.assertEqual(gatelib.gate("s", p, None)["state"], "crashed")

    def test_the_caveat_banner_before_local_commands_is_plumbing_too(self):
        p = self.transcript([assistant(DONE_RECAP), user(CAVEAT), local_command("model"),
                             local_output("Set model to `x`")])
        self.assertEqual(gatelib.gate("s", p, None)["state"], "finished")

    def test_interior_plumbing_is_left_alone(self):
        # Only the TAIL is judged: a chat that ran /model and then kept working ends on its work.
        p = self.transcript([local_command("model"), local_output("Set model to `x`"),
                             user("go"), assistant(DONE_RECAP)])
        recs = gatelib.parse_tail_records(Path(p).read_text(encoding="utf-8"), True)
        self.assertEqual([r["type"] for r in recs], ["user", "user", "user", "assistant"])


class UsageWallIsIdleTest(TranscriptCase):
    """A chat parked at a QUOTA wall is stopped, waiting, chilling - the plainest case of it.
    The account is out of budget until reset, so the engine is not writing and cannot write.
    But the wall arrives as an api_error record, which the completed-turn test excludes, so
    such a chat read as "may be working" for as long as its engine lived and could never be
    moved OFF the exhausted account - the one move that would actually help it. Found live
    2026-09-03 on a chat sitting at "You've hit your session limit"."""

    WALL = "You've hit your session limit · resets 4:50pm (America/Chicago)"

    def test_a_live_chat_at_a_quota_wall_is_idle_and_says_why(self):
        p = self.transcript([user("go"), assistant(self.WALL, api_error=True)], age_secs=600)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertEqual(v["state"], "running")
        self.assertIsNotNone(v["idle"])
        self.assertTrue(v["idle"]["usage_wall"])
        self.assertIn("USAGE WALL", v["cause"])

    def test_a_transient_overload_is_NOT_idle(self):
        # The engine may retry a 529 on its own, and moving a chat that is about to resume
        # rewrites a live transcript. Quota only.
        p = self.transcript([user("go"), assistant("API Error: 529 overloaded_error", api_error=True)],
                            age_secs=600)
        v = gatelib.gate("s", p, {"pid": 123, "name": "x"})
        self.assertIsNone(v["idle"])

    def test_a_wall_still_needs_the_quiet_window(self):
        p = self.transcript([assistant(self.WALL, api_error=True)], age_secs=5)
        self.assertIsNone(gatelib.gate("s", p, {"pid": 123, "name": "x"})["idle"])

    def test_a_stopped_chat_at_a_wall_is_still_a_usage_limit_crash(self):
        # The no-writer branch is untouched: with no engine this is a resume candidate, and
        # that verdict is what the wake lanes act on.
        p = self.transcript([assistant(self.WALL, api_error=True)])
        v = gatelib.gate("s", p, None)
        self.assertEqual((v["state"], v["crashed"]["kind"]), ("crashed", "usage-limit"))


class DoneClaimSectionTest(unittest.TestCase):
    """done_claim_section: the one definition of where the done-claim line lives, shared by
    parse_done_claim and harvest_todos."""

    def test_first_substantive_line_with_bullet_stripped(self):
        self.assertEqual(gatelib.done_claim_section("## Am I 100% done?\n- Yes"), "Yes")

    def test_no_header_is_empty_string(self):
        self.assertEqual(gatelib.done_claim_section("no recap here"), "")

    def test_empty_section_is_empty_string(self):
        text = "## Am I 100% done?\n## Do I recommend anything else?\n- nothing"
        self.assertEqual(gatelib.done_claim_section(text), "")

    def test_strips_bullet_marker_from_a_no_line(self):
        text = ("## Am I 100% done?\n- no, the deploy step is left\n"
                "## Do I recommend anything else?\n- nothing")
        self.assertEqual(gatelib.done_claim_section(text), "no, the deploy step is left")

    def test_parse_done_claim_reads_through_done_claim_section(self):
        text = ("## Am I 100% done?\n- no, the deploy step is left\n"
                "## Do I recommend anything else?\n- nothing")
        self.assertEqual(gatelib.parse_done_claim(text), "no")


class HarvestTodosItemsFromTest(unittest.TestCase):
    """harvest_todos._items_from: the not-finished line comes from gatelib's own
    done_claim_section split, not a second copy of it."""

    def test_not_finished_item_uses_the_done_claim_section_line(self):
        verdict = {
            "state": "finished",
            "finished": {
                "interrupted": False,
                "open_recommendations": [],
                "done_claim": "no",
                "last_assistant_text": (
                    "## Am I 100% done?\n- no, the deploy step is left\n"
                    "## Do I recommend anything else?\n- nothing"
                ),
            },
        }
        items = harvest_todos._items_from(verdict)
        self.assertEqual(items[0], "Not finished: no, the deploy step is left")

    def test_done_yes_produces_no_not_finished_item(self):
        verdict = {
            "state": "finished",
            "finished": {
                "interrupted": False,
                "open_recommendations": [],
                "done_claim": "yes",
                "last_assistant_text": "## Am I 100% done?\n- Yes",
            },
        }
        self.assertEqual(harvest_todos._items_from(verdict), [])


MANAGER_TYPED = ("/orchestrate standing manager chat, started by the toolbox with bypass "
                 "permissions from birth; run the standing loop as documented")
# The desktop app's OWN record of that command - measured live 2026-09-04 on four manager
# chats. Tag order varies (local_command() above uses the other one).
MANAGER_RECORDED = ("<command-message>orchestrate</command-message>\n<command-name>/orchestrate"
                    "</command-name>\n<command-args>standing manager chat, started by the toolbox "
                    "with bypass permissions from birth; run the standing loop as documented"
                    "</command-args>")


class TaskDedupTest(unittest.TestCase):
    """first_user_prompt, normalize_task, is_boilerplate_task, same_task - the double-check
    every spawner runs before starting a chat (owner, 2026-09-01: "it can't do it blind; it
    must always double check, confirm")."""

    def _prompt_transcript(self, tmp, events):
        p = Path(tmp) / "t.jsonl"
        p.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
        return str(p)

    def test_first_user_prompt_skips_meta_and_tool_result_only_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._prompt_transcript(tmp, [
                {"type": "user", "isMeta": True, "message": {"content": "system setup"}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
                {"type": "user", "message": {"content": "Review this repo for bugs"}},
            ])
            self.assertEqual(gatelib.first_user_prompt(p), "Review this repo for bugs")

    def test_first_user_prompt_reads_text_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._prompt_transcript(tmp, [
                {"type": "user", "message": {"content": [{"type": "text", "text": "Do the thing"}]}},
            ])
            self.assertEqual(gatelib.first_user_prompt(p), "Do the thing")

    def test_first_user_prompt_with_no_real_prompt_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = self._prompt_transcript(tmp, [
                {"type": "user", "isMeta": True, "message": {"content": "x"}},
            ])
            self.assertEqual(gatelib.first_user_prompt(p), "")

    def test_first_user_prompt_reads_a_slash_command_back_as_typed(self):
        # THE SHAPE THAT HID EVERY MANAGER (2026-09-04): the app records a slash command as
        # tags, so the birth prompt never compared equal to itself, same_task_chats found no
        # existing manager, and the watchdog reborn one per account.
        with tempfile.TemporaryDirectory() as tmp:
            p = self._prompt_transcript(tmp, [
                {"type": "user", "message": {"content": MANAGER_RECORDED}}])
            self.assertEqual(gatelib.first_user_prompt(p), MANAGER_TYPED)

    def test_unwrap_command_handles_either_tag_order_no_args_and_plain_text(self):
        self.assertEqual(gatelib.unwrap_command(
            "<command-name>/wake</command-name>\n<command-message>wake</command-message>\n"
            "<command-args></command-args>"), "/wake")
        self.assertEqual(gatelib.unwrap_command("<command-name>wake</command-name>"), "/wake")
        self.assertEqual(gatelib.unwrap_command("Review this repo"), "Review this repo")
        self.assertEqual(gatelib.unwrap_command(""), "")

    def test_a_slash_command_carrying_its_task_is_a_task_not_boilerplate(self):
        self.assertFalse(gatelib.is_boilerplate_task(MANAGER_TYPED))
        self.assertFalse(gatelib.is_boilerplate_task(MANAGER_RECORDED))
        self.assertTrue(gatelib.is_boilerplate_task("/orchestrate"))
        self.assertTrue(gatelib.is_boilerplate_task(
            "<command-name>/orchestrate</command-name>\n<command-args></command-args>"))
        # the sweep opener rides a slash command too - its ARGUMENTS are still boilerplate
        self.assertTrue(gatelib.is_boilerplate_task(
            "ultracode\n\n/orchestrate The standing sweep opened this session because work waits"))

    def test_same_task_matches_the_manager_prompt_against_its_recorded_shape(self):
        self.assertTrue(gatelib.same_task(MANAGER_TYPED, MANAGER_RECORDED))
        self.assertTrue(gatelib.same_task(MANAGER_TYPED, MANAGER_TYPED))
        self.assertFalse(gatelib.same_task(MANAGER_TYPED, "/orchestrate"))

    def test_normalize_task_collapses_whitespace_and_case(self):
        self.assertEqual(gatelib.normalize_task("  Review   THIS\nrepo  "), "review this repo")

    def test_is_boilerplate_task_matches_known_prefixes(self):
        for text in ["/some-command", "<command-message>x", "the standing sweep opened this",
                     "automated watchdog nudge", "proceed with your recommendations",
                     "naming pass probe 1", "[agenthydra] wake"]:
            self.assertTrue(gatelib.is_boilerplate_task(text), text)

    def test_is_boilerplate_task_looks_past_a_leading_mode_word(self):
        self.assertTrue(gatelib.is_boilerplate_task("ultracode /some-command"))

    def test_is_boilerplate_task_false_for_a_real_prompt(self):
        self.assertFalse(gatelib.is_boilerplate_task("Review the SageThumbs codebase for bugs"))

    def test_is_boilerplate_task_catches_the_sweep_phrase_anywhere_in_the_first_300_chars(self):
        self.assertTrue(gatelib.is_boilerplate_task(
            "Some preface. the standing sweep opened this session to look at things."))

    def test_same_task_equal_normalized_text(self):
        a = "Review the SageThumbs codebase end to end for correctness bugs"
        self.assertTrue(gatelib.same_task(a, a.upper()))

    def test_same_task_never_when_either_is_boilerplate(self):
        a = "Review the SageThumbs codebase end to end for correctness bugs"
        self.assertFalse(gatelib.same_task(a, "/wake"))

    def test_same_task_never_when_the_shorter_is_under_40_chars(self):
        self.assertFalse(gatelib.same_task("Review this", "Review this please and thanks"))

    def test_same_task_path_prefix_variant_matches(self):
        a = "D:\\x\\app Review this whole codebase for correctness issues"
        b = "Review this whole codebase for correctness issues"
        self.assertTrue(gatelib.same_task(a, b))

    def test_same_task_path_suffix_variant_matches(self):
        a = "Review this whole codebase for correctness issues, save to a file."
        b = "Review this whole codebase for correctness issues, save to a file. d:\\newprojects\\x"
        self.assertTrue(gatelib.same_task(a, b))

    def test_same_task_extra_words_are_not_the_same_task(self):
        a = "Review this whole codebase for correctness issues thoroughly"
        b = ("Review this whole codebase for correctness issues thoroughly, then deploy the "
             "fix to production and email the team")
        self.assertFalse(gatelib.same_task(a, b))

    def test_same_task_shared_85_percent_of_the_longer_counts(self):
        # the extra word is small relative to the whole, and is not path-shaped either
        a = "Review the whole SageThumbs codebase end to end for bugs"
        b = "Review the whole SageThumbs codebase end to end for bugs now"
        self.assertTrue(gatelib.same_task(a, b))


if __name__ == "__main__":
    unittest.main()
