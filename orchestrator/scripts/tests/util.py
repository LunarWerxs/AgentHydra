"""Shared test helper: run a script's main() exactly as the CLI contract sees it.

One copy (was pasted into nine test files until the 2026-08-31 standardization pass).
Import AFTER the sys.path.insert lines every test file already carries.
"""

from __future__ import annotations

import contextlib
import io


def run_cli(fn, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn(argv)
    return code, out.getvalue(), err.getvalue()
