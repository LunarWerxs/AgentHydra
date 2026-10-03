"""Episodic -> semantic memory distillation, done by the hswarm.

Reads Claude Code session transcripts (transcripts.py: found, flattened, REDACTED), and asks a
deepseek-flash worker for the few durable facts each session taught (schema-enforced). The
candidates go straight to triage (triage.py) in the same run: nothing is written to disk, a kept
fact is saved to the Connections memory store as `tentative`, and a dropped one never reaches it.

By default it only plans: it lists what WOULD be sent (size, estimated cost, redaction counts)
and sends nothing. Sending transcript text to DeepSeek is a data-exposure decision; make it on
purpose with --live. --live --dry-run sends and judges but saves nothing, printing what would be
saved. A live run is FAIL-CLOSED on egress receipts (egress.py): a session whose receipt cannot be
written to ~/.hswarm/egress-*.jsonl is not sent.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import config, egress, triage
from .candidates import fact_candidates
from .jobs import JobManager, batch_argparser
from .spec import Task
from .transcripts import extract, find_transcripts, redact  # noqa: F401 - re-exported

MEMORY_REPO = triage.MEMORY_REPO  # the MEMORY.md indexes triage judges against

SYSTEM = """You distill ONE agent session transcript into durable memory facts for a shared, file-based memory the whole team reads.
Keep only what a future session could not derive from the code, git history, or the docs: how the owner wants agents to work (feedback, with the WHY), who they are, ongoing goals/constraints, machine/account/tool quirks that cost time, and references (URLs, dashboards, tickets).
Rules: one fact per entry; write the body so it stands alone; convert relative dates to absolute using the session date; never include secrets, tokens, emails or credentials (they are already redacted; if a fact would need one, drop the fact); no facts about the transcript itself; 0 to 6 facts, usually 1-3; confidence 0.3-0.9 (0.9 = the owner said it explicitly and it is general). If nothing durable was learned, return an empty list."""

SCHEMA = {
    "type": "object",
    "properties": {
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "short kebab-case slug"},
                    "description": {"type": "string", "description": "one line used for recall"},
                    "type": {"type": "string", "enum": ["user", "feedback", "project", "reference"]},
                    "body": {"type": "string", "description": "the fact; for feedback/project include **Why:** and **How to apply:** lines"},
                    "confidence": {"type": "number"},
                    "evidence": {"type": "string", "description": "a short paraphrase of the transcript moment that supports it"},
                },
                "required": ["name", "description", "type", "body", "confidence", "evidence"],
            },
        }
    },
    "required": ["facts"],
}


def _session_task(s: dict, model: str, cwd: str) -> Task:
    return Task.from_dict({
        "id": s["session_id"][:16], "prompt": f"Session date: {s['date']}. Transcript follows.\n\n{s['text']}",
        "system": SYSTEM, "tools": "none", "schema": SCHEMA, "model": model, "max_turns": 2, "thinking": False, "cwd": cwd,
    }, {}, 0)


def _plan(sessions: list[dict], model: str, live: bool, dry_run: bool) -> dict:
    """The plan: what would be sent, what it would cost, how much was redacted."""
    est_tokens = sum(s["chars"] for s in sessions) // 4
    return {
        "sessions": len(sessions),
        "chars": sum(s["chars"] for s in sessions),
        "redactions": sum(s["redactions"] for s in sessions),
        "est_prompt_tokens": est_tokens,
        "est_cost_usd": round(config.cost_usd(model, 0, est_tokens, 800 * len(sessions)), 4),
        "rate": "peak" if config.is_peak() else "off-peak",
        "live": live,
        "dry_run": dry_run,
        "candidates": 0,
        "per_session": [{"session": s["session_id"][:12], "date": s["date"], "turns": s["turns"], "chars": s["chars"], "redactions": s["redactions"]} for s in sessions],
    }


async def distill(paths: list[Path], live: bool, model: str = config.DEFAULT_MODEL, concurrency: int = 32, *, index: Path = MEMORY_REPO / "global" / "MEMORY.md",
                  repos: Path | None = None, dry_run: bool = False, store=None) -> dict:
    """Distill `paths`, then hand every candidate to triage.triage in the same run (`store` and
    `dry_run` go through to it: a keep is saved tentative, or with dry_run only listed)."""
    sessions = [extract(p) for p in paths]
    report = _plan(sessions, model, live, dry_run)
    if not live:
        return report
    if not index.is_file():  # judged against no index, every candidate would look new
        raise FileNotFoundError(f"triage index not found: {index}")
    cwd = str(Path.cwd())
    by_id = {s["session_id"][:16]: s for s in sessions if s["chars"] >= 500}  # a near-empty session teaches nothing
    tasks = [_session_task(s, model, cwd) for s in by_id.values()]
    if not tasks:
        return report
    m = JobManager()
    # Transcript text is the most sensitive thing the swarm sends: no receipt in the egress ledger, no send.
    with egress.fail_closed():
        job = await m.run_batch(tasks, concurrency=concurrency, label="distill")
    await m.aclose()
    report["job_id"], report["cost_usd"] = job.id, job.summary()["cost_usd"]
    cands = []
    for t in tasks:
        r = job.results[t.id]
        if r.status != "ok" or not isinstance(r.data, dict):
            report.setdefault("errors", []).append({"session": t.id, "error": r.error})
            continue
        cands += fact_candidates(by_id[t.id], r.data.get("facts") or [])
    report["candidates"] = len(cands)
    if cands:
        report["triage"] = await triage.triage(cands, index, model, concurrency, repos, dry_run=dry_run, store=store, cwd=Path(cwd))
    return report


def main(argv: list[str]) -> int:
    import asyncio

    ap = batch_argparser("hswarm distill", __doc__, concurrency=32)
    ap.add_argument("--root", default=str(Path.home() / ".claude" / "projects"))
    ap.add_argument("--project", help="substring filter on the project slug dir")
    ap.add_argument("--exclude", action="append", default=[], help="skip project slug dirs containing this substring (repeatable)")
    ap.add_argument("--since", type=float, default=7.0, help="days")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--file", action="append", help="explicit transcript path(s); overrides --root scanning")
    ap.add_argument("--index", default=str(MEMORY_REPO / "global" / "MEMORY.md"), help="the global MEMORY.md index triage judges candidates against")
    ap.add_argument("--repos", default=str(MEMORY_REPO / "repos"), help="repos/ directory holding <Name>/MEMORY.md indexes (skipped when missing)")
    ap.add_argument("--live", action="store_true", help="actually send to DeepSeek, triage the facts and save the kept ones to the memory store (default: plan only)")
    ap.add_argument("--dry-run", action="store_true", help="with --live: send and triage, print what would be saved, save nothing")
    a = ap.parse_args(argv)
    paths = [Path(f) for f in a.file] if a.file else find_transcripts(Path(a.root), a.since, a.project, a.exclude)[: a.limit]
    repos = Path(a.repos) if a.repos and Path(a.repos).is_dir() else None
    print(json.dumps(asyncio.run(distill(paths, a.live, a.model, a.concurrency, index=Path(a.index), repos=repos, dry_run=a.dry_run)), indent=1, ensure_ascii=False))
    return 0
