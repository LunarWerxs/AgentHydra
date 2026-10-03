"""Offline: `ask(images=...)` sends pictures as OpenAI-style content parts, and only real ones.

A path is read and base64-encoded by its extension, a data:/http URL passes through, the text part comes
first, a call with no images keeps the plain-string user turn every provider accepts, and a path that is
not an image, or does not exist, is refused by name - never sent as an empty picture that scores fine
(the shape Dredd's rung two relies on, 2026-09-22).
"""
from __future__ import annotations

import asyncio
import base64
import sys
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.agent import ask, image_part, user_content  # noqa: E402
from hswarm.client import ChatResult, Usage  # noqa: E402


def _png_1x1() -> bytes:
    """A valid 1x1 grey PNG built by hand, so the test ships no binary fixture."""

    def chunk(kind: bytes, body: bytes) -> bytes:
        return len(body).to_bytes(4, "big") + kind + body + (zlib.crc32(kind + body) & 0xFFFFFFFF).to_bytes(4, "big")

    ihdr = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes([8, 0, 0, 0, 0])
    idat = zlib.compress(b"\x00\x80")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


class _RecordingClient:
    """Records the messages of the one chat() call and answers with plain text."""

    def __init__(self):
        self.messages = None

    async def chat(self, messages, **kw):
        self.messages = messages
        return ChatResult(
            message={"role": "assistant", "content": "7", "tool_calls": []},
            finish_reason="stop",
            usage=Usage(),
            model="gemini-3.8-flash",
            seconds=0.01,
            cost_usd=0.0,
            peak=False,
        )


def test_a_png_path_becomes_a_base64_data_url_part_after_the_text(tmp_path):
    shot = tmp_path / "front.png"
    shot.write_bytes(_png_1x1())
    client = _RecordingClient()
    asyncio.run(ask(client, "score this", model="gemini-3.8-flash", images=[str(shot)]))
    user = client.messages[-1]
    assert user["role"] == "user"
    assert isinstance(user["content"], list)
    assert user["content"][0] == {"type": "text", "text": "score this"}
    part = user["content"][1]
    assert part["type"] == "image_url"
    url = part["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == _png_1x1()


def test_a_data_url_and_an_http_url_pass_through_untouched():
    parts = user_content("look", ["data:image/jpeg;base64,AAAA", "https://x.example/a.webp"])
    assert parts[1]["image_url"]["url"] == "data:image/jpeg;base64,AAAA"
    assert parts[2]["image_url"]["url"] == "https://x.example/a.webp"


def test_no_images_keeps_the_plain_string_user_turn():
    client = _RecordingClient()
    asyncio.run(ask(client, "plain", model="gemini-3.8-flash"))
    assert client.messages[-1] == {"role": "user", "content": "plain"}
    assert user_content("plain", None) == "plain"
    assert user_content("plain", []) == "plain"


def test_a_non_image_or_a_missing_file_is_refused_by_name(tmp_path):
    txt = tmp_path / "notes.txt"
    txt.write_text("x")
    with pytest.raises(ValueError, match="not an image"):
        image_part(str(txt))
    with pytest.raises(FileNotFoundError, match="image not found"):
        image_part(str(tmp_path / "gone.png"))


def test_the_vision_role_names_a_model_with_eyes():
    assert config.sees(config.resolve_role("vision"))
