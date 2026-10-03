"""Recipe plan cache: the read-only tool calls of a recipe run that passed, replayed before the model plans again.

WHY: a recurring job runs the same named recipe over differently shaped inputs and pays the model to rediscover the
same reads every time. What is cached is the PLAN (which files to list, glob, grep and read), never the answer, so a
replay is still correct on new input: the calls run against today's files and the model answers from today's bytes.
Idea from Microsoft PowerToys Advanced Paste (MIT), which caches a named action's tool-call chain rather than its
output; no code of theirs is used.

Rules that keep it honest:
- Only a task carrying a `recipe` id is cached. A free-text prompt never is, and the prompt itself is never stored:
  the key is (recipe, input shape, hswarm version) and the value is the tool calls.
- Only read-only tools are recorded (REPLAYABLE). A write or a shell command replayed on new input would change the
  worker's tree on the strength of a different run's reasoning.
- Any replayed call that errors drops the whole replay and the model plans from scratch, as if there were no plan.
- A plan recorded by another hswarm version (or another tool contract) is dropped, never replayed.

State: <HSWARM_HOME>/plans.json, machine-local. Only the api backend replays; cc runs Claude Code's own loop.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from pathlib import Path

from . import __version__, config
from .spec import Task, now_iso
from .toolspecs import PRESETS, SPECS

REPLAYABLE = ("read_file", "list_dir", "glob", "grep", "outline", "unfold")  # outline/unfold: read-only symbol reads
MAX_CALLS = 24  # a plan longer than this is a crawl, not a recipe; the first MAX_CALLS are kept
RECIPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
_LOCK = threading.Lock()  # one process runs hundreds of tasks; the file is rewritten whole under this lock


def plans_file() -> Path:
    return config.HOME / "plans.json"  # read at call time, so a redirected HOME (tests, HSWARM_HOME) is honoured


def version() -> str:
    """The hswarm version plus the tool contract: a plan recorded against other tool schemas is not replayed."""
    specs = hashlib.sha256(json.dumps(SPECS, sort_keys=True).encode("utf-8")).hexdigest()[:8]
    return f"{__version__}+{specs}"


def _tool_names(tools: str | list[str]) -> list[str]:
    if isinstance(tools, list):
        return sorted(tools)
    return sorted(PRESETS.get(tools, [n.strip() for n in str(tools or "").split(",") if n.strip()]))


def shape(task: Task) -> str:
    """The input shape a plan is good for: the tools the worker has, the answer contract, and the kinds and count of
    inlined files and extra roots. Contents and the prompt are deliberately NOT in it: new input of the same shape is
    what a recipe is for."""
    doc = {
        "tools": _tool_names(task.tools),
        "schema": task.schema,
        "files": sorted(Path(f).suffix.lower() for f in task.files),
        "roots": len(task.roots),
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]


def key(task: Task) -> str:
    return f"{task.recipe}|{shape(task)}|{version()}"


def _load() -> dict:
    try:
        doc = json.loads(plans_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _save(doc: dict) -> None:
    """Atomic rewrite, keeping only this version's plans: that is how a version change drops the cache."""
    now = version()
    kept = {k: v for k, v in doc.items() if isinstance(v, dict) and v.get("version") == now}
    path = plans_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(kept, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def lookup(task: Task) -> list[dict]:
    """The recorded calls for this task's (recipe, shape, version), or [] when there is none."""
    if not task.recipe:
        return []
    entry = _load().get(key(task))
    if not isinstance(entry, dict) or entry.get("version") != version():
        return []
    return [c for c in entry.get("calls") or [] if isinstance(c, dict) and c.get("name") in REPLAYABLE][:MAX_CALLS]


def calls_from(messages: list[dict]) -> list[dict]:
    """The read-only tool calls a run made that came back without an ERROR, in order."""
    outputs = {m.get("tool_call_id"): m.get("content") for m in messages if m.get("role") == "tool"}
    calls: list[dict] = []
    for m in messages:
        if m.get("role") != "assistant":
            continue
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            if fn.get("name") not in REPLAYABLE or str(outputs.get(tc.get("id")) or "").startswith("ERROR"):
                continue
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                continue
            if isinstance(args, dict):
                calls.append({"name": fn["name"], "args": args})
    return calls


def _unique(calls: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out = []
    for c in calls:
        sig = json.dumps(c, sort_keys=True)
        if sig not in seen:
            seen.add(sig)
            out.append(c)
    return out[:MAX_CALLS]


def record(task: Task, calls: list[dict]) -> None:
    """Store the plan of a run that PASSED (the replayed calls first, then the ones the model added), each call once.
    Disk errors never fail a task: the cache is an optimisation."""
    calls = _unique(calls)
    if not task.recipe or not calls:
        return
    try:
        with _LOCK:
            doc = _load()
            k = key(task)
            hits = (doc.get(k) or {}).get("hits", 0) if isinstance(doc.get(k), dict) else 0
            doc[k] = {"recipe": task.recipe, "shape": shape(task), "version": version(), "calls": calls[:MAX_CALLS],
                      "recorded": now_iso(), "hits": hits}
            _save(doc)
    except OSError:
        pass


def note_hit(task: Task) -> None:
    try:
        with _LOCK:
            doc = _load()
            entry = doc.get(key(task))
            if isinstance(entry, dict):
                entry["hits"] = int(entry.get("hits") or 0) + 1
                _save(doc)
    except OSError:
        pass


async def replay(task: Task, sb) -> tuple[list[tuple[dict, str]], str | None]:
    """Run the recorded calls in order on this task's sandbox. Returns (calls with their outputs, note): the note is
    None with no recipe, "miss" with no plan, "hit: N calls" when every call ran, and "fallback: ..." (with no
    outputs) when one errored, so the model plans from scratch."""
    if not task.recipe:
        return [], None
    calls = lookup(task)
    if not calls:
        return [], "miss"
    done: list[tuple[dict, str]] = []
    for c in calls:
        out = await sb.run(c["name"], c["args"])
        if out.startswith("ERROR"):
            return [], f"fallback: {c['name']} {out[:200]}"
        done.append((c, out))
    note_hit(task)
    return done, f"hit: {len(done)} calls"


def replay_block(recipe: str, done: list[tuple[dict, str]]) -> str:
    """The replayed calls and their outputs, appended to the task's user turn: plain text every provider accepts,
    with no synthetic assistant turn a thinking-mode provider would refuse for lacking its reasoning."""
    parts = [f"--- replayed plan: recipe {recipe} ---",
             "These read-only tool calls were replayed from this recipe's last passing run, on today's files. "
             "Use their outputs; call tools only for what they do not cover."]
    for c, out in done:
        parts.append(f">>> {c['name']}({json.dumps(c['args'], ensure_ascii=False)})\n{out}")
    parts.append("--- end replayed plan ---")
    return "\n".join(parts)
