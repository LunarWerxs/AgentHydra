"""What every chat on this machine pays for and reads: the server instructions, hswarm_run's description, and the
shape of the answers (2026-10-02). Called at the MCP boundary (mcp.call_tool, mcp.list_tools) where the SDK's own
argument model and serializer are part of the behaviour, and at the tool function where they are not."""
import asyncio
import json

import pytest

from hswarm import dispatch, install, mcp_server, selection, shared


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


def test_the_instructions_reach_a_claude_code_chat_whole():
    # Claude Code keeps 2,048 characters of a server's instructions. At 2,433 the cut fell inside the model/profile
    # paragraph, so no chat ever read the verify-the-citation rule or "never ask the user to paste a key".
    shown = install.instructions_text() + shared.SHARED_NOTE  # what shared.serve hands every chat
    assert len(shown) <= 2048
    assert "`file:line`" in shown and "paste a key" in shown


def test_hswarm_run_description_stays_under_3000_characters():
    # 13,564 characters before: once a chat loads the tool, it re-reads them on every turn. The per-option
    # reference lives in docs/API.md ("hswarm_run options"); a new option is documented there, not here.
    served = {t.name: t for t in asyncio.run(mcp_server.mcp.list_tools())}
    assert len(served["hswarm_run"].description) <= 3000


def test_a_dict_answer_is_served_as_one_compact_json_line(mgr):
    # `schema` is the one argument the SDK aliases (it shadows a pydantic attribute): it must still get through.
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    out = asyncio.run(mcp_server.mcp.call_tool("hswarm_run", {"tasks": ["say OK"], "tools": "none", "schema": schema, "wait": False}))
    text = out.content[0].text
    assert "\n" not in text  # the SDK's own rendering of a dict is indent=2, a line per key
    answer = json.loads(text)
    assert mgr.submitted == 1 and answer["tool"] == "hswarm_run" and "Submitted" in answer["error"]


def test_a_misspelled_argument_is_refused_with_the_nearest_name_and_nothing_is_submitted(mgr):
    # `budget` used to be dropped without a word, leaving budget_usd=None: a job with no ceiling.
    with pytest.raises(Exception) as refused:
        asyncio.run(mcp_server.mcp.call_tool("hswarm_run", {"tasks": ["say OK"], "tools": "none", "budget": 1, "wait": False}))
    assert "unknown argument 'budget'" in str(refused.value) and "'budget_usd'" in str(refused.value)
    assert mgr.submitted == 0


def test_server_behind_is_a_sentence_once_per_chat_then_a_flag(monkeypatch):
    class Job:
        id = "j1"

    class Mgr:
        _gates = {}

        def submit(self, parsed, **kw):
            return Job()

    sentence = "this hswarm process (pid 1, 0.0.0, code from 2026-10-01T00:00:00Z) runs the code it loaded, and 13 source file(s) changed on disk since"
    monkeypatch.setattr(mcp_server, "manager", lambda: Mgr())
    monkeypatch.setattr(mcp_server, "job_payload", lambda *a, **k: {"summary": {}, "results": []})
    monkeypatch.setattr(dispatch, "route_outlook", lambda *a, **k: None)
    monkeypatch.setattr(shared, "behind", lambda: sentence)
    monkeypatch.setattr(mcp_server, "_told_behind", set())

    async def run_as(chat):
        token = shared.REQUEST.set({"mcp_session": chat})
        try:
            return (await mcp_server.hswarm_run(tasks=["say OK"], tools="none", wait=False))["server_behind"]
        finally:
            shared.REQUEST.reset(token)

    assert [asyncio.run(run_as("chat-a")) for _ in range(2)] == [sentence, True]
    assert asyncio.run(run_as("chat-b")) == sentence  # another chat on the shared server has not been told yet


def test_select_answers_with_names_and_flags_and_the_whole_plan_only_when_asked(monkeypatch):
    class Mgr:
        _gates = {}

    def plan(profile, **kw):
        return {"profile": profile, "purpose": "production", "evidence_date": "2026-10-01", "explanation": "x" * 150,
                "candidates": [{"model": f"model-{i}", "reasoning_effort": "high", "score": 60 + i, "benchmark_cost_usd": 0.1 * (i + 1),
                                "source": "https://example.com/leaderboard", "scores": {"coding": 60 + i, "agentic": 50},
                                "rates": {"hit": 0.1, "miss": 1.0, "out": 4.0}, "configuration": f"Model {i} (high)", "free": False}
                               for i in range(4)],
                "rejected": [{"model": f"out-{i}", "filter": "floor", "reason": "coding 41 < 55"} for i in range(48)],
                "unavailable": [{"model": f"gone-{i}", "provider": "p", "why": "every key resting"} for i in range(30)]}

    monkeypatch.setattr(mcp_server, "manager", lambda: Mgr())
    monkeypatch.setattr(dispatch, "_plan", plan)
    monkeypatch.setattr(dispatch, "_rescue", lambda profile, **kw: [])
    selection.note_crawl("model-0")

    brief = asyncio.run(mcp_server.hswarm_select(profile="code"))
    assert len(json.dumps(brief)) < 1500
    assert brief["candidates"] == [{"model": "model-1"}, {"model": "model-2"}, {"model": "model-3"}, {"model": "model-0", "crawling": True}]
    assert (brief["profile"], brief["rejected"], brief["unavailable"]) == ("code", 48, 30)

    full = asyncio.run(mcp_server.hswarm_select(profile="code", verbose=True))
    assert all("rates" in c for c in full["candidates"]) and len(full["rejected"]) == 48 and full["unavailable"][0]["why"]
