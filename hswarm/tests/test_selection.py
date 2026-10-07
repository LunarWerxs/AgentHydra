"""Published-evidence selection at the Task/plan boundary: offline, no keys but the ones a test writes."""
from __future__ import annotations

import pytest

from hswarm import config, keys, selection
from hswarm.jobs import JobManager
from hswarm.spec import Task


def _p(profile="general", **kw):
    return selection.plan(profile, **kw)["candidates"]


def test_profile_defaults_follow_tools_and_roles():
    assert selection.profile_for(None, "none") == "general"
    assert selection.profile_for(None, "all") == "code"
    assert selection.profile_for("judge") == "decision"
    assert selection.profile_for("search") == "research"
    with pytest.raises(ValueError):
        selection.profile_for("nonsense")


def test_candidates_are_free_first_then_cheapest_and_meet_every_floor():
    # Owner, 2026-09-27: prefer NVIDIA because its calls are free, but still the cheapest model that is capable.
    # NVIDIA's own trial terms allow evaluation only, so that free-first order is what an EVALUATION plan gets
    # (purpose, 2026-09-29); a production plan reaches no free route today, which the next test is about.
    cands = _p("general", purpose="evaluation")
    assert cands, "general must have at least one route"
    evaluated = [c for c in cands if not c.get("unevidenced")]
    assert [c["free"] for c in evaluated] == sorted((c["free"] for c in evaluated), reverse=True)  # every free route first
    assert any(c["free"] for c in evaluated) and not all(c["free"] for c in evaluated)
    for free in (True, False):
        costs = [c["benchmark_cost_usd"] for c in evaluated if c["free"] is free]
        assert costs == sorted(costs)
    for c in cands:
        for k, v in selection.PROFILES["general"].items():
            assert c["scores"][k] >= v


def test_a_provider_whose_terms_allow_evaluation_only_never_serves_a_production_task(monkeypatch):
    """The gate stays tested even though NO SHIPPED PROVIDER SETS THE FLAG. NVIDIA carried it from 2026-09-29 until the
    owner reversed that on 2026-09-30 ("that ruling's bullshit, change it back"), so the flag is now a capability with
    no user - and a test that asserted it through NVIDIA would have quietly become a test of nothing, or forced the
    ruling back to keep itself green. So the provider here is SYNTHETIC: flag whichever provider the repo happens to
    ship first and check that a production plan reaches none of its models, on the evaluated plan, through a sibling
    and as a health-picked backup, while an evaluation task still gets them."""
    victim = config.MODELS[next(iter(config.MODELS))]["provider"]
    monkeypatch.setitem(config.PROVIDERS[victim], "evaluation_only", True)
    barred = {m for m, e in config.MODELS.items() if e["provider"] == victim}
    assert barred, "the synthetic evaluation-only provider serves no models, so the gate is untested"
    everywhere = lambda p: True  # noqa: E731 - a live-looking plan, so siblings and backups are offered too
    for profile in selection.PROFILES:
        production = {c["model"] for c in _p(profile, usable=everywhere)}
        assert not (production & barred), f"{profile} production plan reached {production & barred}"
    assert {c["model"] for c in _p("general", purpose="evaluation", usable=everywhere)} & barred
    with pytest.raises(ValueError, match="unknown purpose"):
        _p("general", purpose="whatever")


def test_a_saturated_models_siblings_are_its_last_unevidenced_legs(monkeypatch):
    """2026-09-25: Gemini 3.8 Flash's per-model quota saturated and research had no other leg; its same-provider
    siblings, rate-limited separately, now follow every evaluated candidate, marked unevidenced. A sibling still has
    to fit the task: one whose file does not say it calls tools is no leg for a tool-using task (audit, 2026-09-26)."""
    legs = _p("research", usable=lambda p: p == "gemini")
    assert [c["model"] for c in legs] == ["rank:gemini-3-8-flash:direct", *config.MODELS["rank:gemini-3-8-flash:direct"]["siblings"]]
    assert not legs[0].get("unevidenced") and all(c["unevidenced"] for c in legs[1:])
    monkeypatch.delitem(config.MODELS["gemini-3.5-flash"], "tools")
    assert "gemini-3.5-flash" not in [c["model"] for c in _p("research", tools="read", usable=lambda p: p == "gemini")]


def test_exact_effort_is_preserved_not_approximated():
    for c in _p("general", reasoning_effort="high"):
        assert c["reasoning_effort"] == "high"
        if not c.get("unevidenced"):  # a sibling carries its evaluated model's effort; it has no evidence of its own
            assert config.MODELS[c["model"]]["default_reasoning_effort"] == "high"


def test_critpt_is_never_an_eligibility_axis():
    with pytest.raises(ValueError, match="CritPt"):
        selection.plan("general", min_scores={"critpt": 0.1})
    for c in _p("critical"):
        assert "critpt" not in c["scores"]


def test_unusable_provider_vision_context_and_cc_constraints():
    base = _p("general")
    prov = base[0]["provider"]
    assert all(c["provider"] != prov for c in _p("general", usable=lambda p: p != prov))
    assert _p("general", usable=lambda p: False) == []
    for c in _p("general", vision=True):
        assert config.MODELS[c["model"]].get("vision")
    for c in _p("general", min_context=500_000):
        assert config.MODELS[c["model"]]["ctx"] >= 500_000
    for c in _p("code", tools="all", backend="cc"):
        e = config.MODELS[c["model"]]
        assert e.get("cc_effort") and config.PROVIDERS[e["provider"]].get("anthropic_url")
    for c in _p("code", tools="all"):
        assert config.MODELS[c["model"]].get("tools")
    with pytest.raises(ValueError):
        selection.plan("routine", tools="all")


def test_exclusion_by_model_name():
    first = _p("general")[0]["model"]
    assert first not in [c["model"] for c in _p("general", exclude_models=[first])]


def test_auto_task_gets_profile_and_cheapest_candidate(tmp_path):
    t = Task(id="a", prompt="hi", cwd=str(tmp_path), tools="none")._normalised()
    assert t.profile == "general"
    assert t.model == _p("general")[0]["model"]


def test_auto_pins_a_live_route_and_a_job_on_dead_pools_is_refused_at_submit(tmp_path):
    """Jobs 20260925-184445-98ac and -184659-a701 (general, tools read): the evidence's cheapest route was OpenRouter
    with all 4,287 keys disabled. Every pending task's record named it, and nothing refused a job whose pools were
    all dead; the job sat `pending` instead."""
    providers = list(dict.fromkeys(c["provider"] for c in _p("general", tools="read")))
    assert len(providers) >= 2, providers
    live = providers[-1]  # never the cheapest route's provider
    config.SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    for p in providers:
        (config.SECRETS_DIR / config.PROVIDERS[p]["key_files"][0]).write_text(f"sk-{p}-test-0001\n", encoding="utf-8")
        if p != live:
            keys.pool_for(p).disable(f"sk-{p}-test-0001", reason="out of credit")

    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "general"})
    assert config.provider_of(task.model) == live, task.model

    keys.pool_for(live).disable(f"sk-{live}-test-0001", reason="out of credit")
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "profile": "general"})
    with pytest.raises(ValueError, match="NoCapableSwarmRoute") as refused:
        JobManager().submit([task])
    assert f"{providers[0]} all 1 keys disabled" in str(refused.value), refused.value


def test_a_cc_leg_whose_key_cannot_take_a_workers_first_turn_is_unavailable_and_refused_at_submit(tmp_path):
    """2026-10-02 and 10-03: hswarm_select { profile: code, backend: cc } offered five anthropic-direct Opus legs on a
    key whose organisation allows 10,000 input tokens a minute, and every task sent there died of a 429 in 5-37 s: a
    headless Claude Code worker's first turn alone is tens of thousands of tokens."""
    from hswarm import dispatch, input_limit

    key = "sk-ant-test-0001"
    config.SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    (config.SECRETS_DIR / config.PROVIDERS["anthropic"]["key_files"][0]).write_text(key + "\n", encoding="utf-8")
    opus = lambda plan: [c["model"] for c in plan if config.MODELS[c["model"]]["provider"] == "anthropic"  # noqa: E731
                         and config.MODELS[c["model"]].get("api_id") == "claude-opus-5-5"]
    assert opus(dispatch._plan("code", tools="read", backend="cc", min_context=0)["candidates"])

    said = "API Error: Request rejected (429) · This request would exceed your organization's rate limit of 10,000 input tokens per minute (model: {})"
    input_limit.from_error(key, "claude-opus-5-5", said.format("claude-opus-5-5"))
    plan = dispatch._plan("code", tools="read", backend="cc", min_context=0, explain=True)
    assert not opus(plan["candidates"]), plan["candidates"]
    gone = {u["model"]: u["why"] for u in plan["unavailable"]}
    assert opus([{"model": m} for m in gone]) and all("10,000 input tokens per minute" in gone[m] for m in opus([{"model": m} for m in gone]))

    input_limit.from_error(key, "claude-sonnet-5-5", said.format("claude-sonnet-5-5"))
    task = Task.from_dict({"prompt": "x", "cwd": str(tmp_path), "tools": "read", "backend": "cc", "profile": "code"})
    with pytest.raises(ValueError, match="CliMayte") as refused:
        JobManager().submit([task])
    assert "10,000 input tokens per minute" in str(refused.value), refused.value


def test_auto_role_is_respected(tmp_path):
    t = Task(id="j", prompt="hi", cwd=str(tmp_path), tools="none", role="judge")._normalised()
    assert t.profile == "decision" and t.model == _p("decision")[0]["model"]


def test_explicit_model_is_pinned_without_profile(tmp_path):
    name = _p("general")[-1]["model"]
    t = Task(id="p", prompt="hi", cwd=str(tmp_path), tools="none", model=name)._normalised()
    assert t.profile is None and t.model == config.resolve_model(name)


@pytest.mark.parametrize("field,value", [("api_id", "another/model"), ("default_reasoning_effort", "low")])
def test_overlaid_identity_cannot_inherit_published_scores(monkeypatch, field, value):
    name = _p("general")[0]["model"]
    monkeypatch.setitem(config.MODELS, name, {**config.MODELS[name], field: value})
    assert name not in [c["model"] for c in _p("general")]


def test_direct_routes_still_have_evidence():
    assert {c["provider"] for c in _p("general")} >= {"openrouter", "deepseek", "gemini"}


def test_pinned_ranked_configuration_keeps_its_effort_default(tmp_path):
    name = "rank:claude-opus-5-5"
    task = Task.from_dict({"prompt": "x", "model": name, "profile": "general", "cwd": str(tmp_path)})
    assert task.model == name and task.profile is None
    assert task.reasoning_effort is None  # the client supplies the registry's max, never legacy low


# Contract: when no tested model's provider can serve, a model its file marks `backup` on a provider that can is
# offered last, marked unevidenced, and never for a critical task. Regression: an empty plan while working keys sit
# idle (2026-09-26: every tested route down, 1,115 Cohere keys unused, other chats pinning models by hand).
def test_a_backup_serves_when_every_tested_route_is_down(user_toml):
    user_toml("cohere", "[models.command-a]\nbackup = true\n")
    legs = _p("code", tools="read", usable=lambda p: p == "cohere")
    assert [c["model"] for c in legs] == ["command-a"] and legs[0]["unevidenced"] and legs[0]["backup"]
    assert _p("critical", tools="read", usable=lambda p: p == "cohere") == []
    assert not any(c.get("backup") for c in _p("code", tools="read", usable=lambda p: p != "cohere"))


def test_a_crawling_free_model_goes_behind_every_route_that_is_not_crawling():
    # 2026-09-27: GLM 5.3 Flash on NVIDIA took 46-104 s a call while GLM 5.3 took 1-4 s. The cheapest free model must
    # not hold every call while it crawls, and comes back once it is fast. Since 2026-10-02 it goes behind the healthy
    # paid routes too (owner: a crawling model last): 6,393 NVIDIA first legs had served 308 times.
    from types import SimpleNamespace

    selection.reset_load()
    try:
        cands = _p("general", purpose="evaluation")  # the free routes are NVIDIA's, which only an evaluation reaches
        free = [c["model"] for c in cands if c.get("free") and not c.get("unevidenced")]
        paid = [c["model"] for c in cands if not c.get("free") and not c.get("unevidenced")]
        first = free[0]
        selection.note_speed(first, SimpleNamespace(status="ok", error=None, api_seconds=79.0, seconds=79.0, turns=1))
        order = [c["model"] for c in selection.rebias(cands, lambda p: 0.0)]
        assert [m for m in order if m in free][-1] == first
        assert order.index(first) > max(order.index(m) for m in paid)
        assert order[0] in free  # the free routes that are not crawling still serve first
        selection.note_speed(first, SimpleNamespace(status="ok", error=None, api_seconds=2.0, seconds=2.0, turns=1))
        assert [c["model"] for c in selection.rebias(cands, lambda p: 0.0)][0] == first
    finally:
        selection.reset_load()


def test_a_crawl_mark_reaches_every_hswarm_process_and_the_newest_reading_wins():
    # 2026-09-27: the MCP server had watched GLM 5.3 Flash crawl, and a `hswarm run` job (its own process) still sent all
    # 27 of its tasks there. The marks live in HOME/crawl.json; what another process last saw is what this one sees.
    import json
    import os
    import time
    from types import SimpleNamespace

    selection.note_speed("rank:glm-5-3-flash:nvidia", SimpleNamespace(status="error", error="SlowLeg: crawled", api_seconds=0, seconds=0, turns=1))
    selection._CRAWL.clear()
    selection._CRAWL_SEEN[0] = None  # a fresh process: nothing in memory
    assert selection.crawling("rank:glm-5-3-flash:nvidia")
    path = selection._crawl_path()
    before = path.stat()
    # Another process saw it recover, and its write lands in the same clock tick with the same size, as it can on Windows.
    recovered = json.dumps({"rank:glm-5-3-flash:nvidia": [int(time.time()) + 2, False, 0]})  # [when, crawled, last all-keys-limited]
    path.write_text(recovered.ljust(before.st_size), encoding="utf-8")
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_size == before.st_size
    assert not selection.crawling("rank:glm-5-3-flash:nvidia")


# Contract: AUTO never offers Claude Haiku 4.5 or older on any leg (evaluated, sibling, backup) and names why in
# `rejected`, while Haiku 5.5 is an ordinary candidate. Regression: the bar was the whole `claude-haiku` family, which
# would have kept Haiku 5.5 out of every plan after the owner said to offload there first (2026-10-07). Seam: the plan
# over the shipped provider files plus a user file that registers a Haiku 4.5 route as all three kinds of leg.
def test_auto_never_picks_claude_haiku_4_5_on_any_leg_and_offers_haiku_5_5(user_toml):
    """Owner, 2026-10-07: never use Haiku 4.5; Haiku 5.5 is where work should be offloaded first. Sonnet is not barred
    either: the 2026-09-24 never-Sonnet ruling was retired on 2026-10-03, because it predated Sonnet 5.5."""
    old = "rank:claude-haiku-4-5:direct"
    user_toml("anthropic", f'[models."{old}"]\napi_id = "claude-haiku-4-5-20251001"\nbenchmark_slug = "claude-haiku-4-5"\n'
                           'ctx = 200000\ntools = true\nvision = true\ncc_effort = true\nbackup = true\n\n'
                           f'[models."rank:claude-sonnet-5-5-low:direct"]\nsiblings = ["{old}"]\n')
    assert config.MODELS[old]["backup"] and old in config.MODELS["rank:claude-sonnet-5-5-low:direct"]["siblings"]
    everywhere = lambda p: True  # noqa: E731 - a live-looking plan, so siblings and backups are offered too
    for backend in ("api", "cc"):
        for profile in selection.PROFILES:
            tools = "none" if profile == "routine" else "all"
            chosen = selection.plan(profile, tools=tools, backend=backend, usable=everywhere, purpose="evaluation")
            picked = [c["model"] for c in chosen["candidates"] if selection.auto_barred(config.MODELS[c["model"]])]
            assert not picked, f"{profile} on {backend} offered {picked}"
            assert {"model": old, "filter": "family", "reason": "Claude Haiku 4.5 and older are never picked (owner, 2026-10-07)"} in chosen["rejected"]
    code = selection.plan("code", tools="all", backend="cc", usable=everywhere)
    assert code["candidates"], "barring Haiku 4.5 left a cc code task with no route at all"
    assert any("sonnet" in c["model"] for c in code["candidates"]), "Sonnet 5.5 is an ordinary AUTO candidate again"
    for barred in ({"benchmark_slug": "claude-haiku-4-5"}, {"api_id": "anthropic/claude-haiku-4-5-20251001"},
                   {"api_id": "anthropic/claude-haiku-4.5"}, {"api_id": "claude-3-5-haiku-20241022"}):
        assert selection.auto_barred(barred), barred
    for allowed in ({"benchmark_slug": "claude-sonnet-5-5-high"}, {"benchmark_slug": "claude-haiku-5-5", "api_id": "claude-haiku-5-5"}):
        assert not selection.auto_barred(allowed), allowed
    # Haiku 5.5's published point covers Humanity's Last Exam, so it clears the routine floor on both backends.
    for backend in ("api", "cc"):
        assert "rank:claude-haiku-5-5:direct" in [c["model"] for c in _p("routine", backend=backend)], backend
