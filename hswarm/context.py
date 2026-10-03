"""Context hygiene for the `api` worker loop: clear stale tool results once the history passes a token trigger.

The loop resends the whole history every turn, so a grep or a file read from turn 2 is paid for again on turns
3 through 24. Past `trigger` tokens, older tool results are swapped for a one-line pointer (the full text stays
reachable through fetch_output, tools.spill). The idea is langchain's ClearToolUsesEdit (MIT), written fresh
here: the last `keep` results stay whole, excluded tools are never touched, and a pass that cannot free
`clear_at_least` tokens waits, because every pass breaks the provider's cached prompt prefix from the first
cleared result on - better rarely and in big bites than a little on every turn.

The caller's `messages` list is never edited: it is the task's transcript. `view` returns what to send, and a
cleared result stays cleared with the same bytes on every later turn, so the new prefix caches again at once.
"""
from __future__ import annotations

from typing import Callable

from . import config

CHARS_PER_TOKEN = 4  # the usual rough count; the trigger is a budget, not an invoice
MIN_CLEAR_CHARS = 400  # a result this short costs less than the cache miss clearing it would cause
NEVER_CLEAR = frozenset({"submit_result"})


def approx_tokens(messages: list[dict]) -> int:
    """A rough prompt size: every text part, reasoning trace and tool-call argument, by characters."""
    chars = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        elif isinstance(content, list):
            chars += sum(len(p.get("text") or "") for p in content if isinstance(p, dict))
        chars += len(m.get("reasoning_content") or "")
        for tc in m.get("tool_calls") or []:
            chars += len((tc.get("function") or {}).get("arguments") or "")
    return chars // CHARS_PER_TOKEN


def _tool_names(messages: list[dict]) -> dict[str, str]:
    """tool_call_id -> the tool the assistant called, read off the assistant turns."""
    return {tc.get("id"): (tc.get("function") or {}).get("name") or "tool"
            for m in messages if m.get("role") == "assistant" for tc in (m.get("tool_calls") or []) if tc.get("id")}


class ContextEditor:
    def __init__(self, trigger: int, clear_at_least: int, keep: int = config.CONTEXT_KEEP_TOOL_RESULTS,
                 spill: Callable[[str], str | None] | None = None, exclude: frozenset[str] | set[str] = NEVER_CLEAR):
        self.trigger = max(0, int(trigger or 0))
        self.clear_at_least = max(0, int(clear_at_least or 0))
        self.keep = max(0, int(keep))
        self.spill = spill
        self.exclude = frozenset(exclude)
        self.cleared: dict[str, str] = {}  # tool_call_id -> the placeholder sent in its place, fixed once chosen
        self.passes = 0
        self.tokens_freed = 0

    @classmethod
    def for_leg(cls, task, spill: Callable[[str], str | None] | None = None) -> "ContextEditor":
        """The editor for one leg of `task`: the task's own trigger, or the low one (config.CONTEXT_TRIGGER_UNCACHED)
        when the task kept the defaults and this leg bills a re-sent token at the full input price.

        A leg with a cache discount keeps 60k/20k: a re-read costs it 0.05-0.1x and every pass re-writes the cache. So
        does a free leg: NVIDIA charges nothing and still read 87.8% of glm-5-3's input from its cache, a prefix each
        pass would break. A trigger the caller set (0 = off included) is never changed."""
        trigger, clear_at_least = task.context_trigger, task.context_clear_at_least
        if (trigger, clear_at_least) == (config.CONTEXT_TRIGGER_TOKENS, config.CONTEXT_CLEAR_AT_LEAST):
            try:
                rates = config.price(task.model)
            except (KeyError, ValueError):
                rates = None  # a model with no registry entry: nothing known about its cache, keep the default
            if rates and rates.get("miss", 0.0) > 0 and rates.get("hit") == rates["miss"]:
                trigger, clear_at_least = config.CONTEXT_TRIGGER_UNCACHED, config.CONTEXT_CLEAR_AT_LEAST_UNCACHED
        return cls(trigger, clear_at_least, spill=spill)

    def _apply(self, messages: list[dict]) -> list[dict]:
        if not self.cleared:
            return messages
        return [{**m, "content": self.cleared[m["tool_call_id"]]} if m.get("role") == "tool" and m.get("tool_call_id") in self.cleared else m
                for m in messages]

    def _placeholder(self, name: str, text: str) -> str:
        handle = self.spill(text) if self.spill else None
        if handle:
            return f"[stale {name} output cleared to save context ({len(text)} chars): fetch_output(id=\"{handle}\") returns it]"
        return f"[stale {name} output cleared to save context ({len(text)} chars): run the call again if you still need it]"

    def view(self, messages: list[dict]) -> list[dict]:
        """The messages to send this turn: earlier clearings reapplied, plus one new pass when over the trigger."""
        sent = self._apply(messages)
        if not self.trigger:
            return sent
        total = approx_tokens(sent)
        if total <= self.trigger:
            return sent
        names = _tool_names(messages)
        results = [m for m in messages if m.get("role") == "tool"]
        need = max(self.clear_at_least, total - self.trigger)
        plan: dict[str, str] = {}
        freed = 0
        for m in results[: max(0, len(results) - self.keep)]:  # oldest first; the last `keep` stay whole
            tid, text = m.get("tool_call_id"), m.get("content")
            if not tid or tid in self.cleared or not isinstance(text, str) or len(text) < MIN_CLEAR_CHARS:
                continue
            name = names.get(tid, "tool")
            if name in self.exclude:
                continue
            placeholder = self._placeholder(name, text)
            plan[tid] = placeholder
            freed += (len(text) - len(placeholder)) // CHARS_PER_TOKEN
            if freed >= need:
                break
        if not plan or freed < self.clear_at_least:
            return sent  # not enough to be worth a cache miss yet; more results will pile up behind the kept ones
        self.cleared.update(plan)
        self.passes += 1
        self.tokens_freed += freed
        return self._apply(messages)
