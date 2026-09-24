"""ONE stuck row may not eat the whole courier run (2026-09-18).

THE INCIDENT. `courier --yes --only <id> --only <id>` was run by hand against two staged resume
rows and delivered neither: `stage_reply --list` showed the FIRST row's `attempts` climbing while
the second still read 0, so whatever it was doing, it was doing it inside row one and the second
row was never reached. (That run was cancelled at 15s, not at its 300s deadline - the incident
report's longer timings are retracted. The arithmetic below stands on its own.)

Every step of a delivery was already individually bounded (the daemon send at CONFIRM_SECS+120,
the composer actuator at 300s, the confirm watch at CONFIRM_SECS). Nothing bounded their SUM, so
one row's worst case ran past thirteen minutes - longer than the deadline the whole run was given.
`courier.ROW_BUDGET_SECS` bounds the sum: each step takes the smaller of its own timeout and what
the row has left, a step with nothing left is not started, and the loop advances.

These tests deliberately block the peer send - the daemon's `/message` endpoint, which is the
route a LIVE chat takes - and prove the run comes back with a verdict for BOTH rows.
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

import courier  # noqa: E402
from lib import deliverylib  # noqa: E402
from lib import hydralib  # noqa: E402

SID_A = "aaaa1111-2222-3333-4444-555566667777"
SID_B = "bbbb1111-2222-3333-4444-555566667777"
DONE_WAITING = ("Here is what I found.\n"
                "Let me know if you want me to carry on with the next step.")

#: Small enough that the whole file runs in seconds, and above deliver_one's 5s floor - a row
#: with less than that left is refused BEFORE the send rather than half-sending (its own test
#: below), which is correct in production and would hide the timeout this file is about.
BUDGET = 8.0


class RowBudgetTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self._base = hydralib.BASE
        hydralib.BASE = self.stub.url
        self._tmp = tempfile.TemporaryDirectory()
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

        self.paths = {}
        for sid in (SID_A, SID_B):
            p = Path(self._tmp.name) / f"{sid}.jsonl"
            p.write_text(
                json.dumps({"type": "assistant",
                            "message": {"content": [{"type": "text", "text": DONE_WAITING}]}}) + "\n",
                encoding="utf-8")
            old = time.time() - 600
            os.utime(p, (old, old))
            self.paths[sid] = p

        def dossier_route(method, path, query, body):
            sid = dossier_query(query)
            if sid not in (SID_A, SID_B):
                return {"matches": []}
            return {"matches": [{"instance": "temp1", "chatId": f"c-{sid[:4]}",
                                 "cliSessionId": sid, "lineageIds": [sid],
                                 "title": f"chat {sid[:4]}", "archived": False,
                                 "lastActivityAt": "T1", "live": None}]}

        self.stub.routes["/api/chats/dossier"] = dossier_route
        self.stub.routes["/api/sessions"] = [
            {"session_id": sid, "archived": False, "title": f"chat {sid[:4]}",
             "instance": "temp1", "transcript_path": str(self.paths[sid]),
             "last_activity_at": 1}
            for sid in (SID_A, SID_B)
        ]
        self.stub.routes["/api/fleet"] = {"instances": [
            {"num": 1, "name": "temp1", "dir": "c:\\i\\temp1", "isRunning": True,
             "signedIn": True,
             "account": {"email": "a@x.com", "planLabel": "Max 20×"}}]}

    def tearDown(self):
        self.stub.close()
        hydralib.BASE = self._base
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _stage(self, sid):
        return deliverylib.stage(sid, "Carry on with the next step.",
                                 title=f"chat {sid[:4]}", instance="temp1",
                                 evidence=DONE_WAITING)

    def test_a_blocked_peer_send_times_out_and_the_run_reaches_the_next_row(self):
        """THE REGRESSION. Row A's send never answers; row B must still be attempted."""
        real_post = hydralib.api_post
        seen = {"sends": []}

        def blocking_post(path, body=None, timeout=None):
            if path.endswith("/message"):
                seen["sends"].append((path, timeout))
                # A send that never answers, bounded only by the timeout the CALLER chose.
                # That is the whole point: before ROW_BUDGET_SECS the caller chose 270s for a
                # run that had been given 300, so row B could never be reached.
                time.sleep(float(timeout or 0))
                raise TimeoutError("the peer channel never answered")
            return real_post(path, body, timeout)

        a, b = self._stage(SID_A), self._stage(SID_B)
        started = time.time()
        with mock.patch.object(courier, "ROW_BUDGET_SECS", BUDGET), \
                mock.patch.object(hydralib, "api_post", side_effect=blocking_post), \
                mock.patch.object(courier, "_run_actuator", return_value=(1, "no composer here")):
            report = courier.run(5, {a["id"], b["id"]}, act=True, hand_run=True)
        took = time.time() - started

        by_id = {r["id"]: r for r in report["results"]}
        # BOTH rows got a verdict - the whole point of the bound.
        self.assertEqual(set(by_id), {a["id"], b["id"]}, report)
        for row in by_id.values():
            self.assertFalse(row["ok"])
        # The send was capped at the ROW's budget, never at its own 270s default.
        self.assertTrue(seen["sends"], "the daemon send was never attempted")
        for _, timeout in seen["sends"]:
            self.assertLessEqual(timeout, BUDGET + 0.01, seen["sends"])
        # …and the run as a whole cost about two budgets, not two thirteen-minute worst cases.
        self.assertLess(took, BUDGET * 2 + 30, f"the run took {took:.1f}s")

    def test_a_stuck_row_burns_exactly_one_attempt_and_leaves_a_readable_reason(self):
        """A row the run gave up on is a FAILURE with a reason, never a silent re-queue: the
        attempt was recorded before the send (deliver_one's own rule), so a row that wedged has
        to carry the cost of having been tried."""
        a = self._stage(SID_A)
        before = int((deliverylib.get(a["id"]) or {}).get("attempts") or 0)

        def blocking_post(path, body=None, timeout=None):
            if path.endswith("/message"):
                time.sleep(float(timeout or 0))
                raise TimeoutError("the peer channel never answered")
            return hydralib._request("POST", path, body if body is not None else {},
                                     timeout=timeout)

        with mock.patch.object(courier, "ROW_BUDGET_SECS", BUDGET), \
                mock.patch.object(hydralib, "api_post", side_effect=blocking_post), \
                mock.patch.object(courier, "_run_actuator", return_value=(1, "no composer here")):
            courier.run(5, {a["id"]}, act=True, hand_run=True)

        row = deliverylib.get(a["id"])
        self.assertEqual(int(row["attempts"]), before + 1)
        self.assertNotEqual(row["state"], "staged")
        self.assertTrue(str(row.get("lastError") or "").strip(),
                        "a row the run abandoned must say why")

    def test_a_row_with_no_time_left_is_never_half_sent(self):
        """A send begun with two seconds left is a half-typed message nobody can account for.
        deliver_one refuses to START one instead, and says so.

        ⛔ AND IT STAYS STAGED. Nothing was sent, so this is the NOT-YET class the file already
        has a door for (deliverylib.defer): burning the row to `failed` is what built the
        2026-09-10 "failed graveyard", where the next cycle staged a fresh row for the same chat
        rather than retrying the one that had never been attempted."""
        a = self._stage(SID_A)
        # A budget already spent by the time the send is reached.
        res = courier.deliver_one(a, {"instance": "temp1", "title": "chat aaaa",
                                      "cliSessionId": SID_A, "live": None},
                                  budget_secs=0.0)
        self.assertFalse(res["ok"])
        self.assertTrue(res["deferred"])
        self.assertIn("out of time", res["outcome"])
        self.assertEqual([p for p, _ in self.stub.posts if p.endswith("/message")], [])
        row = deliverylib.get(a["id"])
        self.assertEqual(row["state"], "staged")
        self.assertEqual(int(row.get("deferrals") or 0), 1)
        # The attempt is taken back: the breaker counts futility, not restraint.
        from lib import ledgerlib
        self.assertEqual(ledgerlib.check("deliver", SID_A)["attempts"], 0)

    def test_no_budget_means_the_old_unbounded_behaviour(self):
        """`budget_secs=None` is the seam every direct unit test of one step relies on: the
        steps keep their own timeouts and nothing new can refuse them."""
        self.assertEqual(courier._left(None), float("inf"))
        self.assertEqual(courier._budget(None, 270), 270.0)
        # …and a real deadline only ever shrinks a step, never grows it.
        self.assertEqual(courier._budget(time.time() + 1000, 270), 270.0)
        self.assertLessEqual(courier._budget(time.time() + 5, 270), 5.0)


if __name__ == "__main__":
    unittest.main()
