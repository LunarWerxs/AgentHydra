"""overlord.py: the watchdog that mechanically re-arms the standing /orchestrate chat -
detection, the leave-alone gates, and the confirmed nudge."""

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
from util import run_cli  # noqa: E402

import overlord  # noqa: E402
from lib import armlib  # noqa: E402
from lib import holdlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import ledgerlib  # noqa: E402

SID = "ffff1111-2222-3333-4444-555566667777"
# The desktop app's own record of MANAGER_PROMPT (measured live 2026-09-04).
MANAGER_RECORDED = ("<command-message>orchestrate</command-message>\n<command-name>/orchestrate"
            "</command-name>\n<command-args>"
            + overlord.MANAGER_PROMPT.split(" ", 1)[1] + "</command-args>")


def ms_ago(secs: float) -> int:
    return int((time.time() - secs) * 1000)


class OverlordTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing nudge test here keeps exercising
        # the real path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        self.tp = Path(self._tmp.name) / "t.jsonl"
        self.tp.write_text(json.dumps({"type": "assistant", "message": {
            "content": [{"type": "text", "text": "pass done. Shall I continue?"}]}}) + "\n",
            encoding="utf-8")
        old = time.time() - 1200
        os.utime(self.tp, (old, old))
        self.rows = [
            {"session_id": SID, "archived": False, "title": "Orchestrate", "instance": "p2",
             "transcript_path": str(self.tp), "last_activity_at": ms_ago(1200)},
            {"session_id": "x" * 8, "archived": False,
             "title": "Orchestrator TypeScript to Python migration", "instance": "temp1",
             "transcript_path": str(self.tp), "last_activity_at": ms_ago(10)},
        ]
        stub = self.stub
        stub.routes["/api/sessions"] = lambda m, p, q, b: self.rows
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 9, "name": "p2", "dir": "c:\\i\\p2", "isRunning": True, "signedIn": True}]}

        def dossier_route(method, path, query, body):
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [{"instance": "p2", "chatId": "local_o", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Orchestrate", "archived": False,
                                 "lastActivityAt": "T1", "live": self.live}]}

        self.live = None
        stub.routes["/api/chats/dossier"] = dossier_route

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_detection_picks_the_exact_title_never_the_dev_chat(self):
        row = overlord.find_overlord()
        self.assertEqual(row["session_id"], SID)  # never 'Orchestrator ... migration'

    def test_no_overlord_disarmed_is_a_loud_exit_2_and_spawns_nothing(self):
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        armlib.disarm()
        import spawn_chat
        with mock.patch.object(spawn_chat, "spawn") as spawn:
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 2)
        self.assertIn("NO overlord", out)
        spawn.assert_not_called()

    def test_no_overlord_armed_is_reborn_and_claimed(self):
        # Live soak, 2026-09-01: the manager's desktop record vanished; every tick printed
        # 'gate FAILED' while the judgment queue sat. The watchdog now spawns a replacement
        # through spawn_chat's own rails and claims it.
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        import spawn_chat
        with mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(spawn_chat, "spawn", return_value={
                 "ok": True, "instance": "p2", "sessionId": "reborn-1", "started": "running",
                 "modeSet": "set: Bypass permissions"}) as spawn:
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("REBORN", out)
        folder, prompt, inst = spawn.call_args.args
        self.assertEqual(prompt, overlord.MANAGER_PROMPT)
        self.assertTrue(prompt.startswith("/orchestrate"))
        claim = json.loads((Path(self._state.name) / "overlord.json").read_text(encoding="utf-8"))
        self.assertEqual(claim["sessionId"], "reborn-1")

    def test_a_manager_that_already_exists_is_claimed_never_duplicated(self):
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        import spawn_chat
        with mock.patch.object(hydralib, "same_task_chats", return_value=[
                 {"session_id": "already-1", "title": "Orchestrate", "instance": "p2", "live": True}]), \
             mock.patch.object(spawn_chat, "spawn") as spawn:
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("already exists", out)
        spawn.assert_not_called()
        claim = json.loads((Path(self._state.name) / "overlord.json").read_text(encoding="utf-8"))
        self.assertEqual(claim["sessionId"], "already-1")

    def test_a_claimed_manager_with_no_record_and_no_process_is_reborn(self):
        # the sessions table still lists it, the dossier has no record, nothing holds it
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "x" * 8}), encoding="utf-8")
        import spawn_chat
        with mock.patch.object(overlord, "current_match", return_value=(None, [])), \
             mock.patch.object(hydralib, "live_for", return_value=None), \
             mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(spawn_chat, "spawn", return_value={
                 "ok": True, "instance": "p2", "sessionId": "reborn-2", "started": "running",
                 "modeSet": "set"}) as spawn:
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("no desktop record and no live process", out)
        spawn.assert_called_once()

    def test_a_fresh_claim_the_index_has_not_caught_up_with_is_still_the_overlord(self):
        # Live soak, 2026-09-01: the tick after a rebirth could not see the new chat in
        # GET /api/sessions yet, read the claim as "gone", and reborn a SECOND manager.
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "fresh-1"}), encoding="utf-8")
        self.rows = [r for r in self.rows if r["session_id"] != SID]  # not indexed yet
        with mock.patch.object(hydralib, "resolve_one", return_value={
                 "cliSessionId": "fresh-1", "title": "Orchestrate", "instance": "p2",
                 "archived": False, "lastActivityAt": "2026-09-02T01:24:42.819Z"}), \
             mock.patch.object(hydralib, "session_row", return_value=None):
            row = overlord.find_overlord()
        self.assertIsNotNone(row)
        self.assertEqual(row["session_id"], "fresh-1")
        self.assertTrue(row.get("fromDossier"))

    def test_no_second_rebirth_inside_the_cooldown(self):
        from lib import ledgerlib
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        ledgerlib.note("surface", "reborn-0", note="rebirth: manager respawned (test)")
        import spawn_chat
        with mock.patch.object(hydralib, "same_task_chats", return_value=[]), \
             mock.patch.object(spawn_chat, "spawn") as spawn:
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 2)
        self.assertIn("reborn 0m ago", out)
        spawn.assert_not_called()

    def test_claiming_a_dead_chat_is_refused(self):
        # a fresh manager claimed "standing manager chat" by fragment and got the OLD one:
        # no desktop record by id, no process - a claim on a corpse darkens the watchdog
        with mock.patch.object(hydralib, "resolve_one", return_value={
                 "cliSessionId": "dead-1", "title": "old manager", "live": None}), \
             mock.patch.object(hydralib, "dossier", return_value=[]):
            code, out, _ = run_cli(overlord.main, ["--claim", "standing manager"])
        self.assertEqual(code, 2)
        self.assertIn("claim refused", out)
        self.assertFalse((Path(self._state.name) / "overlord.json").exists())

    def test_a_claim_overrides_the_title_rule_and_a_gone_claim_is_loud(self):
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "x" * 8}), encoding="utf-8")
        self.assertEqual(overlord.find_overlord()["session_id"], "x" * 8)
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "gone-gone"}), encoding="utf-8")
        self.assertIsNone(overlord.find_overlord())

    def test_recently_active_overlord_is_left_alone(self):
        self.rows[0]["last_activity_at"] = ms_ago(60)
        code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("left alone", out)
        self.assertEqual(self.stub.posts, [])

    def test_without_an_armed_window_the_default_path_refuses_and_touches_nothing(self):
        # THE ARMED WINDOW (owner order, 2026-09-01): the nudge/handoff path is unattended
        # acting - it must not run without a person's open window (`python orch.py arm`) or
        # --force, even though it carries no --yes flag of its own.
        armlib.disarm()
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("DISARMED", out)
        self.assertEqual(self.stub.posts, [])

    def test_status_is_never_gated_even_when_disarmed(self):
        armlib.disarm()
        code, out, _ = run_cli(overlord.main, ["--status"])
        self.assertEqual(code, 0)
        self.assertIn("overlord:", out)

    def test_no_waiting_work_means_no_nudge(self):
        with mock.patch.object(overlord, "pending_work", return_value={"any": False, "why": "-"}):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("NO waiting work", out)
        self.assertEqual(self.stub.posts, [])

    def test_held_overlord_is_never_nudged(self):
        holdlib.hold(SID, "owner is driving it by hand")
        code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 6)
        self.assertEqual(self.stub.posts, [])

    def test_quiet_overlord_with_work_gets_woken_through_the_courier(self):
        # The wake is STAGED and delivered by the courier's own rails, cap-exempt - and
        # NEVER via /migrate (2026-09-01: that endpoint delivers no prompt; it killed and
        # reimported the chat dormant).
        import courier
        from lib import deliverylib

        argv_seen = {}

        def fake_courier(argv):
            argv_seen["argv"] = argv
            return 0

        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "3 judgment question(s)"}), \
             mock.patch.object(courier, "main", side_effect=fake_courier):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0, out)
        self.assertIn("NUDGED", out)
        self.assertEqual([p for p, _ in self.stub.posts if "/migrate" in p], [])
        staged = deliverylib.pending()
        self.assertEqual(len(staged), 1)
        self.assertIn("/orchestrate", staged[0]["text"])
        self.assertEqual(staged[0]["by"], "overlord")
        self.assertTrue(staged[0]["verifyText"])  # never types blind
        self.assertEqual(argv_seen["argv"][0:2], ["--yes", "--only"])
        self.assertIn("--cap-exempt", argv_seen["argv"])
        self.assertEqual(len(ledgerlib._load()), 0)  # confirmed clears the attempt

    def test_an_unlanded_wake_is_honest_and_counted(self):
        import courier

        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch.object(courier, "main", return_value=2):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 1)
        self.assertIn("did not land", out)
        self.assertEqual(len(ledgerlib._load()), 1)

    def _lr_transcript(self, prompt_mins_ago: float, tool_result_mins_ago: float | None = 1):
        from datetime import datetime, timedelta, timezone

        def iso(mins):
            return (datetime.now(timezone.utc) - timedelta(minutes=mins)).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z")

        tp = Path(self._tmp.name) / "lr.jsonl"
        lines = [
            json.dumps({"type": "user", "timestamp": iso(prompt_mins_ago),
                        "message": {"content": "do the big build"}}),
            json.dumps({"type": "assistant", "timestamp": iso(prompt_mins_ago - 0.1),
                        "message": {"content": [{"type": "text", "text": "on it"}]}}),
        ]
        if tool_result_mins_ago is not None:
            lines.append(json.dumps({"type": "user", "timestamp": iso(tool_result_mins_ago),
                                     "message": {"content": [{"type": "tool_result",
                                                              "content": "ok"}]}}))
        tp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return tp

    def test_long_runners_flag_old_turns_and_ignore_tool_result_traffic(self):
        # The real prompt was 45m ago; fresh tool results must NOT reset the clock.
        tp = self._lr_transcript(45, tool_result_mins_ago=1)
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [
            {"sessionId": "s1long", "name": "repo-x", "pid": 5, "transcriptPath": str(tp)}]}
        rs = overlord.long_runners()
        self.assertEqual(len(rs), 1)
        self.assertGreaterEqual(rs[0]["minutes"], 44)

    def test_long_runners_widens_the_tail_to_find_a_start_buried_past_400kb(self):
        # The fixed 400 KB tail can miss the turn's start entirely on a big or chatty
        # transcript - mirrors gatelib.read_records' adaptive tail: widen and re-scan rather
        # than read "nothing in the window" as "nothing in flight".
        from datetime import datetime, timedelta, timezone

        def iso(mins):
            return (datetime.now(timezone.utc) - timedelta(minutes=mins)).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z")

        tp = Path(self._tmp.name) / "buried.jsonl"
        head = [
            json.dumps({"type": "user", "timestamp": iso(45),
                        "message": {"content": "do the big build"}}),
            json.dumps({"type": "assistant", "timestamp": iso(44.9),
                        "message": {"content": [{"type": "text", "text": "on it"}]}}),
        ]
        # ~600 KB of trailing tool-result traffic - past _LR_TAIL_BYTES (400 KB), so the
        # starting window lands entirely inside this padding and finds no start record.
        filler = json.dumps({"type": "user", "timestamp": iso(1),
                             "message": {"content": [{"type": "tool_result",
                                                      "content": "x" * 2000}]}})
        tp.write_text("\n".join(head + [filler] * 300) + "\n", encoding="utf-8")
        self.assertGreater(tp.stat().st_size, overlord._LR_TAIL_BYTES)
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [
            {"sessionId": "buried1", "name": "repo-x", "pid": 5, "transcriptPath": str(tp)}]}
        rs = overlord.long_runners()
        self.assertEqual(len(rs), 1)
        self.assertGreaterEqual(rs[0]["minutes"], 44)

    def test_a_fresh_turn_is_not_a_long_runner(self):
        tp = self._lr_transcript(5)
        self.stub.routes["/api/sessions/live"] = {"count": 1, "sessions": [
            {"sessionId": "s1", "name": "repo-x", "pid": 5, "transcriptPath": str(tp)}]}
        self.assertEqual(overlord.long_runners(), [])

    def test_long_runners_ride_the_wakeup_and_count_as_work(self):
        self.stub.routes[f"/api/sessions/{SID}/migrate"] = {"ok": True}
        flips = {"n": 0}

        def fake_live(sid, matches=None):
            flips["n"] += 1
            return None if flips["n"] == 1 else {"pid": 42}

        import courier
        from lib import deliverylib

        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": False, "why": "0 lane act(s)"}), \
             mock.patch.object(overlord, "long_runners",
                               return_value=[{"sessionId": "s1longsid", "name": "repo-x",
                                              "pid": 5, "minutes": 52}]), \
             mock.patch.object(courier, "main", return_value=0):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        staged = deliverylib.pending()
        self.assertEqual(len(staged), 1)
        self.assertIn("LONG-RUNNERS", staged[0]["text"])
        self.assertIn("52m", staged[0]["text"])

    def test_twin_rows_never_silence_the_watchdog_and_get_flagged_after_a_wake(self):
        # The 2026-09-01 live failure: a revive left a zombie twin, resolve_one refused the
        # ambiguity, and the watchdog broke on the very chat it had woken. Newest wins;
        # after a wake the superseded twin is flagged archived on disk, loudly.
        twin_meta = Path(self._tmp.name) / "local_twin.json"
        twin_meta.write_text(json.dumps({"cliSessionId": SID, "title": "Orchestrate",
                                         "isArchived": False}), encoding="utf-8")
        stub = self.stub

        def two_rows(method, path, query, body):
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [
                {"instance": "p2", "chatId": "local_new", "cliSessionId": SID,
                 "lineageIds": [SID], "title": "Orchestrate", "archived": False,
                 "lastActivityAt": "2026-09-01T05:15:00.000Z", "live": None},
                {"instance": "p2", "chatId": "local_twin", "cliSessionId": SID,
                 "lineageIds": [SID], "title": "Orchestrate", "archived": False,
                 "lastActivityAt": "2026-09-01T04:15:00.000Z", "live": None,
                 "metaPath": str(twin_meta)},
            ]}

        stub.routes["/api/chats/dossier"] = two_rows
        import courier

        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch.object(courier, "main", return_value=0):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("NUDGED", out)
        self.assertIn("zombie twin", out)
        self.assertTrue(json.loads(twin_meta.read_text(encoding="utf-8"))["isArchived"])

    def test_a_second_real_orchestrate_chat_is_reported_loudly(self):
        self.rows.append({"session_id": "g" * 8, "archived": False, "title": "Orchestrate",
                          "instance": "work", "transcript_path": str(self.tp),
                          "last_activity_at": ms_ago(9000)})
        code, out, _ = run_cli(overlord.main, ["--status"])
        self.assertEqual(code, 0)
        self.assertIn("SPARE manager chat(s)", out)
        self.assertIn("work", out)

    def _manager_row(self, sid, instance, quiet_secs, title="Standing manager chat orchestration"):
        p = Path(self._tmp.name) / f"{sid}.jsonl"
        p.write_text("\n".join(json.dumps(r) for r in [
            {"type": "user", "message": {"content": MANAGER_RECORDED}},
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "pass done. Shall I continue?"}]}},
        ]) + "\n", encoding="utf-8")
        old = time.time() - quiet_secs
        os.utime(p, (old, old))
        return {"session_id": sid, "archived": False, "title": title, "instance": instance,
                "transcript_path": str(p), "last_activity_at": ms_ago(quiet_secs)}

    def test_a_manager_the_app_titled_itself_is_the_overlord_without_a_claim_or_the_title(self):
        # 2026-09-04, live: no claim, no chat titled 'Orchestrate', FOUR chats born from
        # MANAGER_PROMPT under the app's own titles - and the tick reborn a fifth, on the
        # account with the most room. The birth prompt is the identity; the spares are named.
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        self.rows.append(self._manager_row("mgr-new", "p2", 1200))
        self.rows.append(self._manager_row("mgr-old", "work", 90000,
                                           "Manager chat work (retired)"))
        import spawn_chat
        with mock.patch("pathlib.Path.home", return_value=Path(self._tmp.name) / "nohome"):
            row = overlord.find_overlord()
            self.assertEqual(row["session_id"], "mgr-new")  # newest-active, not the spare
            self.assertTrue(row.get("adopted"))
            with mock.patch.object(spawn_chat, "spawn") as spawn:
                code, out, _ = run_cli(overlord.main, ["--status"])
            self.assertEqual(code, 0)
            spawn.assert_not_called()
            self.assertIn("SPARE manager chat(s)", out)
            self.assertIn("mgr-old", out)
            self.assertIn("archive_chat.py <id> --force", out)
            self.assertEqual(overlord.protected_session_ids(), {"mgr-new", "mgr-old"})
            # --status pins nothing; the acting tick does, so the role cannot ping-pong
            self.assertFalse((Path(self._state.name) / "overlord.json").exists())
            code, out, _ = run_cli(overlord.main, [])
            self.assertEqual(code, 0)
            claim = json.loads((Path(self._state.name) / "overlord.json").read_text(encoding="utf-8"))
            self.assertEqual(claim["sessionId"], "mgr-new")

    def test_managers_without_a_desktop_home_are_named_but_never_adopted(self):
        # Two of the four live spares on 2026-09-04 had no desktop record left (the index
        # still listed them, the dossier had nothing): adopting one would leave the fleet
        # with a manager nothing can wake. A homed one wins; with none, a fresh one is born.
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        self.rows.append({**self._manager_row("mgr-corpse", "p2", 600), "instance": None})
        self.rows.append(self._manager_row("mgr-homed", "work", 90000))
        import spawn_chat
        with mock.patch("pathlib.Path.home", return_value=Path(self._tmp.name) / "nohome"), \
             mock.patch.object(spawn_chat, "spawn") as spawn:
            self.assertEqual(overlord.find_overlord()["session_id"], "mgr-homed")
            self.rows = [r for r in self.rows if r["session_id"] != "mgr-homed"]
            self.assertIsNone(overlord.find_overlord())
            spawn.return_value = {"ok": True, "instance": "p2", "sessionId": "reborn-9",
                                  "started": "running", "modeSet": "set"}
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        spawn.assert_called_once()
        self.assertIn("REBORN", out)
        self.assertIn("none has a desktop home", out)

    def test_a_dead_claim_adopts_the_existing_manager_and_spawns_nothing(self):
        # The exact live failure of 2026-09-04 15:28: the claim pointed at an archived manager,
        # another manager was visible, and the tick spawned a new one anyway because the
        # duplicate guard could not read the birth prompt back out of the app's record.
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "gone-gone"}), encoding="utf-8")
        self.rows = [r for r in self.rows if r["session_id"] != SID]
        self.rows.append(self._manager_row("mgr-live", "p2", 1200))
        import spawn_chat
        with mock.patch("pathlib.Path.home", return_value=Path(self._tmp.name) / "nohome"), \
             mock.patch.object(spawn_chat, "spawn") as spawn:
            # --status stays loud about the dead claim AND says what the tick will do
            code, out, _ = run_cli(overlord.main, ["--status"])
            self.assertEqual(code, 2)
            self.assertIn("gone-gon", out)
            self.assertIn("1 chat(s) born from the manager prompt exist", out)
            self.assertIn("mgr-live", out)
            self.assertIn("spawning nothing", out)
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        spawn.assert_not_called()
        self.assertIn("already exists", out)
        self.assertIn("gone-gon", out)  # the honest reason names the dead claim
        claim = json.loads((Path(self._state.name) / "overlord.json").read_text(encoding="utf-8"))
        self.assertEqual(claim["sessionId"], "mgr-live")

    def test_a_cooked_account_gets_the_quota_handoff_before_the_wake(self):
        # Owner blessing, 2026-09-01: the overlord that halted itself at 81% "was exactly
        # right - hand off to a fresh account instead of stopping". The WATCHDOG relocates
        # (daemon-atomic migrate) and wakes on the fresh account - mechanical, never words.
        import courier

        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 9, "name": "p2", "dir": "c:\\i\\p2", "isRunning": True, "signedIn": True},
            {"num": 5, "name": "fz", "dir": "c:\\i\\fz", "isRunning": True, "signedIn": True}]}
        self.stub.routes[f"/api/sessions/{SID}/migrate"] = {"ok": True}
        hot = {"band": "over-hard", "email": "a@x.com", "peakPct": 91,
               "instances": [{"name": "p2"}]}
        cool = {"email": "b@x.com", "peakPct": 3, "mustOpen": False}
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch("balance.usage_rows_with_fallback",
                        return_value=({"rows": []}, "survey")), \
             mock.patch("balance.accounts_overview", return_value=[hot]), \
             mock.patch("balance.rank_next", return_value=[cool]), \
             mock.patch("balance._target_instance", return_value={"name": "fz"}), \
             mock.patch.object(courier, "main", return_value=0):
            code, out_text, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertIn("QUOTA HANDOFF", out_text)
        self.assertIn("relocated to fz", out_text)
        posts = [b for p, b in self.stub.posts if p.endswith("/migrate")]
        self.assertEqual(posts[0]["instance_ref"], "desktop:c:\\i\\fz")
        self.assertEqual(posts[0]["confirm_title"], "Orchestrate")

    def _last_text(self, text):
        # The overlord's transcript ends on this assistant text block (the app's own shape).
        self.tp.write_text(json.dumps({"type": "assistant", "message": {"role": "assistant",
                           "content": [{"type": "text", "text": text}]}}) + "\n",
                           encoding="utf-8")
        old = time.time() - 900
        os.utime(self.tp, (old, old))

    def test_a_chat_that_merely_talks_about_quota_is_never_relocated(self):
        # 2026-09-01, an hour after the banner handoff went in: the fresh manager's first
        # sentence was "checking my own quota", the gate's generic limit classifier matched
        # the word, and the watchdog RELOCATED the chat it was meant to wake. Prose is not
        # the banner.
        import courier

        # (no "usage limit" phrase here on purpose: that line the verify-snippet rule skips,
        # which is a different, correct refusal - this test is about the HANDOFF only)
        self._last_text("I'll run the standing pass. First checking my own quota and the "
                        "dry loop, then the acting sweep and the judgment queue.")
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch("balance.usage_rows_with_fallback",
                        return_value=({"rows": []}, "survey")), \
             mock.patch("balance.accounts_overview",
                        return_value=[{"band": "ok", "email": "a@x.com", "peakPct": 20,
                                       "instances": [{"name": "p2"}]}]), \
             mock.patch.object(courier, "main", return_value=0):
            code, out_text, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertNotIn("QUOTA HANDOFF", out_text)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/migrate")], [])

    def test_the_apps_limit_banner_moves_the_chat_even_when_the_survey_says_fine(self):
        # The survey measures the ACCOUNT; the banner in the chat's own pane measures THIS
        # chat's ability to take a turn. Either one means the handoff.
        import courier

        self._last_text("You've hit your session limit · resets 5:50pm (America/Chicago)")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 9, "name": "p2", "dir": "c:\\i\\p2", "isRunning": True, "signedIn": True},
            {"num": 5, "name": "fz", "dir": "c:\\i\\fz", "isRunning": True, "signedIn": True}]}
        self.stub.routes[f"/api/sessions/{SID}/migrate"] = {"ok": True}
        fine = {"band": "ok", "email": "a@x.com", "peakPct": 11, "instances": [{"name": "p2"}]}
        cool = {"email": "b@x.com", "peakPct": 3, "mustOpen": False}
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch("balance.usage_rows_with_fallback",
                        return_value=({"rows": []}, "survey")), \
             mock.patch("balance.accounts_overview", return_value=[fine]), \
             mock.patch("balance.rank_next", return_value=[cool]), \
             mock.patch("balance._target_instance", return_value={"name": "fz"}), \
             mock.patch.object(courier, "main", return_value=0):
            code, out_text, _ = run_cli(overlord.main, [])
        self.assertIn("QUOTA HANDOFF", out_text)
        self.assertIn("limit banner", out_text)
        self.assertEqual(len([p for p, _ in self.stub.posts if p.endswith("/migrate")]), 1)

    def test_a_cool_account_is_never_relocated(self):
        import courier

        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch("balance.usage_rows_with_fallback",
                        return_value=({"rows": []}, "survey")), \
             mock.patch("balance.accounts_overview",
                        return_value=[{"band": "ok", "email": "a@x.com", "peakPct": 20,
                                       "instances": [{"name": "p2"}]}]), \
             mock.patch.object(courier, "main", return_value=0):
            code, out_text, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 0)
        self.assertNotIn("QUOTA HANDOFF", out_text)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/migrate")], [])

    def test_migrate_failure_notes_the_ledger_and_the_breaker_suppresses_after_the_cap(self):
        # Review 2026-09-01: maybe_relocate's direct /migrate call must use the same breaker
        # contract as migrate_chat - noted every attempt, suppressed after the cap, and never
        # POSTing again once suppressed.
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 9, "name": "p2", "dir": "c:\\i\\p2", "isRunning": True, "signedIn": True},
            {"num": 5, "name": "fz", "dir": "c:\\i\\fz", "isRunning": True, "signedIn": True}]}
        self.stub.routes[f"/api/sessions/{SID}/migrate"] = (500, {"error": "boom"})
        hot = {"band": "over-soft", "email": "a@x.com", "peakPct": 88, "instances": [{"name": "p2"}]}
        cool = {"email": "b@x.com", "peakPct": 3, "mustOpen": False}
        row = {"session_id": SID, "instance": "p2", "title": "Orchestrate"}
        with mock.patch("balance.usage_rows_with_fallback",
                       return_value=({"rows": []}, "survey")), \
             mock.patch("balance.accounts_overview", return_value=[hot]), \
             mock.patch("balance.rank_next", return_value=[cool]), \
             mock.patch("balance._target_instance", return_value={"name": "fz"}):
            for _ in range(ledgerlib.ATTEMPT_CAP):
                _, note = overlord.maybe_relocate(row)
                self.assertIn("quota handoff refused", note)
            rows = [r for r in ledgerlib._load() if r.get("kind") == "migrate"]
            self.assertEqual(len(rows), ledgerlib.ATTEMPT_CAP)
            posts_before = len([p for p, _ in self.stub.posts if p.endswith("/migrate")])
            _, note = overlord.maybe_relocate(row)
        self.assertIn("suppressed by the breaker", note)
        posts_after = len([p for p, _ in self.stub.posts if p.endswith("/migrate")])
        self.assertEqual(posts_before, posts_after)  # the breaker skipped the POST entirely

    def test_protected_session_ids_includes_the_claim_and_orchestrate_titled_chats(self):
        (Path(self._state.name) / "overlord.json").write_text(
            json.dumps({"sessionId": "claimed-zzzz"}), encoding="utf-8")
        # archived chats titled 'Orchestrate' must NOT be protected - only live ones.
        self.rows.append({"session_id": "archived-orch", "archived": True, "title": "Orchestrate",
                          "instance": "p2", "transcript_path": str(self.tp),
                          "last_activity_at": ms_ago(10)})
        ids = overlord.protected_session_ids()
        self.assertEqual(ids, {"claimed-zzzz", SID})

    def test_an_unexpected_crash_in_the_nudge_path_is_loud_not_a_bare_traceback(self):
        # A bad usage-survey shape (or any other unexpected data) inside maybe_relocate() used
        # to escape main() as a bare traceback with no correctly-set exit code - a scheduled
        # task nobody watches. The broad catch turns that into a loud, exit-1 failure.
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}), \
             mock.patch("balance.usage_rows_with_fallback", side_effect=RuntimeError("boom")):
            code, out, err = run_cli(overlord.main, [])
        self.assertEqual(code, 1)
        self.assertIn("overlord CRASHED", err)
        self.assertIn("boom", err)
        self.assertEqual(self.stub.posts, [])

    def test_the_breaker_bounds_futile_nudges(self):
        for _ in range(4):
            ledgerlib.note("surface", SID, note="drill")
        with mock.patch.object(overlord, "pending_work",
                               return_value={"any": True, "why": "work"}):
            code, out, _ = run_cli(overlord.main, [])
        self.assertEqual(code, 5)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/migrate")], [])


if __name__ == "__main__":
    unittest.main()
