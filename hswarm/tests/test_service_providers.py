"""Offline provider coverage: real service schemas, mocked transport, no credential-bearing network calls."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from hswarm import config
from hswarm.cli import build_parser
from hswarm.client import ChatClient
from hswarm.service import ServiceClient, cmd_service, describe
from hswarm.usage import ApiError


EXPORT_PROVIDERS = set("anthropic assemblyai baseten cartesia cerebras chutes cohere coze deepgram deepseek "
                       "elevenlabs grok_xai groq huggingface humeai ideogram inworld langsmith leonardoai lumaai "
                       "mistral nebius openai openrouter replicate runpod runway stabilityai tavily together voiceflow zhipu".split())
SERVICES = set("assemblyai cartesia coze deepgram elevenlabs humeai ideogram inworld langsmith leonardoai lumaai "
               "replicate runpod runway stabilityai tavily voiceflow".split())
CHAT = {"baseten:": "baseten", "chutes:": "chutes", "xai:": "grok_xai", "grok_xai:": "grok_xai",
        "nebius:": "nebius", "openai:": "openai", "together:": "together", "inworld:": "inworld"}


def test_every_export_service_has_a_canonical_pool_and_real_capabilities():
    assert EXPORT_PROVIDERS <= set(config.PROVIDERS)
    for name in EXPORT_PROVIDERS:
        assert config.PROVIDERS[name]["key_files"][0] == name + "_api_keys"
    for name in SERVICES:
        spec = config.PROVIDERS[name]
        if name != "inworld":
            assert spec["transport"] == "service" and not config.provider_chat(name)
        assert spec.get("models_path") is None
        if name != "inworld":
            assert not spec.get("passthrough")
        assert spec["operations"]
        assert not [m for m in config.MODELS.values() if m["provider"] == name]
        for operation in spec["operations"].values():
            assert operation["capability"] in spec["capabilities"]
            assert operation["method"] in ("GET", "POST")
            assert operation["path"].startswith("/")


def test_explicit_dead_classification_overrides_all_active_sources(user_toml, monkeypatch):
    config.SECRETS_DIR.mkdir(parents=True)
    active = config.SECRETS_DIR / "tavily_api_keys"
    dead = active.with_name(active.name + ".dead")
    active.write_text("unit-live\nunit-dead\nunit-unfunded\n", encoding="utf-8")
    dead.write_text("unit-dead\n", encoding="utf-8")
    active.with_name(active.name + ".unfunded").write_text("unit-unfunded\n", encoding="utf-8")
    user_toml("tavily", 'keys = ["unit-dead", "unit-legacy"]\n')
    monkeypatch.setenv("TAVILY_API_KEY", "unit-dead")
    assert config.all_keys("tavily") == ["unit-legacy", "unit-live", "unit-unfunded"]
    assert "unit-dead" not in json.dumps(config.key_status("tavily"))
    # Existing reader closures see a newly revoked key without config.reload().
    readers = config.key_sources("tavily")
    dead.write_text("unit-dead\nunit-live\n", encoding="utf-8")
    assert "unit-live" not in [key for _, reader in readers for key in reader()]


def test_canonical_keys_survive_an_empty_or_custom_source_overlay(user_toml):
    user_toml("tavily", 'key_files = []\n')
    assert config.PROVIDERS["tavily"]["key_files"] == ("tavily_api_keys",)
    user_toml("tavily", 'key_files = ["custom_api_keys"]\n')
    assert config.PROVIDERS["tavily"]["key_files"] == ("tavily_api_keys", "custom_api_keys")


@pytest.mark.parametrize("provider", sorted(SERVICES - {"inworld"}))
def test_non_chat_services_are_refused_before_http_creation(provider, monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("chat HTTP client must not be created")

    monkeypatch.setattr(httpx, "AsyncClient", unexpected)
    with pytest.raises(ValueError, match="hswarm service"):
        ChatClient(provider=provider, api_keys=["unit-test-key"])


@pytest.mark.parametrize("prefix,provider", CHAT.items())
def test_chat_catalogue_prefixes_preserve_model_case_and_correct_provider(prefix, provider):
    model = prefix + "Example/Model-1"
    name = config.resolve_model(model)
    assert config.provider_of(name) == provider
    assert config.api_model_id(name) == "Example/Model-1"


def test_openai_uses_completion_token_field_without_changing_existing_providers():
    seen = []

    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    async def go():
        client = ChatClient(provider="openai", api_keys=["unit-test-key"])
        await client._http.aclose()
        client._http = httpx.AsyncClient(base_url=client.spec["base_url"], transport=httpx.MockTransport(handler))
        async with client:
            await client.chat([{"role": "user", "content": "example"}], model="openai:example-model", max_tokens=100)

    asyncio.run(go())
    assert seen[0]["max_completion_tokens"] == 100 and "max_tokens" not in seen[0]


def test_inworld_chat_shares_its_basic_credential_with_speech():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    async def go():
        client = ChatClient(provider="inworld", api_keys=["unit-base64-credential"])
        await client._http.aclose()
        client._http = httpx.AsyncClient(base_url=client.spec["base_url"], transport=httpx.MockTransport(handler))
        async with client:
            await client.chat([{"role": "user", "content": "example"}], model="inworld:example-model")

    asyncio.run(go())
    assert str(seen[0].url) == "https://api.inworld.ai/v1/chat/completions"
    assert seen[0].headers["Authorization"] == "Basic unit-base64-credential"


@pytest.mark.parametrize("provider", sorted(SERVICES))
def test_service_operation_uses_documented_auth_and_route(provider):
    spec = config.PROVIDERS[provider]
    operation, op = next(iter(spec["operations"].items()))
    import string

    fields = {field: "example-id" for _, field, _, _ in string.Formatter().parse(op["path"]) if field}
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, content=b"example" if op["response"] == "bytes" else b'{"ok":true}')

    async def go():
        async with ServiceClient(provider, api_keys=["unit-test-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call(operation, {"text": "example"}, path_params=fields)

    result = asyncio.run(go())
    assert result == (b"example" if op["response"] == "bytes" else {"ok": True})
    assert str(seen[0].url).split("?")[0] == spec["base_url"] + op["path"].format_map(fields)
    assert seen[0].headers[spec["auth_header"]] == spec["auth_prefix"] + "unit-test-key"
    for header, value in spec.get("headers", {}).items():
        assert seen[0].headers[header] == value


def test_text_only_multipart_and_binary_responses():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"image": "example-base64"})

    async def go():
        async with ServiceClient("stabilityai", api_keys=["unit-test-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call("generate", {"prompt": "example", "seed": 1})

    assert asyncio.run(go()) == {"image": "example-base64"}
    assert seen[0].headers["content-type"].startswith("multipart/form-data; boundary=")
    assert b'name="prompt"' in seen[0].content and b'example' in seen[0].content


def test_voiceflow_project_key_can_interact_without_a_session_credential():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=[{"type": "text", "payload": {"message": "example answer"}}])

    async def go():
        async with ServiceClient("voiceflow", api_keys=["unit-project-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call("interact", {"action": {"type": "text", "payload": "example question"}},
                                     path_params={"user_id": "example-user"})

    assert asyncio.run(go())[0]["payload"]["message"] == "example answer"
    assert str(seen[0].url) == "https://general-runtime.voiceflow.com/state/user/example-user/interact"
    assert seen[0].headers["Authorization"] == "unit-project-key"
    assert json.loads(seen[0].content)["action"] == {"type": "text", "payload": "example question"}


def test_invalid_path_parameters_and_unknown_operations_never_send():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, json={})

    async def go():
        async with ServiceClient("elevenlabs", api_keys=["unit-test-key"], transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(ValueError, match="path parameters"):
                await client.call("synthesize", {"text": "example"})
            with pytest.raises(ValueError, match="traversal"):
                await client.call("synthesize", {"text": "example"}, path_params={"voice_id": ".."})
            with pytest.raises(ValueError, match="unknown service operation"):
                await client.call("https://example.test")

    asyncio.run(go())
    assert not calls


def test_ambiguous_generation_is_not_retried():
    calls = []

    def handler(req):
        calls.append(req)
        raise httpx.ReadTimeout("ambiguous request result", request=req)

    async def go():
        async with ServiceClient("tavily", api_keys=["unit-key-one", "unit-key-two"], transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(httpx.ReadTimeout):
                await client.call("search", {"query": "example"})

    asyncio.run(go())
    assert len(calls) == 1


def test_error_echo_cannot_expose_the_selected_secret():
    def handler(req):
        return httpx.Response(401, text="invalid unit-test-key")

    async def go():
        async with ServiceClient("tavily", api_keys=["unit-test-key"], transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(ApiError) as error:
                await client.call("search", {"query": "example"})
            assert "unit-test-key" not in str(error.value) and "unit-test-key" not in error.value.body

    asyncio.run(go())


def test_cli_lists_operations_without_keys_and_requires_binary_destination(capsys):
    parser = build_parser()
    args = parser.parse_args(["service", "elevenlabs"])
    assert asyncio.run(cmd_service(args)) == 0
    assert "synthesize" in capsys.readouterr().out
    assert describe("elevenlabs")["transport"] == "service"
    args = parser.parse_args(["service", "elevenlabs", "synthesize", "--path", "voice_id=example"])
    assert asyncio.run(cmd_service(args)) == 1
    assert "--output" in capsys.readouterr().err
