"""Reading Claude Code session transcripts for the distiller: find them, flatten them to text,
strip tool noise, and REDACT secret shapes and emails before anything leaves the machine."""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path

# Real key prefixes with length floors, so a memory that merely mentions `sk-...` as a pattern is untouched.
SECRET_PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9_-]{10,}"), "<redacted-key>"),
    (re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), "<redacted-github-token>"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "<redacted-slack-token>"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "<redacted-aws-key>"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "<redacted-jwt>"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}"), "Bearer <redacted>"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "<redacted-private-key>"),
    (re.compile(r"(?i)(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}"), r"\1=<redacted>"),
    (re.compile(r"\b[0-9a-f]{40,}\b"), "<redacted-hex>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
]


def redact(text: str) -> tuple[str, int]:
    n = 0
    for rx, rep in SECRET_PATTERNS:
        text, k = rx.subn(rep, text)
        n += k
    return text, n


def _tool_use_text(b: dict) -> str:
    inp = b.get("input") or {}
    brief = inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("prompt") or ""
    return f"[tool {b.get('name') or '?'}: {str(brief)[:160]}]"


def _tool_result_text(b: dict) -> str:
    c = b.get("content")
    s = c if isinstance(c, str) else " ".join((x.get("text") or "") for x in (c or []) if isinstance(x, dict))
    return f"[result: {s[:300]}]"


# A transcript block is kept as a one-line summary of what happened, never its full payload.
BLOCK_TEXT = {"text": lambda b: b.get("text") or "", "tool_use": _tool_use_text, "tool_result": _tool_result_text}


def _block_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = [BLOCK_TEXT[b["type"]](b) for b in content or [] if isinstance(b, dict) and b.get("type") in BLOCK_TEXT]
    return "\n".join(p for p in parts if p)


def _turn_text(rec: dict) -> str | None:
    """The speaker-tagged text of one transcript record, or None when it carries nothing worth keeping."""
    typ = rec.get("type")
    if typ not in ("user", "assistant"):
        return None
    text = _block_text((rec.get("message") or {}).get("content")).strip()
    # Meta records and slash-command echoes are harness plumbing, not conversation.
    if not text or rec.get("isMeta") or text.startswith(("<command-name>", "<local-command")):
        return None
    return f"{typ.upper()}: {text}"


def extract(transcript_path: Path, max_chars: int = 60_000) -> dict:
    """Return {session_id, date, text, turns, redactions} from a Claude Code JSONL transcript."""
    lines: list[str] = []
    date = None
    with transcript_path.open(encoding="utf-8", errors="replace") as f:
        for raw in f:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if date is None and rec.get("timestamp") and rec.get("type") in ("user", "assistant"):
                date = str(rec["timestamp"])[:10]
            line = _turn_text(rec)
            if line:
                lines.append(line)
    body = "\n\n".join(lines)
    if len(body) > max_chars:
        # Keep the opening (the ask) and the ending (the outcome); the middle is where the noise lives.
        body = body[: max_chars * 2 // 3] + "\n\n[... middle omitted ...]\n\n" + body[-(max_chars // 3):]
    body, n = redact(body)
    return {"session_id": transcript_path.stem, "date": date or "unknown", "text": body, "turns": len(lines), "redactions": n, "chars": len(body)}


def find_transcripts(root: Path, since_days: float, project: str | None, exclude: list[str] | None = None) -> list[Path]:
    cutoff = dt.datetime.now().timestamp() - since_days * 86400
    out = []
    for slug in sorted(root.iterdir()) if root.exists() else []:
        if not slug.is_dir() or (project and project.lower() not in slug.name.lower()):
            continue
        if any(x.lower() in slug.name.lower() for x in (exclude or [])):
            continue
        for p in slug.glob("*.jsonl"):
            try:
                if p.stat().st_mtime >= cutoff and p.stat().st_size > 2000:  # under 2 KB is a session that never got going
                    out.append(p)
            except OSError:
                continue
    return sorted(out, key=lambda p: p.stat().st_mtime, reverse=True)
