"""hswarm_panel: a blind first round, an anonymised rebuttal round decoded through each panelist's own seating,
and findings regrouped with CONTESTED ones first. All offline: a fake manager answers by model and round."""
from __future__ import annotations

import asyncio
import random
import re
from types import SimpleNamespace

import pytest

from hswarm import config
from hswarm import panel as p

G, M, D = "groq-gpt-oss-120b", "gemini-3.8-flash", "deepseek-flash"
FIRST = {G: "Findings:\n1. SQL injection in login\n2. Missing index on users.email",
         M: "1. SQL injection in login\n2. **No rate limit** on /reset",
         D: "1) Password stored in plain text"}


def _refs(prompt: str, finding: str) -> list[str]:
    """The labels a rebuttal prompt gave `finding` - whatever letters this panelist's seating dealt its authors."""
    return re.findall(r"^([A-X]\d+)\. " + re.escape(finding), prompt, re.M)


class FakeMgr:
    """Round 1 answers from FIRST; round 2 runs `rebut(model, prompt)`. Records (model, prompt) per call."""

    def __init__(self, rebut, fail: set | None = None):
        self.rebut, self.fail, self.calls = rebut, fail or set(), []

    async def ask_routed(self, prompt, model, **kw):
        self.calls.append((model, prompt))
        if model in self.fail:
            return SimpleNamespace(status="error", answer=None, model=model, cost_usd=None, error="NoCreditLeft")
        text = self.rebut(model, prompt) if "Reviewer A:" in prompt else FIRST[model]
        return SimpleNamespace(status="ok", answer=text, model=model, cost_usd=0.001, error=None)


def _run(mgr, models=(G, M, D), seed=7):
    return asyncio.run(p.panel("Review this diff.", mgr, models=list(models), seed=seed))


def test_round_one_is_blind_every_panelist_gets_the_same_prompt_and_no_other_answer():
    mgr = FakeMgr(lambda m, pr: "")
    _run(mgr)
    first = [pr for _, pr in mgr.calls if "Reviewer A:" not in pr]
    assert len(first) == 3 and len(set(first)) == 1
    assert not any(f in first[0] for f in ("SQL injection", "plain text", "rate limit"))


def test_rebuttal_is_anonymous_and_dealt_afresh_per_panelist():
    mgr = FakeMgr(lambda m, pr: "")
    _run(mgr)
    second = {m: pr for m, pr in mgr.calls if "Reviewer A:" in pr}
    assert set(second) == {G, M, D}
    for model, pr in second.items():
        assert not any(name in pr for name in (G, M, D)), f"{model}'s rebuttal names a panelist"
    # The letters are not the input order: over many seeds a panelist sees the other two both ways round.
    views = {tuple(p.seatings(3, random.Random(s))[0].values()) for s in range(20)}
    assert views == {(1, 2), (2, 1)}


def test_positions_decode_through_the_rebutting_panelists_own_seating_and_contested_leads():
    def rebut(model, pr):
        if model == M:  # rejects groq's SQL finding, whatever letter groq wears in gemini's prompt
            return f"- **REJECT {_refs(pr, 'SQL injection')[0]}**: parameterised\nMISSED: CSRF token absent"
        if model == D:  # upholds both SQL findings and groq's index one, under this prompt's own letters
            lines = [f"UPHOLD {r}: yes" for r in _refs(pr, "SQL injection") + _refs(pr, "Missing index")]
            return "\n".join(lines + ["REJECT Q1: no such reviewer"])
        return "CONCEDE Y2: the index exists"

    for seed in range(6):  # every seating must decode to the same verdicts
        out = _run(FakeMgr(rebut), seed=seed)
        rows = {r["id"]: r for r in out["findings"]}
        assert out["contested"] == ["P1.1"] and out["findings"][0]["id"] == "P1.1"
        assert (rows["P1.1"]["rejected_by"], rows["P1.1"]["upheld_by"]) == ([M], [D])
        assert (rows["P2.1"]["status"], rows["P2.1"]["upheld_by"], rows["P2.1"]["rejected_by"]) == ("upheld", [D], [])
        assert rows["P1.2"]["status"] == "upheld" and rows["P1.2"]["conceded"] is True  # conceded, but another still upholds it
        assert rows["P3.1"]["status"] == "unreviewed" and rows["P2.2"]["status"] == "unreviewed"
        assert out["missed"] == [{"by": M, "finding": "CSRF token absent"}] and out["unresolved_refs"] == 1


def test_the_mcp_tool_books_both_rounds_and_keeps_its_payload_plain(monkeypatch):
    from hswarm import mcp_server

    booked = []

    async def book(results, kind, extra=()):
        booked.append((len(results), kind))
        return {}

    mgr = FakeMgr(lambda m, pr: "")
    monkeypatch.setattr(mcp_server, "manager", lambda: mgr)
    monkeypatch.setattr(mcp_server, "_book_asks", book)
    out = asyncio.run(mcp_server.hswarm_panel("Review this diff.", models=[G, M]))
    assert "error" not in out and "_results" not in out
    assert booked == [(4, "panel")] and out["summary"]["answered"] == 2


def test_a_rejected_finding_its_author_concedes_is_not_contested():
    findings = [["a finding"], ["b finding"]]
    seats = [{"A": 1}, {"A": 0}]
    out = p.tally([G, M], findings, seats, [[{"stance": "concede", "ref": "Y1", "why": ""}], [{"stance": "reject", "ref": "A1", "why": "no"}]])
    assert out["contested"] == [] and out["findings"][-1]["status"] == "conceded"
    out = p.tally([G, M], findings, seats, [[], [{"stance": "reject", "ref": "A1", "why": "no"}]])
    assert out["contested"] == ["P1.1"]


def test_parsers_read_what_models_actually_write():
    assert p.parse_findings("Intro\n1. one\n2) two\n  3.  three  \n- not numbered", 2) == ["one", "two"]
    got = p.parse_positions("* **UPHOLD B3**: holds\nreject a1 - wrong\nCONCEDE: Y2\nMISSED - a race in save()\nsomething else")
    assert got == [{"stance": "uphold", "ref": "B3", "why": "holds"}, {"stance": "reject", "ref": "A1", "why": "wrong"},
                   {"stance": "concede", "ref": "Y2", "why": ""}, {"stance": "missed", "ref": "", "why": "a race in save()"}]


def test_a_failed_panelist_is_reported_and_one_survivor_skips_the_rebuttal():
    mgr = FakeMgr(lambda m, pr: "UPHOLD A1: ok", fail={M, D})
    out = _run(mgr)
    assert {r["model"]: r.get("error") for r in out["panel"]} == {G: None, M: "NoCreditLeft", D: "NoCreditLeft"}
    assert "no rebuttal round" in out["summary"]["note"] and not any("Reviewer A:" in pr for _, pr in mgr.calls)
    assert {r["status"] for r in out["findings"]} == {"unreviewed"}


def test_panel_seating_refuses_a_lone_or_repeated_model_and_takes_roles(monkeypatch):
    with pytest.raises(ValueError):
        p.panelists([G])
    with pytest.raises(ValueError):
        p.panelists([G, G])
    monkeypatch.setitem(config.ROLES, "judge", G)  # pinned: a machine's settings.toml may wire judge to M
    assert p.panelists(["judge", M]) == [G, M]


def test_the_settings_panel_overrides_the_default_and_reload_restores_it(user_toml):
    user_toml("settings", 'panel = ["gemini-3.8-flash", "deepseek-flash"]\n')
    assert p.panelists() == [M, D]
    user_toml("settings", "")  # a file that says nothing about the panel must not keep the previous one's seats
    assert config.PANEL == []  # back to AUTO: two makers' models the keys here reach (dispatch.default_panel)
