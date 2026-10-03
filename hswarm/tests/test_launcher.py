"""The launcher starts HSwarm from any working folder with no install (2026-10-03: `python -m hswarm` only worked
from the AgentHydra root, so every registration built from launcher() was broken elsewhere)."""
from __future__ import annotations

import subprocess

from hswarm import config, install


def test_launcher_runs_from_another_folder(tmp_path):
    r = subprocess.run([*config.launcher(), "--help"], cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "hswarm" in (r.stdout + r.stderr).lower()


def test_registered_stdio_command_runs_from_another_folder(tmp_path):
    e = install.stdio_entry()
    r = subprocess.run([e["command"], *e["args"][:-1], "--help"], cwd=tmp_path, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
