"""Offline: the Hugging Face Inference Providers router as a provider (wired 2026-09-17).

Shapes verified against the live router that day: an OpenAI-compatible /v1/chat/completions, the host
pinned by the model id's own `:<host>` suffix, the serving host named in the `x-inference-provider`
response HEADER (not the body), and the provider's cost as `usage.estimated_cost`.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.client import ChatClient  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_key_state(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys-state.json")


def _client(handler) -> ChatClient:
    c = ChatClient(api_keys=["hf_test_token"], provider="huggingface")
    c._http = httpx.AsyncClient(base_url="https://hf.test", transport=httpx.MockTransport(handler))
    return c


def test_the_provider_is_registered():
    p = config.PROVIDERS["huggingface"]
    assert p["base_url"] == "https://router.huggingface.co/v1"
    assert "huggingface_api_keys" in p["key_files"] and "HF_TOKEN" in p["key_env"]
    assert p["host_pin"] == "suffix" and p["upstream_header"] == "x-inference-provider"
    assert p["balance_path"] is None and p["balance_authority"] == "status"


def test_a_repo_id_keeps_its_case_on_the_wire():
    """The registry key is lowercase; the wire id is not. `deepseek-ai/deepseek-v4.1-flash` is a 400 on the
    router - it only knows `DeepSeek-V4.1-Flash`."""
    n = config.resolve_model("hf:deepseek-ai/DeepSeek-V4.1-Flash")
    assert n == "hf:deepseek-ai/deepseek-v4.1-flash" and config.provider_of(n) == "huggingface"
    assert config.api_model_id(n) == "deepseek-ai/DeepSeek-V4.1-Flash"


def test_a_host_pin_becomes_the_model_suffix_not_a_request_field():
    n = config.resolve_model("hf:deepseek-ai/DeepSeek-V4.1-Flash#deepinfra")
    assert config.api_model_id(n) == "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra"
    assert "extra" not in config.MODELS[n]
    # OpenRouter's pin stays a request field
    o = config.resolve_model("or:deepseek/deepseek-v4.1-flash#deepinfra")
    assert config.MODELS[o]["extra"]["provider"]["only"] == ["deepinfra"]


def test_the_serving_host_comes_from_the_header_and_the_cost_from_estimated_cost():
    sent = {}

    def handler(req: httpx.Request):
        sent["body"] = json.loads(req.content)
        return httpx.Response(200, headers={"x-inference-provider": "deepinfra"}, json={
            "choices": [{"message": {"content": "391"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 26, "completion_tokens": 2, "estimated_cost": 6.4e-06,
                      "prompt_tokens_details": {"cached_tokens": 0}}})

    r = asyncio.run(_client(handler).chat([{"role": "user", "content": "x"}], model="hf:deepseek-ai/DeepSeek-V4.1-Flash#deepinfra",
                                          reasoning_effort="low", thinking=False))
    assert sent["body"]["model"] == "deepseek-ai/DeepSeek-V4.1-Flash:deepinfra"
    assert sent["body"]["reasoning_effort"] == "low" and "thinking" not in sent["body"] and "usage" not in sent["body"]
    assert r.raw["provider"] == "deepinfra" and r.cost_usd == pytest.approx(6.4e-06)


def test_a_body_provider_field_is_never_overwritten_by_the_header():
    def handler(req):
        return httpx.Response(200, headers={"x-inference-provider": "header-host"},
                              json={"provider": "body-host", "choices": [{"message": {"content": "ok"}}], "usage": {}})

    r = asyncio.run(_client(handler).chat([{"role": "user", "content": "x"}], model="hf:org/Model"))
    assert r.raw["provider"] == "body-host"


def test_a_reported_cost_of_zero_is_a_measurement_not_a_gap():
    def handler(req):
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {"estimated_cost": 0}})

    r = asyncio.run(_client(handler).chat([{"role": "user", "content": "x"}], model="hf:org/Model"))
    assert r.cost_usd == 0.0


def test_a_hugging_face_key_out_of_credit_gets_one_chance_per_window(tmp_path, monkeypatch):
    """There is no balance endpoint here, so the free probe that heals a DeepSeek key cannot exist. A monthly
    allowance comes back on its own, so a credit disable is re-tried once per window - and never a revoked one."""
    from hswarm.client import DEAD_STRIKES, KeyPool

    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    p = KeyPool(["hf_a", "hf_b"], provider="huggingface")
    p.broke("hf_a", status=402)
    for _ in range(DEAD_STRIKES):
        p.rest("hf_b", 0, status=401, dead=True)
    assert p.disabled() == [config.fingerprint("hf_a"), config.fingerprint("hf_b")]
    assert p.probation() == []  # inside the window: nothing moves
    assert p.probation(0.0) == [config.fingerprint("hf_a")]  # the window passed: the credit one gets a chance
    assert p.disabled() == [config.fingerprint("hf_b")] and p.available() == 1  # the revoked one never does
    p.broke("hf_a", status=402)  # and the next 402 puts it straight back
    assert p.available() == 0


def test_the_probe_path_gives_that_chance_and_the_balance_providers_are_untouched(tmp_path, monkeypatch):
    import asyncio

    from hswarm.client import ChatClient, KeyPool

    monkeypatch.setattr(config, "KEYS_STATE", tmp_path / "keys.json")
    c = ChatClient(api_keys=["hf_a"], provider="huggingface")
    c.pool.broke("hf_a", status=402)
    assert asyncio.run(c.probe_balances()) == [] and c.pool.available() == 0  # inside the window
    assert asyncio.run(c.probe_balances(disabled_age_s=0.0)) == [] and c.pool.available() == 1
    # A provider WITH a balance endpoint never reaches this path: its probe asks the endpoint instead, and only a
    # reading (or `keys enable`) lets a key out. The pool method itself is provider-agnostic.
    d = KeyPool(["sk-d"], provider="deepseek")
    d.broke("sk-d", status=402)
    assert d.probation(0.0) == [config.fingerprint("sk-d")] and d.available() == 1
