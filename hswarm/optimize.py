"""Keep-or-revert metric ratchet: one worker grinds a measurable target unattended.

A fan-out answers one-shot questions; nothing ground a number down overnight. This runs ONE worker in
its own git worktree on its own branch, attempt after attempt: the worker edits only the target paths,
the loop runs the metric command under a fixed wall-clock budget (killed at 2x), reads one number, and
COMMITS the attempt if the number improved or RESETS it if it did not. So the branch is always a working
best-so-far, never a half-broken tree. A simplicity rule (after karpathy/autoresearch's program.md)
keeps a deletion that holds the metric and discards a tiny gain that adds code.

The worker never runs git (the shared-tree refusal in tools.py still applies); this loop owns every
commit, and only ever in the worktree it created under ~/.hswarm/optimize/<run>/tree.

    python -m hswarm optimize --repo D:/proj --target src/fast.py --metric "python bench.py" \\
        --direction min --budget-s 300 --attempts 20 --goal "Make the parser in src/fast.py faster."
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import math
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from . import config
from .procs import CREATE_NO_WINDOW, find_bash, run_hidden
from .spec import Result, Task

DIRECTIONS = ("min", "max")
# The default metric is the LAST number the command prints; nan/inf count, so a diverged run reads as one.
_NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|\b(?:nan|inf)\b", re.I)


@dataclass
class Optimize:
    repo: str
    goal: str
    targets: list[str]
    metric: str  # a bash command run at the worktree root
    direction: str = "min"
    budget_s: int = 300  # the metric run's budget; it is killed at twice this
    attempts: int = 10
    pattern: str | None = None  # regex; group 1 (else the whole match) of its LAST hit is the metric
    min_gain: float = 0.0  # relative gain an attempt that ADDS lines must beat to be kept
    budget_usd: float | None = None  # stop once the workers have spent this much
    worker: dict = field(default_factory=dict)  # Task defaults for the editing worker (model, role, max_cost_usd ...)

    def validated(self) -> "Optimize":
        if self.direction not in DIRECTIONS:
            raise ValueError(f"direction must be one of {DIRECTIONS}")
        if not self.targets or any(Path(t).is_absolute() or ".." in Path(t).parts for t in self.targets):
            raise ValueError("targets: one or more paths relative to the repo root, none escaping it")
        if not self.metric.strip() or not self.goal.strip():
            raise ValueError("metric and goal are required")
        self.targets = [Path(t).as_posix().rstrip("/") for t in self.targets]
        self.attempts, self.budget_s = max(1, int(self.attempts)), max(5, int(self.budget_s))
        return self


def parse_metric(text: str, pattern: str | None = None) -> float | None:
    """The number an attempt scored, or None when there is none or it is nan/inf (a diverged run)."""
    if pattern:
        hits = list(re.finditer(pattern, text or "", re.M))
        raw = (hits[-1].group(1) if hits[-1].groups() else hits[-1].group(0)) if hits else None
    else:
        hits = _NUMBER.findall(text or "")
        raw = hits[-1] if hits else None
    try:
        value = float(raw) if raw is not None else None
    except ValueError:
        return None
    return value if value is not None and math.isfinite(value) else None


def verdict(best: float, value: float | None, direction: str, min_gain: float, net_lines: int) -> tuple[bool, str]:
    """Keep or revert one attempt. Equal-and-shorter is kept; a gain under min_gain that adds lines is not."""
    if value is None:
        return False, "no metric: the run failed, timed out or diverged"
    delta = (best - value) if direction == "min" else (value - best)
    if delta < 0:
        return False, f"worse: {value:g} vs best {best:g}"
    if delta == 0:
        return (True, f"equal metric, {-net_lines} fewer lines") if net_lines < 0 else (False, "no gain")
    gain = delta / abs(best) if best else math.inf
    if net_lines > 0 and gain < min_gain:
        return False, f"gain {gain:.2%} is under min_gain {min_gain:.2%} for {net_lines} added lines"
    return True, f"improved {best:g} -> {value:g} ({gain:.2%})"


def _git(cwd: Path | str, *args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout


def _reset(tree: Path) -> None:
    """Back to the last kept commit: only ever run in the loop's own worktree, never the caller's checkout."""
    _git(tree, "reset", "-q", "--hard", "HEAD")
    _git(tree, "clean", "-fdq")


def _inside(path: str, targets: list[str]) -> bool:
    return any(path == t or path.startswith(t + "/") for t in targets)


async def _measure(spec: Optimize, tree: Path, log: Path) -> tuple[float | None, float]:
    bash = find_bash()
    if not bash:
        raise RuntimeError("no working bash found to run the metric command")
    t0 = time.perf_counter()
    code, out, err = await run_hidden([bash, "-c", spec.metric], tree, timeout=2 * spec.budget_s)
    log.write_text(f"$ {spec.metric}\nexit {code}\n{out}\n{err}", encoding="utf-8")
    # A non-zero exit (a crash, or TIMEOUT_EXIT once killed at 2x budget) scores nothing, whatever it printed.
    return (parse_metric(out + "\n" + err, spec.pattern) if code == 0 else None), round(time.perf_counter() - t0, 1)


def _prompt(spec: Optimize, n: int, best: float, history: list[dict]) -> str:
    better = "lower" if spec.direction == "min" else "higher"
    recent = [f"#{h['n']} {'KEPT' if h['kept'] else 'reverted'} {h['value']} - {h['why']}: {h['summary'][:160]}" for h in history[-8:]]
    return "\n".join([
        spec.goal, "",
        f"This is attempt {n} of {spec.attempts} in a keep-or-revert loop. Edit ONLY: {', '.join(spec.targets)}.",
        f"When you stop, the loop runs `{spec.metric}` (budget {spec.budget_s}s, killed at {2 * spec.budget_s}s) and reads "
        f"one number; {better} is better. Best so far: {best:g}. An improvement is committed; anything else is reset.",
        "Make ONE focused change. Simpler is better: a deletion that holds the metric is kept, a tiny gain bought with "
        "hacky code is not. Do not run git; the loop owns commits. Reply with one line naming the change you made.",
        "", "Recent attempts (newest last):", *(recent or ["none yet"]),
    ])


async def ratchet(spec: Optimize, run_worker: Callable[[Task], Awaitable[Result]], root: Path | None = None) -> dict:
    """Run the loop to the end; returns the summary. `run_worker` runs one Task (the CLI passes a JobManager)."""
    spec.validated()
    repo = Path(_git(spec.repo, "rev-parse", "--show-toplevel").strip())
    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = (root or config.HOME / "optimize") / run_id
    tree, branch = run_dir / "tree", f"hswarm/optimize/{run_id}"
    (run_dir / "logs").mkdir(parents=True, exist_ok=True)
    _git(repo, "worktree", "add", "-q", "-b", branch, str(tree), "HEAD")  # from HEAD: uncommitted edits in repo are not included
    best, _ = await _measure(spec, tree, run_dir / "logs" / "baseline.log")
    _reset(tree)
    if best is None:
        raise RuntimeError(f"the baseline metric run gave no number; see {run_dir / 'logs' / 'baseline.log'}")
    baseline, history, spent = best, [], 0.0
    for n in range(1, spec.attempts + 1):
        if spec.budget_usd is not None and spent >= spec.budget_usd:
            break
        task = Task.from_dict({"prompt": _prompt(spec, n, best, history), "id": f"a{n}", "cwd": str(tree)},
                              {"tools": "edit", "max_turns": 40, "timeout_s": 900, **spec.worker}, n)
        res = await run_worker(task)
        spent += res.cost_usd or 0.0
        said = (res.answer or res.error or "").strip().splitlines()
        rec = {"n": n, "summary": said[0] if said else "", "worker": res.status,
               "cost_usd": res.cost_usd, "value": None, "kept": False, "commit": None}
        _git(tree, "add", "-A")
        files = [f for f in _git(tree, "diff", "--cached", "--name-only", "-z").split("\0") if f]
        stray = [f for f in files if not _inside(f, spec.targets)]
        if not files or stray:
            rec["why"] = f"touched paths outside the targets: {stray[:5]}" if stray else "no change"
        else:
            net = sum(int(a) - int(d) for a, d, *_ in (ln.split("\t") for ln in _git(tree, "diff", "--cached", "--numstat").splitlines()) if a.isdigit() and d.isdigit())
            rec["value"], rec["metric_s"] = await _measure(spec, tree, run_dir / "logs" / f"a{n}.log")
            rec["kept"], rec["why"] = verdict(best, rec["value"], spec.direction, spec.min_gain, net)
        if rec["kept"]:
            _git(tree, "commit", "-q", "-m", f"optimize #{n}: {rec['value']:g} ({rec['why']})\n\n{rec['summary']}")
            rec["commit"], best = _git(tree, "rev-parse", "--short", "HEAD").strip(), rec["value"]
        _reset(tree)  # a revert, or, after a keep, whatever the metric run itself wrote into tracked files
        history.append(rec)
        with (run_dir / "attempts.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"#{n} {'KEPT' if rec['kept'] else 'reverted'} {rec['value']} best={best:g} ${spent:.4f} - {rec['why']}", file=sys.stderr)
    return {"run": run_id, "branch": branch, "tree": str(tree), "baseline": baseline, "best": best, "direction": spec.direction,
            "attempts": len(history), "kept": sum(1 for h in history if h["kept"]), "cost_usd": round(spent, 6),
            "log": str(run_dir / "attempts.jsonl")}


async def _run(spec: Optimize) -> dict:
    from .jobs import JobManager

    m = JobManager()

    async def one(task: Task) -> Result:
        job = await m.run_batch([task], label=f"optimize-{task.id}")
        return job.results[task.id]

    try:
        return await ratchet(spec, one)
    finally:
        await m.aclose()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="hswarm optimize", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="the git repo; the loop works in a new worktree of its HEAD, on its own branch")
    ap.add_argument("--goal", required=True, help="what the worker is trying to improve, in plain words")
    ap.add_argument("--target", action="append", required=True, help="a path (relative to the repo root) the worker may edit; repeatable")
    ap.add_argument("--metric", required=True, help="bash command run at the worktree root; its last number (or --pattern) is the metric")
    ap.add_argument("--direction", choices=DIRECTIONS, default="min")
    ap.add_argument("--pattern", help="regex; group 1 of its last match is the metric")
    ap.add_argument("--budget-s", dest="budget_s", type=int, default=300, help="metric run budget; killed at 2x")
    ap.add_argument("--attempts", type=int, default=10)
    ap.add_argument("--min-gain", dest="min_gain", type=float, default=0.0, help="relative gain an attempt that adds lines must beat")
    ap.add_argument("--budget-usd", dest="budget_usd", type=float, help="stop once the workers have spent this much")
    ap.add_argument("--model", default=config.AUTO)
    ap.add_argument("--role")
    ap.add_argument("--max-cost-usd", dest="max_cost_usd", type=float, default=0.25, help="per attempt")
    a = ap.parse_args(argv)
    worker = {"model": a.model, "role": a.role, "max_cost_usd": a.max_cost_usd}
    spec = Optimize(a.repo, a.goal, a.target, a.metric, a.direction, a.budget_s, a.attempts, a.pattern, a.min_gain, a.budget_usd,
                    {k: v for k, v in worker.items() if v is not None})
    print(json.dumps(asyncio.run(_run(spec)), indent=1))
    return 0
