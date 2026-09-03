"""balance.py: account aggregation, next-account ranking, the move plan, and the likelihood
verdict - plus the doctrine rails (desktop stays desktop, live never moves, stale is not
headroom)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import balance  # noqa: E402


def iso(hours_ago=0.0):
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def survey_row(kind="desktop", num=1, id_="c:\\i\\a", label="a", email="a@x.com",
               plan="Max 20×", five=5, week=10, model=12, binding=None, offload=False,
               reason="ok", hours_ago=0.5):
    binding = binding if binding is not None else week
    return {
        "kind": kind, "num": num, "id": id_, "label": label,
        "result": {
            "snapshot": {
                "account": f"{label} <{email}> · {plan}" if email else label,
                "session": {"pct": five, "resets": "9pm", "resetsAt": None, "severity": "normal"},
                "weekAll": {"pct": week, "resets": "Sep 4", "resetsAt": None, "severity": "normal"},
                "weekModel": {"pct": model, "resets": "Sep 4", "resetsAt": None, "severity": "normal", "label": "Fable"},
                "capturedAt": iso(hours_ago),
                "source": "api",
            },
            "cached": False, "key": f"{kind}:{id_}", "reason": reason,
        },
        "advice": {"severity": "normal", "bindingPct": binding, "shouldOffload": offload,
                   "safeToFanOut": not offload, "advice": "x"},
    }


def fleet_for(rows):
    return {"instances": [
        {"num": r["num"], "name": r["label"], "dir": r["id"], "isRunning": r["num"] == 1,
         "signedIn": True, "account": {"email": _email(r), "planLabel": "Max 20×"}}
        for r in rows if r["kind"] == "desktop"
    ]}


def _email(r):
    import re

    m = re.search(r"<([^>]+)>", r["result"]["snapshot"]["account"])
    return m.group(1) if m else None


def chat(sid, kind, instance="a", email="a@x.com", action="", state=None):
    return {"sessionId": sid, "title": sid, "instance": instance,
            "origin": "desktop" if instance else "console",
            "account": {"email": email} if instance else None,
            "state": state,
            "decision": {"kind": kind, "action": action, "detail": "", "command": None}}


class AccountsOverviewTest(unittest.TestCase):
    def test_parse_account_string(self):
        self.assertEqual(balance._parse_account_string("ape <ape@x.com> · Max 20×"),
                         ("ape@x.com", "Max 20×"))
        self.assertEqual(balance._parse_account_string("linked-cli"), (None, None))

    def test_desktop_rows_join_fleet_and_cli_rows_parse(self):
        rows = [survey_row(), survey_row(kind="cli", num=None, id_="cli:u1", label="linked", email="c@x.com")]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        by = {a["identity"]: a for a in accts}
        self.assertIn("a@x.com", by)
        self.assertEqual(by["a@x.com"]["instances"][0]["name"], "a")
        self.assertIn("c@x.com", by)
        self.assertFalse(by["c@x.com"]["usable"])  # cli logins cannot host desktop chats

    def test_stale_or_failed_reading_is_never_usable(self):
        rows = [survey_row(hours_ago=100), survey_row(num=2, id_="c:\\i\\b", label="b",
                                                      email="b@x.com", reason="check_failed")]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        self.assertTrue(all(not a["usable"] for a in accts))

    def test_pressure_via_pct_and_via_daemon_advice(self):
        rows = [survey_row(week=85, binding=85),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com", week=30, offload=True)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        self.assertTrue(all(a["underPressure"] for a in accts))

    def test_rank_next_prefers_most_fill_room_among_open(self):
        # Both OPEN (num=1 renders isRunning in the fixture fleet): most room under the
        # ceiling wins - deliberately filling under-used accounts is the point.
        rows = [survey_row(week=60, binding=60),
                survey_row(num=1, id_="c:\\i\\b", label="b", email="b@x.com", week=10, binding=10)]
        ranked = balance.rank_next(balance.accounts_overview({"rows": rows}, fleet_for(rows)))
        self.assertEqual(ranked[0]["email"], "b@x.com")


class UsageFallbackTest(unittest.TestCase):
    """A usage outage must degrade, never take the other lanes down with it."""

    def setUp(self):
        import os
        import tempfile

        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from stubdaemon import StubDaemon

        # hydralib.usage_survey serves a copy under 4 minutes old from state/usage-survey.json
        # (2026-09-01): without its own state dir this test read the REAL fleet's cache,
        # the stubbed outage never happened, and the fallback under test never ran.
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self.addCleanup(os.environ.pop, "ORCHESTRATOR_STATE_DIR", None)
        self.addCleanup(self._state.cleanup)
        self.stub = StubDaemon()
        from lib import hydralib

        hydralib.BASE = self.stub.url
        self.hydralib = hydralib

    def tearDown(self):
        self.stub.close()

    def test_survey_failure_falls_back_to_cache_labeled_as_cached(self):
        self.stub.routes["/api/usage/survey"] = (500, {"error": "down"})
        self.stub.routes["/api/usage/cache"] = {"cache": {
            "desktop:c:\\i\\a": {"account": "a <a@x.com> · Max 20×", "session": {"pct": 1},
                                  "weekAll": {"pct": 12, "severity": "normal"},
                                  "weekModel": {"pct": 12}, "capturedAt": iso(0.2)}}}
        rows, source = balance.usage_rows_with_fallback()
        self.assertEqual(source, "cache-fallback")
        self.assertEqual(len(rows["rows"]), 1)

    def test_total_outage_returns_no_rows_not_an_exception(self):
        self.stub.routes["/api/usage/survey"] = (500, {"error": "down"})
        self.stub.routes["/api/usage/cache"] = (500, {"error": "down"})
        rows, source = balance.usage_rows_with_fallback()
        self.assertEqual(source, "unavailable")
        self.assertEqual(rows["rows"], [])


class PlanMovesTest(unittest.TestCase):
    def accounts(self, hot_pct=90, cool_pct=10):
        rows = [survey_row(week=hot_pct, binding=hot_pct),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com",
                           week=cool_pct, binding=cool_pct)]
        return balance.accounts_overview({"rows": rows}, fleet_for(rows))

    def test_crashed_on_usage_wall_moves_first(self):
        chats = [chat("s1", "resume", action="resume candidate - crashed (usage-limit)"),
                 chat("s2", "wait-on-person")]
        plan = balance.plan_moves(self.accounts(), chats)
        self.assertEqual(plan["likelihood"]["level"], "likely")
        self.assertEqual([m["sessionId"] for m in plan["moves"]], ["s1", "s2"])
        self.assertEqual(plan["moves"][0]["to"]["instance"], "b")
        self.assertIn("migrate_chat.py s1 --to b", plan["moves"][0]["command"])

    def test_live_chats_never_move(self):
        chats = [chat("s1", "judgment"), chat("s2", "leave-alone")]
        plan = balance.plan_moves(self.accounts(), chats)
        self.assertEqual(plan["moves"], [])
        self.assertEqual(plan["likelihood"]["level"], "unlikely")

    def test_no_pressure_means_unlikely_and_no_moves(self):
        chats = [chat("s1", "wait-on-person")]
        plan = balance.plan_moves(self.accounts(hot_pct=40), chats)
        self.assertEqual(plan["moves"], [])
        self.assertEqual(plan["likelihood"]["level"], "unlikely")
        self.assertIn("no OPEN account is under pressure", plan["likelihood"]["why"])

    def test_hot_closed_account_is_a_self_note_not_a_move_driver(self):
        # 'a' is OPEN and cool; make 'b' CLOSED and hot: pressure on b must move nothing.
        rows = [survey_row(week=10, binding=10),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com", week=95, binding=95)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        by = {a["email"]: a for a in accts}
        self.assertTrue(by["b@x.com"]["underPressure"] and not by["b@x.com"]["open"])
        plan = balance.plan_moves(accts, [chat("s1", "wait-on-person", instance="b", email="b@x.com")])
        self.assertEqual(plan["moves"], [])
        self.assertIn("no OPEN account is under pressure", plan["likelihood"]["why"])

    def test_handoff_prefers_open_account_over_cooler_closed_one(self):
        # OPEN 'a' at 34% beats CLOSED 'b' at 0% - you always use open accounts unless you must open.
        rows = [survey_row(week=34, binding=34),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com", week=0, binding=0)]
        ranked = balance.rank_next(balance.accounts_overview({"rows": rows}, fleet_for(rows)))
        self.assertEqual(ranked[0]["email"], "a@x.com")
        self.assertFalse(ranked[0]["mustOpen"])
        self.assertTrue(ranked[1]["mustOpen"])

    def test_closed_account_is_last_resort_when_no_open_has_headroom(self):
        rows = [survey_row(week=90, binding=90),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com", week=0, binding=0)]
        ranked = balance.rank_next(balance.accounts_overview({"rows": rows}, fleet_for(rows)))
        self.assertEqual([a["email"] for a in ranked], ["b@x.com"])  # the hot open one is no target
        self.assertTrue(ranked[0]["mustOpen"])

    def test_pressure_without_headroom_is_blocked(self):
        # BOTH accounts past their fill ceilings (Max 20x ceiling = 83): nothing to move onto.
        chats = [chat("s1", "wait-on-person")]
        plan = balance.plan_moves(self.accounts(hot_pct=95, cool_pct=87), chats)
        self.assertEqual(plan["likelihood"]["level"], "blocked")
        self.assertEqual(plan["moves"], [])

    def test_the_bands_and_ceilings(self):
        # The owner's numbers (2026-08-31): target 85, hard gate 90, plan-sized fill leeway.
        self.assertEqual(balance.band_of(91), "over-hard")
        self.assertEqual(balance.band_of(86), "over-soft")
        self.assertEqual(balance.band_of(84), "ok")
        self.assertEqual(balance.band_of(None), "unknown")
        self.assertEqual(balance.fill_ceiling("Max 20×"), 83)
        self.assertEqual(balance.fill_ceiling("Max 5×"), 80)
        self.assertEqual(balance.fill_ceiling("Pro"), 75)
        self.assertEqual(balance.fill_ceiling(None), 75)

    def test_hard_gate_evacuation_is_mandatory_language(self):
        plan = balance.plan_moves(self.accounts(hot_pct=92), [chat("s1", "wait-on-person")])
        self.assertEqual(len(plan["moves"]), 1)
        self.assertIn("HARD GATE", plan["moves"][0]["why"])
        self.assertIn("mandatory", plan["moves"][0]["why"])

    def test_a_running_chat_never_moves_even_under_the_hard_gate(self):
        # Owner order, 2026-09-01: "Never move active chats. Only chats that are stopped,
        # waiting, chilling." Mirrors test_hard_gate_evacuation_is_mandatory_language's shape
        # (a hot account, decision kind wait-on-person - the shape that used to move) but pins
        # that a live ("running") chat is skipped, while the identical row once it has stopped
        # ("finished") still moves.
        accts = self.accounts(hot_pct=92)
        running = chat("s1", "wait-on-person", state="running")
        self.assertEqual(balance.plan_moves(accts, [running])["moves"], [])
        finished = chat("s1", "wait-on-person", state="finished")
        self.assertEqual(len(balance.plan_moves(accts, [finished])["moves"]), 1)

    def test_over_soft_target_is_advice_not_mandate_language(self):
        plan = balance.plan_moves(self.accounts(hot_pct=87), [chat("s1", "wait-on-person")])
        self.assertEqual(len(plan["moves"]), 1)
        self.assertNotIn("HARD GATE", plan["moves"][0]["why"])
        self.assertIn("over the 85% target", plan["moves"][0]["why"])

    def test_peak_takes_the_worst_window_not_just_binding(self):
        # 5-hour at 91 with weekly at 20 must still trip the hard gate - the owner gates on EITHER.
        rows = [survey_row(five=91, week=20, binding=20)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        self.assertEqual(accts[0]["band"], "over-hard")

    def test_moves_spread_round_robin_never_dump_on_one_account(self):
        # Owner, 2026-08-31: "load balancing does not mean dump everything in one account" -
        # four movable chats over two cool open targets must land 2/2, not 4/0.
        rows = [survey_row(week=92, binding=92),
                survey_row(num=1, id_="c:\\i\\b", label="b", email="b@x.com", week=10, binding=10),
                survey_row(num=1, id_="c:\\i\\c", label="c", email="c@x.com", week=12, binding=12)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        chats = [chat(f"s{i}", "wait-on-person") for i in range(4)]
        plan = balance.plan_moves(accts, chats)
        to = [m["to"]["instance"] for m in plan["moves"]]
        self.assertEqual(len(to), 4)
        self.assertEqual(sorted(set(to)), ["b", "c"])
        self.assertEqual(to.count("b"), 2)
        self.assertEqual(to.count("c"), 2)

    def test_deliberate_fill_lists_open_accounts_with_room_only(self):
        # 'a' is OPEN and cool -> it is the fill surface; 'b' is closed and never appears
        # (filling a closed app is opening an account, which is the marked last resort).
        rows = [survey_row(week=10, binding=10),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="b@x.com", week=5, binding=5)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        plan = balance.plan_moves(accts, [])
        self.assertEqual([f["email"] for f in plan["fill"]], ["a@x.com"])
        self.assertIn("simpler chats", plan["fill"][0]["note"])
        self.assertEqual(plan["fill"][0]["fillCeiling"], 83)

    def test_every_console_stray_is_mandated_into_the_desktop(self):
        # ALL console chats land - done ones included (they cannot even be archived until
        # they have a desktop record). Owner mandate, 2026-08-31.
        chats = [chat("s1", "wait-on-person", instance=None, email=None),
                 chat("s2", "archive", instance=None, email=None),
                 chat("s3", "resume", instance=None, email=None)]
        plan = balance.plan_moves(self.accounts(hot_pct=20), chats)
        self.assertEqual({c["sessionId"] for c in plan["consoleStrays"]}, {"s1", "s2", "s3"})
        for c in plan["consoleStrays"]:
            self.assertIn("MUST be landed", c["why"])
            self.assertIn(f"migrate_chat.py {c['sessionId']} --to", c["command"])

    def test_on_hold_console_stray_lands_untargeted_and_never_debits_room(self):
        # An on-hold console stray must be listed (never hidden) but never TARGETED - a
        # targeted row would debit room the next stray needs and queue a migrate that
        # migrate_chat refuses anyway. 'b' has exactly ONE move's worth of room (4%), so if
        # the held row wrongly called next_target and debited it, the following real stray
        # would come up empty.
        rows = [survey_row(week=95, binding=95),
                survey_row(num=1, id_="c:\\i\\b", label="b", email="b@x.com", week=79, binding=79)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        chats = [chat("s1", "on-hold", instance=None, email=None),
                 chat("s2", "wait-on-person", instance=None, email=None)]
        plan = balance.plan_moves(accts, chats)
        by_sid = {c["sessionId"]: c for c in plan["consoleStrays"]}
        held = by_sid["s1"]
        self.assertIsNone(held["to"])
        self.assertIsNone(held["command"])
        self.assertIn("ON HOLD", held["why"])
        # the following non-held stray still gets a target - proof the hold consumed no room
        other = by_sid["s2"]
        self.assertIsNotNone(other["to"])
        self.assertEqual(other["to"]["instance"], "b")
        self.assertIn("migrate_chat.py s2 --to b", other["command"])

    def test_running_console_stray_is_not_targeted(self):
        # A LIVE console chat must never get a to/command: migrate_chat refuses a running
        # session every pass, which would burn a landConsole slot forever (owner, 2026-09-01).
        chats = [chat("s1", "wait-on-person", instance=None, email=None, state="running")]
        plan = balance.plan_moves(self.accounts(hot_pct=20), chats)
        self.assertEqual(len(plan["consoleStrays"]), 1)
        stray = plan["consoleStrays"][0]
        self.assertIsNone(stray["to"])
        self.assertIsNone(stray["command"])
        self.assertIn("live", stray["why"])

    def test_protected_manager_console_stray_is_not_targeted(self):
        # The standing manager chat (overlord.protected_session_ids) is never queued for a
        # console-landing move either - it relocates itself (mirrors groundskeeper.py:199-203).
        chats = [chat("s1", "wait-on-person", instance=None, email=None)]
        plan = balance.plan_moves(self.accounts(hot_pct=20), chats, protected={"s1"})
        self.assertEqual(len(plan["consoleStrays"]), 1)
        stray = plan["consoleStrays"][0]
        self.assertIsNone(stray["to"])
        self.assertIsNone(stray["command"])
        self.assertIn("overlord", stray["why"])

    def test_moves_only_target_other_accounts(self):
        # the only cool account is the chat's own -> nothing to move to
        rows = [survey_row(week=90, binding=90),
                survey_row(num=2, id_="c:\\i\\b", label="b", email="a@x.com", week=10, binding=10)]
        accts = balance.accounts_overview({"rows": rows}, fleet_for(rows))
        plan = balance.plan_moves(accts, [chat("s1", "wait-on-person", email="a@x.com")])
        self.assertEqual(plan["moves"], [])


if __name__ == "__main__":
    unittest.main()
