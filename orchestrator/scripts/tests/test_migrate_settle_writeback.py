"""A settle against a RUNNING source app must survive that app's next write-back (2026-09-18).

THE INCIDENT, and it is the owner-facing half. `move_chats {from:15, to:38, all_unarchived:true}`
landed both chats and settled both source rows; `list_chats {instance:15}` read `all: 200,
unarchived: 0` and the move was reported to the owner as settled. Seventy-five minutes later the
same call read `all: 202` - the source app had held both chats in memory the whole time and
re-saved them over the records the settle had tombstoned. The owner archived them by hand.

The resurrection itself was already known: `_tombstone_source_session_file` documents it and
clears the duplicate - ON A LATER CALL. Nothing ever fired a later call, because the move had
written its terminal `stamped` phase and stopped being anybody's business.

Three rails, each pinned below:

  1. A settle taken against a RUNNING app is reported as PROVISIONAL, never as final. A disk read
     seconds after a settle cannot answer what a running app will write NEXT.
  2. The batch LOOKS AGAIN, after the resume phase has spent real time, and repairs what came
     back - both shapes: an un-archived row (re-settle) and an archived one (re-tombstone). The
     2026-09-18 pair came back ARCHIVED, so a re-check that only asked "is it visible?" would
     have called both of them clean.
  3. The journal stays OWED (`stamped-source-running`, which is not migrate_reconcile's
     `DONE_PHASE`), so the row keeps being re-checked long after this process is gone.
"""

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_batch  # noqa: E402
import migrate_chat  # noqa: E402
import migrate_reconcile  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import mutationlib  # noqa: E402

RUNNING_FLEET = {"instances": [
    {"num": 1, "name": "src", "dir": "c:\\i\\src", "isRunning": True},
    {"num": 2, "name": "dst", "dir": "c:\\i\\dst", "isRunning": True},
]}
CLOSED_FLEET = {"instances": [
    {"num": 1, "name": "src", "dir": "c:\\i\\src", "isRunning": False},
    {"num": 2, "name": "dst", "dir": "c:\\i\\dst", "isRunning": False},
]}
MATCH = {"instance": "src", "title": "a chat"}
TARGET = {"name": "dst", "num": 2}


class SourceAppRunningTest(unittest.TestCase):
    def test_a_running_source_app_is_named_as_such(self):
        self.assertTrue(migrate_chat.source_app_running(MATCH, TARGET, RUNNING_FLEET))

    def test_a_closed_source_app_is_not(self):
        self.assertFalse(migrate_chat.source_app_running(MATCH, TARGET, CLOSED_FLEET))

    def test_a_same_account_no_op_move_has_no_source_app_to_worry_about(self):
        self.assertFalse(
            migrate_chat.source_app_running({"instance": "dst"}, TARGET, RUNNING_FLEET))


class _Landing:
    """The two fields the phases below actually read, plus the slots they write."""

    def __init__(self, running: bool):
        self.match = dict(MATCH)
        self.target = dict(TARGET)
        self.fleet = RUNNING_FLEET if running else CLOSED_FLEET
        self.session_id = "sid-1"
        self.after = {}
        self.src_instance = "src"
        self.chat_title = "a chat"
        self.mutation_id = "m-1"
        self.settle_note = ""
        self.source_row = None
        self.source_app_running = None
        self.source_effort = None
        self.stopped_bystanders = None
        self.doctrine = {"verdict": "bypassPermissions"}
        self.sw = _Stopwatch()


class _Stopwatch:
    def __init__(self):
        self.phases = {}

    def resume(self):
        pass

    def lap(self, _name):
        pass


class PhaseSettleProvisionalTest(unittest.TestCase):
    def setUp(self):
        self._patchers = []
        self._patch(migrate_chat, "_settle_source_row",
                    lambda *a, **k: (" Source row settled.", "settled"))
        self._patch(mutationlib, "advance_phase", lambda mid, phase: self.phases.append(phase))
        # No usage survey from a test: the source is not at its limit.
        self._patch(migrate_chat, "source_at_limit", lambda land: None)
        self.phases = []

    def _patch(self, obj, name, value):
        p = mock.patch.object(obj, name, value)
        p.start()
        self.addCleanup(p.stop)

    def test_a_settle_under_a_running_app_says_PROVISIONAL_in_its_own_note(self):
        land = _Landing(running=True)
        migrate_chat.phase_settle(land)
        self.assertTrue(land.source_app_running)
        self.assertIn("PROVISIONAL", land.settle_note)
        self.assertIn("migrate_reconcile", land.settle_note)

    def test_a_settle_under_a_CLOSED_app_says_nothing_of_the_kind(self):
        land = _Landing(running=False)
        migrate_chat.phase_settle(land)
        self.assertFalse(land.source_app_running)
        self.assertNotIn("PROVISIONAL", land.settle_note)

    def test_the_journal_stays_OWED_when_the_source_app_was_running(self):
        """⛔ THE RAIL THAT CLOSED THE ROW FOREVER. `stamped` is migrate_reconcile's DONE_PHASE:
        writing it is what stopped anything re-reading the resurrected rows."""
        land = _Landing(running=True)
        land.source_row = "settled"
        land.source_app_running = True
        self._patch(migrate_chat, "_stamp_automation_doctrine",
                    lambda *a, **k: {"verdict": "bypassPermissions", "mode": "bypassPermissions",
                                     "evidence": "", "stamped": True, "ultracode": True,
                                     "stampNote": "", "note": "", "remedy": ""})
        self._patch(mutationlib, "record", lambda *a, **k: None)
        migrate_chat.phase_stamp(land)
        self.assertEqual(self.phases[-1], "stamped-source-running")
        self.assertNotIn(self.phases[-1], (migrate_reconcile.DONE_PHASE,))
        self.assertNotIn(self.phases[-1], migrate_reconcile.FINISHED_PHASES)

    def test_a_closed_source_app_still_reaches_the_terminal_phase(self):
        land = _Landing(running=False)
        land.source_row = "settled"
        land.source_app_running = False
        self._patch(migrate_chat, "_stamp_automation_doctrine",
                    lambda *a, **k: {"verdict": "bypassPermissions", "mode": "bypassPermissions",
                                     "evidence": "", "stamped": True, "ultracode": True,
                                     "stampNote": "", "note": "", "remedy": ""})
        self._patch(mutationlib, "record", lambda *a, **k: None)
        migrate_chat.phase_stamp(land)
        self.assertEqual(self.phases[-1], migrate_reconcile.DONE_PHASE)


def _item(provisional: bool, running: bool = True):
    item = migrate_batch._Item("a chat")
    item.landing = _Landing(running=running)
    item.payload = {"landed": True, "title": "a chat", "sessionId": "sid-1",
                    "sourceRow": "settled", "sourceSettled": True,
                    "sourceRowProvisional": provisional, "report": "r"}
    return item


class RecheckPhaseTest(unittest.TestCase):
    def setUp(self):
        self._patch(hydralib, "fleet", lambda: RUNNING_FLEET)

    def _patch(self, obj, name, value):
        p = mock.patch.object(obj, name, value)
        p.start()
        self.addCleanup(p.stop)

    def test_a_row_that_never_came_back_is_left_alone(self):
        self._patch(migrate_chat, "source_still_visible", lambda *a, **k: False)
        self._patch(migrate_chat, "clear_resurrected_source_record", lambda *a, **k: None)
        item = _item(True)
        got = migrate_batch._recheck_provisional_settles([item])
        self.assertEqual(got, {"checked": 1, "cameBack": 0, "repaired": 0})
        self.assertEqual(item.payload["sourceRowRecheck"]["cameBack"], False)

    def test_an_UNARCHIVED_resurrection_is_re_settled_through_the_real_phase(self):
        """It re-drives phase_settle - the same call `migrate_reconcile --finish` makes. No new
        actuator is invented here."""
        self._patch(migrate_chat, "source_still_visible", lambda *a, **k: True)
        calls = []

        def settle_again(land):
            calls.append(land)
            land.source_row = "settled"

        self._patch(migrate_chat, "phase_settle", settle_again)
        item = _item(True)
        got = migrate_batch._recheck_provisional_settles([item])
        self.assertEqual(len(calls), 1)
        self.assertEqual(got, {"checked": 1, "cameBack": 1, "repaired": 1})
        self.assertTrue(item.payload["sourceRowRecheck"]["repaired"])
        self.assertTrue(item.payload["sourceSettled"])

    def test_an_ARCHIVED_resurrection_is_caught_too(self):
        """⛔ THE SHAPE THE 2026-09-18 PAIR ACTUALLY TOOK. Both rows came back ARCHIVED, so
        `source_still_visible` was false for both - only the tombstone can see that one."""
        self._patch(migrate_chat, "source_still_visible", lambda *a, **k: False)
        self._patch(migrate_chat, "clear_resurrected_source_record",
                    lambda *a, **k: "c:\\i\\src\\local_sid-1.json.tombstone")
        item = _item(True)
        got = migrate_batch._recheck_provisional_settles([item])
        self.assertEqual(got, {"checked": 1, "cameBack": 1, "repaired": 1})
        self.assertIn("tombstoned again", item.payload["sourceRowRecheck"]["detail"])

    def test_a_row_that_was_never_provisional_is_not_re_checked_at_all(self):
        self._patch(migrate_chat, "source_still_visible",
                    lambda *a, **k: self.fail("a non-provisional row must not be re-read"))
        self.assertIsNone(migrate_batch._recheck_provisional_settles([_item(False)]))

    def test_a_fleet_that_cannot_be_re_read_says_STILL_PROVISIONAL_rather_than_clean(self):
        def boom():
            raise hydralib.DaemonError("/api/fleet", None, "boom")

        self._patch(hydralib, "fleet", boom)
        item = _item(True)
        got = migrate_batch._recheck_provisional_settles([item])
        self.assertEqual(got["checked"], 0)
        self.assertFalse(item.payload["sourceRowRecheck"]["checked"])
        self.assertIn("PROVISIONAL", item.payload["sourceRowRecheck"]["why"])


class ReportProseTest(unittest.TestCase):
    """The warning has to be in the PROSE. The one time it mattered the owner found out by
    opening his own sidebar, and a JSON field he never reads would not have changed that."""

    class _Parsed:
        dry_run = False
        chats = ["a chat"]

    def _payload_for(self, item):
        with mock.patch.object(migrate_batch, "_report", lambda *a, **k: "the body"):
            return migrate_batch._build_batch_payload([item], self._Parsed(), "", 1.0, None)

    def test_a_resurrection_leads_the_report(self):
        item = _item(True)
        item.payload["sourceRowRecheck"] = {"checked": True, "cameBack": True, "repaired": True}
        got = self._payload_for(item)
        self.assertTrue(got["report"].startswith("⚠ 1 source row(s) CAME BACK"))

    def test_a_row_that_could_not_be_re_checked_is_named_as_still_provisional(self):
        item = _item(True)
        item.payload["sourceRowRecheck"] = {"checked": False, "why": "the fleet read failed"}
        got = self._payload_for(item)
        self.assertIn("still PROVISIONAL", got["report"])
        self.assertIn("migrate_reconcile", got["report"])

    def test_a_clean_re_check_still_says_the_journal_owes_one_more_look(self):
        item = _item(True)
        item.payload["sourceRowRecheck"] = {"checked": True, "cameBack": False, "repaired": False}
        got = self._payload_for(item)
        self.assertIn("all still settled", got["report"])

    def test_a_move_off_a_CLOSED_app_says_none_of_this(self):
        got = self._payload_for(_item(False, running=False))
        self.assertEqual(got["report"], "the body")


if __name__ == "__main__":
    unittest.main()
