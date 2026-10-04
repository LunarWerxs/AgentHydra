"""Offline: each built native scanner (Rust, Go) returns exactly the Python reference's numbers on a
fixture that exercises every rule: replayed requestIds across files, main-before-sub attribution, an
out-of-window record, an unpriced model, 1-hour cache writes, and threaded vs single-threaded folds.
Skipped for an arm whose binary is not built (`hswarm native build`)."""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

from hswarm import claude_usage, native, native_ab
from hswarm.native_ab import diff, normalise, run as bench_run

TODAY = dt.date.today()


def _ts(days_ago: int, hour: int = 12) -> str:
    d = TODAY - dt.timedelta(days_ago)
    return dt.datetime.combine(d, dt.time(hour)).astimezone().astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _line(rid: str, days_ago: int, model: str = "claude-sonnet-5", **usage) -> str:
    u = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0} | usage
    return json.dumps({"requestId": rid, "timestamp": _ts(days_ago), "type": "assistant", "message": {"id": "m-" + rid, "model": model, "usage": u}}) + "\n"


@pytest.fixture
def fixture(tmp_path: Path) -> Path:
    root = tmp_path / "projects" / "proj"
    (root / "sess" / "subagents" / "workflows" / "wf_1").mkdir(parents=True)
    (root / "sess.jsonl").write_text(
        _line("r1", 1, output_tokens=1_000_000) + _line("r1", 1, output_tokens=1_000_000)  # stamped twice, counted once
        + _line("r0", 20, output_tokens=5_000_000)  # outside the window
        + _line("r9", 2, model="claude-mystery-1", output_tokens=10)  # unpriced
        + json.dumps({"type": "user", "message": {"content": "no usage here"}}) + "\n"
        + _line("r8", 2, input_tokens=1000, cache_creation_input_tokens=3000, output_tokens=100).replace('"output_tokens": 100}', '"output_tokens": 100, "cache_creation": {"ephemeral_1h_input_tokens": 2000}}'),
        encoding="utf-8")
    (root / "sess" / "subagents" / "agent-a.jsonl").write_text(
        _line("r1", 1, output_tokens=1_000_000)  # a replay of the parent's request: never billed to the agent
        + _line("r2", 1, input_tokens=5000, cache_read_input_tokens=200_000, output_tokens=100_000)
        + _line("r3", 1, cache_creation_input_tokens=40_000, output_tokens=2_000), encoding="utf-8")
    (root / "sess" / "subagents" / "workflows" / "wf_1" / "agent-b.jsonl").write_text(
        _line("r4", 1, model="claude-opus-5", output_tokens=100_000) + _line("r5", 3, model="claude-opus-5", input_tokens=7), encoding="utf-8")
    return tmp_path / "projects"


@pytest.mark.parametrize("lang", native.LANGS)
def test_native_arm_matches_the_python_reference(fixture: Path, lang: str):
    if native.binary(lang) is None:
        pytest.skip(f"{lang} scanner not built")
    since, until = TODAY - dt.timedelta(14), TODAY
    ref = claude_usage.collect_python(since, until, root=fixture)
    assert ref[(TODAY - dt.timedelta(1)).isoformat()]["main_usd"] == pytest.approx(10.0)
    assert ref[(TODAY - dt.timedelta(2)).isoformat()]["unpriced_requests"] == 1
    single = native.scan(lang, fixture, since, until, n_threads=1)
    threaded = native.scan(lang, fixture, since, until, n_threads=4)
    assert diff(normalise(ref), normalise(single["days"])) == []
    assert diff(normalise(ref), normalise(threaded["days"])) == []
    assert single["stats"]["records"] == sum(d["requests"] for d in ref.values()) == 7  # r1, r9, r8, r2, r3, r4, r5
    assert single["stats"]["files"] == 3 and single["stats"]["candidates"] == 10  # every line carrying "usage", replays included
    # the 1-hour cache write is priced at 2x, the 5-minute one at 1.25x, in every arm
    day2 = single["days"][(TODAY - dt.timedelta(2)).isoformat()]
    assert day2["main_usd"] == pytest.approx((1000 + 1000 * 1.25 + 2000 * 2.0) * 2.0 / 1e6 + 100 * 10.0 / 1e6, abs=1e-4)


def test_collect_uses_the_winner_only_when_built(monkeypatch, fixture: Path):
    monkeypatch.setattr(native, "WINNER", fixture / "winner.json")
    (fixture / "winner.json").write_text(json.dumps({"lang": "rust", "threads": 2}), encoding="utf-8")
    monkeypatch.setattr(native, "binary", lambda lang: None)
    assert native.choose() == "python"
    with pytest.raises(RuntimeError):
        native.choose("go")
    monkeypatch.setenv("HSWARM_SCANNER", "python")
    assert native.choose() == "python"


# ---- the A/B harness's own run() -------------------------------------------------------------------
# run() shells out to one process per arm per repeat, so these drive it with the Python arm on the small
# fixture (a real subprocess, ~1s) and stub only the expensive parts where a branch needs forcing.

def _spy_run_measured(monkeypatch) -> list[dict]:
    """Record every measured child of run(), passing the real measurements through untouched."""
    real, seen = native_ab._run_measured, []

    def spy(cmd: list[str], stdin: str | None) -> dict:
        m = real(cmd, stdin)
        seen.append(m)
        return m

    monkeypatch.setattr(native_ab, "_run_measured", spy)
    return seen


def test_bench_run_measures_the_python_arm(tmp_path: Path, fixture: Path, monkeypatch):
    """One arm, one repeat: run() writes a report whose Python arm is the reference, and records no winner."""
    seen = _spy_run_measured(monkeypatch)
    out = tmp_path / "BENCH.md"
    rep = bench_run(days=14, repeats=1, threads=1, arms=["python"], root=fixture, out=out, today=TODAY)

    assert [m["code"] for m in seen] == [0, 0]  # the discarded warm-up, then the one measured run
    since, until = TODAY - dt.timedelta(14), TODAY - dt.timedelta(1)
    assert json.loads(seen[1]["stdout"])["days"] == claude_usage.collect_python(since, until, root=fixture)
    assert (rep["since"], rep["until"], rep["files"]) == (since.isoformat(), until.isoformat(), 3)
    assert rep["repeats"] == 1 and rep["threads"] == 1
    assert rep["arms"]["python"]["runs"] == 1 and rep["arms"]["python"]["errors"] == []
    assert rep["arms"]["python"]["identical_to_python"] is True and rep["arms"]["python"]["differences"] == []
    assert "winner" not in rep and "No winner recorded" in rep["markdown"]
    assert out.read_text(encoding="utf-8") == rep["markdown"]


@pytest.mark.parametrize("body, complaint", [
    ("import sys; sys.stderr.write('boom'); sys.exit(3)", "boom"),
    ("print('not json at all')", "bad JSON"),
])
def test_bench_run_records_a_broken_arm_and_picks_no_winner(tmp_path: Path, fixture: Path, monkeypatch, body: str, complaint: str):
    """A non-zero exit and unparseable stdout are both recorded as that arm's error, never as a winner."""
    monkeypatch.setattr(native_ab, "arm_command", lambda *a, **k: ([sys.executable, "-c", body], None))
    out = tmp_path / "BENCH.md"
    rep = bench_run(days=14, repeats=1, threads=1, arms=["python"], root=fixture, out=out, today=TODAY)

    entry = rep["arms"]["python"]
    assert entry["runs"] == 0 and complaint in entry["errors"][0]
    assert "identical_to_python" not in entry  # no output was ever produced to compare
    assert "winner" not in rep and f"failed: {complaint}" in rep["markdown"]
    assert out.read_text(encoding="utf-8") == rep["markdown"]


def test_bench_run_picks_the_fastest_arm_that_matches_python(tmp_path: Path, fixture: Path, monkeypatch):
    """Two arms fed identical numbers: both match the reference, the lower wall median is the winner."""
    real = native_ab.arm_command
    monkeypatch.setattr(native_ab, "arm_command", lambda arm, root, since, until, threads: real("python", root, since, until, threads))
    out = tmp_path / "BENCH.md"
    rep = bench_run(days=14, repeats=2, threads=1, arms=["python", "rust"], root=fixture, out=out, today=TODAY)

    assert rep["arms"]["python"]["runs"] == rep["arms"]["rust"]["runs"] == 2
    assert rep["arms"]["rust"]["identical_to_python"] is True and rep["arms"]["rust"]["differences"] == []
    w = rep["winner"]
    assert (w["lang"], w["arm"], w["threads"]) == ("rust", "rust", 1)
    assert w["speedup_wall"] > 0 and w["measured"] == TODAY.isoformat()
    assert f"**Winner: `rust`**" in rep["markdown"]


def test_toolchain_found_at_the_installers_home_when_not_on_path(tmp_path: Path, monkeypatch):
    # rustup installs cargo under ~/.cargo/bin and only a NEW shell gets it on PATH; a machine whose
    # PATH never picked it up reported "cargo not on PATH" and silently kept the slow Python scanner
    # (2026-09-21), though the toolchain was installed.
    exe = ".exe" if sys.platform == "win32" else ""
    cargo = tmp_path / ".cargo" / "bin" / f"cargo{exe}"
    cargo.parent.mkdir(parents=True)
    cargo.write_text("")
    monkeypatch.setattr(native.shutil, "which", lambda tool: None)
    monkeypatch.setattr(native.Path, "home", classmethod(lambda cls: tmp_path))
    assert native.toolchain("cargo") == str(cargo)
    # Go's home is checked before /usr/local/go and Program Files, so the answer is this machine-independent file.
    # (Asserting "no go at all" read the REAL Program Files and went red on a machine with Go installed there.)
    go = tmp_path / "go" / "bin" / f"go{exe}"
    go.parent.mkdir(parents=True)
    go.write_text("")
    assert native.toolchain("go") == str(go)
