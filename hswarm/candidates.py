"""Turning distilled facts into memory candidates for triage: one candidate per fact, in the shape
triage.parse_candidate reads from a one-fact file, and never with a secret shape inside."""
from __future__ import annotations

import re

from .transcripts import redact


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:80] or "fact"


def fact_candidates(session: dict, facts: list[dict]) -> list[dict]:
    """`file` is `<session date>-<slug>.md`, the slug triage saves the memory under; the body carries
    the evidence line, and `source` the session anchor triage's admission gate checks."""
    out = []
    named: set[str] = set()
    for f in facts:
        _, leaks = redact(f"{f.get('description', '')}\n{f.get('body', '')}\n{f.get('evidence', '')}")
        if leaks:
            continue  # secret-shaped content never goes on, even post-redaction
        name = stem = _slug(str(f.get("name") or f.get("description") or "fact"))
        for n in range(2, len(facts) + 2):
            if name not in named:
                break
            name = f"{stem}-{n}"  # two facts of THIS call slug alike: the second is its own fact, not an earlier copy
        named.add(name)
        out.append({
            "file": f"{session['date']}-{name}.md",
            "name": name,
            "description": str(f.get("description", "")).strip().replace(chr(10), " "),
            "type": str(f.get("type") or "project"),
            "confidence": f"{float(f.get('confidence') or 0):.2f}",
            "source": f"session {session['session_id']} ({session['date']})",
            "body": f"{str(f.get('body', '')).strip()}\n\n**Evidence:** {str(f.get('evidence', '')).strip()}",
        })
    return out
