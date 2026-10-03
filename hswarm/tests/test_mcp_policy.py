"""Offline: hswarm's MCP tools are served through one least-authority table (hswarm/mcp_policy.py).

The advertised hints are derived from each tool's class, and the same class is what HSWARM_MCP_CLASSES gates, so a
tool can neither go unclassified nor claim read-only while its body writes."""
from __future__ import annotations

import asyncio

from hswarm import mcp_policy, mcp_server


def _served() -> dict:
    return {t.name: t for t in asyncio.run(mcp_server.mcp.list_tools())}


def test_every_served_tool_has_a_class_and_advertises_its_derived_hints():
    served = _served()
    assert set(served) == set(mcp_policy.TOOL_POLICY)
    for name, tool in served.items():
        assert tool.annotations == mcp_policy.annotations_for(name), name


def test_a_tool_that_touches_keys_or_spends_is_never_advertised_read_only():
    served = _served()
    # hswarm_doctor looks like a health read, but its balance probe parks and clears keys.
    for name in ("hswarm_doctor", "hswarm_keys", "hswarm_run", "hswarm_ask", "hswarm_sync"):
        assert served[name].annotations.read_only_hint is False, name
    assert served["hswarm_status"].annotations.read_only_hint is True


def test_an_ungranted_class_is_refused_before_the_body_runs(monkeypatch):
    # A body that runs anyway must spend nothing: with the gate gone, hswarm_run would otherwise submit a live job.
    def no_manager():
        raise AssertionError("the tool body ran: the class gate did not refuse it")

    monkeypatch.setattr(mcp_server, "manager", no_manager)
    monkeypatch.setenv(mcp_policy.ENV, "read,external-read")
    out = asyncio.run(mcp_server.hswarm_run(tasks=["say OK"], tools="none", wait=False))
    assert out["tool"] == "hswarm_run" and "'execute'" in out["error"]
    monkeypatch.setenv(mcp_policy.ENV, "external-read")
    assert asyncio.run(mcp_server.hswarm_jobs(limit=1))[0]["tool"] == "hswarm_jobs"  # a list-typed tool keeps its shape
    monkeypatch.setenv(mcp_policy.ENV, "reed")  # a typo refuses everything and names itself, never widens the grant
    assert "unknown classes" in mcp_policy.refusal("hswarm_status")
