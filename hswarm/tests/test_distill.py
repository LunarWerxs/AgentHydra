"""Offline tests for the distiller: redaction, extraction, the candidates it hands to triage."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import distill as dist  # noqa: E402
from hswarm.candidates import fact_candidates  # noqa: E402
from hswarm.distill import extract, redact  # noqa: E402


def test_redact_shapes():
    text = "key sk-abcdefghijklmnopqrstuvwxyz0123 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 mail bob@example.com Bearer abcdefghijklmnopqrstu token=ABCDEFGHIJKLMNOPQRSTUV"
    out, n = redact(text)
    assert "sk-abc" not in out and "ghp_" not in out and "bob@example.com" not in out
    assert "<email>" in out and "<redacted-key>" in out
    assert n >= 4


def test_extract_transcript(tmp_path):
    p = tmp_path / "abc123.jsonl"
    recs = [
        {"type": "user", "timestamp": "2026-09-14T10:00:00Z", "message": {"content": "Never open a visible console window. my key is sk-0123456789abcdefghijk"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Understood."}, {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": "a b c"}]}},
        {"type": "summary", "summary": "ignored"},
    ]
    p.write_text("\n".join(json.dumps(r) for r in recs), encoding="utf-8")
    s = extract(p)
    assert s["session_id"] == "abc123" and s["date"] == "2026-09-14" and s["turns"] == 3
    assert "sk-0123" not in s["text"] and "<redacted-key>" in s["text"]
    assert "[tool Bash: ls]" in s["text"] and "USER: Never open" in s["text"]


def test_fact_candidates_secret_guard_and_shape():
    session = {"session_id": "abc123", "date": "2026-09-14"}
    facts = [
        {"name": "No Visible Console", "description": "Detached runs launch hidden", "type": "feedback", "body": "**Why:** windows die.\n**How to apply:** Start-Process hidden.", "confidence": 0.9, "evidence": "owner said so"},
        {"name": "leaky", "description": "has a key sk-abcdefghijklmnopqrstuvwxyz0123", "type": "reference", "body": "x", "confidence": 0.5, "evidence": "y"},
    ]
    c = fact_candidates(session, facts)
    assert len(c) == 1 and c[0]["file"] == "2026-09-14-no-visible-console.md"
    assert c[0]["confidence"] == "0.90" and c[0]["type"] == "feedback" and c[0]["source"] == "session abc123 (2026-09-14)"
    assert "**Why:**" in c[0]["body"] and "**Evidence:** owner said so" in c[0]["body"]


def test_fact_candidates_keeps_two_facts_whose_names_slug_alike():
    # Regression (a hswarm review, 2026-09-26): the write-once guard dropped the second as an "earlier copy".
    session = {"session_id": "abc123", "date": "2026-09-14"}
    facts = [{"name": n, "description": d, "body": "b", "evidence": "e"} for n, d in (("Fix: CI!", "one"), ("fix ci", "two"))]
    assert [c["file"] for c in fact_candidates(session, facts)] == ["2026-09-14-fix-ci.md", "2026-09-14-fix-ci-2.md"]


def test_live_distill_hands_candidates_to_triage_and_writes_nothing(tmp_path, monkeypatch):
    from types import SimpleNamespace

    transcript = tmp_path / "abcdef123456.jsonl"
    long_turn = "Never open a visible console window on the shared PC. " * 20
    transcript.write_text(json.dumps({"type": "user", "timestamp": "2026-09-14T10:00:00Z", "message": {"content": long_turn}}), encoding="utf-8")
    index = tmp_path / "MEMORY.md"
    index.write_text("- [Other](other.md) - something else\n", encoding="utf-8")
    fact = {"name": "No Visible Console", "description": "Detached runs launch hidden", "type": "feedback", "body": "b", "confidence": 0.9, "evidence": "e"}

    class Workers:
        async def run_batch(self, tasks, concurrency, label):
            return SimpleNamespace(id="job-7", results={t.id: SimpleNamespace(status="ok", data={"facts": [fact]}, error=None) for t in tasks}, summary=lambda: {"cost_usd": 0.0})

        async def aclose(self):
            pass

    handed = {}

    async def fake_triage(cands, index_path, model, concurrency, repos_dir=None, **kw):
        handed.update(cands=cands, index=index_path, **kw)
        return {"would_save": [], "dropped": []}

    monkeypatch.setattr(dist, "JobManager", Workers)
    monkeypatch.setattr(dist.triage, "triage", fake_triage)
    monkeypatch.chdir(tmp_path)
    store = object()
    out = asyncio.run(dist.distill([transcript], True, "deepseek-flash", 2, index=index, dry_run=True, store=store))
    assert out["candidates"] == 1 and out["triage"] == {"would_save": [], "dropped": []}
    assert [c["file"] for c in handed["cands"]] == ["2026-09-14-no-visible-console.md"]
    assert handed["cands"][0]["source"].startswith("session abcdef123456") and handed["index"] == index
    assert handed["dry_run"] is True and handed["store"] is store
    assert sorted(p.name for p in tmp_path.iterdir()) == ["MEMORY.md", "abcdef123456.jsonl"]  # no staging folder
