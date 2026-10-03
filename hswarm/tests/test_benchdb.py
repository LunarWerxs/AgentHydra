"""The bench results DB: rows are reused only when they are a real measurement of the same test."""
from __future__ import annotations

import asyncio
import datetime as dt
import json

import pytest

from hswarm import benchdb as db


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "RUNS", tmp_path / "runs.jsonl")
    monkeypatch.setattr(db, "RESULTS", tmp_path / "results.jsonl")
    monkeypatch.setattr(db, "LEGACY", tmp_path / "legacy.jsonl")
    return tmp_path


def _row(item, rep=0, ok=True, status="ok", v="v1", arm="a", suite="s", **kw):
    return {"run": "r", "suite": suite, "v": v, "arm": arm, "item": item, "rep": rep, "pass": ok if status == "ok" else None, "status": status, **kw}


def test_cached_reuses_graded_rows_only():
    db.record_rows([_row("x"), _row("y", ok=False), _row("z", status="error"), _row("b", status="blocked")])
    got = db.cached("s", "v1", "a")
    assert set(got) == {("x", 0), ("y", 0)}  # a graded FAIL is a measurement; an error or a limit is not
    assert got[("y", 0)]["pass"] is False


def test_cached_is_keyed_on_suite_version_and_arm():
    db.record_rows([_row("x", v="old"), _row("x", arm="other")])
    assert db.cached("s", "v1", "a") == {}


def test_cached_skips_rows_older_than_max_age(_tmp_db):
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=40)).isoformat(timespec="seconds")
    db.RESULTS.write_text(json.dumps({"ts": old, **_row("x")}) + "\n", encoding="utf-8")
    assert db.cached("s", "v1", "a", max_age_days=30) == {}
    assert ("x", 0) in db.cached("s", "v1", "a", max_age_days=60)


def test_cached_keeps_the_newest_row_per_item_and_rep(_tmp_db):
    rows = [{"ts": "2099-01-01T00:00:00+00:00", **_row("x", ok=False)}, {"ts": "2099-01-02T00:00:00+00:00", **_row("x", ok=True)}]
    db.RESULTS.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    assert db.cached("s", "v1", "a", max_age_days=1e6)[("x", 0)]["pass"] is True


def test_a_half_written_line_does_not_poison_the_file(_tmp_db):
    db.record_rows([_row("x")])
    with db.RESULTS.open("a", encoding="utf-8") as f:
        f.write('{"ts": "2026-')  # a run killed mid-write
    assert len(db.rows()) == 1


def test_board_counts_ungraded_apart_and_shows_only_the_newest_version(_tmp_db):
    rows = [{"ts": "2026-01-01T00:00:00+00:00", **_row("x", v="old")},
            {"ts": "2026-02-01T00:00:00+00:00", **_row("x", v="new", cost=0.01, s=1.0)},
            {"ts": "2026-02-01T00:00:00+00:00", **_row("y", v="new", ok=False, s=3.0)},
            {"ts": "2026-02-01T00:00:00+00:00", **_row("z", v="new", status="blocked")}]
    db.RESULTS.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    [line] = db.board("s", include_legacy=False)
    assert (line["v"], line["graded"], line["passed"], line["ungraded"], line["rate"]) == ("new", 2, 1, 1, 0.5)
    assert len(db.board("s", include_legacy=False, all_versions=True)) == 2


def test_board_includes_doc_transcribed_aggregates(_tmp_db):
    db.LEGACY.write_text(json.dumps({"date": "2026-09-20", "suite": "s", "arm": "doc-arm", "pass": 9, "total": 10, "source": "docs/X.md"}) + "\n", encoding="utf-8")
    [line] = db.board("s")
    assert (line["arm"], line["rate"], line["source"]) == ("doc-arm", 0.9, "docs/X.md")


def test_version_of_ignores_dict_key_order():
    assert db.version_of({"a": 1, "b": [1, 2]}) == db.version_of({"b": [1, 2], "a": 1})
    assert db.version_of({"a": 1}) != db.version_of({"a": 2})


def test_import_out_is_idempotent_and_keeps_blocked_ungraded(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    report = {"run": "20260915-010203-judg-api", "suite": "judgment", "arms": {"api:flash": {"rows": [
        {"task": "t1", "pass": True, "blocked": False, "status": "ok", "seconds": 1.0, "cost_usd": 0.001},
        {"task": "t2", "pass": False, "blocked": False, "status": "error", "seconds": 2.0, "cost_usd": 0.001},
        {"task": "t3", "pass": False, "blocked": True, "status": "error", "seconds": 0.1, "cost_usd": 0.0}]}}}
    (out / "r.json").write_text(json.dumps(report), encoding="utf-8")
    assert db.import_out(out) == 3
    assert db.import_out(out) == 0
    [line] = db.board("bench.judgment", include_legacy=False, all_versions=True)
    # a non-blocked error was graded a FAIL by the bench, so it is one here; a limit is not a measurement
    assert (line["graded"], line["passed"], line["ungraded"]) == (2, 1, 1)
    # History is read, never reused as a current measurement: a harness asks for its suite's source hash, never "pre-db".
    assert db.cached("bench.judgment", db.version_of_files(*db.ROOT.glob("judgment*.py")), "api:flash") == {}






def test_board_reports_the_trace_tools_rate_apart_from_the_pass_rate():
    # Two right answers, one reached with the wrong tools, and one row whose task names no tool expectations.
    db.record_rows([_row("x", tools_ok=True), _row("y", rep=1, tools_ok=False), _row("z", rep=2)])
    (line,) = db.board("s", include_legacy=False)
    assert line["rate"] == 1.0 and line["tools_rate"] == 0.5


def test_board_flags_an_arm_graded_without_its_known_gap_tasks():
    # A known-gap skip raises the arm's rate by shrinking its denominator: the board must say so, not just report.md.
    db.record_rows([_row("x", arm="gapped", skipped=2), _row("x", arm="full")])
    got = {x["arm"]: x for x in db.board("s", include_legacy=False)}
    assert got["gapped"]["skipped"] == 2 and got["full"]["skipped"] == 0
