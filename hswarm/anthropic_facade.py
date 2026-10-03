# SPDX-License-Identifier: Apache-2.0
# Adapted from vLLM vllm/entrypoints/anthropic/serving.py (Apache-2.0, Copyright contributors to the vLLM project).
# Adapted for hswarm: the request and stream converters only, without the OpenAIServingChat base, behind a
# loopback server that forwards to a provider's OpenAI chat endpoint.
"""Anthropic Messages facade: a `cc` worker (headless Claude Code) on a provider that speaks only OpenAI chat.

WHY: Claude Code talks the Anthropic Messages API and nothing else, so the cc backend could only use a provider
with its own Anthropic endpoint (DeepSeek, Hugging Face, OpenRouter - all paid), while the free groq, gemini and
cerebras legs stayed api-only. A provider whose `anthropic_url` is config.ANTHROPIC_FACADE gets a loopback server
per cc run instead: Claude Code posts /v1/messages to 127.0.0.1, the request is turned into an OpenAI chat request
for the provider's own base_url, and the reply (streamed or not) comes back in Anthropic's shape.

The server holds no key of its own. It forwards the one the worker was launched with, so key rotation, the 402
signature cc.out_of_balance reads ("API Error: 402") and the ledger work exactly as on a native endpoint. It binds
127.0.0.1 on an ephemeral port and lives only as long as the one Claude Code process it serves.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from typing import AsyncIterator, Iterable

import httpx

from . import config

# OpenAI finish_reason -> Anthropic stop_reason.
STOP_REASONS = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use", "function_call": "tool_use", "content_filter": "refusal"}
# Anthropic's error `type` for an upstream status, so Claude Code retries (429, 5xx) and reports (402) as it would natively.
ERROR_TYPES = {400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error",
               404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error"}
# A thinking block needs a signature to be well-formed. An OpenAI endpoint issues none, and a thinking block is never
# replayed upstream (to_chat_request drops it), so this marker only says where the block came from.
SIGNATURE = "hswarm-facade"
UPSTREAM_READ_S = 600.0  # one turn of a slow free leg; the cc task's own timeout bounds the whole run


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


# ---- Anthropic request -> OpenAI chat request ------------------------------------------------------------------


def _text_of(content) -> str:
    """The plain text of a system prompt or a tool result: a string as is, or the text blocks of a block list."""
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def _image_part(block: dict) -> dict | None:
    src = block.get("source") or {}
    if src.get("type") == "base64":
        return {"type": "image_url", "image_url": {"url": f"data:{src.get('media_type') or 'image/png'};base64,{src.get('data', '')}"}}
    if src.get("type") == "url" and src.get("url"):
        return {"type": "image_url", "image_url": {"url": src["url"]}}
    return None


def _user_messages(content) -> list[dict]:
    """One Anthropic user turn as OpenAI messages: every tool_result first, each its own `tool` message (OpenAI wants
    them straight after the assistant's tool_calls), then what the user said as one user message. An image a tool
    returned (a screenshot) cannot ride in a tool message, so it follows as user content."""
    if isinstance(content, str):
        return [{"role": "user", "content": content}]
    out: list[dict] = []
    parts: list[dict] = []
    for b in content or []:
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "tool_result":
            inner = b.get("content")
            text = _text_of(inner) or "(no output)"  # an empty tool message is a 400 on some endpoints
            out.append({"role": "tool", "tool_call_id": b.get("tool_use_id", ""), "content": ("ERROR: " + text) if b.get("is_error") else text})
            if isinstance(inner, list):
                parts += [p for p in (_image_part(x) for x in inner if isinstance(x, dict) and x.get("type") == "image") if p]
        elif kind == "text":
            parts.append({"type": "text", "text": b.get("text", "")})
        elif kind == "image" and (p := _image_part(b)):
            parts.append(p)
    if parts:
        only_text = all(p["type"] == "text" for p in parts)
        out.append({"role": "user", "content": "\n".join(p["text"] for p in parts) if only_text else parts})
    return out


def _assistant_message(content, extras: dict) -> dict:
    """An Anthropic assistant turn as one OpenAI assistant message. Thinking blocks are dropped: no OpenAI field takes
    them back. A tool call gets back any provider `extra_content` the facade saw on it (Gemini's thought signature,
    without which Gemini 3 refuses the next turn of a tool conversation)."""
    if isinstance(content, str):
        return {"role": "assistant", "content": content}
    text, calls = [], []
    for b in content or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            text.append(b.get("text", ""))
        elif b.get("type") == "tool_use":
            call = {"id": b.get("id", ""), "type": "function",
                    "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}}
            if b.get("id") in extras:
                call["extra_content"] = extras[b["id"]]
            calls.append(call)
    msg: dict = {"role": "assistant", "content": "".join(text) if (text or not calls) else None}
    if calls:
        msg["tool_calls"] = calls
    return msg


def _tool_choice(choice) -> str | dict | None:
    kind = (choice or {}).get("type") if isinstance(choice, dict) else None
    if kind == "tool" and choice.get("name"):
        return {"type": "function", "function": {"name": choice["name"]}}
    return {"auto": "auto", "any": "required", "none": "none"}.get(kind)


def _scrub_schema(schema):
    """A tool's input_schema without "$schema". WHY: Claude Code's zod-generated schemas carry a draft-07 "$schema",
    which OpenAI ignores but Gemini's OpenAI endpoint refuses in function parameters with a 400. A property that is
    itself NAMED "$schema" goes too; no Claude Code tool has one."""
    if isinstance(schema, dict):
        return {k: _scrub_schema(v) for k, v in schema.items() if k != "$schema"}
    if isinstance(schema, list):
        return [_scrub_schema(v) for v in schema]
    return schema


def to_chat_request(body: dict, omit: Iterable[str] = (), extras: dict | None = None) -> dict:
    """An Anthropic Messages request as an OpenAI chat request. `omit` names fields the provider refuses
    (PROVIDERS[...]["omit"]); `extras` maps a tool_use id to the provider extra_content it arrived with."""
    extras = extras if extras is not None else {}
    messages: list[dict] = []
    if system := _text_of(body.get("system")):
        messages.append({"role": "system", "content": system})
    for m in body.get("messages") or []:
        if m.get("role") == "assistant":
            messages.append(_assistant_message(m.get("content"), extras))
        else:
            messages.extend(_user_messages(m.get("content")))
    req: dict = {"model": body.get("model"), "messages": messages}
    if body.get("max_tokens"):
        req["max_tokens"] = int(body["max_tokens"])
    for src, dst in (("temperature", "temperature"), ("top_p", "top_p"), ("stop_sequences", "stop")):
        if body.get(src) is not None:
            req[dst] = body[src]
    # A server tool (web_search_...) has no input_schema and nothing upstream to run it, so it is left out.
    tools = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                               "parameters": _scrub_schema(t.get("input_schema") or {"type": "object", "properties": {}})}}
             for t in body.get("tools") or [] if isinstance(t, dict) and t.get("name") and "input_schema" in t]
    if tools:
        req["tools"] = tools
        if (choice := _tool_choice(body.get("tool_choice"))) is not None:
            req["tool_choice"] = choice
    if body.get("stream"):
        req["stream"] = True
        req["stream_options"] = {"include_usage": True}
    for k in omit:
        req.pop(k, None)
    return req


# ---- OpenAI chat reply -> Anthropic message --------------------------------------------------------------------


def _usage(u: dict | None) -> dict:
    """OpenAI usage in Anthropic's fields. input_tokens INCLUDES the cached part: cc._usage reads the miss count as
    input - cache_read, so reporting Anthropic's exclusive figure would have the ledger count cached tokens twice."""
    u = u or {}
    hit = int((u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("prompt_cache_hit_tokens") or 0)
    return {"input_tokens": int(u.get("prompt_tokens") or 0), "cache_read_input_tokens": hit,
            "cache_creation_input_tokens": 0, "output_tokens": int(u.get("completion_tokens") or 0)}


def _arguments(raw) -> dict:
    """A tool call's arguments as the input object. Malformed JSON becomes {}, and the tool's own validation then tells
    the model what was missing, which is what Claude Code would do with a bad native call."""
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw or "{}")
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def to_message(resp: dict, model: str, extras: dict | None = None) -> dict:
    """A non-streamed OpenAI chat completion as one Anthropic message."""
    extras = extras if extras is not None else {}
    choice = (resp.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content: list[dict] = []
    if thinking := msg.get("reasoning_content") or msg.get("reasoning"):
        content.append({"type": "thinking", "thinking": thinking, "signature": SIGNATURE})
    if text := _text_of(msg.get("content")):
        content.append({"type": "text", "text": text})
    for call in msg.get("tool_calls") or []:
        fn = call.get("function") or {}
        tid = call.get("id") or _new_id("toolu")
        if call.get("extra_content"):
            extras[tid] = call["extra_content"]
        content.append({"type": "tool_use", "id": tid, "name": fn.get("name", ""), "input": _arguments(fn.get("arguments"))})
    stop = STOP_REASONS.get(choice.get("finish_reason"), "end_turn")
    if stop == "end_turn" and any(b["type"] == "tool_use" for b in content):
        stop = "tool_use"  # some endpoints (Gemini) finish a tool call with "stop"
    return {"id": _new_id("msg"), "type": "message", "role": "assistant", "model": model,
            "content": content or [{"type": "text", "text": ""}], "stop_reason": stop, "stop_sequence": None,
            "usage": _usage(resp.get("usage"))}


class StreamConverter:
    """OpenAI chat-completion chunks in, Anthropic stream events out as (event, data) pairs. One content block is
    open at a time, closed before the next opens (thinking, text, then each tool call), which is the order Claude
    Code's stream reader expects; a tool call's argument fragments become input_json_delta events."""

    def __init__(self, model: str, extras: dict | None = None, input_tokens: int = 0):
        self.model = model
        # The estimated prompt size message_start reports. Upstream's own count only comes with the last chunk, and a
        # cc worker's cost cap prices each call from the usage it opened with (cc._SpendWatch): at 0 it never tripped.
        self.input_tokens = input_tokens
        self.extras = extras if extras is not None else {}
        self.index = -1
        self.open: tuple[str, object] | None = None
        self.tools: dict[object, str] = {}  # upstream tool-call key -> the tool_use id it was given
        self.finish_reason: str | None = None
        self.usage: dict = {}
        self.started = False
        self.saw_tool = False

    def _start(self) -> list[tuple[str, dict]]:
        self.started = True
        return [("message_start", {"type": "message_start", "message": {
            "id": _new_id("msg"), "type": "message", "role": "assistant", "model": self.model, "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": self.input_tokens, "output_tokens": 0}}})]

    def _close(self) -> list[tuple[str, dict]]:
        if self.open is None:
            return []
        ev = []
        if self.open[0] == "thinking":
            ev.append(("content_block_delta", {"type": "content_block_delta", "index": self.index, "delta": {"type": "signature_delta", "signature": SIGNATURE}}))
        ev.append(("content_block_stop", {"type": "content_block_stop", "index": self.index}))
        self.open = None
        return ev

    def _open(self, kind: str, block: dict, key: object = None) -> list[tuple[str, dict]]:
        ev = self._close()
        self.index += 1
        self.open = (kind, key)
        ev.append(("content_block_start", {"type": "content_block_start", "index": self.index, "content_block": block}))
        return ev

    def _delta(self, delta: dict) -> tuple[str, dict]:
        return ("content_block_delta", {"type": "content_block_delta", "index": self.index, "delta": delta})

    def feed(self, chunk: dict) -> list[tuple[str, dict]]:
        ev = [] if self.started else self._start()
        if chunk.get("usage"):
            self.usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            if thinking := delta.get("reasoning_content") or delta.get("reasoning"):
                if not self.open or self.open[0] != "thinking":
                    ev += self._open("thinking", {"type": "thinking", "thinking": "", "signature": ""})
                ev.append(self._delta({"type": "thinking_delta", "thinking": thinking}))
            if text := delta.get("content"):
                if not self.open or self.open[0] != "text":
                    ev += self._open("text", {"type": "text", "text": ""})
                ev.append(self._delta({"type": "text_delta", "text": text}))
            for n, call in enumerate(delta.get("tool_calls") or []):
                ev += self._tool_call(n, call)
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]
        return ev

    def _tool_call(self, n: int, call: dict) -> list[tuple[str, dict]]:
        # Keyed by the stream index; an endpoint that sends each whole call in one chunk with no index (Gemini) is
        # keyed by its id, and a known index arriving with a DIFFERENT id is a new call, not more of the old one.
        fn = call.get("function") or {}
        key = call["index"] if "index" in call else (call.get("id") or f"#{n}")
        ev: list[tuple[str, dict]] = []
        if key not in self.tools or (call.get("id") and call["id"] != self.tools[key]):
            tid = call.get("id") or _new_id("toolu")
            self.tools[key], self.saw_tool = tid, True
            ev += self._open("tool", {"type": "tool_use", "id": tid, "name": fn.get("name", ""), "input": {}}, key)
        elif self.open != ("tool", key):
            return ev  # arguments for a call already closed; OpenAI streams one call at a time, so this is not expected
        if call.get("extra_content"):
            self.extras[self.tools[key]] = call["extra_content"]
        args = fn.get("arguments")
        if args:
            ev.append(self._delta({"type": "input_json_delta", "partial_json": args if isinstance(args, str) else json.dumps(args)}))
        return ev

    def finish(self) -> list[tuple[str, dict]]:
        ev = [] if self.started else self._start()
        if self.index < 0:
            ev += self._open("text", {"type": "text", "text": ""})  # a reply with no content still carries one block
        ev += self._close()
        stop = STOP_REASONS.get(self.finish_reason or "", "end_turn")
        if stop == "end_turn" and self.saw_tool:
            stop = "tool_use"
        ev.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": _usage(self.usage)}))
        ev.append(("message_stop", {"type": "message_stop"}))
        return ev


def sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def error_body(status: int, message: str) -> dict:
    return {"type": "error", "error": {"type": ERROR_TYPES.get(status, "api_error"), "message": message}}


def estimate_tokens(body: dict) -> int:
    """count_tokens has no OpenAI counterpart, so this is chars/4 over what the request would send: Claude Code
    uses it to judge how full the context is, where a close estimate serves and a 404 would not."""
    return max(1, len(json.dumps([body.get("system"), body.get("messages"), body.get("tools")], ensure_ascii=False)) // 4)


def _upstream_message(text: str, key: str) -> str:
    try:
        err = json.loads(text)
        err = err[0] if isinstance(err, list) and err else err
        msg = (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict) else err.get("error") or err.get("message")
        text = str(msg or text)
    except (ValueError, AttributeError):
        pass
    return (text.replace(key, "***") if key else text)[:800]


async def _sse_data(r: httpx.Response) -> AsyncIterator[dict]:
    async for line in r.aiter_lines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            return
        try:
            data = json.loads(payload)
        except ValueError:
            continue
        if isinstance(data, dict):
            yield data


# ---- the loopback server ---------------------------------------------------------------------------------------


async def _respond(writer: asyncio.StreamWriter, status: int, body: dict, retry_after: str | None = None) -> None:
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    # Claude Code waits as long as Retry-After says on a 429/5xx; the free legs rate-limit often, so theirs is passed on.
    extra = f"Retry-After: {retry_after}\r\n" if retry_after else ""
    writer.write(f"HTTP/1.1 {status} {'OK' if status < 400 else 'Error'}\r\nContent-Type: application/json\r\n{extra}"
                 f"Content-Length: {len(raw)}\r\nConnection: close\r\n\r\n".encode("latin-1") + raw)
    await writer.drain()


class Facade:
    """One loopback Anthropic Messages endpoint in front of one provider's OpenAI chat endpoint, for one cc run.
    `async with Facade("groq") as f:` then point ANTHROPIC_BASE_URL at f.url. One request per connection."""

    def __init__(self, provider: str, transport: httpx.AsyncBaseTransport | None = None):
        self.provider = provider
        self.spec = config.PROVIDERS[provider]
        self.url = ""
        self.extras: dict = {}  # tool_use id -> provider extra_content, kept for the life of the run
        self._transport = transport
        self._server: asyncio.base_events.Server | None = None
        self._http: httpx.AsyncClient | None = None
        self._conns: set[asyncio.Task] = set()

    async def __aenter__(self) -> "Facade":
        self._http = httpx.AsyncClient(base_url=self.spec["base_url"], transport=self._transport,
                                       timeout=httpx.Timeout(UPSTREAM_READ_S, connect=30.0))
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.url = f"http://127.0.0.1:{self._server.sockets[0].getsockname()[1]}"
        return self

    async def __aexit__(self, *exc) -> None:
        self._server.close()
        for t in list(self._conns):  # a request still in flight when Claude Code exited (killed on timeout)
            t.cancel()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._server.wait_closed(), 5)
        await self._http.aclose()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self._conns.add(task)
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1").split("\r\n")
            method, target = (head[0].split(" ") + ["", ""])[:2]
            headers = {k.strip().lower(): v.strip() for k, _, v in (h.partition(":") for h in head[1:] if h)}
            raw = await reader.readexactly(int(headers.get("content-length") or 0))
            path = target.split("?", 1)[0].rstrip("/")
            try:
                body = json.loads(raw or b"{}")
            except ValueError as e:
                return await _respond(writer, 400, error_body(400, f"the request body is not JSON: {e}"))
            if method == "POST" and path.endswith("/v1/messages"):
                await self._messages(body, headers, writer)
            elif method == "POST" and path.endswith("/v1/messages/count_tokens"):
                await _respond(writer, 200, {"input_tokens": estimate_tokens(body)})
            else:
                await _respond(writer, 404, error_body(404, f"the hswarm facade serves POST /v1/messages, not {method} {path}"))
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            pass  # the client went away; nothing to answer
        finally:
            self._conns.discard(task)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def _messages(self, body: dict, headers: dict, writer: asyncio.StreamWriter) -> None:
        key = headers.get("x-api-key") or headers.get("authorization", "").removeprefix("Bearer ").strip()
        model = str(body.get("model") or "")
        try:
            req = to_chat_request(body, self.spec.get("omit") or (), self.extras)
        except (TypeError, AttributeError, KeyError, ValueError) as e:
            return await _respond(writer, 400, error_body(400, f"cannot convert the request: {type(e).__name__}: {e}"))
        auth = {"Authorization": "Bearer " + key, **(self.spec.get("headers") or {})}
        try:
            if not req.get("stream"):
                r = await self._http.post("/chat/completions", json=req, headers=auth)
                if r.status_code >= 400:
                    return await _respond(writer, r.status_code, error_body(r.status_code, _upstream_message(r.text, key)),
                                          r.headers.get("retry-after"))
                try:
                    reply = r.json()
                except ValueError:  # a 200 that is not JSON (a proxy's HTML page) still gets an answer, not a dropped socket
                    return await _respond(writer, 502, error_body(502, f"{self.provider} sent a 200 that is not JSON: {_upstream_message(r.text, key)[:200]}"))
                return await _respond(writer, 200, to_message(reply, model, self.extras))
            async with self._http.stream("POST", "/chat/completions", json=req, headers=auth) as r:
                if r.status_code >= 400:
                    text = (await r.aread()).decode("utf-8", "replace")
                    return await _respond(writer, r.status_code, error_body(r.status_code, _upstream_message(text, key)),
                                          r.headers.get("retry-after"))
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n")
                await self._relay(r, StreamConverter(model, self.extras, estimate_tokens(body)), writer, key)
        except httpx.HTTPError as e:
            await _respond(writer, 502, error_body(502, f"{self.provider} unreachable: {type(e).__name__}: {e}"))

    @staticmethod
    async def _relay(r: httpx.Response, conv: StreamConverter, writer: asyncio.StreamWriter, key: str) -> None:
        """The stream, once its 200 is on the wire: an upstream that breaks or reports an error mid-stream ends it with
        an Anthropic `error` event (Claude Code retries on that), never a silent truncation."""
        try:
            async for data in _sse_data(r):
                if data.get("error"):
                    writer.write(sse("error", error_body(502, _upstream_message(json.dumps(data), key))))
                    return await writer.drain()
                for ev in conv.feed(data):
                    writer.write(sse(*ev))
                await writer.drain()
        except httpx.HTTPError as e:
            writer.write(sse("error", error_body(502, f"upstream stream broke: {type(e).__name__}: {e}")))
            return await writer.drain()
        for ev in conv.finish():
            writer.write(sse(*ev))
        await writer.drain()


@contextlib.asynccontextmanager
async def anthropic_endpoint(provider: str) -> AsyncIterator[str | None]:
    """The Anthropic base URL a cc worker on `provider` talks to: the provider's own, or a facade started for this run
    and stopped when it ends."""
    url = config.PROVIDERS[provider].get("anthropic_url")
    if url != config.ANTHROPIC_FACADE:
        yield url
        return
    async with Facade(provider) as facade:
        yield facade.url
