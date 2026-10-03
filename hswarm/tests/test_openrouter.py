"""Offline: OpenRouter as a provider, and the DISABLED SLOT a key goes to when it runs out.

Both shipped together on 2026-09-17 (owner ask, Michael: wire OpenRouter in, and "when any key runs out of
DeepSeek or OpenRouter, have it go to, like, a disabled slot so it's not constantly retried").

The shapes asserted here were MEASURED against the live endpoints that day, not guessed:
  * /key     -> {"data": {"limit_remaining": null, "usage": ..., "free_model_daily_requests": {"remaining": 1000}}}
  * /credits -> {"data": {"total_credits": 174.4, "total_usage": 174.59}}
  * a chat call with usage.include reports {"usage": {"cost": 6.24e-06, ...}} - what it ACTUALLY charged.
  * ten of eighteen real keys read a NEGATIVE credit figure and every one of them served a paid model at
    HTTP 200, which is why OpenRouter's number is reported and never acted on.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import catalogue, config  # noqa: E402
from hswarm import keys as keymod  # noqa: E402
from hswarm.client import ChatClient, KeyPool, NoUsableKey, balance_reading, openrouter_free_left  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402

OR = ["sk-or-v1-aaa", "sk-or-v1-bbb", "sk-or-v1-ccc"]


@pytest.fixture(autouse=True)
def _isolated_key_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys-state.json")


def _pool(keys=OR, provider="openrouter") -> KeyPool:
    return KeyPool(list(keys), provider)


def _client(handler, keys=OR, provider="openrouter") -> ChatClient:
    c = ChatClient(api_keys=list(keys), provider=provider)
    c._http = httpx.AsyncClient(base_url="https://or.test", transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def _chat_ok(cost: float | None = 6.24e-06) -> httpx.Response:
    usage = {"prompt_tokens": 12, "completion_tokens": 3, "prompt_tokens_details": {"cached_tokens": 2}}
    if cost is not None:
        usage["cost"] = cost
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}], "usage": usage})


# --- the provider ---------------------------------------------------------------------------------


def test_openrouter_is_registered_with_its_keys_and_url():
    p = config.PROVIDERS["openrouter"]
    assert p["base_url"] == "https://openrouter.ai/api/v1" and p["balance_path"] == "/key" and p["credits_path"] == "/credits"
    assert p["balance_authority"] == "status"  # its number is NOT its word on whether it will serve a key
    assert "openrouter_api_keys" in p["key_files"] and "OPENROUTER_API_KEYS" in p["key_env"]
    names = [n for n, _ in config.key_sources("openrouter")]
    # HSwarm keeps key files with the user's state (config.SECRETS_DIR), never in the clone's .secrets/.
    assert names[0] == "env:OPENROUTER_API_KEYS" and names[-1] == "<home>/secrets/openrouter_api_keys"


def test_any_openrouter_model_is_addressable_without_a_code_change():
    """`or:<id>` registers on the spot: ~440 models and a moving catalogue must not need an edit here."""
    assert config.resolve_model("or:deepseek/deepseek-chat-v3.1") == "or:deepseek/deepseek-chat-v3.1"
    assert config.provider_of("or:deepseek/deepseek-chat-v3.1") == "openrouter"
    # The registry name carries the prefix; the id that goes over the wire does not.
    assert config.api_model_id("or:deepseek/deepseek-chat-v3.1") == "deepseek/deepseek-chat-v3.1"
    assert config.api_model_id("deepseek-flash") == "deepseek-flash"
    assert config.cost_usd("or:deepseek/deepseek-chat-v3.1", 1_000_000, 1_000_000, 1_000_000) is None  # unpriced: '-', never 0
    assert config.resolve_model("openrouter:z-ai/glm-5.3-flash") == "openrouter:z-ai/glm-5.3-flash"
    with pytest.raises(ValueError, match="or:<its id>"):
        config.resolve_model("no-such-model")
    with pytest.raises(ValueError):
        config.resolve_model("or:")  # a bare prefix is not a model


def test_the_request_carries_the_wire_id_the_attribution_headers_and_usage_include():
    sent: dict = {}

    def handler(req: httpx.Request):
        sent["body"] = json.loads(req.content)
        sent["headers"] = dict(req.headers)
        return _chat_ok()

    c = _client(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert sent["body"]["model"] == "deepseek/deepseek-chat-v3.1"  # not the `or:` registry name
    assert sent["body"]["usage"] == {"include": True}  # so the provider reports what it charged
    assert sent["headers"]["http-referer"] == "https://github.com/LunarWerxs/AgentHydra" and sent["headers"]["x-title"] == "HydraSwarm"
    assert sent["headers"]["authorization"] == "Bearer " + OR[0]


def test_thinking_off_reaches_openrouter_as_reasoning_disabled():
    # A schema ask sends thinking=False (agent.ask). OpenRouter ignores DeepSeek's `thinking` and reads
    # `reasoning_effort` as "reason", so deepseek-flash-or spent the whole output cap reasoning and answered nothing
    # (Dredd's drafter, 2026-09-24: out 4000, reasoning 4000, finish "length", eight calls running).
    sent: dict = {}

    def handler(req: httpx.Request):
        sent["body"] = json.loads(req.content)
        return _chat_ok()

    c = _client(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash-or", thinking=False, reasoning_effort="low"))
    assert sent["body"]["reasoning"] == {"enabled": False}
    assert "reasoning_effort" not in sent["body"] and "thinking" not in sent["body"]
    # Thinking left to the default (or asked for) keeps the effort the caller gave.
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash-or", reasoning_effort="low"))
    assert sent["body"]["reasoning_effort"] == "low" and "reasoning" not in sent["body"]


def test_an_endpoint_that_must_reason_is_resent_without_the_switch_and_remembered():
    # glm-5-3-flash on OpenRouter refuses `reasoning: {enabled: false}` with a 400, and every schema'd lens
    # of the Connections deep-codebase-audit failed on it (2026-09-25).
    from hswarm import client as clientmod
    bodies: list = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        bodies.append(body)
        if (body.get("reasoning") or {}).get("enabled") is False:
            return httpx.Response(400, json={"error": {"message": "Reasoning is mandatory for this endpoint and cannot be disabled."}})
        return _chat_ok()

    clientmod._REASONING_MANDATORY.discard("deepseek-flash-or")
    try:
        c = _client(handler)
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash-or", thinking=False))
        assert [("reasoning" in b) for b in bodies] == [True, False]  # refused once, then re-sent without it
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash-or", thinking=False))
        assert "reasoning" not in bodies[-1] and len(bodies) == 3  # remembered: no second refusal
    finally:
        clientmod._REASONING_MANDATORY.discard("deepseek-flash-or")


def test_deepseek_never_sees_openrouter_only_fields():
    sent: dict = {}

    def handler(req: httpx.Request):
        sent["body"] = json.loads(req.content)
        sent["headers"] = dict(req.headers)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

    c = _client(handler, keys=["sk-d1"], provider="deepseek")
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False))
    assert "usage" not in sent["body"] and sent["body"]["thinking"] == {"type": "disabled"}
    assert "http-referer" not in sent["headers"]


def test_the_provider_reported_cost_wins_over_our_price_table():
    """OpenRouter routes one model id to several upstreams at different rates, so its own number is the
    only honest one. DeepSeek reports none, and there the price table still stands."""
    c = _client(lambda req: _chat_ok(cost=0.0001234))
    r = asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert r.cost_usd == 0.0001234 and r.model == "or:deepseek/deepseek-chat-v3.1"
    # A free model genuinely costs zero, which is a measurement, not a missing one.
    c2 = _client(lambda req: _chat_ok(cost=0))
    assert asyncio.run(c2.chat([{"role": "user", "content": "x"}], model="or:x/y:free")).cost_usd == 0.0
    # No reported cost and no price on record: '-', never zero.
    c3 = _client(lambda req: _chat_ok(cost=None))
    assert asyncio.run(c3.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1")).cost_usd is None


# --- reading OpenRouter's credit picture ------------------------------------------------------------


def test_openrouter_balance_shapes():
    """A key with a spending limit reports it; a key without one is read from the account's /credits pair."""
    assert balance_reading({"data": {"limit_remaining": 4.25}}, "openrouter") == (4.25, None)
    assert balance_reading({"data": {"limit_remaining": None, "total_credits": 174.4, "total_usage": 174.594480637}}, "openrouter")[0] == pytest.approx(-0.19448, abs=1e-4)
    assert balance_reading({"data": {"limit_remaining": None}}, "openrouter") == (None, None)
    assert balance_reading("junk", "openrouter") == (None, None)
    # The flag is always None: OpenRouter sends no word on whether it will serve a key.
    assert balance_reading({"data": {"limit_remaining": 0}}, "openrouter")[1] is None
    assert openrouter_free_left({"data": {"free_model_daily_requests": {"used": 23, "limit": 50, "remaining": 27}}}) == 27
    assert openrouter_free_left({"data": {}}) is None
    # DeepSeek's shape still reads as DeepSeek's, whichever way it is asked for.
    ds = {"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": "39.53"}]}
    assert balance_reading(ds) == (39.53, True) and balance_reading(ds, "deepseek") == (39.53, True)


def test_a_negative_openrouter_reading_is_reported_and_never_acted_on():
    """Measured 2026-09-17: ten real keys read negative from /credits and all ten served a paid model at 200.
    Acting on that number would have disabled ten live keys, so only a 402 is authority here."""
    p = _pool()
    assert p.balance_authority == "status"
    assert p.note_balance(OR[0], -0.19, None, free_left=1000) is True  # usable: the number does not disable
    st = p.status()[0]
    assert not st["disabled"] and st["balance_usd"] == -0.19 and st["free_left"] == 1000
    assert p.pick() == OR[0]
    # DeepSeek's pool is the opposite, and stays that way: its number IS its word.
    d = _pool(["sk-d1", "sk-d2"], provider="deepseek")
    assert d.balance_authority == "reading"
    assert d.note_balance("sk-d1", -0.19, None) is False and d.status()[0]["disabled"]


def test_a_402_disables_an_openrouter_key_and_the_next_one_serves():
    seen = []

    def handler(req: httpx.Request):
        key = req.headers["Authorization"].removeprefix("Bearer ")
        seen.append(key)
        if key == OR[0]:
            return httpx.Response(402, json={"error": {"message": "Insufficient credits", "code": 402}})
        return _chat_ok()

    c = _client(handler)
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert seen == [OR[0], OR[1]]
    st = c.pool.status()[0]
    assert st["disabled"] and st["disabled_reason"] == "out of credit (402)" and st["resting_s"] == 0
    for _ in range(6):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert OR[0] not in seen[2:]  # never retried with a real request again


# --- the disabled slot ------------------------------------------------------------------------------


def test_disabling_is_sticky_and_has_no_timer():
    """The whole point of the slot: a spent key is not re-tried on any schedule, not even a six-hour one."""
    p = _pool()
    p.broke(OR[0])
    st = p.status()[0]
    assert st["disabled"] and st["state"] == "disabled" and st["resting_s"] == 0
    assert p.pick() in (OR[1], OR[2]) and p.available() == 2 and p.disabled() == [config.fingerprint(OR[0])]
    # Re-reading the shared file in another process sees the same thing, with no clock involved.
    assert KeyPool(list(OR), "openrouter").status()[0]["disabled"]


def test_when_every_key_is_disabled_the_pool_fails_loudly_instead_of_hammering():
    p = _pool()
    for k in OR:
        p.broke(k)
    with pytest.raises(NoUsableKey, match="every one of the 3 openrouter keys is disabled"):
        p.pick()
    assert "hswarm keys enable" in str(pytest.raises(NoUsableKey, p.pick).value)
    # A free GET must still be possible: probing is how a topped-up key gets back out of the slot.
    assert p.any_key() in OR


def test_a_key_disabled_for_a_402_still_serves_free_models():
    """Ten of the eighteen real keys were exactly this on 2026-09-17: out of paid credit, free allowance left.
    Disabling them outright would have thrown away 50-1000 free requests a day each."""
    p = _pool()
    p.note_balance(OR[0], -0.2, None, free_left=500)  # the last probe saw free-tier allowance
    p.broke(OR[0], status=402)
    st = p.status()[0]
    assert st["disabled"] and st["free_only"] and st["state"] == "disabled (:free only)"
    assert p.pick(free=True) == OR[0] and p.available(free=True) == 3
    assert p.pick(free=False) in (OR[1], OR[2]) and p.available(free=False) == 2
    # A key with no free allowance left is disabled for everything.
    p.note_balance(OR[1], -0.2, None, free_left=0)
    p.broke(OR[1], status=402)
    assert not p.status()[1]["free_only"] and p.pick(free=True) in (OR[0], OR[2])


def test_a_free_model_call_routes_to_a_free_only_key():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.headers["Authorization"].removeprefix("Bearer "))
        return _chat_ok(cost=0)

    c = _client(handler, keys=[OR[0]])
    c.pool.note_balance(OR[0], -0.2, None, free_left=50)
    c.pool.broke(OR[0], status=402)
    with pytest.raises(NoUsableKey):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert seen == []  # the paid call never went out
    r = asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:nex-agi/nex-n2.5-mini:free"))
    assert seen == [OR[0]] and r.cost_usd == 0.0
    # And that 200 must NOT let the key back into PAID rotation: it proves the free tier works and says
    # nothing about credit. Caught in review before it shipped - _post recovered on every 200, so every
    # free call silently undid its own disable and the next paid request 402'd again.
    st = c.pool.status()[0]
    assert st["disabled"] and st["free_only"] and st["disabled_reason"] == "out of credit (402)"
    with pytest.raises(NoUsableKey):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert seen == [OR[0]]  # still only the one free call ever went out


def test_a_paid_200_still_heals_a_key_that_was_merely_resting():
    """The other half: recover() must keep working for every ordinary 200, or a 429'd key never comes back."""
    c = _client(lambda req: _chat_ok(), keys=[OR[0]])
    c.pool.rest(OR[0], 60, status=429)
    assert c.pool.status()[0]["resting_s"] > 0
    asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    assert c.pool.status()[0]["resting_s"] == 0 and not c.pool.status()[0]["disabled"]


def test_a_revoked_key_is_disabled_once_it_has_struck_out():
    """A 401 can be one bad minute, so it rests on the doubling ladder first - but a key still revoked after
    three strikes is not coming back on its own, and re-trying it forever is what the slot exists to stop."""
    p = _pool()
    p.rest(OR[0], 0, status=401, dead=True)
    assert not p.status()[0]["disabled"] and 590 < p.status()[0]["resting_s"] <= 600
    p.rest(OR[0], 0, status=401, dead=True)
    assert not p.status()[0]["disabled"]
    p.rest(OR[0], 0, status=403, dead=True)
    st = p.status()[0]
    assert st["strikes"] == 3 and st["disabled"] and st["disabled_reason"] == "revoked (401/403)" and st["dead"]
    assert p.pick() in (OR[1], OR[2])


def test_a_key_whose_account_is_gone_is_disabled_on_its_first_refusal():
    # 2026-09-28: five OpenRouter keys answering 401 "User not found" sat resting, counted live, and every task died on them.
    c = _client(lambda req: httpx.Response(401, json={"error": {"message": "User not found.", "code": 401}}), keys=[OR[0], OR[1]])
    with pytest.raises((ApiError, NoUsableKey)):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    st = c.pool.status()
    assert all(s["disabled"] and s["disabled_reason"] == "revoked (401/403)" and s["strikes"] == 1 for s in st)


def test_a_key_that_spent_its_own_limit_is_disabled_as_out_of_credit():
    # 2026-09-28: a 403 "Key limit exceeded" key only rested, so the next tasks were handed it and died too.
    c = _client(lambda req: httpx.Response(403, json={"error": {"message": "Key limit exceeded (weekly limit).", "code": 403}}), keys=[OR[0]])
    with pytest.raises((ApiError, NoUsableKey)):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="or:deepseek/deepseek-chat-v3.1"))
    st = c.pool.status()[0]
    assert st["disabled"] and st["disabled_reason"] == "out of credit (402)"


def test_a_200_and_a_positive_probe_both_take_a_key_back_out_of_the_slot():
    p = _pool()
    p.broke(OR[0])
    assert p.status()[0]["disabled"]
    p.recover(OR[0])  # the key answered 200: healthy, whatever we thought
    assert not p.status()[0]["disabled"] and p.available() == 3
    p.broke(OR[1])
    assert p.note_balance(OR[1], 12.5, None) is True  # a probe saw a top-up
    st = p.status()[1]
    assert not st["disabled"] and st["strikes"] == 0 and st["balance_usd"] == 12.5


def test_enable_and_disable_by_fingerprint():
    p = _pool()
    p.broke(OR[0])
    p.broke(OR[1])
    assert len(p.disabled()) == 2
    assert p.enable(config.fingerprint(OR[0])) is True and not p.status()[0]["disabled"]
    assert p.enable("not-a-fingerprint") is False
    assert p.enable_all() == 1 and p.disabled() == []
    p.disable(OR[2], reason="rotated out")
    st = p.status()[2]
    assert st["disabled"] and st["disabled_reason"] == "rotated out" and not st["free_only"]


def test_a_legacy_timed_park_upgrades_consistently():
    """What a pre-2026-09-17 build left in keys.json: `broke` with a six-hour timer and no `disabled` flag.
    Every path must agree about it - a review pass claimed pick() and next_with_balance() would disagree
    (the cc path stuck on it forever), so this pins both to the same answer in all three states."""
    now = __import__("time").time()
    config.KEYS_STATE.parent.mkdir(parents=True, exist_ok=True)
    config.KEYS_STATE.write_text(json.dumps({
        config.fingerprint(OR[0]): {"broke": True, "rest_until": now - 10, "strikes": 1, "status": 402},    # expired
        config.fingerprint(OR[1]): {"broke": True, "rest_until": now + 3600, "strikes": 1, "status": 402},  # running
    }), encoding="utf-8")
    p = _pool()
    # A park whose timer ran out is back in play, and both the api and the cc path say so.
    assert p._usable(OR[0], False) and p.next_with_balance()[0] is not None
    assert sorted({p.pick() for _ in range(6)}) == [OR[0], OR[2]]
    assert p.available() == 2
    # One still inside its timer counts as out, reads as disabled, and names the reason it was parked for.
    st = p.status()
    assert st[1]["state"] == "disabled" and st[1]["disabled_reason"] == "out of credit (402)"
    assert st[0]["state"] == "ok" and st[2]["state"] == "ok"
    assert p.disabled() == [config.fingerprint(OR[1])]
    for _ in range(6):
        assert p.next_with_balance()[0] != OR[1]  # the cc path never launches on it either


def test_the_state_file_never_holds_a_key(tmp_path):
    p = _pool()
    p.broke(OR[0])
    p.rest(OR[1], 30, status=429)
    p.disable(OR[2], reason="rotated out")
    raw = config.KEYS_STATE.read_text(encoding="utf-8")
    assert "sk-or-v1-" not in raw and config.fingerprint(OR[0])[:8] in raw
    assert "sk-" not in json.dumps(p.status())


# --- the operator surface ---------------------------------------------------------------------------


def test_keys_report_counts_the_slot(monkeypatch):
    monkeypatch.setattr(config, "load_api_keys", lambda provider=config.DEFAULT_PROVIDER: list(OR) if provider == "openrouter" else [])
    p = _pool()
    p.broke(OR[0])
    rep = keymod.report("openrouter")["providers"]["openrouter"]
    assert rep["keys"] == 3 and rep["ok"] == 2 and rep["disabled"] == 1 and rep["balance_authority"] == "status"
    assert [r["fingerprint"] for r in rep["rows"]] == [config.fingerprint(k) for k in OR]
    assert "hswarm keys probe" in keymod.report("openrouter")["note"]
    out = keymod.set_enabled(config.fingerprint(OR[0]), True, "openrouter")
    assert out["changed"] == 1 and keymod.report("openrouter")["providers"]["openrouter"]["disabled"] == 0
    assert keymod.set_enabled("nope", True, "openrouter")["changed"] == 0
    assert "sk-" not in json.dumps(keymod.report("openrouter"))


def test_keys_report_bounded_lists_only_the_keys_needing_attention(monkeypatch):
    # The MCP default: every count survives, healthy rows do not, and the reply says what it left out.
    monkeypatch.setattr(config, "load_api_keys", lambda provider=config.DEFAULT_PROVIDER: list(OR) if provider == "openrouter" else [])
    p = _pool()
    p.broke(OR[0])
    p.rest(OR[1], 30, status=429)
    rep = keymod.report("openrouter", verbose=False)
    prov = rep["providers"]["openrouter"]
    assert prov["keys"] == 3 and prov["ok"] == 1 and prov["disabled"] == 1 and prov["resting"] == 1
    assert sorted(r["fingerprint"] for r in prov["rows"]) == sorted(config.fingerprint(k) for k in OR[:2])
    assert prov["rows_omitted"] == 1
    assert "Bounded report" in rep["note"] and "sk-" not in json.dumps(rep)
    full = keymod.report("openrouter")["providers"]["openrouter"]
    assert len(full["rows"]) == 3 and "rows_omitted" not in full


def test_probe_reports_what_moved_and_merges_the_credits_call(monkeypatch):
    monkeypatch.setattr(config, "load_api_keys", lambda provider=config.DEFAULT_PROVIDER: list(OR) if provider == "openrouter" else [])
    paths = []

    def handler(req: httpx.Request):
        paths.append(req.url.path)
        if req.url.path.endswith("/credits"):
            return httpx.Response(200, json={"data": {"total_credits": 5.0, "total_usage": 5.05}})
        return httpx.Response(200, json={"data": {"limit_remaining": None, "free_model_daily_requests": {"remaining": 50}}})

    made = {}

    def fake_client(*a, **kw):
        c = ChatClient(api_keys=list(OR), provider="openrouter")
        c._http = httpx.AsyncClient(base_url="https://or.test", transport=httpx.MockTransport(handler), headers={})
        made["c"] = c
        return c

    monkeypatch.setattr(keymod, "ChatClient", fake_client)
    out = asyncio.run(keymod.probe("openrouter"))["providers"]["openrouter"]
    # /key has no limit, so /credits is fetched and folded in: one probe, two GETs, one honest number.
    assert paths.count("/key") == 3 and paths.count("/credits") == 3
    assert out["usable"] == 3 and out["disabled_now"] == [] and out["rows"][0]["credit_usd"] == pytest.approx(-0.05)
    assert out["rows"][0]["free_left"] == 50 and "only a 402 disables" in out["rows"][0]["note"]


# --- the catalogue ------------------------------------------------------------------------------------


def test_the_catalogue_scales_per_token_prices_to_per_million():
    doc = catalogue.build([
        {"id": "deepseek/deepseek-chat-v3.1", "context_length": 163840,
         "pricing": {"prompt": "0.00000025", "completion": "0.00000095", "input_cache_read": "0.00000013"}},
        {"id": "nex-agi/nex-n2.5-mini:free", "context_length": 262144, "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "weird/no-price", "context_length": 8192, "pricing": {}},
        {"id": "weird/half-price", "pricing": {"prompt": "0.000001"}},  # no completion rate quoted
        {"id": "", "pricing": {"prompt": "1"}},
    ])
    m = doc["models"]
    assert set(m) == {"or:deepseek/deepseek-chat-v3.1", "or:nex-agi/nex-n2.5-mini:free", "or:weird/no-price", "or:weird/half-price"}
    # Half a quote is not a price: filling the missing side with 0.0 would bill unquoted output at $0/1M
    # and read as a measured free model. '-' (not measured) is the only honest answer.
    assert "price" not in m["or:weird/half-price"]
    ds = m["or:deepseek/deepseek-chat-v3.1"]
    assert ds["price"] == {"hit": 0.13, "miss": 0.25, "out": 0.95} and ds["api_id"] == "deepseek/deepseek-chat-v3.1" and ds["ctx"] == 163840
    assert m["or:nex-agi/nex-n2.5-mini:free"]["price"] == {"hit": 0.0, "miss": 0.0, "out": 0.0}  # free is measured zero
    assert "price" not in m["or:weird/no-price"]  # nothing quoted: '-', never a guess


def test_a_hand_written_price_outlives_a_catalogue_refresh(tmp_path, monkeypatch, user_toml):
    monkeypatch.setattr(config, "CATALOGUE_FILE", tmp_path / "openrouter-models.json")
    config.CATALOGUE_FILE.write_text(json.dumps({"models": {
        "or:a/b": {"provider": "openrouter", "api_id": "a/b", "price": {"hit": 1.0, "miss": 1.0, "out": 2.0}},
        "or:c/d": {"provider": "openrouter", "api_id": "c/d", "price": {"hit": 9.0, "miss": 9.0, "out": 9.0}},
    }}), encoding="utf-8")
    user_toml("openrouter", '[models."or:a/b"]\nprice = {hit = 0.1, miss = 0.1, out = 0.2}\naliases = ["cheap"]\n')
    assert config.price("or:a/b") == {"hit": 0.1, "miss": 0.1, "out": 0.2}  # the human's line wins
    assert config.price("or:c/d") == {"hit": 9.0, "miss": 9.0, "out": 9.0}  # the generated one stands elsewhere
    assert config.resolve_model("cheap") == "or:a/b" and config.api_model_id("or:a/b") == "a/b"
