"""Index hooks for the index diet: parse the MEMORY.md index, measure which trigger tokens a
hook carries, and have flash workers rewrite hooks without losing those tokens.

A hook's only job is recognition: a future session must see that THIS memory answers its
question. So a rewrite is accepted only when it keeps the proper nouns, paths, numbers, error
strings and dates of the original; narrative can go, triggers cannot."""
from __future__ import annotations

import re
from pathlib import Path

from .jobs import JobManager
from .spec import Task

ENTRY_RX = re.compile(r"^- \[(?P<title>.*?)\]\((?P<slug>[^)]+)\)\s*-?\s*(?P<hook>.*)$")

REWRITE_SYSTEM = """You compress memory-index entries. Each entry is a pointer to a memory file: [title](slug) - hook. The hook's only job is to let a future session recognise that THIS memory answers its question. Keep every proper noun, tool name, number, error string and date that could be a search trigger. Drop narrative, justification and history. Output a hook of at most 30 words, plus ONE realistic question a future session might ask that this memory answers (phrase it the way an engineer would, not quoting the hook)."""
REWRITE_SCHEMA = {"type": "object", "properties": {"short_hook": {"type": "string"}, "question": {"type": "string"}}, "required": ["short_hook", "question"]}

RECALL_SYSTEM = "You are reading a memory index to find the ONE entry that answers a question. Reply with the slug of the best entry via submit_result. If none fits, slug = \"none\"."
RECALL_SCHEMA = {"type": "object", "properties": {"slug": {"type": "string"}}, "required": ["slug"]}

# What counts as a search trigger: code spans, paths, dates, CamelCase, ALLCAPS ids, anything with a digit, Capitalised names.
TOKEN_RX = re.compile(
    r"`[^`]+`"
    r"|\b[A-Za-z_][\w./\\-]*[\\/][\w./\\-]+"
    r"|\b\d{4}-\d{2}-\d{2}\b"
    r"|\b[A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+\b"
    r"|\b[A-Z]{2,}[A-Z0-9_-]*\b"
    r"|\b\w*\d+\w*\b"
    r"|\b[A-Z][a-z]{2,}\b"
)
# Sentence-initial capitals and the two owners' names are not triggers.
STOP = {"The", "This", "That", "When", "Never", "Always", "Every", "After", "Before", "Only", "Both", "Each", "Then", "There", "Their", "They", "What", "Which", "Where", "With", "From", "Into", "Not", "And", "But", "For", "Use", "Run", "Read", "Do", "If", "It", "In", "On", "To", "Of", "So", "No", "Michael", "Jacob"}


def parse_index(path: Path) -> tuple[list[str], list[dict]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    entries = []
    for i, line in enumerate(lines):
        m = ENTRY_RX.match(line)
        if m:
            entries.append({"line": i, "title": m.group("title"), "slug": m.group("slug"), "hook": m.group("hook")})
    return lines, entries


def render(entries: list[dict], hook_key: str) -> str:
    return "\n".join(f"[{e['title']}]({e['slug']}) - {e[hook_key]}" for e in entries)


def trigger_tokens(hook: str) -> set[str]:
    toks = set()
    for m in TOKEN_RX.findall(hook):
        t = m.strip("`").strip(".,;:()")
        if len(t) >= 3 and t not in STOP:
            toks.add(t.lower())
    return toks


def coverage(long_hook: str, short_hook: str) -> tuple[float, list[str]]:
    """Share of the long hook's trigger tokens the short hook still contains, plus the missing ones."""
    need = trigger_tokens(long_hook)
    if not need:
        return 1.0, []
    low = short_hook.lower()
    missing = sorted(t for t in need if t not in low)
    return 1 - len(missing) / len(need), missing


def worker(task_id: str, prompt: str, system: str, schema: dict, model: str, cwd: str, index: int) -> Task:
    """One tool-free, no-thinking flash call: the index rides in the system prompt so it is a cache hit after the pilot."""
    return Task.from_dict({"id": task_id, "prompt": prompt, "system": system, "tools": "none", "schema": schema, "model": model, "max_turns": 2, "thinking": False, "cwd": cwd}, {}, index)


def rewrite_task(i: int, e: dict, model: str, cwd: str, max_words: int, must_have: list[str] | None = None) -> Task:
    prompt = f"ENTRY\ntitle: {e['title']}\nslug: {e['slug']}\nhook: {e['hook']}\n\nMax hook words: {max_words}."
    if must_have is not None:
        prompt += " Your short hook MUST contain these tokens verbatim: " + (", ".join(must_have) if must_have else "(all proper nouns, paths, numbers and error strings from the hook)") + "."
    return worker(f"rw{i}", prompt, REWRITE_SYSTEM, REWRITE_SCHEMA, model, cwd, i)


def short_hook(job, task_id: str) -> tuple[str, str]:
    r = job.results[task_id]
    d = r.data if r.status == "ok" and isinstance(r.data, dict) else {}
    return " ".join(str(d.get("short_hook") or "").split()), str(d.get("question") or "")


def _absorb_retry(entries: list[dict], retry: list[Task], job) -> None:
    """A retried hook replaces the first attempt only when it kept at least as many trigger tokens."""
    for t in retry:
        e = entries[int(t.id[2:])]
        hook, _ = short_hook(job, t.id)
        cov, _ = coverage(e["hook"], hook) if hook else (0.0, [])
        if hook and cov >= e["coverage"]:
            e["short"], e["coverage"] = hook, cov


async def rewrite_hooks(m: JobManager, entries: list[dict], model: str, cwd: str, max_words: int, min_coverage: float, concurrency: int) -> list:
    """Sets e['short'], e['coverage'], e['question'] on every entry; one retry naming the missing trigger tokens."""
    job1 = await m.run_batch([rewrite_task(i, e, model, cwd, max_words) for i, e in enumerate(entries)], concurrency=concurrency, label="indexdiet-rewrite")
    retry: list[Task] = []
    for i, e in enumerate(entries):
        hook, question = short_hook(job1, f"rw{i}")
        e["question"] = question or f"What do we know about {e['title']}?"
        cov, missing = coverage(e["hook"], hook) if hook else (0.0, [])
        e["short"], e["coverage"] = hook, cov
        if not hook or len(hook.split()) > max_words + 10 or cov < min_coverage:
            retry.append(rewrite_task(i, e, model, cwd, max_words, must_have=missing))
    jobs = [job1]
    if retry:
        jobs.append(await m.run_batch(retry, concurrency=concurrency, label="indexdiet-rewrite-retry"))
        _absorb_retry(entries, retry, jobs[-1])
    for e in entries:
        if not e["short"] or e["coverage"] < min_coverage:
            e["short"], e["coverage"] = e["hook"], 1.0  # keep the long hook: the short one lost its triggers
    return jobs
