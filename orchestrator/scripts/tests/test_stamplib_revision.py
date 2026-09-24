"""stamplib.mutate_meta (audit AH-18): a meta record is never replaced from a stale snapshot.

The doctrine/ultracode stampers, the courier, migrate_chat and twin cleanup all read the whole
app-owned metadata document and replace it. Unique temp names stopped them corrupting bytes,
but a field the app (or another lane) wrote between the read and the replace was silently
lost. The mutator now holds a per-record lock for the toolbox's own writers and re-checks the
file's revision immediately before the replace; a record that changed underneath is re-read
and re-applied, and one that keeps changing is left alone with an error."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import configlib, ledgerlib, stamplib  # noqa: E402


class MutateMetaTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self._tmp = tempfile.TemporaryDirectory()
        self.meta = Path(self._tmp.name) / "local_abc.json"
        self.meta.write_text(json.dumps({"cliSessionId": "abc", "title": "Old title",
                                         "permissionMode": "acceptEdits"}), encoding="utf-8")

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _external_write(self, **fields):
        """The app rewriting the record from memory - not a cooperating writer, no lock.
        ONE write: `_between` is invoked on every attempt, and a writer that fired again on the
        retry would (correctly) be judged never-still - a different scenario, tested below."""
        fired = {"done": False}

        def go():
            if fired["done"]:
                return
            fired["done"] = True
            cur = json.loads(self.meta.read_text(encoding="utf-8"))
            cur.update(fields)
            # A different size guarantees the revision differs even inside one mtime tick.
            self.meta.write_text(json.dumps(cur, indent=2), encoding="utf-8")
        return go

    def test_a_plain_stamp_lands_and_verifies(self):
        r = stamplib.stamp_doctrine(self.meta)
        self.assertEqual((r["changed"], r["bypass"], r["ultracode"], r["error"]),
                         (True, True, True, None))
        again = stamplib.stamp_doctrine(self.meta)
        self.assertEqual((again["changed"], again["bypass"], again["ultracode"]), (False, True, True))

    def test_an_unrelated_field_written_between_read_and_replace_survives(self):
        r = stamplib.mutate_meta(self.meta, stamplib._apply_doctrine,
                                 _between=self._external_write(title="Renamed by the app"))
        self.assertIsNone(r["error"], r)
        self.assertTrue(r["changed"])
        got = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertEqual(got["permissionMode"], "bypassPermissions")   # our stamp landed
        self.assertEqual(got["title"], "Renamed by the app")           # theirs survived
        self.assertTrue(got["sessionSettings"]["ultracode"])

    def test_a_record_that_keeps_changing_is_left_as_the_other_writer_left_it(self):
        counter = {"n": 0}

        def always_changing():
            counter["n"] += 1
            self._external_write(title=f"edit {counter['n']}", tick=counter["n"])()

        r = stamplib.mutate_meta(self.meta, stamplib._apply_doctrine, _between=always_changing)
        self.assertFalse(r["changed"])
        self.assertIn("kept changing", r["error"])
        got = json.loads(self.meta.read_text(encoding="utf-8"))
        self.assertEqual(got["permissionMode"], "acceptEdits")  # never clobbered
        self.assertEqual(got["title"], f"edit {stamplib.META_WRITE_ATTEMPTS}")
        self.assertEqual(counter["n"], stamplib.META_WRITE_ATTEMPTS)
        self.assertFalse(list(self.meta.parent.glob("*.tmp")))

    def test_nothing_to_do_writes_nothing(self):
        before = self.meta.stat().st_mtime_ns
        r = stamplib.mutate_meta(self.meta, lambda m: False)
        self.assertEqual((r["changed"], r["error"]), (False, None))
        self.assertEqual(self.meta.stat().st_mtime_ns, before)

    def test_cooperating_writers_take_turns_on_the_per_record_lock(self):
        released_at = {}
        finished_at = {}

        def other_lane():
            r = stamplib.mutate_meta(self.meta, stamplib._apply_doctrine)
            finished_at["t"] = time.monotonic()
            finished_at["r"] = r

        with ledgerlib.locked(f"meta-{self.meta.stem}"):
            t = threading.Thread(target=other_lane)
            t.start()
            time.sleep(0.3)
            self.assertNotIn("t", finished_at)  # still waiting on our lock
            released_at["t"] = time.monotonic()
        t.join(timeout=10)
        self.assertIn("t", finished_at)
        self.assertGreaterEqual(finished_at["t"], released_at["t"])
        self.assertTrue(finished_at["r"]["changed"])

    def test_a_missing_or_corrupt_record_is_an_error_not_a_crash(self):
        r = stamplib.mutate_meta(self.meta.with_name("missing.json"), stamplib._apply_doctrine)
        self.assertFalse(r["changed"])
        self.assertIsNotNone(r["error"])
        self.meta.write_text("{not json", encoding="utf-8")
        r2 = stamplib.stamp_ultracode(self.meta)
        self.assertFalse(r2["stamped"])
        self.assertIsNotNone(r2["error"])
        self.assertEqual(self.meta.read_text(encoding="utf-8"), "{not json")


class AutomationProfileTest(unittest.TestCase):
    """Owner, 2026-09-24: "I run chats on ultra, you run them on whatever you know is
    efficient." A chat AgentHydra launched itself carries a marker (stamplib.mark_automation), and
    the doctrine stamps it with the AUTOMATION profile (doctrine.automation_*). The shipped
    defaults keep that profile identical to the owner's, so an install that never set them sees
    no change; the owner's own chats keep ultracode + xhigh either way."""

    EFFICIENT = {"doctrine.automation_ultracode": False, "doctrine.automation_effort": "high"}

    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(setattr, configlib, "_CACHE", configlib._CACHE)
        self.mine = self._meta("jacob-1")
        self.bot = self._meta("bot-1")
        stamplib.mark_automation("bot-1", "test")

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._tmp.cleanup()
        self._state.cleanup()

    def _meta(self, sid: str, **fields) -> Path:
        p = Path(self._tmp.name) / f"local_{sid}.json"
        p.write_text(json.dumps({"cliSessionId": sid, "sessionId": f"local_{sid}",
                                 "permissionMode": "acceptEdits", **fields}), encoding="utf-8")
        return p

    def policy(self, **overrides):
        configlib._CACHE = {**configlib.defaults(), **overrides}

    def read(self, p: Path) -> dict:
        return json.loads(p.read_text(encoding="utf-8"))

    def test_the_shipped_defaults_stamp_a_launched_chat_exactly_like_the_owners(self):
        self.policy()
        for p in (self.mine, self.bot):
            r = stamplib.stamp_doctrine(p)
            self.assertEqual((r["bypass"], r["ultracode"], r["error"]), (True, True, None))
            m = self.read(p)
            self.assertEqual((m["permissionMode"], m["effort"], m["sessionSettings"]),
                             ("bypassPermissions", "xhigh", {"ultracode": True}))

    def test_the_efficient_policy_never_puts_ultracode_on_a_launched_chat(self):
        self.policy(**self.EFFICIENT)
        r = stamplib.stamp_doctrine(self.bot)
        self.assertEqual((r["changed"], r["bypass"], r["ultracode"]), (True, True, True))
        m = self.read(self.bot)
        self.assertEqual(m["permissionMode"], "bypassPermissions")
        self.assertEqual(m["effort"], "high")
        self.assertIsNot((m.get("sessionSettings") or {}).get("ultracode"), True)
        # the next pass finds it on its profile and writes nothing - no flip-flop
        self.assertFalse(stamplib.stamp_doctrine(self.bot)["changed"])

    def test_the_owners_chats_keep_ultracode_under_the_efficient_policy(self):
        self.policy(**self.EFFICIENT)
        stamplib.stamp_doctrine(self.mine)
        m = self.read(self.mine)
        self.assertEqual((m["effort"], m["sessionSettings"]), ("xhigh", {"ultracode": True}))

    def test_a_launched_chat_found_on_ultracode_is_brought_back_to_the_efficient_effort(self):
        self.policy(**self.EFFICIENT)
        self.bot.write_text(json.dumps({"cliSessionId": "bot-1", "permissionMode": "bypassPermissions",
                                        "effort": "xhigh", "sessionSettings": {"ultracode": True, "keep": 1}}),
                            encoding="utf-8")
        self.assertFalse(stamplib.is_stamped(self.read(self.bot)))
        stamplib.stamp_doctrine(self.bot)
        m = self.read(self.bot)
        self.assertEqual((m["effort"], m["sessionSettings"]), ("high", {"ultracode": False, "keep": 1}))
        self.assertTrue(stamplib.is_stamped(m))

    def test_the_marker_is_matched_by_the_local_id_as_well_as_the_cli_id(self):
        stamplib.mark_automation("local_zz-9", "test")
        self.assertTrue(stamplib.is_automation({"sessionId": "local_zz-9", "cliSessionId": "other"}))
        self.assertTrue(stamplib.is_automation({"cliSessionId": "bot-1"}))
        self.assertFalse(stamplib.is_automation({"cliSessionId": "jacob-1", "sessionId": "local_jacob-1"}))
        self.assertFalse(stamplib.is_automation({}))


if __name__ == "__main__":
    unittest.main()
