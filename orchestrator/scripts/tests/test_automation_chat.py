"""automation_chat.py + stamplib: the mechanical automation doctrine - bypassPermissions via
the daemon, ultracode via the meta record, both verified, prompt-advice never."""

import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon, dossier_query  # noqa: E402
from util import run_cli  # noqa: E402

import automation_chat  # noqa: E402
from lib import armlib  # noqa: E402
from lib import hydralib  # noqa: E402
from lib import stamplib  # noqa: E402

SID = "cccc1111-2222-3333-4444-555566667777"


class AutomationChatTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate tests below explicitly disarm to prove the refusal.
        armlib.arm(3600)
        self.meta = Path(self._tmp.name) / "local_x.json"
        self.meta.write_text(json.dumps({
            "sessionId": "local_x", "cliSessionId": SID, "title": "A chat",
            "model": "claude-opus-4-8", "permissionMode": "acceptEdits",
        }), encoding="utf-8")
        stub = self.stub

        def dossier_route(method, path, query, body):
            if dossier_query(query) not in (SID, "A chat"):
                return {"matches": []}
            return {"matches": [{"instance": "cold", "chatId": "local_x", "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "A chat", "archived": False,
                                 "lastActivityAt": "T1", "live": None,
                                 "metaPath": str(self.meta)}]}

        stub.routes["/api/chats/dossier"] = dossier_route
        stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": False, "signedIn": True}]}
        stub.routes[f"/api/sessions/{SID}/automation"] = {"ok": True, "mode": "bypassPermissions"}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_stamps_both_and_verifies_on_disk(self):
        code, out, _ = run_cli(automation_chat.main, [SID, "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["bypassStamped"])
        self.assertTrue(payload["ultracodeStamped"])
        meta = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertIs(meta["sessionSettings"]["ultracode"], True)
        self.assertEqual(meta["effort"], "xhigh")
        # THE MODEL IS THE CHAT'S OWN - the doctrine's second clause, never touched.
        self.assertEqual(meta["model"], "claude-opus-4-8")

    def test_running_app_gets_the_honest_caveat(self):
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": "c:\\i\\cold", "isRunning": True, "signedIn": True}]}
        code, out, _ = run_cli(automation_chat.main, [SID])
        self.assertEqual(code, 0)
        self.assertIn("RUNNING", out)

    def test_already_stamped_is_idempotent(self):
        self.meta.write_text(json.dumps({
            "cliSessionId": SID, "title": "A chat", "effort": "xhigh",
            "sessionSettings": {"ultracode": True}, "permissionMode": "bypassPermissions",
        }), encoding="utf-8")
        code, out, _ = run_cli(automation_chat.main, [SID])
        self.assertEqual(code, 0)
        self.assertIn("already set", out)

    def test_single_target_stamps_a_held_chat_too(self):
        # Same doctrine as FleetEnforceTest.test_a_held_chat_still_gets_its_PERMISSION_MODE
        # (owner, 2026-09-01): a hold blocks the chat's WORK, never its permission mode - so
        # the single-target path must stamp it, not refuse outright.
        from lib import holdlib

        holdlib.hold(SID, "owner is mid-review")
        code, out, _ = run_cli(automation_chat.main, [SID, "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["held"])
        self.assertTrue(payload["bypassStamped"])
        self.assertTrue(payload["ultracodeStamped"])

    def test_no_meta_path_is_a_deterministic_refusal(self):
        stub = self.stub

        def bare(method, path, query, body):
            if dossier_query(query) != SID:
                return {"matches": []}
            return {"matches": [{"instance": None, "chatId": None, "cliSessionId": SID,
                                 "lineageIds": [SID], "title": "Console stray", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}

        stub.routes["/api/chats/dossier"] = bare
        code, out, _ = run_cli(automation_chat.main, [SID])
        self.assertEqual(code, 3)
        self.assertIn("migrate_chat", out)

    def test_partial_stamp_is_exit_2_with_each_named(self):
        # The disk write is the stamp (both halves, stamplib.stamp_doctrine); a half that did
        # not verify is named and the exit is 2.
        import unittest.mock as mock
        from lib import stamplib

        with mock.patch.object(stamplib, "stamp_doctrine",
                               return_value={"changed": True, "bypass": False,
                                             "ultracode": True, "error": None}):
            code, out, _ = run_cli(automation_chat.main, [SID])
        self.assertEqual(code, 2)
        self.assertIn("bypassPermissions FAILED", out)
        self.assertIn("ultracode stamped", out)

    def test_the_daemons_refusal_alone_is_not_a_failed_stamp(self):
        # 2026-09-01: the permission half used to go only through the daemon's endpoint,
        # which 404s for chats its index does not carry; the disk is the truth now and the
        # endpoint is the extra. A refusal there must not un-stamp a record that verified.
        self.stub.routes[f"/api/sessions/{SID}/automation"] = (422, {"ok": False})
        code, out, _ = run_cli(automation_chat.main, [SID, "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["bypassStamped"])
        meta = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertEqual(meta["permissionMode"], "bypassPermissions")

    def test_stamplib_preserves_every_other_field(self):
        before = json.loads(self.meta.read_text(encoding="utf-8"))
        result = stamplib.stamp_ultracode(self.meta)
        self.assertTrue(result["verified"])
        after = json.loads(self.meta.read_text(encoding="utf-8"))
        for k, v in before.items():
            if k not in ("sessionSettings", "effort"):
                self.assertEqual(after[k], v)

    def test_stamplib_missing_file_reports_never_raises(self):
        result = stamplib.stamp_ultracode(Path(self._tmp.name) / "nope.json")
        self.assertFalse(result["verified"])
        self.assertIsNotNone(result["error"])

    def test_single_target_stamps_even_without_the_icon(self):
        # Owner, 2026-09-01: "a constant check for any chats/threads that are not bypass
        # permissions and it should auto set them to that. This can be done autonomously, as
        # long as it's programmatically." The doctrine is configuration, not the chat's work,
        # so it is the one lane the icon does not gate.
        armlib.disarm()
        code, out, _ = run_cli(automation_chat.main, [SID, "--json"])
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)
        meta = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertEqual(meta["permissionMode"], "bypassPermissions")

    def test_single_target_with_an_armed_window_stamps_as_before(self):
        code, out, _ = run_cli(automation_chat.main, [SID, "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["bypassStamped"])
        self.assertTrue(payload["ultracodeStamped"])


class FleetEnforceTest(unittest.TestCase):
    """--all: the fleet-wide doctrine sweep, against a fake disk store."""

    def setUp(self):
        import unittest.mock as mock

        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        # Default to an ARMED window so every pre-existing act test here keeps exercising the
        # real act path unchanged; the gate test below explicitly disarms to prove the refusal.
        armlib.arm(3600)
        inst_dir = Path(self._tmp.name) / "inst"
        store = inst_dir / "claude-code-sessions" / "w" / "p"
        store.mkdir(parents=True)

        def write(name, **fields):
            p = store / f"local_{name}.json"
            p.write_text(json.dumps(fields), encoding="utf-8")
            return p

        self.unstamped = write("a", cliSessionId="a" * 8, title="Needs both",
                               permissionMode="acceptEdits")
        write("b", cliSessionId="b" * 8, title="Already conformant",
              permissionMode="bypassPermissions", effort="xhigh",
              sessionSettings={"ultracode": True})
        write("c", cliSessionId="c" * 8, title="Archived - left alone",
              permissionMode="acceptEdits", isArchived=True)
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "cold", "dir": str(inst_dir), "isRunning": False, "signedIn": True}]}
        self.stub.routes[f"/api/sessions/{'a' * 8}/automation"] = {"ok": True}
        # keep the test's world to the fake store: Path.home() -> tmp (no real APPDATA reads)
        self._home = mock.patch("pathlib.Path.home", return_value=Path(self._tmp.name))
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def test_plan_lists_only_the_nonconformant_unarchived_chats(self):
        code, out, _ = run_cli(automation_chat.main, ["--all", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["missing"], 1)
        self.assertEqual(payload["rows"][0]["title"], "Needs both")
        self.assertEqual(payload["rows"][0]["missing"], ["bypass", "ultracode"])
        # plan only: nothing was posted, nothing was written
        self.assertEqual(self.stub.posts, [])

    def test_yes_stamps_and_verifies_everything_missing(self):
        code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["stamped"], 1)
        meta = json.loads(self.unstamped.read_text(encoding="utf-8"))
        self.assertIs(meta["sessionSettings"]["ultracode"], True)
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/automation")],
                         [f"/api/sessions/{'a' * 8}/automation"])

    def test_a_held_chat_still_gets_its_PERMISSION_MODE(self):
        # Owner, 2026-09-01: "I am getting sick of having to change things from manual edits to
        # bypass permissions." A hold means do not act on the chat's WORK - no message, no
        # archive, no move. The doctrine stamps are configuration and change nothing the chat
        # is doing, and held chats are exactly the ones he sits in and fixes by hand.
        from lib import holdlib

        holdlib.hold("a" * 8, "owner is mid-review")
        code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["held"], 1)
        self.assertEqual(payload["stamped"], 1)
        meta = json.loads(self.unstamped.read_text(encoding="utf-8"))
        self.assertEqual(meta["permissionMode"], "bypassPermissions")

    def test_all_yes_stamps_even_without_the_icon(self):
        # Owner, 2026-09-01: the bypass check runs "autonomously, as long as it's
        # programmatically" - the fleet pass is the constant check, icon or no icon.
        armlib.disarm()
        code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        self.assertNotIn("DISARMED", out)
        meta = json.loads(self.unstamped.read_text(encoding="utf-8"))
        self.assertEqual(meta["permissionMode"], "bypassPermissions")


class ViaAppTest(unittest.TestCase):
    """set_mode_via_app: a LIVE chat missing bypass under a RUNNING app also gets the app's
    own permission picker pressed (enforce_all --all --yes), never just the disk stamp."""

    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._state = tempfile.TemporaryDirectory()
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        armlib.arm(3600)
        self._home = mock.patch("pathlib.Path.home", return_value=Path(self._tmp.name))
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _write_meta(self, inst_dir: Path, name: str, **fields) -> Path:
        store = inst_dir / "claude-code-sessions" / "w" / "p"
        store.mkdir(parents=True, exist_ok=True)
        p = store / f"local_{name}.json"
        p.write_text(json.dumps(fields), encoding="utf-8")
        return p

    def test_live_running_missing_bypass_triggers_the_picker(self):
        sid = "a" * 8
        inst_dir = Path(self._tmp.name) / "hot"
        self._write_meta(inst_dir, "a", cliSessionId=sid, title="Live chat",
                         permissionMode="acceptEdits")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot", "dir": str(inst_dir), "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"sessions": [{"sessionId": sid}]}
        with mock.patch.object(automation_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0,
                                                       stdout="Bypass permissions set\n",
                                                       stderr="")) as run_mock:
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        pickers = [c.args[0] for c in run_mock.call_args_list if "approve_prompt.ps1" in c.args[0][5]]
        self.assertEqual(len(pickers), 1)
        self.assertIn("-SetMode", pickers[0])
        self.assertIn("Bypass permissions", pickers[0])
        payload = json.loads(out)
        self.assertEqual(payload["picker"][0]["viaApp"], "Bypass permissions set")
        # THE APP IS THE TRUTH (owner, 2026-09-01): the picker's word is the confirmation,
        # kept per chat - the next tick has nothing pending for it.
        self.assertEqual(payload["confirmedInApp"], 1)
        self.assertEqual(payload["pendingInApp"], [])
        self.assertIn(sid, automation_chat.load_confirmed())

    def test_a_running_apps_chat_is_confirmed_through_the_picker_even_when_not_live(self):
        # The app holds every chat's mode in memory, live or not: a chat that is NOT live
        # but sits in a RUNNING app still needs the app's own picker to say bypass once.
        # A chat whose app is shut needs nothing but the disk stamp (it reads it on start).
        sid_not_live = "b" * 8
        inst_hot = Path(self._tmp.name) / "hot2"
        self._write_meta(inst_hot, "b", cliSessionId=sid_not_live, title="Not live",
                         permissionMode="acceptEdits")
        sid_cold = "d" * 8
        inst_cold = Path(self._tmp.name) / "cold2"
        self._write_meta(inst_cold, "d", cliSessionId=sid_cold, title="App shut",
                         permissionMode="acceptEdits")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot2", "dir": str(inst_hot), "isRunning": True, "signedIn": True},
            {"num": 2, "name": "cold2", "dir": str(inst_cold), "isRunning": False, "signedIn": True},
        ]}
        self.stub.routes["/api/sessions/live"] = {"sessions": [{"sessionId": sid_cold}]}
        with mock.patch.object(automation_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="already Bypass permissions\n",
                                                       stderr="")) as run_mock:
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        pickers = [c.args[0] for c in run_mock.call_args_list if "approve_prompt.ps1" in c.args[0][5]]
        self.assertEqual(len(pickers), 1, "one picker: the running app's chat, never the shut app's")
        self.assertEqual(pickers[0][pickers[0].index("-Instance") + 1], str(inst_hot))
        payload = json.loads(out)
        self.assertEqual(payload["inApp"], 1)
        self.assertEqual(payload["confirmedInApp"], 1)

    def test_a_confirmation_is_dropped_when_the_disk_reads_wrong_again(self):
        sid = "e" * 8
        inst_dir = Path(self._tmp.name) / "hot4"
        meta = self._write_meta(inst_dir, "e", cliSessionId=sid, title="Flipped back",
                                permissionMode="bypassPermissions", ultracode=True)
        automation_chat.mark_confirmed(sid, "picker said so earlier")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot4", "dir": str(inst_dir), "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"sessions": []}
        # the app re-saved its real mode over the stamp
        meta.write_text(json.dumps({"cliSessionId": sid, "title": "Flipped back",
                                    "permissionMode": "acceptEdits"}), encoding="utf-8")
        with mock.patch.object(automation_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=3, stdout="no picker\n", stderr="")):
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        payload = json.loads(out)
        self.assertNotIn(sid, automation_chat.load_confirmed())
        self.assertEqual([p["sessionId"] for p in payload["pendingInApp"]], [sid])

    def test_with_the_icon_down_the_disk_is_stamped_but_no_window_is_touched(self):
        # Owner, 2026-09-01, after the picker pass flipped his windows with the icon down:
        # "I made it very clear I can't run that... I didn't authorize you to start one yet."
        # The disk stamp is the programmatic half he allowed; the picker waits for the icon.
        armlib.disarm()
        sid = "g" * 8
        inst_dir = Path(self._tmp.name) / "hot6"
        meta = self._write_meta(inst_dir, "g", cliSessionId=sid, title="Manual chat",
                                permissionMode="acceptEdits")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot6", "dir": str(inst_dir), "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"sessions": [{"sessionId": sid}]}
        with mock.patch.object(automation_chat.clilib, "run_text") as run_mock:
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        pickers = [c.args[0] for c in run_mock.call_args_list if "approve_prompt.ps1" in c.args[0][5]]
        self.assertEqual(pickers, [], "no window is driven while the icon is down")
        self.assertEqual(json.loads(meta.read_text(encoding="utf-8"))["permissionMode"], "bypassPermissions")
        payload = json.loads(out)
        self.assertEqual(payload["confirmedInApp"], 0)
        self.assertIn("waits for the tray icon", payload["report"])

    def test_a_chat_the_app_already_confirmed_gets_no_picker(self):
        # The disk saying bypass proves nothing for a running app; the app's own word does.
        # Once confirmed, a chat missing only ultracode is a disk stamp and nothing else.
        sid = "c" * 8
        inst_dir = Path(self._tmp.name) / "hot3"
        self._write_meta(inst_dir, "c", cliSessionId=sid, title="Needs ultracode only",
                         permissionMode="bypassPermissions")
        automation_chat.mark_confirmed(sid, "already Bypass permissions")
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot3", "dir": str(inst_dir), "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"sessions": [{"sessionId": sid}]}
        with mock.patch.object(automation_chat.clilib, "run_text") as run_mock:
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        self.assertEqual(code, 0)
        pickers = [c.args[0] for c in run_mock.call_args_list if "approve_prompt.ps1" in c.args[0][5]]
        self.assertEqual(pickers, [])
        payload = json.loads(out)
        self.assertEqual(payload["rows"][0]["missing"], ["ultracode"])
        self.assertEqual(payload["confirmedInApp"], 1)
        self.assertEqual(payload["pendingInApp"], [])

    def test_the_picker_pass_is_capped_per_tick_and_never_starts_the_shut_app(self):
        inst_dir = Path(self._tmp.name) / "hot5"
        for i in range(6):
            self._write_meta(inst_dir, f"f{i}", cliSessionId=f"f{i}" * 4, title=f"Chat {i}",
                             permissionMode="bypassPermissions", ultracode=True)
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "hot5", "dir": str(inst_dir), "isRunning": True, "signedIn": True}]}
        self.stub.routes["/api/sessions/live"] = {"sessions": []}
        with mock.patch.object(automation_chat.clilib, "run_text",
                               return_value=mock.Mock(returncode=0, stdout="set\n", stderr="")) as run_mock:
            code, out, _ = run_cli(automation_chat.main, ["--all", "--yes", "--json"])
        pickers = [c.args[0] for c in run_mock.call_args_list if "approve_prompt.ps1" in c.args[0][5]]
        self.assertEqual(len(pickers), automation_chat.PICKER_PER_TICK)
        payload = json.loads(out)
        self.assertEqual(payload["confirmedInApp"], automation_chat.PICKER_PER_TICK)
        self.assertEqual(len(payload["pendingInApp"]), 6 - automation_chat.PICKER_PER_TICK)


if __name__ == "__main__":
    unittest.main()
