"""Evaluated configuration identity must survive the real provider request builder."""
import asyncio
import json

import httpx
import pytest

from hswarm import config
from hswarm.agent import ask
from hswarm.client import ChatClient


@pytest.mark.parametrize("model", ["rank:claude-opus-5-5", "rank:claude-opus-5-5-low",
                                 "rank:claude-opus-5-5-medium", "rank:gpt-6-astra-high", "rank:mimo-v2-6-pro"])
def test_ranked_request_sends_exact_evaluated_reasoning(model):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": '{"ok":true}'}}],
                                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "cost": .00001}})
    async def go():
        async with ChatClient(api_key="test-key", provider="openrouter") as client:
            await client._http.aclose()
            client._http = httpx.AsyncClient(base_url=config.PROVIDERS["openrouter"]["base_url"],
                                             transport=httpx.MockTransport(handler))
            return await ask(client, "return data", model=model, schema={"type": "object", "required": ["ok"]})
    result = asyncio.run(go())
    assert result.status == "ok" and result.data == {"ok": True}
    assert seen[0]["model"] == config.MODELS[model]["api_id"]
    expected = {"enabled": True}
    effort = config.MODELS[model].get("default_reasoning_effort")
    if effort:
        expected["effort"] = effort
    assert seen[0]["reasoning"] == expected
