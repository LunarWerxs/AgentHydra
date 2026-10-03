"""Offline: what a refused or exhausted leg leaves behind for the next call and the next task (client._post,
selection's marks), and the egress receipts written on the way out (egress.py: off the loop, one segment a day)."""
from __future__ import annotations

import asyncio
import hashlib
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import config, egress, selection  # noqa: E402
from hswarm.client import DeepSeekClient  # noqa: E402
from hswarm.jobs import leg_unavailable, too_large  # noqa: E402
from hswarm.spec import Result  # noqa: E402
from hswarm.usage import ApiError  # noqa: E402

SMALL, BIG = "sk-orgsmall0000xxxx", "sk-orgbig00000xxxx"
ASK = [{"role": "user", "content": "x"}]
LARGE = [{"role": "user", "content": "x" * 80_000}]  # about 20,000 tokens at four bytes a token
# Groq's own wording for the two refusals (the 413 from jobs 20260926-050510-e32e, the 429 from the legs of 2026-10-01).
TPM_413 = ("Request too large for model `qwen/qwen3.8-27b` in organization `org_small` service tier `on_demand` on "
           "tokens per minute (TPM): Limit 6000, Requested 20000, please reduce your message size and try again.")
OTPM_429 = ("Request too large for model `qwen/qwen3.8-27b` in organization `org_small` service tier `on_demand` on "
            "output tokens per minute (OTPM): Limit 1000, Requested 16000, please reduce your message size and try again.")


def _client(handler) -> DeepSeekClient:
    c = DeepSeekClient(api_keys=[SMALL, BIG])
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def _ok(req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


def _refusal(status: int, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"message": message, "type": "tokens", "code": "rate_limit_exceeded"}})


def _key(req: httpx.Request) -> str:
    return req.headers["Authorization"].removeprefix("Bearer ")


def _failed(error: Exception) -> Result:
    return Result(id="t", status="error", model="deepseek-flash", error=str(error))


def test_a_leg_that_ends_with_every_key_rate_limited_marks_its_model_and_its_provider():
    """Week to 2026-10-02: 7,878 legs ended "every key is rate-limited" after their 30 s and left no mark, so the next
    task ranked the same exhausted model first (872 of 1,862 gemini-3-8-flash first legs). The error is the client's
    own, taken from a real give-up, so the mark cannot drift from the words that set it."""
    c = _client(lambda req: httpx.Response(429, json={"error": {"message": "Rate limit reached"}}))
    with pytest.raises(ApiError) as refused:
        asyncio.run(c.chat(ASK, model="deepseek-flash", thinking=False, rest_budget_s=0.0))
    res = _failed(refused.value)
    selection.note_speed("deepseek-flash", res)
    assert selection.crawling("deepseek-flash"), res.error
    # A leg beside it that found a free key and finished fast says nothing about the quota being back.
    selection.note_speed("deepseek-flash", Result(id="u", status="ok", model="deepseek-flash", seconds=1.0, turns=1))
    assert selection.crawling("deepseek-flash")
    assert not selection.crawling("deepseek-flash", now=time.time() + config.SLOW_MARK_S + 1)  # and it still ages out
    selection.note_result("deepseek", res.error, now=100.0)
    assert selection.pressure("deepseek", 4, now=101.0) == 0.25


def test_a_429_request_too_large_fails_over_at_once_resting_no_key_and_marking_no_model():
    """Since 2026-09-30: 539 qwen3.8-27b legs on Groq got 429 "Request too large ... output tokens per minute", which
    rested every key it touched, halved the leg's gate and waited 30 s. No wait and no other key fits that call. It
    must fail over as an unavailable leg, never as a too-large PROMPT, and never mark the model for everyone else."""
    seen, halved = [], []

    def handler(req):
        seen.append(_key(req))
        return _refusal(429, OTPM_429)

    c = _client(handler)
    c.gate = SimpleNamespace(ok=lambda: None, saturated=lambda: halved.append(1))
    with pytest.raises(ApiError) as refused:
        asyncio.run(c.chat(ASK, model="deepseek-flash", thinking=False, rest_budget_s=1.0))
    assert len(seen) == 1 and c.pool.available() == 2 and not halved, seen
    res = _failed(refused.value)
    assert leg_unavailable(res) and not too_large(res) and "OTPM" in res.error, res.error
    selection.note_speed("deepseek-flash", res)
    assert not selection.crawling("deepseek-flash")


def test_a_key_whose_account_refused_a_size_is_not_sent_that_size_again_for_that_model():
    """2026-10-01/02: Groq took 88,906 POSTs for 4,986 distinct bodies, because the keys a 413 found too small were
    forgotten when the call ended and every later turn sent its whole body to them again. The limit is per key AND
    model (Groq's is per organisation per model), and a request that fits still goes to the key."""
    seen: list[str] = []

    def handler(req):
        seen.append(_key(req))
        if _key(req) == SMALL and len(req.content) > 24_000:
            return _refusal(413, TPM_413)
        return _ok(req)

    c = _client(handler)

    async def go():
        await c.chat(LARGE, model="deepseek-flash", thinking=False)
        await c.chat(LARGE, model="deepseek-flash", thinking=False)
        first_two = list(seen)
        await c.chat(LARGE, model="deepseek-v4-pro", thinking=False)
        await c.chat(ASK, model="deepseek-flash", thinking=False)
        return first_two

    first_two = asyncio.run(go())
    assert first_two == [SMALL, BIG, BIG], first_two  # the second call went straight to the key that fits
    assert seen.count(SMALL) == 3, seen  # once more for the other model, and once for the request that fits it
    assert c.pool.available() == 2  # never rested: the small key is fine for a smaller request


def test_a_request_no_key_is_known_to_fit_is_not_sent_and_still_fails_over_as_too_large():
    seen: list[str] = []

    def handler(req):
        seen.append(_key(req))
        return _refusal(413, TPM_413)

    c = _client(handler)

    async def go():
        errors = []
        for _ in range(2):
            try:
                await c.chat(LARGE, model="deepseek-flash", thinking=False)
            except ApiError as e:
                errors.append(e)
        return errors

    errors = asyncio.run(go())
    assert sorted(seen) == sorted([SMALL, BIG]), seen  # each key once, on the first call; the second sent nothing
    assert len(errors) == 2 and errors[1].status == 413 and too_large(_failed(errors[1])), errors


def test_a_slow_receipt_write_does_not_hold_the_event_loop(monkeypatch):
    """Every POST appended its receipt under a file lock ON the loop, 272k times a day on the shared server, so one
    slow append stalled every task in the process. Nothing else on the loop may wait for it."""
    monkeypatch.setattr(egress, "_append", lambda entry: time.sleep(0.3))

    async def go():
        ticks = 0

        async def tick():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        ticking = asyncio.create_task(tick())
        await _client(_ok).chat(ASK, model="deepseek-flash", thinking=False)
        ticking.cancel()
        return ticks

    assert asyncio.run(go()) >= 5


def test_receipts_roll_into_a_segment_a_day_and_the_chain_spans_them_packed_or_not(monkeypatch):
    """One egress.jsonl only grew (71 MiB a day, 446 MiB by 2026-10-02). A day is a segment now, earlier days are
    packed, and none of that may cost a receipt or the chain: a day dropped from the middle must still be seen."""
    def on(day: str, body: bytes) -> dict:
        monkeypatch.setattr(egress, "_today", lambda: day)
        return egress.record("deepseek:api.test", body, provider="deepseek", model="m")

    first = on("20261001", b"day one")
    on("20261002", b"day two")
    on("20261002", b"day two again")
    assert [p.name for p in egress.segments()] == ["egress-20261001.jsonl", "egress-20261002.jsonl"]
    day_one = (config.HOME / "egress-20261001.jsonl").read_bytes().rstrip(b"\n")
    assert egress.tail(10)[1]["prev"] == hashlib.sha256(day_one).hexdigest()  # day two's first line chains to day one
    assert egress.verify() == {"ok": True, "lines": 3, "path": str(egress.ledger_path())}

    assert egress.compact()["packed"] == 1
    assert [p.name for p in egress.segments()] == ["egress-20261001.jsonl.xz", "egress-20261002.jsonl"]
    assert egress.verify()["ok"] and egress.verify()["lines"] == 3
    assert egress.find(first["sha256"]) == [first] and len(egress.tail(10)) == 3

    on("20261003", b"day three")
    assert egress.verify()["ok"]
    (config.HOME / "egress-20261002.jsonl").unlink()
    rep = egress.verify()
    assert not rep["ok"] and rep["broken_at"] == 1 and rep["path"].endswith("egress-20261003.jsonl"), rep


def test_a_legacy_ledger_started_again_after_its_pack_hides_nothing(monkeypatch):
    packed, plain = config.HOME / "egress.jsonl.xz", config.HOME / "egress.jsonl"
    config.HOME.mkdir(parents=True, exist_ok=True)
    import lzma
    import os
    import time

    packed.write_bytes(lzma.compress(b'{"old": 1}\n'))
    old = time.time() - 3 * 86400
    os.utime(packed, (old, old))
    plain.write_text('{"new": 1}\n', encoding="utf-8")  # an old build appending after the pack
    os.utime(plain, (old + 3600, old + 3600))

    assert [p.name for p in egress.segments()] == ["egress.jsonl.xz", "egress.jsonl"]
    egress.compact()
    assert lzma.decompress(packed.read_bytes()) == b'{"old": 1}\n' and plain.is_file()
