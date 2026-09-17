#!/usr/bin/env python3
"""dryrun.py - OBSERVE: run the dry loop N times and prove it actually works, with evidence.

THE ASK (owner, 2026-09-17): "can we run like 50 dry runs to make sure it's all functioning?"
A single dry loop tells you it did not crash THIS time. Fifty tell you something a single run
structurally cannot:

  1. DOES IT CRASH INTERMITTENTLY? One clean run proves nothing about the daemon blip, the
     half-written transcript, the app that was mid-restart. N runs put a number on it.
  2. DOES IT AGREE WITH ITSELF? Two runs can report the same COUNTS and still disagree about
     which chat is which. This harness fingerprints every chat's decision (sessionId ->
     lane) and reports FLAPS - a chat that changed lane and changed back with nothing in
     between. A flap is a real bug: it means some lane's verdict depends on timing, and on
     an acting pass that is the difference between archiving a chat and waking it.
  3. WHERE DOES THE TIME GO? Each run reports per-stage timings; N runs turn "the loop takes
     about two minutes" into a named stage with a median.
  4. DOES THE POLICY ACTUALLY STEER IT? --matrix runs the loop under different policies and
     asserts each one changed exactly what it claims to. A config file nothing reads is worse
     than no config file, and the only honest way to know is to flip a knob and watch the
     plan move.

⛔ EVERY RUN IS A FRESH SUBPROCESS, ON PURPOSE. Looping inside one process would let
hydralib's usage-survey cache (240s) and every module-level constant carry from run to run:
runs 2..N would be faster and MORE identical than reality, which is a false green in the
exact place this harness exists to be honest about. A subprocess costs an interpreter start
and buys a real answer.

Nothing here can act: it runs `orch.py loop --json`, which calls plan-only paths only. Safe
to run against a live fleet, and safe to run fifty times.

Usage: python dryrun.py [--runs N] [--gap SECS] [--json] [--out FILE]
       python dryrun.py --matrix [--runs N]     # one run per policy variant, then compare
       python dryrun.py --runs 50               # the owner's 50, ~10 minutes on this fleet
Exit:  0 every run clean and self-consistent - 2 runs failed, flapped, or the matrix showed a
       policy that changed nothing - 1 could not run at all. An INCONCLUSIVE matrix variant
       (nothing on the fleet for that knob to steer) is printed as unproven and does not fail.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

from lib import clilib

REPO = Path(__file__).resolve().parent.parent
ORCH = REPO / "orch.py"
REPORTS = REPO / "state" / "dryruns"

# The policy variants --matrix walks: (name, overrides, expectation).
#
# ⛔ EACH VARIANT DECLARES WHAT IT SHOULD CHANGE, AND IS JUDGED ON THAT (rewritten 2026-09-17,
# the first hour this harness existed). The first version asked only "did anything in the plan
# differ from baseline?" and reported every variant as a pass - because the judgment-queue
# count drifts on its own while a live fleet works, so NATURAL DRIFT was being read as proof
# the policy was wired. That is the exact false green this harness exists to prevent, and it
# passed it. A variant now names the field it must move and in which direction; drift in any
# other field is ignored, and a variant that cannot be seen in a DRY loop at all
# (`sees_plan=False`) says so out loud instead of quietly counting as a pass - those knobs act
# at ACT time and are covered by tests/test_policy_wiring.py, which is named here so the gap
# is documented rather than discovered.
#
#
# ⛔ AND EACH IS JUDGED ON EVIDENCE THAT CANNOT PASS AN INERT KNOB (rewritten again the same
# day, on review). The second version still compared counts with a `>=` or an "or unchanged",
# so a cap nobody read passed whenever the lane was already full, and a signal nobody read
# passed because "the same number of archive candidates" satisfies "the same or more". Now a
# cap is checked inside the variant's own run (shown == min(cap, everything waiting)), and a
# signal is checked chat by chat: the baseline records which chats are held back ONLY by the
# signals the variant switches off, and every one of them must come out released. When this
# fleet has nothing that could tell a wired knob from an inert one, the verdict is
# INCONCLUSIVE - said out loud, never counted as a pass.
#
# `expect(baseline_view, variant_view) -> (ok, said)`, a view being `_view(row)`; ok None is
# the inconclusive answer.
def _view(row: dict) -> dict:
    s = row.get("stages") or {}
    return {"counts": _stage_counts(row), "decisions": s.get("decisions") or {},
            "dissent": s.get("dissent") or {}}


def _expect_lane_cap(lane: str, cap: int):
    def check(_base, got):
        from lib import configlib

        shown, over = got["counts"][lane], got["counts"][lane + "Over"]
        waiting = shown + over
        said = f"{lane} shows {shown} of {waiting} waiting (cap {cap})"
        if min(cap, waiting) == min(configlib.defaults()["lanes.max_per_lane"], waiting):
            return None, said + " - too little waiting to tell this cap from the default"
        return shown == min(cap, waiting), said
    return check


def _expect_signals_release(*signals: str):
    """Every chat the baseline shows as held back ONLY by `signals` must come out as an archive
    candidate (or held back by the breaker, which is the archive lane's own brake)."""
    def check(base, got):
        held = [sid for sid, ds in base["dissent"].items()
                if ds and set(ds) <= set(signals)
                and base["decisions"].get(sid) == "wait-on-person"]
        if not held:
            return None, (f"no chat on this fleet is held back only by {', '.join(signals)} - "
                          "nothing for the switch to release")
        # A chat that is still waiting on a person with its only objections switched off is
        # the knob doing nothing. A chat that moved anywhere else (woken, archived by hand,
        # started running) is the fleet moving between the two runs, and is not counted.
        stuck = [sid for sid in held if got["decisions"].get(sid) == "wait-on-person"]
        released = [sid for sid in held
                    if got["decisions"].get(sid) in ("archive", "held-back")]
        said = (f"{len(released)} of {len(held)} chat(s) held back only by "
                f"{', '.join(signals)} became archive candidates")
        if stuck:
            said += f"; STILL WAITING: {', '.join(s[:8] for s in stuck[:5])}"
        return (not stuck and bool(released)), said
    return check


def _expect_same_liveness(base, got):
    """The slow per-chat path must agree with the fast index. A chat that differs could be the
    fleet moving between two runs, or the fast path missing a writer - so each one is named."""
    b, g = base["decisions"], got["decisions"]
    differ = sorted(sid for sid in set(b) & set(g) if b[sid] != g[sid])
    said = f"{len(g)} chats on the slow path, {len(differ)} decision(s) differ from the fast path"
    if differ:
        said += ": " + ", ".join(f"{s[:8]} {b[s]}->{g[s]}" for s in differ[:4])
    return bool(g), said


MATRIX: list[dict] = [
    {"name": "baseline", "overrides": {}, "sees_plan": True, "expect": None},
    {"name": "tiny-caps", "overrides": {"lanes.max_per_lane": 1}, "sees_plan": True,
     "expect": _expect_lane_cap("landConsole", 1),
     "why": "every lane is capped at 1, so a lane with work must show exactly 1"},
    {"name": "big-caps", "overrides": {"lanes.max_per_lane": 25}, "sees_plan": True,
     "expect": _expect_lane_cap("landConsole", 25),
     "why": "a lane capped at 25 must show everything waiting, up to 25"},
    {"name": "eager-archive", "sees_plan": True,
     "overrides": {"gate.signal_no_open_recommendations": False,
                   "gate.signal_no_offer_to_continue": False},
     "expect": _expect_signals_release("recommendations", "offer"),
     "why": "every chat held back only by open recommendations or an offer to carry on must "
            "be released to the archive lane - that is what 'off' means, and it is why the "
            "menu calls it more eager rather than faster"},
    {"name": "all-signals-off", "sees_plan": True,
     "overrides": {"gate.signal_done_claim": False, "gate.signal_no_question": False,
                   "gate.signal_no_offer_to_continue": False,
                   "gate.signal_no_open_recommendations": False},
     "expect": _expect_signals_release("done_claim", "question", "offer", "recommendations"),
     "why": "the most dangerous setting the file allows - every finished chat waiting on a "
            "person must be released, so nobody can set it and see nothing happen"},
    {"name": "slow-liveness", "overrides": {"perf.bulk_liveness": False}, "sees_plan": True,
     "expect": _expect_same_liveness,
     "why": "the per-chat liveness fallback must still produce a plan, and every decision it "
            "disagrees with the fast index on is named"},
    # Knobs that act at ACT time and are invisible to a dry loop, by design.
    {"name": "lanes-off", "sees_plan": False,
     "overrides": {"lanes.archive": False, "lanes.moves": False,
                   "lanes.land_console": False, "lanes.deliver": False},
     "why": "lane toggles are read by sweep.parse_lanes when a sweep ACTS; the dry loop still "
            "shows the full batch (you should always see what is waiting), now marked OFF. "
            "Covered by test_policy_wiring.SweepLaneTest"},
    {"name": "archive-off", "sees_plan": False, "overrides": {"archive.enabled": False},
     "why": "the master switch is enforced inside archive_chat, not in the plan - candidates "
            "are still FOUND and shown, never filed. Covered by "
            "test_policy_wiring.ArchiveMasterSwitchTest"},
    {"name": "small-queue", "sees_plan": False, "overrides": {"interview.max_questions": 2},
     "why": "the question cap is interview.py's, not the loop's. Covered by "
            "test_configlib.EveryKnobIsWiredTest (something reads it) and the "
            "default-matches-the-constant pairs"},
]


def one_run(env_extra: dict | None = None, timeout: int = 900) -> dict:
    """One dry loop, in its own process. Returns a row even when it fails - a harness that
    raises on the first bad run cannot tell you the failure RATE, which is the whole point."""
    import os

    env = {**os.environ, **(env_extra or {})}
    t0 = time.time()
    try:
        # clilib.run_text, never a text-mode subprocess: under the daemon (PYTHONUTF8=1) one
        # non-ASCII byte in the loop's output blanks the whole read, and a blank read here is
        # a "crash".
        p = clilib.run_text([sys.executable, str(ORCH), "loop", "--json"],
                            timeout=timeout, cwd=str(REPO), env=env)
    except subprocess.TimeoutExpired:
        return {"ok": False, "exit": None, "secs": round(time.time() - t0, 1),
                "why": f"TIMED OUT after {timeout}s", "stages": None}
    secs = round(time.time() - t0, 1)
    try:
        stages = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "exit": p.returncode, "secs": secs, "stages": None,
                "why": "the loop printed something that is not JSON: "
                       + (p.stderr or p.stdout or "")[-300:]}
    # exit 2 is "the loop found something that failed" - a real finding, not a harness error,
    # so it is recorded as a run that completed AND as a problem, never silently as a pass.
    return {"ok": p.returncode == 0, "exit": p.returncode, "secs": secs, "stages": stages,
            "why": "" if p.returncode == 0 else _why_exit2(stages)}


def _why_exit2(stages: dict) -> str:
    bits = []
    if not (stages.get("census") or {}).get("plausible"):
        bits.append("census not plausible (0-1 instances open = detection is broken, not a "
                    "quiet fleet)")
    if not (stages.get("gate") or {}).get("complete"):
        bits.append("the chat read was INCOMPLETE - every count is a lower bound")
    if (stages.get("reconcile") or {}).get("reverted"):
        bits.append(f"{stages['reconcile']['reverted']} archive(s) did not settle")
    if stages.get("policyProblems"):
        bits.append(f"the policy file has problems: {stages['policyProblems'][0]}")
    return "; ".join(bits) or "exit 2 with no stage flagged - look at the JSON"


def _decisions(row: dict) -> dict:
    return ((row.get("stages") or {}).get("decisions")) or {}


# A live chat that pauses longer than gate.idle_after_secs and then carries on legitimately
# crosses the idle line in both directions - 'leave-alone' (working) <-> 'judgment' (idle with
# a live writer). Confirmed live on 2026-09-17: the one chat the first 50-run pass flagged was
# writing to its transcript every few seconds and had simply paused past 180s twice. Neither
# state can archive or move anything (both mean a writer is alive), so the oscillation costs
# nothing - but it is REAL, and it is why a chat can appear in the judgment queue while it is
# actually mid-work. It is reported, separately and with that explanation, rather than either
# hidden or counted as a defect.
IDLE_OSCILLATION = {"leave-alone", "judgment"}


def find_flaps(rows: list[dict]) -> list[dict]:
    """A chat whose decision CHANGED AND CHANGED BACK across the runs. Deliberately not "any
    change": a chat legitimately moves lane when it starts running, finishes a turn or is
    archived, and that shows up as one transition in one direction. A value that oscillates
    (A -> B -> A) is the shape that cannot be explained by the fleet moving forward.

    Each flap carries `serious`: False for the known-benign idle oscillation above, True for
    anything else - and only a serious flap fails the run. A harness that called the benign
    one a bug would be red on every pass with a busy chat on the fleet, and a harness that is
    always red is a harness nobody reads."""
    seen: dict[str, list] = {}
    for i, row in enumerate(rows):
        for sid, kind in _decisions(row).items():
            hist = seen.setdefault(sid, [])
            if not hist or hist[-1][1] != kind:
                hist.append((i, kind))
    flaps = []
    for sid, hist in seen.items():
        kinds = [k for _i, k in hist]
        if len(kinds) >= 3 and len(set(kinds)) < len(kinds):
            benign = set(kinds) <= IDLE_OSCILLATION
            flaps.append({"sessionId": sid, "serious": not benign,
                          "why": ("a live chat crossing the idle threshold in both directions "
                                  "- it paused past gate.idle_after_secs and carried on. "
                                  "Neither state can archive or move it." if benign else
                                  "a verdict that depends on timing - on an acting pass this "
                                  "is the difference between archiving a chat and waking it"),
                          "path": " -> ".join(f"{k}@{i}" for i, k in hist)})
    return flaps


def _stage_counts(row: dict) -> dict:
    s = row.get("stages") or {}
    lanes = s.get("lanes") or {}
    out = {"chats": (s.get("gate") or {}).get("scanned")}
    for lane in ("archive", "moves", "landConsole", "deliver"):
        out[lane] = (lanes.get(lane) or {}).get("would")
        out[lane + "Over"] = (lanes.get(lane) or {}).get("overCap")
    out["judgment"] = len(s.get("judgmentQueue") or [])
    out["onHold"] = len(s.get("onHold") or [])
    return out


def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    return 0.0 if not xs else (xs[len(xs) // 2] if len(xs) % 2 else
                               round((xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2, 2))


def summarize(rows: list[dict]) -> dict:
    done = [r for r in rows if r.get("stages")]
    failed = [r for r in rows if not r.get("stages")]
    exit2 = [r for r in done if r["exit"] == 2]
    counts = [_stage_counts(r) for r in done]
    varies = {k: sorted({c[k] for c in counts if c[k] is not None})
              for k in (counts[0] if counts else {})}
    timings: dict[str, list[float]] = {}
    for r in done:
        for stage, secs in ((r["stages"].get("timings")) or {}).items():
            timings.setdefault(stage, []).append(secs)
    flaps = find_flaps(done)
    return {
        "runs": len(rows), "completed": len(done), "crashed": len(failed),
        "exitZero": sum(1 for r in done if r["exit"] == 0), "exitTwo": len(exit2),
        "secs": {"min": min((r["secs"] for r in done), default=0),
                 "median": _median([r["secs"] for r in done]),
                 "max": max((r["secs"] for r in done), default=0)},
        "stageSecs": {k: {"median": _median(v), "max": max(v), "share": None}
                      for k, v in timings.items()},
        "countRange": {k: (v[0], v[-1]) if v else None for k, v in varies.items()},
        "flaps": flaps,
        "problems": [{"run": i, "why": r["why"]} for i, r in enumerate(rows) if r.get("why")],
    }


def run_many(n: int, gap: float) -> list[dict]:
    rows = []
    for i in range(n):
        row = one_run()
        rows.append(row)
        mark = "ok " if row["exit"] == 0 else ("FAIL" if row["stages"] is None else "exit2")
        c = _stage_counts(row) if row.get("stages") else {}
        print(f"  run {i + 1:>3}/{n}  {mark}  {row['secs']:>6.1f}s  "
              f"chats={c.get('chats')} archive={c.get('archive')} judgment={c.get('judgment')}"
              + (f"   {row['why'][:90]}" if row.get("why") else ""), flush=True)
        if gap and i + 1 < n:
            time.sleep(gap)
    return rows


def run_matrix(runs_each: int) -> dict:
    """One dry loop per policy variant, each in a subprocess with ORCH_CONFIG pointed at a
    throwaway file - the owner's real state/config.json is never touched, read or written by
    this. The assertion is that a variant CHANGES SOMETHING a person can see."""
    import os
    import tempfile

    out = []
    tmpdir = Path(tempfile.mkdtemp(prefix="orch-matrix-"))
    base_view = None
    try:
        for spec in MATRIX:
            name, overrides = spec["name"], spec["overrides"]
            cfg = tmpdir / f"{name}.json"
            cfg.write_text(json.dumps(overrides), encoding="utf-8")
            rows = [one_run({"ORCH_CONFIG": str(cfg)}) for _ in range(runs_each)]
            done = [r for r in rows if r.get("stages")]
            view = _view(done[0]) if done else None
            if name == "baseline":
                base_view = view
            ran = bool(done) and all(r.get("stages") for r in rows)
            # The verdict, in honest shapes - never one "ok" that hides the difference.
            if not ran:
                verdict, said = "FAILED", next((r["why"] for r in rows if r.get("why")), "")
            elif not spec.get("sees_plan"):
                verdict, said = "not-visible-here", spec.get("why", "")
            elif spec["expect"] is None:
                verdict, said = "baseline", ""
            elif base_view is None:
                verdict, said = "FAILED", "the baseline never produced a plan to compare with"
            else:
                ok, said = spec["expect"](base_view, view)
                verdict = ("INCONCLUSIVE" if ok is None else
                           "steered" if ok else "DID NOT STEER")
            out.append({"variant": name, "overrides": overrides, "verdict": verdict,
                        "counts": view and view["counts"], "said": said,
                        "why": spec.get("why", ""),
                        "secs": _median([r["secs"] for r in done]) if done else None})
            print(f"  {name:<17} {verdict:<17} {(said or spec.get('why', ''))[:74]}", flush=True)
    finally:
        for p in tmpdir.glob("*"):
            p.unlink(missing_ok=True)
        tmpdir.rmdir()

    bad = [r["variant"] for r in out if r["verdict"] in ("DID NOT STEER", "FAILED")]
    unproven = [r["variant"] for r in out if r["verdict"] == "INCONCLUSIVE"]
    return {"variants": out, "failed": bad, "inconclusive": unproven,
            "note": ("Each variant is judged against what it CLAIMS to change, on evidence an "
                     "inert knob cannot fake: a cap inside its own run, a signal chat by chat. "
                     "'INCONCLUSIVE' means this fleet had nothing that could tell a wired knob "
                     "from an inert one right now - not a pass. A 'not-visible-here' variant "
                     "acts at ACT time and names the unit test that covers it.")}


def render(summary: dict) -> str:
    L = ["", "=" * 78,
         f"DRY RUN HARNESS - {summary['runs']} run(s), all read-only", "=" * 78]
    L.append(f"completed        {summary['completed']} of {summary['runs']}"
             + (f"   ⚠ {summary['crashed']} never produced a plan" if summary["crashed"] else ""))
    L.append(f"clean (exit 0)   {summary['exitZero']}")
    if summary["exitTwo"]:
        L.append(f"found a problem  {summary['exitTwo']} run(s) exited 2 - the loop's own "
                 "'something failed' code, which is a FINDING, not a harness fault")
    s = summary["secs"]
    L.append(f"wall clock       median {s['median']}s (min {s['min']}, max {s['max']})")
    if summary["stageSecs"]:
        L.append("where the time goes (median per stage):")
        for stage, v in sorted(summary["stageSecs"].items(), key=lambda kv: -kv[1]["median"]):
            L.append(f"                   {stage:<12} {v['median']:>7}s   (worst {v['max']}s)")
    L.append("")
    L.append("SELF-CONSISTENCY - does it agree with itself run to run?")
    for k, rng in summary["countRange"].items():
        if rng is None:
            continue
        lo, hi = rng
        L.append(f"  {k:<14} {lo}" + (f" .. {hi}   (moved during the run - expected on a live "
                                      "fleet)" if lo != hi else "   (identical every run)"))
    serious = [f for f in summary["flaps"] if f.get("serious")]
    benign = [f for f in summary["flaps"] if not f.get("serious")]
    if serious:
        L.append(f"\n  ⛔ {len(serious)} chat(s) FLAPPED on a verdict that can ACT - a decision "
                 "that changed and changed back. This is timing-dependent and it is a bug:")
        for f in serious[:10]:
            L.append(f"      {f['sessionId'][:8]}  {f['path']}")
            L.append(f"          {f['why']}")
    if benign:
        L.append(f"\n  {len(benign)} chat(s) crossed the idle line both ways - expected, not a "
                 "defect: both states mean a writer is alive, so neither can archive or move "
                 "anything. Worth knowing, though - this is how a chat can appear in the "
                 "judgment queue while it is actually mid-work.")
        for f in benign[:5]:
            L.append(f"      {f['sessionId'][:8]}  {f['path']}")
    if not summary["flaps"]:
        L.append("\n  no flaps - no chat's decision changed and changed back. Every verdict "
                 "that moved, moved once and stayed.")
    if summary["problems"]:
        L.append(f"\nPROBLEMS ({len(summary['problems'])}):")
        for p in summary["problems"][:12]:
            L.append(f"  run {p['run'] + 1}: {p['why'][:150]}")
    return "\n".join(L)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    runs = int(argv[argv.index("--runs") + 1]) if "--runs" in argv else 50
    gap = float(argv[argv.index("--gap") + 1]) if "--gap" in argv else 2.0
    if not ORCH.exists():
        print(f"cannot find {ORCH}", file=sys.stderr)
        return 1
    REPORTS.mkdir(parents=True, exist_ok=True)

    if "--matrix" in argv:
        print(f"POLICY MATRIX - {len(MATRIX)} variant(s), {runs if '--runs' in argv else 1} "
              "run(s) each. Your own config.json is not touched.\n")
        result = run_matrix(runs if "--runs" in argv else 1)
        payload = {"mode": "matrix", **result}
        if as_json:
            print(json.dumps(payload, indent=2, default=str))
        else:
            print("\n" + result["note"])
            if result["failed"]:
                print(f"\n⛔ {', '.join(result['failed'])} did not do what it claims - a knob "
                      "that changes nothing is a knob the owner only THINKS he has.")
            else:
                seen = sum(1 for v in result["variants"] if v["verdict"] == "steered")
                hid = sum(1 for v in result["variants"] if v["verdict"] == "not-visible-here")
                print(f"\n{seen} variant(s) steered the plan exactly as claimed; {hid} act at "
                      "ACT time and are covered by the named unit tests instead.")
                if result["inconclusive"]:
                    print(f"⚠ {', '.join(result['inconclusive'])}: this fleet could not show "
                          "whether the knob is wired - NOT proven, re-run when there is work "
                          "for it to steer.")
                else:
                    print("Nothing was silently inert.")
        _save(payload)
        return 2 if result["failed"] else 0

    print(f"{runs} dry run(s), each a fresh process, {gap}s apart. Nothing is touched.\n")
    rows = run_many(runs, gap)
    summary = summarize(rows)
    payload = {"mode": "runs", "summary": summary,
               "rows": [{k: v for k, v in r.items() if k != "stages"} for r in rows]}
    print(json.dumps(payload, indent=2, default=str) if as_json else render(summary))
    path = _save(payload)
    if not as_json:
        print(f"\nfull report: {path}")
    serious_flaps = [f for f in summary["flaps"] if f.get("serious")]
    return 0 if (summary["completed"] == summary["runs"] and not serious_flaps
                 and not summary["exitTwo"]) else 2


def _save(payload: dict) -> Path:
    # Sequential names, no clock: two reports a second apart must not collide, and the
    # orchestrator's own scripts avoid wall-clock filenames for exactly that reason.
    REPORTS.mkdir(parents=True, exist_ok=True)
    n = 1 + max([int(p.stem.split("-")[-1]) for p in REPORTS.glob("report-*.json")
                 if p.stem.split("-")[-1].isdigit()] or [0])
    path = REPORTS / f"report-{n:04d}.json"
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return path


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
