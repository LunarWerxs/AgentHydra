"""The cost ledger (~/.hswarm/ledger.jsonl, one line per finished task), the usage report that
groups it by WHO asked (plus the routing gate's record of Claude fan-outs), and the argument
parser every batch tool starts from."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import threading

from . import config, survival
from .caller import ledger_fields


def append_row(row: dict) -> None:
    """One ledger line. Disk errors never fail the call that produced the row."""
    try:
        config.LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with config.LEDGER.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def ask_row(res, caller: dict | None) -> dict:
    """The ledger line for a one-shot hswarm_ask, so asks are attributed and costed like jobs."""
    return {
        "ts": res.finished or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "job": "ask", "task": res.id,
        "backend": res.backend, "model": res.model, "provider": _provider(res.model), "status": res.status, "calls": max(1, res.turns), **res.usage,
        "cost_usd": res.cost_usd, "seconds": res.seconds, "peak": config.is_peak(),
        "upstream": ",".join(getattr(res, "upstream", []) or []) or None, "api_seconds": getattr(res, "api_seconds", 0.0),
        "failover": ",".join(getattr(res, "failover", []) or []) or None, "taint": getattr(res, "taint", "") or None, **ledger_fields(caller),
    }


def _provider(model: str) -> str:
    try:
        return config.provider_of(model)
    except (ValueError, KeyError):
        return ""


def ledger_rows(days: float) -> list[dict]:
    """Rows newer than `days` ago; a malformed line is skipped, never fatal. A task whose edits have been
    scored carries its newest score as `survival` (survival.py): the ledger file itself stays append-only."""
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    rows = []
    if config.LEDGER.exists():
        with config.LEDGER.open("rb") as f:
            f.seek(_window_start(f, since))
            for line in f:
                try:
                    r = json.loads(line)
                    if dt.datetime.fromisoformat(r["ts"]) >= since:
                        rows.append(r)
                except (ValueError, KeyError):
                    continue
    scores = survival.latest() if rows else {}
    for r in rows:
        if (s := scores.get((r.get("job"), r.get("task")))) is not None:
            r["survival"] = s
    return rows


def _window_start(f, since: dt.datetime) -> int:
    """Where the rows newer than `since` begin, found from the ledger's END the way today_spend walks it: a block at a
    time until a row an hour older than `since` shows up (parallel writers land a little out of order). A 1-day
    usage read parsed every one of 197k rows (114 MB, 1-2 s on the shared server) until 2026-09-29."""
    stop = since - dt.timedelta(hours=1)
    carry = b""
    pos = f.seek(0, os.SEEK_END)
    while pos > 0:
        step = min(1 << 20, pos)
        pos -= step
        f.seek(pos)
        lines = (f.read(step) + carry).split(b"\n")
        carry = lines.pop(0) if pos > 0 else b""  # cut mid-line: joined to the block before it on the next read
        for line in lines:
            try:
                if dt.datetime.fromisoformat(json.loads(line)["ts"]) < stop:
                    return pos + len(carry) + 1 if pos > 0 else 0  # the block's first whole line
            except (ValueError, KeyError, TypeError):
                continue
    return 0


_DAILY: dict = {"path": None, "offset": 0, "days": {}}
_DAILY_LOCK = threading.Lock()  # the console reads it off the event loop; two reads must not fold one line twice


def daily(days: int = 14) -> list[dict]:
    """Spend and task outcomes per LOCAL day (a person reads days on their own clock), newest last, for the console's
    charts. The ledger is append-only and runs to ~100 MB, so it is parsed once per process, a line at a time, and
    afterwards only the bytes appended since the last call are read; a file that shrank or moved is parsed again."""
    path = config.LEDGER
    with _DAILY_LOCK:
        size = path.stat().st_size if path.exists() else 0
        if _DAILY["path"] != str(path) or size < _DAILY["offset"]:
            _DAILY.update(path=str(path), offset=0, days={})
        if size > _DAILY["offset"]:
            with path.open("rb") as f:
                f.seek(_DAILY["offset"])
                for line in f:
                    if not line.endswith(b"\n"):
                        break  # a line still being written is read next time, whole
                    _DAILY["offset"] += len(line)
                    _fold_day(line)
        today = dt.datetime.now().astimezone().date()
        wanted = [(today - dt.timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
        empty = {"tasks": 0, "ok": 0, "error": 0, "cost_usd": 0.0, "providers": {}, "models": {}}
        return [{"date": d, **_DAILY["days"].get(d, empty)} for d in wanted]


def today_spend() -> float:
    """Today's (local) spend, read from the ledger's END: it is append-only and in time order, so the read walks back
    a block at a time until it passes local midnight, never the whole file (a CLI run checks the cap on every submit,
    and the whole 87 MB took 1.3 s). Rows from parallel writers land a little out of order: an hour of slack."""
    midnight = dt.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    stop = midnight - dt.timedelta(hours=1)
    spent, carry = 0.0, b""
    try:
        f = config.LEDGER.open("rb")
    except OSError:
        return 0.0
    with f:
        pos = f.seek(0, os.SEEK_END)
        while pos > 0:
            step = min(1 << 20, pos)
            pos -= step
            f.seek(pos)
            lines = (f.read(step) + carry).split(b"\n")
            carry = lines.pop(0) if pos > 0 else b""  # cut mid-line: joined to the block before it on the next read
            past = False
            for line in lines:
                try:
                    r = json.loads(line)
                    at = dt.datetime.fromisoformat(r["ts"])
                    past = past or at < stop
                    if at >= midnight and not r.get("cached"):
                        spent += float(r.get("cost_usd") or 0.0)
                except (ValueError, KeyError, TypeError):
                    continue
            if past:
                break
    return round(spent, 6)


def over_daily_cap() -> str | None:
    """The refusal for new work once today's spend reached the daily cap (config.DAILY_CAP_USD), else None."""
    cap = config.DAILY_CAP_USD
    if cap is None:
        return None
    spent = today_spend()
    if spent < cap:
        return None
    return (f"DailyCapReached: today's spend ${spent:.2f} reached this machine's daily cap of ${cap:.2f}; raise or clear "
            f"it in hswarm ui (Routing & roles) or as daily_cap_usd in {config.SETTINGS_FILE}, or wait until tomorrow")


def _fold_day(line: bytes) -> None:
    try:
        r = json.loads(line)
        day = dt.datetime.fromisoformat(r["ts"]).astimezone().date().isoformat()
    except (ValueError, KeyError, TypeError):
        return
    if r.get("cached"):
        return  # an answer a resume reused: no call, no spend
    b = _DAILY["days"].setdefault(day, {"tasks": 0, "ok": 0, "error": 0, "cost_usd": 0.0, "providers": {}, "models": {}})
    b["tasks"] += 1
    outcome = "ok" if r.get("status") == "ok" else "error"
    b[outcome] += 1
    cost = r.get("cost_usd") or 0.0
    b["cost_usd"] = round(b["cost_usd"] + cost, 6)
    who = r.get("provider") or "other"
    b["providers"][who] = round(b["providers"].get(who, 0.0) + cost, 6)
    # Per model too, for the console's provider and model pages: [tasks, ok, failed, cost, seconds].
    m = b["models"].setdefault(str(r.get("model") or "other"), [0, 0, 0, 0.0, 0.0])
    m[0] += 1
    m[1 if outcome == "ok" else 2] += 1
    m[3] = round(m[3] + cost, 6)
    m[4] = round(m[4] + float(r.get("seconds") or 0.0), 3)


def ledger_summary(days: float = 1.0) -> dict:
    rows = ledger_rows(days)
    # A `cached` line is an answer a resume reused (no call, no spend): counting it would count one task twice.
    cached = sum(1 for r in rows if r.get("cached"))
    rows = [r for r in rows if not r.get("cached")]
    total = 0.0
    unknown = 0
    by_model: dict[str, dict] = {}
    by_backend: dict[str, dict] = {}
    by_status: dict[str, int] = {}
    kept: dict[str, list[dict]] = {}
    tok = {"in_hit": 0, "in_miss": 0, "out": 0, "reasoning": 0}
    for r in rows:
        c = r.get("cost_usd")
        if c is None:
            unknown += 1  # a backend without usage data reports None, which is "not measured", never zero
        else:
            total += c
        for k in tok:
            if isinstance(r.get(k), int):
                tok[k] += r[k]
        for key, bucket in ((r.get("model", "?"), by_model), (r.get("backend", "?"), by_backend)):
            b = bucket.setdefault(key, {"tasks": 0, "cost_usd": 0.0})
            b["tasks"] += 1
            b["cost_usd"] = round(b["cost_usd"] + (c or 0.0), 6)
        by_status[r.get("status", "?")] = by_status.get(r.get("status", "?"), 0) + 1
        if r.get("survival"):
            kept.setdefault(r.get("model", "?"), []).append(r["survival"])
    # Whether each model's edits were kept, beside what it cost: a model that finishes cheaply but whose
    # code is reverted is not the bargain its cost line says.
    for model, scores in kept.items():
        by_model[model]["survival"] = survival.mean(scores)
    nxt, state = config.next_rate_change()
    return {
        "window_days": days, "tasks": len(rows), "cached_tasks": cached, "cost_usd": round(total, 6), "cost_unknown_tasks": unknown, "tokens": tok,
        "by_model": by_model, "by_backend": by_backend, "by_status": by_status,
        "rate_now": "peak" if config.is_peak() else "off-peak (50% off)",
        "next_rate_change_utc": nxt.isoformat(timespec="minutes"), "next_rate_state": state, "ledger": str(config.LEDGER),
    }


def routing_rows(hours: float) -> list[dict]:
    """The routing gate's decisions newer than `hours` ago (Claude sub-agent calls it saw), oldest first."""
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    rows = []
    if config.ROUTING.exists():
        with config.ROUTING.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if dt.datetime.fromisoformat(r["ts"]) >= since:
                        rows.append(r)
                except (ValueError, KeyError):
                    continue
    return rows


def _job_label(job_id: str, cache: dict) -> str:
    if job_id not in cache:
        label = ""
        p = config.JOBS_DIR / job_id / "job.json"
        if p.exists():
            try:
                label = str(json.loads(p.read_text(encoding="utf-8")).get("summary", {}).get("label") or "")
            except (ValueError, OSError):
                label = ""
        cache[job_id] = label
    return cache[job_id]


def _group_seed(k: tuple, inst: str, sess: str, cwd: str, ts: str) -> dict:
    """An empty tally for one caller: the key it was grouped under and its first and last sighting."""
    return {"caller": " / ".join(k), "instance": inst, "session": sess, "cwd": cwd, "stamped": bool(inst or sess or cwd),
            "jobs": set(), "labels": set(), "tasks": 0, "ok": 0, "error": 0, "timeout": 0, "loop": 0, "cancelled": 0, "asks": 0,
            "cost_usd": 0.0, "first": ts, "last": ts}


def _add_to_group(g: dict, r: dict, labels: dict[str, str]) -> None:
    """Fold one ledger line into its caller's tally."""
    job = str(r.get("job") or "")
    if job == "ask":
        g["asks"] += 1
    else:
        g["jobs"].add(job)
        lbl = _job_label(job, labels)
        if lbl:
            g["labels"].add(lbl)
    g["tasks"] += 1
    st = r.get("status") or "?"
    if st in g:
        g[st] += 1
    g["cost_usd"] += float(r.get("cost_usd") or 0.0)
    g["first"], g["last"] = min(g["first"], r["ts"]), max(g["last"], r["ts"])


def _caller_groups(rows: list[dict]) -> list[dict]:
    """Every ledger line folded into its caller stamp (account instance / session / working folder), the biggest
    spender first. Lines written before the stamp existed land under one "unstamped" row, never guessed at."""
    labels: dict[str, str] = {}
    groups: dict[tuple, dict] = {}
    for r in rows:
        inst, sess, cwd = r.get("caller_instance") or "", r.get("caller_session") or "", r.get("caller_cwd") or ""
        k = (inst or "-", sess or "-", os.path.basename(cwd.rstrip("\\/")) or "-")
        _add_to_group(groups.setdefault(k, _group_seed(k, inst, sess, cwd, r["ts"])), r, labels)
    callers = []
    for g in sorted(groups.values(), key=lambda g: -g["cost_usd"]):
        g["jobs"] = len(g["jobs"])
        g["labels"] = sorted(g["labels"])[:12]
        g["cost_usd"] = round(g["cost_usd"], 4)
        callers.append(g)
    return callers


def _fanouts(routing: list[dict]) -> dict:
    """The Claude side of the report: what the gate decided, one row per session it saw, and the fan-outs that
    matched the mechanical rule and went to Claude anyway."""
    decisions = {"blocked": 0, "allowed": 0, "reminded": 0}
    for r in routing:
        decisions[r.get("decision", "allowed")] = decisions.get(r.get("decision", "allowed"), 0) + 1
    mech_claude = [
        {k: r.get(k, "") for k in ("ts", "instance", "session_id", "cwd", "tool", "model", "agents", "mechanical", "reason")}
        for r in routing if r.get("decision") != "blocked" and r.get("mechanical")
    ]
    by_session: dict[str, dict] = {}
    for r in routing:
        s = (r.get("session_id") or "")[:8] or "-"
        b = by_session.setdefault(s, {"instance": r.get("instance", ""), "cwd": r.get("cwd", ""), "calls": 0, "blocked": 0, "allowed": 0, "agents": 0})
        b["calls"] += 1
        b["blocked" if r.get("decision") == "blocked" else "allowed"] += 1
        if r.get("decision") != "blocked":
            b["agents"] += int(r.get("agents") or 1)
    return {"decisions": len(routing), **decisions, "by_session": by_session, "mechanical_but_claude": mech_claude}


def usage_report(hours: float = 24.0) -> dict:
    """WHO used the swarm in the last N hours, and which Claude fan-outs the routing gate saw instead.

    Groups every ledger line by its caller stamp (account instance / session / working folder); lines written
    before the stamp existed land under one "unstamped" row rather than being guessed at. The Claude side comes
    from the routing gate's log: every Agent/Workflow decision, with the mechanical-rule matches called out.
    """
    rows = ledger_rows(hours / 24.0)
    cached = sum(1 for r in rows if r.get("cached"))  # answers a resume reused: already counted where they ran
    rows = [r for r in rows if not r.get("cached")]
    routing = routing_rows(hours)
    return {
        "window_hours": hours,
        "swarm": {"tasks": len(rows), "cached_tasks": cached, "cost_usd": round(sum(float(r.get("cost_usd") or 0.0) for r in rows), 4), "callers": _caller_groups(rows), "ledger": str(config.LEDGER)},
        "claude_fanouts": {**_fanouts(routing), "log": str(config.ROUTING)},
    }


def batch_argparser(prog: str, doc: str | None, concurrency: int = 64) -> argparse.ArgumentParser:
    """The argument parser every batch tool (distill, triage, indexdiet) starts from: --model and --concurrency."""
    ap = argparse.ArgumentParser(prog=prog, description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=config.DEFAULT_MODEL)
    ap.add_argument("--concurrency", type=int, default=concurrency)
    return ap
