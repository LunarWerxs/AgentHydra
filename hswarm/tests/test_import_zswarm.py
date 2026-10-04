"""Offline: `hswarm import-zswarm` on temp homes (never the real ones)."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from hswarm import import_zswarm, utilization  # noqa: E402
from hswarm.cli import main  # noqa: E402


def _row(task: str, ts: str) -> str:
    return json.dumps({"ts": ts, "job": "j1", "task": task, "backend": "api", "status": "ok", "cost_usd": 0.01})


def _zswarm(home: Path) -> None:
    home.mkdir()
    db = sqlite3.connect(home / "zswarm.sqlite")
    db.executescript(utilization.SCHEMA)
    db.execute("INSERT INTO utilizations (id, ts, kind, machine, tasks) VALUES ('u1', '2026-09-01T00:00:00+00:00', 'job', 'm', 3)")
    db.execute("INSERT INTO profiles (id, ts, machine, sample) VALUES ('p1', '2026-09-01T00:00:00+00:00', 'm', 5)")
    db.execute("INSERT INTO claude_days (machine, day, claude_usd) VALUES ('m', '2026-09-01', 1.5)")
    db.execute("INSERT INTO claude_accounts (machine, day, account, usd) VALUES ('m', '2026-09-01', 'a', 0.5)")
    db.commit()
    db.close()
    (home / "ledger.jsonl").write_text("\n".join(_row(f"t{i}", f"2026-09-01T00:00:0{i}+00:00") for i in (1, 2, 3)) + "\n")
    (home / "survival.jsonl").write_text(json.dumps({"ts": "2026-09-01T00:00:00+00:00", "job": "j1", "task": "t1"}) + "\n")
    (home / "routing.jsonl").write_text(json.dumps({"ts": "2026-09-01T00:00:00+00:00", "tool": "Workflow"}) + "\n")
    (home / "savings-daily.jsonl").write_text(json.dumps({"day": "2026-09-01", "zswarm_tasks": 3}) + "\n")
    job = home / "jobs" / "20260901-000000-aaaa"
    job.mkdir(parents=True)
    (job / "job.json").write_text("{}")
    (job / "keys.json").write_text("SECRET")
    (home / "history" / "jobs").mkdir(parents=True)
    (home / "history" / "jobs" / "20260901.json").write_text("{}")
    (home / "history" / "spill").mkdir()
    (home / "history" / "spill" / "x").write_text("SECRET")
    for name in ("keys.json", "console-token", "vault-request.key", "egress.jsonl"):
        (home / name).write_text("SECRET")
    (home / "secrets").mkdir()
    (home / "secrets" / "k_api_keys").write_text("SECRET")


def _snapshot(home: Path) -> dict[str, bytes]:
    return {str(p.relative_to(home)): p.read_bytes() for p in sorted(home.rglob("*")) if p.is_file()}


def _count(out: dict) -> dict:
    flat = {k: v for k, v in out.items() if k != "sqlite"} | {f"sqlite.{t}": v for t, v in out["sqlite"].items()}
    return {k: (v["read"], v["added"], v["already_there"]) for k, v in flat.items()}


def test_import_is_a_one_shot_dedupes_and_never_copies_secrets(tmp_path):
    src, dest = tmp_path / "z", tmp_path / "h"
    _zswarm(src)
    dest.mkdir()
    (dest / "ledger.jsonl").write_text(_row("t2", "2026-09-01T00:00:02+00:00") + "\n" + _row("own", "2026-09-01T00:00:09+00:00") + "\n")

    first = import_zswarm.run(src, dest)
    assert first["ledger.jsonl"] == {"read": 3, "added": 2, "already_there": 1}  # t2 was already there
    lines = (dest / "ledger.jsonl").read_text().splitlines()
    assert sorted(json.loads(x)["task"] for x in lines) == ["own", "t1", "t2", "t3"]
    assert [json.loads(x)["ts"] for x in lines] == sorted(json.loads(x)["ts"] for x in lines)  # still in time order
    assert first["sqlite"]["utilizations"]["added"] == 1 and first["jobs"]["added"] == 1 and first["history"]["added"] == 1
    assert json.loads((dest / "savings-daily.jsonl").read_text())["hswarm_tasks"] == 3
    c = sqlite3.connect(dest / "hswarm.sqlite")
    assert c.execute("SELECT tasks FROM utilizations WHERE id='u1'").fetchone() == (3,)
    c.close()

    # A one-shot: the first real run records that it ran; later runs read nothing and write nothing.
    with (src / "ledger.jsonl").open("a") as f:
        f.write(_row("t4", "2026-09-01T00:00:10+00:00") + "\n")
    before = _snapshot(dest)
    second = import_zswarm.run(src, dest)
    assert list(second) == ["already_ran"]
    assert _snapshot(dest) == before
    assert "one-shot" in import_zswarm.summary_line(second)

    names = {p.name for p in dest.rglob("*")}
    assert not names & {"keys.json", "console-token", "vault-request.key", "egress.jsonl", "secrets", "k_api_keys", "spill", "x"}
    assert "SECRET" not in b"".join(_snapshot(dest).values()).decode("utf-8", "ignore")


def test_dry_run_changes_nothing_and_cli_prints_json(tmp_path, monkeypatch, capsys):
    src, dest = tmp_path / "z", tmp_path / "h"
    _zswarm(src)
    dest.mkdir()
    (dest / "ledger.jsonl").write_text(_row("own", "2026-09-01T00:00:09+00:00") + "\n")
    before = _snapshot(dest)
    from hswarm import config

    monkeypatch.setattr(config, "HOME", dest)
    assert main(["import-zswarm", "--from", str(src), "--dry-run", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["dry_run"] is True and out["counts"]["ledger.jsonl"] == {"read": 3, "added": 3, "already_there": 0}
    assert _snapshot(dest) == before
