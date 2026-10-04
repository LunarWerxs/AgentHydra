"""The three scanners must agree, and the threaded arms must agree with the serial ones.

The fixture carries the shape that broke them (found by the A/B on 2026-09-17): a transcript that replays
one request id TWICE - first with a timestamp OUTSIDE the window, then inside it. The serial arms drop the
first (it never claims the id) and count the second; the parallel arms used to dedupe per file BEFORE the
window test, so the first claimed the id and the real record vanished - deterministically, 3 requests and
$1.83 of a real day. Skipped when the native binaries are not built.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hswarm import claude_usage, native  # noqa: E402

DAY = dt.date(2026, 9, 16)
OUTSIDE = DAY - dt.timedelta(30)


def _ts(day: dt.date) -> str:
    return dt.datetime.combine(day, dt.time(12)).astimezone().astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _req(rid: str, day: dt.date, model: str = "claude-sonnet-5", **usage) -> str:
    u = {"input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0} | usage
    return json.dumps({"requestId": rid, "timestamp": _ts(day), "type": "assistant", "message": {"model": model, "usage": u}}) + "\n"


@pytest.fixture
def tree(tmp_path):
    """Enough files that a threaded run really uses its workers, with the replay shape in the middle."""
    root = tmp_path / "projects" / "proj"
    (root / "sess-replay" / "subagents").mkdir(parents=True)
    (root / "sess-replay.jsonl").write_text(
        _req("shared-1", OUTSIDE, output_tokens=1000) + _req("shared-1", DAY, output_tokens=1000)
        + _req("own-1", DAY, input_tokens=500), encoding="utf-8")
    (root / "sess-replay" / "subagents" / "agent-a.jsonl").write_text(_req("sub-1", DAY, output_tokens=200), encoding="utf-8")
    for i in range(8):
        (root / f"sess-{i}.jsonl").write_text(_req(f"r{i}", DAY, input_tokens=100 + i, cache_read_input_tokens=1000), encoding="utf-8")
    return tmp_path / "projects"


def _shape(days: dict) -> dict:
    """Only what every arm must agree on, rounded the way native.py rounds."""
    return {day: {"requests": d["requests"], "claude_usd": round(d["claude_usd"], 4), "tokens": d["tokens"],
                  "by_session": {s: (v["requests"], round(v["usd"], 4), v["tokens"]) for s, v in d["by_session"].items()},
                  "by_model": {m: (v["requests"], v["tokens"]) for m, v in d["by_model"].items()}}
            for day, d in days.items()}


def test_every_arm_agrees_including_the_threaded_ones(tree):
    want = _shape(claude_usage.collect_python(DAY, DAY, tree))
    assert want[DAY.isoformat()]["requests"] == 11  # 8 plain + own-1 + the replayed id once + the sub-agent's
    # That session's own two requests plus its sub-agent's: a sub-agent's usage belongs to the session that spawned it.
    assert want[DAY.isoformat()]["by_session"]["sess-replay"][0] == 3
    ran = 0
    for lang in native.LANGS:
        if native.binary(lang) is None:
            continue
        for threads in (1, 8):
            got = _shape(native.scan(lang, tree, DAY, DAY, threads)["days"])
            assert got == want, f"{lang}@{threads} disagrees with Python"
            ran += 1
    if not ran:
        pytest.skip("no native scanner built: run `hswarm native build`")


def test_a_streamed_request_counts_at_its_fullest_line_in_every_arm(tmp_path):
    """A streamed reply is several lines with one requestId; the first carries a placeholder output_tokens. Every arm
    bills the largest, from the earliest file that has the request, and none counts a later replay."""
    root = tmp_path / "projects" / "proj"
    (root / "sess" / "subagents").mkdir(parents=True)
    (root / "sess.jsonl").write_text(_req("s0", DAY, output_tokens=40), encoding="utf-8")
    (root / "sess" / "subagents" / "agent-a.jsonl").write_text(
        _req("s0", DAY, output_tokens=40_000)  # a replay of the parent's request: ignored
        + _req("s1", DAY, output_tokens=8) + _req("s2", DAY, output_tokens=500) + _req("s1", DAY, output_tokens=1_000)
        + _req("s2", DAY, output_tokens=2), encoding="utf-8")
    tree = tmp_path / "projects"
    want = _shape(claude_usage.collect_python(DAY, DAY, tree))
    assert want[DAY.isoformat()]["tokens"]["output"] == 40 + 1_000 + 500
    for lang in native.LANGS:
        if native.binary(lang) is None:
            continue
        for threads in (1, 4):
            assert _shape(native.scan(lang, tree, DAY, DAY, threads)["days"]) == want, f"{lang}@{threads} disagrees with Python"
