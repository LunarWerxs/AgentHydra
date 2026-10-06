"""ChatGPT-only cookies encrypted for the current Windows user; no web cache."""

import json
from pathlib import Path

from ..errors import ClaudeError
from ..state import STATE_DIR, atomic_write, dpapi


MAGIC = b"CLAUDFREE-CHATGPT-DPAPI-1\x00"


def allowed_domain(value: str) -> bool:
    host = value.lstrip(".").lower()
    return (
        host == "chatgpt.com"
        or host.endswith(".chatgpt.com")
        or host == "auth.openai.com"
        or host.endswith(".auth.openai.com")
    )


def filter_state(value: dict) -> dict:
    """Keep account cookies, excluding unrelated sites and cached web-app storage."""
    return {
        "cookies": [c for c in value.get("cookies", []) if allowed_domain(c.get("domain", ""))],
        "origins": [],
    }


class ChatGPTState:
    def __init__(self, directory: str | Path | None = None):
        self.directory = Path(directory or STATE_DIR / "chatgpt").expanduser().resolve()
        self.session_file = self.directory / "session.dpapi"

    def save(self, value: dict):
        raw = json.dumps(filter_state(value), ensure_ascii=False).encode("utf-8")
        atomic_write(self.session_file, MAGIC + dpapi(raw))

    def load(self) -> dict | None:
        if not self.session_file.exists():
            return None
        data = self.session_file.read_bytes()
        if not data.startswith(MAGIC):
            raise ClaudeError(
                "Invalid ChatGPT session file. Sign in again.", code="invalid_session"
            )
        try:
            decoded = json.loads(dpapi(data[len(MAGIC) :], decrypt=True))
            result = filter_state(decoded)
            # Upgrade old browser snapshots once. The caller's normal session lock
            # serializes this with login and requests.
            if decoded.get("origins"):
                self.save(result)
            return result
        except (ValueError, TypeError, AttributeError):
            raise ClaudeError(
                "Invalid ChatGPT session data. Sign in again.", code="invalid_session"
            ) from None
