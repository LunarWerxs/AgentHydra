"""Triage memory candidates against the existing memory index, by the hswarm, and save the kept ones.

Every candidate (the facts `hswarm distill` hands over in the same run, or one-fact markdown files)
gets one flash worker that judges it against the current MEMORY.md index (the index rides in the
shared system prompt, so it is a cache hit after the pilot): duplicate (already known; names the
slug), trivial (session-specific, derivable from code/git, or about the transcript itself), or keep
(durable, new, actionable), with a 0-1 score and a topic key so near-duplicate candidates cluster.

Only `keep` reaches the Connections memory store (claude-memory's memstore.py, the kit's one door):
a `memory_save` with `tentative: true` (shown at once, kept once a search uses it, dropped after 30
days unused), `keep`, the score and the run id in `origin`, and the repo the worker scoped it to in
`repo` (none for a global fact). A slug already in the store is left alone (write-once: someone may
have edited it). A duplicate, trivial or rejected candidate never reaches the store. Nothing is
written to disk unless --report names a file; --dry-run judges and prints what would be saved,
and saves nothing.

Before any worker is paid, a deterministic admission gate rejects a candidate whose text is
instruction-shaped ("ignore previous instructions", "reveal the system prompt") or secret-shaped,
or that carries no checkable source anchor (`source: session <id>` as distill writes it, or
`source: <path>:<line>`). A path anchor may not traverse (`..`), and when the file can be resolved
(absolute, or relative to --anchor-root) the cited file and line must still exist. Retrieved memory
is evidence, not authority: the anchor is what lets a reader check it.

    python -m hswarm triage --candidates <folder of one-fact .md files> \
        --index <memory repo>/global/MEMORY.md --repos <memory repo>/repos
    python -m hswarm triage --replay <an earlier triage.json> --index ... --repos ... --dry-run
        re-judges that batch, counts the verdicts that match it, prints what would be saved
"""
from __future__ import annotations

import asyncio
import datetime as dt
import importlib.util
import json
import os
import re
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
KINDS = ("user", "feedback", "project", "reference")  # memory_save's kinds
CANDIDATE_FIELDS = ("file", "name", "description", "type", "confidence", "source", "body")  # parse_candidate's shape
MEMORY_REPO = Path(os.environ.get("HSWARM_MEMORY_REPO") or Path.home() / "claude-memory")  # the memory kit checkout: indexes under global/ and repos/
MEMSTORE_CHECKOUT = MEMORY_REPO / "home" / "tools"

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
            titles = [f"[{m.group(1)[:90]}]({m.group(2)})" for line in idx.read_text(encoding="utf-8").splitlines() if (m := re.match(r"- \[(.*?)\]\((.*?)\)", line))]
            if titles:
                blocks.append(f"## {d.name}\n" + "\n".join(titles))
    return "\n".join(blocks), names


def load_index(path: Path) -> str:
    # keep the hook short: title, slug, first ~200 chars of hook
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"- \[(.*?)\]\((.*?)\)\s*-?\s*(.*)", line)
        if line.startswith("- [") and m:
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


def candidates_in(folder: Path) -> list[dict]:
    """Every one-fact markdown file under `folder`, verdict subfolders of an older run included."""
    return [parse_candidate(p) for p in sorted(folder.rglob("*.md")) if p.name not in ("README.md", "TRIAGE.md")]


def replay_batch(path: Path) -> tuple[list[dict], dict[str, str]]:
    """An earlier run's triage.json as the candidates it judged, and the verdict each got then."""
    rows = json.loads(path.read_text(encoding="utf-8"))
    return [{k: str(r.get(k) or "") for k in CANDIDATE_FIELDS} for r in rows], {r["file"]: r.get("verdict", "") for r in rows}


def _candidate_task(i: int, c: dict, index: str, model: str, cwd: Path) -> Task:
    prompt = f"CANDIDATE\nname: {c['name']}\ndescription: {c['description']}\ntype: {c['type']}\nconfidence: {c['confidence']}\n\n{c['body'][:4000]}"
    return Task.from_dict({
        "id": c["file"][:-3][:60].replace(" ", "_") + f"_{i}", "prompt": prompt, "system": index, "tools": "none", "schema": SCHEMA,
        "model": model, "max_turns": 2, "thinking": False, "cwd": str(cwd),
    }, {}, i)


def _row(c: dict, r) -> dict:
    d = r.data if (r.status == "ok" and isinstance(r.data, dict)) else {"verdict": "error", "score": 0.0, "key": "", "reason": r.error or "no data"}
    return {**c, "verdict": d.get("verdict", "error"), "score": float(d.get("score") or 0), "key": d.get("key", ""), "matches": d.get("matches", ""), "scope": d.get("scope", ""), "reason": d.get("reason", "")}


def _rejected_row(c: dict, problem: str) -> dict:
    return {**c, "verdict": "rejected", "score": 0.0, "key": "", "matches": "", "scope": "", "reason": problem}


def memory_params(r: dict, run_id: str) -> dict:
    """The memory_save a kept row becomes: tentative, the verdict and run in origin, its repo or none."""
    scope = str(r.get("scope") or "").strip()
    repo = scope[5:].strip() if scope.lower().startswith("repo:") else ""
    description = " ".join(str(r.get("description") or "").split())
    body = str(r.get("body") or "").strip()
    if r.get("source"):
        body += f"\n\n**Source:** {r['source']}"
    p = {
        "slug": r["file"][:-3] if r["file"].endswith(".md") else r["file"], "title": (description or r["name"])[:120],
        "description": description, "body": body, "kind": r.get("type") if r.get("type") in KINDS else "project",
        "origin": f"hswarm triage verdict=keep score={r['score']:.2f} run={run_id}", "tentative": True,
    }
    return {**p, "repo": repo} if repo else p


def open_store():
    """The Connections memory store through claude-memory's memstore.py (the kit installs it into
    ~/.claude/tools; the shared checkout is the fallback). Opened only when a kept fact is saved."""
    for d in (Path.home() / ".claude" / "tools", MEMSTORE_CHECKOUT):
        if (d / "memstore.py").is_file():
            spec = importlib.util.spec_from_file_location("memstore", d / "memstore.py")
            memstore = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(memstore)
            return memstore.LocalMcp(memstore.home_folder())
    raise RuntimeError(f"memstore.py not found in ~/.claude/tools or {MEMSTORE_CHECKOUT}")


def save_kept(rows: list[dict], run_id: str, store=None, dry_run: bool = False) -> dict:
    """Save every `keep` row to the store (`store.tool(name, params)`, memstore.LocalMcp's shape). The
    other verdicts are listed as dropped and never sent. dry_run lists the saves and opens no store."""
    kept = [memory_params(r, run_id) for r in rows if r["verdict"] == "keep"]
    dropped = [{"file": r["file"], "verdict": r["verdict"], "reason": str(r.get("reason") or "")[:200]} for r in rows if r["verdict"] != "keep"]
    if dry_run:
        return {"would_save": kept, "dropped": dropped}
    out: dict = {"saved": [], "already_saved": [], "errors": [], "dropped": dropped}
    if not kept:
        return out
    own = store is None
    store = store or open_store()
    try:
        for p in kept:
            try:
                # Write-once: the slug is the upsert key, and a person may have edited the earlier copy.
                if re.search(r"(?m)^slug: ", store.tool("memory_open", {"id": p["slug"], **({"repo": p["repo"]} if "repo" in p else {})})):
                    out["already_saved"].append(p["slug"])
                    continue
                answer = store.tool("memory_save", p)
                out["saved"].append({"slug": p["slug"], "repo": p.get("repo", ""), "answer": (answer.splitlines() or [""])[0][:200]})
            except RuntimeError as err:  # memstore.StoreError: the save was refused, or the store did not answer
                out["errors"].append({"slug": p["slug"], "error": str(err)[:300]})
    finally:
        if own:
            store.close()
    return out


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


def _compare(rows: list[dict], expect: dict[str, str]) -> dict:
    """How this run's verdicts line up with an earlier run's on the same candidates."""
    changed = [{"file": r["file"], "before": expect[r["file"]], "after": r["verdict"]} for r in rows if r["file"] in expect and expect[r["file"]] != r["verdict"]]
    compared = sum(1 for r in rows if r["file"] in expect)
    return {"compared": compared, "same": compared - len(changed), "changed": changed}


async def triage(cands: list[dict], index_path: Path, model: str, concurrency: int, repos_dir: Path | None = None, anchor_root: Path | None = None,
                 *, dry_run: bool = False, store=None, cwd: Path | None = None, report: Path | None = None, expect: dict[str, str] | None = None) -> dict:
    """Judge `cands` (parse_candidate's shape), then save the kept ones to the store (save_kept)."""
    index = _full_index(index_path, repos_dir)
    problems = [admission_problem(c, anchor_root) for c in cands]
    admitted = [c for c, why in zip(cands, problems) if not why]
    rows = [_rejected_row(c, why) for c, why in zip(cands, problems) if why]
    job_id, cost = "", 0.0
    if admitted:  # an all-rejected batch spends nothing
        tasks = [_candidate_task(i, c, index, model, cwd or Path.cwd()) for i, c in enumerate(admitted)]
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
    out = {"run_id": job_id, "candidates": len(rows), "counts": counts, "cost_usd": cost, "dry_run": dry_run}
    if expect is not None:
        out["replay"] = _compare(rows, expect)
    out.update(save_kept(rows, job_id, store, dry_run))
    if report is not None:
        text, out["keep_topics"] = _report(rows, job_id, cost, counts)
        report.write_text(text, encoding="utf-8")
        out["report"] = str(report)
    return out


def main(argv: list[str]) -> int:
    ap = batch_argparser("hswarm triage", __doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--candidates", help="folder of one-fact .md candidates (subfolders included)")
    src.add_argument("--replay", help="an earlier run's triage.json: re-judge its candidates and count the verdicts that match")
    ap.add_argument("--index", required=True)
    ap.add_argument("--repos", help="repos/ directory holding <Name>/MEMORY.md indexes (for duplicate detection and scope)")
    ap.add_argument("--limit", type=int, help="judge only the first N candidates")
    ap.add_argument("--dry-run", action="store_true", help="judge and print what would be saved to the memory store; save nothing")
    ap.add_argument("--report", help="also write the TRIAGE.md summary to this file")
    ap.add_argument("--anchor-root", help="repo root that relative `source: <path>:<line>` anchors resolve against, so a stale file or line is rejected")
    a = ap.parse_args(argv)
    expect = None
    if a.replay:
        cands, expect = replay_batch(Path(a.replay))
    else:
        cands = candidates_in(Path(a.candidates))
    cands = cands[: a.limit] if a.limit else cands
    where = Path(a.candidates or a.replay).resolve()
    print(json.dumps(asyncio.run(triage(cands, Path(a.index), a.model, a.concurrency, Path(a.repos) if a.repos else None,
                                        Path(a.anchor_root) if a.anchor_root else None, dry_run=a.dry_run,
                                        cwd=where if where.is_dir() else where.parent, report=Path(a.report) if a.report else None,
                                        expect=expect)), indent=1, ensure_ascii=False))
    return 0
