"""Anthropic's native Messages API for the `api` backend: what a provider with `transport = "anthropic"` speaks.

WHY: Anthropic's OpenAI-compatible endpoint does not cache prompts (its own docs: "Prompt caching is not
supported", and `usage.prompt_tokens_details` is always empty). Measured 2026-10-01 from that night's jobs: 1,513
Claude tasks of 3+ turns on the api backend carried 147.4M input tokens with 0 of them cached, every turn re-sending
the whole transcript at full price. The native endpoint takes `cache_control` breakpoints and reports
`cache_read_input_tokens`, so a turn pays a tenth (a twentieth on Opus 5.5) for everything the last turn sent.

The worker loop keeps speaking OpenAI chat. This module turns one OpenAI-shaped request into a Messages request and
the reply back into an OpenAI-shaped message, so agent.py, the ledger and failover see no difference.

Breakpoints (the API allows 4; this sets 3): the end of the system prompt, which caches tools + system for every task
on that key's organisation that shares them, and (not on a one-shot ask) the last block of each of the last two user turns. The newest one is
written; the one before it is where the previous turn wrote, so it is read even when a turn appends more blocks than
the API's 20-block lookback. A cache belongs to one organisation, so the client keeps a task on one key
(`sticky_keys`, client.ChatClient._pick).

Every block is built fresh from the transcript on every call, the same bytes for the same history, and the
breakpoints are set on those copies only: the transcript itself is never touched.

Thinking blocks are not sent back, as on the OpenAI-compatible route this replaces. Replaying them would bill the
model's earlier reasoning as input on every later turn, and hswarm's context editor rewrites old tool results, which
the API's history check (preserved thinking) would refuse on the newest accounts.
"""
from __future__ import annotations

import json
import re

from .usage import Usage

VERSION = "2023-06-01"  # the `anthropic-version` header every Messages request carries
PATH = "/v1/messages"
# Anthropic's effort levels. Anything else a caller sends (`minimal`, `none`) is left out, so the model's default runs.
EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_MAX_TOKENS = 16_000  # the field is required here; Task.max_tokens' own default
CACHE = {"type": "ephemeral"}  # the 5-minute cache: turns of one task start well inside it, and a write costs 1.25x, not 2x
STOP_REASONS = {"end_turn": "stop", "stop_sequence": "stop", "pause_turn": "stop", "tool_use": "tool_calls",
                "max_tokens": "length", "model_context_window_exceeded": "length", "refusal": "content_filter"}
_ILLEGAL_ID_CHARS = re.compile(r"[^a-zA-Z0-9_-]")


def _tool_id(raw) -> str:
    """A tool_use id Anthropic accepts (^[a-zA-Z0-9_-]+$), the same for a call and its result, every turn."""
    return _ILLEGAL_ID_CHARS.sub("_", str(raw or "")) or "call"


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text") or "" for p in content or [] if isinstance(p, dict) and p.get("type", "text") == "text")


def _image(part: dict) -> dict | None:
    url = str(((part.get("image_url") or {}).get("url")) or "")
    head, sep, data = url.partition(";base64,")
    if url.startswith("data:") and sep:
        return {"type": "image", "source": {"type": "base64", "media_type": head[5:] or "image/png", "data": data}}
    if url.startswith(("http://", "https://")):
        return {"type": "image", "source": {"type": "url", "url": url}}
    return None


def _blocks(content) -> list[dict]:
    """User content (a string or OpenAI parts) as Anthropic blocks: text and images; empty text dropped (a 400)."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    out: list[dict] = []
    for p in content or []:
        if not isinstance(p, dict):
            continue
        if p.get("type", "text") == "text" and p.get("text"):
            out.append({"type": "text", "text": p["text"]})
        elif p.get("type") == "image_url" and (img := _image(p)):
            out.append(img)
    return out


def _tool_result(m: dict) -> dict:
    block = {"type": "tool_result", "tool_use_id": _tool_id(m.get("tool_call_id"))}
    c = m.get("content")
    if isinstance(c, list):
        if parts := _blocks(c):
            block["content"] = parts
    elif c:
        block["content"] = str(c)
    return block


def _assistant(m: dict) -> list[dict]:
    out: list[dict] = []
    if text := _text_of(m.get("content")):
        out.append({"type": "text", "text": text})
    for call in m.get("tool_calls") or ():
        fn = call.get("function") or {}
        args = fn.get("arguments")
        try:
            data = json.loads(args) if isinstance(args, str) else args
        except ValueError:
            data = None
        if not isinstance(data, dict):
            data = {} if args in (None, "") else {"_unparsed": str(args)}
        out.append({"type": "tool_use", "id": _tool_id(call.get("id")), "name": str(fn.get("name") or ""), "input": data})
    return out


def _turns(messages: list[dict]) -> tuple[str, list[dict]]:
    """(system text, alternating Messages turns). Every system message is hoisted and joined with a newline, as the
    OpenAI-compatible endpoint did; tool results and user text fold into one user turn, tool results first."""
    system: list[str] = []
    turns: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            if text := _text_of(m.get("content")):
                system.append(text)
            continue
        if role == "assistant":
            blocks, want = _assistant(m), "assistant"
        elif role == "tool":
            blocks, want = [_tool_result(m)], "user"
        else:
            blocks, want = _blocks(m.get("content")), "user"
        if not blocks:
            continue
        if turns and turns[-1]["role"] == want:
            turns[-1]["content"].extend(blocks)
        else:
            turns.append({"role": want, "content": blocks})
    for t in turns:
        if t["role"] == "user":  # a tool_result must lead its user turn; sorted() is stable, so the rest keep their order
            t["content"] = sorted(t["content"], key=lambda b: b.get("type") != "tool_result")
    return "\n".join(system), turns


def _tools(tools: list[dict] | None) -> list[dict]:
    out = []
    for t in tools or ():
        fn = t.get("function") or t
        spec = {"name": fn.get("name"), "input_schema": fn.get("parameters") or {"type": "object", "properties": {}}}
        if fn.get("description"):
            spec["description"] = fn["description"]
        out.append(spec)
    return out


def messages_request(api_id: str, messages: list[dict], *, tools: list[dict] | None = None, tool_choice=None,
                     max_tokens: int | None = None, reasoning_effort: str | None = None, stop: list[str] | None = None,
                     cache_turns: bool = True) -> dict:
    """One OpenAI-shaped chat call as a Messages request body, cache breakpoints set.

    `cache_turns=False` is for a call with no next turn (agent.ask): only the system breakpoint, which a batch shares,
    is set. Measured 2026-10-02 on 69 single-call Opus asks: 95.1% of 637k input tokens were written to the cache at
    1.25x and never read back, about 24% extra on ask input.

    Not sent: `temperature` (Claude 5.5 refuses a non-default value), `thinking` (always adaptive on Claude 5.5, and
    `disabled` is a 400; omitting it is the adaptive default), and a forced `tool_choice` (also a 400 on Claude 5.5:
    `required` or a named tool goes out as the default, auto)."""
    system, turns = _turns(messages)
    body: dict = {"model": api_id, "max_tokens": int(max_tokens or DEFAULT_MAX_TOKENS)}
    if system:
        body["system"] = [{"type": "text", "text": system, "cache_control": CACHE}]
    users = [t for t in turns if t["role"] == "user"]
    for t in users[-2:] if cache_turns else ():
        t["content"][-1]["cache_control"] = CACHE
    body["messages"] = turns
    if spec := _tools(tools):
        body["tools"] = spec
        if tool_choice == "none":
            body["tool_choice"] = {"type": "none"}
    if reasoning_effort in EFFORTS:
        body["output_config"] = {"effort": reasoning_effort}
    if stops := [s for s in stop or () if s and s.strip()]:
        body["stop_sequences"] = stops
    return body


def chat_message(data: dict) -> tuple[dict, str]:
    """A Messages reply as (the OpenAI-shaped assistant message, its finish_reason). Thinking blocks are dropped."""
    texts: list[str] = []
    calls: list[dict] = []
    for b in data.get("content") or ():
        if b.get("type") == "text" and b.get("text"):
            texts.append(b["text"])
        elif b.get("type") == "tool_use":
            calls.append({"id": b.get("id"), "type": "function",
                          "function": {"name": b.get("name"), "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}})
    message: dict = {"role": "assistant", "content": "\n".join(texts)}
    if calls:
        message["tool_calls"] = calls
    return message, STOP_REASONS.get(data.get("stop_reason") or "", data.get("stop_reason") or "")


def usage(u: dict | None) -> Usage:
    """Messages usage as hswarm's counters. Anthropic's three input figures are disjoint: `input_tokens` is only what
    came after the last breakpoint. miss = that + the cache writes, and `write` keeps the writes apart for pricing."""
    u = u or {}
    write = int(u.get("cache_creation_input_tokens") or 0)
    return Usage(hit=int(u.get("cache_read_input_tokens") or 0), miss=int(u.get("input_tokens") or 0) + write,
                 out=int(u.get("output_tokens") or 0),
                 reasoning=int((u.get("output_tokens_details") or {}).get("thinking_tokens") or 0), write=write)
