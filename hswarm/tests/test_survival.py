"""Offline: edit survival - whether the code an api worker wrote is still in the file later, per ledger row and per model."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, survival  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.ledger import ledger_rows, ledger_summary  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402

BEFORE = "def area(r):\n    return 3.14 * r * r\n"
AFTER = "import math\n\n\ndef area(r):\n    return math.pi * r ** 2\n\n\ndef circumference(r):\n    return 2 * math.pi * r\n"
REWORKED = 'def area(radius: float) -> float:\n    """Disc area."""\n    return radius * radius * 22 / 7\n'


def _edit_then(tmp_path: Path, now: str | None, new_file_now: str | None) -> dict:
    """A worker edits geo.py and creates notes.txt through the Sandbox; then the files become `now` / `new_file_now`."""
    (tmp_path / "geo.py").write_text(BEFORE, encoding="utf-8", newline="")
    sb = Sandbox(tmp_path)
    asyncio.run(sb.t_read_file("geo.py"))  # a worker reads an existing file before overwriting it (tools.Sandbox read gate)
    asyncio.run(sb.t_write_file("geo.py", AFTER))
    asyncio.run(sb.t_write_file("notes.txt", "area now uses math.pi\n"))
    files = survival.snapshot(sb.originals)
    for name, text in (("geo.py", now), ("notes.txt", new_file_now)):
        if text is None:
            (tmp_path / name).unlink()
        else:
            (tmp_path / name).write_text(text, encoding="utf-8", newline="")
    return {Path(f["path"]).name: survival.file_score(f["before"], f["after"], survival.read_text(f["path"])) for f in files}


def test_the_score_tells_a_kept_edit_from_a_reworked_one_and_a_rollback(tmp_path):
    """The two numbers answer different questions: four_gram "is the worker's text still there", no_revert "did
    someone put the old file back". A rework loses the first and keeps the second; a rollback loses both."""
    (tmp_path / "a").mkdir()
    kept = _edit_then(tmp_path / "a", AFTER, "area now uses math.pi\n")
    assert kept["geo.py"]["four_gram"] == 1.0 and kept["geo.py"]["no_revert"] == 1.0
    assert kept["notes.txt"]["four_gram"] == 1.0 and kept["notes.txt"]["no_revert"] == 1.0

    (tmp_path / "b").mkdir()
    reworked = _edit_then(tmp_path / "b", REWORKED, "area now uses math.pi\n")
    assert reworked["geo.py"]["four_gram"] < 0.3 and reworked["geo.py"]["no_revert"] == 1.0

    (tmp_path / "c").mkdir()
    reverted = _edit_then(tmp_path / "c", BEFORE, None)  # the old file restored, the new file deleted
    assert reverted["geo.py"]["four_gram"] == 0.0 and reverted["geo.py"]["no_revert"] == 0.0
    assert reverted["notes.txt"]["four_gram"] == 0.0 and reverted["notes.txt"]["no_revert"] == 0.0


class _EditingClient:
    """Stands in for the provider: turn 1 edits geo.py through the worker's own edit_file tool, turn 2 answers."""

    def __init__(self):
        self.turns = 0

    async def chat(self, messages, **kw):
        self.turns += 1
        if self.turns == 1:
            args = json.dumps({"path": "geo.py", "old_string": BEFORE, "new_string": AFTER})
            call = {"id": "c1", "type": "function", "function": {"name": "edit_file", "arguments": args}}
            return ChatResult(message={"role": "assistant", "content": "", "tool_calls": [call]}, finish_reason="tool_calls",
                              usage=Usage(), model="deepseek-flash", seconds=0.01, cost_usd=0.0, peak=False)
        return ChatResult(message={"role": "assistant", "content": "done"}, finish_reason="stop", usage=Usage(),
                          model="deepseek-flash", seconds=0.01, cost_usd=0.0, peak=False)

    async def aclose(self):
        pass


def test_an_api_workers_edit_is_journalled_then_scored_onto_its_ledger_row_and_model(tmp_path):
    """The path a real task takes: the job journals the edit, a later pass scores it at the checkpoint it reached,
    and the ledger row and the per-model summary carry the score. A pass that runs late files its reading under the
    checkpoint actually reached, and the last checkpoint drops the snapshot."""
    work = tmp_path / "repo"
    work.mkdir()
    (work / "geo.py").write_text(BEFORE, encoding="utf-8", newline="")

    async def go():
        m = JobManager(client=_EditingClient())
        task = Task.from_dict({"id": "t0", "prompt": "use math.pi", "cwd": str(work), "tools": "edit", "model": "deepseek-flash"}, {}, 0)
        return await m.run_batch([task], concurrency=1)

    job = asyncio.run(go())
    assert job.results["t0"].status == "ok" and job.results["t0"].files_changed == ["geo.py"]
    row = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()][-1]
    assert row["files_changed"] == 1
    snap = survival.edits_dir() / job.id / "t0.json"
    assert snap.exists()

    (work / "geo.py").write_text(BEFORE, encoding="utf-8", newline="")  # the owner rolls the edit back
    finished = dt.datetime.fromisoformat(job.results["t0"].finished)
    assert survival.score_due(finished + dt.timedelta(hours=2))["scored"] == 1
    [r] = [r for r in ledger_rows(1) if r.get("job") == job.id]
    assert r["survival"]["checkpoint"] == "1h" and r["survival"]["four_gram"] == 0.0 and r["survival"]["no_revert"] == 0.0
    assert ledger_summary(1)["by_model"][r["model"]]["survival"] == {"scored": 1, "four_gram": 0.0, "no_revert": 0.0}
    assert survival.score_due(finished + dt.timedelta(hours=3))["scored"] == 0  # 1h already on record

    assert survival.score_due(finished + dt.timedelta(days=2)) == {"scored": 1, "finished": 1}
    assert not snap.exists()
    assert survival.score_due(finished + dt.timedelta(days=3))["scored"] == 0
