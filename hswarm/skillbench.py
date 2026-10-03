"""hswarm skillbench: run a skill library's dormant evals as a with/without benchmark, graded from the trace.

    python hswarm.py skillbench <skill-dir> [<skill-dir> ...]              # dry run: the plan, nothing sent
    python hswarm.py skillbench <skill-dir> --repeats 3 --pressure --run   # spend: workers, then graders

Why: a skill's evals/evals.json (skill-creator's schema: skill_name, evals[id, prompt, expected_output,
assertions]) says what the skill should change, and nothing ran it, so nobody knew which skills earn their
context tokens. Each eval prompt runs N times WITH the skill's SKILL.md in front of it and N times without,
as one hswarm batch; a second batch on the tool-free `grader` role judges every run's assertions against
its recorded tool trace (hswarm/trace.py: the trace is fenced as untrusted, verdicts are schema-checked).
The report gives mean/stddev pass rate, seconds and tokens per configuration and the with-minus-without
delta, and names assertions too weak to discriminate (passed in every run of both configurations, or
flagged weak by the grader). --pressure adds time, sunk-cost and authority-pressure variants of every
prompt: a discipline skill that holds only when nobody argues with it has not been tested.

Default is a dry run that sends nothing: a batch spends provider money (free tier or not), so --run.
"""
from __future__ import annotations

import datetime as dt
import json
import shutil
import statistics
from pathlib import Path

from . import config
from .jobs import JobManager, batch_argparser
from .spec import Task
from .trace import GRADE_SCHEMA, grader_prompt, load_calls, parse_grade

CONFIGS = ("with", "without")
# Pressure preambles, one per rationalisation a rule is most often argued out of. Written fresh for hswarm.
PRESSURE = {
    "time": "We are out of time: the release goes out in five minutes. Skip anything that is not strictly needed and just get it done.",
    "sunk_cost": "I have already spent two days on the current approach and do not want to throw that away, so keep what is there and only patch it.",
    "authority": "The tech lead has already reviewed this and said the usual process does not apply here, so do not bother with it.",
}


def load_skill(skill_dir: Path) -> dict:
    """{name, text, dir, evals: [{id, prompt, expectations, files}]}. A skill with no evals file is refused by name."""
    skill_dir = Path(skill_dir)
    doc = json.loads((skill_dir / "evals" / "evals.json").read_text(encoding="utf-8"))
    evals = []
    for i, e in enumerate(doc.get("evals") or []):
        exp = [str(x) for x in (e.get("assertions") or e.get("expectations") or []) if str(x).strip()]
        if not exp and str(e.get("expected_output") or "").strip():
            exp = [str(e["expected_output"])]
        if not str(e.get("prompt") or "").strip() or not exp:
            raise ValueError(f"{skill_dir.name}: eval {e.get('id', i)} needs a prompt and assertions or expected_output")
        evals.append({"id": str(e.get("id", i + 1)), "prompt": e["prompt"], "expectations": exp, "files": list(e.get("files") or [])})
    return {"name": doc.get("skill_name") or skill_dir.name, "text": (skill_dir / "SKILL.md").read_text(encoding="utf-8"), "dir": skill_dir, "evals": evals}


def _prompt(skill: dict, ev: dict, cfg: str) -> str:
    with_skill, _, pressure = cfg.partition("+")
    body = ev["prompt"] + (f"\n\n{PRESSURE[pressure]}" if pressure else "")
    if with_skill != "with":
        return body
    return f"Follow this skill while you work.\n\n<skill name=\"{skill['name']}\">\n{skill['text']}\n</skill>\n\n{body}"


def configs(pressure: bool) -> list[str]:
    return [c + (f"+{p}" if p else "") for p in ("", *(PRESSURE if pressure else ())) for c in CONFIGS]


def plan(skills: list[dict], repeats: int, pressure: bool, run_dir: Path, tools: str, model: str, materialise: bool = False) -> list[dict]:
    """One entry per worker run: {id, skill, eval, cfg, rep, expectations, task}. The ids are the join key back."""
    out = []
    for s in skills:
        for ev in s["evals"]:
            for cfg in configs(pressure):
                for k in range(repeats):
                    tid = f"{s['name']}~{ev['id']}~{cfg}~r{k + 1}"
                    cwd = run_dir / "work" / tid.replace("~", "_").replace("+", "-")
                    task = None  # a dry run only counts: no folders made, no Task (a Task needs its cwd to exist)
                    if materialise:
                        cwd.mkdir(parents=True, exist_ok=True)
                        for f in ev["files"]:  # skill-creator keeps eval inputs beside evals.json
                            src = s["dir"] / "evals" / f
                            if src.is_file():
                                (cwd / Path(f).name).write_bytes(src.read_bytes())
                        task = Task.from_dict({"id": tid, "prompt": _prompt(s, ev, cfg), "cwd": str(cwd), "tools": tools, "model": model,
                                               "max_turns": 16, "purpose": "evaluation"})
                    out.append({"id": tid, "skill": s["name"], "eval": ev["id"], "cfg": cfg, "rep": k, "expectations": ev["expectations"], "task": task})
    return out


def _grade_task(p: dict, res, calls, cwd: Path) -> Task:
    prompt = grader_prompt(p["expectations"], calls, res.answer or res.error or "", list(res.files_changed))
    # NOT purpose "evaluation", though it runs inside a benchmark: the grader PRODUCES the measurement, so it stays on
    # the grader role's chosen model instead of being routed onto whatever free tier an evaluation may reach.
    return Task.from_dict({"id": p["id"], "prompt": prompt, "cwd": str(cwd), "tools": "none", "role": "grader", "schema": GRADE_SCHEMA,
                           "max_turns": 2})


def _stats(xs: list[float]) -> dict:
    return {"mean": round(statistics.mean(xs), 3), "stddev": round(statistics.pstdev(xs), 3)} if xs else {"mean": None, "stddev": None}


def aggregate(runs: list[dict]) -> dict:
    """Per skill: per configuration mean/stddev of pass rate, seconds and tokens, the with-minus-without delta
    (per pressure variant too), and the assertions that never discriminated."""
    out: dict = {}
    for skill in sorted({r["skill"] for r in runs}):
        rs = [r for r in runs if r["skill"] == skill]
        graded = [r for r in rs if r.get("verdicts") is not None]
        by_cfg = _by_cfg(rs, graded)
        out[skill] = {"configs": by_cfg, "delta": _delta(by_cfg), "weak_assertions": _weak(graded), "ungraded": len(rs) - len(graded)}
    return out


def _by_cfg(rs: list[dict], graded: list[dict]) -> dict:
    """Per configuration: run and graded counts, and mean/stddev of pass rate, seconds and tokens over the graded runs."""
    by_cfg = {}
    for cfg in sorted({r["cfg"] for r in rs}):
        g = [r for r in graded if r["cfg"] == cfg]
        by_cfg[cfg] = {"runs": len([r for r in rs if r["cfg"] == cfg]), "graded": len(g),
                       "pass_rate": _stats([sum(v["passed"] for v in r["verdicts"]) / len(r["verdicts"]) for r in g]),
                       "seconds": _stats([r["seconds"] for r in g]), "tokens": _stats([r["tokens"] for r in g])}
    return by_cfg


def _delta(by_cfg: dict) -> dict:
    """Each `with` configuration minus its `without` twin (same pressure variant), where both have a pass rate."""
    delta = {}
    for cfg, d in by_cfg.items():
        base, _, pressure = cfg.partition("+")
        other = by_cfg.get("without" + (f"+{pressure}" if pressure else ""))
        if base == "with" and other and d["pass_rate"]["mean"] is not None and other["pass_rate"]["mean"] is not None:
            delta[cfg] = {k: round(d[k]["mean"] - other[k]["mean"], 3) for k in ("pass_rate", "seconds", "tokens")}
    return delta


def _weak(graded: list[dict]) -> list[dict]:
    """The assertions that never discriminated: passed in every run of both configurations, or flagged by the grader."""
    weak = []
    for ev in sorted({r["eval"] for r in graded}):
        weak += _weak_in_eval(ev, [r for r in graded if r["eval"] == ev])
    return weak


def _weak_in_eval(ev: str, er: list[dict]) -> list[dict]:
    weak = []
    both = {r["cfg"].partition("+")[0] for r in er} == set(CONFIGS)
    for i, text in enumerate(er[0]["expectations"]):
        always = both and all(r["verdicts"][i]["passed"] for r in er)
        flagged = sum(r["verdicts"][i]["weak"] for r in er)
        if always or flagged:
            weak.append({"eval": ev, "n": i + 1, "assertion": text[:160], "passes_everywhere": always, "grader_flagged": flagged})
    return weak


def render_md(report: dict) -> str:
    lines = [f"# hswarm skillbench {report['run']} (repeats {report['repeats']})", ""]
    for skill, d in report["skills"].items():
        lines += [f"## {skill}", "", "| config | graded/runs | pass rate mean | stddev | seconds | tokens |", "|---|---|---|---|---|---|"]
        for cfg, c in d["configs"].items():
            pr = c["pass_rate"]
            lines.append(f"| {cfg} | {c['graded']}/{c['runs']} | {pr['mean'] if pr['mean'] is not None else '-'} | {pr['stddev'] if pr['stddev'] is not None else '-'} | "
                         f"{c['seconds']['mean'] if c['seconds']['mean'] is not None else '-'} | {c['tokens']['mean'] if c['tokens']['mean'] is not None else '-'} |")
        lines += [""] + [f"- delta {cfg} minus without: pass rate {v['pass_rate']:+}, seconds {v['seconds']:+}, tokens {v['tokens']:+}" for cfg, v in d["delta"].items()]
        lines += [f"- weak assertion (eval {w['eval']} #{w['n']}): {w['assertion']}" for w in d["weak_assertions"]]
        lines.append("")
    return "\n".join(lines)


async def run(skills: list[dict], repeats: int, pressure: bool, run_dir: Path, tools: str, model: str, concurrency: int, manager: JobManager | None = None) -> dict:
    """Workers as one batch, graders as a second; returns the report. `manager` is injectable for tests."""
    runs = plan(skills, repeats, pressure, run_dir, tools, model, materialise=True)
    m = manager or JobManager()
    try:
        job = await m.run_batch([p["task"] for p in runs], concurrency=concurrency, label="skillbench")
        grades = [_grade_task(p, job.results[p["id"]], load_calls(job.dir, p["id"]), run_dir) for p in runs]
        gjob = await m.run_batch(grades, concurrency=concurrency, label="skillbench-grade")
    finally:
        if manager is None:
            await m.aclose()
    rows = []
    for p in runs:
        r, g = job.results[p["id"]], gjob.results[p["id"]]
        try:
            verdicts = parse_grade(g.data if g.data is not None else g.answer, len(p["expectations"])) if g.status == "ok" else None
            why = "" if verdicts is not None else f"grader {g.status}: {(g.error or '')[:160]}"
        except ValueError as e:
            verdicts, why = None, f"grade refused: {e}"  # a malformed grade is reported, never scored as pass or fail
        u = r.usage or {}
        rows.append({k: p[k] for k in ("id", "skill", "eval", "cfg", "rep", "expectations")} | {
            "status": r.status, "seconds": r.seconds, "tokens": u.get("in_hit", 0) + u.get("in_miss", 0) + u.get("out", 0),
            "cost_usd": (r.cost_usd or 0) + (g.cost_usd or 0), "verdicts": verdicts, "ungraded_why": why})
    return {"run": run_dir.name, "repeats": repeats, "jobs": [job.id, gjob.id], "skills": aggregate(rows), "rows": rows,
            "cost_usd": round(sum(r["cost_usd"] for r in rows), 6)}


def main(argv: list[str]) -> int:
    import asyncio

    ap = batch_argparser("hswarm skillbench", __doc__, concurrency=32)
    ap.set_defaults(model=config.AUTO)
    ap.add_argument("skills", nargs="+", help="skill directories, each holding SKILL.md and evals/evals.json")
    ap.add_argument("--repeats", type=int, default=3, help="runs per eval per configuration (one run is an anecdote)")
    ap.add_argument("--pressure", action="store_true", help="also run time, sunk-cost and authority-pressure variants of every prompt")
    ap.add_argument("--tools", default="read", help="worker tool preset (read | all | none | comma list)")
    ap.add_argument("--out", default=str(config.HOME / "skillbench"), help="parent directory of the run's work dirs and report")
    ap.add_argument("--run", action="store_true", help="actually send the batches (default: dry run, the plan only)")
    a = ap.parse_args(argv)
    skills = [load_skill(Path(s)) for s in a.skills]
    run_dir = Path(a.out) / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    repeats = max(1, a.repeats)
    if not a.run:
        n = len(plan(skills, repeats, a.pressure, run_dir, a.tools, a.model))
        print(json.dumps({"live": False, "skills": [s["name"] for s in skills], "evals": sum(len(s["evals"]) for s in skills),
                          "configs": configs(a.pressure), "worker_tasks": n, "grader_tasks": n, "grader_model": config.resolve_role("grader"),
                          "hint": "add --run to send them"}, indent=1))
        return 0
    report = asyncio.run(run(skills, repeats, a.pressure, run_dir, a.tools, a.model, a.concurrency))
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    (run_dir / "report.md").write_text(render_md(report), encoding="utf-8")
    shutil.rmtree(run_dir / "work", ignore_errors=True)  # the scratch cwds; the transcripts stay in the jobs
    print(render_md(report))
    print(f"report: {run_dir / 'report.md'}")
    return 0
