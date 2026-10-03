"""Batch the QUESTIONS, not the calls (owner, 2026-09-29).

A worker answers fifty short questions in about the time it answers one: every call pays its own round trip,
queue slot, system prompt and model warm-up, and the answer tokens are the small part. Yet the instructions this
server hands every client used to say "one task per file, item or question", and callers followed them: a
100-item classification went out as 100 tool-free tasks instead of two. So:

- hswarm_run REFUSES a fan-out of many small tool-free tasks that share one model, system prompt and schema
  (`unbatched_run`): the refusal says how to pack them, and `unbatched=true` sends them anyway when every
  question truly needs its own call (independent samples of one question, items that must not see each other).
  An evaluation job (purpose="evaluation": a benchmark measuring one question per call) is never refused.
- hswarm_ask notes a caller that sends one small question after another (`note_ask`) and hands back the same
  recipe beside its answer; it never refuses, because parallel asks with different systems (a critics' board)
  are a legitimate shape.

What a batched call IS: one prompt carrying 20-100 numbered items (or naming a file the worker reads), and a
schema whose answer is an array with one entry per item, keyed by the item's id.
"""
from __future__ import annotations

import collections
import json
import os
import threading
import time

from .toolspecs import tool_names

MIN_TASKS = 8  # a tool-free fan-out at least this wide, of small questions of one shape, is refused
SMALL_CHARS = 3000  # a question this short leaves a worker's context almost empty: pack it with others
PACK = 50  # the items per packed task the refusal suggests
ASK_WINDOW_S = 120.0
ASK_NOTE_AT = 5  # small hswarm_ask calls from one caller inside the window before the recipe is handed back

RECIPE = ("Put 20-100 items in ONE task: number them in the prompt (or list them in a file the worker reads) and give "
          "a schema whose answer is an array with one entry per item, e.g. "
          '{"type":"object","required":["answers"],"properties":{"answers":{"type":"array","items":{"type":"object",'
          '"required":["id","answer"],"properties":{"id":{"type":"string"},"answer":{"type":"string"}}}}}}. '
          "A worker answers 50 short questions in about the time it answers one; each separate call pays its own "
          "round trip, queue slot and system prompt.")


def _shape(t) -> tuple:
    return (t.model, t.backend, t.system or "", json.dumps(t.schema, sort_keys=True) if t.schema else "", t.role or "",
            t.profile or "", t.reasoning_effort or "")


def unbatched_run(tasks: list) -> str | None:
    """The refusal for a hswarm_run that sends many small tool-free questions of one shape as separate tasks, else
    None. `tasks` are parsed spec.Task objects."""
    if len(tasks) < MIN_TASKS or any(t.purpose == "evaluation" for t in tasks):
        return None
    small = [t for t in tasks if not tool_names(t.tools) and not t.files and len(t.prompt) <= SMALL_CHARS]
    if len(small) < MIN_TASKS:
        return None
    shape, n = collections.Counter(_shape(t) for t in small).most_common(1)[0]
    if n < MIN_TASKS:
        return None
    packs = -(-n // PACK)
    return (f"unbatched fan-out refused: {n} small tool-free tasks (each under {SMALL_CHARS} characters) share one "
            f"model, system prompt and schema. Send them as {packs} task{'s' * (packs > 1)} of up to {PACK} items "
            f"instead. {RECIPE} Pass unbatched=true only when every question truly needs its own call "
            "(independent samples of one question, items that must not see each other).")


_asks: dict[str, collections.deque] = collections.defaultdict(collections.deque)
_lock = threading.Lock()


def caller_id() -> str:
    """Who is asking, cheaply: the chat the shared server's request names, else this process's session."""
    from . import shared

    r = shared.REQUEST.get() if shared.ACTIVE else None
    if r:
        return r.get("session") or r.get("chat") or r.get("instance") or "shared"
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or f"pid{os.getpid()}"


def note_ask(prompt: str, who: str | None = None, now: float | None = None) -> str | None:
    """Record one hswarm_ask; the batching recipe when this caller has sent ASK_NOTE_AT or more small questions
    inside ASK_WINDOW_S, else None."""
    if len(prompt or "") > SMALL_CHARS:
        return None
    who = who or caller_id()
    now = time.monotonic() if now is None else now
    with _lock:
        q = _asks[who]
        q.append(now)
        while q and now - q[0] > ASK_WINDOW_S:
            q.popleft()
        n = len(q)
    if n < ASK_NOTE_AT:
        return None
    return (f"{n} small hswarm_ask calls from this chat in the last {int(ASK_WINDOW_S)} s. Ask them together: one "
            f"hswarm_ask whose prompt numbers every question and whose schema returns an array, or one hswarm_run "
            f"task per 20-100 questions. {RECIPE}")
