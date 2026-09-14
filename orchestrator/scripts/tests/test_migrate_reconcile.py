"""migrate_reconcile.py: the half-moves a killed batch leaves, and the journal that finds them.

THE INCIDENT (2026-09-13). A 25-chat batch was killed mid-flight. 14 archived chats were left
IMPORTED onto the target and STILL unarchived on the source - duplicates, not moves - and
nothing on the machine said which of the 25 were which. These pin the four verdicts, the
journal advancing under them, and that --finish re-drives migrate_chat's OWN phases rather
than inventing a second settle.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402

from lib import hydralib  # noqa: E402
from lib import mutationlib  # noqa: E402
import migrate_reconcile  # noqa: E402

SRC = "source-acct"
TGT = "target-acct"


class MigrateReconcileTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        #: sid -> list of (instance, archived); a HALF-MOVE is two rows for one session, which
        #: is exactly the shape the dossier reports and the collapsed session view cannot.
        self.chats: dict[str, list[tuple[str, bool]]] = {}

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            rows = self.chats.get(sid) or []
            return {"matches": [{"instance": inst, "chatId": f"c-{sid}", "cliSessionId": sid,
                                 "lineageIds": [sid], "title": f"chat {sid}",
                                 "archived": archived, "live": None,
                                 "metaPath": f"c:\\{inst}\\{sid}.json"}
                                for inst, archived in rows]}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": SRC, "dir": f"c:\\i\\{SRC}", "isRunning": False},
            {"num": 2, "name": TGT, "dir": f"c:\\i\\{TGT}", "isRunning": False},
        ]}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _moved(self, sid: str, phase: str = "imported") -> str:
        """A migrate mutation exactly as migrate_chat records one in phase one."""
        return mutationlib.record("migrate", sid, instance=TGT, title=f"chat {sid}",
                                  before={"instance": SRC}, after={"instance": TGT},
                                  undoable=True, phase=phase)

    # --- the verdicts ---------------------------------------------------------------------

    def test_a_chat_on_both_accounts_is_an_unsettled_half_move(self):
        """THE 14. Imported onto the target, still unarchived on the source: a duplicate."""
        self.chats["s1"] = [(SRC, False), (TGT, False)]
        self._moved("s1")
        report = migrate_reconcile.reconcile()
        row = report["rows"][0]
        self.assertEqual(row["state"], "unsettled")
        self.assertEqual(report["unsettled"], [row])
        self.assertIn("duplicate", row["why"])

    def test_an_archived_source_row_is_a_whole_move_and_the_journal_is_advanced(self):
        mid = self._moved("s2")
        self.chats["s2"] = [(SRC, True), (TGT, False)]
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "settled")
        self.assertEqual(report["unsettled"], [])
        self.assertEqual(mutationlib.get(mid)["phase"], migrate_reconcile.VERIFIED_PHASE,
                         "a row proven whole must stop being re-checked forever")

    def test_a_source_that_no_longer_holds_the_chat_is_settled(self):
        self._moved("s3")
        self.chats["s3"] = [(TGT, False)]
        self.assertEqual(migrate_reconcile.reconcile()["rows"][0]["state"], "settled")

    def test_a_verified_move_whose_chat_is_now_live_twice_elsewhere_is_the_loudest_row(self):
        """Not on the target, and live on TWO other accounts: a duplicate the ledger cannot
        explain. Never quietly 'settled'."""
        mutationlib.record("migrate", "s4", instance=TGT, title="chat s4",
                           before={"instance": SRC}, after={"instance": TGT},
                           undoable=True, phase="imported")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": SRC}, {"num": 2, "name": TGT}, {"num": 3, "name": "third-acct"}]}
        self.chats["s4"] = [(SRC, False), ("third-acct", False)]
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "not-landed")
        self.assertEqual(len(report["unsettled"]), 1)

    def test_a_chat_archived_since_is_at_rest_not_a_fault(self):
        self._moved("s4d")
        self.chats["s4d"] = [(SRC, True)]
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "archived-since")
        self.assertEqual(report["unsettled"], [])

    def test_a_chat_that_is_whole_somewhere_else_is_moved_on_not_a_fault(self):
        """The first live run's other false red: a chat moved back by an older path that never
        wrote a migrate row. One live copy, somewhere - the ledger is stale, nothing is broken."""
        self._moved("s4b")
        self.chats["s4b"] = [(SRC, False)]
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "moved-on")
        self.assertEqual(report["unsettled"], [])

    def test_a_move_into_an_account_that_no_longer_exists_is_target_gone(self):
        mutationlib.record("migrate", "s4c", instance="deleted-acct", title="chat s4c",
                           before={"instance": SRC}, after={"instance": "deleted-acct"},
                           undoable=True, phase="imported")
        self.chats["s4c"] = [(SRC, False), (TGT, False)]
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "target-gone")
        self.assertEqual(report["unsettled"], [])

    def test_a_session_that_resolves_nowhere_is_gone_not_unsettled(self):
        self._moved("s5")
        self.assertEqual(migrate_reconcile.reconcile()["rows"][0]["state"], "gone")
        self.assertEqual(migrate_reconcile.reconcile()["unsettled"], [])

    def test_a_move_stamped_while_its_source_twin_was_still_visible_is_still_found(self):
        """REVIEW FINDING, 2026-09-14: the stamp phase runs whatever the settle said, and it used
        to write 'stamped' over 'settle-visible' - hiding a real duplicate from this very tool."""
        import migrate_chat

        mid = self._moved("s21")
        land = migrate_chat._Landing(session_id="s21", target={"name": TGT}, after=[],
                                     fleet={}, chat_title="chat s21", mutation_id=mid,
                                     sw=migrate_chat._Stopwatch(), source_row="visible")
        with mock.patch.object(migrate_chat, "_stamp_automation_doctrine",
                               lambda *a, **k: {"verdict": "ok", "mode": "bypassPermissions",
                                                "evidence": ""}):
            migrate_chat.phase_stamp(land)
        self.assertEqual(mutationlib.get(mid)["phase"], "stamped-settle-visible")
        self.chats["s21"] = [(SRC, False), (TGT, False)]
        self.assertEqual(migrate_reconcile.reconcile()["rows"][0]["state"], "unsettled")

    def test_a_finished_move_is_not_re_checked_at_all(self):
        self._moved("s6", phase=migrate_reconcile.DONE_PHASE)
        self.chats["s6"] = [(SRC, False), (TGT, False)]
        self.assertEqual(migrate_reconcile.reconcile()["checked"], 0,
                         "a row that reached the last phase owes nothing")

    def test_an_undone_move_is_not_a_half_move(self):
        mid = self._moved("s7")
        undo_id = self._moved("s7-undo")
        mutationlib.mark_undone(mid, undo_id)
        self.chats["s7"] = [(SRC, False), (TGT, False)]
        checked = [r["sessionId"] for r in migrate_reconcile.reconcile()["rows"]]
        self.assertNotIn("s7", checked, "it went back on purpose")

    def test_only_a_chat_s_newest_move_is_judged_and_older_ones_are_superseded(self):
        """THE FIRST LIVE RUN (2026-09-14): 63 `not-landed` rows for chats that had simply moved
        AGAIN on purpose (#12 -> #8, then #8 -> #36). Judging the first move against where the
        chat is now is a false red, and a reconciler that cries wolf 63 times gets ignored."""
        first = mutationlib.record("migrate", "s20", instance=TGT, title="chat s20",
                                   before={"instance": SRC}, after={"instance": TGT},
                                   undoable=True, phase="imported", now_ms=1_000)
        mutationlib.record("migrate", "s20", instance="third-acct", title="chat s20",
                           before={"instance": TGT}, after={"instance": "third-acct"},
                           undoable=True, phase="imported", now_ms=2_000)
        self.chats["s20"] = [("third-acct", False), (TGT, True)]
        report = migrate_reconcile.reconcile()
        self.assertEqual([r["target"] for r in report["rows"]], ["third-acct"])
        self.assertEqual(report["unsettled"], [], "the chat is exactly where its last move put it")
        self.assertEqual(mutationlib.get(first)["phase"], migrate_reconcile.SUPERSEDED_PHASE)
        # ...and a superseded row is never read again.
        self.assertEqual(migrate_reconcile.reconcile()["checked"], 0)

    def test_a_pre_journal_row_is_checked_rather_than_assumed_finished(self):
        """Rows written before the journal existed have no phase. Unknown is not done."""
        mutationlib.record("migrate", "s8", instance=TGT, title="old one",
                           before={"instance": SRC}, after={"instance": TGT}, undoable=True)
        self.chats["s8"] = [(SRC, False), (TGT, False)]
        self.assertEqual(migrate_reconcile.reconcile()["rows"][0]["state"], "unsettled")

    def test_a_failed_dossier_read_counts_as_unsettled_never_as_clean(self):
        self._moved("s9")

        def boom(method, path, query, body):
            raise AssertionError("dossier is down")

        self.stub.routes["/api/chats/dossier"] = boom
        report = migrate_reconcile.reconcile()
        self.assertEqual(report["rows"][0]["state"], "unknown")
        self.assertEqual(len(report["unsettled"]), 1, "a failed read is ignorance, not a pass")

    # --- repairing ------------------------------------------------------------------------

    def test_finish_re_drives_migrate_chat_s_own_phases_and_advances_the_journal(self):
        import migrate_chat

        mid = self._moved("s10")
        self.chats["s10"] = [(SRC, False), (TGT, False)]
        ran: list[str] = []

        def settle(land):
            ran.append(f"settle:{land.session_id}:{land.match.get('instance')}")
            land.source_row = "settled"
            mutationlib.advance_phase(land.mutation_id, "settle-settled")

        def stamp(land, watched=None):
            ran.append(f"stamp:{land.session_id}")
            land.doctrine = {"mode": "bypassPermissions", "verdict": "ok", "evidence": ""}
            mutationlib.advance_phase(land.mutation_id, migrate_reconcile.DONE_PHASE)

        with mock.patch.object(migrate_chat, "phase_settle", settle), \
             mock.patch.object(migrate_chat, "phase_stamp", stamp):
            report = migrate_reconcile.reconcile()
            out = migrate_reconcile.finish(report["unsettled"])

        self.assertEqual(ran, [f"settle:s10:{SRC}", "stamp:s10"],
                         "the source row is what gets settled, through migrate_chat's own phase")
        self.assertTrue(out[0]["ok"])
        self.assertEqual(mutationlib.get(mid)["phase"], migrate_reconcile.DONE_PHASE)

    def test_a_settle_that_leaves_the_row_visible_is_not_reported_as_repaired(self):
        import migrate_chat

        self._moved("s11")
        self.chats["s11"] = [(SRC, False), (TGT, False)]

        def settle(land):
            land.source_row = "visible"  # the actuator could not reach the row

        with mock.patch.object(migrate_chat, "phase_settle", settle), \
             mock.patch.object(migrate_chat, "phase_stamp", lambda land, watched=None: None):
            out = migrate_reconcile.finish(migrate_reconcile.reconcile()["unsettled"])
        self.assertFalse(out[0]["ok"])
        self.assertIn("still visible", out[0]["outcome"])

    def test_an_actuator_failure_is_that_chat_s_failure_not_the_run_s(self):
        import migrate_chat

        self._moved("s12")
        self._moved("s13")
        self.chats["s12"] = [(SRC, False), (TGT, False)]
        self.chats["s13"] = [(SRC, False), (TGT, False)]

        def settle(land):
            if land.session_id == "s12":
                raise RuntimeError("the window would not open")
            land.source_row = "settled"

        with mock.patch.object(migrate_chat, "phase_settle", settle), \
             mock.patch.object(migrate_chat, "phase_stamp", lambda land, watched=None: None):
            out = migrate_reconcile.finish(migrate_reconcile.reconcile()["unsettled"])
        by_sid = {r["sessionId"]: r for r in out}
        self.assertFalse(by_sid["s12"]["ok"])
        self.assertIn("RuntimeError", by_sid["s12"]["outcome"])
        self.assertTrue(by_sid["s13"]["ok"], "one bad chat must not cost the others their repair")

    def test_reverse_hands_the_row_to_undo_rather_than_reversing_it_here(self):
        import undo

        mid = self._moved("s14")
        seen: list[list[str]] = []

        def fake_main(argv):
            seen.append(list(argv))
            return 0

        with mock.patch.object(undo, "main", fake_main):
            code, _ = migrate_reconcile.reverse(mid)
        self.assertEqual(code, 0)
        self.assertEqual(seen, [[mid]], "undo.py owns the reversal route; this only chooses")

    # --- the CLI --------------------------------------------------------------------------

    def test_the_exit_code_says_whether_anything_is_half_moved(self):
        from util import run_cli

        self.chats["s15"] = [(SRC, True), (TGT, False)]
        self._moved("s15")
        code, said, _err = run_cli(migrate_reconcile.main, ["--json"])
        self.assertEqual(code, 0, said)

        self.chats["s16"] = [(SRC, False), (TGT, False)]
        self._moved("s16")
        code, said, _err = run_cli(migrate_reconcile.main, ["--json"])
        self.assertEqual(code, 2, said)
        self.assertIn("unsettled", said)

    def test_an_unknown_id_is_refused_deterministically(self):
        from util import run_cli

        code, _out, _err = run_cli(migrate_reconcile.main, ["--reverse", "nosuchid"])
        self.assertEqual(code, 3)
        code, _out, _err = run_cli(migrate_reconcile.main, ["--reverse"])
        self.assertEqual(code, 3, "a flag with no value is a usage error, not a silent sweep")


if __name__ == "__main__":
    unittest.main()
