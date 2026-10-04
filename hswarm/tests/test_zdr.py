"""Offline: zero data retention (zdr.py). A zdr task reaches only listed models, carries the preference on every
request, and is refused when the list was never read."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, selection, zdr  # noqa: E402
from hswarm.client import ChatClient  # noqa: E402

MODEL = "rank:gpt-oss-120b"  # api_id openai/gpt-oss-120b on OpenRouter


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HOME", tmp_path)


def _body(entry, zdr_on=True):
    c = ChatClient(provider="openrouter", api_key="sk-or-v1-test")
    return c._chat_body(MODEL, entry, entry["api_id"], [{"role": "user", "content": "x"}], tools=None, tool_choice=None, max_tokens=100,
                        thinking=None, reasoning_effort=None, response_format=None, temperature=None, user=None, stop=None, zdr=zdr_on)


def test_request_body_for_a_cleared_model_carries_the_preference():
    zdr.save(["openai/gpt-oss-120b"])
    assert zdr.cleared(MODEL)
    assert _body(dict(config.MODELS[MODEL]))["provider"] == {"zdr": True}
    assert "provider" not in _body(dict(config.MODELS[MODEL]), zdr_on=False)


def test_an_existing_provider_pin_survives_the_merge():
    entry = dict(config.MODELS[MODEL], extra={"provider": {"order": ["deepinfra"], "allow_fallbacks": True}})
    body = _body(entry)
    assert body["provider"] == {"order": ["deepinfra"], "allow_fallbacks": True, "zdr": True}
    assert entry["extra"]["provider"] == {"order": ["deepinfra"], "allow_fallbacks": True}  # the registry is not edited


def test_an_unread_list_clears_nothing_and_refuses_the_task():
    assert zdr.load()["fetched_at"] is None and not zdr.cleared(MODEL)
    assert "never read" in zdr.refusal(MODEL)
    plan = selection.plan("general", zdr=True)
    assert plan["candidates"] == [] and {r["filter"] for r in plan["rejected"]} >= {"zdr"}
    c = ChatClient(provider="openrouter", api_key="sk-or-v1-test")
    with pytest.raises(ValueError, match="zdr task refused"):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model=MODEL, zdr=True))


def test_the_automatic_router_and_unlisted_models_are_never_cleared():
    zdr.save(["openrouter/auto", "some/other-model"])
    assert "openrouter/auto" not in zdr.load()["models"]
    assert "not on OpenRouter's zero-retention list" in zdr.refusal(MODEL)
    assert "not served through OpenRouter" in zdr.refusal("deepseek-flash")


def test_a_garbled_list_fails_closed():
    zdr.cache_file().write_text("{not json", encoding="utf-8")
    assert zdr.load()["models"] == set() and not zdr.cleared(MODEL)
