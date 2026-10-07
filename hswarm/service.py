"""Capability-specific REST operations for speech, media, search and application providers.

The provider TOML declares the endpoint, method, input/response type and API-key header. Payloads
follow that provider's documented schema; this adapter never turns them into chat completions.
One client retains one key so an asynchronous job is polled with the account which created it.
POSTs are sent once: retrying an ambiguous result can create and charge for a second generation.
"""
from __future__ import annotations

import json
import string
from pathlib import Path
from urllib.parse import quote

import httpx

from . import config, egress, redaction
from .client import KeyPool
from .provider_auth import request_headers
from .usage import ApiError


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


class ServiceClient:
    def __init__(self, provider: str, *, api_keys: list[str] | None = None, key_fingerprint: str | None = None,
                 timeout_s: float = 120.0, transport=None):
        if provider not in config.PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}")
        self.provider, self.spec = provider, config.PROVIDERS[provider]
        if not self.spec.get("operations"):
            raise ValueError(f"{provider} has no configured service operations")
        self.pool = KeyPool(api_keys or config.load_api_keys(provider), provider)
        if key_fingerprint:
            matches = [k for k in self.pool.keys if config.fingerprint(k) == key_fingerprint]
            if len(matches) != 1:
                raise ValueError("key fingerprint must identify exactly one key in this provider")
            self._key = matches[0]
            if not self.pool.ready(self._key):
                raise ValueError("selected provider key is disabled or resting")
        else:
            self._key = self.pool.pick()
        self._http = httpx.AsyncClient(base_url=self.spec["base_url"], timeout=timeout_s,
                                       transport=transport, follow_redirects=False)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    async def aclose(self):
        await self._http.aclose()

    @property
    def key_fingerprint(self) -> str:
        return config.fingerprint(self._key)

    async def call(self, operation: str, payload: dict | None = None, *, path_params: dict | None = None,
                   params: dict | None = None, files: dict | None = None, content: bytes | None = None,
                   content_type: str | None = None):
        op = _operation(self.spec, operation)
        if payload and payload.get("stream"):
            raise ValueError("service operations return a complete response; streaming is not supported")
        path = _path(op, path_params)
        method = str(op.get("method", "POST")).upper()
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            raise ValueError("unsupported service operation method")
        encoding = op.get("input", "json")
        headers = {**(op.get("headers") or {}), **request_headers(self.spec, self._key)}
        kwargs: dict = {"headers": headers, "params": params}
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
                headers["Content-Type"] = content_type
        elif encoding == "json":
            if files or content is not None:
                raise ValueError("JSON operation does not accept files or binary content")
            if payload is not None:
                kwargs["json"] = payload
        else:
            raise ValueError(f"unsupported service input {encoding!r}")
        request = self._http.build_request(method, path, **kwargs)
        # For multipart, materialise the body once. The receipt holds a hash and length, never a payload/key.
        await request.aread()
        egress.record(self.spec["base_url"] + op["path"], request.content, provider=self.provider, model=operation)
        response = await self._http.send(request)
        if not response.is_success:
            if response.status_code == 401:
                self.pool.rest(self._key, 30.0, status=401, dead=True)
            elif response.status_code == 402:
                self.pool.broke(self._key, status=402)
            elif response.status_code == 429:
                try:
                    wait_s = float(response.headers.get("retry-after", "30"))
                except ValueError:
                    wait_s = 30.0
                self.pool.rest(self._key, max(1.0, wait_s), status=429)
            self.pool.flush()
            body = response.text
            for key in self.pool.keys:
                body = body.replace(key, "[REDACTED_KEY]")
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
