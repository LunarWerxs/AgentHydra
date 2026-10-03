"""Frontier loop: re-probe, fan the frontier out to workers, repeat until the probe reports nothing left.

WHY: a long many-step job (a port, a migration, a fleet-wide fix) needs a machine-readable "where are we"
and a log that outlives the session driving it. The caller supplies a PROBE, a shell command run in `cwd`
that prints JSON:

    {"frontier": null | "<stage>" | {"stage": "<stage>", "mode"?: "fix"|"port", "failures"?: [...], "detail"?: ...},
     "perStage": {"<stage>": <anything: counts, pass/fail, "missing">, ...}}

`frontier` is the EARLIEST failing stage; null means done. Each round the loop runs the probe, picks FIX or
PORT for the frontier (the probe's own `mode` wins; otherwise PORT when perStage marks the stage missing /
unported / not started, FIX for anything else), sends one worker per listed failure (at most max_workers, or
one for the whole stage when none are listed), waits, and probes again. The probe is the verification: a
round that leaves the frontier and its failures exactly as they were counts as no progress, and
`stall_rounds` of those in a row stop the loop instead of paying for the same guess again.

Every step goes to a markdown log (Status at the top, rewritten; Log below, append-only). Starting a loop on
an existing log keeps its Log lines, so a loop cut off mid-run resumes from the probe with its history intact.
The orchestrator never reads source here: it reads the probe and the log. Pattern adapted from React's
compiler-orchestrator skill (MIT); no code copied.

CLI: `hswarm loop --probe "<cmd>" --cwd <dir> [--log PATH] [--max-rounds N] ...`; MCP: hswarm_loop.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config
from .procgate import CREATE_NO_WINDOW
from .spec import Task

PORT_MARKS = {"missing", "unported", "not_ported", "not started", "not_started", "todo", "unimplemented"}

FIX_PROMPT = """You are one worker in a frontier loop. The probe command `{probe}` (run in {cwd}) reports stage `{stage}` as the EARLIEST failing stage.
Mode FIX: the stage exists but fails. Fix this failure at its root cause, not its symptom:
{failure}

Probe detail for the stage: {detail}
Per-stage status: {per_stage}

Change only what the fix needs. Do not weaken, skip or delete a check to make it pass. Reply with what you changed (file:line) and why,
or one line starting with FAILED: and the reason."""

PORT_PROMPT = """You are one worker in a frontier loop. The probe command `{probe}` (run in {cwd}) reports stage `{stage}` as the EARLIEST stage not yet done.
Mode PORT: the stage is missing or not yet ported. Implement it, following how the stages before it are written:
{failure}

Probe detail for the stage: {detail}
Per-stage status: {per_stage}

Write it in the idiom of the surrounding code. Reply with what you added (file:line), or one line starting with FAILED: and the reason."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _short(v: Any, n: int = 600) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, sort_keys=True, default=str)
    return s if len(s) <= n else s[:n] + f"... [{len(s) - n} more chars]"


def parse_probe(stdout: str) -> dict:
    """The probe's JSON: the whole stdout, or else its last line that parses as an object (a probe may log first)."""
    text = (stdout or "").strip()
    candidates = [text] + [ln.strip() for ln in reversed(text.splitlines()) if ln.strip().startswith("{")]
    for c in candidates:
        try:
            out = json.loads(c)
        except ValueError:
            continue
        if isinstance(out, dict) and "frontier" in out:
            return out
    raise ValueError("probe printed no JSON object with a 'frontier' key")


def frontier_of(probe: dict) -> dict | None:
    """Normalise the frontier to {stage, mode, failures, detail}; None when the probe says nothing is left."""
    f = probe.get("frontier")
    if f is None or f == "" or f is False:
        return None
    if not isinstance(f, dict):
        f = {"stage": str(f)}
    stage = str(f.get("stage") or f.get("name") or "?")
    mode = str(f.get("mode") or "").lower()
    if mode not in ("fix", "port"):
        per = (probe.get("perStage") or {}).get(stage)
        mark = per.get("status") if isinstance(per, dict) else per
        ported = per.get("ported") if isinstance(per, dict) else None
        mode = "port" if ported is False or (isinstance(mark, str) and mark.strip().lower() in PORT_MARKS) else "fix"
    failures = f.get("failures") or []
    if not isinstance(failures, list):
        failures = [failures]
    return {"stage": stage, "mode": mode, "failures": failures, "detail": f.get("detail")}


def run_probe(cmd: str, cwd: str, timeout_s: float) -> dict:
    """Run the probe once. Its exit code is ignored on purpose: a harness reporting failures usually exits non-zero."""
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout_s,
                           creationflags=CREATE_NO_WINDOW)  # the shared server has no console: a child without this opens a window
    except subprocess.TimeoutExpired:
        raise ValueError(f"probe timed out after {timeout_s:.0f}s") from None
    try:
        return parse_probe(p.stdout)
    except ValueError as e:
        raise ValueError(f"{e} (exit {p.returncode}; stderr: {_short((p.stderr or '').strip(), 300)})") from None


def _fill(template: str, values: dict) -> str:
    # Plain replacement, not str.format: a caller's template may carry JSON braces of its own.
    for k, v in values.items():
        template = template.replace("{" + k + "}", v)
    return template


@dataclass
class FrontierLoop:
    probe: str
    cwd: str
    log_path: Path
    id: str = ""
    task_defaults: dict = field(default_factory=dict)
    fix_prompt: str = FIX_PROMPT
    port_prompt: str = PORT_PROMPT
    max_rounds: int = 5
    max_workers: int = 4
    stall_rounds: int = 2
    budget_usd: float | None = None
    probe_timeout_s: float = 600.0
    concurrency: int | None = None
    state: str = "running"
    reason: str = ""
    round: int = 0
    frontier: dict | None = None
    per_stage: Any = None
    cost_usd: float = 0.0
    jobs: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    started: str = field(default_factory=_now)

    def __post_init__(self) -> None:
        self.id = self.id or "loop-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        if not Path(self.cwd).is_absolute() or not Path(self.cwd).is_dir():
            raise ValueError(f"cwd must be an absolute directory (the probe runs there): {self.cwd!r}")
        self.log_path = Path(self.log_path)
        self.max_rounds, self.max_workers, self.stall_rounds = max(1, int(self.max_rounds)), max(1, int(self.max_workers)), max(1, int(self.stall_rounds))
        self.log = self._previous_log()

    def _previous_log(self) -> list[str]:
        """A resumed loop keeps the Log lines of the one that wrote this file before it."""
        try:
            text = self.log_path.read_text(encoding="utf-8")
        except OSError:
            return []
        _, _, tail = text.partition("\n## Log\n")
        return [ln for ln in tail.splitlines() if ln.startswith("- ")]

    def status(self) -> dict:
        return {"loop_id": self.id, "state": self.state, "reason": self.reason, "round": self.round, "max_rounds": self.max_rounds,
                "frontier": self.frontier, "perStage": self.per_stage, "cost_usd": round(self.cost_usd, 6), "jobs": self.jobs,
                "log": str(self.log_path), "started": self.started, "last": self.log[-3:]}

    def _note(self, line: str) -> None:
        self.log.append(f"- {_now()} {' '.join(line.split())}")  # one line per step, so a resumed loop reads every one back
        self._write()

    def _write(self) -> None:
        f = self.frontier
        status = [
            f"# hswarm frontier loop {self.id}", "", "## Status", "",
            f"- state: {self.state}" + (f" ({self.reason})" if self.reason else ""),
            f"- round: {self.round} of {self.max_rounds}",
            f"- frontier: {f['stage'] + ' [' + f['mode'].upper() + ', ' + str(len(f['failures'])) + ' failure(s)]' if f else 'none'}",
            f"- perStage: `{_short(self.per_stage, 1500)}`",
            f"- probe: `{self.probe}` in {self.cwd}",
            f"- cost: ${self.cost_usd:.4f}" + (f" of ${self.budget_usd:.4f}" if self.budget_usd is not None else ""),
            f"- jobs: {', '.join(self.jobs) or '-'}", "", "## Log", "",
        ]
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log_path.write_text("\n".join(status + self.log) + "\n", encoding="utf-8")

    def _stop(self, state: str, reason: str) -> None:
        self.state, self.reason = state, reason
        self._note(f"STOP {state}: {reason}")

    def _tasks(self, f: dict) -> list[Task]:
        template = self.port_prompt if f["mode"] == "port" else self.fix_prompt
        items = f["failures"][: self.max_workers] or [f"(the probe lists no single failures: make stage {f['stage']} pass as a whole)"]
        base = {"probe": self.probe, "cwd": self.cwd, "stage": f["stage"], "mode": f["mode"].upper(),
                "detail": _short(f["detail"]) if f["detail"] is not None else "-", "per_stage": _short(self.per_stage, 2000)}
        return [Task.from_dict({**self.task_defaults, "id": f"r{self.round}-{i + 1}", "cwd": self.cwd,
                                "prompt": _fill(template, base | {"failure": _short(item, 4000)})}, {}, i) for i, item in enumerate(items)]

    async def run(self, manager) -> dict:
        """Probe, dispatch, repeat. Returns the final status; every step is already in the log when it returns."""
        previous, unchanged = None, 0
        self._note(f"START probe `{self.probe}` max_rounds={self.max_rounds} max_workers={self.max_workers}")
        try:
            while True:
                try:
                    probe = await asyncio.to_thread(run_probe, self.probe, self.cwd, self.probe_timeout_s)
                except ValueError as e:
                    self._stop("probe_failed", str(e))
                    break
                self.frontier, self.per_stage = frontier_of(probe), probe.get("perStage")
                f = self.frontier
                self._note(f"probe (after round {self.round}): frontier {f['stage'] + ' ' + f['mode'].upper() + ' x' + str(len(f['failures'])) if f else 'none'}")
                if f is None:
                    self._stop("done", "the probe reports no frontier")
                    break
                key = json.dumps([f["stage"], f["mode"], f["failures"]], sort_keys=True, default=str)
                unchanged = unchanged + 1 if key == previous else 0
                previous = key
                if unchanged >= self.stall_rounds:
                    self._stop("stalled", f"frontier {f['stage']} unchanged after {unchanged} round(s) of workers")
                    break
                if self.round >= self.max_rounds:
                    self._stop("max_rounds", f"{self.max_rounds} round(s) dispatched, frontier still {f['stage']}")
                    break
                if self.budget_usd is not None and self.cost_usd >= self.budget_usd:
                    self._stop("budget", f"${self.cost_usd:.4f} spent of ${self.budget_usd:.4f}")
                    break
                self.round += 1
                tasks = self._tasks(f)
                remaining = None if self.budget_usd is None else max(self.budget_usd - self.cost_usd, 0.0)
                job = manager.submit(tasks, concurrency=self.concurrency, label=f"{self.id}:r{self.round}:{f['mode']}:{f['stage']}"[:120], budget_usd=remaining)
                self.jobs.append(job.id)
                try:
                    job = await manager.wait(job.id, None)
                except asyncio.CancelledError:
                    manager.cancel(job.id, reason=f"frontier loop {self.id} cancelled")  # a cancelled loop leaves no workers spending
                    raise
                self.cost_usd += job.cost()
                counts: dict[str, int] = {}
                for r in job.results.values():
                    counts[r.status] = counts.get(r.status, 0) + 1
                self._note(f"round {self.round}: {f['mode'].upper()} {f['stage']}, {len(tasks)} worker(s), job {job.id}: "
                           + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) + f", ${job.cost():.4f}")
        except asyncio.CancelledError:
            self._stop("cancelled", "cancelled by the caller")
            raise
        except Exception as e:  # noqa: BLE001 - a crashed loop must say so in its own log, not just vanish
            self._stop("error", f"{type(e).__name__}: {e}"[:400])
        return self.status()


def default_log(loop_id: str) -> Path:
    return config.HOME / "loops" / f"{loop_id}.md"


def build(probe: str, cwd: str, log: str | None = None, **kw) -> FrontierLoop:
    """A loop with its log path settled: the caller's file (resumed when it exists) or ~/.hswarm/loops/<id>.md."""
    loop_id = kw.pop("id", "") or "loop-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    return FrontierLoop(probe=probe, cwd=cwd, log_path=Path(log) if log else default_log(loop_id), id=loop_id, **kw)


def main(argv: list[str]) -> int:
    from .jobs import JobManager

    ap = argparse.ArgumentParser(prog="hswarm loop", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--probe", required=True, help="shell command run in --cwd that prints {frontier, perStage} as JSON")
    ap.add_argument("--cwd", required=True, help="absolute folder: where the probe and every worker run")
    ap.add_argument("--log", help="the Status+Log markdown file (default ~/.hswarm/loops/<id>.md); an existing one is resumed")
    ap.add_argument("--max-rounds", dest="max_rounds", type=int, default=5)
    ap.add_argument("--max-workers", dest="max_workers", type=int, default=4, help="workers per round (one per listed failure)")
    ap.add_argument("--stall-rounds", dest="stall_rounds", type=int, default=2, help="stop after this many rounds that leave the frontier unchanged")
    ap.add_argument("--budget", type=float, help="USD ceiling for the whole loop")
    ap.add_argument("--probe-timeout-s", dest="probe_timeout_s", type=float, default=600.0)
    ap.add_argument("--tools", default="edit", help="worker tool preset (read | edit | all) or comma list")
    ap.add_argument("--model", default=config.AUTO)
    ap.add_argument("--backend", default="api", choices=["api", "cc"])
    ap.add_argument("--max-turns", dest="max_turns", type=int, default=24)
    ap.add_argument("--fix-prompt", dest="fix_prompt", help="file holding the FIX template ({stage} {failure} {detail} {per_stage} {probe} {cwd})")
    ap.add_argument("--port-prompt", dest="port_prompt", help="file holding the PORT template (same placeholders)")
    a = ap.parse_args(argv)
    lp = build(a.probe, a.cwd, a.log, max_rounds=a.max_rounds, max_workers=a.max_workers, stall_rounds=a.stall_rounds, budget_usd=a.budget,
               probe_timeout_s=a.probe_timeout_s, task_defaults={"tools": a.tools, "model": a.model, "backend": a.backend, "max_turns": a.max_turns},
               fix_prompt=Path(a.fix_prompt).read_text(encoding="utf-8") if a.fix_prompt else FIX_PROMPT,
               port_prompt=Path(a.port_prompt).read_text(encoding="utf-8") if a.port_prompt else PORT_PROMPT)

    async def go() -> dict:
        m = JobManager()
        try:
            return await lp.run(m)
        finally:
            await m.aclose()

    out = asyncio.run(go())
    print(json.dumps(out, indent=1, default=str))
    return 0 if out["state"] == "done" else 1
