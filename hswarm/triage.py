"""Triage staged memory candidates against the existing memory index, by the hswarm.

For every `<staging>/*.md` written by `hswarm distill`, one flash worker judges it against the
current MEMORY.md index (the index rides in the shared system prompt, so it is a cache hit
after the pilot): duplicate (already known; names the slug), trivial (session-specific,
derivable from code/git, or about the transcript itself), or keep (durable, new, actionable),
with a 0-1 score and a topic key so near-duplicate candidates cluster. Files are MOVED into
`keep/`, `duplicate/`, `trivial/` subfolders (reversible), and `TRIAGE.md` summarises.

Before any worker is paid, a deterministic admission gate moves a candidate to `rejected/` when
its text is instruction-shaped ("ignore previous instructions", "reveal the system prompt") or
secret-shaped, or when it carries no checkable source anchor (`source: session <id>` as distill
writes it, or `source: <path>:<line>`). A path anchor may not traverse (`..`), and when the file
can be resolved (absolute, or relative to --anchor-root) the cited file and line must still exist.
Retrieved memory is evidence, not authority: the anchor is what lets a reader check it.

    python -m hswarm triage --staging /path/to/staging \
        --index /path/to/MEMORY.md
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import re
import shutil
from pathlib import Path

from . import egress
from .jobs import JobManager, batch_argparser
from .spec import Task
from .transcripts import redact

SYSTEM = """You triage candidate memory facts for a shared, file-based team memory. You are given the CURRENT INDEX (one line per existing memory: [title](slug) - hook) and ONE candidate.

Verdicts:
- duplicate: the index already records this fact or a more general version of it. Give the matching slug in `matches`.
- trivial: session-specific, obvious, derivable from the code/git/docs, a task status, a one-off number, or a statement about the transcript itself. Also trivial if it names no reusable rule, quirk, preference, or reference.
- keep: durable, new, and actionable for a future session (an owner preference or rule with its why, a machine/account/tool quirk that costs time, a project constraint, a reference).

Also give: score 0.0-1.0 (how valuable it is to keep, independent of verdict), key (a 2-4 word kebab-case topic so near-duplicates cluster, e.g. "docker-vhdx-compaction"), scope ("global" if it applies across codebases: owner preferences, machine/account/tool quirks, cross-project playbooks; otherwise "repo:<Name>" using a name from the REPO LIST when the fact is about one codebase), and a one-line reason.
The index has two parts: GLOBAL INDEX (title, slug, hook) and REPO INDEXES (per repo, titles and slugs only). A candidate that matches an entry in either part is a duplicate."""

SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["duplicate", "trivial", "keep"]},
        "score": {"type": "number"},
        "key": {"type": "string"},
        "matches": {"type": "string", "description": "slug of the existing memory it duplicates, else empty"},
        "scope": {"type": "string", "description": "global or repo:<Name>"},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "score", "key", "scope", "reason"],
}
VERDICTS = ("keep", "duplicate", "trivial", "rejected")

# Admission gate. WHY: a kept memory is replayed into every future session's context, so an
# instruction-shaped record is a standing prompt injection, and a record with no source anchor
# cannot be caught going stale when the code it describes moves. Bare mentions of "system prompt"
# stay admissible (memories about this very tooling use the phrase); commands aimed at it do not.
INSTRUCTION_SHAPES = re.compile(
    r"\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?"
    r"(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?|context)"
    r"|\b(?:reveal|print|repeat|show|leak|output|ignore|override|disregard)\s+(?:your|the)\s+system\s+prompt"
    r"|\bsystem\s+prompt\s*:"
    r"|\byou\s+are\s+now\s+(?:a|an|in)\b"
    r"|\bnew\s+instructions?\s*:"
    r"|<\|?\s*/?\s*(?:system|im_start|im_end)\s*\|?>",
    re.I,
)
SESSION_ANCHOR = re.compile(r"^session\s+[0-9A-Za-z_-]{6,}(?:\s|$)")
FILE_ANCHOR = re.compile(r"^(?P<path>(?:[A-Za-z]:[\\/])?[^:\s][^:]*):(?P<line>[1-9]\d*)(?:\s|$)")
TRAVERSAL = re.compile(r"(?:^|[\\/])\.\.(?:[\\/]|$)")


def anchor_problem(source: str, root: Path | None = None) -> str:
    """Why `source` is not a usable anchor, or "" when it is. A relative path with no root is
    accepted as cited (it cannot be checked here); anything resolvable is checked on disk."""
    s = source.strip()
    if not s:
        return "no source anchor"
    if SESSION_ANCHOR.match(s):
        return ""
    m = FILE_ANCHOR.match(s)
    if not m:
        return f"source is not an anchor (session <id> or path:line): {s[:80]}"
    path, line = m.group("path").strip(), int(m.group("line"))
    if TRAVERSAL.search(path):
        return f"source path traverses (..): {path[:80]}"
    p = Path(path)
    if not p.is_absolute():
        if root is None:
            return ""
        p = root / p
    if not p.is_file():
        return f"cited file no longer exists: {path[:80]}"
    with p.open(encoding="utf-8", errors="replace") as fh:
        n = sum(1 for _ in fh)
    return f"cited line {line} is past the end of {path[:80]} ({n} lines)" if line > n else ""


def admission_problem(c: dict, root: Path | None = None) -> str:
    """Why candidate `c` (from parse_candidate) must not be proposed as a memory, or "" to admit it."""
    text = f"{c.get('name', '')}\n{c.get('description', '')}\n{c.get('body', '')}"
    if m := INSTRUCTION_SHAPES.search(text):
        return f"instruction-shaped text: {m.group(0)[:60]!r}"
    if redact(text)[1]:
        return "secret-shaped text"
    return anchor_problem(c.get("source", ""), root)


def load_repo_indexes(repos_dir: Path) -> tuple[str, list[str]]:
    names = []
    blocks = []
    if repos_dir.exists():
        for d in sorted(repos_dir.iterdir()):
            idx = d / "MEMORY.md"
            if not d.is_dir() or not idx.exists():
                continue
            names.append(d.name)
            titles = [f"[{m.group(1)[:90]}]({m.group(2)})" for l in idx.read_text(encoding="utf-8").splitlines() if (m := re.match(r"- \[(.*?)\]\((.*?)\)", l))]
            if titles:
                blocks.append(f"## {d.name}\n" + "\n".join(titles))
    return "\n".join(blocks), names


def load_index(path: Path) -> str:
    # keep the hook short: title, slug, first ~200 chars of hook
    out = []
    for l in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"- \[(.*?)\]\((.*?)\)\s*-?\s*(.*)", l)
        if l.startswith("- [") and m:
            out.append(f"[{m.group(1)}]({m.group(2)}) - {m.group(3)[:200]}")
    return "\n".join(out)


def parse_candidate(p: Path) -> dict:
    t = p.read_text(encoding="utf-8")
    parts = t.split("---", 2)
    fm = parts[1] if len(parts) > 2 else ""
    body = parts[2].strip() if len(parts) > 2 else t

    def g(k):
        m = re.search(rf"^\s*{k}:\s*(.*)$", fm, re.M)
        return m.group(1).strip() if m else ""

    return {"file": p.name, "name": g("name"), "description": g("description"), "type": g("type"), "confidence": g("confidence"), "source": g("source"), "body": body}


def _full_index(index_path: Path, repos_dir: Path | None) -> str:
    index = "GLOBAL INDEX\n" + load_index(index_path)
    if repos_dir is not None:
        repo_index, names = load_repo_indexes(repos_dir)
        index += "\n\nREPO LIST: " + ", ".join(names) + "\n\nREPO INDEXES\n" + repo_index
    return index


def _candidate_task(i: int, c: dict, index: str, model: str, staging: Path) -> Task:
    prompt = f"CANDIDATE\nname: {c['name']}\ndescription: {c['description']}\ntype: {c['type']}\nconfidence: {c['confidence']}\n\n{c['body'][:4000]}"
    return Task.from_dict({
        "id": c["file"][:-3][:60].replace(" ", "_") + f"_{i}", "prompt": prompt, "system": index, "tools": "none", "schema": SCHEMA,
        "model": model, "max_turns": 2, "thinking": False, "cwd": str(staging),
    }, {}, i)


def _row(c: dict, r) -> dict:
    d = r.data if (r.status == "ok" and isinstance(r.data, dict)) else {"verdict": "error", "score": 0.0, "key": "", "reason": r.error or "no data"}
    return {**c, "verdict": d.get("verdict", "error"), "score": float(d.get("score") or 0), "key": d.get("key", ""), "matches": d.get("matches", ""), "scope": d.get("scope", ""), "reason": d.get("reason", "")}


def _rejected_row(c: dict, problem: str) -> dict:
    return {**c, "verdict": "rejected", "score": 0.0, "key": "", "matches": "", "scope": "", "reason": problem}


def _move_by_verdict(staging: Path, rows: list[dict]) -> None:
    for r in rows:
        src = staging / r["file"]
        if r["verdict"] in VERDICTS and src.exists():
            (staging / r["verdict"]).mkdir(exist_ok=True)
            shutil.move(str(src), str(staging / r["verdict"] / r["file"]))


def _report(rows: list[dict], job_id: str, cost: float, counts: dict) -> tuple[str, int]:
    keep = sorted([r for r in rows if r["verdict"] == "keep"], key=lambda r: -r["score"])
    by_key: dict[str, list] = {}
    for r in keep:
        by_key.setdefault(r["key"] or "misc", []).append(r)
    lines = [f"# Memory triage {dt.date.today().isoformat()}", "", f"job {job_id} · {len(rows)} candidates · cost ${cost:.4f} · verdicts {counts}", "",
             "## keep, grouped by topic (highest score first)", ""]
    for key, items in sorted(by_key.items(), key=lambda kv: -max(i["score"] for i in kv[1])):
        lines.append(f"### {key} ({len(items)})")
        lines += [f"- {r['score']:.2f} [{r['type']}] ({r['scope']}) `{r['file']}` - {r['description'][:140]}  ·  {r['reason'][:120]}  ·  src {r['source'][:80]}" for r in items]
        lines.append("")
    lines += ["## duplicates (index slug they match)", ""]
    lines += [f"- `{r['file']}` -> {r['matches']}" for r in sorted([r for r in rows if r["verdict"] == "duplicate"], key=lambda r: r["matches"])]
    rejected = [r for r in rows if r["verdict"] == "rejected"]
    if rejected:
        lines += ["", "## rejected at admission (never sent to a worker)", ""]
        lines += [f"- `{r['file']}` - {r['reason']}" for r in rejected]
    return "\n".join(lines) + "\n", len(by_key)


async def triage(staging: Path, index_path: Path, model: str, concurrency: int, apply: bool, repos_dir: Path | None = None, anchor_root: Path | None = None) -> dict:
    index = _full_index(index_path, repos_dir)
    cands = [parse_candidate(p) for p in sorted(staging.glob("*.md"))]
    problems = [admission_problem(c, anchor_root) for c in cands]
    admitted = [c for c, why in zip(cands, problems) if not why]
    rows = [_rejected_row(c, why) for c, why in zip(cands, problems) if why]
    job_id, cost = "", 0.0
    if admitted:  # an all-rejected batch spends nothing
        tasks = [_candidate_task(i, c, index, model, staging) for i, c in enumerate(admitted)]
        m = JobManager()
        # Candidates are distilled transcript facts: fail-closed on egress receipts, like distill.
        with egress.fail_closed():
            job = await m.run_batch(tasks, concurrency=concurrency, label="memory-triage")
        await m.aclose()
        rows = [_row(c, job.results[t.id]) for t, c in zip(tasks, admitted)] + rows
        job_id, cost = job.id, job.summary()["cost_usd"]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    if apply:
        _move_by_verdict(staging, rows)
    text, topics = _report(rows, job_id, cost, counts)
    (staging / "TRIAGE.md").write_text(text, encoding="utf-8")
    (staging / "triage.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    return {"job_id": job_id, "candidates": len(rows), "counts": counts, "cost_usd": cost, "keep_topics": topics, "report": str(staging / "TRIAGE.md")}


def main(argv: list[str]) -> int:
    ap = batch_argparser("hswarm triage", __doc__)
    ap.add_argument("--staging", required=True)
    ap.add_argument("--index", required=True)
    ap.add_argument("--repos", help="repos/ directory holding <Name>/MEMORY.md indexes (for duplicate detection and scope)")
    ap.add_argument("--no-apply", dest="apply", action="store_false", help="report only; do not move files into verdict folders")
    ap.add_argument("--anchor-root", help="repo root that relative `source: <path>:<line>` anchors resolve against, so a stale file or line is rejected")
    a = ap.parse_args(argv)
    print(json.dumps(asyncio.run(triage(Path(a.staging), Path(a.index), a.model, a.concurrency, a.apply, Path(a.repos) if a.repos else None,
                                        Path(a.anchor_root) if a.anchor_root else None)), indent=1))
    return 0
