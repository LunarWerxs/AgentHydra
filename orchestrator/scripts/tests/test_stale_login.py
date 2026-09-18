"""A record filed under a PREVIOUS login of a profile is on disk and not on screen (2026-09-18).

The desktop app renders only the signed-in account's folder of `claude-code-sessions`. #12 was
re-logged into another account twenty minutes after four chats were moved in; the chats vanished
from the app, and every move of them answered "nothing to do: already lives in pap3r rotate2"
because the dossier's `instance` said so. The daemon now tags each record `staleLogin`; these pin
the three places the move reads it: the no-op short-circuit, the landing check, and the stamp's
path - plus the resolver's choice between an on-screen copy and an invisible twin.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import migrate_chat  # noqa: E402
from lib import hydralib  # noqa: E402

FLEET = {"instances": [{"num": 12, "name": "pap3r rotate2", "dir": "c:/x/pap3r rotate2"},
                       {"num": 27, "name": "anothuh1", "dir": "c:/x/anothuh1"}]}


def row(instance, stale, archived=False, when="2026-09-18T22:29:52Z", path="p"):
    return {"instance": instance, "staleLogin": stale, "archived": archived,
            "cliSessionId": "aa2fcfeb", "lastActivityAt": when, "metaPath": path}


class ShortCircuitTest(unittest.TestCase):
    def test_a_chat_on_screen_in_the_target_is_still_nothing_to_do(self):
        with self.assertRaises(migrate_chat._MigrateRefusal) as ctx:
            migrate_chat._resolve_target_or_raise(FLEET, "12", row("pap3r rotate2", False),
                                                  "aa2fcfeb", "RustTor")
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn("already lives", ctx.exception.payload["report"])

    def test_an_unknown_login_keeps_the_old_answer(self):
        with self.assertRaises(migrate_chat._MigrateRefusal):
            migrate_chat._resolve_target_or_raise(FLEET, "12", row("pap3r rotate2", None),
                                                  "aa2fcfeb", "RustTor")

    def test_a_stale_login_record_on_the_target_is_re_homed_not_skipped(self):
        # The exact move that answered "nothing to do" four times on 2026-09-18.
        target = migrate_chat._resolve_target_or_raise(FLEET, "12", row("pap3r rotate2", True),
                                                       "aa2fcfeb", "RustTor")
        self.assertEqual(target["num"], 12)


class LandingTest(unittest.TestCase):
    def test_a_stale_twin_on_the_target_does_not_count_as_landed(self):
        target = FLEET["instances"][0]
        self.assertFalse(migrate_chat._on_screen_in(row("pap3r rotate2", True), target))
        self.assertTrue(migrate_chat._on_screen_in(row("pap3r rotate2", False), target))
        self.assertTrue(migrate_chat._on_screen_in(row("pap3r rotate2", None), target))
        self.assertFalse(migrate_chat._on_screen_in(row("anothuh1", False), target))

    def test_the_stamp_path_is_the_on_screen_record_not_the_stale_twin(self):
        land = migrate_chat._Landing.__new__(migrate_chat._Landing)
        land.target = FLEET["instances"][0]
        land.after = [row("pap3r rotate2", True, path="old-login"),
                      row("pap3r rotate2", False, path="signed-in")]
        self.assertEqual(migrate_chat.landed_meta_path(land), "signed-in")


class ChooseMatchTest(unittest.TestCase):
    def test_the_copy_on_screen_wins_over_a_newer_invisible_twin(self):
        visible = row("anothuh1", False, when="2026-09-18T20:00:00Z")
        invisible = row("pap3r rotate2", True, when="2026-09-18T22:00:00Z")
        self.assertIs(hydralib.choose_match("RustTor", [invisible, visible]), visible)

    def test_two_invisible_twins_fall_back_to_the_lineage_rule(self):
        older = row("pap3r rotate2", True, when="2026-09-18T20:00:00Z")
        newer = row("pap3r rotate2", True, when="2026-09-18T22:00:00Z")
        self.assertIs(hydralib.choose_match("RustTor", [older, newer]), newer)


if __name__ == "__main__":
    unittest.main()
