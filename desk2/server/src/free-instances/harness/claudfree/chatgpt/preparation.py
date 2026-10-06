"""Encrypted, short-lived, single-use website preparations. No browser imports.

All operations run under the provider's existing session lock. A credential is
removed durably before POST, including when the network later rejects the send.
"""

import hashlib
import json
import math
import time

from ..errors import ClaudeError
from ..state import atomic_write, dpapi

MAGIC = b"CLAUDFREE-CHATGPT-PREPARED-1\x00"
MAX_PREPARATIONS = 8
MAX_AGE = 300  # Conservative local cutoff, not a promise of service validity.
HEADER_NAMES = frozenset(
    {
        "openai-sentinel-chat-requirements-token",
        "openai-sentinel-chat-requirements-prepare-token",
        "openai-sentinel-proof-token",
        "openai-sentinel-turnstile-token",
        "openai-sentinel-so-token",
        "openai-sentinel-token",
        "user-agent",
        "oai-device-id",
        "oai-language",
    }
)


def account_key(user_id):
    if not isinstance(user_id, str) or not user_id:
        raise ClaudeError("The signed-in account could not be identified.", code="invalid_response")
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def verification_headers(headers):
    """Allow only verification and its ordinary browser context, never cookies/auth."""
    if not isinstance(headers, dict):
        raise ValueError()
    selected = {}
    for key, value in headers.items():
        if not isinstance(key, str) or key.lower() not in HEADER_NAMES:
            continue
        if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
            raise ValueError()
        selected[key.lower()] = value
    if (
        not any(
            selected.get(key)
            for key in (
                "openai-sentinel-chat-requirements-token",
                "openai-sentinel-chat-requirements-prepare-token",
                "openai-sentinel-token",
            )
        )
        or sum(len(value) for value in selected.values()) > 1024 * 1024
    ):
        raise ValueError()
    return selected


def needs_preparation():
    return ClaudeError(
        "Fresh verification is needed. Run prepare --provider chatgpt --count 3; its JavaScript runtime closes before HTTP sending. No browser is required after login. No message was sent.",
        code="preparation_required",
    )


class Preparations:
    def __init__(self, directory, *, clock=time.time):
        self.path = directory / "prepared.dpapi"
        self.clock = clock

    def clear(self):
        self.path.unlink(missing_ok=True)

    def _load(self):
        if not self.path.exists():
            return {"account": None, "requests": []}
        try:
            data = self.path.read_bytes()
            if not data.startswith(MAGIC):
                raise ValueError()
            body = json.loads(dpapi(data[len(MAGIC) :], decrypt=True))
            if (
                not isinstance(body, dict)
                or not isinstance(body.get("account"), str)
                or len(body["account"]) != 64
                or not isinstance(body.get("requests"), list)
                or len(body["requests"]) > MAX_PREPARATIONS
            ):
                raise ValueError()
            for entry in body["requests"]:
                stamp = entry["created_at"]
                if (
                    isinstance(stamp, bool)
                    or not isinstance(stamp, (int, float))
                    or not math.isfinite(stamp)
                ):
                    raise ValueError()
                entry["headers"] = verification_headers(entry["headers"])
            return body
        except (ValueError, TypeError, KeyError, AttributeError, ClaudeError):
            raise ClaudeError(
                "Prepared verification is invalid. Run prepare --provider chatgpt again.",
                code="preparation_invalid",
            ) from None

    def _save(self, body):
        if not body["requests"]:
            self.clear()
        else:
            atomic_write(self.path, MAGIC + dpapi(json.dumps(body).encode("utf-8")))

    def replace(self, account, entries):
        if (
            not isinstance(account, str)
            or len(account) != 64
            or not 1 <= len(entries) <= MAX_PREPARATIONS
        ):
            raise ClaudeError("Invalid preparation batch.", code="invalid_arguments")
        body = {"account": account, "requests": []}
        try:
            for entry in entries:
                stamp = entry["created_at"]
                if (
                    isinstance(stamp, bool)
                    or not isinstance(stamp, (int, float))
                    or not 0 <= self.clock() - stamp < MAX_AGE
                ):
                    raise ValueError()
                body["requests"].append(
                    {"created_at": stamp, "headers": verification_headers(entry["headers"])}
                )
        except (ValueError, TypeError, KeyError):
            raise ClaudeError(
                "The preparation batch was not valid.", code="preparation_invalid"
            ) from None
        self._save(body)

    def status(self):
        now = self.clock()
        entries = self._load()["requests"]
        ready = [e for e in entries if 0 <= now - e["created_at"] < MAX_AGE]
        return {
            "source": "local_preparation_pool",
            "is_usage_allowance": False,
            "ready_messages": len(ready),
            "expired_messages": len(entries) - len(ready),
            "next_expires_in_seconds": max(0, int(ready[0]["created_at"] + MAX_AGE - now))
            if ready
            else None,
            "local_max_age_seconds": MAX_AGE,
            "single_use": True,
            "browser_required_for_refresh": False,
            "service_acceptance_guaranteed": False,
        }

    def require_available(self):
        if not self.status()["ready_messages"]:
            self.clear()
            raise needs_preparation()

    def take(self, account):
        body = self._load()
        if body["requests"] and body["account"] != account:
            raise ClaudeError(
                "Prepared verification belongs to a different login. Run prepare --provider chatgpt again.",
                code="preparation_account_mismatch",
            )
        now = self.clock()
        ready = [e for e in body["requests"] if 0 <= now - e["created_at"] < MAX_AGE]
        if not ready:
            self.clear()
            raise needs_preparation()
        entry, body["requests"] = ready[0], ready[1:]
        try:
            self._save(body)
        except (OSError, ClaudeError):
            raise ClaudeError(
                "Could not consume verification safely. No message was sent.",
                code="preparation_save_failed",
            ) from None
        return entry["headers"]
