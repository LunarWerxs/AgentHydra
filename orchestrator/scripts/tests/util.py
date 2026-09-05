"""Shared test helper: run a script's main() exactly as the CLI contract sees it.

One copy (was pasted into nine test files until the 2026-08-31 standardization pass).
Import AFTER the sys.path.insert lines every test file already carries.
"""

from __future__ import annotations

import contextlib
import io
import os
import tempfile
from pathlib import Path


def run_cli(fn, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn(argv)
    return code, out.getvalue(), err.getvalue()


def isolate_state_dir(case) -> Path:
    """Point ORCHESTRATOR_STATE_DIR at a private temp dir for this test; restored on cleanup.

    Every lib that keeps state (ledgerlib and everything built on it: holds, attempts, the usage
    survey cache, the naming lock, the UI locks) resolves the dir at CALL time, so a test that runs
    a script without this writes into the checkout's own state/. In the live checkout that is the
    real orchestrator's state: measured 2026-09-05, a full run of this suite left the stub's fake
    accounts in usage-survey.json, which the scheduled lanes then read as the fleet for up to four
    minutes. Side by side with a scheduled pass, or with a second copy of the suite, the two
    collide on locks and four name-pass tests went red. `probe_state_dir.py` finds the modules
    that still write there. Call this FIRST in setUp; the cleanup restores what was set before."""
    tmp = tempfile.TemporaryDirectory()
    case.addCleanup(tmp.cleanup)
    prev = os.environ.get("ORCHESTRATOR_STATE_DIR")

    def restore():
        if prev is None:
            os.environ.pop("ORCHESTRATOR_STATE_DIR", None)
        else:
            os.environ["ORCHESTRATOR_STATE_DIR"] = prev

    case.addCleanup(restore)
    state = Path(tmp.name) / "state"
    os.environ["ORCHESTRATOR_STATE_DIR"] = str(state)
    return state
