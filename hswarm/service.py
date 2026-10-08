"""Capability-specific REST operations for speech, media, search and application providers.

The provider TOML declares the endpoint, method, input/response type and API-key header. Payloads
follow that provider's documented schema; this adapter never turns them into chat completions.
One client retains one key so an asynchronous job is polled with the account which created it.
POSTs are sent once: retrying an ambiguous result can create and charge for a second generation. A key the provider
refused before doing anything (invalid, out of balance, rate-limited) is marked, and a client that holds no key yet
sends the same request on another one.
A call takes its key through the provider's [limits] (keylimits); a client that names no key starts its pool at a
random key, because each `hswarm service` call is its own process and every one of them used to take the first key.
"""
from __future__ import annotations

import json
import random
import re
import string
from collections.abc import Collection
from pathlib import Path
from urllib.parse import quote

import httpx

from . import config, egress, keylimits, redaction
from .client import _OUT_OF_CREDIT_429, KeyPool, NoUsableKey
from .provider_auth import request_headers
from .usage import ApiError

# How many keys one call may try when each refuses it before doing anything. Measured 2026-10-07: 12 of 20 sampled Jina
# keys refused (10 out of balance, 2 invalid), so one try failed more often than it answered; eight leave about 2 in 100.
REFUSED_TRIES = 8


def describe(provider: str) -> dict:
    if provider not in config.PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")
    spec = config.PROVIDERS[provider]
    return {"provider": provider, "transport": spec.get("transport", "openai"),
            "capabilities": list(spec.get("capabilities") or ()), "docs": spec.get("docs"),
            "operations": spec.get("operations") or {},
            "note": "Operation payloads follow the linked provider documentation; generation operations may incur charges."}


def _operation(spec: dict, name: str) -> dict:
    op = (spec.get("operations") or {}).get(name)
    if not isinstance(op, dict):
        raise ValueError(f"unknown service operation {name!r}; available: {', '.join(sorted(spec.get('operations') or {}))}")
    if op.get("capability") not in spec.get("capabilities", ()):
        raise ValueError(f"operation {name!r} has no declared provider capability")
    return op


def _path(op: dict, path_params: dict | None) -> str:
    template = op.get("path", "")
    if not template.startswith("/") or template.startswith("//") or "?" in template or "#" in template:
        raise ValueError("service operation path must be a relative API path")
    needed = set()
    for _, field, fmt, conversion in string.Formatter().parse(template):
        if field is not None:
            if not field.isidentifier() or fmt or conversion:
                raise ValueError("service operation has an invalid path placeholder")
            needed.add(field)
    supplied = path_params or {}
    if needed != set(supplied):
        raise ValueError(f"path parameters must be exactly: {', '.join(sorted(needed)) or '(none)'}")
    if any(str(v) in ("", ".", "..") for v in supplied.values()):
        raise ValueError("empty or traversal path parameters are invalid")
    return template.format_map({k: quote(str(v), safe="") for k, v in supplied.items()})


def _base_url(spec: dict, op: dict) -> str:
    """Fixed service hosts or a configured index host; credentials never follow a redirect/foreign origin. Only an
    operation that overrides its target is checked: the provider's own base_url is the person's to set, http included
    (a local mock or a self-hosted runtime)."""
    field = op.get("base_url_field")
    if not field and "base_url" not in op:
        return spec["base_url"].rstrip("/")
    value = spec.get(field) if field else op["base_url"]
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"this operation requires {field!r} in the provider configuration")
    value = value.strip().rstrip("/")
    if field and "://" not in value:
        value = "https://" + value
    try:
        url = httpx.URL(value)
    except httpx.InvalidURL as exc:
        raise ValueError("invalid service target URL") from exc
    # A bare trailing "?" or "#" parses as an empty query or fragment, and would carry the operation's path with it.
    if url.scheme != "https" or not url.host or url.userinfo or url.query or url.fragment or "?" in value or "#" in value:
        raise ValueError("service target must be an HTTPS URL without credentials, query or fragment")
    if field and (url.path not in ("", "/") or url.port not in (None, 443)):
        raise ValueError("configured service host must contain only an HTTPS hostname")
    hosts, pattern = op.get("allowed_hosts"), op.get("allowed_host_pattern")
    if (hosts or pattern) and url.port not in (None, 443):
        raise ValueError("service target is outside this operation's documented HTTPS origin")
    if hosts and url.host not in hosts:
        raise ValueError("service target is outside this operation's documented hosts")
    if pattern and not re.fullmatch(pattern, url.host):
        raise ValueError("configured service host does not match the provider's documented index hosts")
    return str(url).rstrip("/")


class ServiceClient:
    def __init__(self, provider: str, *, api_keys: list[str] | None = None, key_fingerprint: str | None = None,
                 timeout_s: float = 120.0, transport=None):
        if provider not in config.PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}")
        self.provider, self.spec = provider, config.PROVIDERS[provider]
        if not self.spec.get("operations"):
            raise ValueError(f"{provider} has no configured service operations")
        keys = api_keys or config.load_api_keys(provider)
        self.pool = KeyPool(keys, provider, start=random.randrange(len(keys)) if keys else 0)
        # The key this client keeps: the one named by fingerprint, else the one its first call takes (_pick).
        self._key: str | None = None
        if key_fingerprint:
            matches = [k for k in self.pool.keys if config.fingerprint(k) == key_fingerprint]
            if len(matches) != 1:
                raise ValueError("key fingerprint must identify exactly one key in this provider")
            self._key = matches[0]
            if not self.pool.ready(self._key):
                raise ValueError("selected provider key is disabled or resting")
        self._http = httpx.AsyncClient(base_url=self.spec["base_url"], timeout=timeout_s,
                                       transport=transport, follow_redirects=False)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    async def aclose(self):
        await self._http.aclose()

    @property
    def key_fingerprint(self) -> str | None:
        """The fingerprint of the key this client keeps; None before its first call when no key was named."""
        return config.fingerprint(self._key) if self._key else None

    def _pick(self, exclude: Collection[str]) -> str:
        """keylimits.acquire's choice for one call. Until the client holds a key: the pool's next live key outside
        `exclude` (the keys at their [limits]), so a full key never holds up a call another key could take. Once it
        holds one: only that key, because an asynchronous job is polled on the account that created it; a full held
        key is waited on, never swapped (this NoUsableKey is acquire's signal to wait)."""
        if self._key is None:
            return self.pool.pick(exclude=exclude)
        if self._key in exclude:
            raise NoUsableKey(f"the {self.provider} key this client holds is at its [limits]")
        return self._key

    def _refused(self, key: str, response: httpx.Response) -> bool:
        """Marks `key` from a refusal. True when the provider refused the key itself before doing anything (invalid, out of
        balance, rate-limited), so the same request may go to another key; Jina says "Insufficient account balance" with
        a 403, which the pool used to leave in rotation."""
        status, text = response.status_code, response.text or ""
        if status == 401:
            self.pool.rest(key, 30.0, status=401, dead=True)
        elif status == 402 or (status in (403, 429) and _OUT_OF_CREDIT_429.search(text)):
            self.pool.broke(key, status=402)
        elif status == 429:
            try:
                wait_s = float(response.headers.get("retry-after", "30"))
            except ValueError:
                wait_s = 30.0
            self.pool.rest(key, max(1.0, wait_s), status=429)
        else:
            return False
        return True

    async def call(self, operation: str, payload: dict | None = None, *, path_params: dict | None = None,
                   params: dict | None = None, files: dict | None = None, content: bytes | None = None,
                   content_type: str | None = None):
        op = _operation(self.spec, operation)
        if payload and payload.get("stream"):
            raise ValueError("service operations return a complete response; streaming is not supported")
        path = _path(op, path_params)
        target_base = _base_url(self.spec, op)
        method = str(op.get("method", "POST")).upper()
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            raise ValueError("unsupported service operation method")
        encoding = op.get("input", "json")
        typed: dict = {}  # a binary body's Content-Type, applied over the provider's headers once the key is known
        kwargs: dict = {"params": params}
        if method == "GET":
            if files or content is not None:
                raise ValueError("GET operations do not accept a request body")
            kwargs["params"] = {**(payload or {}), **(params or {})}
        elif encoding == "multipart":
            if content is not None:
                raise ValueError("multipart operation requires form fields/files")
            # (None, value) form parts force multipart for text-only image-generation requests too.
            form = [(name, (None, value if isinstance(value, str) else json.dumps(value)))
                    for name, value in (payload or {}).items()]
            form.extend((files or {}).items())
            if not form:
                raise ValueError("multipart operation requires form fields or files")
            kwargs["files"] = form
        elif encoding == "bytes":
            if content is None or payload or files:
                raise ValueError("binary operation requires content bytes only")
            kwargs["content"] = content
            if content_type:
                typed["Content-Type"] = content_type
        elif encoding == "json":
            if files or content is not None:
                raise ValueError("JSON operation does not accept files or binary content")
            if payload is not None:
                kwargs["json"] = payload
        else:
            raise ValueError(f"unsupported service input {encoding!r}")
        target_url = target_base + path
        # A client already holding a key (named, or taken by an earlier call) keeps it: an asynchronous job is polled on its
        # own account. One with none may move on from a refused key; a file part that is a stream could not be sent again.
        movable = self._key is None and not any(hasattr(v[1] if isinstance(v, tuple) else v, "read")
                                                for v in (files or {}).values())
        tried: set[str] = set()
        while True:
            # A key only once the call is known to be valid: one with headroom under the provider's [limits], waiting
            # unsent while it is full; with no [limits], the key at once, as before. Released once, when the reply is in
            # or the send failed.
            key = await keylimits.acquire(self.provider, self._pick, operation, tried)
            try:
                if self._key is None:
                    self._key = key
                kwargs["headers"] = {**(op.get("headers") or {}), **request_headers(self.spec, key), **typed}
                request = self._http.build_request(method, target_url, **kwargs)
                # For multipart, materialise the body once. The receipt holds a hash and length, never a payload/key.
                await request.aread()
                egress.record(target_base + op["path"], request.content, provider=self.provider, model=operation)
                response = await self._http.send(request)
            finally:
                keylimits.release(self.provider, key, operation)
            if response.is_success:
                break
            refused = self._refused(key, response)
            self.pool.flush()
            tried.add(key)
            if movable and refused and len(tried) < REFUSED_TRIES and self.pool.live_besides(tried):
                self._key = None
                continue
            body = response.text
            for secret in self.pool.keys:
                body = body.replace(secret, "[REDACTED_KEY]")
            raise ApiError(response.status_code, redaction.scrub_keys(body), self.provider)
        kind = op.get("response", "json")
        if kind == "bytes":
            return response.content
        if kind == "text":
            return response.text
        if not response.content:
            return None
        return response.json()


def _pairs(values: list[str] | None) -> dict:
    out = {}
    for value in values or ():
        name, sep, text = value.partition("=")
        if not sep or not name or name in out:
            raise ValueError("parameters must be unique NAME=VALUE pairs")
        out[name] = text
    return out


async def cmd_service(a) -> int:
    import sys

    try:
        config.refresh()
        info = describe(a.provider)
        if not a.operation:
            print(json.dumps(info, indent=2))
            return 0
        op = _operation(config.PROVIDERS[a.provider], a.operation)
        path_params, params = _pairs(a.path_param), _pairs(a.param)
        # Check output before a potentially billed request so a binary answer cannot be lost on stdout.
        if op.get("response") == "bytes" and not a.output:
            raise ValueError("this operation returns binary media; provide --output PATH")
        payload = None
        if a.input:
            payload = json.loads(sys.stdin.read() if a.input == "-" else Path(a.input).read_text(encoding="utf-8-sig"))
            if not isinstance(payload, dict):
                raise ValueError("--input must contain a JSON object")
        file_paths = _pairs(a.file)
        files = {name: (Path(path).name, Path(path).read_bytes()) for name, path in file_paths.items()}
        content = Path(a.data_body).read_bytes() if a.data_body else None
        async with ServiceClient(a.provider, key_fingerprint=a.key_fingerprint, timeout_s=a.timeout_s) as client:
            result = await client.call(a.operation, payload, path_params=path_params, params=params, files=files or None,
                                       content=content, content_type=a.content_type)
            used_key = client.key_fingerprint
        if a.output:
            output = Path(a.output)
            if isinstance(result, bytes):
                output.write_bytes(result)
            else:
                output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
            print(json.dumps({"provider": a.provider, "operation": a.operation, "key_fingerprint": used_key,
                              "output": str(output.resolve())}))
        else:
            print(redaction.scrub_keys(json.dumps({"provider": a.provider, "operation": a.operation,
                                                   "key_fingerprint": used_key, "result": result},
                                                  indent=2, ensure_ascii=False)))
        return 0
    except (ValueError, OSError, httpx.HTTPError, RuntimeError) as exc:
        print(redaction.scrub_keys(str(exc)), file=sys.stderr)
        return 1
