"""Every use of the swarm, costed and compared: one row per hswarm_run job and per hswarm_ask in a
small SQLite database (~/.hswarm/hswarm.sqlite), with what the same work would have cost as Claude
sub-agents on the ORCHESTRATOR's model at the time it asked, and a running total across every
machine (owner ask, Michael, 2026-09-15 evening).

The estimate is measured, never assumed. A sub-agent PROFILE is the median token buckets of one real
Claude sub-agent on this machine over the last 14 recorded days (Sonnet ones when there are enough),
priced at Anthropic's list rate for the model the calling session was running, read from its own
transcript at submit time (caller.py). One ANSWERED hswarm task stands in for one sub-agent, so `est_usd` is
ok tasks x that price and `est_low_usd` is one sub-agent for the whole job; `saved_usd` is the estimate
minus what DeepSeek charged. A row written before any profile exists carries no estimate ('-', not
zero) and is priced when the first profile lands; after that a row is never re-priced, so history keeps
the numbers of its day. A caller whose model is unknown (a CLI run) is priced at the Sonnet floor,
the cheapest a sub-agent is allowed to be, and the row's `basis` says so.

Sync: the DB stays machine-local; what travels is one shard per machine, `<machine>.jsonl`, on the
`sync` branch of this repo, checked out as a worktree under ~/.hswarm/sync-tree so the code checkout is
never touched. Two machines never write the same file, so nothing ever conflicts. `hswarm sync` pulls,
imports the other shards, exports this one, regenerates TOTALS.md (the fleet running total, readable
on GitHub) and pushes; the daily savings task does the same.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import platform
import secrets
import sqlite3
import statistics
import subprocess
from pathlib import Path

from . import claude_usage, config
from .savings_view import usd

REPO = Path(__file__).resolve().parent.parent
SYNC_BRANCH = "sync"
MACHINE = (os.environ.get("HSWARM_MACHINE") or platform.node() or "unknown").lower()
FLOOR_MODEL = "claude-sonnet-5"
POOL_DAYS = 14
MIN_POOL = 5
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

COLUMNS = ("id", "ts", "kind", "machine", "caller_instance", "caller_session", "caller_cwd", "caller_account", "label", "orchestrator_model",
           "backend", "worker_model", "tasks", "ok", "failed", "seconds", "worker_usd", "worker_tokens",
           "est_model", "per_agent_usd", "est_usd", "est_low_usd", "saved_usd", "saved_low_usd", "basis", "profile_id", "seq")
PROFILE_COLUMNS = ("id", "ts", "machine", "basis", "sample", "pool_days", "input", "cache_read", "cache_5m", "cache_1h", "output", "requests")
SCHEMA = """
CREATE TABLE IF NOT EXISTS utilizations (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, machine TEXT NOT NULL,
  caller_instance TEXT, caller_session TEXT, caller_cwd TEXT, label TEXT, orchestrator_model TEXT,
  backend TEXT, worker_model TEXT, tasks INTEGER, ok INTEGER, failed INTEGER, seconds REAL, worker_usd REAL, worker_tokens INTEGER,
  est_model TEXT, per_agent_usd REAL, est_usd REAL, est_low_usd REAL, saved_usd REAL, saved_low_usd REAL, basis TEXT, profile_id TEXT
);
CREATE INDEX IF NOT EXISTS utilizations_ts ON utilizations(ts);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, ts TEXT, machine TEXT, basis TEXT, sample INTEGER, pool_days INTEGER,
  input INTEGER, cache_read INTEGER, cache_5m INTEGER, cache_1h INTEGER, output INTEGER, requests INTEGER
);
CREATE TABLE IF NOT EXISTS claude_days (
  machine TEXT NOT NULL, day TEXT NOT NULL, claude_usd REAL, sub_usd REAL, subagents INTEGER, partial INTEGER DEFAULT 0,
  by_model TEXT, rules TEXT, tokens TEXT, plan_usd REAL,
  PRIMARY KEY (machine, day)
);
CREATE TABLE IF NOT EXISTS claude_accounts (
  machine TEXT NOT NULL, day TEXT NOT NULL, account TEXT NOT NULL, tier TEXT, usd REAL, requests INTEGER, sessions INTEGER,
  tokens TEXT, plan_usd REAL,
  PRIMARY KEY (machine, day, account)
);
"""
CLAUDE_DAY_COLUMNS = ("machine", "day", "claude_usd", "sub_usd", "subagents", "partial", "by_model", "rules", "tokens", "plan_usd")
CLAUDE_ACCOUNT_COLUMNS = ("machine", "day", "account", "tier", "usd", "requests", "sessions", "tokens", "plan_usd")
TOKEN_KEYS = claude_usage.TOKEN_KEYS
NOTE = ("One hswarm task = one Claude sub-agent, priced at the calling session's model at the time (Sonnet floor when "
        "unknown), sized by the measured median sub-agent on that machine (cache reads and writes priced at their own rates). "
        "saved = estimate - DeepSeek, in Anthropic list-price dollars: on a subscription that is quota kept, not money. "
        "share = estimate / (estimate + the Claude work actually done on that machine the same days). '-' = not measured.")


def db_path() -> Path:
    return config.HOME / "hswarm.sqlite"


def sync_dir() -> Path:
    return config.HOME / "sync-tree"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def log(message: str) -> None:
    try:
        config.HOME.mkdir(parents=True, exist_ok=True)
        with (config.HOME / "utilization.log").open("a", encoding="utf-8") as f:
            f.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {message}\n")
    except OSError:
        pass


def connect() -> sqlite3.Connection:
    config.HOME.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(db_path(), timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")  # one MCP server per Claude session: several writers, never a lock error
    c.executescript(SCHEMA)
    _migrate(c)
    return c


def _migrate(c: sqlite3.Connection) -> None:
    """Run numbers (Michael, 2026-09-16: "number each run so I can refer to one"): `seq` counts up per machine in
    time order and never changes, so "run 196" means the same row next month. Added to DBs from before it."""
    cols = {r[1] for r in c.execute("PRAGMA table_info(utilizations)")}
    if "seq" not in cols:
        c.execute("ALTER TABLE utilizations ADD COLUMN seq INTEGER")
    if "caller_account" not in cols:  # Michael, 2026-09-17: which ACCOUNT ordered this run, by its stable hashed id
        c.execute("ALTER TABLE utilizations ADD COLUMN caller_account TEXT")
    day_cols = {r[1] for r in c.execute("PRAGMA table_info(claude_days)")}
    for col in ("by_model", "rules"):  # Michael, 2026-09-16: which models did the Claude work, and were the rulings followed
        if col not in day_cols:
            c.execute(f"ALTER TABLE claude_days ADD COLUMN {col} TEXT")
    if "tokens" not in day_cols:  # the day's own token buckets: the page's token view, beside the dollar one
        c.execute("ALTER TABLE claude_days ADD COLUMN tokens TEXT")
    if "plan_usd" not in day_cols:  # what the accounts that worked that day cost that day
        c.execute("ALTER TABLE claude_days ADD COLUMN plan_usd REAL")
    if c.execute("SELECT 1 FROM utilizations WHERE seq IS NULL LIMIT 1").fetchone():
        for (m,) in c.execute("SELECT DISTINCT machine FROM utilizations WHERE seq IS NULL").fetchall():
            n = c.execute("SELECT COALESCE(MAX(seq), 0) FROM utilizations WHERE machine = ?", (m,)).fetchone()[0]
            for (rid,) in c.execute("SELECT id FROM utilizations WHERE machine = ? AND seq IS NULL ORDER BY ts, id", (m,)).fetchall():
                n += 1
                c.execute("UPDATE utilizations SET seq = ? WHERE id = ?", (n, rid))
        c.commit()


def next_seq(c: sqlite3.Connection, row: dict) -> int:
    """The row's existing number when it is re-recorded, else the next one for its machine."""
    have = c.execute("SELECT seq FROM utilizations WHERE id = ?", (row["id"],)).fetchone()
    if have and have["seq"] is not None:
        return int(have["seq"])
    return int(c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM utilizations WHERE machine = ?", (row["machine"],)).fetchone()[0])


def short_model(model: str | None) -> str:
    return (model or "-").removeprefix("claude-")


def local_dt(ts: str) -> dt.datetime | None:
    """A stored UTC stamp as a local datetime; None when it cannot be parsed."""
    try:
        return dt.datetime.fromisoformat((ts or "").replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def local_min(ts: str) -> str:
    """A stored UTC stamp on the reader's clock, to the minute. Day buckets are local days, so every time a
    human reads is local too; only the stored value and the shared totals file stay UTC."""
    d = local_dt(ts)
    return d.strftime("%Y-%m-%d %H:%M") if d else (ts or "")[:16]


def how(row: dict) -> str:
    """The estimate in six words: '3 x sub-agent @ fable-5-1', with '(floor)' when the caller's model was not the one priced."""
    if row.get("est_usd") is None:
        return "unpriced"
    floored = (row.get("est_model") or "") != (row.get("orchestrator_model") or "")
    return f"{int(row.get('tasks') or 1)} x sub-agent @ {short_model(row.get('est_model'))}" + (" (floor)" if floored else "")


# ---- rows ---------------------------------------------------------------------------------------

def _mode(values: list[str]) -> str:
    return max(set(values), key=values.count) if values else ""


def caller_account(caller: dict | None) -> str:
    """The stable hashed id of the account that ordered a run: by its session first, by the instance folder it
    ran under otherwise (folder names are reused, so the session is the better key). "" when nothing knows it."""
    from . import accounts

    c = caller or {}
    sid = c.get("session_id") or ""
    res = accounts.resolver()
    if sid and sid not in res["by_session"]:  # a session started since the cache was read is not "unknown" yet
        res = accounts.resolver(fresh=True)
    found = accounts.of_session(sid, res) or accounts.of_instance(c.get("instance") or "", res)
    return found["account"] if found else ""


def _caller_fields(caller: dict | None) -> dict:
    c = caller or {}
    return {"caller_instance": c.get("instance") or "", "caller_session": (c.get("session_id") or c.get("chat_id") or "")[:8],
            "caller_cwd": c.get("cwd") or "", "orchestrator_model": c.get("model") or "", "caller_account": caller_account(c)}


def _tokens(usage: dict | None) -> int:
    """The three token counters a worker reports, summed: what it read, what it wrote, what came back."""
    return sum(int((usage or {}).get(k) or 0) for k in ("in_hit", "in_miss", "out"))


def _seconds_of(created: str, finished: str, results: list[dict]) -> float:
    """The job's wall clock from its two stamps; when either will not parse, the longest worker's own time."""
    try:
        return round((dt.datetime.fromisoformat(finished) - dt.datetime.fromisoformat(created)).total_seconds(), 3)
    except ValueError:
        return round(max((float(r.get("seconds") or 0.0) for r in results), default=0.0), 3)


def _build_row(job_id: str, created: str, finished: str, label: str, caller: dict | None, results: list[dict]) -> dict:
    """The utilization row of one finished job, from its plain result dicts (live Job or job.json alike)."""
    # An answer reused by a resume (jobs.resumable) was counted, and its saving claimed, by the job that ran it.
    results = [r for r in results if not r.get("cached_from")]
    ok = sum(1 for r in results if r.get("status") == "ok")
    return {
        "id": job_id, "ts": finished or now_iso(), "kind": "run", "machine": MACHINE, **_caller_fields(caller), "label": label or "",
        "backend": _mode([str(r.get("backend") or "") for r in results]), "worker_model": _mode([str(r.get("model") or "") for r in results]),
        "tasks": len(results), "ok": ok, "failed": len(results) - ok, "seconds": _seconds_of(created, finished, results),
        "worker_usd": round(sum(float(r.get("cost_usd") or 0.0) for r in results), 6),
        "worker_tokens": sum(_tokens(r.get("usage")) for r in results),
    }


def job_row(job) -> dict:
    return _build_row(job.id, job.created, job.finished, job.label, job.caller, [r.as_dict() for r in job.results.values()])


def ask_row(res, caller: dict | None) -> dict:
    """The utilization row of one hswarm_ask."""
    ts = res.finished or now_iso()
    return {
        "id": "ask-" + ts.replace(":", "").replace("+00:00", "Z") + "-" + secrets.token_hex(2), "ts": ts, "kind": "ask", "machine": MACHINE,
        **_caller_fields(caller), "label": (caller or {}).get("label") or "ask", "backend": res.backend, "worker_model": res.model,
        "tasks": 1, "ok": int(res.status == "ok"), "failed": int(res.status != "ok"), "seconds": res.seconds, "worker_usd": round(res.cost_usd or 0.0, 6),
        "worker_tokens": _tokens(res.usage),
    }


def estimate(row: dict, prof: dict | None) -> dict:
    """What `row` would have cost as Claude sub-agents on the caller's model, sized by `prof`; nothing without a profile."""
    empty = {k: None for k in ("est_model", "per_agent_usd", "est_usd", "est_low_usd", "saved_usd", "saved_low_usd", "profile_id")}
    if not prof:
        return empty | {"basis": "no sub-agent profile yet: `hswarm savings --record` (or --profile) prices this row once one is measured"}
    model = row.get("orchestrator_model") or ""
    est_model, why = (model, "the calling session's model") if model else (FLOOR_MODEL, "caller model unknown, priced at the Sonnet floor")
    per = claude_usage.price_tokens(est_model, prof)
    if per is None:
        est_model, why = FLOOR_MODEL, f"no list price for {model}, priced at the Sonnet floor"
        per = claude_usage.price_tokens(FLOOR_MODEL, prof) or 0.0
    tasks = max(1, int(row.get("tasks") or 1))
    # Only an ANSWERED task stood in for a sub-agent: a timeout or an error came back empty and its work was redone
    # on Claude, so it saved nothing and its spend is a loss. Measured 2026-09-24, job 20260924-234903-1c5b: 1 ok of
    # 24 reported "saved $17.64" while the work went to Opus. A row with no `ok` count (an old shard) is all answered.
    answered = min(tasks, int(row["ok"])) if row.get("ok") is not None else tasks
    worker = float(row.get("worker_usd") or 0.0)
    low = per if answered else 0.0
    return {
        "est_model": est_model, "per_agent_usd": round(per, 6), "est_usd": round(answered * per, 6), "est_low_usd": round(low, 6),
        "saved_usd": round(answered * per - worker, 6), "saved_low_usd": round(low - worker, 6), "profile_id": prof["id"],
        "basis": (f"{answered}" + (f" answered of {tasks}" if answered != tasks else "")
                  + f" x {prof['basis']} sub-agent ({prof['sample']} measured, {prof['pool_days']}d) @ {short_model(est_model)}; {why}"),
    }


def current_profile(c: sqlite3.Connection) -> dict | None:
    r = c.execute("SELECT * FROM profiles ORDER BY (machine = ?) DESC, ts DESC LIMIT 1", (MACHINE,)).fetchone()
    return dict(r) if r else None


def _upsert(c: sqlite3.Connection, table: str, columns: tuple, row: dict) -> None:
    c.execute(f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) VALUES ({','.join('?' * len(columns))})", [row.get(k) for k in columns])


def record(row: dict) -> dict:
    """Store one utilization (idempotent on id), priced against the current profile. Never raises: a
    ledger that fails must not fail the job that produced it."""
    try:
        c = connect()
        try:
            full = row | estimate(row, current_profile(c))
            full["seq"] = next_seq(c, full)
            _upsert(c, "utilizations", COLUMNS, full)
            c.commit()
        finally:
            c.close()
        return full
    except Exception as e:  # noqa: BLE001
        log(f"record failed for {row.get('id')}: {type(e).__name__}: {e}")
        return row


def record_job(job) -> dict:
    return record(job_row(job))


def record_ask(res, caller: dict | None) -> dict:
    return record(ask_row(res, caller))


def compact(full: dict) -> dict:
    """The part of a row a job summary shows: the estimate and what it rests on."""
    return {k: full.get(k) for k in ("est_model", "est_usd", "est_low_usd", "saved_usd", "saved_low_usd", "basis")}


def _store_priced(c: sqlite3.Connection, row: dict, prof: dict | None) -> None:
    """Price a row against the current profile, give it its run number, and write it."""
    row = row | estimate(row, prof)
    row["seq"] = next_seq(c, row)
    _upsert(c, "utilizations", COLUMNS, row)


def _job_row_from_doc(job_id: str, doc: dict, models: dict[str, str]) -> dict | None:
    """The row for one job.json: None when the job is not finished or left no results. The model is read from
    the job's own stamp, and only when that stamp has none from the session's transcript (cached in `models`)."""
    from .caller import session_model

    s, caller, results = doc.get("summary") or {}, dict(doc.get("caller") or {}), list((doc.get("results") or {}).values())
    results = [r for r in results if not (isinstance(r, dict) and r.get("cached_from"))]  # a fully reused resume ran nothing
    if s.get("state") not in ("done", "cancelled") or not results:
        return None
    sid = caller.get("session_id") or ""
    if not caller.get("model"):
        caller["model"] = models.setdefault(sid, session_model(sid))
    return _build_row(job_id, s.get("created") or "", s.get("finished") or "", s.get("label") or "", caller, results)


def _ask_id(i: int, r: dict) -> str:
    """The row id of the i-th ledger line, as the ledger writes it (its ts carries no colons)."""
    return "ask-" + str(r.get("ts", "")).replace(":", "").replace("+00:00", "Z") + f"-l{i}"


def _ask_row_from_ledger_line(rid: str, r: dict) -> dict:
    """The row for one `ask` line of the ledger."""
    caller = {"instance": r.get("caller_instance"), "session_id": r.get("caller_session"), "cwd": r.get("caller_cwd"), "model": r.get("caller_model") or ""}
    return {"id": rid, "ts": r.get("ts") or now_iso(), "kind": "ask", "machine": MACHINE, **_caller_fields(caller), "label": "ask",
            "backend": r.get("backend") or "api", "worker_model": r.get("model") or "", "tasks": 1, "ok": int(r.get("status") == "ok"),
            "failed": int(r.get("status") != "ok"), "seconds": float(r.get("seconds") or 0.0), "worker_usd": round(float(r.get("cost_usd") or 0.0), 6),
            "worker_tokens": sum(int(r.get(k) or 0) for k in ("in_hit", "in_miss", "out"))}


def backfill(jobs_dir: Path | None = None, ledger: Path | None = None) -> dict:
    """Rows for every finished job on disk and every ask in the ledger that the DB does not have yet: the history
    from before this ledger existed. A job's model comes from its stamp, else from its session's transcript now."""
    jobs_dir, ledger = jobs_dir or config.JOBS_DIR, ledger or config.LEDGER
    added = {"jobs": 0, "asks": 0}
    c = connect()
    try:
        have = {r[0] for r in c.execute("SELECT id FROM utilizations")}
        prof = current_profile(c)
        from . import archive
        from .job import fold_journal

        models: dict[str, str] = {}
        for job_id in archive.job_ids():  # folders and archives alike
            if job_id in have:
                continue
            doc = archive.read_json(job_id, "job.json")
            if not isinstance(doc, dict):
                continue
            row = _job_row_from_doc(job_id, fold_journal(job_id, doc), models)  # a finished record's results are in its journal
            if row is None:
                continue
            _store_priced(c, row, prof)
            added["jobs"] += 1
        if ledger.exists():
            for i, line in enumerate(ledger.read_text(encoding="utf-8").splitlines()):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("job") != "ask":
                    continue
                rid = _ask_id(i, r)
                if rid in have:
                    continue
                _store_priced(c, _ask_row_from_ledger_line(rid, r), prof)
                added["asks"] += 1
        c.commit()
    finally:
        c.close()
    log(f"backfill: {added['jobs']} jobs, {added['asks']} asks")
    return added


# ---- the profile --------------------------------------------------------------------------------

def _pool_sample(day_rows: list[dict], pool_days: int) -> tuple[str, list[dict], int] | None:
    """What the profile is measured from: the last `pool_days` complete days, Sonnet sub-agents when there are
    MIN_POOL of them and any model otherwise. None when even the fallback has too few on record."""
    pool = [r for r in day_rows if not r.get("partial")][-pool_days:]
    by_family: dict[str, list[dict]] = {}
    for r in pool:
        for fam, agents in (r.get("agent_tokens") or {}).items():
            by_family.setdefault(fam, []).extend(a for a in agents if isinstance(a, dict))
    sonnet = by_family.get("sonnet", [])
    every = [a for v in by_family.values() for a in v]
    basis, sample = ("Sonnet", sonnet) if len(sonnet) >= MIN_POOL else ("any-model", every)
    return (basis, sample, len(pool)) if len(sample) >= MIN_POOL else None


def refresh_profile(day_rows: list[dict], pool_days: int = POOL_DAYS) -> dict | None:
    """Measure the sub-agent profile from the recorded days (savings-daily rows with `agent_tokens`), store
    it, and price every row on this machine that has no estimate yet. None when fewer than MIN_POOL
    sub-agents are on record: that is "not measured", never a made-up number."""
    chosen = _pool_sample(day_rows, pool_days)
    if chosen is None:
        return None
    basis, sample, days = chosen
    med = {k: int(statistics.median(int(a.get(k) or 0) for a in sample)) for k in (*claude_usage.TOKEN_KEYS, "requests")}
    now = dt.datetime.now(dt.timezone.utc)
    prof = {"id": f"{MACHINE}-{now:%Y%m%d-%H%M%S}", "ts": now.isoformat(timespec="seconds"), "machine": MACHINE, "basis": basis,
            "sample": len(sample), "pool_days": days, **med}
    c = connect()
    try:
        _upsert(c, "profiles", PROFILE_COLUMNS, prof)
        repriced = _reprice(c, prof)
        c.commit()
    finally:
        c.close()
    log(f"profile {prof['id']}: {basis} x{len(sample)} over {days}d, tokens {med}; repriced {repriced} row(s)")
    return prof | {"repriced": repriced}


def _reprice(c: sqlite3.Connection, prof: dict) -> int:
    rows = [dict(r) for r in c.execute("SELECT * FROM utilizations WHERE est_usd IS NULL AND machine = ?", (MACHINE,))]
    for r in rows:
        _upsert(c, "utilizations", COLUMNS, r | estimate(r, prof))
    return len(rows)


# ---- Claude's own usage, per day, so a saving can be read as a share ----------------------------

def _routing_rows() -> list[dict]:
    try:
        return [json.loads(line) for line in config.ROUTING.read_text(encoding="utf-8").splitlines() if line.strip()]
    except (OSError, ValueError):
        return []


_FAMILIES = ("sonnet", "opus", "fable", "haiku")


def _family(model) -> str:
    """Which model family a sub-agent belongs to; "other" for anything the rulings do not name."""
    return next((f for f in ("haiku", "sonnet", "opus", "fable") if f in (model or "")), "other")


def _agent_counts(agents: list[dict]) -> dict:
    """Per family: how many sub-agents ran, what they cost, and how many of them sat inside a Workflow."""
    out = {}
    for f in _FAMILIES:
        mine = [a for a in agents if _family(a.get("model")) == f]
        out[f"{f}_agents"] = len(mine)
        out[f"{f}_usd"] = round(sum(float(a.get("usd") or 0.0) for a in mine), 4)
        out[f"{f}_workflow_agents"] = sum(1 for a in mine if a.get("workflow"))
    return out


def _local_day(ts: str) -> str:
    d = local_dt(ts)
    return d.date().isoformat() if d else ""


def _gate_decisions(routing: list[dict], day: str) -> dict:
    """What the gate decided on that local day, and how many Sonnet sub-agents it let through."""
    todays = [r for r in routing if _local_day(r.get("ts") or "") == day]
    out = {"gate_decisions": len(todays)}
    for d in ("blocked", "allowed", "reminded"):
        out[f"gate_{d}"] = sum(1 for r in todays if r.get("decision") == d)
    out["gate_allowed_sonnet_agents"] = sum(int(r.get("agents") or 1) for r in todays if r.get("model") == "sonnet" and r.get("decision") != "blocked")
    return out


def _gate_bypass(agents: list[dict], gate_start: str, gated_sessions: set[str]) -> dict:
    """Sub-agents that started after the gate went live, and how many came from sessions it never saw."""
    after = [a for a in agents if gate_start and (a.get("started") or "") >= gate_start]
    return {"agents_after_gate": len(after),
            "ungated_agents_after_gate": sum(1 for a in after if (a.get("session") or "") not in gated_sessions),
            "gate_live_since": gate_start[:16]}


def _gate_start(routing: list[dict]) -> str:
    """The earliest stamp in the gate's log: when it first decided anything."""
    return min((r.get("ts") or "" for r in routing if r.get("ts")), default="")


def _gated_sessions(routing: list[dict]) -> set[str]:
    """The session ids the gate has ever seen, short as the transcripts write them."""
    return {(r.get("session_id") or "")[:8] for r in routing if r.get("session_id")}


def _haiku_requests(by_model: dict) -> int:
    """Every Haiku request that day: the ban is on the model, and it is counted from Claude's own by-model split."""
    return sum(int(v.get("requests") or 0) for m, v in by_model.items() if "haiku" in m)


def rule_check(day_row: dict, routing: list[dict] | None = None) -> dict:
    """Were the rulings followed that day, from the transcripts and the routing gate's log: Haiku requests (banned),
    Sonnet sub-agents and their cost (allowed only with a logged reason), Opus/Fable sub-agents, how many sub-agents
    started after the gate went live, and how many of those came from sessions the gate never saw (a bypass)."""
    routing = _routing_rows() if routing is None else routing
    agents = [a for v in (day_row.get("agent_tokens") or {}).values() for a in v if isinstance(a, dict)]
    out = {"haiku_requests": _haiku_requests(day_row.get("by_model") or {})}
    out |= _agent_counts(agents)
    out |= _gate_decisions(routing, day_row.get("day") or "")
    out |= _gate_bypass(agents, _gate_start(routing), _gated_sessions(routing))
    out["agents_detail"] = bool(agents and "model" in agents[0])  # False for a day recorded before the scanners carried model/session/start
    return out


def _fill_caller_accounts(c: sqlite3.Connection, res: dict) -> int:
    """Give this machine's older rows the account that ordered them, from the instance folder they were stamped
    with. Folder names are reused over time, so this is the mapping as it stands TODAY - rows recorded from here
    on carry the account resolved at the moment they ran. Another machine's rows arrive already resolved."""
    from . import accounts

    n = 0
    # The session is the better key (a folder name is reused, a session id is not); the ledger keeps its first
    # 8 characters, which is what a sub-agent transcript is named by too, so the prefix is what matches here.
    short: dict[str, dict | None] = {}
    for sid, label in res["by_session"].items():
        found = res["by_instance"].get(label)
        prefix = sid[:8]
        if prefix in short and (short[prefix] or {}).get("account") != (found or {}).get("account"):
            short[prefix] = None  # two sessions share this prefix and disagree: attribute neither
        else:
            short.setdefault(prefix, found)
    for prefix, found in short.items():
        if not found:
            continue
        n += c.execute("UPDATE utilizations SET caller_account = ? WHERE machine = ? AND caller_session = ? AND COALESCE(caller_account, '') = ''",
                       (found["account"], MACHINE, prefix)).rowcount
    for (label,) in c.execute("SELECT DISTINCT caller_instance FROM utilizations WHERE machine = ? AND COALESCE(caller_account, '') = '' "
                              "AND COALESCE(caller_instance, '') <> ''", (MACHINE,)).fetchall():
        found = accounts.of_instance(label, res)
        if not found:
            continue
        n += c.execute("UPDATE utilizations SET caller_account = ? WHERE machine = ? AND caller_instance = ? AND COALESCE(caller_account, '') = ''",
                       (found["account"], MACHINE, label)).rowcount
    return n


def _store_accounts(c: sqlite3.Connection, day: str, per_account: dict[str, dict]) -> None:
    """One day's per-account rows, replacing whatever that day held (a re-measure must not leave an account behind)."""
    from . import accounts

    c.execute("DELETE FROM claude_accounts WHERE machine = ? AND day = ?", (MACHINE, day))
    for acct, row in per_account.items():
        plan = None if acct == accounts.UNATTRIBUTED else accounts.tier_usd_day(row.get("tier") or "")
        _upsert(c, "claude_accounts", CLAUDE_ACCOUNT_COLUMNS,
                {"machine": MACHINE, "day": day, "account": acct, "tier": row.get("tier") or "", "usd": row.get("usd"),
                 "requests": row.get("requests"), "sessions": row.get("sessions"),
                 "tokens": json.dumps(row.get("tokens") or {}, sort_keys=True), "plan_usd": plan})


def record_claude_days(day_rows: list[dict], partial: bool = False) -> int:
    """This machine's Claude usage per local day (the savings-daily rows, or today's live measurement with
    partial=True), with the per-model split, the token buckets, the rule check, and which ACCOUNTS did the work -
    each by its hashed id, with what that day of their plans cost. A completed day is never overwritten by a partial one."""
    from . import accounts

    routing = _routing_rows()
    res = accounts.resolver(fresh=True)
    c = connect()
    try:
        _fill_caller_accounts(c, res)
        n = 0
        for r in day_rows:
            day = r.get("day")
            if not day:
                continue
            have = c.execute("SELECT partial FROM claude_days WHERE machine = ? AND day = ?", (MACHINE, day)).fetchone()
            if have is not None and not have["partial"] and partial:
                continue
            per_account = accounts.attribute(r.get("by_session") or {}, res)
            c.execute("INSERT OR REPLACE INTO claude_days (machine, day, claude_usd, sub_usd, subagents, partial, by_model, rules, tokens, plan_usd)"
                      " VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (MACHINE, day, float(r.get("claude_usd") or 0.0), float(r.get("claude_sub_usd") or 0.0),
                       sum(len(v) for v in (r.get("subagent_usd") or {}).values()), int(partial),
                       json.dumps(r.get("by_model") or {}, sort_keys=True), json.dumps(rule_check(r, routing), sort_keys=True),
                       json.dumps(r.get("tokens") or {}, sort_keys=True), accounts.day_plan_usd(per_account)))
            _store_accounts(c, day, per_account)
            n += 1
        c.commit()
    finally:
        c.close()
    return n


def claude_day_rows(c: sqlite3.Connection, machine: str | None = None) -> list[dict]:
    """claude_days with by_model and rules parsed, newest first."""
    q = "SELECT * FROM claude_days" + (" WHERE machine = ?" if machine else "") + " ORDER BY day DESC"
    out = []
    for r in c.execute(q, (machine,) if machine else ()):
        d = dict(r)
        for k in ("by_model", "rules", "tokens"):
            try:
                d[k] = json.loads(d[k]) if d.get(k) else {}
            except ValueError:
                d[k] = {}
        out.append(d)
    return out


def measure_today() -> bool:
    """Today's Claude usage on this machine, live, stored as a partial day. Only with a native scanner (a
    few seconds); the Python fallback would add a minute to every sync, and yesterday's figure stands."""
    from . import native, savings

    if native.choose() == "python":
        return False
    today = dt.date.today()
    try:
        record_claude_days([savings.measure(today, today, today)[today.isoformat()]], partial=True)
        return True
    except Exception as e:  # noqa: BLE001 - a failed measurement leaves the day unmeasured, never breaks a sync
        log(f"today's Claude usage not measured: {type(e).__name__}: {e}")
        return False


def share(est, claude) -> float | None:
    """The swarm's estimated work as a share of (itself + the Claude work done beside it); None when either is unknown."""
    if est is None or claude is None or est + claude <= 0:
        return None
    return round(est / (est + claude), 4)


# ---- reading ------------------------------------------------------------------------------------

def _tokens_sum(alias: str, col: str = "tokens") -> str:
    """SQL for the five token buckets of one stored JSON blob, summed. A row written before tokens were counted
    reads as 0 here, so every caller also counts those rows and reports them rather than letting an undercount
    pass as a measurement."""
    return " + ".join(f"COALESCE(json_extract({alias}.{col}, '$.{k}'), 0)" for k in claude_usage.TOKEN_KEYS)


_DAY_TOKENS_SQL = _tokens_sum("d")

_TOTALS_SQL = ("SELECT COUNT(*) AS n, COALESCE(SUM(tasks), 0) AS tasks, COALESCE(SUM(worker_usd), 0) AS worker_usd, SUM(est_usd) AS est_usd, "
               "SUM(est_low_usd) AS est_low_usd, "
               "SUM(saved_usd) AS saved_usd, SUM(saved_low_usd) AS saved_low_usd, SUM(CASE WHEN est_usd IS NULL THEN 1 ELSE 0 END) AS unpriced, "
               "MIN(ts) AS first, MAX(ts) AS last FROM utilizations")
# Claude usage on the local days that have utilizations, per machine (a day the swarm sat idle is not in the comparison).
_CLAUDE_SQL = ("SELECT COALESCE(SUM(d.claude_usd), 0) AS claude_usd, COUNT(*) AS claude_days, COALESCE(SUM(d.partial), 0) AS partial_days, "
               f"SUM({_DAY_TOKENS_SQL}) AS claude_tokens, SUM(CASE WHEN d.tokens IS NULL OR d.tokens IN ('', '{{}}') THEN 1 ELSE 0 END) AS days_without_tokens, "
               # The plan cost counts COMPLETE days only, exactly like plan_rates: a part-written day would put a
               # part-day of usage against a whole day of plan and read as a worse rate than the fleet really has.
               "SUM(CASE WHEN d.partial = 0 THEN d.plan_usd END) AS plan_usd, "
               "SUM(CASE WHEN d.partial = 0 AND d.plan_usd IS NULL THEN 1 ELSE 0 END) AS days_without_plan FROM claude_days d "
               "WHERE EXISTS (SELECT 1 FROM utilizations u WHERE u.machine = d.machine AND date(u.ts, 'localtime') = d.day)")
# What the same work would have cost in TOKENS, not dollars: one task = one measured sub-agent, so the profile's
# buckets x tasks. A row with no profile contributes NULL (SUM skips it) and is counted as unsized instead.
_TOKENS_SQL = ("SELECT SUM(u.tasks * (p.input + p.cache_read + p.cache_5m + p.cache_1h + p.output)) AS est_tokens, "
               "SUM(p.input + p.cache_read + p.cache_5m + p.cache_1h + p.output) AS est_low_tokens, "
               "SUM(u.tasks * p.input) AS est_input, SUM(u.tasks * p.cache_read) AS est_cache_read, "
               "SUM(u.tasks * (p.cache_5m + p.cache_1h)) AS est_cache_write, SUM(u.tasks * p.output) AS est_output, "
               "COALESCE(SUM(u.worker_tokens), 0) AS worker_tokens, SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS unsized "
               "FROM utilizations u LEFT JOIN profiles p ON p.id = u.profile_id")


def _round(d: dict) -> dict:
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()}


def totals(c: sqlite3.Connection, machine: str | None = None) -> dict:
    """The running total: every machine's rows in this DB (imported shards included), or one machine's, with
    the Claude work done beside it on the same days and the share the swarm's estimate is of the two.

    Three units, because a list-price dollar is not what a subscription charges (owner ask, Michael, 2026-09-17):
    `*_usd` is Anthropic's list price, `*_tokens` is the same work in tokens, and the plan figures convert a
    list dollar at what this fleet's plans actually cost per list dollar (see plan_rates)."""
    args = (machine,) if machine else ()
    t = dict(c.execute(_TOTALS_SQL + (" WHERE machine = ?" if machine else ""), args).fetchone())
    cl = dict(c.execute(_CLAUDE_SQL + (" AND d.machine = ?" if machine else ""), args).fetchone())
    tk = dict(c.execute(_TOKENS_SQL + (" WHERE u.machine = ?" if machine else ""), args).fetchone())
    claude = cl["claude_usd"] if cl["claude_days"] else None  # no day measured: not measured, never zero
    claude_tokens = cl["claude_tokens"] if cl["claude_days"] and not cl["days_without_tokens"] else None
    return _round(t) | tk | {
        "machine": machine or "all", "claude_usd": None if claude is None else round(claude, 4), "claude_days": cl["claude_days"],
        "claude_partial_days": cl["partial_days"], "share": share(t["est_usd"], claude),
        "claude_tokens": claude_tokens, "days_without_tokens": cl["days_without_tokens"],
        "token_share": share(tk["est_tokens"], claude_tokens),
        "plan_usd": None if cl["days_without_plan"] or not cl["claude_days"] else _round_or_none(cl["plan_usd"]),
        "days_without_plan": cl["days_without_plan"],
    }


def _round_or_none(v, digits: int = 4):
    return None if v is None else round(v, digits)


def add_measured(a, b):
    """Sum two figures where None means NOT MEASURED: None + x is x, and nothing measured stays None."""
    return b if a is None else (a if b is None else a + b)


def by_machine(c: sqlite3.Connection) -> list[dict]:
    return [totals(c, r[0]) for r in c.execute("SELECT DISTINCT machine FROM utilizations ORDER BY machine")]


# ---- the subscription: what a list-price dollar actually costs -----------------------------------

def plan_rates(c: sqlite3.Connection) -> dict:
    """What one list-price dollar of Claude work really cost, per machine and for the fleet.

    rate = (the plans of the accounts that DID work, charged per day they worked) / (the list-price value of the
    work they did on those days). On a subscription that is the honest conversion: list price is what the API
    would have billed, the rate is what the plan billed instead (owner ask, Michael, 2026-09-17: count the
    accounts actually used, not every account that is open). Only complete days with a plan cost count; a
    machine with none of its own is priced at the fleet rate and flagged `estimated`. Nothing measured -> None."""
    rows = [dict(r) for r in c.execute(
        "SELECT machine, SUM(plan_usd) AS plan_usd, SUM(claude_usd) AS claude_usd, COUNT(*) AS days, MIN(day) AS first, MAX(day) AS last "
        "FROM claude_days WHERE partial = 0 AND plan_usd IS NOT NULL AND claude_usd > 0 GROUP BY machine ORDER BY machine")]
    per = {r["machine"]: {"rate": round(r["plan_usd"] / r["claude_usd"], 8), "plan_usd": round(r["plan_usd"], 4),
                          "claude_usd": round(r["claude_usd"], 4), "days": r["days"], "first": r["first"], "last": r["last"],
                          "estimated": False} for r in rows if r["claude_usd"]}
    plan, claude = sum(r["plan_usd"] for r in rows), sum(r["claude_usd"] for r in rows)
    fleet = {"rate": round(plan / claude, 8) if claude else None, "plan_usd": round(plan, 4), "claude_usd": round(claude, 4),
             "days": sum(r["days"] for r in rows), "machines": len(per)}
    return {"machines": per, "fleet": fleet}


def rate_of(rates: dict, machine: str) -> tuple[float | None, bool]:
    """(rate, is it the fleet's rather than this machine's own) for one machine."""
    own = (rates.get("machines") or {}).get(machine)
    if own and own["rate"] is not None:
        return own["rate"], False
    return (rates.get("fleet") or {}).get("rate"), True


def weigh(usd, rate: float | None):
    """A list-price figure in plan dollars; None when either side is not measured."""
    return None if usd is None or rate is None else round(usd * rate, 6)


def _fold_account_day(folded: dict[str, dict], row: dict) -> None:
    """Fold one (account, day) grouped row into that account's running total in `folded`."""
    from . import accounts

    have = folded.get(row["account"])
    if have is None:
        folded[row["account"]] = {"account": row["account"], "tier": row["tier"] or "", "days": 1, "usd": row["usd"] or 0.0,
                                  "plan_usd": row["plan_usd"], "requests": row["requests"] or 0, "sessions": row["sessions"] or 0,
                                  "tokens": row["tokens"] or 0, "first": row["day"], "last": row["day"],
                                  "machines": row["machines"] or ""}
        return
    have["tier"] = accounts.better_tier(have["tier"], row["tier"] or "")  # two folders, two readings: dearest wins
    have["days"] += 1
    have["plan_usd"] = add_measured(have["plan_usd"], row["plan_usd"])
    for k in ("usd", "requests", "sessions", "tokens"):
        have[k] = (have.get(k) or 0) + (row.get(k) or 0)
    have["first"] = min(have["first"], row["day"])
    have["last"] = max(have["last"], row["day"])
    have["machines"] = ",".join(sorted({*have["machines"].split(","), *str(row["machines"] or "").split(",")} - {""}))


def _run_totals(c: sqlite3.Connection, machine: str | None, args: tuple) -> dict[str, dict]:
    """The swarm runs each account ordered, grouped by caller account (unresolved ones under UNATTRIBUTED)."""
    from . import accounts

    runs: dict[str, dict] = {}
    # a run whose account could not be resolved joins the same `unattributed` line as the usage
    q = ("SELECT COALESCE(NULLIF(caller_account, ''), ?) AS caller_account, COUNT(*) AS runs, COALESCE(SUM(tasks), 0) AS tasks, "
         "SUM(est_usd) AS est_usd, COALESCE(SUM(worker_usd), 0) AS worker_usd, SUM(u.tasks * (p.input + p.cache_read + p.cache_5m + p.cache_1h + p.output)) AS est_tokens "
         "FROM utilizations u LEFT JOIN profiles p ON p.id = u.profile_id"
         + (" WHERE u.machine = ?" if machine else "") + " GROUP BY caller_account")
    for r in c.execute(q, (accounts.UNATTRIBUTED, *args)):
        runs[r["caller_account"]] = dict(r)
    return runs


def _merge_run_totals(out: list[dict], runs: dict[str, dict], machine: str | None) -> list[dict]:
    """Fold each account's run totals onto its usage row, and add the accounts that only ever ordered work."""
    for row in out:
        r = runs.get(row["account"]) or {}
        row |= {"runs": r.get("runs", 0), "tasks": r.get("tasks", 0), "est_usd": r.get("est_usd"),
                "est_tokens": r.get("est_tokens"), "worker_usd": r.get("worker_usd", 0.0)}
    seen = {row["account"] for row in out}
    for acct, r in runs.items():  # an account that ordered swarm work but whose own Claude days are not measured
        if acct and acct not in seen:
            out.append({"account": acct, "tier": "", "days": 0, "usd": None, "plan_usd": None, "requests": 0, "sessions": 0,
                        "tokens": None, "first": "", "last": "", "machines": machine or "", **r})
    return out


def account_rows(c: sqlite3.Connection, machine: str | None = None) -> list[dict]:
    """Per account (by its hashed id, never a name or an email): which plan it is on, how many days it worked,
    what that work was worth at list price and in tokens, what its plan cost over those days, and the swarm runs
    it ordered. `unattributed` is the work no account could be put to - not measured, never dropped."""
    where = " WHERE machine = ?" if machine else ""
    args = (machine,) if machine else ()
    # Per account per DAY first: one account used on two machines on one day is one day of one plan, not two.
    q = (f"SELECT account, day, MAX(tier) AS tier, SUM(usd) AS usd, MAX(plan_usd) AS plan_usd, SUM(requests) AS requests, "
         f"SUM(sessions) AS sessions, SUM({_tokens_sum('claude_accounts')}) AS tokens, "
         f"GROUP_CONCAT(DISTINCT machine) AS machines FROM claude_accounts{where} GROUP BY account, day")
    folded: dict[str, dict] = {}
    for r in c.execute(q, args):
        _fold_account_day(folded, dict(r))
    out = sorted(folded.values(), key=lambda r: -(r.get("usd") or 0))
    out = _merge_run_totals(out, _run_totals(c, machine, args), machine)
    return sorted(out, key=lambda r: -((r.get("usd") or 0) + (r.get("est_usd") or 0)))


def recent(c: sqlite3.Connection, n: int = 10) -> list[dict]:
    keys = ("seq", "id", "ts", "machine", "kind", "label", "caller_instance", "caller_session", "caller_cwd", "orchestrator_model", "tasks", "ok",
            "worker_usd", "est_model", "est_usd", "saved_usd", "basis")
    return [{k: r[k] for k in keys} for r in c.execute("SELECT * FROM utilizations ORDER BY ts DESC, id DESC LIMIT ?", (max(1, n),))]


def summary(n: int = 10) -> dict:
    """What the MCP tool and the CLI print: profile, fleet total, per machine, the last n rows."""
    c = connect()
    try:
        days = claude_day_rows(c, MACHINE)
        rates = plan_rates(c)
        total = totals(c)
        return {"machine": MACHINE, "profile": current_profile(c), "total": total, "by_machine": by_machine(c), "recent": recent(c, n),
                "latest_claude_day": days[0] if days else None, "plan_rates": rates, "plan": plan_view(total, rates),
                "accounts": account_rows(c), "db": str(db_path()), "shards": str(sync_dir()), "html": str(config.HOME / "hswarm.html"), "note": NOTE}
    finally:
        c.close()


def plan_view(total: dict, rates: dict) -> dict:
    """The running total in PLAN dollars: what the swarm's work was worth at the rate the subscriptions actually
    charge, minus the DeepSeek bill, which is real money and is never weighted."""
    rate = (rates.get("fleet") or {}).get("rate")
    est = weigh(total.get("est_usd"), rate)
    low = weigh(total.get("est_low_usd"), rate)
    return {"rate": rate, "est_usd": est, "est_low_usd": low,
            "saved_low_usd": None if low is None else round(low - (total.get("worker_usd") or 0.0), 4),
            "worker_usd": total.get("worker_usd"), "saved_usd": None if est is None else round(est - (total.get("worker_usd") or 0.0), 4),
            "claude_usd": weigh(total.get("claude_usd"), rate), "plan_usd": total.get("plan_usd"), "days": (rates.get("fleet") or {}).get("days"),
            "machines_measured": (rates.get("fleet") or {}).get("machines")}


def rules_text(d: dict | None) -> str:
    """One line: did that day follow the rulings."""
    if not d or not d.get("rules"):
        return "rule check: no Claude day measured yet"
    r = d["rules"]
    bm = d.get("by_model") or {}
    models = ", ".join(f"{short_model(m)} {usd(v.get('usd'))} ({v.get('requests')} req, {v.get('agents')} sub-agents)" for m, v in sorted(bm.items(), key=lambda kv: -(kv[1].get('usd') or 0)))
    haiku = "Haiku 0 (ban held)" if not r.get("haiku_requests") else f"HAIKU {r['haiku_requests']} REQUESTS (banned)"
    return (f"rule check {d['day']}{'*' if d.get('partial') else ''}: {haiku}; Sonnet sub-agents {r.get('sonnet_agents', 0)} ({usd(r.get('sonnet_usd'))}, "
            f"{r.get('sonnet_workflow_agents', 0)} in workflows); Opus {r.get('opus_agents', 0)}, Fable {r.get('fable_agents', 0)}; gate live since {r.get('gate_live_since') or '-'}: "
            f"{r.get('gate_decisions', 0)} decisions ({r.get('gate_blocked', 0)} blocked, {r.get('gate_allowed', 0)} allowed, {r.get('gate_reminded', 0)} reminded), "
            f"{r.get('agents_after_gate', 0)} sub-agents started after it, {r.get('ungated_agents_after_gate', 0)} of them from sessions the gate never saw"
            + ("" if r.get("agents_detail") else "; per-agent detail not recorded for this day") + f"\n  by model: {models or '-'}")


def big(n) -> str:
    """A token count a human reads: 21.3B, 4.7M, 812k. '-' is not measured, never zero."""
    if n is None:
        return "-"
    n = float(n)
    for unit, size in (("T", 1e12), ("B", 1e9), ("M", 1e6), ("k", 1e3)):
        if abs(n) >= size:
            return f"{n / size:,.1f}{unit}"
    return f"{n:,.0f}"


def tokens_text(t: dict) -> str:
    """The same total in tokens, which is the unit a subscription actually rations."""
    ratio = f"{t['est_tokens'] / t['worker_tokens']:,.0f}x fewer" if t.get("est_tokens") and t.get("worker_tokens") else "ratio not measured"
    share_txt = f", {t['token_share'] * 100:.1f}% of the tokens this fleet ran on swarm days" if t.get("token_share") is not None else ""
    return (f"in tokens: {big(t.get('est_tokens'))} Claude tokens avoided ({big(t.get('est_cache_read'))} of them cache reads), "
            f"{big(t.get('worker_tokens'))} DeepSeek tokens spent, {ratio}{share_txt}"
            + (f"; {t['unsized']} run(s) unsized" if t.get("unsized") else ""))


def plan_text(plan: dict, rates: dict) -> str:
    """The same total in PLAN dollars: list price is not what a subscription bills."""
    if not plan.get("rate"):
        return "on the plans: not measured yet (no account could be costed; set ~/.hswarm/plan.json or let AgentHydra resolve the accounts)"
    f = rates.get("fleet") or {}
    return (f"on the plans: 1 list-price dollar cost {usd(plan['rate'])} ({usd(f.get('plan_usd'))} of plans over {f.get('days')} day(s) carried "
            f"{usd(f.get('claude_usd'))} of list-price work), so the swarm's work was worth {usd(plan['est_usd'])} of plan, "
            f"DeepSeek charged {usd(plan['worker_usd'])} in real money: saved {usd(plan['saved_usd'])}")


def render(s: dict) -> str:
    """Plain text for `hswarm savings`: the running total first, then who did what lately."""
    t, p = s["total"], s.get("profile")
    cheaper = f"{t['est_usd'] / t['worker_usd']:,.0f}x cheaper" if t["est_usd"] is not None and t["worker_usd"] else "ratio not measured"
    pct = f"{t['share'] * 100:.1f}% of the Claude work done beside it ({usd(t['claude_usd'])} over {t['claude_days']} day(s))" if t["share"] is not None else "share of Claude work not measured yet"
    out = [f"hswarm running total, all machines ({len(s['by_machine'])} on record): {t['n']} utilizations, {t['tasks']} tasks, "
           f"DeepSeek {usd(t['worker_usd'])}, est. Claude {usd(t['est_usd'])}, saved {usd(t['saved_usd'])} (low {usd(t['saved_low_usd'])}), {cheaper}"
           + (f", {t['unpriced']} unpriced" if t["unpriced"] else ""),
           f"  = {pct}; the dollars are list-price equivalents of quota, not money"]
    for m in s["by_machine"]:
        sh = f"{m['share'] * 100:5.1f}%" if m["share"] is not None else "    -"
        out.append(f"  {m['machine']:16s} {m['n']:5d} uses {m['tasks']:6d} tasks  DeepSeek {usd(m['worker_usd']):>9s}  est. {usd(m['est_usd']):>10s}  saved {usd(m['saved_usd']):>10s}  share {sh}")
    out.append(tokens_text(t))
    out.append(plan_text(s.get("plan") or {}, s.get("plan_rates") or {}))
    if p:
        out.append(f"profile on {s['machine']}: one {p['basis']} sub-agent = {p['input']} in + {p['cache_read']} cache-read + {p['cache_5m']}/{p['cache_1h']} cache-write + {p['output']} out tokens "
                   f"over {p['requests']} requests (median of {p['sample']}, {p['pool_days']} days, {p['ts'][:10]})")
    else:
        out.append(f"profile on {s['machine']}: none yet (rows stay unpriced until `hswarm savings --record` measures one)")
    out.append(rules_text(s.get("latest_claude_day")))
    if s["recent"]:
        out.append(f"last {len(s['recent'])} (run numbers count up per machine and never change; times are this machine's local clock):")
        for r in s["recent"]:
            who = f"{r['caller_instance'] or '-'}/{r['caller_session'] or '-'}"
            out.append(f"  #{r['seq'] or '?':<5} {local_min(r['ts'])} {r['machine'][:10]:10s} {r['kind']:4s} {r['tasks']:4d}t {who:22s} {short_model(r['orchestrator_model'])[:14]:14s} "
                       f"est {usd(r['est_usd']):>9s} DeepSeek cost {usd(r['worker_usd']):>8s} saved {usd(r['saved_usd']):>9s}  {how(r):28s} {(r['label'] or '')[:30]}")
    return "\n".join(out)


# ---- sync: one shard per machine on the `sync` branch ----------------------------------------------

def shard_path(where: Path, machine: str = MACHINE) -> Path:
    return where / f"{machine}.jsonl"


def export_shard(c: sqlite3.Connection, where: Path) -> Path:
    """This machine's rows and profiles as one deterministic JSONL file (sorted, stable keys: git diffs stay small)."""
    where.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"row": "profile", **dict(r)}, sort_keys=True) for r in c.execute("SELECT * FROM profiles WHERE machine = ? ORDER BY id", (MACHINE,))]
    lines += [json.dumps({"row": "claude_day", **dict(r)}, sort_keys=True) for r in c.execute("SELECT * FROM claude_days WHERE machine = ? ORDER BY day", (MACHINE,))]
    lines += [json.dumps({"row": "claude_account", **dict(r)}, sort_keys=True)
              for r in c.execute("SELECT * FROM claude_accounts WHERE machine = ? ORDER BY day, account", (MACHINE,))]
    lines += [json.dumps({"row": "utilization", **dict(r)}, sort_keys=True) for r in c.execute("SELECT * FROM utilizations WHERE machine = ? ORDER BY id", (MACHINE,))]
    p = shard_path(where)
    tmp = p.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
    os.replace(tmp, p)
    return p


def import_shards(c: sqlite3.Connection, where: Path, include_self: bool = False) -> int:
    """Every other machine's shard into this DB (upsert by id). Their estimates travel as written there.

    `include_self` also reads THIS machine's shard back, which is the restore path: the shard on the sync
    branch is the only off-machine copy of the ledger, and a normal sync must not read it (a row deleted or
    repriced locally would come straight back), so rebuilding after a lost disk has to ask for it."""
    n = 0
    for p in sorted(where.glob("*.jsonl")):
        if p.stem == MACHINE and not include_self:
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            kind = obj.pop("row", None)
            if kind == "utilization" and obj.get("id"):
                _upsert(c, "utilizations", COLUMNS, obj)
                n += 1
            elif kind == "profile" and obj.get("id"):
                _upsert(c, "profiles", PROFILE_COLUMNS, obj)
            elif kind == "claude_day" and obj.get("machine") and obj.get("day"):
                _upsert(c, "claude_days", CLAUDE_DAY_COLUMNS, obj | {"partial": int(obj.get("partial") or 0)})
            elif kind == "claude_account" and obj.get("machine") and obj.get("day") and obj.get("account"):
                _upsert(c, "claude_accounts", CLAUDE_ACCOUNT_COLUMNS, obj)
    c.commit()
    return n


def totals_markdown(c: sqlite3.Connection) -> str:
    t = totals(c)
    rates = plan_rates(c)
    plan = plan_view(t, rates)
    pct = lambda v: "-" if v is None else f"{v * 100:.1f}%"  # noqa: E731
    head = ["# hswarm running total, all machines", "",
            f"Updated {now_iso()} by `{MACHINE}`. Times in this shared file are UTC, because a local clock here is not a local clock on the other "
            f"machine; each machine's own page shows its own. {NOTE}", "",
            "| machine | utilizations | tasks | est. Claude | DeepSeek cost | saved | saved (floor) | Claude used beside it | share | unpriced | first | last |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|"]
    rows = [f"| **all** | {t['n']} | {t['tasks']} | {usd(t['est_usd'])} | {usd(t['worker_usd'])} | {usd(t['saved_usd'])} | {usd(t['saved_low_usd'])} | {usd(t['claude_usd'])} | {pct(t['share'])} | {t['unpriced']} | {(t['first'] or '')[:10]} | {(t['last'] or '')[:10]} |"]
    rows += [f"| {m['machine']} | {m['n']} | {m['tasks']} | {usd(m['est_usd'])} | {usd(m['worker_usd'])} | {usd(m['saved_usd'])} | {usd(m['saved_low_usd'])} | {usd(m['claude_usd'])} | {pct(m['share'])} | {m['unpriced']} | {(m['first'] or '')[:10]} | {(m['last'] or '')[:10]} |"
             for m in by_machine(c)]
    units = ["", "## The same total in the other two units", "",
             f"- **Tokens.** {tokens_text(t)}",
             f"- **Plan dollars.** {plan_text(plan, rates)}",
             "", "A list-price dollar is what the API would have billed; a plan dollar is what the subscriptions billed instead, "
             "counting only the accounts that actually did work on the days they did it. The DeepSeek figure is real money in every unit."]
    last = ["", "## Last 20", "", "| # | when (UTC) | machine | kind | tasks | caller | model at the time | est. Claude | DeepSeek cost | saved | how | label |", "|---:|---|---|---|---:|---|---|---:|---:|---:|---|---|"]
    last += [f"| {r['seq'] or '?'} | {r['ts'][:16]} | {r['machine']} | {r['kind']} | {r['tasks']} | {r['caller_instance'] or '-'}/{r['caller_session'] or '-'} | {short_model(r['orchestrator_model'])} | "
             f"{usd(r['est_usd'])} | {usd(r['worker_usd'])} | {usd(r['saved_usd'])} | {how(r)} | {(r['label'] or '').replace('|', '/')[:40]} |" for r in recent(c, 20)]
    return "\n".join(head + rows + units + last) + "\n"


def write_totals(c: sqlite3.Connection, where: Path) -> Path:
    p = where / "TOTALS.md"
    p.write_text(totals_markdown(c), encoding="utf-8")
    return p


def _git(cwd: Path, *args: str, check: bool = False, input_text: str | None = None) -> subprocess.CompletedProcess:
    r = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8", errors="replace", input=input_text, creationflags=CREATE_NO_WINDOW)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:400]}")
    return r


SYNC_README = """# hswarm sync branch

One file per machine, `<machine>.jsonl`: that machine's hswarm utilizations (every hswarm_run job and
hswarm_ask, with the DeepSeek cost and the estimated Claude cost it displaced). `TOTALS.md` is the fleet
running total, regenerated on every `hswarm sync`. Nothing else lives on this branch; the code is on master.
Checked out as a worktree under ~/.hswarm/sync-tree on each machine; never edit by hand.
"""


def ensure_sync_tree() -> Path:
    """The worktree for the sync branch: attached to origin/sync when it exists, else started from an empty tree."""
    t = sync_dir()
    if (t / ".git").exists():
        return t
    _git(REPO, "worktree", "prune")
    _git(REPO, "fetch", "--quiet", "origin", SYNC_BRANCH)  # may fail: the branch does not exist until the first machine pushes
    if _git(REPO, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{SYNC_BRANCH}").returncode == 0:
        _git(REPO, "worktree", "add", "--quiet", "-B", SYNC_BRANCH, str(t), f"origin/{SYNC_BRANCH}", check=True)
        _git(t, "branch", "--quiet", "--set-upstream-to", f"origin/{SYNC_BRANCH}", SYNC_BRANCH)
    else:
        empty_tree = _git(REPO, "hash-object", "-t", "tree", "--stdin", check=True, input_text="").stdout.strip()
        root = _git(REPO, "commit-tree", empty_tree, "-m", "sync: shard branch for hswarm utilization ledgers", check=True).stdout.strip()
        _git(REPO, "worktree", "add", "--quiet", "-B", SYNC_BRANCH, str(t), root, check=True)
    if not (t / "README.md").exists():
        (t / "README.md").write_text(SYNC_README, encoding="utf-8")
    return t


def restore() -> dict:
    """Rebuild this machine's ledger from its own shard on the sync branch, after a lost or wiped DB.
    Upserts by id, so running it on a healthy DB changes nothing that is already there."""
    rep: dict = {"machine": MACHINE, "restored": 0, "notes": []}
    try:
        t = ensure_sync_tree()
    except RuntimeError as e:
        rep["notes"].append(str(e))
        return rep
    r = _git(t, "pull", "--rebase", "--quiet")
    if r.returncode:
        rep["notes"].append("pull: " + (r.stderr or r.stdout).strip()[:200])
    shard = shard_path(t)
    if not shard.exists():
        rep["notes"].append(f"no shard for {MACHINE} on the sync branch yet: nothing to restore from")
        return rep
    before = 0
    c = connect()
    try:
        before = c.execute("SELECT COUNT(*) FROM utilizations").fetchone()[0]
        import_shards(c, t, include_self=True)
        rep["restored"] = c.execute("SELECT COUNT(*) FROM utilizations").fetchone()[0] - before
        rep["rows_now"] = c.execute("SELECT COUNT(*) FROM utilizations").fetchone()[0]
        rep["total"] = totals(c)
    finally:
        c.close()
    log(f"restore: {rep['restored']} row(s) recovered from {shard}, {rep.get('rows_now')} now")
    return rep


def sync(push: bool = True) -> dict:
    """Pull the other machines' shards, import them, export ours, regenerate TOTALS.md, commit, push."""
    rep: dict = {"machine": MACHINE, "tree": "", "pulled": False, "imported": 0, "committed": False, "pushed": False, "notes": []}
    try:
        t = ensure_sync_tree()
    except RuntimeError as e:
        rep["notes"].append(str(e))
        log("sync: " + str(e))
        return rep
    rep["tree"] = str(t)
    has_upstream = _git(t, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").returncode == 0
    if push and not has_upstream:
        rep["notes"].append("first sync from this machine: no remote sync branch to pull yet; pushing ours")
    elif push:
        r = _git(t, "pull", "--rebase", "--quiet")
        rep["pulled"] = r.returncode == 0
        if r.returncode:
            rep["notes"].append("pull: " + (r.stderr or r.stdout).strip()[:200])
    measure_today()  # so the share compares against today's Claude work too, not only yesterday's
    c = connect()
    try:
        rep["imported"] = import_shards(c, t)
        export_shard(c, t)
        write_totals(c, t)
        rep["total"] = totals(c)
    finally:
        c.close()
    _git(t, "add", "--", f"{MACHINE}.jsonl", "TOTALS.md", "README.md")
    if _git(t, "diff", "--cached", "--quiet").returncode != 0:
        tot = rep["total"]
        r = _git(t, "commit", "--quiet", "-m", f"sync: {MACHINE}, {tot['n']} utilizations, saved {usd(tot['saved_usd'])}")
        rep["committed"] = r.returncode == 0
        if r.returncode:
            rep["notes"].append("commit: " + (r.stderr or r.stdout).strip()[:200])
    if push:
        r = _git(t, "push", "--quiet", "-u", "origin", SYNC_BRANCH)
        rep["pushed"] = r.returncode == 0
        if r.returncode:
            rep["notes"].append("push: " + (r.stderr or r.stdout).strip()[:200])
    from . import report_html  # here, not at import: report_html imports this module

    rep["html"] = str(report_html.write())  # the page the owner opens instead of asking
    log(f"sync: imported {rep['imported']}, committed {rep['committed']}, pushed {rep['pushed']}" + (f", notes {rep['notes']}" if rep["notes"] else ""))
    return rep
