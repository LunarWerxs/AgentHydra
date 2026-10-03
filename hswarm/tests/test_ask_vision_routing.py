"""Offline: an ask that carries images fails over only onto legs that can SEE (2026-09-22).

Found by the Opus 5.5 review of Dredd: with Gemini's free pool spent (a 429 RESOURCE_EXHAUSTED, which is a
failover signal), `ask_routed` walked the tool-using chain on to deepseek-flash-or, glm-4.5-air and
mistral-medium-3.5 - paid, and none of them with eyes - so a screenshot score came back as a text-only
model's guess and was billed. The route is now filtered to vision-capable legs (`vision: true` in the
registry), an ask with no seeing leg left answers an error naming that, and the pictures are encoded once
for the whole walk instead of once per leg.
"""
from __future__ import annotations

import asyncio
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config  # noqa: E402
from hswarm.jobs import JobManager  # noqa: E402
from hswarm.spec import Result  # noqa: E402

# The tool-using chain is CHEAP-ONLY since 2026-09-23: gemini (free, seeing) then deepseek-flash-or
# (already-paid, blind). glm-4.5-air and mistral-medium-3.5 were retired from routing.
_TOOL_CHAIN = ["gemini-3.8-flash", "deepseek-flash-or"]


def _png(tmp_path: Path) -> Path:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return len(body).to_bytes(4, "big") + kind + body + (zlib.crc32(kind + body) & 0xFFFFFFFF).to_bytes(4, "big")

    ihdr = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes([8, 0, 0, 0, 0])
    p = tmp_path / "shot.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00\x80")) + chunk(b"IEND", b""))
    return p


def _manager(monkeypatch, plan: list[str]) -> JobManager:
    m = JobManager(client=object())
    monkeypatch.setattr(m, "route_plan", lambda model: list(plan))
    monkeypatch.setattr(m, "client_for", lambda model: object())
    return m


def _record(monkeypatch, answer):
    import hswarm.agent as agent

    seen: list[tuple[str, list | None]] = []

    async def fake_ask(client, prompt, model=None, images=None, **kw):
        seen.append((model, images))
        return answer(model, images)

    monkeypatch.setattr(agent, "ask", fake_ask)
    return seen


def test_only_gemini_models_are_registered_as_seeing():
    assert config.sees("gemini-3.8-flash")
    for blind in ("deepseek-flash-or", "glm-4.5-air", "mistral-medium-3.5", "groq-gpt-oss-120b", "deepseek-flash"):
        assert not config.sees(blind), blind


def test_a_spent_gemini_pool_does_not_send_the_pictures_to_a_blind_paid_leg(monkeypatch, tmp_path):
    shot = _png(tmp_path)
    seen = _record(monkeypatch, lambda model, images: Result(id="ask", model=model, status="error",
                                                             error="gemini API 429: RESOURCE_EXHAUSTED", cost_usd=0.0))
    r = asyncio.run(_manager(monkeypatch, _TOOL_CHAIN).ask_routed("score", "gemini-3.8-flash", images=[str(shot)]))
    assert [s[0] for s in seen] == ["gemini-3.8-flash"]
    assert r.status == "error" and "RESOURCE_EXHAUSTED" in r.error and r.failover == []


def test_no_seeing_leg_with_credit_answers_an_error_and_calls_nothing(monkeypatch, tmp_path):
    shot = _png(tmp_path)
    seen = _record(monkeypatch, lambda model, images: Result(id="ask", model=model, status="ok", answer="7"))
    # Gemini had no credit, so the plan kept only the paid, blind legs.
    r = asyncio.run(_manager(monkeypatch, _TOOL_CHAIN[1:]).ask_routed("score", "gemini-3.8-flash", images=[str(shot)]))
    assert seen == []
    assert r.status == "error" and "NoVisionLeg" in r.error and "credit" in r.error
    assert r.model == "gemini-3.8-flash"


def test_a_named_blind_model_with_images_is_refused_not_guessed(monkeypatch, tmp_path):
    shot = _png(tmp_path)
    seen = _record(monkeypatch, lambda model, images: Result(id="ask", model=model, status="ok", answer="7"))
    r = asyncio.run(JobManager(client=object()).ask_routed("score", "groq-gpt-oss-120b", route=False, images=[str(shot)]))
    assert seen == []
    assert r.status == "error" and "NoVisionLeg" in r.error and "cannot see" in r.error


def test_the_pictures_are_encoded_once_for_every_leg(monkeypatch, tmp_path):
    shot = _png(tmp_path)

    def answer(model, images):
        if model == "gemini-3.8-flash":
            shot.unlink()  # the file is gone before the second leg: only an up-front encoding survives this
            return Result(id="ask", model=model, status="error", error="gemini API 429: RESOURCE_EXHAUSTED", cost_usd=0.0)
        return Result(id="ask", model=model, status="ok", answer="7", cost_usd=0.0)

    seen = _record(monkeypatch, answer)
    plan = ["gemini-3.8-flash", "deepseek-flash-or", "gemini-3.7-flash"]
    r = asyncio.run(_manager(monkeypatch, plan).ask_routed("score", "gemini-3.8-flash", images=[str(shot)]))
    assert [s[0] for s in seen] == ["gemini-3.8-flash", "gemini-3.7-flash"]
    assert r.status == "ok" and r.failover == ["gemini-3.8-flash"]
    first, second = seen[0][1], seen[1][1]
    assert first == second and first[0].startswith("data:image/png;base64,")


def test_an_ask_without_images_keeps_the_whole_chain(monkeypatch):
    seen = _record(monkeypatch, lambda model, images: Result(id="ask", model=model, status="error",
                                                             error="gemini API 429: RESOURCE_EXHAUSTED")
                   if model == "gemini-3.8-flash" else Result(id="ask", model=model, status="ok", answer="7"))
    r = asyncio.run(_manager(monkeypatch, _TOOL_CHAIN).ask_routed("plain", "gemini-3.8-flash"))
    assert [s[0] for s in seen] == ["gemini-3.8-flash", "deepseek-flash-or"] and r.status == "ok"
