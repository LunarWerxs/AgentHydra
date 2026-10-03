"""Offline: a review task that declares an `inventory` must hand back a `reviewed_paths` receipt equal to it.

Contract: the receipt is checked by hswarm, not trusted from the worker - in the worker loop (a partial receipt is a
tool error the model can fix) and again at the job gate (whatever the backend, an ok result without a matching
receipt ends as IncompleteReview). Regression it catches: a cheap worker reads three files of ten and its
"reviewed, no issues" comes back ok. Also pins the `review` role's rubric and default schema being attached.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import review  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result, Task  # noqa: E402
from hswarm.tools import Sandbox  # noqa: E402
from hswarm.worker import run_tools  # noqa: E402

INVENTORY = ["src/a.py", "src/b.py", "docs/gone.md"]


def _submit(args: dict) -> dict:
    return {"id": "t1", "function": {"name": "submit_result", "arguments": json.dumps(args)}}


def test_partial_receipt_is_rejected_back_to_the_worker():
    outputs, submitted = asyncio.run(run_tools(None, [_submit({"summary": "no issues", "reviewed_paths": ["src/a.py"]})], None, inventory=INVENTORY))
    assert submitted is None
    assert outputs[0].startswith("ERROR: submit_result rejected - IncompleteReview") and "src/b.py" in outputs[0] and "docs/gone.md" in outputs[0]


def test_claimed_path_outside_the_inventory_is_rejected():
    outputs, submitted = asyncio.run(run_tools(None, [_submit({"reviewed_paths": INVENTORY + ["src/extra.py"]})], None, inventory=INVENTORY))
    assert submitted is None and "not in the inventory src/extra.py" in outputs[0]


def test_full_receipt_is_accepted_whatever_the_slashes():
    receipt = {"summary": "ok", "reviewed_paths": ["./src/a.py", "src\\b.py", "docs/gone.md"]}
    outputs, submitted = asyncio.run(run_tools(None, [_submit(receipt)], None, inventory=INVENTORY))
    assert submitted == receipt and outputs == ["result accepted"]


def test_receipt_path_never_read_is_rejected_until_it_is(tmp_path):
    # The inventory is in the worker's prompt, so a full receipt alone proves nothing: on the api backend every listed
    # path that still exists must have been opened with read_file. docs/gone.md is deleted, so it needs no read.
    (tmp_path / "src").mkdir()
    for name in ("a.py", "b.py"):
        (tmp_path / "src" / name).write_text("x = 1\n", encoding="utf-8")
    sb = Sandbox(tmp_path)
    receipt = _submit({"summary": "ok", "reviewed_paths": INVENTORY})
    asyncio.run(sb.run("read_file", {"path": "src/a.py"}))
    outputs, submitted = asyncio.run(run_tools(sb, [receipt], None, inventory=INVENTORY))
    assert submitted is None and "never opened with read_file: src/b.py" in outputs[0] and "docs/gone.md" not in outputs[0]
    asyncio.run(sb.run("read_file", {"path": "src/b.py"}))
    outputs, submitted = asyncio.run(run_tools(sb, [receipt], None, inventory=INVENTORY))
    assert outputs == ["result accepted"]


def test_inventory_demands_the_receipt_in_schema_and_prompt(tmp_path):
    t = Task.from_dict({"prompt": "review it", "cwd": str(tmp_path), "model": "flash", "inventory": ["./src/a.py", "src/a.py", "src/b.py"]}, {}, 0)
    assert t.inventory == ["src/a.py", "src/b.py"]
    assert "reviewed_paths" in t.schema["required"] and t.schema["properties"]["reviewed_paths"]["type"] == "array"
    assert "- src/a.py" in t.prompt and "- src/b.py" in t.prompt


def test_review_role_brings_rubric_and_default_schema(tmp_path):
    t = Task.from_dict({"prompt": "review the diff", "cwd": str(tmp_path), "model": "flash", "role": "review", "system": "Repo rule: no em-dashes."}, {}, 0)
    assert t.system.startswith(review.RUBRIC) and t.system.endswith("Repo rule: no em-dashes.")
    assert {"verdict", "problem", "solution", "ownership", "findings"} <= set(t.schema["required"])
    own = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "model": "flash", "role": "review", "schema": {"type": "object", "properties": {"n": {"type": "integer"}}}}, {}, 1)
    assert own.schema == {"type": "object", "properties": {"n": {"type": "integer"}}}  # a caller's own schema wins


def test_job_gate_fails_an_ok_result_without_a_matching_receipt(tmp_path, monkeypatch):
    # The worker loop is faked: an ok answer with a partial receipt, the shape a cc worker or a final-text reply leaves.
    async def fake_legs(self, job, task, warm, is_pilot):
        data = {"summary": "no issues", "reviewed_paths": ["src/a.py"] if task.id == "partial" else list(INVENTORY)}
        return Result(id=task.id, status="ok", model=task.model, answer="no issues", data=data), None

    monkeypatch.setattr(JobManager, "_run_legs", fake_legs)
    tasks = [Task.from_dict({"id": i, "prompt": "review", "cwd": str(tmp_path), "model": "flash", "route": False, "inventory": INVENTORY}, {}, n)
             for n, i in enumerate(("partial", "full"))]
    job = asyncio.run(JobManager(client=object()).run_batch(tasks))
    assert job.results["partial"].status == "error" and job.results["partial"].error.startswith("IncompleteReview:")
    assert job.results["partial"].data["reviewed_paths"] == ["src/a.py"]  # what it did cover stays visible
    assert job.results["full"].status == "ok"
