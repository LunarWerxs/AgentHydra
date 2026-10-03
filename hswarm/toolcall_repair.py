"""Promote tool calls a model wrote as TEXT into real tool_calls.

WHY: the api loop treats a reply without tool_calls as the final answer (agent._after_reply), so a cheap worker
that writes its call as prose instead of structured tool_calls ended the task with the markup as its answer and
status ok. The shapes seen from the free legs:

- gpt-oss harmony headers: `<|channel|>commentary to=functions.read_file <|constrain|>json<|message|>{...}<|call|>`
- Hermes / Qwen tags: `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` and
  `<function=read_file><parameter=path>a.py</parameter></function>`
- Mistral brackets: `[TOOL_CALLS]read_file[ARGS]{...}` and `[TOOL_CALLS][{"name": ..., "arguments": {...}}]`
- a reply that is nothing but `{"name": ..., "arguments": {...}}` (or a list of them)

A candidate is promoted only when its name is one of the tools offered that turn, its arguments decode to a JSON
object, and it does not start inside a fenced code block, an inline code span or a blockquote: a worker explaining
tool-call syntax in its answer is answering, not calling. Tag and bracket forms must also open a line (standalone),
since a mid-sentence mention is prose; harmony tokens never occur in prose, so those may sit anywhere.

Ideas from openclaw/openclaw packages/tool-call-repair (MIT); written fresh for hswarm, no code copied. Nothing here
talks to the network.
"""
from __future__ import annotations

import json
import re
import uuid

_DECODER = json.JSONDecoder()

# Ranges a call must not start inside: code fences (an unclosed one runs to the end), inline code, blockquotes.
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)", re.M | re.S)
_INLINE_CODE = re.compile(r"`[^`\n]+`")
_BLOCKQUOTE = re.compile(r"^[ \t]*>.*$", re.M)

_HARMONY = re.compile(
    r"(?:<\|start\|>\s*assistant\s*)?(?:<\|channel\|>\s*\w+\s*)?to=(?:functions\.)?(?P<name>[\w.-]+)\s*"
    r"(?:<\|channel\|>\s*\w+\s*)?(?:<\|constrain\|>\s*)?(?:json\s*)?<\|message\|>")
_HARMONY_END = re.compile(r"\s*(?:<\|call\|>|<\|end\|>|<\|return\|>)?")
_HARMONY_TOKEN = re.compile(r"<\|[a-z_]+\|>")
_TAG = re.compile(r"^[ \t]*<tool_call>\s*", re.M)
_TAG_END = re.compile(r"\s*(?:</tool_call>)?")
_FUNCTION_TAG = re.compile(r"^[ \t]*(?:<tool_call>\s*)?<function=(?P<name>[\w.-]+)>(?P<body>.*?)</function>(?:\s*</tool_call>)?", re.M | re.S)
_PARAMETER_TAG = re.compile(r"<parameter=(?P<key>[\w.-]+)>\n?(?P<value>.*?)\n?</parameter>", re.S)
_BRACKET = re.compile(r"^[ \t]*\[TOOL_CALLS\]\s*", re.M)
_BRACKET_NAMED = re.compile(r"\s*(?:\[TOOL_CALLS\]\s*)?(?P<name>[\w.-]+)\s*(?:\[ARGS\])?\s*(?=\{)")


def _decode(text: str, i: int) -> tuple[bool, object, int]:
    """The JSON value starting at text[i] (after whitespace): (found, value, index past it)."""
    while i < len(text) and text[i].isspace():
        i += 1
    try:
        value, end = _DECODER.raw_decode(text, i)
    except ValueError:
        return False, None, i
    return True, value, end


def _named(obj: object, strict: bool = False) -> dict | None:
    """{"name", "arguments"} from one call object: the Hermes shape, `parameters` instead of `arguments`, or the
    OpenAI {"function": {...}} wrapper; arguments may arrive double-encoded as a JSON string. `strict` (a bare JSON
    reply, no call markup around it) demands the arguments key, so a JSON answer that merely has a `name` is not a call."""
    if isinstance(obj, dict) and isinstance(obj.get("function"), dict):
        obj = obj["function"]
    if not isinstance(obj, dict) or not isinstance(obj.get("name"), str):
        return None
    if strict and "arguments" not in obj and "parameters" not in obj:
        return None
    args = obj.get("arguments", obj.get("parameters", {}))
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except ValueError:
            return None
    return {"name": obj["name"], "arguments": args} if isinstance(args, dict) else None


def _calls(obj: object, strict: bool = False) -> list[dict | None]:
    return [_named(o, strict) for o in obj] if isinstance(obj, list) else [_named(obj, strict)]


def _coerce(value: str, prop: dict) -> object:
    """A <parameter> body is always text; decode it only when the tool's schema says the key is not a string, so a
    path like `123` stays a string."""
    if (prop or {}).get("type") in ("integer", "number", "boolean", "array", "object"):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _hits(text: str, schemas: dict[str, dict]) -> list[tuple[int, int, list[dict | None]]]:
    """Every candidate block as (start, end, calls); a call is None when its body did not parse."""
    hits: list[tuple[int, int, list[dict | None]]] = []
    for m in _HARMONY.finditer(text):
        found, args, end = _decode(text, m.end())
        if found:
            hits.append((m.start(), _HARMONY_END.match(text, end).end(), [_named({"name": m["name"], "arguments": args})]))
    for m in _TAG.finditer(text):
        found, obj, end = _decode(text, m.end())
        if found:
            hits.append((m.start(), _TAG_END.match(text, end).end(), _calls(obj)))
    for m in _FUNCTION_TAG.finditer(text):
        props = (schemas.get(m["name"]) or {}).get("properties") or {}
        params = {p["key"]: _coerce(p["value"], props.get(p["key"]) or {}) for p in _PARAMETER_TAG.finditer(m["body"])}
        if not params and m["body"].strip():
            found, args, _ = _decode(m["body"], 0)
            params = args if found else None
        hits.append((m.start(), m.end(), [_named({"name": m["name"], "arguments": params})]))
    for m in _BRACKET.finditer(text):
        found, obj, end = _decode(text, m.end())
        if found:
            hits.append((m.start(), end, _calls(obj)))
            continue
        calls: list[dict | None] = []
        i = m.end()
        while n := _BRACKET_NAMED.match(text, i):
            found, args, end = _decode(text, n.end())
            if not found:
                break
            calls.append(_named({"name": n["name"], "arguments": args}))
            i = end
        if calls:
            hits.append((m.start(), i, calls))
    whole = text.strip()
    if whole.startswith(("{", "[")):
        found, obj, end = _decode(whole, 0)
        if found and end == len(whole):
            hits.append((0, len(text), _calls(obj, strict=True)))
    return hits


def find_text_tool_calls(text: str, schemas: dict[str, dict]) -> tuple[list[dict], list[tuple[int, int]]]:
    """The tool calls written as text in `text`, as {"name", "arguments"} dicts, and the spans they occupy.
    `schemas` maps each tool offered this turn to its parameters schema; any other name is not a call."""
    if not text or not schemas:
        return [], []
    masks = [m.span() for rx in (_FENCE, _INLINE_CODE, _BLOCKQUOTE) for m in rx.finditer(text)]
    kept: list[tuple[int, int]] = []
    calls: list[dict] = []
    for start, end, found in sorted(_hits(text, schemas), key=lambda h: (h[0], -h[1])):
        if kept and start < kept[-1][1]:
            continue  # the same block matched by a second form, or a call nested in one already taken
        # A mask that opens inside a call already taken (a fence in write_file content) does not hide later calls.
        if any(a <= start < b and not any(ks <= a < ke for ks, ke in kept) for a, b in masks):
            continue
        # A block is all-or-nothing: one unknown name or unparsed body means it was not a clean call.
        if not found or any(c is None or c["name"] not in schemas for c in found):
            continue
        kept.append((start, end))
        calls.extend(found)
    return calls, kept


def tool_schemas(tools: list[dict]) -> dict[str, dict]:
    """name -> parameters schema for OpenAI-style tool specs (tools.specs_for)."""
    out: dict[str, dict] = {}
    for t in tools or []:
        fn = t.get("function") or {}
        if fn.get("name"):
            out[fn["name"]] = fn.get("parameters") or {}
    return out


def promote_text_tool_calls(message: dict, text: str, tools: list[dict]) -> dict | None:
    """A copy of the assistant `message` with its text-written calls promoted to structured tool_calls and the call
    markup cut from its content, or None when the text holds no call to a tool offered this turn. The ids are nine
    alphanumerics because Mistral rejects any other shape, and every provider accepts that one."""
    calls, spans = find_text_tool_calls(text, tool_schemas(tools))
    if not calls:
        return None
    rest, last = [], 0
    for start, end in spans:
        rest.append(text[last:start])
        last = end
    rest.append(text[last:])
    fixed = dict(message)
    fixed["content"] = _HARMONY_TOKEN.sub(" ", "".join(rest)).strip()
    fixed["tool_calls"] = [{"id": uuid.uuid4().hex[:9], "type": "function",
                            "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}}
                           for c in calls]
    return fixed
