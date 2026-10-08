"""Offline provider coverage: real service schemas, mocked transport, no credential-bearing network calls."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from hswarm import config, egress
from hswarm.cli import build_parser
from hswarm.client import ChatClient
from hswarm.service import ServiceClient, cmd_service, describe
from hswarm.usage import ApiError


EXPORT_PROVIDERS = set("anthropic assemblyai baseten cartesia cerebras chutes cohere coze deepgram deepseek "
                       "elevenlabs grok_xai groq huggingface humeai ideogram inworld langsmith leonardoai lumaai "
                       "mistral nebius openai openrouter replicate runpod runway stabilityai tavily together voiceflow zhipu "
                       "dashscope jina pinecone stepfun gemini".split())
SERVICES = set("assemblyai cartesia coze deepgram elevenlabs humeai ideogram inworld langsmith leonardoai lumaai "
               "replicate runpod runway stabilityai tavily voiceflow jina pinecone".split())
CHAT = {"baseten:": "baseten", "chutes:": "chutes", "xai:": "grok_xai", "grok_xai:": "grok_xai",
        "nebius:": "nebius", "openai:": "openai", "together:": "together", "inworld:": "inworld",
        "dashscope:": "dashscope"}


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


@pytest.mark.parametrize("model", ["step-5-preview", "step-3.5-flash", "step-1o-turbo-vision", "stepaudio-3-chat-preview",
                                   "step-r1-v-mini", "step-1o-vision-32k"])
def test_stepfun_routes_only_documented_chat_families(model):
    name = config.resolve_model("stepfun:" + model)
    assert config.provider_of(name) == "stepfun"
    assert config.api_model_id(name) == model


@pytest.mark.parametrize("model", ["stepaudio-2.5-tts", "step-1x-edit", "step-2x-large", "step-image-edit-2", "step-1o-audio", "example-unknown"])
def test_stepfun_non_chat_catalog_entries_cannot_be_registered_as_chat(model):
    with pytest.raises(ValueError, match="outside its documented chat"):
        config.resolve_model("stepfun:" + model)


def test_invalid_chat_model_configuration_has_a_clear_error(monkeypatch):
    monkeypatch.setitem(config.PROVIDERS["stepfun"], "chat_model_pattern", "[")
    with pytest.raises(ValueError, match="invalid chat_model_pattern"):
        config.resolve_model("stepfun:step-5-preview")


def test_stepfun_mixed_catalog_is_filtered_in_watch_and_chat_client(monkeypatch):
    from hswarm import model_watch

    body = {"data": [{"id": "step-5-preview"}, {"id": "stepaudio-2.5-tts"}, {"id": "stepaudio-3-chat-preview"}]}

    class CatalogClient:
        def __init__(self, provider):
            assert provider == "stepfun"
            self.spec = config.PROVIDERS[provider]

        async def get_json(self, path):
            assert path == "/models"
            return body

        async def aclose(self):
            pass

    from hswarm import client as client_module

    monkeypatch.setattr(client_module, "DeepSeekClient", CatalogClient)
    assert asyncio.run(model_watch._list("stepfun")) == ["step-5-preview", "stepaudio-3-chat-preview"]

    async def go():
        async with ChatClient(provider="stepfun", api_keys=["unit-test-key"]) as client:
            async def get_json(path):
                return body

            client.get_json = get_json
            return await client.models()

    assert asyncio.run(go()) == ["step-5-preview", "stepaudio-3-chat-preview"]


@pytest.mark.parametrize("provider,body,expected", [
    ("stepfun", {"data": [{"id": "step-5-preview"}, {"id": "step-2x-large"}, {"id": "stepaudio-2.5-tts"}]}, {"stepfun:step-5-preview"}),
    ("together", [{"id": "Example/Model-1"}], {"together:example/model-1"}),
])
def test_catalog_refresh_registers_supported_models_and_keeps_other_providers(provider, body, expected, monkeypatch):
    from hswarm import catalogue

    # The catalogue file is shared: refreshing one provider must leave another's priced entries in place.
    kept = {"or:example/kept-model": {"provider": "openrouter", "api_id": "example/kept-model", "passthrough": True,
                                      "price": {"hit": 1.0, "miss": 1.0, "out": 2.0}}}
    config.CATALOGUE_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.CATALOGUE_FILE.write_text(json.dumps({"models": kept}), encoding="utf-8")

    class CatalogClient:
        def __init__(self, provider):
            self.provider = provider

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            pass

        async def get_json(self, path):
            assert path == "/models"
            return body

    monkeypatch.setattr(catalogue, "ChatClient", CatalogClient)
    result = asyncio.run(catalogue.refresh(provider))
    assert set(json.loads(config.CATALOGUE_FILE.read_text(encoding="utf-8"))["models"]) == expected | set(kept)
    assert result["models"] == len(expected)
    assert f"'{provider}:<id>'" in result["note"]
    assert expected <= set(config.MODELS)


def test_explicit_chat_provider_without_a_catalog_refuses_refresh_before_http(monkeypatch):
    from hswarm import catalogue

    monkeypatch.setattr(catalogue, "ChatClient", lambda **kwargs: pytest.fail("no catalog request should be created"))
    with pytest.raises(SystemExit, match="no configured chat catalog endpoint"):
        asyncio.run(catalogue.refresh("dashscope"))


@pytest.mark.parametrize("provider,model,url", [
    ("stepfun", "stepfun:step-5-preview", "https://api.stepfun.ai/v1/chat/completions"),
    ("dashscope", "dashscope:qwen-example", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"),
])
def test_new_chat_routes_send_the_documented_bearer_request(provider, model, url):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})

    async def go():
        client = ChatClient(provider=provider, api_keys=["unit-test-key"])
        await client._http.aclose()
        client._http = httpx.AsyncClient(base_url=client.spec["base_url"], transport=httpx.MockTransport(handler))
        async with client:
            await client.chat([{"role": "user", "content": "example"}], model=model)

    asyncio.run(go())
    assert str(seen[0].url) == url
    assert seen[0].headers["Authorization"] == "Bearer unit-test-key"
    assert json.loads(seen[0].content)["model"] == model.split(":", 1)[1]


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


@pytest.mark.parametrize("operation,url,payload", [
    ("read", "https://r.jina.ai/", {"url": "https://example.com/article"}),
    ("search", "https://s.jina.ai/", {"q": "example topic"}),
])
def test_jina_reader_and_search_use_their_own_hosts_and_the_receipt_names_them(operation, url, payload):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"data": []})

    async def go():
        async with ServiceClient("jina", api_keys=["unit-test-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call(operation, payload)

    assert asyncio.run(go()) == {"data": []}
    assert str(seen[0].url) == url
    assert seen[0].headers["Authorization"] == "Bearer unit-test-key"
    assert seen[0].headers["Accept"] == "application/json"
    # The egress receipt records where the bytes went, not the provider's main host.
    assert egress.tail(1)[-1]["sink"] == url


def test_a_base_url_the_person_sets_is_used_as_given_http_included(user_toml):
    # A local mock or a self-hosted runtime: only an operation that overrides its own target is held to HTTPS.
    user_toml("voiceflow", 'base_url = "http://127.0.0.1:8099/"\n')
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=[])

    async def go():
        async with ServiceClient("voiceflow", api_keys=["unit-project-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call("interact", {"action": {"type": "launch"}}, path_params={"user_id": "example-user"})

    asyncio.run(go())
    assert str(seen[0].url) == "http://127.0.0.1:8099/state/user/example-user/interact"


@pytest.mark.parametrize("target", ["https://example.test", "https://r.jina.ai:444"])
def test_jina_fixed_operation_cannot_send_a_key_to_another_host(target, monkeypatch):
    spec = config.PROVIDERS["jina"]
    read = {**spec["operations"]["read"], "base_url": target}
    monkeypatch.setitem(config.PROVIDERS, "jina", {**spec, "operations": {**spec["operations"], "read": read}})
    seen = []

    async def go():
        async with ServiceClient("jina", api_keys=["unit-test-key"], transport=httpx.MockTransport(lambda req: seen.append(req))) as client:
            with pytest.raises(ValueError, match="documented"):
                await client.call("read", {"url": "https://example.com"})

    asyncio.run(go())
    assert not seen


@pytest.mark.parametrize("operation,path", [("embed", "/embed"), ("rerank", "/rerank")])
def test_pinecone_inference_uses_control_plane_auth_and_api_version(operation, path):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"data": []})

    async def go():
        async with ServiceClient("pinecone", api_keys=["unit-project-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call(operation, {"model": "example-model", "inputs": [{"text": "example"}]})

    asyncio.run(go())
    assert str(seen[0].url) == "https://api.pinecone.io" + path
    assert seen[0].headers["Api-Key"] == "unit-project-key"
    assert seen[0].headers["X-Pinecone-Api-Version"] == "2025-10"


@pytest.mark.parametrize("operation,path", [("query", "/query"), ("upsert", "/vectors/upsert"), ("index_stats", "/describe_index_stats")])
@pytest.mark.parametrize("index_host", ["example-index.svc.us-east-1-aws.pinecone.io", "https://example-index.svc.aped-1234.pinecone.io/"])
def test_pinecone_vectors_use_only_the_configured_index_host(operation, path, index_host, user_toml):
    user_toml("pinecone", f'index_host = "{index_host}"\n')
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={"matches": []})

    async def go():
        async with ServiceClient("pinecone", api_keys=["unit-project-key"], transport=httpx.MockTransport(handler)) as client:
            return await client.call(operation, {"namespace": "example", "topK": 2})

    asyncio.run(go())
    expected = index_host.rstrip("/")
    if not expected.startswith("https://"):
        expected = "https://" + expected
    assert str(seen[0].url) == expected + path
    assert seen[0].headers["Api-Key"] == "unit-project-key"
    assert seen[0].headers["X-Pinecone-Api-Version"] == "2025-10"


@pytest.mark.parametrize("index_host", [
    None, "https://example.test", "example-index.pinecone.io", "example-index.svc.region.pinecone.io.example.test",
    "http://example-index.svc.region.pinecone.io", "https://user:pass@example-index.svc.region.pinecone.io",
    "https://example-index.svc.region.pinecone.io/v1", "https://example-index.svc.region.pinecone.io:444",
    "https://example-index.svc.region.pinecone.io?redirect=example.test", "https://example-index.svc.region.pinecone.io#fragment",
    "https://example-index.svc.region.pinecone.io:bad-port",
    # An empty query or fragment parses as none, and would have carried the operation's path off into it.
    "https://example-index.svc.region.pinecone.io?", "https://example-index.svc.region.pinecone.io#",
])
def test_pinecone_missing_or_foreign_index_hosts_are_refused_before_http(index_host, user_toml):
    if index_host is not None:
        user_toml("pinecone", f'index_host = "{index_host}"\n')
    seen = []

    async def go():
        async with ServiceClient("pinecone", api_keys=["unit-test-key"], transport=httpx.MockTransport(lambda req: seen.append(req))) as client:
            with pytest.raises(ValueError):
                await client.call("query", {"vector": [0.1], "topK": 1})

    asyncio.run(go())
    assert not seen


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


@pytest.mark.parametrize("status,text", [
    (403, '{"detail":"Insufficient account balance. Top up your account.","code":"AUTHZ_INSUFFICIENT_BALANCE"}'),
    (401, '{"detail":{"message":"Invalid API key"}}'),
    (429, '{"detail":"Too many requests"}'),
])
def test_a_key_refused_before_anything_ran_is_marked_and_the_call_moves_to_another_key(status, text, monkeypatch):
    # Measured 2026-10-07: 12 of 20 sampled Jina keys refused (a 403 "Insufficient account balance", or invalid), and the
    # pool left the 403s in rotation, so most one-shot calls failed on a key that could never answer.
    from hswarm import service

    monkeypatch.setattr(service.random, "randrange", lambda n: 0)  # a fresh client starts on the first key
    refused, good, other = "unit-refused-key", "unit-good-key", "unit-refused-key-2"
    seen = []

    def handler(req):
        key = req.headers["Authorization"].removeprefix("Bearer ")
        seen.append(key)
        return httpx.Response(status, text=text) if key.startswith("unit-refused") else httpx.Response(200, json={"data": []})

    async def go(**kw):
        async with ServiceClient("jina", api_keys=[refused, good, other], transport=httpx.MockTransport(handler), **kw) as client:
            return await client.call("search", {"q": "example"}), client.key_fingerprint

    # A fresh client sends the same request on the next key, which answers.
    assert asyncio.run(go()) == ({"data": []}, config.fingerprint(good))
    assert seen == [refused, good]
    # The refused key was marked: the next fresh client starts past it.
    assert asyncio.run(go()) == ({"data": []}, config.fingerprint(good))
    assert seen == [refused, good, good]
    # A client named to a key keeps it, refused or not: an asynchronous job stays on its own account.
    with pytest.raises(ApiError):
        asyncio.run(go(key_fingerprint=config.fingerprint(other)))
    assert seen == [refused, good, good, other]


def test_cli_lists_operations_without_keys_and_requires_binary_destination(capsys):
    parser = build_parser()
    args = parser.parse_args(["service", "elevenlabs"])
    assert asyncio.run(cmd_service(args)) == 0
    assert "synthesize" in capsys.readouterr().out
    assert describe("elevenlabs")["transport"] == "service"
    args = parser.parse_args(["service", "elevenlabs", "synthesize", "--path", "voice_id=example"])
    assert asyncio.run(cmd_service(args)) == 1
    assert "--output" in capsys.readouterr().err
