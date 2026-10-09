"""A move's bypass check asks the target app again when its sidebar had not rendered the landed
rows yet (2026-10-03: five chats moved #37 -> #55 came back disk-only on "rendered NO chat rows
at all in 6s", and the same picker confirmed all five later; the overnight watch reached for the
ccd permission tool instead and froze 7.5 hours on its approval card).
"""

import sys
import unittest
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import migrate_chat  # noqa: E402

EMPTY = "REFUSED: expanded 0 group(s), none was collapsed - the sidebar in x rendered NO chat rows at all in 6s"
TARGET = {"isRunning": True, "dir": "c:\\x", "name": "x"}
WATCHED = {"mode": "bypassPermissions", "stable": True}


class BypassRetry(unittest.TestCase):
    def run_with(self, answers):
        confirmed = set()
        calls = []

        def picker(row, fleet):
            said = answers[len(calls)]
            calls.append(said)
            if said == "ok":
                confirmed.add(row["sessionId"])
            return said

        with mock.patch.object(migrate_chat, "confirm_bypass_in_app", picker), \
             mock.patch.object(migrate_chat, "_app_confirmed", lambda sid: sid in confirmed), \
             mock.patch.object(migrate_chat, "_drop_confirmed", lambda sid: None), \
             mock.patch.object(migrate_chat, "BYPASS_EMPTY_SIDEBAR_RETRY_SECS", (0, 0)):
            verdict = migrate_chat._adjudicate_bypass("s1", "T", TARGET, "m.json", {}, WATCHED)
        return verdict[0], len(calls)

    def test_empty_sidebar_then_rows_confirms(self):
        self.assertEqual(self.run_with([EMPTY, "ok"]), ("app-confirmed", 2))

    def test_sidebar_never_renders_stays_disk_only_after_every_retry(self):
        self.assertEqual(self.run_with([EMPTY, EMPTY, EMPTY]), ("disk-only", 3))

    def test_any_other_refusal_is_not_retried(self):
        self.assertEqual(self.run_with(["REFUSED: no sidebar row is named 'T'"]), ("disk-only", 1))

    # 2026-10-09: the picker cost 5.5s a chat; the native effort call now reads bypass back.
    def test_bypass_read_back_natively_never_drives_the_picker(self):
        def native(path, body, **_):
            return {"ok": True, "after": {"permissionMode": "bypassPermissions"}}

        with mock.patch.object(migrate_chat.hydralib, "api_post_once", native):
            self.assertIs(migrate_chat.effort_in_app(
                TARGET, "c:\\x\\local_s1.json", {"effort": "xhigh", "ultracode": True}), True)
        try:
            with mock.patch.object(migrate_chat, "confirm_bypass_in_app",
                                   lambda row, fleet: self.fail("picker driven")), \
                 mock.patch.object(migrate_chat, "_drop_confirmed", lambda sid: None):
                verdict = migrate_chat._adjudicate_bypass(
                    "s1", "T", TARGET, "c:\\x\\local_s1.json", {}, WATCHED)
        finally:
            migrate_chat._NATIVE_BYPASS.clear()
        self.assertEqual(verdict[0], "app-confirmed")

    def test_native_route_without_bypass_falls_back_to_the_picker(self):
        with mock.patch.object(migrate_chat.hydralib, "api_post_once",
                               lambda path, body, **_: {"ok": True, "after": {}}):
            migrate_chat.effort_in_app(TARGET, "c:\\x\\local_s1.json",
                                       {"effort": "xhigh", "ultracode": True})
        self.assertEqual(self.run_with(["ok"]), ("app-confirmed", 1))


if __name__ == "__main__":
    unittest.main()
