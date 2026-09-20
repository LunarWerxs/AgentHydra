"""Native archive protocol gates, using in-process replies and no installed app."""

import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import hydralib, nativearchivelib

SID = "aaaa1111-2222-3333-4444-555566667777"
PROFILE = r"C:\profiles\source"
ROUTE = f"/api/sessions/{SID}/native-archive"
VERIFIED = {"available": True, "ok": True, "verified": True, "dispatch": "sent"}


class NativeArchiveTransportTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reply = (200, VERIFIED)
        self.fleet = {"instances": [{"name": "source", "dir": PROFILE}]}
        self.base_patch = mock.patch.object(hydralib, "BASE", "http://native-test")
        self.base_patch.start()
        self.addCleanup(self.base_patch.stop)
        self.inproc = mock.patch.dict(hydralib.INPROC, {hydralib.BASE: self.handle})
        self.inproc.start()
        self.addCleanup(self.inproc.stop)

    def handle(self, method, path, data):
        self.requests.append((method, path, json.loads(data) if data else None))
        if path == "/api/fleet":
            return 200, json.dumps(self.fleet).encode()
        if isinstance(self.reply, Exception):
            raise self.reply
        status, body = self.reply
        return status, body if isinstance(body, bytes) else json.dumps(body).encode()

    def act(self, instance=PROFILE):
        return nativearchivelib.try_archive(SID, instance)

    def test_exact_profile_and_cli_id_are_sent_once(self):
        code, detail = self.act()
        self.assertEqual(code, nativearchivelib.NATIVE_VERIFIED)
        self.assertEqual(nativearchivelib.result(detail), VERIFIED)
        self.assertEqual(self.requests, [("POST", ROUTE, {"instance_ref": f"desktop:{PROFILE}"})])

    def test_exact_unique_name_is_resolved_before_post(self):
        self.assertEqual(self.act("SOURCE")[0], nativearchivelib.NATIVE_VERIFIED)
        self.assertEqual(self.requests[-1][2], {"instance_ref": f"desktop:{PROFILE}"})

    def test_posix_profile_reaches_daemon_with_native_id(self):
        code, _ = nativearchivelib.try_archive("local_" + SID, "/home/owner/claude/profile")
        self.assertEqual(code, nativearchivelib.NATIVE_VERIFIED)
        self.assertEqual(self.requests, [("POST", f"/api/sessions/local_{SID}/native-archive",
                                         {"instance_ref": "desktop:/home/owner/claude/profile"})])

    def test_duplicate_name_is_refused_without_post(self):
        self.fleet["instances"].append({"name": "source", "dir": r"C:\other\source"})
        self.assertEqual(self.act("source")[0], nativearchivelib.NATIVE_TERMINAL)
        self.assertTrue(all(method == "GET" for method, _, _ in self.requests))

    def test_missing_profile_directory_is_refused(self):
        self.fleet["instances"][0].pop("dir")
        self.assertEqual(self.act("source")[0], nativearchivelib.NATIVE_TERMINAL)
        self.assertEqual(len(self.requests), 1)

    def test_explicit_unavailable_and_old_route_404_allow_fallback(self):
        for reply in [(200, {"available": False, "dispatch": "not-sent", "ok": False,
                            "verified": False, "reason": "no inspector"}),
                      (404, {"error": "not found"}), (404, b"Not Found")]:
            with self.subTest(reply=reply):
                self.reply = reply
                self.assertIsNone(self.act())

    def test_native_refusal_even_on_404_is_terminal(self):
        self.reply = (404, {"available": True, "ok": False, "verified": False,
                            "dispatch": "not-sent", "reason": "session missing"})
        code, detail = self.act()
        self.assertEqual(code, nativearchivelib.NATIVE_TERMINAL)
        self.assertEqual(nativearchivelib.result(detail)["reason"], "session missing")

    def test_unknown_unverified_and_malformed_never_allow_fallback(self):
        replies = [
            (200, {**VERIFIED, "verified": False}),
            (200, {**VERIFIED, "available": False}),
            (200, {**VERIFIED, "available": False, "dispatch": "not-sent"}),
            (200, {"available": False}),
            (200, {**VERIFIED, "ok": "true"}),
            (200, {**VERIFIED, "dispatch": "unknown"}),
            (200, []), (200, b"not JSON"), (502, {"error": "gateway timeout"}),
            TimeoutError("reply lost after archive"),
        ]
        for reply in replies:
            with self.subTest(reply=reply):
                self.reply = reply
                self.requests.clear()
                self.assertEqual(self.act()[0], nativearchivelib.NATIVE_TERMINAL)
                self.assertEqual(len(self.requests), 1)

    def test_verified_noop_is_success(self):
        self.reply = (200, {**VERIFIED, "dispatch": "not-sent"})
        self.assertEqual(self.act()[0], nativearchivelib.NATIVE_VERIFIED)

    def test_stale_pointer_timeout_never_reposts_or_probes_fallback(self):
        with mock.patch.dict(hydralib.INPROC, {}, clear=True), \
                mock.patch.object(hydralib, "_POINTER_BASE", hydralib.BASE), \
                mock.patch.object(hydralib, "_default_port_answers", return_value=True) as health, \
                mock.patch.object(hydralib.urllib.request, "urlopen",
                                  side_effect=urllib.error.URLError("reply lost")) as send:
            code, detail = self.act()
        self.assertEqual(code, nativearchivelib.NATIVE_TERMINAL)
        self.assertEqual(nativearchivelib.result(detail)["dispatch"], "unknown")
        send.assert_called_once()
        health.assert_not_called()


if __name__ == "__main__":
    unittest.main()
