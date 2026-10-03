"""Writing distilled facts into the memory staging directory: one file per fact, front-matter
marked `trust: unreviewed`, write-once, and never with a secret shape inside."""
from __future__ import annotations

import re
from pathlib import Path

from .transcripts import redact


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:80] or "fact"


def _staging_doc(session: dict, name: str, f: dict) -> str:
    fm = [
        "---",
        f"name: {name}",
        f"description: {str(f.get('description', '')).strip().replace(chr(10), ' ')}",
        "metadata:",
        f"  type: {f.get('type', 'project')}",
        "  trust: unreviewed",
        f"  confidence: {float(f.get('confidence') or 0):.2f}",
        f"  source: session {session['session_id']} ({session['date']})",
        "---",
        "",
        str(f.get("body", "")).strip(),
        "",
        f"**Evidence:** {str(f.get('evidence', '')).strip()}",
        "",
    ]
    return "\n".join(fm)


def write_staging(out_dir: Path, session: dict, facts: list[dict]) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    named: set[str] = set()
    for f in facts:
        _, leaks = redact(f"{f.get('description', '')}\n{f.get('body', '')}\n{f.get('evidence', '')}")
        if leaks:
            continue  # secret-shaped content never lands, even post-redaction
        name = stem = _slug(str(f.get("name") or f.get("description") or "fact"))
        for n in range(2, len(facts) + 2):
            if name not in named:
                break
            name = f"{stem}-{n}"  # two facts of THIS call slug alike: the second is its own fact, not an earlier copy
        named.add(name)
        p = out_dir / f"{session['date']}-{name}.md"
        if p.exists():
            continue  # write-once: a human may have edited the earlier copy
        p.write_text(_staging_doc(session, name, f), encoding="utf-8")
        written.append(p)
    return written
