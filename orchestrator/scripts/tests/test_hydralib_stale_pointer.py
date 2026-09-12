"""hydralib: a pointer-named port that refuses is NOT "the daemon is down" (2026-09-12).

A probe daemon left ~/.agenthydra/runtime.json naming a dead 7799 while the real daemon answered
on 7787, and every script said "is the daemon running?" - the advice that starts a second one. Now
the refusal names the pointer file and the port it names, asks the default port once, and switches
to it for the rest of the process when it answers as agenthydra. A BASE that is anyone else's word
(an explicit env, or a caller's own reassignment) is never second-guessed. And a daemon whose store
is relocated stamps every answer, which hydralib announces once on stderr.
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stubdaemon import StubDaemon  # noqa: E402

from lib import hydralib  # noqa: E402

DEAD = "http://127.0.0.1:9"  # discard port - nothing listens
HEALTHY = {"ok": True, "service": "agenthydra", "version": "t"}
_GLOBALS = ("BASE", "_POINTER_BASE", "_POINTER_PATH", "_DEFAULT_BASE", "_SIDE_RUN_ANNOUNCED", "TIMEOUT_SECS")


class StalePointerTest(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(hydralib, name) for name in _GLOBALS}
        self.stub = StubDaemon()
        self.stub.routes["/api/health"] = HEALTHY
        self.stub.routes["/api/fleet"] = {"instances": ["real"]}
        hydralib.TIMEOUT_SECS = 0.3
        hydralib._SIDE_RUN_ANNOUNCED = False
        hydralib._POINTER_PATH = "C:/fake/.agenthydra/runtime.json"

    def tearDown(self):
        self.stub.close()
        for name, value in self.saved.items():
            setattr(hydralib, name, value)

    def _as_pointer(self, url):
        hydralib.BASE = url
        hydralib._POINTER_BASE = url

    def test_a_stale_pointer_names_itself_and_the_process_switches_to_the_default_that_answers(self):
        self._as_pointer(DEAD)
        hydralib._DEFAULT_BASE = self.stub.url  # the stub stands in for 7787, in-process
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = hydralib.fleet()
        self.assertEqual(result, {"instances": ["real"]})
        self.assertEqual(hydralib.BASE, self.stub.url, "the switch sticks for the rest of the process")
        self.assertIn(f"C:/fake/.agenthydra/runtime.json names {DEAD}, nothing is listening there", err.getvalue())
        self.assertIn("Do NOT start another daemon", err.getvalue())
        # One probe of the default, then the real request against it - nothing else.
        self.assertEqual(self.stub.gets, [("/api/health", ""), ("/api/fleet", "")])

    def test_a_stale_pointer_with_a_dead_default_says_both_and_never_pretends_a_fleet(self):
        self._as_pointer(DEAD)
        hydralib._DEFAULT_BASE = "http://127.0.0.1:10"  # also dead, on the wire
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.fleet()
        self.assertIn("may be stale", ctx.exception.detail)
        self.assertIn("the default port did not answer either", ctx.exception.detail)
        self.assertEqual(hydralib.BASE, DEAD, "no switch without an answer")

    def test_a_base_that_is_not_the_pointers_word_is_never_second_guessed(self):
        hydralib._POINTER_BASE = DEAD
        hydralib.BASE = "http://127.0.0.1:10"  # a caller's own reassignment, dead
        hydralib._DEFAULT_BASE = self.stub.url  # would answer, and must not be asked
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.fleet()
        self.assertNotIn("stale", ctx.exception.detail)
        self.assertEqual(self.stub.gets, [], "the default port was not probed")

    def test_a_pointer_naming_the_default_itself_is_named_stale_without_a_second_port_to_try(self):
        self._as_pointer("http://127.0.0.1:10")
        hydralib._DEFAULT_BASE = "http://127.0.0.1:10"
        with self.assertRaises(hydralib.DaemonError) as ctx:
            hydralib.fleet()
        self.assertNotIn("stale", ctx.exception.detail)
        self.assertEqual(self.stub.gets, [])

    def test_a_side_run_daemon_is_announced_once_on_stderr_from_the_wire(self):
        hydralib.INPROC.pop(self.stub.url)  # force the wire: headers only exist there
        self.stub.side_run = "X:/scratch/probe-data/agenthydra.db"
        hydralib.BASE = self.stub.url
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            hydralib.health()
            hydralib.health()
        text = err.getvalue()
        self.assertEqual(text.count("SIDE-RUN DAEMON"), 1, "said once, not per request")
        self.assertIn("X:/scratch/probe-data/agenthydra.db", text)

    def test_a_primary_daemon_announces_nothing(self):
        hydralib.INPROC.pop(self.stub.url)
        hydralib.BASE = self.stub.url
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            hydralib.health()
        self.assertEqual(err.getvalue(), "")


class ResolveBaseSourceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_each_source_is_named(self):
        pointer_path = str(self.home / ".agenthydra" / "runtime.json")
        self.assertEqual(hydralib.resolve_base({}, self.home), ("http://127.0.0.1:7787", "default", pointer_path))
        self.assertEqual(hydralib.resolve_base({"AGENTHYDRA_PORT": "17787"}, self.home),
                         ("http://127.0.0.1:17787", "port", pointer_path))
        self.assertEqual(hydralib.resolve_base({"AGENTHYDRA_URL": "http://h:1/"}, self.home),
                         ("http://h:1", "url", pointer_path))
        (self.home / ".agenthydra").mkdir()
        Path(pointer_path).write_text(json.dumps({"url": "http://127.0.0.1:7788", "port": 7788, "pid": 1}),
                                      encoding="utf-8")
        self.assertEqual(hydralib.resolve_base({}, self.home), ("http://127.0.0.1:7788", "pointer", pointer_path))

    def test_resolve_base_url_is_the_url_of_resolve_base(self):
        self.assertEqual(hydralib.resolve_base_url({}, self.home), hydralib.resolve_base({}, self.home)[0])


if __name__ == "__main__":
    unittest.main()
