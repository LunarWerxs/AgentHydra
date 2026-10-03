"""The shapes a chat-completions call returns: the error, the usage split, the result envelope, and
the request body builder. Kept apart from the client so the HTTP code stays small."""
from __future__ import annotations

from dataclasses import dataclass, field


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str, provider: str = "DeepSeek"):
        super().__init__(f"{provider} API {status}: {body[:400]}")
        self.status = status
        self.body = body
        self.provider = provider


@dataclass
class Usage:
    hit: int = 0
    miss: int = 0
    out: int = 0
    reasoning: int = 0
    write: int = 0  # the part of `miss` a provider wrote to its prompt cache (Anthropic bills it at 1.25x input)

    def add(self, other: "Usage") -> None:
        self.hit += other.hit
        self.miss += other.miss
        self.out += other.out
        self.reasoning += other.reasoning
        self.write += other.write

    @property
    def prompt(self) -> int:
        return self.hit + self.miss

    def as_dict(self) -> dict:
        d = {"in_hit": self.hit, "in_miss": self.miss, "out": self.out, "reasoning": self.reasoning}
        if self.write:  # only a provider with explicit cache writes has the counter; every other row stays as it was
            d["in_write"] = self.write
        return d

    @staticmethod
    def from_api(u: dict | None) -> "Usage":
        u = u or {}
        # DeepSeek reports cache hit/miss directly; the OpenAI-shaped `cached_tokens` is the fallback.
        hit = int(u.get("prompt_cache_hit_tokens") or (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
        miss = int(u.get("prompt_cache_miss_tokens") or max(0, int(u.get("prompt_tokens") or 0) - hit))
        out = int(u.get("completion_tokens") or 0)
        reasoning = int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
        return Usage(hit, miss, out, reasoning)


@dataclass
class ChatResult:
    message: dict
    finish_reason: str
    usage: Usage
    model: str
    seconds: float
    cost_usd: float | None  # None: the model has no price on record (not measured, never zero)
    peak: bool
    attempts: int = 1
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def content(self) -> str:
        """The reply's text. Mistral can answer with a LIST of content parts ([{"type": "text", "text": ...}], a
        "thinking" part beside it) instead of a string; every reader here calls str methods on this, so the parts are
        flattened to their text once, here (22 of 49 mining tasks died on `.strip()` of a list, 2026-09-23)."""
        c = self.message.get("content") or ""
        if isinstance(c, list):
            return "".join(p.get("text") or "" for p in c if isinstance(p, dict) and p.get("type", "text") == "text")
        return c if isinstance(c, str) else str(c)

    @property
    def tool_calls(self) -> list[dict]:
        return self.message.get("tool_calls") or []


def request_body(model: str, messages: list[dict], **opts) -> dict:
    """The request body: model + messages plus every option that was actually given."""
    body: dict = {"model": model, "messages": messages}
    thinking = opts.pop("thinking", None)
    if thinking is not None:
        body["thinking"] = {"type": "enabled" if thinking else "disabled"}
    if opts.get("max_tokens"):
        opts["max_tokens"] = int(opts["max_tokens"])
    # Unset options must be ABSENT, not null: DeepSeek rejects `"tools": null` and `"stop": []`.
    body.update({k: v for k, v in opts.items() if v is not None and v != "" and v != [] and v != 0})
    return body
