"""census.py against a stub daemon: sanity rail, waiting scan labeling, failure honesty."""

import importlib
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402


def load_census(base_url: str):
    os.environ["AGENTHYDRA_URL"] = base_url
    from lib import hydralib

    importlib.reload(hydralib)
    import census

    return importlib.reload(census)


def fleet_with(open_count: int, total: int = 4) -> dict:
    return {
        "instances": [
            {
                "num": n,
                "name": f"i{n}",
                "isRunning": n < open_count,
                "account": {"planLabel": "Max 20x"},
                "usage": {"weeklyPct": 10 + n},
            }
            for n in range(total)
        ]
    }


class CensusTest(unittest.TestCase):
    def setUp(self):
        self.stub = StubDaemon()
        self.stub.routes["/api/health"] = {"ok": True, "version": "0.36.0", "distribution": "source"}

    def tearDown(self):
        self.stub.close()
        os.environ.pop("AGENTHYDRA_URL", None)

    def test_plausible_fleet_and_waiting_preview_hit(self):
        self.stub.routes["/api/fleet"] = fleet_with(2)
        self.stub.routes["/api/sessions"] = [
            {"session_id": "a", "archived": False, "title": "T1", "instance": "i0",
             "last_text_preview": "All done. Say the word and I start on item 1."},
            {"session_id": "b", "archived": False, "title": "T2", "instance": "i1",
             "last_text_preview": "Working on it."},
            {"session_id": "c", "archived": True, "title": "T3", "instance": "i1",
             "last_text_preview": "Say the word - archived rows are excluded."},
        ]
        census = load_census(self.stub.url)
        c = census.census()
        self.assertTrue(c["sanity"]["plausible"])
        self.assertEqual(c["chats"], {"total": 3, "visible": 2, "archived": 1})
        self.assertEqual([w["sessionId"] for w in c["waitingOnAPerson"]], ["a"])
        # The scan must label itself incomplete - a cheap proxy reported as a verdict was v2's
        # defining failure.
        self.assertFalse(c["waitingScan"]["complete"])
        self.assertEqual(census.main(["--json"]), 0)

    def test_sanity_rail_trips_on_one_open_instance(self):
        self.stub.routes["/api/fleet"] = fleet_with(1)
        self.stub.routes["/api/sessions"] = []
        census = load_census(self.stub.url)
        self.assertEqual(census.main([]), 2)

    def test_failed_read_exits_1_never_prints_clean(self):
        self.stub.routes["/api/fleet"] = (500, {"error": "boom"})
        self.stub.routes["/api/sessions"] = []
        census = load_census(self.stub.url)
        self.assertEqual(census.main([]), 1)

    def test_sessions_wrapped_in_object_are_normalized(self):
        self.stub.routes["/api/fleet"] = fleet_with(2)
        self.stub.routes["/api/sessions"] = {"sessions": [{"session_id": "x", "archived": False}]}
        census = load_census(self.stub.url)
        c = census.census()
        self.assertEqual(c["chats"]["total"], 1)


class OfferPatternTest(unittest.TestCase):
    def test_offer_phrases_match(self):
        import census

        for phrase in [
            "Say the word and I start burning item 1",
            "ready when you are",
            "Want me to proceed?",
            "Shall I continue?",
            "let me know and I will begin",
        ]:
            self.assertTrue(census.offers_to_continue(phrase), phrase)

    def test_plain_statements_do_not_match(self):
        import census

        for phrase in ["All tests pass.", "The fix is deployed.", None, ""]:
            self.assertFalse(census.offers_to_continue(phrase), repr(phrase))


if __name__ == "__main__":
    unittest.main()
