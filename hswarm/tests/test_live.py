"""Live tests: hit DeepSeek (cents) and spawn real workers. Skipped without a key.

    python -m pytest tests/test_live.py -m live -q
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.agent import ask  # noqa: E402
from hswarm.client import DeepSeekClient  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402

pytestmark = pytest.mark.live

if not config.key_status()["present"]:
    pytest.skip("no DeepSeek key", allow_module_level=True)
from hswarm import keys  # noqa: E402

if not keys.has_credit(config.DEFAULT_PROVIDER):  # keys on file that are all out of credit cannot pass a live call either
    pytest.skip("no DeepSeek key with credit", allow_module_level=True)


def run(coro):
    return asyncio.run(coro)


def test_ask_plain():
    async def go():
        async with DeepSeekClient() as c:
            return await ask(c, "Reply with exactly the word PONG.", thinking=False, max_tokens=10)
    r = run(go())
    assert r.status == "ok" and "PONG" in r.answer.upper()
    assert r.cost_usd is not None and 0 < r.cost_usd < 0.001


def test_ask_schema():
    async def go():
        async with DeepSeekClient() as c:
            return await ask(c, "Colors: red, green, blue.", schema={"type": "object", "properties": {"count": {"type": "integer"}, "colors": {"type": "array", "items": {"type": "string"}}}, "required": ["count", "colors"]}, thinking=False)
    r = run(go())
    assert r.status == "ok" and r.data["count"] == 3 and len(r.data["colors"]) == 3


def test_api_tool_loop_edits_file(tmp_path):
    (tmp_path / "greet.py").write_text("def greet(name):\n    return 'Hello ' + nme\n")

    async def go():
        m = JobManager()
        job = m.submit([Task.from_dict({"prompt": "greet.py has a NameError bug. Fix it with edit_file. Reply with one line.", "cwd": str(tmp_path), "tools": "edit"}, {}, 0)])
        await m.wait(job.id, 180)
        await m.aclose()
        return job

    job = run(go())
    r = job.results["t1"]
    assert r.status == "ok", r.error
    assert "greet.py" in r.files_changed
    assert "nme" not in (tmp_path / "greet.py").read_text()
    assert (config.JOBS_DIR / job.id / "results.jsonl").exists()


def test_api_burst_100():
    async def go():
        async with DeepSeekClient() as c:
            async def one(i):
                return await c.chat([{"role": "user", "content": f"Reply OK ({i})"}], max_tokens=5, thinking=False)
            res = await asyncio.gather(*[one(i) for i in range(100)], return_exceptions=True)
            return res, c.retries
    res, retries = run(go())
    errs = [r for r in res if isinstance(r, Exception)]
    assert not errs, errs[:3]
    assert retries < 20


def test_cc_backend_pong(tmp_path):
    async def go():
        m = JobManager()
        job = m.submit([Task.from_dict({"prompt": "Create a file pong.txt containing exactly PONG. Reply DONE.", "cwd": str(tmp_path), "backend": "cc", "tools": "edit", "confirm_write": True, "max_turns": 4}, {}, 0)])
        await m.wait(job.id, 240)
        await m.aclose()
        return job

    job = run(go())
    r = job.results["t1"]
    assert r.status == "ok", r.error
    assert (tmp_path / "pong.txt").read_text().strip() == "PONG"
    assert r.cost_usd is not None and r.cost_usd < 0.01, r.cost_usd
    # From the worker's own stream-json tool calls, not a diff of the folder.
    assert r.files_changed == ["pong.txt"] and r.tool_calls >= 1, (r.files_changed, r.tool_calls)
