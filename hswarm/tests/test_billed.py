"""Offline: a free-tier key's call is written billed=false and stays out of spent_usd; old lines are unknown."""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hswarm import config, ledger  # noqa: E402


def _res(model: str) -> SimpleNamespace:
    return SimpleNamespace(model=model, failover=[], escalation=None)


def test_free_call_is_billed_false_and_not_spent(tmp_path, monkeypatch):
    free = "gemini-3.8-flash"
    assert ledger.billed_fields(_res(free)) == {"billed": False}
    assert ledger.billed_fields(_res("no-such-model")) == {}  # unknown stays absent, never guessed

    monkeypatch.setattr(config, "LEDGER", tmp_path / "ledger.jsonl")
    ts = dt.datetime.now(dt.timezone.utc).isoformat()
    base = {"ts": ts, "job": "j", "status": "ok", "tokens": 1}
    ledger.append_row({**base, "task": "free", "cost_usd": 1.0, **ledger.billed_fields(_res(free))})
    ledger.append_row({**base, "task": "paid", "cost_usd": 2.0, "billed": True})
    ledger.append_row({**base, "task": "old", "cost_usd": 4.0})  # written before the field existed

    rows = [json.loads(line) for line in config.LEDGER.read_text(encoding="utf-8").splitlines()]
    assert rows[0]["billed"] is False and "billed" not in rows[2]

    today = ledger.daily(2)[-1]
    assert (today["spent_usd"], today["free_usd"], today["unknown_usd"], today["value_usd"]) == (2.0, 1.0, 4.0, 7.0)
