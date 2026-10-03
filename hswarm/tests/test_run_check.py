"""Offline: `hswarm run --check` validates a tasks file and says whether it can be served, and sends nothing.

Before it, a file with a typo showed its mistake only after the whole batch had run and been paid for (2026-10-02)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import commands, config  # noqa: E402
from hswarm.cli import build_parser  # noqa: E402


def _check(path: Path) -> int:
    return asyncio.run(commands.cmd_run(build_parser().parse_args(["run", str(path), "--check"])))


def test_check_passes_a_good_file_and_refuses_a_typo_without_a_job(tmp_path, capsys):
    good = tmp_path / "good.json"
    good.write_text(json.dumps([{"id": "a", "prompt": "say hi", "cwd": str(tmp_path), "tools": "none"}]), encoding="utf-8")
    assert _check(good) == 0
    out = capsys.readouterr().out
    assert out.startswith("a: ") and "servable: nothing was sent" in out

    typo = tmp_path / "typo.json"
    typo.write_text(json.dumps([{"id": "a", "prompt": "say hi", "cwd": str(tmp_path), "tool": "none"}]), encoding="utf-8")
    assert _check(typo) == 1
    assert "unknown fields ['tool']" in capsys.readouterr().out

    twice = tmp_path / "twice.json"
    twice.write_text(json.dumps([{"id": "a", "prompt": "x", "cwd": str(tmp_path), "tools": "none"}] * 2), encoding="utf-8")
    assert _check(twice) == 1  # what submit refuses, --check refuses too
    assert "duplicate task ids" in capsys.readouterr().out

    assert not config.JOBS_DIR.exists() or not any(config.JOBS_DIR.iterdir())
