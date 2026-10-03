"""Batch the questions, not the calls (owner, 2026-09-29): hswarm_run refuses a fan-out of many small tool-free
tasks of one shape BEFORE anything is submitted, and lets through what legitimately needs one call per item;
hswarm_ask hands the packing recipe back beside the answer once a chat sends small asks one after another.
Called at the MCP tool boundary with only the job manager stubbed, like test_mcp_refusal.py."""
import asyncio

import pytest

from hswarm import batching, mcp_server


class Submitted(Exception):
    """Raised by the stub manager: the call got past every check to submit()."""


class Recorder:
    def __init__(self):
        self.submitted = 0

    def submit(self, parsed, **kw):
        self.submitted += 1
        raise Submitted(f"{len(parsed)} tasks")


@pytest.fixture
def mgr(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(mcp_server, "manager", lambda: rec)
    return rec


def test_a_fan_out_of_small_tool_free_questions_is_refused_and_nothing_is_submitted(mgr):
    out = asyncio.run(mcp_server.hswarm_run(tasks=[f"Is {n} prime? Answer yes or no." for n in range(12)], tools="none", wait=False))
    assert mgr.submitted == 0
    assert out["error"].startswith("unbatched fan-out refused: 12 small tool-free tasks")
    assert "array" in out["batching"]


@pytest.mark.parametrize("kwargs", [
    {"tools": "none", "unbatched": True},  # every question needs its own call: the caller says so
    {"tools": "none", "purpose": "evaluation"},  # a benchmark measures one question per call on purpose
    {"tools": "read"},  # a task that reads its own files is work, not a question
])
def test_what_needs_one_call_per_item_still_goes_out(mgr, kwargs):
    out = asyncio.run(mcp_server.hswarm_run(tasks=[f"Is {n} prime?" for n in range(12)], wait=False, **kwargs))
    assert mgr.submitted == 1 and "Submitted" in out["error"]


def test_a_chat_asking_one_small_question_after_another_gets_the_recipe(monkeypatch):
    from hswarm.spec import Result

    class Fine:
        async def ask_routed(self, *a, **k):
            return Result(id="ask", status="ok", model="groq-gpt-oss-120b", answer="yes")

    monkeypatch.setattr(mcp_server, "manager", lambda: Fine())
    batching._asks.clear()
    outs = [asyncio.run(mcp_server.hswarm_ask(f"Is {n} prime?")) for n in range(batching.ASK_NOTE_AT)]
    assert all(o["answer"] == "yes" for o in outs)  # the answer is never withheld
    assert "batching" not in outs[-2] and "Ask them together" in outs[-1]["batching"]
