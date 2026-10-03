"""Offline: egress receipts (egress.py). One content-free, hash-chained line per request body that leaves,
written BEFORE the send; fail-closed sends refuse to go out without one."""
from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import egress  # noqa: E402
from hswarm.client import DeepSeekClient  # noqa: E402

K = ["sk-aaaa1111", "sk-bbbb2222"]


def _client(handler) -> DeepSeekClient:
    c = DeepSeekClient(api_keys=K)
    c._http = httpx.AsyncClient(base_url="https://api.test", transport=httpx.MockTransport(handler), headers={"Content-Type": "application/json"})
    return c


def _ok(req: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
                                     "usage": {"prompt_tokens": 1, "completion_tokens": 1}})


def test_a_chat_post_leaves_a_receipt_hashing_the_exact_bytes_sent_and_no_payload():
    """Contract: the receipt's sha256/bytes are those of the body the host received, and the secret text is not stored."""
    sent: list[bytes] = []

    def handler(req: httpx.Request):
        sent.append(req.content)
        return _ok(req)

    c = _client(handler)
    asyncio.run(c.chat([{"role": "user", "content": "the-secret-transcript-text"}], model="deepseek-flash", thinking=False))
    rows = egress.tail(10)
    assert len(sent) == 1 and len(rows) == 1
    assert rows[0]["sha256"] == hashlib.sha256(sent[0]).hexdigest() and rows[0]["bytes"] == len(sent[0])
    assert rows[0]["sink"] == "deepseek:api.test" and rows[0]["prev"] == ""
    assert "the-secret-transcript-text" not in egress.ledger_path().read_text(encoding="utf-8")
    assert egress.find(rows[0]["sha256"]) == rows


def test_the_chain_verifies_and_an_edited_line_breaks_it_where_it_was_edited():
    """Regression: a receipt edited or dropped after the fact must not pass verify."""
    for i in range(3):
        egress.record("deepseek:api.test", f"body {i}".encode(), provider="deepseek", model="m")
    assert egress.verify() == {"ok": True, "lines": 3, "path": str(egress.ledger_path())}
    lines = egress.ledger_path().read_bytes().splitlines(keepends=True)
    first = json.loads(lines[0])
    first["bytes"] = 999
    lines[0] = json.dumps(first, separators=(",", ":")).encode() + b"\n"
    egress.ledger_path().write_bytes(b"".join(lines))
    rep = egress.verify()
    assert not rep["ok"] and rep["broken_at"] == 2  # line 2's prev no longer matches the edited line 1
    egress.ledger_path().write_bytes(b"".join([lines[0], lines[2]]))
    assert not egress.verify()["ok"]


def test_the_doctors_incremental_verify_still_fails_a_bad_append_and_a_ledger_rewritten_under_it():
    """Regression: the doctor reads only what was appended since its last pass. A broken receipt appended after that
    pass, and a ledger rewritten underneath its cached offset, must still fail rather than ride on the cache."""
    for i in range(3):
        egress.record("deepseek:api.test", f"body {i}".encode(), provider="deepseek", model="m")
    path = egress.ledger_path()
    good = path.read_bytes()
    assert egress.verify(incremental=True) == {"ok": True, "lines": 3, "path": str(path)}
    path.write_bytes(good + b'{"ts":"x","prev":"not the hash of line 3"}\n')
    rep = egress.verify(incremental=True)
    assert not rep["ok"] and rep["broken_at"] == 4
    lines = good.splitlines(keepends=True)
    path.write_bytes(lines[0] + lines[2] + lines[1])  # same size, reordered under the offset the doctor cached
    assert not egress.verify(incremental=True)["ok"]


def test_fail_closed_refuses_the_send_when_the_receipt_cannot_be_written(monkeypatch):
    """Contract: inside fail_closed() (distill/triage) no receipt means no request at all; outside it the send goes on."""
    sent: list[bytes] = []

    def handler(req: httpx.Request):
        sent.append(req.content)
        return _ok(req)

    def broken(entry):
        raise OSError("disk full")

    monkeypatch.setattr(egress, "_append", broken)
    monkeypatch.delenv("HSWARM_EGRESS_STRICT", raising=False)

    async def strict_call():
        with egress.fail_closed():
            await _client(handler).chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False)

    with pytest.raises(egress.EgressReceiptFailed, match="EGRESS_RECEIPT_FAILED"):
        asyncio.run(strict_call())
    assert sent == []
    asyncio.run(_client(handler).chat([{"role": "user", "content": "x"}], model="deepseek-flash", thinking=False))
    assert len(sent) == 1  # fail-open by default: a swarm job never dies for want of a receipt
