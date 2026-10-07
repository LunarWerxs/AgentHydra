"""Offline: the provider layer - a user's provider files register a model and settings.toml wires a role, each provider gets
its own client (URL, key, allowed request fields, usage shape), an unpriced model costs '-', not zero,
the cc backend stays DeepSeek-only, and the job manager routes a task to its provider's client."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.client import ChatClient, DeepSeekClient  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402

@pytest.fixture
def overlay(user_toml):
    user_toml("moonshot", '[models.kimi-test]\nctx = 262144\naliases = ["kimi"]\n')
    user_toml("gemini", '[models.gem-test]\nprice = {miss = 0.30, out = 2.50}\n')
    # judge = "" blanks the built-in wiring, so the "a role with nothing wired fails loudly" path below is still
    # exercised: every role ships wired by default (config.ROLES), so a role must be explicitly blanked to be unwired.
    user_toml("settings", '[roles]\nsearch = "gem-test"\ncode = "kimi-test"\njudge = ""\n')


def test_overlay_registers_models_aliases_and_roles(overlay):
    assert config.resolve_model("kimi") == "kimi-test" and config.provider_of("kimi-test") == "moonshot"
    assert config.resolve_role("search") == "gem-test" and config.resolve_role("code") == "kimi-test"
    assert config.resolve_role(None) == "deepseek-flash" and config.resolve_model("flash") == "deepseek-flash"
    assert config.cost_usd("kimi-test", 1_000_000, 1_000_000, 1_000_000) is None  # no price: not measured, never zero
    assert config.cost_usd("gem-test", 1_000_000, 1_000_000, 1_000_000) == pytest.approx(0.30 + 0.30 + 2.50)
    st = config.providers_status()
    assert st["moonshot"]["models"] == ["kimi-test"] and st["moonshot"]["unpriced_models"] == ["kimi-test"] and st["gemini"]["unpriced_models"] == []
    with pytest.raises(ValueError, match="no model wired"):
        config.resolve_role("judge")
    with pytest.raises(ValueError, match="unknown role"):
        config.resolve_role("dance")


def test_without_the_overlay_the_builtins_stand():
    # deepseek-flash-hf / -or: the same model through Hugging Face and OpenRouter, the router's fallback legs.
    # The free-tier provider models were added 2026-09-20 when DeepSeek's direct keys ran out; they ship in
    # the package's provider files (not a machine-local one) so every clone routes the same way.
    # + gpt-oss-120b, qwen3.8-27b direct on Groq/Cerebras, 5 on NVIDIA, Claude Sonnet 5.5 at five efforts (46dacfc)
    # + the direct Anthropic provider's 10 `:direct` routes - Opus 5.5 and Sonnet 5.5, each at five efforts (5744065,
    #   which left this count at 39 and the assertion red)
    # + Cohere's Aya Expanse 32B (d94af6a): no `rank:` route, so it is in the list below and not in this count
    # + Haiku 5.5 direct at five efforts (2026-10-07)
    assert len([m for m in config.MODELS if m.startswith("rank:")]) == 54
    assert sorted(m for m in config.MODELS if not m.startswith("rank:")) == [
        "aya-expanse-32b", "cerebras-gpt-oss-120b", "cerebras-qwen3.8-27b", "command-a", "command-r7b",
        "deepseek-flash", "deepseek-flash-hf", "deepseek-flash-or", "deepseek-v4-pro",
        "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-3.8-flash",
        "glm-4.5-air", "groq-gpt-oss-120b", "groq-gpt-oss-20b", "groq-qwen3.8-27b", "jev-latest",
        "magistral-medium", "ministral-8b", "mistral-medium-3.5",
    ]
    with pytest.raises(ValueError, match="PROVIDERS.md"):
        config.resolve_model("kimi-test")
    assert DeepSeekClient is ChatClient


def test_each_provider_has_its_own_url_key_and_request_shape(overlay):
    seen: list[dict] = []

    def handler(req: httpx.Request):
        seen.append({"url": str(req.url), "auth": req.headers["Authorization"], "body": json.loads(req.content)})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 300, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 100}}})

    c = ChatClient(provider="moonshot", api_keys=["sk-moon-1"])
    c._http = httpx.AsyncClient(base_url=config.PROVIDERS["moonshot"]["base_url"], transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    r = asyncio.run(c.chat([{"role": "user", "content": "x"}], model="kimi", thinking=False, reasoning_effort="low", max_tokens=100))
    assert seen[0]["url"] == "https://api.moonshot.ai/v1/chat/completions" and seen[0]["auth"] == "Bearer sk-moon-1"
    assert seen[0]["body"] == {"model": "kimi-test", "messages": [{"role": "user", "content": "x"}], "max_tokens": 100}  # DeepSeek-only fields dropped
    assert (r.usage.hit, r.usage.miss, r.usage.out) == (100, 200, 20) and r.cost_usd is None and r.model == "kimi-test"
    with pytest.raises(ValueError, match="belongs to provider"):
        asyncio.run(c.chat([{"role": "user", "content": "x"}], model="deepseek-flash"))
    assert asyncio.run(c.balance())["note"].startswith("moonshot has no balance")


def test_no_key_for_a_provider_names_its_env_and_file(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEYS", raising=False)
    monkeypatch.setattr(config, "SECRETS_DIR", Path("Z:/nowhere"))
    with pytest.raises(RuntimeError, match=r"gemini\.toml.*GEMINI_API_KEY"):
        ChatClient(provider="gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "g-unit-secret")
    st = config.key_status("gemini")
    assert st["present"] and st["count"] == 1 and "unit-secret" not in json.dumps(st)


def test_tasks_take_a_role_and_cc_needs_an_anthropic_endpoint(overlay, tmp_path):
    t = Task.from_dict({"prompt": "x", "role": "search", "cwd": str(tmp_path)}, {}, 0)
    assert t.model == "gem-test" and t.role == "search"
    # Claude Code speaks the Anthropic Messages API and nothing else, so Kimi's OpenAI-only endpoint is refused...
    with pytest.raises(ValueError, match="which has none"):
        Task.from_dict({"prompt": "x", "backend": "cc", "model": "kimi-test", "cwd": str(tmp_path)}, {}, 0)
    # ...while the two fallback paths that DO have one are allowed (added 2026-09-17, when the DeepSeek keys
    # stopped being topped up and cc had to have somewhere to go).
    for m in ("deepseek-flash-hf", "deepseek-flash-or"):
        assert Task.from_dict({"prompt": "x", "backend": "cc", "model": m, "cwd": str(tmp_path)}, {}, 0).model == m


class _FakeClient:
    def __init__(self, provider: str, cost: float | None):
        self.provider, self.cost, self.calls = provider, cost, 0

    async def chat(self, messages, **kw):
        self.calls += 1
        await asyncio.sleep(0.01)
        return ChatResult(message={"role": "assistant", "content": "OK"}, finish_reason="stop", usage=Usage(), model=kw.get("model", "?"), seconds=0.01, cost_usd=self.cost, peak=False)

    async def aclose(self):
        pass


def test_job_manager_routes_each_task_to_its_providers_client(overlay, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "JOBS_DIR", tmp_path / "jobs")
    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    deepseek, moonshot = _FakeClient("deepseek", 0.001), _FakeClient("moonshot", None)  # Kimi has no price on record here

    async def go():
        m = JobManager(client=deepseek)
        m._clients["moonshot"] = moonshot
        tasks = [Task.from_dict({"id": "a", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "kimi"}, {}, 0),
                 # pinned: this asserts each task reaches ITS provider's client, not what AUTO resolves to.
                 Task.from_dict({"id": "b", "prompt": "x", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"}, {}, 1)]
        return await m.run_batch(tasks)

    job = asyncio.run(go())
    assert (moonshot.calls, deepseek.calls) == (1, 1)
    assert job.results["a"].cost_usd is None and job.results["a"].status == "ok"  # unpriced: '-', and the task still succeeds
    assert job.summary()["cost_unknown_tasks"] == 1
    rows = [json.loads(line) for line in (tmp_path / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
    assert {r["task"]: r["provider"] for r in rows} == {"a": "moonshot", "b": "deepseek"}


# Contract: a typed model (Jev) answers typed questions through hswarm_decide and is never sent a chat call; naming it
# for a task says so. Regression: a task pinned to jev-latest posting to a chat endpoint that does not exist.
def test_a_typed_model_is_never_sent_a_chat_task():
    async def go():
        async with ChatClient(api_keys=["sk-typed-test-0001"], provider="typesafe") as c:
            await c.chat([{"role": "user", "content": "hi"}], model="jev-latest")

    with pytest.raises(ValueError, match="hswarm_decide"):
        asyncio.run(go())


# Contract: a provider whose calls cost nothing (`free_calls`) charges nothing to the ledger or to a task's
# max_cost_usd. Regression: NVIDIA's models carried list prices, so a free refresh job was stopped at the $0.25 cap
# having spent nothing (2026-09-27).
def test_a_free_calls_provider_charges_nothing():
    free = [m for m, e in config.MODELS.items() if config.PROVIDERS[e["provider"]].get("free_calls")]
    assert free
    assert {m: config.cost_usd(m, 10**6, 10**6, 10**6) for m in free} == {m: 0.0 for m in free}
