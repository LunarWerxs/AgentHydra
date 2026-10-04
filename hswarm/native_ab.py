"""A/B: the transcript scan in Python vs Rust vs Go, on this machine's real Claude Code transcripts.

Each arm scans the same window of ~/.claude/projects; every run is a separate process whose wall time,
CPU time (user + kernel) and peak working set are read from the OS when it exits. Arms run interleaved
(python, rust, go, python, rust, go, ...) after one discarded warm-up, so the page cache favours nobody.
Before any speed is compared the outputs are checked against the Python reference: same days, same
request counts, same dollars, same sub-agent lists. An arm that disagrees is reported and never chosen.
The winner (language, threads) lands in ~/.hswarm/native/winner.json and claude_usage.collect() uses it from then on.

    hswarm native bench --days 14 --repeats 3 --threads 8
"""
from __future__ import annotations

import datetime as dt
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import claude_usage, native

# The folder holding the hswarm package: the Python arm's child imports the same hswarm from it.
REPO = Path(__file__).resolve().parent.parent

PY_SNIPPET = (
    "import datetime as dt, json, sys; sys.path.insert(0, sys.argv[4]); from hswarm import claude_usage as c; "
    "print(json.dumps({'days': c.collect_python(dt.date.fromisoformat(sys.argv[1]), dt.date.fromisoformat(sys.argv[2]), root=sys.argv[3])}))"
)


# ---- measuring a child process ---------------------------------------------------------------------

def _run_measured(cmd: list[str], stdin_text: str | None) -> dict:
    """Run cmd to completion; return wall/user/sys seconds, peak RSS bytes, exit code and stdout."""
    t0 = time.perf_counter()
    if os.name == "nt":
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        out, err = p.communicate(stdin_text.encode("utf-8") if stdin_text is not None else None)
        wall = time.perf_counter() - t0
        user, kernel, peak = _win_times(p._handle)  # the handle stays valid after exit, so the counters are final
        return {"wall": wall, "user": user, "sys": kernel, "peak_rss": peak, "code": p.returncode, "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace")[-400:]}
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # The pipes drain on threads and wait4 reaps the child itself, returning that child's own rusage: communicate()
    # would reap it first and leave wait4 no child to wait for (ChildProcessError on every Linux and macOS run).
    got: dict[str, bytes] = {}
    readers = [threading.Thread(target=lambda n=n, f=f: got.__setitem__(n, f.read())) for n, f in (("out", p.stdout), ("err", p.stderr))]
    for t in readers:
        t.start()
    if stdin_text is not None:
        try:
            p.stdin.write(stdin_text.encode("utf-8"))
        except BrokenPipeError:  # a child that exits without reading its input
            pass
        p.stdin.close()
    _, status, ru = os.wait4(p.pid, 0)
    p.returncode = os.waitstatus_to_exitcode(status)
    for t in readers:
        t.join()
    out, err = got.get("out", b""), got.get("err", b"")
    wall = time.perf_counter() - t0
    return {"wall": wall, "user": ru.ru_utime if ru else 0.0, "sys": ru.ru_stime if ru else 0.0, "peak_rss": (ru.ru_maxrss * (1 if sys.platform == "darwin" else 1024)) if ru else 0,
            "code": p.returncode, "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace")[-400:]}


def _win_times(handle: int) -> tuple[float, float, int]:
    import ctypes
    from ctypes import wintypes as w

    class FILETIME(ctypes.Structure):
        _fields_ = [("lo", w.DWORD), ("hi", w.DWORD)]

    class PMC(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    c, e, k, u = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    ctypes.windll.kernel32.GetProcessTimes(w.HANDLE(handle), ctypes.byref(c), ctypes.byref(e), ctypes.byref(k), ctypes.byref(u))
    pmc = PMC()
    pmc.cb = ctypes.sizeof(pmc)
    ctypes.windll.psapi.GetProcessMemoryInfo(w.HANDLE(handle), ctypes.byref(pmc), pmc.cb)
    ft = lambda f: ((f.hi << 32) | f.lo) / 1e7  # noqa: E731 - 100ns units
    return ft(u), ft(k), int(pmc.PeakWorkingSetSize)


# ---- arms ----------------------------------------------------------------------------------------

def arm_command(arm: str, root: Path, since: dt.date, until: dt.date, threads: int) -> tuple[list[str], str | None]:
    lang = arm.split("@")[0]
    n = int(arm.split("@")[1]) if "@" in arm else 1
    if lang == "python":
        return [sys.executable, "-c", PY_SNIPPET, since.isoformat(), until.isoformat(), str(root), str(REPO)], None
    return native.command(lang, root, since, until, n if n > 1 else 1), native.prices_json()


def normalise(days: dict) -> dict:
    """Order-free view of a collect() result: sorted per-family lists, rounded dollars."""
    out = {}
    for day, d in days.items():
        out[day] = {
            "requests": d["requests"], "unpriced_requests": d["unpriced_requests"],
            "claude_usd": round(d["claude_usd"], 4), "main_usd": round(d["main_usd"], 4), "sub_usd": round(d["sub_usd"], 4),
            "agents": {f: sorted(round(u, 4) for u in v) for f, v in d["agents"].items()},
            "agent_tokens": {f: sorted((json.dumps(t, sort_keys=True) for t in v)) for f, v in d.get("agent_tokens", {}).items()},
            "by_model": {m: {k: (round(x, 4) if isinstance(x, float) else x) for k, x in v.items()} for m, v in d.get("by_model", {}).items()},
        }
    return out


def diff(ref: dict, other: dict) -> list[str]:
    """Human-readable differences between two normalised results; empty means identical."""
    out = []
    for day in sorted(set(ref) | set(other)):
        a, b = ref.get(day), other.get(day)
        if a is None or b is None:
            out.append(f"{day}: present in {'reference' if b is None else 'candidate'} only")
            continue
        for k in ("requests", "unpriced_requests"):
            if a[k] != b[k]:
                out.append(f"{day}: {k} {a[k]} vs {b[k]}")
        for k in ("claude_usd", "main_usd", "sub_usd"):
            if abs(a[k] - b[k]) > 2e-4:
                out.append(f"{day}: {k} {a[k]} vs {b[k]}")
        for fam in sorted(set(a["agents"]) | set(b["agents"])):
            x, y = a["agents"].get(fam, []), b["agents"].get(fam, [])
            if len(x) != len(y) or any(abs(p - q) > 1e-4 for p, q in zip(x, y)):
                out.append(f"{day}: {fam} sub-agents {len(x)} vs {len(y)}" + ("" if len(x) != len(y) else " (values differ)"))
        for fam in sorted(set(a["agent_tokens"]) | set(b["agent_tokens"])):
            if a["agent_tokens"].get(fam, []) != b["agent_tokens"].get(fam, []):
                out.append(f"{day}: {fam} sub-agent token buckets differ")
        for model in sorted(set(a["by_model"]) | set(b["by_model"])):
            x, y = a["by_model"].get(model), b["by_model"].get(model)
            if x is None or y is None or x["requests"] != y["requests"] or x["agents"] != y["agents"] or any(abs(x[k] - y[k]) > 2e-4 for k in ("usd", "main_usd", "sub_usd")):
                out.append(f"{day}: by_model {model or '(unknown)'} {x} vs {y}")
    return out


def corpus_size(root: Path, since: dt.date) -> tuple[int, int]:
    start_ts = dt.datetime.combine(since, dt.time.min).astimezone().timestamp()
    files = claude_usage.transcripts(root, start_ts)
    total = 0
    for p in files:
        try:
            total += os.stat(p).st_size
        except OSError:
            continue
    return len(files), total


# ---- the run ---------------------------------------------------------------------------------------

def arm_list(threads: int, arms: list[str] | None) -> list[str]:
    """The explicit arms, else python plus every built language, single-threaded and (past one thread) threaded."""
    if arms:
        return arms
    built = [lang for lang in native.LANGS if native.binary(lang)]
    return ["python"] + [a for lang in built for a in ([lang] + ([f"{lang}@{threads}"] if threads > 1 else []))]


def warm_up(arms: list[str], root: Path, since: dt.date, until: dt.date, threads: int) -> dict:
    """One discarded run of a native arm (or python when none is built), so the page cache favours nobody."""
    warm = next((a for a in arms if not a.startswith("python")), arms[0])
    cmd, stdin = arm_command(warm, root, since, until, threads)
    print(f"warm-up ({warm}) ...", file=sys.stderr, end=" ", flush=True)
    w = _run_measured(cmd, stdin)
    print(f"{w['wall']:.1f}s (discarded)", file=sys.stderr)
    return w


def measure_arms(arms: list[str], repeats: int, root: Path, since: dt.date, until: dt.date, threads: int) -> tuple[dict, dict]:
    """Run every arm `repeats` times, interleaved. Returns per-arm measurements and each arm's first parsed days."""
    results: dict[str, list[dict]] = {a: [] for a in arms}
    outputs: dict[str, dict] = {}
    for r in range(repeats):
        for arm in arms:
            cmd, stdin = arm_command(arm, root, since, until, threads)
            print(f"[{r + 1}/{repeats}] {arm:10s} ...", file=sys.stderr, end=" ", flush=True)
            m = _run_measured(cmd, stdin)
            print(f"wall {m['wall']:.2f}s cpu {m['user'] + m['sys']:.2f}s peak {m['peak_rss'] / 2**20:.0f} MiB exit {m['code']}", file=sys.stderr)
            if m["code"] != 0:
                results[arm].append(m | {"error": m["stderr"]})
                continue
            try:
                payload = json.loads(m["stdout"])
            except ValueError as e:
                results[arm].append(m | {"error": f"bad JSON: {e}"})
                continue
            days_out = payload["days"] if arm.startswith("python") else native._round_days(payload["days"])
            outputs.setdefault(arm, days_out)
            results[arm].append({k: m[k] for k in ("wall", "user", "sys", "peak_rss", "code")} | {"stats": payload.get("stats")})
    return results, outputs


def range_of(values) -> dict:
    """Median and min/max of one measurement across an arm's runs, rounded as the report prints it."""
    return {"median": round(statistics.median(values), 3), "min": round(min(values), 3), "max": round(max(values), 3)}


def timing_block(ok: list[dict]) -> dict:
    """The wall/user/sys ranges, cpu median, peak RSS and scanner stats for an arm that ran at least once."""
    entry = {k: range_of([m[k] for m in ok]) for k in ("wall", "user", "sys")}
    entry["cpu"] = {"median": round(statistics.median(m["user"] + m["sys"] for m in ok), 3)}
    entry["peak_rss_mib"] = {"median": round(statistics.median(m["peak_rss"] for m in ok) / 2**20, 1), "max": round(max(m["peak_rss"] for m in ok) / 2**20, 1)}
    entry["stats"] = ok[0].get("stats")
    return entry


def arm_entry(arm: str, runs: list[dict], ref: dict, days_out: dict | None) -> dict:
    """One arm's report row: run count, the errors it hit, its timing medians, and its agreement with Python."""
    ok = [m for m in runs if "error" not in m]
    entry: dict = {"runs": len(ok), "errors": [m["error"] for m in runs if "error" in m][:2]}
    if ok:
        entry |= timing_block(ok)
    if days_out is not None:
        d = diff(ref, normalise(days_out)) if ref and arm != "python" else []
        entry["identical_to_python"] = not d if arm != "python" else True
        entry["differences"] = d[:12]
    return entry


def pick_winner(entries: dict, py: dict, today: dt.date) -> dict | None:
    """The fastest native arm that both ran and matched Python, or None when nothing qualifies."""
    candidates = [(a, e) for a, e in entries.items() if a != "python" and e.get("identical_to_python") and e.get("runs")]
    if not (candidates and py.get("wall")):
        return None
    best, e = min(candidates, key=lambda ae: ae[1]["wall"]["median"])
    lang, _, n = best.partition("@")
    return {"lang": lang, "threads": int(n or 1), "arm": best, "speedup_wall": round(py["wall"]["median"] / e["wall"]["median"], 2),
            "cpu_ratio": round(py["cpu"]["median"] / e["cpu"]["median"], 2) if e["cpu"]["median"] else None,
            "rss_ratio": round(py["peak_rss_mib"]["median"] / e["peak_rss_mib"]["median"], 2) if e["peak_rss_mib"]["median"] else None,
            "measured": today.isoformat(), "machine": os.environ.get("COMPUTERNAME") or os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME", "")}


def run(days: int = 14, repeats: int = 3, threads: int = 8, arms: list[str] | None = None, root: Path | None = None, out: Path | None = None, today: dt.date | None = None) -> dict:
    root = root or claude_usage.PROJECTS
    today = today or dt.date.today()
    # Completed days only: today's transcripts grow while the arms run (the first bench saw 33591, 33598,
    # 33602, ... requests for today, one arm after another), and a moving target fails every parity check.
    since, until = today - dt.timedelta(days), today - dt.timedelta(1)
    arms = arm_list(threads, arms)
    n_files, n_bytes = corpus_size(root, since)
    print(f"corpus: {n_files} transcript files, {n_bytes / 2**30:.2f} GiB written since {since}; arms {arms}; {repeats} interleaved run(s) each", file=sys.stderr)
    warm_up(arms, root, since, until, threads)
    results, outputs = measure_arms(arms, repeats, root, since, until, threads)

    ref = normalise(outputs.get("python", {}))
    report = {"date": today.isoformat(), "window_days": days, "since": since.isoformat(), "until": until.isoformat(), "root": str(root), "files": n_files, "bytes": n_bytes,
              "repeats": repeats, "threads": threads, "cores": os.cpu_count(), "arms": {}}
    for arm in arms:
        report["arms"][arm] = arm_entry(arm, results[arm], ref, outputs.get(arm))
    winner = pick_winner(report["arms"], report["arms"].get("python", {}), today)
    if winner:
        report["winner"] = winner
    md = render(report)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding="utf-8")
    return report | {"markdown": md}


def render(rep: dict) -> str:
    lines = [f"# Native scanner A/B, {rep['date']}", "",
             f"Window {rep['since']} to {rep['until']} (the {rep['window_days']} completed days before the run; today's transcripts are still "
             f"being written) of `{rep['root']}`: {rep['files']} transcript files, {rep['bytes'] / 2**30:.2f} GiB read. "
             f"{rep['repeats']} interleaved run(s) per arm after one discarded warm-up, {rep['cores']} cores, shared box. "
             "Each run is its own process; CPU = user + kernel; memory = peak working set.", "",
             "| arm | runs | wall median (min-max) | CPU median | peak RSS median | same numbers as Python |", "|---|---:|---:|---:|---:|---|"]
    for arm, e in rep["arms"].items():
        if not e.get("runs"):
            lines.append(f"| {arm} | 0 | failed: {'; '.join(e.get('errors') or ['?'])[:120]} | | | |")
            continue
        same = "reference" if arm == "python" else ("yes" if e.get("identical_to_python") else "NO: " + "; ".join(e.get("differences") or [])[:200])
        lines.append(f"| {arm} | {e['runs']} | {e['wall']['median']:.2f}s ({e['wall']['min']:.2f}-{e['wall']['max']:.2f}) | {e['cpu']['median']:.2f}s | {e['peak_rss_mib']['median']:.0f} MiB | {same} |")
    w = rep.get("winner")
    if w:
        lines += ["", f"**Winner: `{w['arm']}`**: {w['speedup_wall']}x the Python wall time, {w['cpu_ratio']}x less CPU, {w['rss_ratio']}x less peak memory. "
                      f"Recorded in native/winner.json; `claude_usage.collect()` now runs it when the binary is built."]
    else:
        lines += ["", "No winner recorded: no native arm both ran and matched the Python numbers."]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(prog="hswarm native bench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=14, help="window length; it always ends yesterday (completed days only)")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--arms", help="comma list, e.g. python,rust,rust@8,go,go@8 (default: python + every built arm, single and threaded)")
    ap.add_argument("--root")
    ap.add_argument("--out", help="markdown report path (default ~/.hswarm/native/BENCH-NATIVE-<date>.md)")
    ap.add_argument("--no-record", dest="record", action="store_false", help="do not write ~/.hswarm/native/winner.json")
    a = ap.parse_args(argv)
    today = dt.date.today()
    out = Path(a.out) if a.out else native.WINNER.parent / f"BENCH-NATIVE-{today.isoformat()}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    rep = run(a.days, a.repeats, a.threads, a.arms.split(",") if a.arms else None, Path(a.root) if a.root else None, out, today)
    print(rep["markdown"])
    if a.record and rep.get("winner"):
        native.WINNER.parent.mkdir(parents=True, exist_ok=True)
        native.WINNER.write_text(json.dumps(rep["winner"], indent=1) + "\n", encoding="utf-8")
        print(f"winner recorded: {native.WINNER}", file=sys.stderr)
    print(f"report: {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
