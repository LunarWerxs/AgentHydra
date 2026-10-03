"""Offline: price-aware routing between paths to the same model.

Owner ask, Michael, 2026-09-17: "lets default to openrouter when off-peak hours and use deepseek when
it costs half as much" - read as meant, take whichever path is cheaper right now. Priced alone that is:

  * OFF-PEAK: DeepSeek halves its own rates ($0.0683/1M blended) and beats OpenRouter's flat leg.
  * PEAK:     OpenRouter steered to DeepInfra ($0.20/$0.60, verified against billed cost) is $0.0861
              against DeepSeek's $0.1365.

But price is not the whole rule. The benchmark the same day put the OpenRouter leg at 45/50 against
direct's 49/50 (the gap all on exact counting), ~4x slower per call, and serving 29 of 99 calls from an
fp4 host despite the steer. Owner doctrine is "cheaper only with NO regression", so that leg is a
FALLBACK: it serves only when DeepSeek has no key with credit, until a benchmark earns it
`fallback = false` in the user's own provider file. Price orders legs within a tier, never across tiers.

Comparison is on the MEASURED token mix (65.1% cache hits, 31.8% miss, 3.1% out across 7,577 api rows
in this machine's ledger), never on one rate.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import catalogue, config  # noqa: E402
from hswarm import keys as keymod  # noqa: E402

PEAK = dt.datetime(2026, 9, 17, 2, 0, tzinfo=dt.timezone.utc)      # Thursday 02:00 UTC, inside 01-04
OFF = dt.datetime(2026, 9, 17, 14, 0, tzinfo=dt.timezone.utc)      # Thursday 14:00 UTC
WEEKEND = dt.datetime(2026, 9, 19, 2, 0, tzinfo=dt.timezone.utc)   # Saturday: never peak
OR_FLASH = "deepseek-flash-or"  # the builtin OpenRouter leg, steered to DeepInfra
HF_FLASH = "deepseek-flash-hf"  # the builtin Hugging Face leg, pinned to DeepInfra


@pytest.fixture(autouse=True)
def _routing_on(monkeypatch):
    """conftest turns price routing OFF for the whole suite (a routed task left a fake client for the live
    network). This module is where routing is tested, so it turns it back on - as the process default,
    because reload() resets the flag to that default."""
    monkeypatch.setattr(config, "_PRICE_ROUTING_DEFAULT", True)
    config.reload()
    yield
    config.reload()


@pytest.fixture
def everyone_has_credit(monkeypatch):
    monkeypatch.setattr(keymod, "has_credit", lambda provider: True)


# --- the decision ------------------------------------------------------------------------------


def test_the_flag_is_not_the_routing_log_path():
    """config.ROUTING is the agent_routing_gate's routing.jsonl and predates this feature; the price
    flag is PRICE_ROUTING. Naming the new one ROUTING clobbered the path and broke `hswarm usage`."""
    assert isinstance(config.ROUTING, Path) and config.ROUTING.name == "routing.jsonl"
    assert isinstance(config.PRICE_ROUTING, bool)


def test_direct_serves_at_every_hour_while_it_has_credit(everyone_has_credit):
    """The OpenRouter leg is cheaper at peak but benchmarked worse, so it is a fallback: price never
    lifts it over a primary leg that can serve."""
    assert config.cheapest_route("deepseek-flash", OFF, usable=keymod.has_credit) == "deepseek-flash"
    assert config.cheapest_route("deepseek-flash", WEEKEND, usable=keymod.has_credit) == "deepseek-flash"
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"
    assert config.MODELS[OR_FLASH]["fallback"] is True


def test_a_promoted_leg_is_priced_against_the_primary(user_toml, everyone_has_credit):
    """`fallback = false` is the owner's switch once a benchmark says the leg has earned it: then price decides,
    and OpenRouter takes peak while DeepSeek keeps off-peak - the instruction exactly as given."""
    mine = user_toml("openrouter", f"[models.{OR_FLASH}]\nfallback = false\n")
    assert config.MODELS[OR_FLASH]["fallback"] is False
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == OR_FLASH
    assert config.cheapest_route("deepseek-flash", OFF, usable=keymod.has_credit) == "deepseek-flash"
    # and the shipped entry itself was never edited: without the user's file the fallback is back
    mine.unlink()
    config.reload()
    assert config.MODELS[OR_FLASH]["fallback"] is True


def test_the_prices_behind_the_legs(everyone_has_credit):
    # And the numbers behind it: off-peak DeepSeek is exactly half its peak; the OpenRouter leg is flat.
    off = {o["model"]: o["usd_per_1m"] for o in config.route_options("deepseek-flash", OFF)}
    peak = {o["model"]: o["usd_per_1m"] for o in config.route_options("deepseek-flash", PEAK)}
    assert off["deepseek-flash"] == pytest.approx(peak["deepseek-flash"] / 2)
    assert peak[OR_FLASH] == pytest.approx(off[OR_FLASH]) == pytest.approx(0.0861, abs=1e-4)
    assert peak[OR_FLASH] < peak["deepseek-flash"] and off["deepseek-flash"] < off[OR_FLASH]


def test_the_blend_is_the_measured_mix_not_one_rate():
    assert sum(config.REFERENCE_MIX.values()) == pytest.approx(1.0)
    p = config.price("deepseek-flash", PEAK)
    want = p["hit"] * 0.651 + p["miss"] * 0.318 + p["out"] * 0.031
    assert config.blended_price("deepseek-flash", PEAK) == pytest.approx(want)
    # Output-rate-only comparison would be a tie here; the blend is what makes the off-peak call.
    assert config.blended_price("deepseek-flash", OFF) < config.blended_price(OR_FLASH, OFF)


def test_a_path_with_no_credit_loses_however_cheap_it_is(monkeypatch):
    """The half that matters on a day when twelve of sixteen DeepSeek keys are out of credit: the
    cheapest path is no good if nothing can pay for it."""
    monkeypatch.setattr(keymod, "has_credit", lambda provider: provider != "deepseek")
    assert config.cheapest_route("deepseek-flash", OFF, usable=keymod.has_credit) == OR_FLASH
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == OR_FLASH
    # two fallbacks at the same measured price: list order decides, and the credit already paid for goes first
    assert config.route_plan("deepseek-flash", PEAK, usable=keymod.has_credit) == [OR_FLASH, HF_FLASH]
    assert config.route_plan("deepseek-flash", PEAK, usable=keymod.has_credit, backend="cc") == [HF_FLASH, OR_FLASH]
    monkeypatch.setattr(keymod, "has_credit", lambda provider: provider == "openrouter")
    assert config.route_plan("deepseek-flash", PEAK, usable=keymod.has_credit) == [OR_FLASH]
    # And when NOTHING has credit, routing hands back the model as ASKED FOR rather than making the call
    # impossible - so the NoUsableKey that follows names the model the caller chose, not a path they never
    # mentioned. It returned the cheapest option here until a review caught it, 2026-09-17.
    monkeypatch.setattr(keymod, "has_credit", lambda provider: False)
    assert config.cheapest_route("deepseek-flash", OFF, usable=keymod.has_credit) == "deepseek-flash"
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"


def test_an_unpriced_path_is_never_chosen_over_a_priced_one(tmp_path, monkeypatch, user_toml, everyone_has_credit):
    monkeypatch.setattr(config, "CATALOGUE_FILE", tmp_path / "cat.json")
    config.CATALOGUE_FILE.write_text(json.dumps({"models": {
        "or:mystery/model": {"provider": "openrouter", "api_id": "mystery/model"},  # no price on record
    }}), encoding="utf-8")
    user_toml("deepseek", '[models.deepseek-flash]\nroute = ["or:mystery/model", "deepseek-flash"]\n')
    # Unpriced sorts last even though it is listed first: it cannot be compared, so it never wins.
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"
    assert config.route_options("deepseek-flash", PEAK)[-1]["usd_per_1m"] is None


# --- the switches ------------------------------------------------------------------------------


def test_routing_can_be_turned_off(monkeypatch, everyone_has_credit):
    monkeypatch.setattr(config, "PRICE_ROUTING", False)
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"
    assert config.cheapest_route("flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"  # alias still resolves


def test_user_files_can_rewrite_the_routes_and_disable_routing(user_toml, everyone_has_credit):
    user_toml("openrouter", '[models."or:x/y"]\napi_id = "x/y"\nprice = {hit = 0.0, miss = 0.01, out = 0.02}\n')
    user_toml("deepseek", '[models.deepseek-flash]\nroute = ["or:x/y", "deepseek-flash"]\n')
    assert config.cheapest_route("deepseek-flash", OFF, usable=keymod.has_credit) == "or:x/y"  # far cheaper, and a primary
    user_toml("settings", "routing = false\n")
    assert config.PRICE_ROUTING is False
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "deepseek-flash"
    # And it RESETS: a file that says nothing about routing must not leave the previous one's `routing = false`
    # standing. It did until 2026-09-17 - PRICE_ROUTING was set by the file and never restored by reload(), so
    # one file with the switch off turned routing off for every later reload in the process.
    user_toml("settings", "")
    assert config.PRICE_ROUTING is True
    assert config.cheapest_route("deepseek-flash", PEAK, usable=keymod.has_credit) == "or:x/y"  # the cheap route serves again


def test_a_model_with_no_route_is_left_alone(everyone_has_credit):
    assert config.routes_for("deepseek-v4-pro") == ("deepseek-v4-pro",)
    assert config.cheapest_route("deepseek-v4-pro", PEAK, usable=keymod.has_credit) == "deepseek-v4-pro"
    assert config.cheapest_route(OR_FLASH, PEAK, usable=keymod.has_credit) == OR_FLASH


def test_a_key_added_while_the_server_is_running_is_picked_up(tmp_path, monkeypatch):
    """The MCP server is one process for a whole Claude session. A pool cache that read the key list
    once meant a provider with no key file at startup was cached as unusable FOREVER - so dropping in
    .secrets/openrouter_api_keys mid-session did nothing until a restart. Found in review 2026-09-17,
    the same day that file was first created mid-session."""
    keyfile = tmp_path / "openrouter_api_keys"
    monkeypatch.setattr(config, "SECRETS_DIR", tmp_path)
    monkeypatch.setattr(keymod, "_POOLS", {})
    monkeypatch.delenv("OPENROUTER_API_KEYS", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert keymod.pool_for("openrouter") is None and keymod.has_credit("openrouter") is False
    keyfile.write_text("sk-or-v1-added-later\n", encoding="utf-8")
    # Still cached as absent inside the recheck window; past it, the new key is live without a restart.
    monkeypatch.setattr(keymod, "POOL_RECHECK_S", 0.0)
    pool = keymod.pool_for("openrouter")
    assert pool is not None and len(pool) == 1 and keymod.has_credit("openrouter") is True
    # A key REMOVED is picked up the same way, and an unchanged list keeps the very same pool object,
    # so the round-robin cursor is not reset on every lookup.
    assert keymod.pool_for("openrouter") is pool
    keyfile.write_text("sk-or-v1-added-later\nsk-or-v1-second\n", encoding="utf-8")
    assert len(keymod.pool_for("openrouter")) == 2




# --- what the operator sees ----------------------------------------------------------------------


def test_the_routes_view_says_which_path_serves_and_why(monkeypatch):
    monkeypatch.setattr(keymod, "has_credit", lambda provider: True)
    monkeypatch.setattr(config, "is_peak", lambda when=None: True)
    v = catalogue.routes_view()
    row = next(r for r in v["routes"] if r["model"] == "deepseek-flash")
    assert v["enabled"] and v["rate_now"] == "peak"
    assert row["serves"] == "deepseek-flash" and row["provider"] == "deepseek"
    assert "FALLBACK" in row["why"] and "fallback = false" in row["why"]  # says why the cheaper leg is not taken
    assert all(o["has_credit"] for o in row["options"])
    monkeypatch.setattr(config, "is_peak", lambda when=None: False)
    row = next(r for r in catalogue.routes_view()["routes"] if r["model"] == "deepseek-flash")
    assert row["serves"] == "deepseek-flash" and row["provider"] == "deepseek"
    # A path that cannot pay is named as the reason, not silently skipped.
    monkeypatch.setattr(keymod, "has_credit", lambda provider: provider != "deepseek")
    row = next(r for r in catalogue.routes_view()["routes"] if r["model"] == "deepseek-flash")
    assert row["serves"] == OR_FLASH and row["why"].startswith("fallback: no primary leg")


# --- the OpenRouter leg itself -----------------------------------------------------------------


def test_the_openrouter_leg_steers_to_one_host_and_sends_it():
    """OpenRouter serves this model from ~20 hosts, fp4 among them, and its default picks the cheapest.
    The leg steers to DeepInfra with `order` (never `only`: eligibility is per KEY, and a strict pin
    404'd on two of three real keys) and the steer must actually reach the request body."""
    import asyncio

    import httpx

    from hswarm.client import ChatClient

    leg = config.MODELS[OR_FLASH]
    assert leg["provider"] == "openrouter" and leg["api_id"] == "deepseek/deepseek-v4.1-flash"
    assert leg["extra"]["provider"] == {"order": ["deepinfra"], "allow_fallbacks": True}
    assert "only" not in leg["extra"]["provider"]
    sent = {}

    def handler(req: httpx.Request):
        sent["body"] = json.loads(req.content)
        return httpx.Response(200, json={"provider": "DeepInfra", "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 33, "completion_tokens": 8, "cost": 1.14e-05}})

    c = ChatClient(api_keys=["sk-or-v1-test"], provider="openrouter")
    c._http = httpx.AsyncClient(base_url="https://or.test", transport=httpx.MockTransport(handler))
    r = asyncio.run(c.chat([{"role": "user", "content": "x"}], model=OR_FLASH))
    assert sent["body"]["model"] == "deepseek/deepseek-v4.1-flash"
    assert sent["body"]["provider"] == {"order": ["deepinfra"], "allow_fallbacks": True}
    assert r.raw["provider"] == "DeepInfra" and r.cost_usd == 1.14e-05


def test_a_provider_that_does_not_take_the_field_never_sees_it():
    """`extra` is filtered by the provider's allowed options, like every other non-standard field."""
    import asyncio

    import httpx

    from hswarm.client import ChatClient

    config.MODELS["deepseek-flash"]["extra"] = {"provider": {"order": ["x"]}}
    try:
        sent = {}

        def handler(req: httpx.Request):
            sent["body"] = json.loads(req.content)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {}})

        c = ChatClient(api_keys=["sk-d"], provider="deepseek")
        c._http = httpx.AsyncClient(base_url="https://ds.test", transport=httpx.MockTransport(handler))
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash"))
        assert "provider" not in sent["body"]
    finally:
        config.MODELS["deepseek-flash"].pop("extra", None)


def test_a_result_records_who_served_it_and_the_api_time():
    """An accuracy number for an OpenRouter model means nothing without the machines that produced it."""
    from hswarm.agent import _note_upstream
    from hswarm.spec import Result
    from hswarm.usage import ChatResult, Usage

    res = Result(id="t")
    for who, secs in (("DeepInfra", 1.5), ("DeepInfra", 0.5), ("Reka", 1.0)):
        _note_upstream(res, ChatResult(message={}, finish_reason="stop", usage=Usage(), model="m", seconds=secs,
                                       cost_usd=None, peak=True, raw={"provider": who}))
    assert res.upstream == ["DeepInfra", "Reka"] and res.api_seconds == pytest.approx(3.0)
    direct = Result(id="d")
    _note_upstream(direct, ChatResult(message={}, finish_reason="stop", usage=Usage(), model="m", seconds=2.0, cost_usd=0.0, peak=True, raw={}))
    assert direct.upstream == [] and direct.api_seconds == 2.0


def test_a_host_pin_in_the_model_id_is_strict():
    """`or:<id>#<host>` is how the bench measures ONE host: OpenRouter bounced 125 of 150 multi-turn tasks
    between hosts, so a per-host accuracy number needs a pin with no fallback."""
    n = config.resolve_model("or:deepseek/deepseek-v4.1-flash#deepinfra")
    assert config.api_model_id(n) == "deepseek/deepseek-v4.1-flash"
    assert config.MODELS[n]["extra"] == {"provider": {"only": ["deepinfra"], "allow_fallbacks": False}}
    assert config.price(n) is None  # a host's rate is not the model page's; the call reports what it billed
    plain = config.resolve_model("or:deepseek/deepseek-v4.1-flash")
    assert "extra" not in config.MODELS[plain]
    with pytest.raises(ValueError):
        config.resolve_model("or:#deepinfra")


def test_the_hugging_face_leg_is_a_pinned_fallback_at_its_measured_price():
    leg = config.MODELS[HF_FLASH]
    assert leg["provider"] == "huggingface" and leg["fallback"] is True
    assert leg["api_id"] == "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra"  # the host pin IS the id suffix
    # fitted from 90 billed calls with zero error, and equal to the OpenRouter leg's DeepInfra price
    assert leg["price"] == {"hit": 0.006, "miss": 0.20, "out": 0.60} == config.MODELS[OR_FLASH]["price"]
    assert config.routes_for("deepseek-flash") == ("deepseek-flash", OR_FLASH, HF_FLASH)


# --- who backs up whom, and with whose money (2026-09-17, after "I'll never top up any of the keys") -------


def test_the_already_paid_credit_goes_first_for_api_and_the_pinned_host_first_for_cc(everyone_has_credit):
    """The two fallbacks bill the same rate and benchmarked within noise, so the tie is broken twice over:
    api work spends OpenRouter's prepaid credit first, and cc work takes Hugging Face first because Claude
    Code cannot send OpenRouter's `provider` steer and would land on its default host mix."""
    assert config.route_plan("deepseek-flash") == ["deepseek-flash", OR_FLASH, HF_FLASH]
    assert config.route_plan("deepseek-flash", backend="cc") == ["deepseek-flash", HF_FLASH, OR_FLASH]
    assert config.routes_for("deepseek-flash", "cc")[1] == HF_FLASH


def test_a_hand_written_route_wins_for_both_backends_unless_route_cc_says_otherwise(user_toml, everyone_has_credit):
    mine = user_toml("deepseek", f'[models.deepseek-flash]\nroute = ["deepseek-flash", "{HF_FLASH}"]\n')
    assert config.route_plan("deepseek-flash") == ["deepseek-flash", HF_FLASH]
    assert config.route_plan("deepseek-flash", backend="cc") == ["deepseek-flash", HF_FLASH]  # not the builtin cc order
    user_toml("deepseek", f'[models.deepseek-flash]\nroute = ["deepseek-flash", "{HF_FLASH}"]\nroute_cc = ["{HF_FLASH}", "deepseek-flash"]\n')
    assert config.routes_for("deepseek-flash", "cc") == (HF_FLASH, "deepseek-flash")  # the table took the override
    assert config.route_plan("deepseek-flash", backend="cc") == ["deepseek-flash", HF_FLASH]  # tiers still order it
    mine.unlink()
    config.reload()
    assert config.route_plan("deepseek-flash", backend="cc") == ["deepseek-flash", HF_FLASH, OR_FLASH]  # builtins restored
