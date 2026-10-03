"""The bench results database: every A/B and benchmark row ever measured, shared by every machine.

Why it exists (owner, Michael, 2026-09-21): "we should probably be maintaining a database of previous
swarm A/B testing and benchmarking ... so we don't end up having to do this over and over and over again,
and waste usage to test." Before it, results lived in two places nobody could query: `bench/out/`
(gitignored, so only the machine that ran a bench could read it) and the prose tables of
`docs/BENCH-*.md` (aggregates only; `hard_reasoning.py` printed to stdout and kept nothing).

Storage is append-only JSONL under `bench/results/`, COMMITTED, with `merge=union` in `.gitattributes` so
two machines appending never conflict:

    runs.jsonl     one line per run: suite, suite version, arms, machine, git sha, argv
    results.jsonl  one line per (item, repeat, arm) attempt: pass, status, answer, gold, cost, seconds
    legacy.jsonl   aggregate-only results transcribed from docs/BENCH-*.md, where no per-item rows exist

Reuse: a harness calls `cached(suite, version, arm)` before it spends a call and skips every (item, rep)
that already has a GRADED row younger than `max_age_days`. A row that errored or hit a limit is never
reused - it measured the provider's bad minute, not the model. `--fresh` re-measures. The suite version is
a hash of the items (or of the suite's source files), so editing a suite never reuses stale rows.

    hswarm benchdb board                      # leaderboard, every suite (also the hswarm_bench MCP tool)
    hswarm benchdb board --suite decisions.triage --json
    hswarm benchdb has --suite hard_reasoning --arm groq-gpt-oss-120b@low
    hswarm benchdb import-out                 # backfill bench/out/*.json (idempotent)

It lives in the package, not in bench/, because the MCP server and the CLI must read it from any clone;
the harnesses in bench/ import it from here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

from . import config

ROOT = config.HOME / "bench"  # state lives under HSWARM_HOME, never in the clone
DB = ROOT / "results"
RUNS, RESULTS, LEGACY = DB / "runs.jsonl", DB / "results.jsonl", DB / "legacy.jsonl"
# A status that says the ARM could not answer (limit, key, network), so the row is not a measurement of
# the model and must never be reused or counted as a wrong answer.
UNGRADED = {"blocked", "error"}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def machine() -> str:
    return socket.gethostname()


def git_sha() -> str:
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10,
                              creationflags=0x08000000 if sys.platform == "win32" else 0).stdout.strip()  # CREATE_NO_WINDOW
    except (OSError, subprocess.SubprocessError):
        return ""


def version_of(obj) -> str:
    """Stable 12-hex hash of anything JSON-serialisable (the item list of a suite)."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:12]


def version_of_files(*paths: Path) -> str:
    """Suite version for fixture-based suites: the suite is its source, so hash the source."""
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(p.name.encode())
        h.update(p.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()[:12]


def _append(path: Path, rows: list[dict]) -> None:
    """One os.write per batch on an O_APPEND handle, so two processes appending interleave whole lines."""
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    data = "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in rows).encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0))
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # a half-written line from a killed run; the rest of the file is still good
    return out


def new_run_id(suite: str) -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + machine().lower()[:12] + "-" + suite.replace(".", "_")[:24]


def record_run(run: str, suite: str, version: str, arms: list[str], argv: list[str] | None = None, started: str | None = None, items: int | None = None, note: str = "") -> None:
    _append(RUNS, [{"run": run, "suite": suite, "v": version, "arms": arms, "machine": machine(), "git": git_sha(),
                    "started": started or now_iso(), "finished": now_iso(), "argv": argv if argv is not None else sys.argv[1:], "items": items, "note": note}])


def record_rows(rows: list[dict]) -> None:
    """Each row needs at least run, suite, v, arm, item, rep, pass, status. ts and machine are stamped here."""
    ts, host = now_iso(), machine()
    _append(RESULTS, [{"ts": ts, "machine": host, **r} for r in rows])


def rows(suite: str | None = None, arm: str | None = None, version: str | None = None) -> list[dict]:
    out = []
    for r in _read(RESULTS):
        if suite and r.get("suite") != suite:
            continue
        if arm and r.get("arm") != arm:
            continue
        if version and r.get("v") != version:
            continue
        out.append(r)
    return out


def _cutoff(max_age_days: float) -> dt.datetime:
    """now - max_age_days; a huge value ("reuse anything, ever") clamps to the start of time instead of overflowing."""
    try:
        return dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max_age_days)
    except OverflowError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def cached(suite: str, version: str, arm: str, max_age_days: float = 30.0) -> dict[tuple[str, int], dict]:
    """(item, rep) -> the newest GRADED row for this arm on this exact suite version, if young enough."""
    cutoff = _cutoff(max_age_days)
    best: dict[tuple[str, int], dict] = {}
    for r in rows(suite, arm, version):
        if r.get("status") in UNGRADED or r.get("pass") is None:
            continue
        try:
            if dt.datetime.fromisoformat(r["ts"]) < cutoff:
                continue
        except (KeyError, ValueError):
            continue
        k = (str(r["item"]), int(r.get("rep", 0)))
        if k not in best or r["ts"] > best[k]["ts"]:
            best[k] = r
    return best


def _pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


def board(suite: str | None = None, include_legacy: bool = True, all_versions: bool = False) -> list[dict]:
    """One line per (suite, version, arm): graded n, passes, rate, cost, latency, when, where.

    By default only the NEWEST version of each suite is shown (an old version measured a different test);
    `all_versions` shows every one. Ungraded rows are counted separately as `ungraded`, never as fails."""
    groups: dict[tuple, dict] = {}
    newest_v: dict[str, str] = {}
    for r in rows(suite):
        s, v = r.get("suite"), r.get("v")
        if s not in newest_v or r["ts"] > newest_v[s][1]:
            newest_v[s] = (v, r["ts"])
        _add_to_group(groups.setdefault((s, v, r.get("arm")), _new_group(s, v, r)), r)
    out = [_group_line(s, v, g) for (s, v, _a), g in groups.items() if all_versions or newest_v.get(s, (None,))[0] == v]
    if include_legacy:
        out += _legacy_lines(suite)
    out.sort(key=lambda x: (x["suite"] or "", x["source"] != "rows", -(x["rate"] or 0), x["arm"] or ""))
    return out


def _new_group(s: str | None, v: str | None, r: dict) -> dict:
    return {"suite": s, "v": v, "arm": r.get("arm"), "graded": 0, "passed": 0, "ungraded": 0,
            "cost_usd": 0.0, "secs": [], "tools": [], "skipped": 0, "first": r["ts"], "last": r["ts"], "machines": set(), "runs": set(), "model": r.get("resolved") or r.get("model")}


def _add_to_group(g: dict, r: dict) -> None:
    """Fold one result row into its (suite, version, arm) group."""
    if r.get("status") in UNGRADED or r.get("pass") is None:
        g["ungraded"] += 1
    else:
        g["graded"] += 1
        g["passed"] += bool(r["pass"])
        if r.get("s") is not None:
            g["secs"].append(float(r["s"]))
    if r.get("tools_ok") is not None:  # the trace score (hswarm/trace.py): did the arm reach its answer the right way
        g["tools"].append(bool(r["tools_ok"]))
    # Known-gap tasks the arm was not run on (bench/tasks.py KnownGap): its rate covers fewer items than its peers'.
    g["skipped"] = max(g["skipped"], int(r.get("skipped") or 0))
    g["cost_usd"] += float(r.get("cost") or 0)
    g["first"], g["last"] = min(g["first"], r["ts"]), max(g["last"], r["ts"])
    g["machines"].add(r.get("machine"))
    g["runs"].add(r.get("run"))


def _group_line(s: str | None, v: str | None, g: dict) -> dict:
    n = g["graded"]
    return {"suite": s, "v": v, "arm": g["arm"], "model": g["model"], "graded": n, "passed": g["passed"], "rate": round(g["passed"] / n, 4) if n else None,
            "ungraded": g["ungraded"], "tools_rate": round(sum(g["tools"]) / len(g["tools"]), 4) if g["tools"] else None,
            "skipped": g["skipped"],
            "cost_usd": round(g["cost_usd"], 6), "cost_per_item": round(g["cost_usd"] / max(1, n + g["ungraded"]), 7),
            "p50_s": _pct(g["secs"], 0.5), "p95_s": _pct(g["secs"], 0.95), "first": g["first"][:10], "last": g["last"][:10],
            "machines": sorted(m for m in g["machines"] if m), "runs": len(g["runs"]), "source": "rows"}


def _legacy_lines(suite: str | None) -> list[dict]:
    out = []
    for r in _read(LEGACY):
        if suite and r.get("suite") != suite:
            continue
        out.append({"suite": r["suite"], "v": r.get("v", "doc"), "arm": r["arm"], "model": r.get("model"), "graded": r["total"], "passed": r["pass"],
                    "rate": round(r["pass"] / r["total"], 4) if r.get("total") else None, "ungraded": r.get("ungraded", 0), "cost_usd": r.get("cost_usd"),
                    "cost_per_item": None, "p50_s": r.get("p50_s"), "p95_s": None, "first": r["date"], "last": r["date"], "machines": [r.get("machine") or "?"],
                    "runs": 1, "source": r.get("source", "doc"), "note": r.get("note", "")})
    return out


def print_board(lines: list[dict]) -> None:
    suite = None
    for x in lines:
        if x["suite"] != suite:
            suite = x["suite"]
            print(f"\n== {suite}")
            print(f"  {'arm':34s} {'pass':>9s} {'rate':>6s} {'tools':>6s} {'skip':>4s} {'ungr':>5s} {'$/item':>10s} {'p50 s':>7s} {'last':>10s}  src")
        rate = f"{100 * x['rate']:.0f}%" if x["rate"] is not None else "-"
        tools = f"{100 * x['tools_rate']:.0f}%" if x.get("tools_rate") is not None else "-"
        skip = str(x["skipped"]) if x.get("skipped") else "-"
        cpi = f"{x['cost_per_item']:.6f}" if x.get("cost_per_item") is not None else "-"
        p50 = f"{x['p50_s']:.2f}" if x.get("p50_s") is not None else "-"
        src = "rows" if x["source"] == "rows" else "doc"
        print(f"  {str(x['arm'])[:34]:34s} {x['passed']:>4}/{x['graded']:<4} {rate:>6s} {tools:>6s} {skip:>4s} {x['ungraded']:>5} {cpi:>10s} {p50:>7s} {x['last']:>10s}  {src}")


# ---------------------------------------------------------------- backfill of the machine-local reports

def _suite_of(report: dict) -> str:
    s = report.get("suite") or "mechanical"
    return "bench.judgment" if s == "judgment" else "bench.mechanical" if s == "mechanical" else f"bench.{s}"


def import_out(out_dir: Path | None = None) -> int:
    """Backfill every bench/out/*.json report into results.jsonl. Idempotent: a run already imported is skipped.

    Those runs predate suite versioning, so their version is `pre-db` and they never satisfy `cached()` for a
    current suite; they are there to be READ (the leaderboard, the history), not to skip new work."""
    out_dir = out_dir or (ROOT / "out")
    have = {r.get("run") for r in _read(RUNS)}
    host = machine()  # bench/out is gitignored, so a report there was written on this machine
    n_rows = 0
    for p in sorted(out_dir.glob("*.json")):
        try:
            rep = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        run = rep.get("run") or p.stem
        if run in have or not isinstance(rep.get("arms"), dict) or not rep["arms"]:
            continue
        suite = _suite_of(rep)
        stamp = dt.datetime.strptime(run[:15], "%Y%m%d-%H%M%S").astimezone(dt.timezone.utc).isoformat(timespec="seconds") if run[:15].replace("-", "").isdigit() else now_iso()
        out_rows = []
        for arm, rec in rep["arms"].items():
            runs = rec.get("runs") or [rec]
            for k, one in enumerate(runs):
                for r in one.get("rows") or []:
                    # The bench graded a non-blocked error (cost cap, turn cap, timeout) as a FAIL, so it is a graded row here too;
                    # only a limit/login failure (`blocked`) is not a measurement of the model.
                    status = "blocked" if r.get("blocked") else "ok"
                    out_rows.append({"ts": stamp, "machine": host, "run": run, "suite": suite, "v": "pre-db", "arm": arm, "model": arm.split(":", 1)[-1],
                                     "item": r.get("task"), "rep": k, "pass": bool(r.get("pass")) if status not in UNGRADED else None, "status": status, "worker_status": r.get("status"),
                                     "answer": (r.get("answer") or "")[:200], "cost": r.get("cost_usd"), "s": r.get("seconds"), "api_s": r.get("api_seconds"),
                                     "turns": r.get("turns"), "tools": r.get("tool_calls"), "upstream": r.get("upstream"), "detail": (r.get("detail") or "")[:160]})
        if not out_rows:
            continue
        _append(RESULTS, out_rows)
        _append(RUNS, [{"run": run, "suite": suite, "v": "pre-db", "arms": list(rep["arms"]), "machine": host, "git": "", "started": stamp, "finished": stamp,
                        "argv": [], "items": None, "note": f"backfilled from bench/out/{p.name}"}])
        n_rows += len(out_rows)
        have.add(run)
    return n_rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="hswarm benchdb", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("board", help="leaderboard: pass rate, cost, latency per (suite, arm)")
    b.add_argument("--suite")
    b.add_argument("--all-versions", action="store_true")
    b.add_argument("--no-legacy", action="store_true")
    b.add_argument("--json", action="store_true")
    h = sub.add_parser("has", help="does the DB already hold graded rows for this suite and arm? (exit 0 yes, 1 no)")
    h.add_argument("--suite", required=True)
    h.add_argument("--arm", required=True)
    h.add_argument("--max-age-days", type=float, default=30.0)
    sub.add_parser("import-out", help="backfill bench/out/*.json (idempotent)")
    a = ap.parse_args(argv)
    if a.cmd == "board":
        lines = board(a.suite, include_legacy=not a.no_legacy, all_versions=a.all_versions)
        print(json.dumps(lines, indent=1)) if a.json else print_board(lines)
        return 0
    if a.cmd == "has":
        rs = [r for r in rows(a.suite, a.arm) if r.get("status") not in UNGRADED]
        cutoff = _cutoff(a.max_age_days).isoformat()
        fresh = [r for r in rs if r["ts"] >= cutoff]
        vs = sorted({r.get("v") for r in fresh})
        print(f"{len(fresh)} graded rows younger than {a.max_age_days:g} days, suite versions {vs}" if fresh else "none")
        return 0 if fresh else 1
    if a.cmd == "import-out":
        print(f"imported {import_out()} rows")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
