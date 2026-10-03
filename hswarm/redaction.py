"""Redaction of PII and secret shapes in worker tool output, before it goes into a provider's message list.

WHY: an `api` worker's tool output (a file it read, a grep hit, a shell result) is sent to whichever
provider serves the task, and the default routes are free tiers (groq, gemini) whose terms allow training
on what they are sent. A worker reading a config file or a customer fixture ships every email and key in it.
A Redactor rewrites those spans first; the originals never leave the machine.

Detectors: email, credit_card (Luhn-checked), ip, mac, url, secret (key prefixes, bearer tokens, private-key
blocks, `password = "..."` assignments), plus any named regex. Strategies:
    block   the whole tool output is withheld and the worker gets an ERROR naming what was found
    redact  [REDACTED_EMAIL]
    mask    everything but the last 4 characters starred (an email keeps its domain)
    hash    <email:1a2b3c4d>, the same tag for the same value across the whole task, so the model can still
            tell two addresses apart and refer back to one; the Sandbox maps a tag back to its value in a
            write or a command, so a worker that edits a redacted file writes the real bytes, not the tag.

The detector/strategy design follows langchain-ai/langchain
libs/langchain_v1/langchain/agents/middleware/_redaction.py (MIT, Copyright (c) LangChain, Inc.);
written fresh for hswarm.
"""
from __future__ import annotations

import hashlib
import ipaddress
import os
import re
from collections import Counter
from typing import Callable

STRATEGIES = ("block", "redact", "mask", "hash")

# Key shapes with length floors, so text that merely DESCRIBES a key (`sk-...`, `ghp_xxx`) is untouched.
# A `v` group, when present, is the span redacted; the rest of the match is context kept for the reader.
_SECRET_RES = [
    re.compile(r"\bc?sk-[A-Za-z0-9_-]{20,}"),  # csk-: cerebras, a provider this product routes to
    re.compile(r"\bhf_[A-Za-z0-9]{30,}"),  # Hugging Face, likewise a built-in provider
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}"),
    re.compile(r"\bgsk_[A-Za-z0-9]{20,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"(?i)\bbearer\s+(?P<v>[A-Za-z0-9._~+/=-]{16,})"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    # An assignment's value must carry a digit: `token = get_token_from_env` in source code is not a secret.
    # No `\b` before the name: `_` is a word character, so `\b` would miss DB_PASSWORD=, client_secret: and
    # GITHUB_TOKEN=, the commonest .env/config shapes; any non-alphanumeric (or the start) may precede it.
    # `\]?` lets a subscript through: conf["password"] = "..." leaked while password = "..." was caught.
    re.compile(r"(?i)(?<![A-Za-z0-9])(?:api[_-]?key|secret(?:[_-]?key)?|password|passwd|token)[\"']?\]?\s*[:=]\s*[\"']?(?P<v>(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,})"),
]
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_CARD_RE = re.compile(r"(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])")
_IP_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
_MAC_RE = re.compile(r"\b[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}\b")
_URL_RE = re.compile(r"\bhttps?://[^\s<>\"'`)\]]+")

Span = tuple[int, int]


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def _spans(rx: re.Pattern, text: str, keep: Callable[[str], bool] | None = None) -> list[Span]:
    out = []
    for m in rx.finditer(text):
        span = m.span("v") if "v" in rx.groupindex else m.span()
        if keep is None or keep(text[span[0]:span[1]]):
            out.append(span)
    return out


def _is_card(s: str) -> bool:
    digits = re.sub(r"\D", "", s)
    return 13 <= len(digits) <= 19 and _luhn_ok(digits)


def _is_ip(s: str) -> bool:
    try:
        ipaddress.ip_address(s)
    except ValueError:
        return False
    return True


DETECTORS: dict[str, Callable[[str], list[Span]]] = {
    "email": lambda t: _spans(_EMAIL_RE, t),
    "credit_card": lambda t: _spans(_CARD_RE, t, _is_card),
    "ip": lambda t: _spans(_IP_RE, t, _is_ip),
    "mac": lambda t: _spans(_MAC_RE, t),
    "url": lambda t: _spans(_URL_RE, t),
    "secret": lambda t: [s for rx in _SECRET_RES for s in _spans(rx, t)],
}
# ip, mac and url are opt-in: a worker reading code or docs needs its version strings and links intact.
DEFAULT_DETECTORS = ("secret", "email", "credit_card")

# Per-process salt: a hash tag is stable for a whole task (and job), but is not a lookup table an
# adviser could reverse by hashing candidate addresses.
_SALT = os.urandom(16)

# Hash tag -> the value it stands for, for the whole PROCESS, not one Redactor: a task that fails over builds a
# new Redactor per leg (agent.run_api_task), and the tags an earlier leg left in the resumed transcript must still
# map back when a later leg writes them into a file or returns them in its answer. Tags are salted per process,
# so one map is consistent across every task in it.
_ORIGINALS: dict[str, str] = {}

# Tools whose arguments get hash tags mapped back to real values: the ones that write to this machine. read_url
# and the rest stay tagged, so an injected page cannot talk the worker into fetching `?k=<secret:..>` with the real key.
RESTORE_TOOLS = frozenset({"write_file", "edit_file", "bash", "bash_start"})


def restore(text: str) -> str:
    """Hash tags (from any leg of any task in this process) mapped back to their real values."""
    if not _ORIGINALS or "<" not in text:
        return text
    for tag, value in _ORIGINALS.items():
        text = text.replace(tag, value)
    return text


def restore_deep(value: object) -> object:
    """restore() over a final answer or a submit_result payload, which go back to the LOCAL caller: a hash
    tag there is a value the caller cannot map, and the real one never leaves the machine anyway."""
    if isinstance(value, str):
        return restore(value)
    if isinstance(value, dict):
        return {k: restore_deep(v) for k, v in value.items()}
    if isinstance(value, list):
        return [restore_deep(v) for v in value]
    return value


class RedactionBlocked(Exception):
    """A `block` detector fired: the text must not leave the machine at all."""


class Redactor:
    def __init__(self, strategy: str = "hash", detectors: list[str] | tuple[str, ...] = DEFAULT_DETECTORS, patterns: dict[str, str] | None = None):
        if strategy not in STRATEGIES:
            raise ValueError(f"redact strategy must be one of {'|'.join(STRATEGIES)}, not {strategy!r}")
        unknown = [d for d in detectors if d not in DETECTORS]
        if unknown:
            raise ValueError(f"unknown redact detector(s) {unknown}; known: {sorted(DETECTORS)} (or a named regex under 'patterns')")
        self.strategy = strategy
        self.detectors: dict[str, Callable[[str], list[Span]]] = {d: DETECTORS[d] for d in detectors}
        if patterns is not None and not isinstance(patterns, dict):
            raise ValueError("redact patterns must be an object of {name: regex}")
        for name, rx in (patterns or {}).items():
            if name in DETECTORS:
                # Stored under the same key it would REPLACE the built-in, so a pattern named "secret" sent real keys out.
                raise ValueError(f"redact pattern {name!r} has a built-in detector's name and would replace it; give it its own name")
            try:
                compiled = re.compile(rx)
            except re.error as e:
                raise ValueError(f"redact pattern {name!r} is not a valid regex: {e}") from None
            self.detectors[name] = lambda t, c=compiled: _spans(c, t)
        self.counts: Counter = Counter()
        self.emitted: set[str] = set()  # every placeholder handed to the model, for the write-back guard

    def _replacement(self, kind: str, value: str) -> str:
        if self.strategy == "redact":
            return f"[REDACTED_{kind.upper()}]"
        if self.strategy == "mask":
            if kind == "email" and "@" in value:
                return "****@" + value.split("@", 1)[1]
            return "*" * min(max(len(value) - 4, 4), 16) + value[-4:]
        digest = hashlib.sha256(_SALT + value.encode('utf-8')).hexdigest()
        tag = f"<{kind}:{digest[:8]}>"
        if _ORIGINALS.get(tag, value) != value:
            # The map is process-wide, so a 32-bit tag can collide; a collision must never restore the wrong value.
            tag = f"<{kind}:{digest[:16]}>"
        _ORIGINALS[tag] = value
        return tag

    def apply(self, text: str) -> str:
        """The text with every detected span replaced; raises RedactionBlocked under the block strategy."""
        found: list[tuple[int, int, str]] = []
        for kind, detect in self.detectors.items():
            found.extend((a, b, kind) for a, b in detect(text) if b > a)
        if not found:
            return text
        # Overlaps (a URL holding an email, a key inside an assignment): the earliest, then the longest, wins.
        found.sort(key=lambda s: (s[0], -(s[1] - s[0])))
        kept: list[tuple[int, int, str]] = []
        for a, b, kind in found:
            if not kept or a >= kept[-1][1]:
                kept.append((a, b, kind))
        if self.strategy == "block":
            kinds = sorted({k for _, _, k in kept})
            self.counts.update(k for _, _, k in kept)
            raise RedactionBlocked(f"{len(kept)} span(s) of {', '.join(kinds)}")
        parts, last = [], 0
        for a, b, kind in kept:
            rep = self._replacement(kind, text[a:b])
            self.emitted.add(rep)
            self.counts[kind] += 1
            parts += [text[last:a], rep]
            last = b
        parts.append(text[last:])
        return "".join(parts)

    def restore(self, text: str) -> str:
        """Hash tags the model echoes back (in a write, an edit, a command) mapped to their real values."""
        return restore(text)

    def restore_deep(self, value: object) -> object:
        return restore_deep(value)

    def scrub(self, text: str, what: str) -> str:
        """apply(), with the block strategy's refusal as the text instead of an exception."""
        try:
            return self.apply(text)
        except RedactionBlocked as e:
            return f"ERROR: {what} withheld - it contains {e}, and this task redacts with strategy block"

    def unrestorable(self, text: str) -> str | None:
        """A placeholder in `text` that cannot be mapped back (redact/mask), or None. Writing one would put
        `[REDACTED_EMAIL]` into the file for good, so the Sandbox refuses the write instead."""
        if self.strategy == "hash":
            return None
        return next((p for p in self.emitted if p in text), None)


def from_spec(spec: object) -> Redactor | None:
    """A task's `redact` field: None/False/"off" -> no redaction; True -> hash over the default detectors;
    a strategy name; or {"strategy": ..., "detectors": [...], "patterns": {name: regex}}."""
    if isinstance(spec, str):
        spec = spec.strip().lower()
    if spec is None or spec is False or spec in ("", "off", "none"):
        return None
    if spec is True:
        return Redactor()
    if isinstance(spec, str):
        return Redactor(spec)
    if isinstance(spec, dict):
        unknown = set(spec) - {"strategy", "detectors", "patterns"}
        if unknown:
            raise ValueError(f"redact: unknown keys {sorted(unknown)}; known: detectors, patterns, strategy")
        detectors = spec.get("detectors")
        if isinstance(detectors, str):
            detectors = [d.strip() for d in detectors.split(",") if d.strip()]
        return Redactor(str(spec.get("strategy") or "hash").lower(), tuple(detectors) if detectors is not None else DEFAULT_DETECTORS, spec.get("patterns"))
    raise ValueError(f"redact must be a strategy name ({'|'.join(STRATEGIES)}), true/false, or an object; got {type(spec).__name__}")


def for_task(redact: object, free_tier: bool) -> Redactor | None:
    """The redactor for one task leg. An explicit `redact` on the task wins (including "off"); otherwise a
    leg served by a free-tier provider is redacted when this machine sets HSWARM_REDACT_FREE_TIER to a spec
    (a strategy name, or "on" for hash)."""
    if redact is not None:
        return from_spec(redact)
    machine = os.environ.get("HSWARM_REDACT_FREE_TIER", "").strip().lower()
    if not free_tier or not machine:
        return None
    try:
        return from_spec(True if machine in ("1", "on", "true", "yes") else machine)
    except ValueError as e:  # a typo on the machine switch names the variable, not a task field
        raise ValueError(f"HSWARM_REDACT_FREE_TIER: {e}") from None


# A worker in a checkout could read and send the live keys (.secrets/, ~/.hswarm/providers). Whatever the bytes
# were reached by, a token equal to a key this process holds never reaches the model. The set is built lazily,
# once, dropped by forget_keys() when config reloads, never logged and never leaves the process.
# Idea from CopilotKit/OpenBot .github/workflows/ci.yml:556-570 and CopilotKit/OpenTag agent/coding/sandbox.py:114 (MIT), 2026-10-03.
KEY_WITHHELD = "[hswarm key withheld]"
_KEY_RUN = re.compile(r"[A-Za-z0-9_\-\.]{16,}")
_KEYS: frozenset[str] | None = None


def forget_keys() -> None:
    global _KEYS
    _KEYS = None


def _known_keys() -> frozenset[str]:
    global _KEYS
    if _KEYS is None:
        from . import config
        found: set[str] = set()
        for provider in list(config.PROVIDERS):
            try:
                found.update(k for k in config.all_keys(provider) if len(k) >= 16)
            except Exception:  # noqa: BLE001 - a provider whose key source cannot be read holds no keys we can know
                continue
        _KEYS = frozenset(found)
    return _KEYS


def scrub_keys(text: str) -> str:
    """`text` with every token equal to a held key replaced by KEY_WITHHELD; always on, one set lookup per token."""
    keys = _known_keys()
    if not keys or not text:
        return text
    return _KEY_RUN.sub(lambda m: KEY_WITHHELD if m.group(0) in keys else m.group(0), text)
