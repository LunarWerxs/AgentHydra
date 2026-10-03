"""Memory index diet with a recall test in front of it (move one of the 2026-09-15 plan).

The global MEMORY.md index had grown to ~41k tokens because every hook is a paragraph. This
tool (1) asks a flash worker, per index entry, for one realistic question a future session
would ask and a <=30-word hook that keeps the trigger words (hooks.py); (2) measures recall:
given a question, can a model pick the right slug from the LONG index and from the SHORT index
(recall@1, flash as the reader, cached prefix so it is cents); (3) writes the short index
only when short recall is within `--tolerance` of long recall, keeping the long hook for
any entry whose recall dropped.

    python -m hswarm indexdiet --index /path/to/MEMORY.md --apply
    python -m hswarm indexdiet --index ... --report-only     # measure, write nothing
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
from pathlib import Path

from .hooks import RECALL_SCHEMA, RECALL_SYSTEM, parse_index, render, rewrite_hooks, worker
from .jobs import JobManager, batch_argparser


async def _measure_recall(m: JobManager, entries: list[dict], model: str, cwd: str, samples: int, concurrency: int):
    """Sets e['recall_long'] / e['recall_short'] (hits out of `samples`); returns (job, recall_long, recall_short, dropped_slugs)."""
    indexes = {"long": render(entries, "hook"), "short": render(entries, "short")}
    tasks = [
        worker(f"{variant}{s}_{i}", f"QUESTION: {e['question']}", RECALL_SYSTEM + "\n\nINDEX\n" + idx, RECALL_SCHEMA, model, cwd, i)
        for i, e in enumerate(entries) for variant, idx in indexes.items() for s in range(samples)
    ]
    job = await m.run_batch(tasks, concurrency=concurrency, label="indexdiet-recall")
    hits = {"long": 0.0, "short": 0.0}
    dropped = []
    for i, e in enumerate(entries):
        for variant in indexes:
            k = 0
            for s in range(samples):
                r = job.results[f"{variant}{s}_{i}"]
                slug = str((r.data or {}).get("slug", "")) if r.status == "ok" and isinstance(r.data, dict) else ""
                k += slug.strip() == e["slug"]
            e[f"recall_{variant}"] = k
            hits[variant] += k / samples
        if e["recall_short"] < e["recall_long"]:
            dropped.append(e["slug"])  # this entry keeps its long hook whatever the aggregate says
    n = len(entries)
    return job, hits["long"] / n, hits["short"] / n, dropped


def _apply(index_path: Path, lines: list[str], entries: list[dict], report: dict) -> None:
    """Write the index: the short hook where it measured no worse, the long hook elsewhere. Dated backup first."""
    new_lines = list(lines)
    kept_long = 0
    for e in entries:
        use_short = e["recall_short"] >= e["recall_long"] and e["short"] != e["hook"]
        kept_long += not use_short
        new_lines[e["line"]] = f"- [{e['title']}]({e['slug']}) - {e['short'] if use_short else e['hook']}"
    backup = index_path.parent / f"MEMORY.md.before-diet-{dt.date.today().isoformat()}"
    backup.write_text("\n".join(lines) + "\n", encoding="utf-8")
    index_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    report.update({"applied": True, "entries_kept_long": kept_long, "backup": str(backup), "tokens_after": len(index_path.read_text(encoding="utf-8")) // 4})


async def indexdiet(index_path: Path, apply: bool, tolerance: float, max_words: int, concurrency: int, model: str, sample: int | None, samples: int = 2, min_coverage: float = 0.85) -> dict:
    lines, entries = parse_index(index_path)
    if sample:
        entries = entries[:sample]
    m = JobManager()
    cwd = str(index_path.parent)
    rewrite_jobs = await rewrite_hooks(m, entries, model, cwd, max_words, min_coverage, concurrency)
    recall_job, long_r, short_r, dropped = await _measure_recall(m, entries, model, cwd, samples, concurrency)
    await m.aclose()
    long_tokens = len(render(entries, "hook")) // 4
    short_tokens = len(render(entries, "short")) // 4
    # What would actually be written: the short hook where it measured no worse, the long hook elsewhere.
    mixed_tokens = len(render([{**e, "mixed": e["hook"] if e["slug"] in set(dropped) or e["short"] == e["hook"] else e["short"]} for e in entries], "mixed")) // 4
    verdict = "apply" if short_r >= long_r - tolerance or mixed_tokens < long_tokens * 0.9 else "hold"
    report = {
        "entries": len(entries), "samples_per_variant": samples, "recall_long": round(long_r, 3), "recall_short": round(short_r, 3), "entries_where_short_lost": len(dropped),
        "shortened_with_full_trigger_coverage": sum(1 for e in entries if e["short"] != e["hook"]),
        "tokens_long": long_tokens, "tokens_short_all": short_tokens, "tokens_after_per_entry_fallback": mixed_tokens,
        "verdict": verdict, "tolerance": tolerance, "min_coverage": min_coverage,
        "cost_usd": round(sum(j.summary()["cost_usd"] for j in rewrite_jobs) + recall_job.summary()["cost_usd"], 4),
        "jobs": [j.id for j in rewrite_jobs] + [recall_job.id],
    }
    (index_path.parent / "INDEXDIET.json").write_text(json.dumps({"report": report, "entries": entries}, indent=1, ensure_ascii=False), encoding="utf-8")
    if apply and verdict == "apply":
        _apply(index_path, lines, entries, report)
    return report


def main(argv: list[str]) -> int:
    ap = batch_argparser("hswarm indexdiet", __doc__)
    ap.add_argument("--index", required=True)
    ap.add_argument("--apply", action="store_true", help="rewrite the index if the recall test passes (a dated backup is written next to it)")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--tolerance", type=float, default=0.03, help="allowed recall drop, fraction (default 0.03)")
    ap.add_argument("--max-words", type=int, default=40)
    ap.add_argument("--samples", type=int, default=2, help="recall samples per entry per variant")
    ap.add_argument("--min-coverage", type=float, default=0.85, help="share of the long hook's proper nouns/paths/numbers the short hook must keep")
    ap.add_argument("--sample", type=int, help="only the first N entries (for a dry measurement)")
    a = ap.parse_args(argv)
    rep = asyncio.run(indexdiet(Path(a.index), a.apply and not a.report_only, a.tolerance, a.max_words, a.concurrency, a.model, a.sample, a.samples, a.min_coverage))
    print(json.dumps(rep, indent=1))
    return 0
