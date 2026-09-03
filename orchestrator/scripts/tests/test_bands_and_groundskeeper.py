"""The usage bands as a SHARED door, the per-account spread ceiling, and the groundskeeper -
the lane that moves stranded chats off a cooked account and archives the ones that are done.

These exist because of two owner reports on 2026-09-01: "one of my accounts hit 100% on the 5
hour - thought you had rules against that" (the bands were checked in exactly one lane, so
every other lane fed accounts freely), and "multiple of my accounts have dormant chats just
sitting there not running or archived" (nothing ever STARTED an archive, and chats stranded on
a hot account were skipped by the only lane that looked at them).
"""

import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

import groundskeeper  # noqa: E402
from lib import armlib  # noqa: E402
from lib import bandlib  # noqa: E402
from lib import gatelib  # noqa: E402
from lib import hydralib  # noqa: E402

from util import run_cli  # noqa: E402

DONE = ("All set.\n## What I did\n- fixed it\n## Am I 100% done?\n- Yes, everything is done.\n"
        "## Do I recommend anything else?\n- nothing")
OFFERS = ("Here is the result.\n## Am I 100% done?\n- No, the deploy step is still open.\n"
          "## Do I recommend anything else?\n- I can run the deploy next if you want.")


class UnblockPromptsTest(unittest.TestCase):
    """Chats that stopped on a permission prompt they should never have been shown (owner,
    2026-09-01: "four chats currently pending on someone to push enter, because they're not
    set to the proper bypass permissions"). The eligibility rule is the whole safety story."""

    def setUp(self):
        import unblock_prompts

        self.mod = unblock_prompts
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "acct", "dir": str(self.root / "acct"), "isRunning": True}]}
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [{"sessionId": "s1"}]}
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self.stub.close()
        self._tmp.cleanup()
        self._state.cleanup()

    def _chat(self, sid, mode, pending=True, quiet=1800):
        d = self.root / "acct" / "claude-code-sessions" / "a" / "b"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"local_{sid}.json").write_text(json.dumps(
            {"cliSessionId": sid, "isArchived": False, "title": f"Chat {sid}",
             "permissionMode": mode}), encoding="utf-8")
        proj = self.root / "acct" / "projects" / "p"
        proj.mkdir(parents=True, exist_ok=True)
        # A real chat's last words are a sentence, not a token: the identity proof (rail 2b,
        # 2026-09-01) derives the verify text from these, and a chat with nothing distinctive
        # in its tail is deliberately NOT eligible - see test_unblock_prompts for that case.
        content = [{"type": "text", "text": f"working on {sid}: running the build now to check"}]
        if pending:
            content.append({"type": "tool_use", "name": "Bash", "input": {}})
        tp = proj / f"{sid}.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": content}}) + "\n",
                      encoding="utf-8")
        old = time.time() - quiet
        os.utime(tp, (old, old))

    def test_a_bypass_chat_stuck_on_a_prompt_is_eligible(self):
        self._chat("s1", "bypassPermissions")
        stuck = self.mod.find_stuck()
        self.assertEqual(len(stuck), 1)
        self.assertTrue(stuck[0]["eligible"])
        self.assertIn("running the build", stuck[0]["verify"])  # its own words are the proof

    def test_a_chat_NOT_configured_bypass_is_reported_but_never_answered(self):
        # Answering here would be inventing consent - that prompt is genuinely a person's call.
        self._chat("s1", "acceptEdits")
        stuck = self.mod.find_stuck()
        self.assertEqual(len(stuck), 1)
        self.assertFalse(stuck[0]["eligible"])

    def test_a_held_chat_is_never_answered(self):
        from lib import holdlib

        self._chat("s1", "bypassPermissions")
        holdlib.hold("s1", "owner is driving it")
        self.assertFalse(self.mod.find_stuck()[0]["eligible"])

    def test_a_chat_that_finished_its_turn_is_not_stuck(self):
        self._chat("s1", "bypassPermissions", pending=False)
        self.assertEqual(self.mod.find_stuck(), [])

    def test_a_command_that_only_just_started_is_left_to_run(self):
        # An unanswered tool call seconds old is a command running, not a prompt waiting.
        self._chat("s1", "bypassPermissions", quiet=30)
        self.assertEqual(self.mod.find_stuck(), [])


class BandDoorTest(unittest.TestCase):
    SNAP = {"bands": {"hot": "over-hard", "warm": "over-soft", "cool": "ok"}, "accounts": []}

    def test_a_cooked_account_may_not_take_more_work(self):
        for name in ("hot", "warm"):
            ok, why = bandlib.may_take_work(name, self.SNAP)
            self.assertFalse(ok)
            self.assertIn(name, why)

    def test_a_healthy_or_unmeasured_account_is_not_blocked(self):
        # 'unknown' is deliberately NOT a closed band: a survey hiccup must not stall the fleet.
        self.assertTrue(bandlib.may_take_work("cool", self.SNAP)[0])
        self.assertTrue(bandlib.may_take_work("never-surveyed", self.SNAP)[0])
        self.assertTrue(bandlib.may_take_work("cool", None)[0])

    def test_the_share_splits_the_floor_and_stays_inside_sane_bounds(self):
        self.assertEqual(bandlib.per_account_share(5, 18), 4)   # the live fleet's shape
        self.assertEqual(bandlib.per_account_share(1, 18), 5)   # one account never takes 18
        self.assertEqual(bandlib.per_account_share(20, 18), 2)  # nor does it thrash at 1
        self.assertEqual(bandlib.per_account_share(0, 18), 2)

    def test_a_broken_survey_yields_an_empty_snapshot_not_a_crash(self):
        with mock.patch.object(hydralib, "fleet", side_effect=hydralib.DaemonError("/x", 500, "")):
            snap = bandlib.snapshot()
        self.assertEqual(snap["bands"], {})
        self.assertTrue(bandlib.may_take_work("anything", snap)[0])


class CourierBandGuardTest(unittest.TestCase):
    """The guard lives in deliverable(), the one door every staged reply goes through."""

    def setUp(self):
        import courier
        from lib import deliverylib

        self.courier = courier
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self._tmp = tempfile.TemporaryDirectory()
        self.tp = Path(self._tmp.name) / "t.jsonl"
        self.tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": OFFERS}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 600
        os.utime(self.tp, (old, old))

        self.sid = "aaaa1111-2222-3333-4444-555566667777"
        self.live = None
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/chats/dossier"] = lambda *a: {"matches": [
            {"instance": "hot", "chatId": "c1", "cliSessionId": self.sid, "lineageIds": [self.sid],
             "title": "A stranded chat", "archived": False, "live": self.live}]}
        self.stub.routes["/api/sessions"] = [
            {"session_id": self.sid, "archived": False, "title": "A stranded chat",
             "instance": "hot", "transcript_path": str(self.tp)}]
        self.entry = deliverylib.stage(self.sid, "carry on", title="A stranded chat",
                                       instance="hot", evidence=OFFERS)

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_no_reply_is_delivered_into_an_account_past_its_usage_target(self):
        snap = {"bands": {"hot": "over-hard"}, "accounts": []}
        ok, why, _ = self.courier.deliverable(self.entry, _bands=snap)
        self.assertFalse(ok)
        self.assertIn("HARD gate", why)
        self.assertIn("staged, not lost", why)

    def test_the_same_reply_goes_out_once_the_account_is_healthy(self):
        ok, why, _ = self.courier.deliverable(
            self.entry, _bands={"bands": {"hot": "ok"}, "accounts": []})
        self.assertTrue(ok, why)

    def test_a_dormant_chat_is_not_woken_on_an_account_already_at_its_share(self):
        snap = {"bands": {"hot": "ok"}, "accounts": []}
        ok, why, _ = self.courier.deliverable(self.entry, _bands=snap,
                                              _per_instance={"hot": 4}, _share=4)
        self.assertFalse(ok)
        self.assertIn("hogging", why)

    def test_but_a_chat_that_is_ALREADY_running_still_gets_its_reply(self):
        # Answering a live chat adds a turn, not a runner - the share ceiling counts runners,
        # so capping it here would strand the very chats that are working.
        self.live = {"pid": 4242, "name": "w"}
        snap = {"bands": {"hot": "ok"}, "accounts": []}
        ok, why, _ = self.courier.deliverable(self.entry, _bands=snap,
                                              _per_instance={"hot": 9}, _share=4)
        self.assertTrue(ok, why)


class DoctrineBeforeTheWakeTest(unittest.TestCase):
    """A dormant chat is stamped bypassPermissions + ultracode in the instant before the send
    boots it - the only moment the stamp is durable (owner, 2026-09-01: "not setting bypass
    permissions... when a chat asks for permission to run something because you forgot")."""

    def setUp(self):
        import courier

        self.courier = courier
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/sessions/x/automation"] = {"ok": True, "mode": "bypassPermissions"}

    def tearDown(self):
        self.stub.close()

    def test_a_dormant_chat_is_stamped_before_it_is_woken(self):
        with mock.patch("lib.stamplib.stamp_doctrine",
                        return_value={"bypass": True, "ultracode": True, "error": None,
                                      "changed": True}) as stamp:
            note = self.courier._ensure_doctrine("x", {"live": None, "metaPath": "m.json"})
        self.assertEqual(note, "")  # nothing to report means both stamps landed
        stamp.assert_called_once_with("m.json")
        self.assertIn("/api/sessions/x/automation", [p for p, _b in self.stub.posts])

    def test_a_LIVE_chat_is_not_stamped_because_its_app_would_re_save_it_away(self):
        with mock.patch("lib.stamplib.stamp_doctrine") as stamp:
            self.courier._ensure_doctrine("x", {"live": {"pid": 1}, "metaPath": "m.json"})
        stamp.assert_not_called()
        self.assertEqual(self.stub.posts, [])

    def test_a_failed_stamp_is_reported_and_never_cancels_the_delivery(self):
        self.stub.routes["/api/sessions/x/automation"] = (422, {"ok": False})
        with mock.patch("lib.stamplib.stamp_doctrine", side_effect=OSError("locked")):
            note = self.courier._ensure_doctrine("x", {"live": None, "metaPath": "m.json"})
        self.assertIn("bypass stamp", note)
        self.assertIn("stamp failed", note)


class TwinAuditTest(unittest.TestCase):
    """A chat visible in two places at once (owner, 2026-09-01: "it's also duplicating
    chats"). Firing the app's resume deeplink at a profile that already carries the chat makes
    a SECOND record - and from then on the sidebar actuator refuses to act on either, because
    it identifies rows by title. Four were live on the fleet when this was written."""

    def setUp(self):
        import audit_twins

        self.mod = audit_twins
        self._tmp = tempfile.TemporaryDirectory()
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/sessions"] = []
        self.stub.routes["/api/fleet"] = {"instances": []}
        # A stale copy under a running app is archived through the app's own control since
        # 2026-09-01; here no app exists, so the drive answers "not rendered" and the disk
        # flag path these tests pin runs as before.
        drive = mock.patch.object(audit_twins, "_drive_archive", return_value=(3, "not rendered"))
        drive.start()
        self.addCleanup(drive.stop)

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def _meta(self, instance, stem, cli, archived=False, title="A chat"):
        d = Path(self._tmp.name) / instance / "claude-code-sessions" / "a" / "b"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{stem}.json").write_text(json.dumps(
            {"cliSessionId": cli, "isArchived": archived, "title": title}), encoding="utf-8")
        names = sorted({*(x["name"] for x in self.stub.routes["/api/fleet"]["instances"]),
                        instance})
        self.stub.routes["/api/fleet"]["instances"] = [
            {"num": n + 1, "name": name, "dir": str(Path(self._tmp.name) / name),
             "isRunning": True}
            for n, name in enumerate(names)]
        return d / f"{stem}.json"

    def test_a_second_record_in_the_SAME_instance_is_the_re_import_artefact(self):
        self._meta("one", "local_S1", "S1")
        self._meta("one", "local_OTHER", "S1")
        self.stub.routes["/api/sessions"] = [{"session_id": "S1", "instance": "one"}]
        twins = self.mod.find_twins()
        self.assertEqual(len(twins), 1)
        self.assertEqual(twins[0]["keep"]["stem"], "local_S1")  # named for its own session id
        self.assertEqual([s["stem"] for s in twins[0]["stale"]], ["local_OTHER"])

    def test_the_copy_left_behind_by_a_migration_is_the_stale_one(self):
        self._meta("old", "local_S2", "S2")
        self._meta("new", "local_S2", "S2")
        self.stub.routes["/api/sessions"] = [{"session_id": "S2", "instance": "new"}]
        twins = self.mod.find_twins()
        self.assertEqual(twins[0]["keep"]["instance"], "new")

    def test_an_archived_copy_is_not_a_twin(self):
        self._meta("one", "local_S3", "S3")
        self._meta("two", "local_S3", "S3", archived=True)
        self.assertEqual(self.mod.find_twins(), [])

    def test_it_refuses_rather_than_guess_when_neither_rule_picks_a_copy(self):
        self._meta("one", "local_A", "S4")
        self._meta("two", "local_B", "S4")
        self.stub.routes["/api/sessions"] = [{"session_id": "S4", "instance": "elsewhere"}]
        twins = self.mod.find_twins()
        self.assertIsNone(twins[0]["keep"])
        out = self.mod.fix(twins)
        self.assertIn("REFUSED", out[0]["outcome"])

    def test_a_HELD_chats_stale_twin_is_still_tidied_and_the_real_copy_kept(self):
        # A hold protects the chat, not a stale duplicate of it. While a twin exists that chat
        # is unactionable by every actuator (they identify rows by title), which serves nobody.
        from lib import holdlib

        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            keep = self._meta("one", "local_S5", "S5")
            dup = self._meta("one", "local_DUP", "S5")
            self.stub.routes["/api/sessions"] = [{"session_id": "S5", "instance": "one"}]
            holdlib.hold("S5", "owner is reading it")
            out = self.mod.fix(self.mod.find_twins())
            self.assertIn("archived the stale copy", out[0]["outcome"])
            self.assertTrue(json.loads(dup.read_text(encoding="utf-8"))["isArchived"])
            self.assertFalse(json.loads(keep.read_text(encoding="utf-8"))["isArchived"])
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()

    def test_fix_without_an_armed_window_refuses_and_settles_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --fix alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            self._meta("one", "local_A", "S6")
            dup = self._meta("one", "local_DUP6", "S6")
            self.stub.routes["/api/sessions"] = [{"session_id": "S6", "instance": "one"}]
            with mock.patch.object(self.mod, "fix") as m:
                code, out, _ = run_cli(self.mod.main, ["--fix"])
            m.assert_not_called()
            self.assertEqual(code, 0)
            self.assertIn("DISARMED", out)
            self.assertFalse(json.loads(dup.read_text(encoding="utf-8"))["isArchived"])
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()

    def test_fix_with_an_armed_window_settles_as_before(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            armlib.arm(3600)
            keep = self._meta("one", "local_S7", "S7")
            dup = self._meta("one", "local_DUP7", "S7")
            self.stub.routes["/api/sessions"] = [{"session_id": "S7", "instance": "one"}]
            code, out, _ = run_cli(self.mod.main, ["--fix"])
            self.assertEqual(code, 0)
            self.assertNotIn("DISARMED", out)
            self.assertTrue(json.loads(dup.read_text(encoding="utf-8"))["isArchived"])
            self.assertFalse(json.loads(keep.read_text(encoding="utf-8"))["isArchived"])
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()

    def test_lineage_merges_two_different_cli_ids_into_one_twin(self):
        # A compaction/resume rolls the cli session id, and the dossier's lineageIds says two
        # ids are the SAME conversation - so two visible records under different ids (a rolled
        # cli id) must still be one twin group, not two untouched chats.
        self._meta("one", "local_A", "A")
        self._meta("two", "local_B", "B")
        self.stub.routes["/api/sessions"] = [{"session_id": "A", "instance": "one"}]

        def dossier_route(method, path, query, body):
            q = dossier_query(query)
            if q == "A":
                return {"matches": [{"cliSessionId": "A", "lineageIds": ["A", "B"]}]}
            return {"matches": []}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        twins = self.mod.find_twins()
        self.assertEqual(len(twins), 1)
        self.assertEqual(len(twins[0]["copies"]), 2)


class SameTaskAuditTest(unittest.TestCase):
    """audit_twins.find_same_task/fix_same_task: a DIFFERENT kind of duplicate from a twin
    record - two separate chats started for the same task (owner, 2026-09-01: two identical
    'SageThumbs codebase review' chats, 30 minutes apart, both running - "we can't have
    this... it must always double check, confirm"). The remedy is a HOLD, never an archive."""

    TASK = "Review the SageThumbs codebase end to end for correctness bugs"

    def setUp(self):
        import audit_twins

        self.mod = audit_twins
        self._tmp = tempfile.TemporaryDirectory()
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/fleet"] = {"instances": []}

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def _transcript(self, name, prompt):
        p = Path(self._tmp.name) / f"{name}.jsonl"
        p.write_text(json.dumps({"type": "user", "message": {"content": prompt}}) + "\n",
                     encoding="utf-8")
        return str(p)

    def test_two_chats_with_the_same_first_prompt_form_a_group(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "a1", "title": "Chat A", "instance": "one", "archived": False,
             "transcript_path": self._transcript("a1", self.TASK), "created_at": 100},
            {"session_id": "b2", "title": "Chat B", "instance": "two", "archived": False,
             "transcript_path": self._transcript("b2", self.TASK), "created_at": 200},
        ]
        groups = self.mod.find_same_task()
        self.assertEqual(len(groups), 1)
        g = groups[0]
        self.assertEqual(g["keep"]["sessionId"], "a1")  # earliest createdAt
        self.assertEqual([c["sessionId"] for c in g["later"]], ["b2"])

    def test_a_short_or_boilerplate_prompt_never_forms_a_group(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "a1", "title": "A", "instance": "one", "archived": False,
             "transcript_path": self._transcript("a1", "hi")},
            {"session_id": "b2", "title": "B", "instance": "one", "archived": False,
             "transcript_path": self._transcript("b2", "hi")},
        ]
        self.assertEqual(self.mod.find_same_task(), [])

    def test_fix_holds_the_later_copy_and_reports_an_already_held_one(self):
        from lib import holdlib

        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            keep = {"sessionId": "a1", "title": "Chat A", "instance": "one"}
            later1 = {"sessionId": "b2", "title": "Chat B", "instance": "two"}
            later2 = {"sessionId": "c3", "title": "Chat C", "instance": "three"}
            holdlib.hold("c3", "already on hold")
            groups = [{"task": "x", "chats": [keep, later1, later2], "keep": keep,
                      "later": [later1, later2]}]
            out = self.mod.fix_same_task(groups)
            self.assertIn("HELD as a duplicate of 'Chat A'", out[0]["outcome"])
            self.assertIn("DUPLICATE TASK", holdlib.why_blocked("b2"))  # the hold's own reason
            self.assertEqual(out[1]["outcome"], "already held")
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()

    def test_main_reports_same_task_duplicates_with_keep_and_dup_tags(self):
        self.stub.routes["/api/sessions"] = [
            {"session_id": "a1", "title": "Chat A", "instance": "one", "archived": False,
             "transcript_path": self._transcript("a1", self.TASK), "created_at": 100},
            {"session_id": "b2", "title": "Chat B", "instance": "two", "archived": False,
             "transcript_path": self._transcript("b2", self.TASK), "created_at": 200},
        ]
        code, out, _ = run_cli(self.mod.main, [])
        self.assertEqual(code, 2)
        self.assertIn("task(s) started MORE THAN ONCE", out)
        self.assertIn("[KEEP ]", out)
        self.assertIn("[DUP  ]", out)

    def test_fix_with_an_armed_window_holds_the_duplicate(self):
        from lib import holdlib

        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            armlib.arm(3600)
            self.stub.routes["/api/sessions"] = [
                {"session_id": "a1", "title": "Chat A", "instance": "one", "archived": False,
                 "transcript_path": self._transcript("a1", self.TASK), "created_at": 100},
                {"session_id": "b2", "title": "Chat B", "instance": "two", "archived": False,
                 "transcript_path": self._transcript("b2", self.TASK), "created_at": 200},
            ]
            code, out, _ = run_cli(self.mod.main, ["--fix"])
            self.assertEqual(code, 0)
            self.assertTrue(holdlib.why_blocked("b2"))
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()


class DoneBarAuditTest(unittest.TestCase):
    """The whole-history sweep for chats archived before they were done. Its two traps both
    produced a scary and WRONG list on the first cut, so both are pinned here."""

    def setUp(self):
        import audit_done_bar

        self.mod = audit_done_bar
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/fleet"] = {"instances": []}
        self._home = self.mod.Path.home
        # keep the real user's ~/.claude/projects out of a unit test
        self.mod.Path.home = staticmethod(lambda: self.root / "nohome")

    def tearDown(self):
        self.mod.Path.home = self._home
        self.stub.close()
        self._tmp.cleanup()

    def _chat(self, instance, cli, text, title, archived=True):
        d = self.root / instance / "claude-code-sessions" / "a" / "b"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"local_{cli}.json").write_text(json.dumps(
            {"cliSessionId": cli, "isArchived": archived, "title": title}), encoding="utf-8")
        proj = self.root / instance / "projects" / "p"
        proj.mkdir(parents=True, exist_ok=True)
        (proj / f"{cli}.jsonl").write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n",
            encoding="utf-8")
        names = sorted({*(x["name"] for x in self.stub.routes["/api/fleet"]["instances"]),
                        instance})
        self.stub.routes["/api/fleet"]["instances"] = [
            {"num": n + 1, "name": nm, "dir": str(self.root / nm), "isRunning": True}
            for n, nm in enumerate(names)]

    def test_a_chat_archived_while_it_still_recommended_work_is_named(self):
        self._chat("one", "c1", "## Am I 100% done?\n- Yes.\n"
                                "## Do I recommend anything else?\n- Finish the migration.",
                   "Migrate the billing tables")
        rep = self.mod.scan()
        self.assertEqual([r["title"] for r in rep["real"]], ["Migrate the billing tables"])
        self.assertIn("open recommendation", rep["real"][0]["why"])

    def test_a_MOVED_chat_is_not_reported_as_wrongly_archived(self):
        # Trap 1: the old copy is archived and the new one is live - the conversation is not
        # archived at all, and listing it would hand over chats that are running right now.
        self._chat("old", "c2", "## Am I 100% done?\n- No, still going.", "Live work",
                   archived=True)
        self._chat("new", "c2", "## Am I 100% done?\n- No, still going.", "Live work",
                   archived=False)
        self.assertEqual(self.mod.scan()["real"], [])

    def test_drill_chats_are_counted_separately_not_mixed_into_real_work(self):
        self._chat("one", "c3", "OK", "say OK")
        self._chat("one", "c4", "ACK", "Please reply with exactly PROBE ACK and stop.")
        rep = self.mod.scan()
        self.assertEqual(rep["real"], [])
        self.assertEqual(len(rep["drills"]), 2)

    def test_a_genuinely_finished_chat_is_not_flagged(self):
        self._chat("one", "c5", "## Am I 100% done?\n- Yes, everything shipped.\n"
                                "## Do I recommend anything else?\n- nothing", "Real finished work")
        self.assertEqual(self.mod.scan()["real"], [])


class HarvestTodosTest(unittest.TestCase):
    """Rescuing the work left inside archived chats into to-do markdown (owner, 2026-09-01:
    "either restore the chats or move the pending items to a ToDo md file")."""

    def setUp(self):
        import harvest_todos

        self.mod = harvest_todos
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_the_project_folder_name_resolves_back_to_the_real_repo(self):
        (self.root / "PublicProjects" / "orchestrator").mkdir(parents=True)
        with mock.patch.object(self.mod, "ROOTS", [self.root / "PublicProjects"]):
            idx = self.mod._repo_index()
        # case-insensitive, because the app writes the drive letter in either case
        enc = self.mod._encode(self.root / "PublicProjects" / "orchestrator").lower()
        self.assertIn(enc, idx)
        self.assertEqual(idx[enc].name, "orchestrator")

    def test_items_come_from_the_chats_own_words(self):
        v = {"state": "finished", "crashed": None, "finished": {
            "interrupted": False, "done_claim": "no",
            "open_recommendations": ["Wire the check into CI", "Delete the dead path"],
            "last_assistant_text": "## Am I 100% done?\n- No, the deploy step is open.\n"
                                   "## Do I recommend anything else?\n- Wire the check into CI"}}
        items = self.mod._items_from(v)
        self.assertEqual(items[0], "Not finished: No, the deploy step is open.")
        self.assertIn("Wire the check into CI", items)

    def test_a_crashed_chat_says_so_rather_than_inventing_a_task(self):
        v = {"state": "crashed", "crashed": {"kind": "usage-limit"}, "finished": None}
        self.assertEqual(len(self.mod._items_from(v)), 1)
        self.assertIn("usage-limit", self.mod._items_from(v)[0])

    def test_an_existing_file_is_never_overwritten(self):
        # A ticked-off to-do means DONE. Regenerating would resurrect items a person cleared.
        repo = self.root / "repo"
        (repo / "docs" / "todo").mkdir(parents=True)
        keep = repo / "docs" / "todo" / self.mod.TODO_NAME
        keep.write_text("# mine\n- [x] already handled", encoding="utf-8")
        plan = {"repos": {str(repo): {"repo": str(repo), "chats": [
            {"title": "T", "sessionId": "s", "ageDays": 1.0, "why": "x", "items": ["do it"]}]}}}
        out = self.mod.write(plan)
        self.assertTrue(out[0]["ok"])
        self.assertIn("already exists", out[0]["why"])
        self.assertEqual(keep.read_text(encoding="utf-8"), "# mine\n- [x] already handled")

    def test_yes_without_an_armed_window_refuses_and_writes_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            plan = {"chats": 1, "repos": {}, "skipped": 0}
            with mock.patch.object(self.mod, "build", return_value=plan), \
                 mock.patch.object(self.mod, "write") as m:
                code, out, _ = run_cli(self.mod.main, ["--yes"])
            m.assert_not_called()
            self.assertEqual(code, 0)
            self.assertIn("DISARMED", out)
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()

    def test_yes_with_an_armed_window_writes_as_before(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        try:
            armlib.arm(3600)
            plan = {"chats": 1, "repos": {}, "skipped": 0}
            with mock.patch.object(self.mod, "build", return_value=plan), \
                 mock.patch.object(self.mod, "write", return_value=[{"ok": True, "path": "p", "chats": 1}]) as m:
                code, out, _ = run_cli(self.mod.main, ["--yes"])
            m.assert_called_once()
            self.assertEqual(code, 0)
            self.assertNotIn("DISARMED", out)
        finally:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
            self._state.cleanup()


class SaturateWakeVerifyTextTest(unittest.TestCase):
    """saturate.py's build_plan/execute: the wake's verify text comes from the chat's OWN
    last words (owner correction, 2026-09-01 - it shipped as the literal string 'x', one
    character, so every automatic wake carried a guard that matched any pane on screen)."""

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        self._tmp = tempfile.TemporaryDirectory()
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "acct", "dir": "c:\\i\\acct", "isRunning": True, "signedIn": True}]}
        self._patch = mock.patch.object(bandlib, "snapshot",
                                        return_value={"bands": {}, "accounts": []})
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _chat(self, sid, records, title="A chat"):
        tp = Path(self._tmp.name) / f"{sid}.jsonl"
        tp.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
        old = time.time() - 4000
        os.utime(tp, (old, old))
        return {"session_id": sid, "archived": False, "title": title, "instance": "acct",
                "transcript_path": str(tp)}

    def test_a_non_staged_wake_derives_its_verify_text_from_the_chats_own_words(self):
        import saturate

        distinct = ("The archived Q3 vendor ledger for Meridian Textiles still needs a "
                    "countersignature from finance before it can close.")
        self.stub.routes["/api/sessions"] = [self._chat("s1", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": distinct}]}},
            {"type": "user", "message": {"content": "continue"}},
        ], "Mid-turn work")]
        plan = saturate.build_plan()
        self.assertEqual(len(plan["planned"]), 1)
        row = plan["planned"][0]
        self.assertIn("transcript", row)
        self.assertTrue(row["transcript"].endswith("s1.jsonl"))
        import courier

        with mock.patch.object(courier, "main", return_value=0):
            results = saturate.execute(plan)
        self.assertEqual(results[0]["exit"], 0)
        from lib import deliverylib

        staged = deliverylib.pending()
        self.assertEqual(len(staged), 1)
        self.assertIn(staged[0]["verifyText"], distinct)  # a real substring of its own words
        self.assertNotEqual(staged[0]["verifyText"], "x")

    def test_yes_without_an_armed_window_refuses_and_wakes_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        import saturate

        armlib.disarm()
        distinct = ("The archived Q3 vendor ledger for Meridian Textiles still needs a "
                    "countersignature from finance before it can close.")
        self.stub.routes["/api/sessions"] = [self._chat("s1", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": distinct}]}},
            {"type": "user", "message": {"content": "continue"}},
        ], "Mid-turn work")]
        with mock.patch.object(saturate, "execute") as m:
            code, out, _ = run_cli(saturate.main, ["--yes"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)

    def test_yes_with_an_armed_window_wakes_as_before(self):
        import saturate

        distinct = ("The archived Q3 vendor ledger for Meridian Textiles still needs a "
                    "countersignature from finance before it can close.")
        self.stub.routes["/api/sessions"] = [self._chat("s1", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": distinct}]}},
            {"type": "user", "message": {"content": "continue"}},
        ], "Mid-turn work")]
        with mock.patch.object(saturate, "execute",
                               return_value=[{"ok": True, "exit": 0, "title": "x",
                                             "instance": "acct", "why": "wake",
                                             "outcome": "woken"}]) as m:
            code, out, _ = run_cli(saturate.main, ["--yes"])
        m.assert_called_once()
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)

    def test_a_transcript_with_no_distinctive_line_refuses_the_blind_wake(self):
        import saturate

        self.stub.routes["/api/sessions"] = [self._chat("s2", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}},
            {"type": "user", "message": {"content": "go"}},
        ], "Too terse to verify")]
        plan = saturate.build_plan()
        self.assertEqual(len(plan["planned"]), 1)
        import courier

        with mock.patch.object(courier, "main", return_value=0):
            results = saturate.execute(plan)
        self.assertEqual(results[0]["exit"], 4)
        self.assertIn("did NOT wake", results[0]["outcome"])
        from lib import deliverylib

        self.assertEqual(deliverylib.pending(), [])

    def test_a_recent_delivery_within_the_window_is_already_woken_not_restaged(self):
        import saturate
        from lib import deliverylib

        self.stub.routes["/api/sessions"] = [self._chat("s3", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}},
            {"type": "user", "message": {"content": "go"}},
        ], "Just woken")]
        plan = saturate.build_plan()
        self.assertEqual(len(plan["planned"]), 1)
        with mock.patch.object(deliverylib, "recent_delivery",
                               return_value={"id": "d1", "by": "overlord", "deliveredAt": 1}):
            results = saturate.execute(plan)
        self.assertTrue(results[0]["ok"])
        self.assertEqual(results[0]["outcome"], "already woken")
        self.assertEqual(deliverylib.pending(), [])


class GroundskeeperTest(unittest.TestCase):
    HOT, COOL, BUSY = "hot", "cool", "busy"

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        self._tmp = tempfile.TemporaryDirectory()
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": self.HOT, "dir": "c:\\i\\hot", "isRunning": True, "signedIn": True},
            {"num": 2, "name": self.COOL, "dir": "c:\\i\\cool", "isRunning": True, "signedIn": True},
        ]}
        self.snap = {
            "bands": {self.HOT: "over-hard", self.COOL: "ok"},
            "accounts": [
                {"band": "over-hard", "roomPct": 0,
                 "instances": [{"name": self.HOT, "isRunning": True}]},
                {"band": "ok", "roomPct": 60,
                 "instances": [{"name": self.COOL, "isRunning": True}]},
            ],
        }
        self._patch = mock.patch.object(bandlib, "snapshot", return_value=self.snap)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _chat(self, sid, instance, text, title="A chat", quiet_secs=4000):
        tp = Path(self._tmp.name) / f"{sid}.jsonl"
        tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - quiet_secs
        os.utime(tp, (old, old))
        return {"session_id": sid, "archived": False, "title": title, "instance": instance,
                "transcript_path": str(tp)}

    def test_a_wakeable_chat_stranded_on_a_cooked_account_is_moved_to_a_healthy_one(self):
        self.stub.routes["/api/sessions"] = [
            self._chat("s1", self.HOT, OFFERS, "Stranded work")]
        plan = groundskeeper.build_plan()
        self.assertEqual(len(plan["evacuate"]), 1)
        self.assertEqual((plan["evacuate"][0]["from"], plan["evacuate"][0]["to"]),
                         (self.HOT, self.COOL))
        self.assertEqual(plan["archive"], [])

    def test_yes_without_an_armed_window_refuses_and_executes_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): --yes alone must not act unless a
        # person opened a window (`python orch.py arm`) or passed --force.
        armlib.disarm()
        self.stub.routes["/api/sessions"] = [
            self._chat("s1", self.HOT, OFFERS, "Stranded work")]
        with mock.patch.object(groundskeeper, "execute") as m:
            code, out, _ = run_cli(groundskeeper.main, ["--yes"])
        m.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)

    def test_yes_with_an_armed_window_executes_as_before(self):
        self.stub.routes["/api/sessions"] = [
            self._chat("s1", self.HOT, OFFERS, "Stranded work")]
        with mock.patch.object(groundskeeper, "execute",
                               return_value=[{"ok": True, "title": "Stranded work",
                                             "why": "moved", "from": self.HOT, "to": self.COOL,
                                             "duty": "evacuate", "outcome": "moved"}]) as m:
            code, out, _ = run_cli(groundskeeper.main, ["--yes"])
        m.assert_called_once()
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)

    def test_EVERY_dormant_chat_leaves_a_burnt_account_even_one_with_no_work_queued(self):
        # Owner correction, 2026-09-01: "why are you leaving chats sitting in accounts with
        # 100% 5hr - they should be migrated, obviously, so they can resume without waiting."
        # A done chat cannot even be ARCHIVED there, because preserving its knowledge first
        # needs a turn the account cannot pay for. So it moves too.
        self.stub.routes["/api/sessions"] = [self._chat("s1", self.HOT, DONE, "Done work")]
        plan = groundskeeper.build_plan()
        self.assertEqual([r["to"] for r in plan["evacuate"]], [self.COOL])
        self.assertEqual(plan["archive"], [])  # never archived FROM the burnt account

    def test_chats_with_work_in_hand_leave_first(self):
        self.stub.routes["/api/sessions"] = [
            self._chat("s1", self.HOT, DONE, "AAA done"),
            self._chat("s2", self.HOT, OFFERS, "ZZZ has work")]
        plan = groundskeeper.build_plan(evacuate_max=1)
        self.assertEqual([r["title"] for r in plan["evacuate"]], ["ZZZ has work"])
        self.assertEqual(plan["strandedLeftBehind"], 1)

    def test_a_full_target_account_still_accepts_an_evacuee(self):
        # The per-account SHARE caps running chats, and a landed chat does not run until
        # something wakes it. Applying the cap to the move was the bug that left chats
        # stranded on a burnt account waiting for a quota reset.
        self.stub.routes["/api/sessions/live"] = {
            "count": 9, "sessions": [{"sessionId": f"r{i}"} for i in range(9)]}
        self.stub.routes["/api/sessions"] = [
            self._chat("s1", self.HOT, OFFERS, "Stranded")] + [
            {"session_id": f"r{i}", "archived": False, "title": f"busy{i}",
             "instance": self.COOL, "transcript_path": ""} for i in range(9)]
        plan = groundskeeper.build_plan()
        self.assertEqual([r["to"] for r in plan["evacuate"]], [self.COOL])

    def test_a_done_chat_on_a_healthy_account_is_queued_for_archiving(self):
        self.stub.routes["/api/sessions"] = [self._chat("s2", self.COOL, DONE, "Done work")]
        plan = groundskeeper.build_plan()
        self.assertEqual([r["title"] for r in plan["archive"]], ["Done work"])

    def test_a_freshly_finished_chat_is_given_time_to_be_wrong_about_being_done(self):
        # Owner, 2026-09-01: "I strongly feel chats are being archived when they are not
        # completely done." The gate's signals say the chat BELIEVES it finished; the settling
        # period gives it time to be picked back up before anything files it away.
        self.stub.routes["/api/sessions"] = [
            self._chat("s9", self.COOL, DONE, "Just finished", quiet_secs=600)]
        self.assertEqual(groundskeeper.build_plan()["archive"], [])

    def test_a_chat_that_still_RECOMMENDS_work_is_not_done(self):
        # The fourth signal: a recap that recommends three more things has stopped, not
        # finished - and by the owner's own doctrine those recommendations are the work.
        recommending = ("## What I did\n- the thing\n## Am I 100% done?\n- Yes, all green.\n"
                        "## Do I recommend anything else?\n- Wire the new check into CI.\n"
                        "- Delete the dead config path I found.")
        self.stub.routes["/api/sessions"] = [
            self._chat("s10", self.COOL, recommending, "Stopped, not finished")]
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["archive"], [])

    def test_a_chat_that_offers_to_carry_on_is_never_archived(self):
        self.stub.routes["/api/sessions"] = [self._chat("s3", self.COOL, OFFERS)]
        self.assertEqual(groundskeeper.build_plan()["archive"], [])

    def test_a_held_chat_is_left_alone_by_both_duties(self):
        from lib import holdlib

        self.stub.routes["/api/sessions"] = [
            self._chat("s4", self.HOT, OFFERS), self._chat("s5", self.COOL, DONE)]
        holdlib.hold("s4", "owner is reading it")
        holdlib.hold("s5", "owner is reading it")
        plan = groundskeeper.build_plan()
        self.assertEqual((plan["evacuate"], plan["archive"]), ([], []))

    def test_a_running_chat_is_never_touched(self):
        self.stub.routes["/api/sessions"] = [self._chat("s6", self.COOL, DONE)]
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [{"sessionId": "s6"}]}
        plan = groundskeeper.build_plan()
        self.assertEqual((plan["evacuate"], plan["archive"]), ([], []))

    def test_evacuations_spread_instead_of_piling_onto_one_target(self):
        self.stub.routes["/api/fleet"]["instances"].append(
            {"num": 3, "name": self.BUSY, "dir": "c:\\i\\busy", "isRunning": True, "signedIn": True})
        self.snap["bands"][self.BUSY] = "ok"
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 90, "instances": [{"name": self.BUSY, "isRunning": True}]})
        self.stub.routes["/api/sessions"] = [
            self._chat(f"s{i}", self.HOT, OFFERS, f"Stranded {i}") for i in range(4)]
        plan = groundskeeper.build_plan(evacuate_max=4)
        targets = [r["to"] for r in plan["evacuate"]]
        # four moves, two healthy accounts: never three-to-one, which is the hog this exists
        # to prevent - the plan counts its own moves forward as it builds.
        self.assertEqual(sorted(targets), sorted([self.COOL, self.BUSY] * 2))

    def test_a_chat_the_daemon_never_indexed_is_still_seen_and_acted_on(self):
        # Owner, 2026-09-01: "why are there so many that haven't been touched in hours - open -
        # like sweep ones which haven't been in days." The daemon's session list held 17 chats
        # while the desktop stores held 30 unarchived ones; the other 13 were invisible to
        # every lane, so nothing woke them and nothing archived them.
        store = self.root_store = Path(self._tmp.name) / self.COOL / "claude-code-sessions" / "a" / "b"
        store.mkdir(parents=True)
        (store / "local_ghost.json").write_text(json.dumps(
            {"cliSessionId": "ghost", "isArchived": False, "title": "Sweep report: old"}),
            encoding="utf-8")
        proj = Path(self._tmp.name) / self.COOL / "projects" / "p"
        proj.mkdir(parents=True)
        tp = proj / "ghost.jsonl"
        tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": OFFERS}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 90000
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = []          # the daemon has never heard of it
        self.stub.routes["/api/fleet"]["instances"] = [
            {"num": 1, "name": self.HOT, "dir": "c:\\i\\hot", "isRunning": True, "signedIn": True},
            {"num": 2, "name": self.COOL, "dir": str(Path(self._tmp.name) / self.COOL),
             "isRunning": True, "signedIn": True}]
        rows = hydralib.visible_chats()
        self.assertIn("ghost", [r.get("session_id") for r in rows])
        ghost = next(r for r in rows if r["session_id"] == "ghost")
        self.assertEqual(ghost["source"], "desktop-store")
        self.assertEqual(ghost["instance"], self.COOL)
        self.assertTrue(ghost["transcript_path"].endswith("ghost.jsonl"))

    def test_an_OPEN_account_is_always_preferred_over_a_closed_one(self):
        # Owner, standing: "only ever open an account if you absolutely have no more tokens."
        # A closed account is emptier by definition, so ranking on emptiness alone made it win
        # every time and apps started opening themselves. Open wins; closed is a last resort.
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 99,
             "instances": [{"name": "closed-and-empty", "isRunning": False, "signedIn": True}]})
        self.snap["bands"]["closed-and-empty"] = "ok"
        got = groundskeeper._target_account(self.snap, {self.COOL: 5}, 4, exclude=set())
        self.assertEqual(got["name"], self.COOL)
        self.assertTrue(got["isRunning"])

    def test_a_closed_account_is_used_only_when_no_open_one_may_take_work(self):
        self.snap["accounts"][1]["band"] = "over-hard"  # the only open healthy one is cooked
        self.snap["bands"][self.COOL] = "over-hard"
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 99,
             "instances": [{"name": "closed-and-empty", "isRunning": False, "signedIn": True}]})
        self.snap["bands"]["closed-and-empty"] = "ok"
        got = groundskeeper._target_account(self.snap, {}, 4, exclude=set())
        self.assertEqual(got["name"], "closed-and-empty")
        self.assertFalse(got["isRunning"])

    def test_nothing_moves_when_every_other_account_is_cooked_too(self):
        self.snap["bands"][self.COOL] = "over-soft"
        self.snap["accounts"][1]["band"] = "over-soft"
        self.stub.routes["/api/sessions"] = [self._chat("s7", self.HOT, OFFERS)]
        self.assertEqual(groundskeeper.build_plan()["evacuate"], [])

    def test_a_running_but_idle_chat_on_a_burnt_account_is_named_not_moved(self):
        # New owner order, 2026-09-01: "Never move active chats. Only chats that are stopped,
        # waiting, chilling." The first cut moved an idle-but-live chat off a burnt account
        # through the daemon's atomic migrate route; that is reverted here - a chat with a
        # live engine, idle or mid-turn, stays put and is named in activeOnBurnt until it
        # stops on its own.
        tp = Path(self._tmp.name) / "live.jsonl"
        tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": OFFERS}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 3600
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "L1", "archived": False, "title": "Busy but idle",
             "instance": self.HOT, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "L1", "pid": 4242}]}
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual([r["sessionId"] for r in plan["activeOnBurnt"]], ["L1"])
        self.assertIn("not moved", plan["activeOnBurnt"][0]["why"])

    def test_a_chat_MID_TURN_is_never_moved_even_off_a_burnt_account(self):
        tp = Path(self._tmp.name) / "midturn.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "working"},
            {"type": "tool_use", "name": "Bash", "input": {}}]}}) + "\n", encoding="utf-8")
        self.stub.routes["/api/sessions"] = [
            {"session_id": "L2", "archived": False, "title": "Mid turn",
             "instance": self.HOT, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "L2", "pid": 99}]}
        self.assertEqual(groundskeeper.build_plan()["evacuate"], [])

    def test_a_chat_STUCK_on_a_permission_prompt_is_named_and_never_moved(self):
        # Owner, 2026-09-01: "when a chat asks for permission to run something because you
        # forgot to set the permissions... shouldn't break the entire account." The gate has
        # always NAMED this shape. New owner order, same day: "Never move active chats. Only
        # chats that are stopped, waiting, chilling" - so the first cut's fix (move it to
        # re-land it dormant) is reverted: it is reported in plan["stuck"] every pass and left
        # exactly where it is; a person answers it, or unblock_prompts presses bypass.
        tp = Path(self._tmp.name) / "stuck.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "running the build"},
            {"type": "tool_use", "name": "Bash", "input": {}}]}}) + "\n", encoding="utf-8")
        old = time.time() - 4000
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "S1", "archived": False, "title": "Blocked on approval",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "S1", "pid": 777}]}
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 99, "instances": [{"name": "fresh", "isRunning": True}]})
        self.snap["bands"]["fresh"] = "ok"
        self.stub.routes["/api/fleet"]["instances"].append(
            {"num": 9, "name": "fresh", "dir": "c:\\i\\fresh", "isRunning": True, "signedIn": True})
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual(len(plan["stuck"]), 1)
        self.assertEqual(plan["stuck"][0]["sessionId"], "S1")
        self.assertEqual(plan["stuck"][0]["instance"], self.COOL)  # left where it stuck
        self.assertTrue(plan["stuck"][0]["why"].startswith("STUCK"))

    def _meta(self, sid, mode):
        # A desktop meta record under the COOL instance's store, so build_plan's mode map (the
        # surface unblock_prompts reads) knows this chat's CONFIGURED permission mode.
        root = Path(self._tmp.name) / "cool"
        self.stub.routes["/api/fleet"]["instances"][1]["dir"] = str(root)
        d = root / "claude-code-sessions" / "a" / "b"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"local_{sid}.json").write_text(json.dumps(
            {"cliSessionId": sid, "isArchived": False, "title": "Blocked",
             "permissionMode": mode}), encoding="utf-8")

    def _shell_pending(self, name, quiet_secs):
        tp = Path(self._tmp.name) / f"{name}.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "running the build now"},
            {"type": "tool_use", "name": "PowerShell", "input": {}}]}}) + "\n", encoding="utf-8")
        old = time.time() - quiet_secs
        os.utime(tp, (old, old))
        return tp

    def test_a_default_mode_chat_stuck_on_a_shell_call_is_named_after_ten_minutes(self):
        # 2026-09-01: a deeplink-born chat is LIVE from birth, so the bypass stamp cannot
        # stick; it stalls on its first shell call in 'default' mode, unblock rightly refuses
        # to press for it, and the generic 30-minute stall window left it dead for half an
        # hour. A not-bypass chat with a shell call pending is a PROMPT after PROMPT_STALL_SECS.
        # Same-day owner order ("never move active chats") means being named sooner replaces
        # being MOVED sooner - it still never leaves plan["evacuate"].
        self._meta("D1", "default")
        tp = self._shell_pending("default-stuck", 12 * 60)
        self.stub.routes["/api/sessions"] = [
            {"session_id": "D1", "archived": False, "title": "Blocked",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "D1", "pid": 779}]}
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 99, "instances": [{"name": "fresh", "isRunning": True}]})
        self.snap["bands"]["fresh"] = "ok"
        self.stub.routes["/api/fleet"]["instances"].append(
            {"num": 9, "name": "fresh", "dir": "c:\\i\\fresh", "isRunning": True, "signedIn": True})
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual([r["sessionId"] for r in plan["stuck"]], ["D1"])
        self.assertIn("default mode", plan["stuck"][0]["why"])

    def test_a_bypass_chat_with_the_same_shape_keeps_the_generic_stall_window(self):
        # The shorter window is ONLY for chats whose mode is not bypass: a bypass chat twelve
        # minutes into a shell call may be a real build, and the 30-minute rule still guards it.
        self._meta("B1", "bypassPermissions")
        tp = self._shell_pending("bypass-busy", 12 * 60)
        self.stub.routes["/api/sessions"] = [
            {"session_id": "B1", "archived": False, "title": "Building",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "B1", "pid": 780}]}
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual(plan["stuck"], [])

    def test_dry_run_names_a_stuck_chat_as_not_moved(self):
        # Owner order, 2026-09-01: "Never move active chats." main()'s plain-text output is
        # what a person actually reads on a dry pass, so pin its exact wording for a stuck row.
        tp = Path(self._tmp.name) / "stuck-dry.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "running the build"},
            {"type": "tool_use", "name": "Bash", "input": {}}]}}) + "\n", encoding="utf-8")
        old = time.time() - 4000
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "SD1", "archived": False, "title": "Blocked on approval",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "SD1", "pid": 900}]}
        code, out, _ = run_cli(groundskeeper.main, [])
        self.assertEqual(code, 0)
        self.assertIn("STUCK - not moved", out)

    def test_the_overlord_itself_is_still_named_when_stalled(self):
        # The protection shield (2026-09-01) keeps the overlord out of archiving, evacuation
        # and rebalancing - NOT out of being named. New owner order, same day: "never move
        # active chats", so duty 3 no longer relocates a stuck manager either - it is reported
        # in plan["stuck"] exactly like any other stalled chat (seen live the same afternoon: a
        # fresh deeplink-born manager booted in default mode and stalled on its first shell
        # call), while the shield still keeps it out of evacuate/archive/rebalance.
        tp = Path(self._tmp.name) / "stuck-ov.jsonl"
        tp.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "running the standing loop now"},
            {"type": "tool_use", "name": "PowerShell", "input": {}}]}}) + "\n", encoding="utf-8")
        old = time.time() - 4000
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "OV", "archived": False, "title": "Orchestrate",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "OV", "pid": 778}]}
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "OV"}), encoding="utf-8")
        self.snap["accounts"].append(
            {"band": "ok", "roomPct": 99, "instances": [{"name": "fresh", "isRunning": True}]})
        self.snap["bands"]["fresh"] = "ok"
        self.stub.routes["/api/fleet"]["instances"].append(
            {"num": 9, "name": "fresh", "dir": "c:\\i\\fresh", "isRunning": True, "signedIn": True})
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual([r["sessionId"] for r in plan["stuck"]], ["OV"])
        self.assertTrue(plan["stuck"][0]["why"].startswith("STUCK"))
        self.assertEqual(plan["archive"], [])

    def test_a_healthy_running_chat_is_never_unstuck(self):
        tp = Path(self._tmp.name) / "healthy.jsonl"
        tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": OFFERS}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 4000
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "H1", "archived": False, "title": "Idle and fine",
             "instance": self.COOL, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "H1", "pid": 5}]}
        self.assertEqual(groundskeeper.build_plan()["evacuate"], [])

    def test_the_overlords_own_chat_is_excluded_from_archiving_even_when_done(self):
        # overlord.protected_session_ids: the claimed sessionId in state/overlord.json.
        # Archiving the standing manager unattended darkens the watchdog for good.
        self.stub.routes["/api/sessions"] = [self._chat("s-ov", self.COOL, DONE, "Orchestrate")]
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "s-ov"}), encoding="utf-8")
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["archive"], [])

    def test_a_chat_titled_orchestrate_is_excluded_from_evacuation_even_when_stranded(self):
        # The second rule of protected_session_ids: any un-archived chat titled 'Orchestrate'
        # is the overlord's own, whether or not it is the claimed session.
        self.stub.routes["/api/sessions"] = [self._chat("s-ov2", self.HOT, OFFERS, "Orchestrate")]
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual(plan["strandedTotal"], 0)

    def test_a_live_idle_chat_on_a_burnt_account_lands_in_activeOnBurnt_never_posts_migrate(self):
        # New owner order, 2026-09-01: "Never move active chats." This replaces two tests that
        # pinned the old live-migrate path's shapes (a ledger note written before the POST, and
        # a deterministic second note on a 400) - that path is gone for a live chat entirely,
        # so the only thing left to prove is that build_plan never proposes the move and
        # execute() never talks to the daemon's /migrate route for it.
        tp = Path(self._tmp.name) / "live3.jsonl"
        tp.write_text(json.dumps(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": OFFERS}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 3600
        os.utime(tp, (old, old))
        self.stub.routes["/api/sessions"] = [
            {"session_id": "L3", "archived": False, "title": "Busy but idle 3",
             "instance": self.HOT, "transcript_path": str(tp)}]
        self.stub.routes["/api/sessions/live"] = {
            "count": 1, "sessions": [{"sessionId": "L3", "pid": 4242}]}
        plan = groundskeeper.build_plan()
        self.assertEqual(plan["evacuate"], [])
        self.assertEqual([r["sessionId"] for r in plan["activeOnBurnt"]], ["L3"])
        results = groundskeeper.execute(plan)
        self.assertEqual(results, [])
        self.assertFalse([p for p, _b in self.stub.posts if p.endswith("/migrate")])

    def test_the_preservation_step_in_flight_counts_as_ok_not_a_failure(self):
        # archive_chat exit 8 means the chat was asked to update its markdown first (the
        # owner's rule); the archive lands on a later pass. Calling that a failure would trip
        # the breaker on the exact chats that are behaving correctly.
        plan = {"evacuate": [], "archive": [{"sessionId": "s8", "title": "Done work",
                                             "instance": self.COOL, "band": "ok", "why": "done"}]}
        with mock.patch("archive_chat.main", return_value=8):
            out = groundskeeper.execute(plan)
        self.assertTrue(out[0]["ok"])
        self.assertIn("preserve", out[0]["outcome"])

    def test_one_malformed_chat_is_skipped_and_named_without_zeroing_other_duties(self):
        # A bad transcript or a gate that throws on one chat used to take the whole tick down
        # with it - one malformed row zeroed all four duties for every OTHER chat that pass.
        # Now it is caught, named in plan["errored"], and the rest of the sweep still runs.
        self.stub.routes["/api/sessions"] = [
            self._chat("bad", self.COOL, DONE, "Bad chat"),
            self._chat("s2", self.COOL, DONE, "Good chat")]
        real_gate = gatelib.gate  # every OTHER chat still gets the real verdict

        def flaky(sid, *a, **kw):
            if sid == "bad":
                raise RuntimeError("boom")
            return real_gate(sid, *a, **kw)

        with mock.patch("groundskeeper.gatelib.gate", side_effect=flaky):
            plan = groundskeeper.build_plan()
        self.assertEqual([e["sessionId"] for e in plan["errored"]], ["bad"])
        self.assertIn("boom", plan["errored"][0]["error"])
        self.assertEqual(plan["errored"][0]["title"], "Bad chat")
        self.assertEqual([r["title"] for r in plan["archive"]], ["Good chat"])

    def test_main_prints_the_errored_chats_loudly(self):
        self.stub.routes["/api/sessions"] = [
            self._chat("bad", self.COOL, DONE, "Bad chat")]
        with mock.patch("groundskeeper.gatelib.gate", side_effect=RuntimeError("boom")):
            code, out, err = run_cli(groundskeeper.main, [])
        self.assertEqual(code, 0)
        self.assertIn("1 chat(s) errored in planning", err)
        self.assertIn("boom", err)

    def test_a_crash_in_build_plan_is_loud_and_exits_1_not_a_bare_traceback(self):
        with mock.patch.object(groundskeeper, "build_plan", side_effect=RuntimeError("kaboom")):
            code, out, err = run_cli(groundskeeper.main, [])
        self.assertEqual(code, 1)
        self.assertIn("groundskeeper CRASHED", err)
        self.assertIn("kaboom", err)


if __name__ == "__main__":
    unittest.main()
