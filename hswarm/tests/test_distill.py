"""Offline tests for the distiller: redaction, extraction, write-once staging."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm.distill import extract, redact, write_staging  # noqa: E402


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


def test_write_staging_write_once_and_secret_guard(tmp_path):
    session = {"session_id": "abc123", "date": "2026-09-14"}
    facts = [
        {"name": "No Visible Console", "description": "Detached runs launch hidden", "type": "feedback", "body": "**Why:** windows die.\n**How to apply:** Start-Process hidden.", "confidence": 0.9, "evidence": "owner said so"},
        {"name": "leaky", "description": "has a key sk-abcdefghijklmnopqrstuvwxyz0123", "type": "reference", "body": "x", "confidence": 0.5, "evidence": "y"},
    ]
    w = write_staging(tmp_path, session, facts)
    assert len(w) == 1 and w[0].name == "2026-09-14-no-visible-console.md"
    txt = w[0].read_text(encoding="utf-8")
    assert "trust: unreviewed" in txt and "confidence: 0.90" in txt and "**Why:**" in txt
    w[0].write_text("EDITED", encoding="utf-8")
    assert write_staging(tmp_path, session, facts) == []
    assert w[0].read_text(encoding="utf-8") == "EDITED"


def test_write_staging_keeps_two_facts_whose_names_slug_alike(tmp_path):
    # Regression (a hswarm review, 2026-09-26): the write-once guard dropped the second as an "earlier copy".
    session = {"session_id": "abc123", "date": "2026-09-14"}
    facts = [{"name": n, "description": d, "body": "b", "evidence": "e"} for n, d in (("Fix: CI!", "one"), ("fix ci", "two"))]
    w = write_staging(tmp_path, session, facts)
    assert [p.name for p in w] == ["2026-09-14-fix-ci.md", "2026-09-14-fix-ci-2.md"]
