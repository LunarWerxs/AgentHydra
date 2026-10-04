"""Monthly ledger rotation (ledgerstore.py): finished months move to ledger-YYYYMM.jsonl.gz, a crash loses and doubles nothing,
and every reader that sums history reports the same totals before and after."""
from __future__ import annotations

import datetime as dt
import gzip
import json
from collections import Counter
from pathlib import Path

import pytest

from hswarm import config, ledger, ledgerstore, model_stats

NOW = dt.datetime(2026, 10, 3, 12, 0, tzinfo=dt.timezone.utc)


def _row(task: str, ts: str, cost: float = 0.01, model: str = "m") -> dict:
    return {"ts": ts, "job": "j", "task": task, "model": model, "status": "ok", "cost_usd": cost, "seconds": 1.5, "out": 10}


def _write(rows: list[dict]) -> list[bytes]:
    lines = [(json.dumps(r) + "\n").encode() for r in rows]
    config.LEDGER.parent.mkdir(parents=True, exist_ok=True)
    config.LEDGER.write_bytes(b"".join(lines))
    return lines


def _live_lines() -> list[bytes]:
    return config.LEDGER.read_bytes().splitlines(keepends=True)


def _archive(month: str) -> list[bytes]:
    return list(ledgerstore.read_archive_lines(ledgerstore.archive_path(config.LEDGER, month)))


def _everything() -> Counter:
    out = Counter(_live_lines())
    for p in ledgerstore.archives(config.LEDGER).values():
        out.update(ledgerstore.read_archive_lines(p))
    return out


MIXED = [
    _row("a1", "2026-08-30T10:00:00+00:00"),
    _row("s1", "2026-09-01T00:00:01+00:00"),
    _row("s2", "2026-09-30T23:59:59+00:00"),
    _row("o1", "2026-10-01T00:00:00+00:00"),
    _row("o2", "2026-10-03T08:00:00+00:00"),
]


def test_rotation_moves_only_finished_months_one_archive_each():
    lines = _write(MIXED)
    assert ledgerstore.rotate(config.LEDGER, now=NOW) == {"202608": 1, "202609": 2}
    assert _archive("202608") == lines[:1] and _archive("202609") == lines[1:3]
    assert _live_lines() == lines[3:]  # October stays, in order
    assert ledgerstore.rotate(config.LEDGER, now=NOW) == {}  # nothing finished is left
    assert not ledgerstore._journal(config.LEDGER).exists()


def test_a_late_line_of_an_archived_month_joins_its_archive(monkeypatch):
    lines = _write(MIXED)
    ledgerstore.rotate(config.LEDGER, now=NOW)
    late = (json.dumps(_row("s3", "2026-09-30T23:59:59+00:00")) + "\n").encode()
    with config.LEDGER.open("ab") as f:
        f.write(late)
    ledgerstore.rotate(config.LEDGER, now=NOW)
    assert _archive("202609") == [lines[1], lines[2], late]
    assert _live_lines() == lines[3:]


@pytest.mark.parametrize("crash_after_swap", [False, True])
def test_a_crash_between_archive_and_truncate_loses_and_doubles_nothing(monkeypatch, crash_after_swap):
    lines = _write(MIXED)
    ledgerstore.rotate(config.LEDGER, now=NOW)  # an archive already exists, so the crash run must not append to it twice
    late = (json.dumps(_row("s3", "2026-09-30T23:59:59+00:00")) + "\n").encode()
    with config.LEDGER.open("ab") as f:
        f.write(late)
    expected = Counter([*lines, late])

    real = ledgerstore._replace_with_retry

    def crash(src, dst):
        if crash_after_swap:
            real(src, dst)  # the live file was already replaced; only the journal's delete is lost
        raise RuntimeError("power cut")

    monkeypatch.setattr(ledgerstore, "_replace_with_retry", crash)
    with pytest.raises(RuntimeError):
        ledgerstore.rotate(config.LEDGER, now=NOW)
    monkeypatch.setattr(ledgerstore, "_replace_with_retry", real)
    assert ledgerstore._journal(config.LEDGER).exists()
    if not crash_after_swap:
        assert _everything()[late] == 2  # the window the next rotation closes: archive written, live not yet cut

    # More lines land while the swap is half done, then rotation runs again (any append does it).
    more = (json.dumps(_row("s4", "2026-09-29T00:00:00+00:00")) + "\n").encode()
    with config.LEDGER.open("ab") as f:
        f.write(more)
    ledgerstore.rotate(config.LEDGER, now=NOW)
    expected[more] += 1
    assert _everything() == expected  # every line once: none lost, none doubled
    assert _live_lines() == lines[3:]
    assert not ledgerstore._journal(config.LEDGER).exists()


def test_a_live_file_that_is_neither_before_nor_after_is_left_alone():
    _write(MIXED)
    ledgerstore._journal(config.LEDGER).write_text(
        json.dumps({"old_len": 5, "old_sha": "x", "keep_len": 3, "keep_sha": "y", "n": {}}), encoding="utf-8")
    assert ledgerstore.rotate(config.LEDGER, now=NOW) == {}
    assert len(_live_lines()) == len(MIXED) and not ledgerstore.archives(config.LEDGER)


def test_append_rotates_when_the_month_changed(monkeypatch):
    lines = _write(MIXED)
    monkeypatch.setattr(ledgerstore, "_now_month", lambda now=None: "202610")
    monkeypatch.setitem(ledgerstore._state, "checked", None)
    ledger.append_row(_row("new", "2026-10-03T09:00:00+00:00"))
    assert _archive("202609") == lines[1:3]
    assert [json.loads(x)["task"] for x in _live_lines()] == ["o1", "o2", "new"]


def test_readers_report_the_same_totals_before_and_after_a_rotation():
    now = dt.datetime.now(dt.timezone.utc)
    this_month = now.strftime("%Y%m")
    rows = []
    for i, days in enumerate((75, 50, 40, 35, 20, 3, 1, 0)):
        ts = (now - dt.timedelta(days=days, hours=1)).isoformat(timespec="seconds")
        rows.append(_row(f"t{i}", ts, cost=0.01 * (i + 1), model="a" if i % 2 else "b"))
    _write(rows)
    unrotated = [r for r in rows if ledgerstore.month_of(r["ts"]) == this_month]
    assert len(unrotated) < len(rows)  # something is a finished month

    def totals():
        stats = model_stats.compute(60, config.LEDGER, config.HOME / "none.jsonl", now=now)
        summ = ledger.ledger_summary(60)
        daily = ledger.daily(60)
        return (
            sorted((m["model"], m["tasks"], m["cost_usd"], m["seconds"], m["tokens"]) for m in stats["models"]),
            stats["daily"],
            summ,
            [(d["date"], d["tasks"], d["cost_usd"]) for d in daily],
            ledger.today_spend(),
            ledger.usage_report(60 * 24.0)["swarm"]["cost_usd"],
        )

    before = totals()
    moved = ledgerstore.rotate(config.LEDGER)
    assert moved and sum(moved.values()) == len(rows) - len(unrotated)
    assert len(_live_lines()) == len(unrotated)
    assert totals() == before
    assert model_stats.model_stats(60)["models"] == model_stats.compute(60, config.LEDGER, config.HOME / "survival.jsonl")["models"]


def test_gzip_archives_are_plain_gzip_any_reader_opens():
    _write(MIXED)
    ledgerstore.rotate(config.LEDGER, now=NOW)
    path = ledgerstore.archive_path(config.LEDGER, "202609")
    assert path.name == "ledger-202609.jsonl.gz"
    with gzip.open(path, "rt", encoding="utf-8") as f:
        assert [json.loads(x)["task"] for x in f] == ["s1", "s2"]
    assert not list(Path(path.parent).glob("*.tmp"))
