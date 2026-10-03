"""AUTO: the default model is chosen by whether the task uses TOOLS (wired 2026-09-20).

The benchmark that decided this is docs/BENCH-2026-09-20-providers.md: gpt-oss-120b is the best
tool-FREE reasoner (51/51) and the worst tool-caller (it emits harmony-format tool calls this backend
400s on), while gemini-3.8-flash is the best agent (24/24). One default for both would be wrong either
way, so AUTO branches on tools. These tests pin that contract, and the failover triggers that make the
free-tier-first chains actually down-route instead of dead-ending.
"""
import pytest

from hswarm import config
from hswarm.spec import Task


@pytest.mark.parametrize("tools,uses_tools", [
    ("none", False), ("", False), (None, False), ([], False),
    ("read", True), ("edit", True), ("all", True), (["read_file"], True),
])
def test_auto_picks_by_whether_the_task_has_tools(tools, uses_tools):
    """A task with tools never gets a model that cannot call them; a tool-free one gets the general profile's pick."""
    chosen = config.default_model_for(tools)
    if uses_tools:
        assert config.MODELS[chosen]["tools"], chosen
    else:
        assert chosen == config.default_model_for("none")


def test_every_pick_outside_a_batch_lands_on_a_provider_this_machine_has_a_key_for(user_toml):
    """Roles, the default panel and a bare `auto` pick from the benchmark plan over the keys this machine holds.
    Before 2026-09-26 they took the evidence's cheapest alone: a machine with only a Groq key had its judge,
    doubt and panel pinned to OpenRouter and DeepSeek models it could not call."""
    from hswarm import panel

    user_toml("groq", 'keys = ["gsk-test-only-groq-key-0123456789"]\n')
    # every role but vision: that one needs a model with eyes, and Groq serves none
    picks = [config.resolve_role(r) for r in config.ROLES if r != "vision"] + panel.panelists() + [
        config.resolve_model(config.AUTO), config.default_model_for("none"), config.default_model_for("read")]
    assert {config.provider_of(m) for m in picks} == {"groq"}, picks


def test_cc_selects_only_verified_effort_and_anthropic_endpoints():
    for tools in ("read", "none"):
        chosen = config.default_model_for(tools, "cc")
        assert config.PROVIDERS[config.provider_of(chosen)].get("anthropic_url")
        assert config.MODELS[chosen]["cc_effort"]


def test_a_task_resolves_auto_by_its_tools(tmp_path):
    def mk(**kw):
        return Task.from_dict({"prompt": "x", "cwd": str(tmp_path), **kw}, {}, 0)

    assert mk(tools="none").model == config.default_model_for("none")
    assert mk(tools="read").model == config.default_model_for("read")
    # an explicitly named model or role always wins over AUTO
    assert mk(tools="read", model="groq-gpt-oss-20b").model == "groq-gpt-oss-20b"
    assert mk(tools="none", role="judge").model == config.resolve_role("judge")


def test_resolve_model_auto_falls_back_to_the_tool_capable_default():
    """AUTO with no tools context must pick the model that can do BOTH kinds of work. gpt-oss cannot:
    it 400s on tool calls, and a 400 never fails over."""
    assert config.resolve_model(config.AUTO) == config.default_model_for("read")
    assert config.MODELS[config.resolve_model(config.AUTO)]["tools"]


def test_the_tool_free_default_is_never_put_in_a_tool_using_route():
    """gpt-oss 400s on tool calls and a 400 is a task-level failure that never fails over, so a
    tool-using chain through it would dead-end instead of down-routing."""
    from hswarm.selection import plan
    for candidate in plan("code", tools="read")["candidates"]:
        assert candidate["benchmark_slug"] != "gpt-oss-120b"
        assert config.MODELS[candidate["model"]]["tools"]


@pytest.fixture
def routing_on(monkeypatch):
    """conftest turns price routing OFF for the suite (it would otherwise make live calls); the two
    tests below are ABOUT routing, so they turn it back on, the same way test_routing.py does."""
    monkeypatch.setattr(config, "_PRICE_ROUTING_DEFAULT", True)
    monkeypatch.setattr(config, "PRICE_ROUTING", True)


def test_profile_chains_are_cost_ordered_and_keep_stronger_swarm_models(routing_on):
    from hswarm.selection import plan
    for profile in ("general", "code", "decision"):
        candidates = plan(profile, usable=lambda p: True)["candidates"]
        assert candidates
        evaluated = [c for c in candidates if not c.get("unevidenced")]
        # free routes (free_calls) first, then paid; each group cheapest first
        assert [c["free"] for c in evaluated] == sorted((c["free"] for c in evaluated), reverse=True)
        for free in (True, False):
            costs = [c["benchmark_cost_usd"] for c in evaluated if c["free"] is free]
            assert costs == sorted(costs)
        # unevidenced siblings (a model's `siblings`) are the last legs, after every evaluated candidate
        flags = [bool(c.get("unevidenced")) for c in candidates]
        assert flags == sorted(flags)
        assert any(c["benchmark_slug"] == "claude-opus-5-5" for c in candidates)


def test_exhausted_provider_is_removed_without_lowering_task_requirements(routing_on):
    from hswarm.selection import plan
    candidates = plan("general", usable=lambda p: p != "openrouter")["candidates"]
    assert candidates and all(c["provider"] != "openrouter" for c in candidates)
    assert any(c["provider"] == "deepseek" for c in candidates)
    # every TESTED candidate keeps the floor; untested last resorts (siblings, backups) follow them, marked unevidenced
    assert all(c["scores"]["humanitys-last-exam"] >= .30 for c in candidates if not c.get("unevidenced"))


@pytest.mark.parametrize("body,is_key_problem", [
    ('{"error":{"code":400,"message":"Please pass a valid API key."}}', True),
    ('{"error":{"message":"API key not valid. Please pass a valid API key."}}', True),
    ('{"error":{"message":"missing API key"}}', True),
    # NOT a key problem: gpt-oss emits these and they must stay task-level failures, or a real bad
    # request would quietly rest every healthy key in the pool.
    ('{"error":{"message":"Tool call validation failed: attempted to call tool \'commentary\'"}}', False),
    ('{"error":{"message":"Failed to parse tool call arguments as JSON"}}', False),
    ('{"error":{"message":"Invalid request: max_tokens too large"}}', False),
])
def test_a_key_shaped_400_is_told_apart_from_a_bad_request(body, is_key_problem):
    """Gemini reports an unusable key as 400, not 401 (measured 2026-09-20: a 40-task swarm lost 26
    tasks while the pool still read "72 ready, 0 disabled"). Only the key-shaped ones may rest a key."""
    from hswarm.client import _KEY_SHAPED_400
    assert bool(_KEY_SHAPED_400.search(body)) is is_key_problem


@pytest.mark.parametrize("body,resample", [
    ('{"code":"tool_use_failed","message":"attempted to call tool \'commentary\'"}', True),
    ('{"code":"output_parse_failed"}', True),
    ('{"message":"Failed to parse tool call arguments as JSON"}', True),
    ('{"message":"max_tokens is too large"}', False),     # OUR request was wrong: fail now
    ('{"message":"Please pass a valid API key."}', False),  # a key problem, handled elsewhere
])
def test_a_bad_model_sample_is_resampled_not_failed(body, resample):
    """gpt-oss writes harmony channels and sometimes malformed tool-call JSON, which the provider rejects
    with a 400. That is a bad SAMPLE, not a bad request, so it is re-rolled a bounded number of times."""
    from hswarm.client import _KEY_SHAPED_400, _MODEL_OUTPUT_400
    assert bool(_MODEL_OUTPUT_400.search(body)) is resample
    # the two 400 families must never overlap, or a bad sample would rest a healthy key
    assert not (_MODEL_OUTPUT_400.search(body) and _KEY_SHAPED_400.search(body))


@pytest.mark.parametrize("body,is_out_of_credit", [
    ('{"error":{"code":"1113","message":"Insufficient balance or no resource pack"}}', True),
    ('{"message":"balance is insufficient"}', True),
    ('{"message":"Rate limit exceeded, please retry"}', False),      # a real 429: rest, do not disable
    ('{"message":"Quota exceeded for requests per minute"}', False),
])
def test_an_out_of_credit_429_is_told_apart_from_a_rate_limit(body, is_out_of_credit):
    """Zhipu reports an unfunded key as 429 "Insufficient balance", which is permanent until someone
    pays. A plain 429 only RESTS a key, so the pool re-tried dead keys forever (measured 2026-09-20:
    47 of 50 sampled zhipu keys unfunded). These go to the disabled slot like a 402; a genuine
    rate-limit 429 must NOT, or a busy pool would disable itself."""
    from hswarm.client import _OUT_OF_CREDIT_429
    assert bool(_OUT_OF_CREDIT_429.search(body)) is is_out_of_credit
