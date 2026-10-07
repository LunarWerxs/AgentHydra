"""Provider-specific API-key headers shared by chat and capability-specific REST operations."""
from __future__ import annotations


def request_headers(spec: dict, key: str) -> dict[str, str]:
    header = spec.get("auth_header", "Authorization")
    prefix = spec.get("auth_prefix", "Bearer ")
    headers = dict(spec.get("headers") or {})
    # Credential always wins over a static attribution header; never place it in a URL/query string.
    headers[header] = prefix + key
    return headers
