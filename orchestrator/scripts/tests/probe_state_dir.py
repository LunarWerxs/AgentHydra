#!/usr/bin/env python3
"""Which test modules write into the CHECKOUT's orchestrator/state dir?

Deterministic, no judgment: for each scripts/tests/test_*.py, remove <orchestrator>/state, run
that one module with ORCHESTRATOR_STATE_DIR unset, and report whether state/ exists afterwards
(even a lock that was unlinked leaves the directory behind). A module that creates it runs
against the live checkout's state when the suite runs there - the real orchestrator's usage
cache, ledger and locks - and collides with a scheduled pass or a second copy of the suite.
The fix is one line at the top of the class's setUp: `isolate_state_dir(self)` from util.py.

Why it exists (2026-09-05): four copies of this suite side by side put three of them red on the
same four name-pass tests (a shared naming lock), and a full run in the live checkout had left
the stub's fake accounts in usage-survey.json for the scheduled lanes to read. Three more modules
were found this way in one pass; all four are fixed and this file keeps the next one from hiding.

Run: python scripts/tests/probe_state_dir.py [<orchestrator dir>]   (about 15 minutes; not a
gate - the name has no test_ prefix on purpose, so discover never collects it)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    orch = Path(argv[0]).resolve() if argv else Path(__file__).resolve().parents[2]
    state = orch / "state"
    env = {k: v for k, v in os.environ.items() if k != "ORCHESTRATOR_STATE_DIR"}
    env["PYTHONIOENCODING"] = "utf-8"
    touched: list[tuple[str, list[str]]] = []
    clean: list[str] = []
    red: list[str] = []
    for mod in sorted((orch / "scripts" / "tests").glob("test_*.py")):
        if state.exists():
            shutil.rmtree(state, ignore_errors=True)
        p = subprocess.run([sys.executable, "-X", "utf8", "-m", "unittest", "discover", "-s", "scripts/tests", "-p", mod.name],
                           cwd=str(orch), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=1800)
        if p.returncode != 0:
            red.append(mod.name)
        if state.exists():
            touched.append((mod.name, [str(x.relative_to(state)) for x in state.rglob("*")]))
        else:
            clean.append(mod.name)
    if state.exists():
        shutil.rmtree(state, ignore_errors=True)
    print(f"probed {len(touched) + len(clean)} modules: {len(touched)} touch the checkout's state/, "
          f"{len(clean)} clean, {len(red)} red on their own")
    for name, files in touched:
        print(f"  TOUCHES  {name}  left: {files[:6]}")
    for name in red:
        print(f"  RED      {name}  (red run alone: an order dependency, or a file discover collects nothing from)")
    return 1 if touched else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
