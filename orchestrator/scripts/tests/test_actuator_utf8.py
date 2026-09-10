"""A non-ASCII chat title must survive an actuator's stdout pipe.

Found 2026-09-10: `chat_rename` refused with

    FAIL: 'Alcanc? mi l?mite de uso mientras trabajabas, pero ya se restableci?. ...'

for a chat whose real title carries Spanish accents. PowerShell encodes a PIPED stream with
[Console]::OutputEncoding, which defaults to the machine's OEM code page - so the accents were
replaced with literal '?' bytes INSIDE PowerShell, before any reader saw them. A '?' is perfectly
valid UTF-8, so nothing downstream can detect the loss: clilib.decode_console is already
UTF-8-first with an OEM fallback and still read question marks. The symptom was a refusal naming
a chat that does not exist, which reads as a missing chat rather than an encoding fault.

Every fixture in the suite was ASCII, which is why nothing caught it. These two tests are the
answer to that: one proves the shipped prelude actually makes PowerShell emit UTF-8, the other
holds down the list of scripts that must carry it.
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lib import clilib  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[1]
APP = SCRIPTS.parents[1]

#: Every PowerShell script whose stdout is CAPTURED by a caller (the daemon through Bun.spawn, or
#: the toolbox through clilib.run_text) and which can echo a chat title back. A new one belongs on
#: this list the day it is written, not the day a title comes back mangled.
CAPTURED_ACTUATORS = [
    APP / "misc" / "Manage-DesktopChat.ps1",
    APP / "misc" / "Deliver-DesktopChat.ps1",
    SCRIPTS / "actuator" / "manage_desktop_chat.ps1",
    SCRIPTS / "actuator" / "approve_prompt.ps1",
    SCRIPTS / "actuator" / "deliver_desktop_chat.ps1",
    SCRIPTS / "actuator" / "rename_first.ps1",
    SCRIPTS / "actuator" / "chip.ps1",
]

MARKER = "UTF-8 ON THE WAY OUT"

#: Spanish accents (the title that found this), an em dash, CJK and Cyrillic. Any of them alone
#: degrades to '?' under an OEM code page; together they also prove the fix is not Latin-1 luck.
PROBE = "Alcancé mi límite — 中文 Русский"


def _prelude_of(path: Path) -> str:
    """The UTF-8 prelude exactly as that script ships it - never a copy retyped here, or this
    test would keep passing after the shipped one was edited or deleted."""
    text = path.read_text(encoding="utf-8")
    start = text.index(MARKER)
    end = text.index("} catch { }", start) + len("} catch { }")
    return text[start:end]


@unittest.skipUnless(sys.platform == "win32", "PowerShell actuators are Windows-only")
class ActuatorUtf8Test(unittest.TestCase):
    def test_the_shipped_prelude_makes_powershell_emit_utf8(self):
        """The behavioural half: run the REAL prelude, then print the probe, and read it back
        through the toolbox's own reader."""
        prelude = _prelude_of(SCRIPTS / "actuator" / "approve_prompt.ps1")
        with tempfile.TemporaryDirectory() as tmp:
            ps1 = Path(tmp) / "probe.ps1"
            # utf-8-SIG deliberately: Windows PowerShell 5.1 reads a .ps1 with no BOM as ANSI, so
            # a BOM-less file would corrupt the probe in the SOURCE and this test would be
            # measuring its own fixture rather than the pipe.
            ps1.write_text(prelude + f"\nWrite-Output '{PROBE}'\n", encoding="utf-8-sig")
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1)],
                timeout=120,
            )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(PROBE, r.stdout)
        self.assertNotIn("?", r.stdout)

    def test_a_bom_less_ansi_pipe_is_what_the_fix_prevents(self):
        """The control. Without the prelude the same probe comes back mangled - which is what
        makes the test above evidence rather than a tautology. Asserted loosely (the exact
        substitution depends on the machine's code page); the point is only that it is NOT the
        probe."""
        with tempfile.TemporaryDirectory() as tmp:
            ps1 = Path(tmp) / "bare.ps1"
            ps1.write_text(f"Write-Output '{PROBE}'\n", encoding="utf-8-sig")
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1)],
                timeout=120,
            )
        if PROBE in r.stdout:
            self.skipTest("this console is already UTF-8, so there is no mangling to demonstrate")
        self.assertNotIn(PROBE, r.stdout)

    def test_every_captured_actuator_carries_the_prelude(self):
        """The guard. A script whose output a caller reads must not be able to lose a title."""
        missing = [p.name for p in CAPTURED_ACTUATORS
                   if MARKER not in p.read_text(encoding="utf-8")]
        self.assertEqual(missing, [], f"these actuators can mangle a non-ASCII title: {missing}")

    def test_the_listed_actuators_all_exist(self):
        """A renamed or deleted script must fail loudly here, not silently shrink the guard."""
        gone = [str(p) for p in CAPTURED_ACTUATORS if not p.exists()]
        self.assertEqual(gone, [])


if __name__ == "__main__":
    unittest.main()
