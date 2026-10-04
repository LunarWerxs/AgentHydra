"""Offline: an empty reply is retried round the upstream host that served it, not on the same route.

Idea adapted from whirlchat/whirl replyRepair.ts (MIT); written fresh.

An empty OpenRouter reply usually comes from one bad host, not the model. The worker's empty-reply retry to the
same model carries that host in provider.ignore; a registry entry that pins its host has nowhere else to go and
sends nothing extra. Seams: agent.run_api_task with a fake client, and ChatClient._chat_body for the request.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import agent  # noqa: E402
from hswarm.client import ChatClient  # noqa: E402
from hswarm.spec import Task  # noqa: E402
from hswarm.usage import ChatResult, Usage  # noqa: E402


def _reply(content: str, host: str) -> ChatResult:
    return ChatResult(message={"role": "assistant", "content": content}, finish_reason="stop", usage=Usage(), model="m",
                      seconds=0.01, cost_usd=0.001, peak=False, raw={"provider": host})


class Fake:
    def __init__(self, replies: list[ChatResult]):
        self.replies, self.seen = list(replies), []

    async def chat(self, messages, **kw):
        self.seen.append(kw)
        return self.replies.pop(0)


def _body(entry: dict, avoid: list[str] | None) -> dict:
    c = ChatClient(api_keys=["sk-test-1"], provider="openrouter")
    return c._chat_body("m", entry, "vendor/m", [{"role": "user", "content": "x"}], tools=None, tool_choice=None, max_tokens=None,
                        thinking=None, reasoning_effort=None, response_format=None, temperature=None, user=None, stop=None,
                        avoid_upstream=avoid)


def test_the_retry_after_an_empty_reply_carries_the_bad_host(tmp_path):
    fake = Fake([_reply("", "X"), _reply("the answer", "Y")])
    task = Task.from_dict({"prompt": "q", "cwd": str(tmp_path), "tools": "none", "model": "deepseek-flash"})
    res, _ = asyncio.run(agent.run_api_task(fake, task))
    assert res.status == "ok" and res.answer == "the answer"
    assert "avoid_upstream" not in fake.seen[0]
    assert fake.seen[1]["avoid_upstream"] == ["X"]


def test_the_host_goes_into_the_provider_ignore_list():
    assert _body({}, None).get("provider") is None
    assert _body({}, ["X"])["provider"] == {"ignore": ["X"]}
    merged = _body({"extra": {"provider": {"ignore": ["Z"], "data_collection": "deny"}}}, ["X", "Z"])["provider"]
    assert merged == {"ignore": ["Z", "X"], "data_collection": "deny"}


def test_a_pinned_route_sends_nothing_extra():
    pin = {"extra": {"provider": {"only": ["Fireworks"], "allow_fallbacks": False}}}
    assert _body(pin, ["X"])["provider"] == {"only": ["Fireworks"], "allow_fallbacks": False}
