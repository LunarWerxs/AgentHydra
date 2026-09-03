"""windowlib.instance_lock: ONE DRIVER PER WINDOW AT A TIME - the atomic-mkdir lock that
stops the courier's composer send, archive_chat's sidebar control and any other lane from
interleaving on the same instance's window."""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import ledgerlib  # noqa: E402
from lib import windowlib  # noqa: E402


class InstanceLockTest(unittest.TestCase):
    def setUp(self):
        self._state = tempfile.TemporaryDirectory()
        os.environ["ORCHESTRATOR_STATE_DIR"] = self._state.name

    def tearDown(self):
        os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        self._state.cleanup()

    def _lock_path(self, instance: str) -> Path:
        return ledgerlib._state_dir() / "locks" / f"ui-{windowlib._lock_key(instance)}"

    def test_second_acquirer_yields_false_while_the_first_holds_it(self):
        with windowlib.instance_lock("temp1") as first:
            self.assertTrue(first)
            with windowlib.instance_lock("temp1", wait_secs=0) as second:
                self.assertFalse(second)

    def test_the_lock_is_released_after_the_with_block(self):
        with windowlib.instance_lock("temp1"):
            self.assertTrue(self._lock_path("temp1").exists())
        self.assertFalse(self._lock_path("temp1").exists())
        # and it can be taken again immediately - nothing was left behind
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)

    def test_a_stale_lock_dir_is_broken_and_retaken(self):
        # A lock older than UI_LOCK_STALE_SECS belongs to a dead lane (a crashed process),
        # never a live one - it must be broken loudly and retaken, not waited on forever.
        path = self._lock_path("temp1")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir()
        old = time.time() - 20 * 60  # 20 minutes, past UI_LOCK_STALE_SECS (15 minutes)
        os.utime(path, (old, old))
        with windowlib.instance_lock("temp1", wait_secs=0) as mine:
            self.assertTrue(mine)

    def test_lock_key_maps_a_path_and_its_basename_to_the_same_key(self):
        # Both shapes reach the lanes: a bare instance name, and a full instance directory.
        self.assertEqual(
            windowlib._lock_key("5claude"),
            windowlib._lock_key("C:" + chr(92) + "i" + chr(92) + ".claude-instances" + chr(92) + "5claude"),
        )

    def test_an_empty_instance_yields_true_without_locking(self):
        with windowlib.instance_lock(None) as mine:
            self.assertTrue(mine)
        with windowlib.instance_lock("") as mine2:
            self.assertTrue(mine2)


if __name__ == "__main__":
    unittest.main()
