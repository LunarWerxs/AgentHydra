"""hswarm_run must return a refused task spec's REASON, never raise it into the MCP layer.

Measured 2026-09-19: reasoning_effort="medium" raised ValueError inside hswarm_run, FastMCP reduced it
to "Error executing tool hswarm_run", and the caller lost two batches bisecting its arguments. The tool
is called directly here (no server), so this fails against the old code with the ValueError itself.
"""
import asyncio

from hswarm import mcp_server


def test_bad_reasoning_effort_is_refused_with_its_reason():
    out = asyncio.run(mcp_server.hswarm_run(tasks=["say OK"], tools="none", reasoning_effort="ultra", wait=False))
    assert "error" in out
    assert "reasoning_effort" in out["error"]
    assert "low|medium|high|xhigh|max" in out["hint"]


def test_a_tool_that_raises_returns_the_reason_not_a_bare_error(monkeypatch):
    """2026-09-21, Jacob's PC: hswarm_ask failed as a bare "Error executing tool" while the CLI answered."""
    class Boom:
        async def ask_routed(self, *a, **k):
            raise RuntimeError("client has been closed")

    monkeypatch.setattr(mcp_server, "manager", lambda: Boom())
    out = asyncio.run(mcp_server.hswarm_ask("say ok"))
    assert out["error"] == "RuntimeError: client has been closed" and out["tool"] == "hswarm_ask" and out["where"]


def test_bookkeeping_failure_never_costs_the_answer(monkeypatch):
    from hswarm.spec import Result

    class Fine:
        async def ask_routed(self, *a, **k):
            return Result(id="ask", status="ok", model="groq-gpt-oss-120b", answer="ok")

    def broken(*a, **k):
        raise OSError("database is locked")

    monkeypatch.setattr(mcp_server, "manager", lambda: Fine())
    monkeypatch.setattr(mcp_server.utilization, "record_ask", broken)
    out = asyncio.run(mcp_server.hswarm_ask("say ok"))
    assert out["answer"] == "ok" and out["status"] == "ok" and "database is locked" in out["bookkeeping_error"]


def test_the_decorator_keeps_every_tool_schema():
    """FastMCP builds each tool's input schema from its signature; the wrapper must not hide it."""
    import inspect

    assert list(inspect.signature(mcp_server.hswarm_ask).parameters)[:3] == ["prompt", "system", "model"]
    assert "items" in inspect.signature(mcp_server.hswarm_decide).parameters
