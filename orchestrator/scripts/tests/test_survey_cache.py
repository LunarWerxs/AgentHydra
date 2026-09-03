"""hydralib.usage_survey's shared one-tick cache (live smoke, 2026-09-01).

The whole-fleet usage survey measured ~80 s on the real daemon, and every planning lane
(sweep, saturate, groundskeeper, overlord, balance) paid it separately every 5 minutes - the
single slowest leg of the fleet. A survey younger than SURVEY_CACHE_SECS is now served from
state/usage-survey.json across processes. These pin the three things that matter: a fresh
copy is served without a daemon call and says so; a stale or broken copy falls through to the
live call; max_age_secs=0 always goes live."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402

SURVEY = {"rows": [{"kind": "desktop", "num": 5, "id": "x", "label": "5claude",
                    "result": {"snapshot": {"weekAll": {"pct": 12}}}, "advice": {}}]}


class SurveyCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._tmp.name
        self.stub = StubDaemon()
        hydralib.BASE = self.stub.url
        self.calls = 0

        def survey_route(method, path, query, body):
            self.calls += 1
            return (200, SURVEY)

        self.stub.routes["/api/usage/survey"] = survey_route
        self.cache = Path(self._tmp.name) / "usage-survey.json"

    def tearDown(self):
        self.stub.close()
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()

    def test_first_call_hits_the_daemon_and_writes_the_cache(self):
        got = hydralib.usage_survey()
        self.assertEqual(got["rows"], SURVEY["rows"])
        self.assertNotIn("cachedAgeSecs", got)
        self.assertEqual(self.calls, 1)
        raw = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertEqual(raw["survey"]["rows"], SURVEY["rows"])
        self.assertLess(time.time() - raw["at"], 5)

    def test_second_call_within_the_window_is_served_from_the_file_and_labeled(self):
        hydralib.usage_survey()
        got = hydralib.usage_survey()
        self.assertEqual(self.calls, 1, "the second call must not reach the daemon")
        self.assertEqual(got["rows"], SURVEY["rows"])
        self.assertIn("cachedAgeSecs", got)
        self.assertLessEqual(got["cachedAgeSecs"], 5)

    def test_a_stale_copy_falls_through_to_the_live_call(self):
        self.cache.write_text(json.dumps({"at": time.time() - hydralib.SURVEY_CACHE_SECS - 1,
                                          "survey": {"rows": [{"stale": True}]}}), encoding="utf-8")
        got = hydralib.usage_survey()
        self.assertEqual(self.calls, 1)
        self.assertEqual(got["rows"], SURVEY["rows"])

    def test_a_broken_cache_file_never_breaks_the_read(self):
        self.cache.write_text("{not json", encoding="utf-8")
        got = hydralib.usage_survey()
        self.assertEqual(self.calls, 1)
        self.assertEqual(got["rows"], SURVEY["rows"])
        # and it is repaired for the next reader
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8"))["survey"]["rows"],
                         SURVEY["rows"])

    def test_max_age_zero_always_goes_live(self):
        hydralib.usage_survey()
        hydralib.usage_survey(max_age_secs=0)
        self.assertEqual(self.calls, 2)

    def test_a_cached_copy_from_the_future_is_not_trusted(self):
        # a clock that jumped backwards (sleep/resume, NTP) must not pin a stale survey forever
        self.cache.write_text(json.dumps({"at": time.time() + 3600, "survey": {"rows": [{"future": True}]}}),
                              encoding="utf-8")
        got = hydralib.usage_survey()
        self.assertEqual(self.calls, 1)
        self.assertEqual(got["rows"], SURVEY["rows"])


if __name__ == "__main__":
    unittest.main()
