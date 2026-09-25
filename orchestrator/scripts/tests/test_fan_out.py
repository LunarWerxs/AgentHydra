"""fan_out.py: one task list -> N visible desktop chats, one account each, tracked as a group.

Every spawn is spawn_chat.spawn, mocked here (its own suite proves the deeplink); what THIS
suite pins is the part that was missing: the spread over accounts by real room, the
per-account cap, unassigned tasks reported rather than dropped, the fleet duplicate check
that still lets one spec share a prompt across its own tasks, the group record surviving a
refusal mid-way, `status` reading real transcript bytes, and `send` posting exactly one
message per member while respecting holds.
"""

import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock as mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402
from util import run_cli  # noqa: E402

import fan_out  # noqa: E402
from lib import holdlib, hydralib, recoverylib  # noqa: E402


def _iso(hours_ago=0.2):
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def survey_row(num, name, email, plan="Max 20×", five=5, week=10, running=True, reason="ok"):
    return {
        "kind": "desktop", "num": num, "id": f"c:\\i\\{name}", "label": name,
        "result": {
            "snapshot": {
                "account": f"{name} <{email}> · {plan}",
                "session": {"pct": five, "resets": "", "resetsAt": None, "severity": "normal"},
                "weekAll": {"pct": week, "resets": "", "resetsAt": None, "severity": "normal"},
                "weekModel": None, "capturedAt": _iso(), "source": "api",
            },
            "cached": False, "key": f"desktop:c:\\i\\{name}", "reason": reason,
        },
        "advice": {"severity": "normal", "bindingPct": week, "shouldOffload": False,
                   "safeToFanOut": True, "advice": "x"},
    }


def fleet_row(num, name, email, running=True, plan="Max 20×"):
    return {"num": num, "name": name, "dir": f"c:\\i\\{name}", "isRunning": running,
            "signedIn": True, "label": name, "account": {"email": email, "planLabel": plan}}


class FanOutBase(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        os.environ["ORCHESTRATOR_STATE_DIR"] = str(self.root / "state")
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.folders = []
        for n in ("plane-a", "plane-b", "plane-c", "plane-d"):
            p = self.root / n
            p.mkdir()
            self.folders.append(str(p))
        # Three open accounts with room (best first: charlie 70 > alice 60 > bob 50), one open
        # with NO room (dave, 5-hour at 100), one closed with room (erin), one unreadable.
        self.stub.routes["/api/usage/survey"] = {"rows": [
            survey_row(1, "alice", "alice@x.com", week=20),
            survey_row(2, "bob", "bob@x.com", week=30),
            survey_row(3, "charlie", "charlie@x.com", week=10),
            survey_row(4, "dave", "dave@x.com", five=100, week=40),
            survey_row(5, "erin", "erin@x.com", week=0, running=False),
            survey_row(6, "frank", "frank@x.com", reason="check_failed"),
        ]}
        self.stub.routes["/api/fleet"] = {"instances": [
            fleet_row(1, "alice", "alice@x.com"),
            fleet_row(2, "bob", "bob@x.com"),
            fleet_row(3, "charlie", "charlie@x.com"),
            fleet_row(4, "dave", "dave@x.com"),
            fleet_row(5, "erin", "erin@x.com", running=False),
            fleet_row(6, "frank", "frank@x.com"),
        ]}
        self.stub.routes["/api/sessions"] = []
        self.stub.routes["/api/sessions/live"] = {"count": 0, "sessions": []}
        # the survey cache lives in the state dir, so a stale real one can never leak in
        self.spawned = []

        def fake_spawn(folder, prompt, instance, force=False):
            n = len(self.spawned) + 1
            self.spawned.append({"folder": folder, "prompt": prompt, "instance": instance,
                                 "force": force})
            return {"ok": True, "sessionId": f"sid-{n}", "started": "running (composer submitted)",
                    "submitted": "sent", "landedIn": "folder", "modeSet": "ok"}

        self.fake_spawn = fake_spawn
        self._spawn_patch = mock.patch.object(fan_out.spawn_chat, "spawn", side_effect=fake_spawn)
        self._spawn_patch.start()
        self.addCleanup(self._spawn_patch.stop)

    def tearDown(self):
        self.stub.close()
        self._tmp.cleanup()

    def spec(self, n, prompt="lint this plane", group=None, same_prompt=True):
        tasks = [{"title": f"task {i}", "folder": self.folders[i % len(self.folders)],
                  "prompt": prompt if same_prompt else f"{prompt} {i}"} for i in range(n)]
        data = {"tasks": tasks}
        if group:
            data["group"] = group
        path = self.root / "spec.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        return str(path)


class PlanTest(FanOutBase):
    def test_targets_are_open_accounts_with_room_best_first_and_closed_only_on_request(self):
        r = fan_out.rank_targets()
        self.assertEqual([t["name"] for t in r["targets"]], ["charlie", "alice", "bob"])
        whys = {s.get("instance"): s["why"] for s in r["skipped"]}
        self.assertIn("closed", whys["#5 erin"])
        self.assertIn("no room", whys["#4 dave"])   # 5-hour window at 100% is not room
        self.assertIn("no room", whys["#6 frank"])  # an unreadable account is never room
        r2 = fan_out.rank_targets(open_closed=True)
        self.assertEqual([t["name"] for t in r2["targets"]], ["charlie", "alice", "bob", "erin"])
        self.assertTrue(r2["targets"][-1]["mustOpen"])

    def _app_log(self, name, minutes_ago, line):
        """A fake instance dir whose app log holds one line stamped `minutes_ago` (local time)."""
        inst = self.root / "instances" / name
        (inst / "logs").mkdir(parents=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - minutes_ago * 60))
        (inst / "logs" / "main.log").write_text(
            "2026-09-01 03:00:27 [info] Failed to set title bar overlay\n"
            f"{stamp} [info] {line}\n", encoding="utf-8")
        return str(inst)

    def test_an_account_a_person_is_working_in_is_not_room_unless_named(self):
        # The 2026-09-15 incident: the owner had sent messages in #37's app minutes earlier; the
        # spawned chat landed there and he stopped and deleted it. Room was the only question asked.
        send = "LocalSessions.sendMessage: sessionId=local_fd6b378e, messageLength=540, priority=next"
        inst_dir = self._app_log("charlie", 3, send)
        # The survey row and the fleet row name the same dir, the way the real ones do: the
        # overview pairs an account to its instance by that dir.
        self.stub.routes["/api/fleet"]["instances"][2]["dir"] = inst_dir
        row = self.stub.routes["/api/usage/survey"]["rows"][2]
        row["id"] = inst_dir
        row["result"]["key"] = f"desktop:{inst_dir}"
        r = fan_out.rank_targets()
        self.assertEqual([t["name"] for t in r["targets"]], ["alice", "bob"])
        why = {s.get("instance"): s["why"] for s in r["skipped"]}["#3 charlie"]
        self.assertIn("a person is working in it", why)
        self.assertIn("3 min ago", why)
        # --only naming it is a person's word and still reaches it.
        r = fan_out.rank_targets(only=["charlie"])
        self.assertEqual([t["name"] for t in r["targets"]], ["charlie"])

    def test_a_click_into_a_chat_counts_but_old_activity_and_other_log_lines_do_not(self):
        click = "[CCD] LocalSessions.setFocusedSession: sessionId=local_02e52be1"
        self.assertIsNotNone(fan_out.hands_on_secs_ago(self._app_log("recent-click", 1, click)))
        self.assertIsNone(fan_out.hands_on_secs_ago(self._app_log("old-click", 25, click)))
        # Focus cleared (sessionId=null) and background noise are not a hand on a chat.
        self.assertIsNone(fan_out.hands_on_secs_ago(self._app_log(
            "null-focus", 1, "[CCD] LocalSessions.setFocusedSession: sessionId=null")))
        self.assertIsNone(fan_out.hands_on_secs_ago(self._app_log(
            "noise", 1, "[updater] Checking for updates")))
        self.assertIsNone(fan_out.hands_on_secs_ago(str(self.root / "no-such-instance")))
        self.assertIsNone(fan_out.hands_on_secs_ago(None))

    def test_only_and_exclude_filter_by_number_name_or_email_and_a_bad_ref_refuses(self):
        r = fan_out.rank_targets(exclude=["3"])
        self.assertEqual([t["name"] for t in r["targets"]], ["alice", "bob"])
        r = fan_out.rank_targets(only=["bob@x.com", "charlie"])
        self.assertEqual([t["name"] for t in r["targets"]], ["charlie", "bob"])
        with self.assertRaises(ValueError):
            fan_out.rank_targets(exclude=["nobody"])

    def test_plan_spreads_one_task_per_account_then_reports_the_rest_unassigned(self):
        targets = fan_out.rank_targets()["targets"]
        tasks = fan_out.parse_spec(self.spec(5))["tasks"]
        p = fan_out.plan(tasks, targets, per_account=1)
        self.assertEqual([a["target"]["name"] if a["target"] else None for a in p],
                         ["charlie", "alice", "bob", None, None])
        p2 = fan_out.plan(tasks, targets, per_account=2)
        self.assertEqual([a["target"]["name"] for a in p2],
                         ["charlie", "alice", "bob", "charlie", "alice"])

    def test_spec_validation_names_the_exact_complaint(self):
        with self.assertRaisesRegex(ValueError, "no tasks"):
            fan_out.parse_spec('{"tasks": []}')
        with self.assertRaisesRegex(ValueError, "not a directory"):
            fan_out.parse_spec(json.dumps([{"folder": str(self.root / "nope"), "prompt": "x"}]))
        with self.assertRaisesRegex(ValueError, "no prompt"):
            fan_out.parse_spec(json.dumps([{"folder": self.folders[0]}]))
        with self.assertRaisesRegex(ValueError, "JSON"):
            fan_out.parse_spec("not json at all")
        got = fan_out.parse_spec(json.dumps([{"folder": self.folders[0], "prompt": "Do it\nnow"}]))
        self.assertEqual(got["tasks"][0]["title"], "Do it")  # defaulted from the prompt


class SpawnTest(FanOutBase):
    def test_dry_run_plans_everything_and_spawns_nothing_and_writes_nothing(self):
        code, out, _ = run_cli(fan_out.main, ["--spec", self.spec(3), "--dry-run", "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertTrue(got["dryRun"])
        self.assertEqual([m["instance"] for m in got["members"]],
                         ["#3 charlie", "#1 alice", "#2 bob"])
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.stub.posts, [])
        self.assertFalse(fan_out._path().exists())

    def test_spawns_one_chat_per_account_and_records_the_group(self):
        code, out, _ = run_cli(fan_out.main, ["--spec", self.spec(3, group="lint sweep"), "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertEqual([m["sessionId"] for m in got["members"]], ["sid-1", "sid-2", "sid-3"])
        self.assertEqual([s["instance"] for s in self.spawned], ["3", "1", "2"])
        saved = fan_out.find_group("lint sweep")
        self.assertEqual(saved["id"], got["id"])
        self.assertEqual([m["state"] for m in saved["members"]], ["spawned"] * 3)
        # spawn_chat's OWN duplicate check is lifted (this loop ran the fleet check itself)
        self.assertTrue(all(s["force"] for s in self.spawned))

    def test_group_id_is_taken_verbatim_when_given_not_generated(self):
        # The MCP `fan_out` tool mints this id itself and hands it back to ITS OWN caller before
        # spawning finishes (defect 2, 2026-09-15: a blocking MCP call died on the client's own
        # transport timeout with no id anyone had ever seen). It must be the id fan_out.py
        # actually uses, or a caller polling fan_out_status by that id would find nothing.
        code, out, _ = run_cli(fan_out.main,
                               ["--spec", self.spec(1), "--group-id", "fo-mcp-abc123", "--json"])
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["id"], "fo-mcp-abc123")
        self.assertIsNotNone(fan_out.find_group("fo-mcp-abc123"))

    def test_more_tasks_than_accounts_leaves_the_rest_unassigned_with_exit_4(self):
        code, out, _ = run_cli(fan_out.main, ["--spec", self.spec(4), "--json"])
        self.assertEqual(code, 4)
        got = json.loads(out)
        self.assertEqual(got["members"][3]["state"], "unassigned")
        self.assertIsNone(got["members"][3]["sessionId"])
        self.assertEqual(len(self.spawned), 3)

    def test_a_refused_spawn_does_not_stop_the_others_and_the_record_says_why(self):
        def flaky(folder, prompt, instance, force=False):
            if instance == "1":
                return {"ok": False, "why": "alice's window is busy"}
            return self.fake_spawn(folder, prompt, instance, force)

        with mock.patch.object(fan_out.spawn_chat, "spawn", side_effect=flaky):
            code, out, _ = run_cli(fan_out.main, ["--spec", self.spec(3), "--json"])
        self.assertEqual(code, 4)
        states = [(m["state"], m["sessionId"]) for m in json.loads(out)["members"]]
        self.assertEqual(states, [("spawned", "sid-1"), ("refused", None), ("spawned", "sid-2")])
        self.assertIn("window is busy", json.loads(out)["members"][1]["why"])

    def test_nothing_spawned_is_exit_2(self):
        with mock.patch.object(fan_out.spawn_chat, "spawn",
                               return_value={"ok": False, "why": "no"}):
            code, _, _ = run_cli(fan_out.main, ["--spec", self.spec(2), "--json"])
        self.assertEqual(code, 2)

    def test_a_daemon_that_is_not_ready_leaves_a_group_record_that_says_so(self):
        # 2026-09-24: the MCP hands out the group id first; a ranking that died on an unready
        # daemon wrote nothing, and status on that id answered "no such fan-out group".
        err = hydralib.DaemonError("/api/fleet", None, "timed out")
        with mock.patch.object(fan_out, "rank_targets", side_effect=err):
            code, _, _ = run_cli(fan_out.main, ["--spec", self.spec(2), "--group-id", "fo-t1",
                                                "--json"])
        self.assertEqual(code, 1)
        code, out, _ = run_cli(fan_out.main, ["status", "fo-t1", "--json"])
        self.assertEqual(code, 0)
        s = json.loads(out)
        self.assertEqual(s["phase"], "failed")
        self.assertIn("daemon not ready", s["error"])

    def test_a_task_already_running_in_the_fleet_is_refused_unless_forced(self):
        existing = [{"session_id": "old-1", "title": "Old lint", "instance": "bob", "live": True}]
        with mock.patch.object(fan_out.hydralib, "same_task_chats", return_value=existing):
            code, out, _ = run_cli(fan_out.main, ["--spec", self.spec(2), "--json"])
        self.assertEqual(code, 2)
        for m in json.loads(out)["members"]:
            self.assertEqual(m["state"], "refused-duplicate")
            self.assertIn("Old lint", m["why"])
        self.assertEqual(self.spawned, [])
        with mock.patch.object(fan_out.hydralib, "same_task_chats", return_value=existing):
            code, _, _ = run_cli(fan_out.main, ["--spec", self.spec(2), "--json", "--force"])
        self.assertEqual(code, 0)
        self.assertEqual(len(self.spawned), 2)

    def test_the_fleet_duplicate_check_excludes_this_groups_own_members(self):
        seen = []

        def same_task(prompt, exclude=None):
            seen.append(set(exclude or ()))
            return []

        with mock.patch.object(fan_out.hydralib, "same_task_chats", side_effect=same_task):
            code, _, _ = run_cli(fan_out.main, ["--spec", self.spec(3), "--json"])
        self.assertEqual(code, 0)
        # the same prompt three times: the 2nd check excludes sid-1, the 3rd excludes both
        self.assertEqual(seen, [set(), {"sid-1"}, {"sid-1", "sid-2"}])

    def test_a_closed_target_is_opened_first_only_with_open_closed(self):
        opened = []

        def route(method, path, query, body):
            opened.append(path)
            self.stub.routes["/api/fleet"]["instances"][4]["isRunning"] = True
            return {"ok": True}

        self.stub.routes["/api/instances/c%3A%5Ci%5Cerin/open"] = route
        with mock.patch.object(fan_out, "OPEN_WAIT_SECS", 5):
            code, out, _ = run_cli(fan_out.main,
                                   ["--spec", self.spec(4), "--open-closed", "--json"])
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertEqual(got["members"][3]["instance"], "#5 erin")
        self.assertTrue(got["members"][3].get("opened"))
        self.assertEqual(len(opened), 1)

    def test_bad_usage_is_exit_3_before_anything_runs(self):
        for argv in ([], ["--spec", "{not json"], ["status", "no-such-group"],
                     ["send", "x"], ["send"], ["delete"], ["delete", "no-such-group"]):
            code, _, _ = run_cli(fan_out.main, argv)
            self.assertEqual(code, 3, argv)
        self.assertEqual(self.spawned, [])


class StatusAndSendTest(FanOutBase):
    def _transcript(self, name, lines):
        p = self.root / f"{name}.jsonl"
        p.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
        old = time.time() - 400  # quiet long enough for an idle/finished verdict
        os.utime(p, (old, old))
        return str(p)

    def _finished_transcript(self, name, text):
        return self._transcript(name, [
            {"type": "user", "message": {"role": "user", "content": "lint this plane"}},
            {"type": "assistant", "message": {"role": "assistant",
                                              "content": [{"type": "text", "text": text}]}},
        ])

    def _spawn_two(self):
        code, out, err = run_cli(fan_out.main, ["--spec", self.spec(2, group="g1"), "--json"])
        # a refusal or a daemon failure explains itself on stderr; a bare "1 != 0" explains nothing
        self.assertEqual(code, 0, err or out)
        return json.loads(out)

    def test_status_reads_each_members_verdict_and_last_words(self):
        self._spawn_two()
        t1 = self._finished_transcript("sid-1", "All clean.\n\n## Am I 100% done?\n- yes")
        t2 = self._finished_transcript("sid-2", "Found 3 errors in plane-b.")
        self.stub.routes["/api/sessions/sid-1"] = {"session_id": "sid-1", "title": "Lint A",
                                                   "transcript_path": t1}
        self.stub.routes["/api/sessions/sid-2"] = {"session_id": "sid-2", "title": "Lint B",
                                                   "transcript_path": t2}
        # sid-2 still has a live engine (a working chat); sid-1 has ended its turn
        self.stub.routes["/api/chats/dossier"] = lambda m, p, q, b: {"matches": [
            {"cliSessionId": "sid-2", "live": {"pid": 4242, "name": "claude",
                                                "startedAt": _iso(1)}}
            if "sid-2" in q else {"cliSessionId": "sid-1", "live": None}]}
        code, out, _ = run_cli(fan_out.main, ["status", "--json"])  # latest group by default
        self.assertEqual(code, 0, out)
        got = json.loads(out)
        self.assertEqual(got["name"], "g1")
        m1, m2 = got["members"]
        self.assertEqual(m1["state"], "finished")
        self.assertEqual(m1["chatTitle"], "Lint A")
        self.assertIn("All clean", m1["lastText"])
        self.assertEqual(m2["state"], "idle")  # live pid, quiet past the idle window
        self.assertIn("3 errors", m2["lastText"])
        self.assertEqual(got["counts"], {"finished": 1, "idle": 1})

    def test_status_never_turns_an_unreadable_liveness_into_a_verdict(self):
        # Review 2026-09-05: live_for raising is "unknown", and gating with live=None would
        # print a confident finished/crashed for a chat that may still be working.
        self._spawn_two()
        t1 = self._finished_transcript("sid-1", "Half way through the lint run.")
        self.stub.routes["/api/sessions/sid-1"] = {"session_id": "sid-1", "title": "Lint A",
                                                   "transcript_path": t1}
        self.stub.routes["/api/chats/dossier"] = (500, {"error": "boom"})
        code, out, _ = run_cli(fan_out.main, ["status", "g1", "--json"])
        self.assertEqual(code, 0, out)
        m1 = json.loads(out)["members"][0]
        self.assertEqual(m1["state"], "unknown")
        self.assertFalse(m1["liveKnown"])
        self.assertNotIn("cause", m1)
        self.assertIn("Half way", m1["lastText"])  # the words still come through

    def test_status_of_an_unspawned_member_carries_its_spawn_state(self):
        with mock.patch.object(fan_out.spawn_chat, "spawn",
                               return_value={"ok": False, "why": "busy"}):
            run_cli(fan_out.main, ["--spec", self.spec(1, group="g2"), "--json"])
        code, out, _ = run_cli(fan_out.main, ["status", "g2", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["members"][0]["state"], "refused")

    def test_send_posts_one_message_per_member_and_respects_holds(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-1/message"] = {"ok": True, "delivered": True,
                                                           "route": "peer"}
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True,
                                                           "route": "composer"}
        code, out, _ = run_cli(fan_out.main,
                               ["send", "g1", "--text", "Also check the tests.", "--json"])
        self.assertEqual(code, 0, out)
        posts = [(p, b) for p, b in self.stub.posts if p.endswith("/message")]
        self.assertEqual([p for p, _ in posts],
                         ["/api/sessions/sid-1/message", "/api/sessions/sid-2/message"])
        self.assertTrue(all(b["text"] == "Also check the tests." for _, b in posts))
        self.assertEqual(len(fan_out.find_group("g1")["sends"]), 1)

        # a HELD member is skipped, and named; --force is a person's word past the hold
        holdlib.hold("sid-1", "mine", by="owner")
        self.stub.posts.clear()
        code, out, _ = run_cli(fan_out.main, ["send", "g1", "--text", "again", "--json"])
        self.assertEqual(code, 0)
        got = json.loads(out)
        self.assertIn("HELD", got["results"][0]["skipped"])
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/message")],
                         ["/api/sessions/sid-2/message"])
        self.stub.posts.clear()
        run_cli(fan_out.main, ["send", "g1", "--text", "again", "--json", "--force"])
        self.assertEqual(len([p for p, _ in self.stub.posts if p.endswith("/message")]), 2)

    def test_send_only_narrows_to_named_sessions_and_an_undelivered_send_is_exit_4(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = (422, {"ok": False, "delivered": False,
                                                                 "detail": "no confirm"})
        code, out, _ = run_cli(fan_out.main, ["send", "g1", "--text", "x", "--only", "sid-2",
                                              "--json"])
        self.assertEqual(code, 4)
        got = json.loads(out)
        self.assertEqual([r["sessionId"] for r in got["results"]], ["sid-2"])
        self.assertFalse(got["results"][0]["delivered"])
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/message")],
                         ["/api/sessions/sid-2/message"])

    def test_send_stops_an_idle_engine_first_so_the_composer_boots_the_chat(self):
        # THE PEER PIPE IS NOT A SEND for a chat nobody has clicked (measured 2026-09-04): the
        # member's idle engine is stopped and the route is asked to boot it via the composer.
        self._spawn_two()
        self.stub.routes["/api/chats/dossier"] = lambda m, p, q, b: {"matches": [
            {"cliSessionId": "sid-1", "lineageIds": ["sid-1"],
             "live": {"pid": 77, "name": "claude", "startedAt": _iso(1)}}
            if "sid-1" in q else {"cliSessionId": "sid-2", "live": None}]}
        self.stub.routes["/api/sessions/sid-1/message"] = {"ok": True, "delivered": True,
                                                           "route": "composer"}
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True,
                                                           "route": "composer"}
        stops = []

        def stop(match, min_quiet_secs=300, idle_after_secs=180):
            stops.append((match.get("cliSessionId"), min_quiet_secs))
            return {"stopped": True, "pid": 77, "reason": "idle", "why": "idle"}

        with mock.patch.object(fan_out.enginelib, "background_work",
                               return_value={"scanned": True, "outstanding": []}), \
             mock.patch.object(fan_out.enginelib, "stop_idle_engine", side_effect=stop):
            code, out, _ = run_cli(fan_out.main, ["send", "g1", "--text", "go on", "--json"])
        self.assertEqual(code, 0, out)
        self.assertEqual(stops, [("sid-1", 15)])  # only the live one; the fast window
        posts = [(p, b) for p, b in self.stub.posts if p.endswith("/message")]
        self.assertEqual(len(posts), 2)
        self.assertTrue(all(b.get("allow_stop_idle") is True for _, b in posts))
        got = json.loads(out)
        self.assertEqual(got["results"][0]["engine"]["state"], "stopped")
        self.assertEqual(got["results"][1]["engine"]["state"], "not-live")

    def test_send_supplies_a_terse_last_line_as_the_placeholder_verify_and_never_a_long_one(self):
        # The route refuses to type blind when every transcript line is under its 10-character
        # floor - what "PONG" looks like. A short last line rides along as the documented
        # placeholder; a long one is left to the route's own derivation.
        self._spawn_two()
        t1 = self._finished_transcript("sid-1", "PONG")
        t2 = self._finished_transcript("sid-2", "Found 3 errors in plane-b, all fixed.")
        self.stub.routes["/api/sessions/sid-1"] = {"session_id": "sid-1", "transcript_path": t1}
        self.stub.routes["/api/sessions/sid-2"] = {"session_id": "sid-2", "transcript_path": t2}
        self.stub.routes["/api/sessions/sid-1/message"] = {"ok": True, "delivered": True}
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True}
        code, _, _ = run_cli(fan_out.main, ["send", "g1", "--text", "again", "--json"])
        self.assertEqual(code, 0)
        bodies = {p: b for p, b in self.stub.posts if p.endswith("/message")}
        self.assertEqual(bodies["/api/sessions/sid-1/message"].get("verify_text"), "PONG")
        self.assertNotIn("verify_text", bodies["/api/sessions/sid-2/message"])

    def test_send_skips_a_member_whose_engine_is_working_and_says_why(self):
        self._spawn_two()
        self.stub.routes["/api/chats/dossier"] = lambda m, p, q, b: {"matches": [
            {"cliSessionId": "sid-1", "live": {"pid": 77}} if "sid-1" in q
            else {"cliSessionId": "sid-2", "live": None}]}
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True}
        with mock.patch.object(fan_out.enginelib, "background_work",
                               return_value={"scanned": True, "outstanding": []}), \
             mock.patch.object(fan_out.enginelib, "stop_idle_engine",
                               return_value={"stopped": False, "reason": "working",
                                             "why": "a turn is in flight"}):
            code, out, _ = run_cli(fan_out.main, ["send", "g1", "--text", "go on", "--json"])
        self.assertEqual(code, 0)  # the one attempted send landed; the skip is named
        got = json.loads(out)
        self.assertIn("in flight", got["results"][0]["skipped"])
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/message")],
                         ["/api/sessions/sid-2/message"])

    def test_delete_runs_delete_chat_on_every_member_and_marks_the_group(self):
        self._spawn_two()
        calls = []

        def fake_delete(sid, stop_idle=False, force=False, instance_hint=None):
            calls.append((sid, stop_idle, force, instance_hint))
            return {"ok": True, "code": 0, "sessionId": sid, "trash": f"/trash/{sid}",
                    "remaining": [], "ui": [], "note": None}

        with mock.patch.object(fan_out.delete_chat, "delete", side_effect=fake_delete):
            code, out, _ = run_cli(fan_out.main, ["delete", "g1", "--json"])
        self.assertEqual(code, 0, out)
        # the hint is the instance each chat was spawned into (charlie #3, alice #1)
        self.assertEqual(calls, [("sid-1", True, False, "3"), ("sid-2", True, False, "1")])
        saved = fan_out.find_group("g1")
        self.assertTrue(all(m["deleted"] for m in saved["members"]))
        self.assertTrue(saved.get("deletedAt"))
        # status now says deleted, and a second delete has nothing left to do
        code, out, _ = run_cli(fan_out.main, ["status", "g1", "--json"])
        self.assertEqual({m["state"] for m in json.loads(out)["members"]}, {"deleted"})
        with mock.patch.object(fan_out.delete_chat, "delete", side_effect=fake_delete) as again:
            code, _, _ = run_cli(fan_out.main, ["delete", "g1", "--json"])
        self.assertEqual(code, 2)
        again.assert_not_called()

    def test_a_member_that_will_not_delete_is_partial_and_force_is_forwarded(self):
        self._spawn_two()

        def flaky(sid, stop_idle=False, force=False, instance_hint=None):
            if sid == "sid-2":
                return {"ok": False, "code": 3, "why": "LIVE writer (pid 9)"}
            return {"ok": True, "code": 0, "sessionId": sid, "trash": "/t", "remaining": []}

        with mock.patch.object(fan_out.delete_chat, "delete", side_effect=flaky) as d:
            code, out, _ = run_cli(fan_out.main, ["delete", "g1", "--json", "--force"])
        self.assertEqual(code, 4)
        got = json.loads(out)
        self.assertEqual([r["deleted"] for r in got["results"]], [True, False])
        self.assertIn("LIVE writer", got["results"][1]["why"])
        self.assertTrue(all(c.kwargs.get("force") for c in d.call_args_list))
        self.assertFalse(fan_out.find_group("g1").get("deletedAt"))

    def test_delete_never_touches_a_member_whose_chat_opens_with_somebody_elses_words(self):
        # 2026-09-23: a spawn adopted a chat a person had just started on the same account, so
        # fan_out_delete would have deleted it. --force is a person's word about holds, not about
        # whose chat it is.
        self._spawn_two()
        t1 = self._transcript("sid-1", [
            {"type": "user", "message": {"role": "user", "content": "fix the GP invoices page"}}])
        self.stub.routes["/api/sessions/sid-1"] = {"session_id": "sid-1", "transcript_path": t1}
        with mock.patch.object(fan_out.delete_chat, "delete",
                               return_value={"ok": True, "code": 0}) as d:
            code, out, _ = run_cli(fan_out.main, ["delete", "g1", "--json", "--force"])
        self.assertEqual([c.args[0] for c in d.call_args_list], ["sid-2"])
        self.assertIn("not this group's chat", json.loads(out)["results"][0]["skipped"])
        self.assertEqual(fan_out.find_group("g1")["members"][0]["state"], "unbound")

    def test_list_shows_every_group_newest_last(self):
        self._spawn_two()
        code, out, err = run_cli(fan_out.main, ["--spec", self.spec(1, group="g3"), "--json"])
        self.assertEqual(code, 0, err or out)
        code, out, err = run_cli(fan_out.main, ["list", "--json"])
        self.assertEqual(code, 0, err or out)
        rows = json.loads(out)["groups"]
        self.assertEqual([r["name"] for r in rows], ["g1", "g3"])
        self.assertEqual(rows[0]["spawned"], 2)


class OpenAndWaitTest(FanOutBase):
    """_open_and_wait drives the wait with an injected clock and sleep, so the verdict depends on
    the instance, never on where the wall clock happened to fall between two looks."""

    def _drive(self, comes_up_at, wait_secs=12):
        now = [0.0]
        sleeps = []

        def sleep(secs):
            sleeps.append(secs)
            now[0] += secs

        def fleet(method, path, query, body):
            return {"instances": [fleet_row(5, "erin", "erin@x.com", running=now[0] >= comes_up_at)]}

        self.stub.routes["/api/fleet"] = fleet
        self.stub.routes["/api/instances/c%3A%5Ci%5Cerin/open"] = {"ok": True}
        with mock.patch.object(fan_out, "OPEN_WAIT_SECS", wait_secs):
            why = fan_out._open_and_wait({"dir": "c:\\i\\erin", "num": 5},
                                         clock=lambda: now[0], sleep=sleep)
        return why, sleeps

    def test_an_instance_up_by_the_deadline_is_seen_by_the_look_after_the_last_sleep(self):
        # up at t=12 exactly: looks at 0, 5, 10 say no; the last sleep is the 2s LEFT, not 5;
        # the look at t=12 says yes. The old loop slept 5, woke at 15 past the deadline, and
        # reported an instance that was running as never having come up.
        why, sleeps = self._drive(comes_up_at=12)
        self.assertIsNone(why)
        self.assertEqual(sleeps, [5, 5, 2])

    def test_an_instance_that_never_comes_up_is_reported_after_exactly_the_wait(self):
        why, sleeps = self._drive(comes_up_at=10_000)
        self.assertEqual(why, "opened, but not running after 12s")
        self.assertEqual(sum(sleeps), 12)
        self.assertTrue(all(0 < s <= fan_out.OPEN_POLL_SECS for s in sleeps), sleeps)

    def test_an_instance_already_running_costs_no_sleep(self):
        why, sleeps = self._drive(comes_up_at=0)
        self.assertIsNone(why)
        self.assertEqual(sleeps, [])


class RecoverTest(FanOutBase):
    """`recover`: each failed member met with its recipe from lib/recoverylib - one automatic
    attempt, then the escalation - and `status` showing the recipe and the ledger."""

    LONG = "Re-run the lint with --fix and report every file it changed. " * 6  # > the 200 kept

    def _spawn_two(self):
        code, out, err = run_cli(fan_out.main, ["--spec", self.spec(2, group="g1"), "--json"])
        self.assertEqual(code, 0, err or out)

    def _message_posts(self, sid="sid-2"):
        return [b for p, b in self.stub.posts if p == f"/api/sessions/{sid}/message"]

    def test_a_422_is_never_resent_because_it_may_already_be_typed(self):
        # the route's own word: a peer pipe that did not confirm must not be sent again
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = (
            422, {"ok": False, "route": "peer", "delivered": False,
                  "detail": "peer channel did not confirm (timeout)"})
        run_cli(fan_out.main, ["send", "g1", "--text", "x" * 20, "--only", "sid-2", "--json"])
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True}
        self.stub.posts.clear()
        code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(code, 4)
        (row,) = json.loads(out)["results"]
        self.assertEqual((row["kind"], row["outcome"]), ("delivery-failed", "escalated"))
        self.assertIn("never re-sent blind", row["detail"])
        self.assertEqual(self._message_posts(), [])

    def test_a_stalled_chat_is_asked_once_and_not_again_while_it_stays_stalled(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True}
        real = fan_out._member_status

        def stalled(m):
            out = real(m)
            if m.get("sessionId") == "sid-2":
                out["state"] = "stalled"
            return out

        self.stub.posts.clear()
        with mock.patch.object(fan_out, "_member_status", stalled):
            code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
            self.assertEqual(code, 0)
            (row,) = json.loads(out)["results"]
            self.assertEqual((row["kind"], row["outcome"]), ("chat-stalled", "asked"))
            self.assertEqual([b["text"] for b in self._message_posts()], [fan_out.STALL_QUESTION])
            self.stub.posts.clear()
            code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
            self.assertEqual(code, 4)
            self.assertEqual(self._message_posts(), [])  # still stalled: the one ask is spent
        # no longer stalled: the spent ask is freed for a later stall
        group = fan_out.find_group("g1")
        subject = fan_out._subject(group, group["members"][1])
        self.assertEqual(recoverylib.attempts_used("chat-stalled", subject), 1)
        run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(recoverylib.attempts_used("chat-stalled", subject), 0)

    def test_a_refused_send_is_resent_once_with_its_whole_text(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = (409, {"error": "composer busy"})
        run_cli(fan_out.main, ["send", "g1", "--text", self.LONG, "--only", "sid-2", "--json"])
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": True}
        self.stub.posts.clear()
        code, out, err = run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(code, 0, err or out)
        (row,) = json.loads(out)["results"]
        self.assertEqual((row["kind"], row["outcome"]), ("delivery-failed", "recovered"))
        self.assertEqual([b["text"] for b in self._message_posts()], [self.LONG])

    def test_a_refusal_that_persists_escalates_to_an_incident_and_is_never_tried_twice(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = (409, {"error": "composer busy"})
        run_cli(fan_out.main, ["send", "g1", "--text", "x" * 20, "--only", "sid-2", "--json"])
        self.stub.posts.clear()
        code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(code, 4)
        (row,) = json.loads(out)["results"]
        self.assertEqual(row["escalation"], "alert-human")
        self.assertTrue(row["incident"])
        self.assertEqual(len(self._message_posts()), 1)
        self.stub.posts.clear()
        code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(code, 4)
        self.assertEqual(self._message_posts(), [])  # the attempt is spent
        # status carries the member's recipe and the group's ledger
        _, out, _ = run_cli(fan_out.main, ["status", "g1", "--json"])
        got = json.loads(out)
        rec = got["members"][1]["recovery"]
        self.assertEqual((rec["kind"], rec["attemptsUsed"], rec["maxAttempts"]),
                         ("delivery-failed", 1, 1))
        self.assertNotIn("recovery", got["members"][0])
        self.assertEqual([r["outcome"] for r in got["recoveries"]], ["escalated", "escalated"])

    def test_an_unconfirmed_send_is_never_resent_blind(self):
        self._spawn_two()
        self.stub.routes["/api/sessions/sid-2/message"] = {"ok": True, "delivered": False,
                                                           "detail": "no confirm"}
        run_cli(fan_out.main, ["send", "g1", "--text", "x" * 20, "--only", "sid-2", "--json"])
        self.stub.posts.clear()
        code, out, _ = run_cli(fan_out.main, ["recover", "g1", "--json"])
        self.assertEqual(code, 4)
        (row,) = json.loads(out)["results"]
        self.assertEqual(row["outcome"], "escalated")
        self.assertIn("never re-sent blind", row["detail"])
        self.assertEqual(self._message_posts(), [])

    def test_an_unassigned_task_is_replaced_inside_the_groups_own_fence(self):
        # only charlie is left once alice and bob are excluded (dave has no 5-hour room)
        code, _, _ = run_cli(fan_out.main, ["--spec", self.spec(2, group="g3", same_prompt=False),
                                            "--exclude", "1", "--exclude", "2", "--json"])
        self.assertEqual(code, 4)
        self.assertEqual(fan_out.find_group("g3")["members"][1]["state"], "unassigned")
        # dave's window resets; alice (more room than dave) is still behind the group's fence
        self.stub.routes["/api/usage/survey"]["rows"][3] = survey_row(4, "dave", "dave@x.com",
                                                                      five=5, week=40)
        code, out, err = run_cli(fan_out.main, ["recover", "g3", "--json"])
        self.assertEqual(code, 0, err or out)
        (row,) = json.loads(out)["results"]
        self.assertEqual((row["kind"], row["outcome"]), ("account-at-cap", "recovered"))
        self.assertEqual([s["instance"] for s in self.spawned], ["3", "4"])
        self.assertEqual(fan_out.find_group("g3")["members"][1]["state"], "spawned")
        # nothing is owed any more
        code, out, _ = run_cli(fan_out.main, ["recover", "g3", "--json"])
        self.assertEqual((code, json.loads(out)["results"]), (2, []))


if __name__ == "__main__":
    unittest.main()
