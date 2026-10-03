"""A reply whose content is a LIST of parts (Mistral's shape) reads as its text everywhere, never as a list.

Found 2026-09-23: 22 of 49 Mistral mining tasks died with `'list' object has no attribute 'strip'` in the agent loop,
because ChatResult.content handed the raw list to code that calls str methods on it.
"""
from hswarm.usage import ChatResult, Usage


def _reply(content):
    return ChatResult(message={"content": content}, finish_reason="stop", usage=Usage.from_api(None), model="m",
                      seconds=0.0, cost_usd=0.0, peak=False)


def test_list_of_parts_is_its_text_and_thinking_is_left_out():
    parts = [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "hello "}, {"type": "text", "text": "world"}]
    assert _reply(parts).content == "hello world"


def test_a_string_and_nothing_read_as_before():
    assert _reply("plain").content == "plain"
    assert _reply(None).content == ""
    assert _reply([]).content == ""
