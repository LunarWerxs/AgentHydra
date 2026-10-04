"""Savings tracker: per local day, what the hswarm spent on DeepSeek, what Claude cost on this machine,
and what the hswarm's work would have cost as Claude sub-agents instead.

The counterfactual is MEASURED, not assumed: the median API-equivalent cost of a real Sonnet sub-agent
on this machine over the last POOL_DAYS days on record (every sub-agent when Sonnet ran too few). It is
a range, because nobody knows how many sub-agents one hswarm_run replaced:
  low  = one sub-agent per hswarm job   (the whole batch would have been one agent)
  high = one sub-agent per hswarm task  (every task would have been its own agent)
Completed days land in ~/.hswarm/savings-daily.jsonl, so the history outlives Claude Code's transcript
cleanup. `hswarm savings --record` fills it; `hswarm install --track-savings` schedules that daily.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import statistics
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

from . import claude_usage, config
from .ledger import ledger_rows

DEFAULT_AGENTHYDRA_URL = "http://127.0.0.1:7787"
KIT_SOURCES = "cli,desktop,climayte"  # the analytics kit's Claude sources (sessions of this PC's Claude Code)
KIT_TIMEOUT_S = 5
BACKFILL_DAYS = 7
POOL_DAYS = 14
MIN_POOL = 5
SUMMED = ("deepseek_usd", "claude_usd", "hswarm_tasks", "hswarm_jobs", "claude_subagents",
          "avoided_low_usd", "avoided_high_usd", "net_saved_low_usd", "net_saved_high_usd")
NOTE = ("Claude figures are Anthropic list-price equivalents of subscription usage (quota), not a bill. "
        "Avoided = hswarm jobs (low) or tasks (high) x the median cost of one real Claude sub-agent here. "
        "Share = avoided / (avoided + Claude actually used). '-' means not measured. * = today so far.")


def daily_path():
    return config.HOME / "savings-daily.jsonl"


def log(message: str) -> None:
    """The scheduled run has no console, so it leaves a line behind instead."""
    config.HOME.mkdir(parents=True, exist_ok=True)
    with (config.HOME / "savings.log").open("a", encoding="utf-8") as f:
        f.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {message}\n")


def lower_priority() -> None:
    """The scan reads gigabytes of transcripts; on a shared box it yields to interactive work."""
    if os.name == "nt":
        import ctypes

        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    else:
        os.nice(10)


KIT_CURRENT_SLACK_MS = 5 * 60_000  # a few of the daemon's one-minute sweeps


def kit_claude_by_day(since: dt.date, end: dt.date) -> dict[str, dict] | None:
    """Claude's per-day USD and tokens on this PC from the AgentHydra analytics kit, or None when the kit cannot say.

    None means the daemon does not answer (AGENTHYDRA_URL, else the default port; empty disables it) OR the kit has
    ingested no Claude events yet, none old enough for the window, or has not caught up to the window's end, so a low figure would pass for a true one.
    The caller then runs the transcript scan (claude_usage.py): that is HSwarm's own path when it runs without
    AgentHydra, not a fallback for old builds. Asking by the machine's own day buckets (no tz) with pc=self keeps
    it this PC's usage, as the scan is.
    """
    base = os.environ.get("AGENTHYDRA_URL", DEFAULT_AGENTHYDRA_URL).rstrip("/")
    if not base:
        return None
    ms = lambda d: int(dt.datetime.combine(d, dt.time.min).astimezone().timestamp() * 1000)  # noqa: E731
    query = urllib.parse.urlencode({"source": KIT_SOURCES, "groupBy": "day,model", "pc": "self",
                                    "from": ms(since), "to": ms(end + dt.timedelta(1)) - 1, "measures": "tokens,list_usd"})
    try:
        with urllib.request.urlopen(f"{base}/api/kit/usage?{query}", timeout=KIT_TIMEOUT_S) as resp:
            data = json.load(resp)
        seen = [v for k, v in data["coverage"]["sources"].items() if k in KIT_SOURCES.split(",") and v.get("events")]
        if not seen or min(v["firstTs"] for v in seen) > ms(since):
            return None
        # Caught up to the window's end too: a daemon stopped overnight (or mid first sweep) has the old events but
        # not the recent ones, and a low day stored now would never be re-measured. The newest event (or transcript
        # mtime the sweep has read) must reach the window end, less a few sweep intervals, capped at now.
        target = min(ms(end + dt.timedelta(1)) - 1, int(time.time() * 1000)) - KIT_CURRENT_SLACK_MS
        newest = max([v["lastTs"] for v in seen] + [data["coverage"].get("cursors", {}).get("newestMtime") or 0])
        if newest < target:
            return None
        out: dict[str, dict] = {}
        for r in data["rows"]:
            d = out.setdefault(r["day"], {"claude_usd": 0.0, "claude_tokens": 0})
            d["claude_usd"] += r.get("list_usd") or 0.0
            d["claude_tokens"] += int(r.get("tokens") or 0)
        return out
    except (OSError, ValueError, KeyError, TypeError):  # URLError is an OSError; a bad body or shape is not the kit's answer
        return None


def hswarm_by_day(since: dt.date, today: dt.date) -> dict[str, dict]:
    """Ledger rows grouped by local day: tasks, distinct jobs, DeepSeek USD (tasks with no cost counted apart)."""
    out: dict[str, dict] = {}
    for r in ledger_rows(days=(today - since).days + 2):
        day = dt.datetime.fromisoformat(r["ts"]).astimezone().date().isoformat()
        if day < since.isoformat() or r.get("cached"):
            continue  # a `cached` line is a resume reusing an answer already counted on the day it ran
        d = out.setdefault(day, {"tasks": 0, "jobs": set(), "deepseek_usd": 0.0, "cost_unknown_tasks": 0})
        d["tasks"] += 1
        d["jobs"].add(r.get("job"))
        if r.get("cost_usd") is None:
            d["cost_unknown_tasks"] += 1
        else:
            d["deepseek_usd"] += r["cost_usd"]
    return {k: v | {"jobs": len(v["jobs"]), "deepseek_usd": round(v["deepseek_usd"], 6)} for k, v in out.items()}


def day_row(day: str, claude: dict | None, swarm: dict | None, kit: dict | None = None) -> dict:
    """`kit` is the kit's {day: {claude_usd, claude_tokens}} when it answered for the window, else None (then the
    scan's own totals stand). The scan still supplies what the kit has no field for: the per-sub-agent costs the
    counterfactual is measured from, and the per-session token split the per-account view is built from."""
    c, s = claude or claude_usage.empty_day(), swarm or {}
    if kit is None:
        used = {"claude_usd": c["claude_usd"], "claude_tokens": sum(c.get("tokens", {}).values()), "claude_source": "scan"}
    else:
        used = {"claude_usd": round(kit.get(day, {}).get("claude_usd", 0.0), 6), "claude_tokens": kit.get(day, {}).get("claude_tokens", 0),
                "claude_source": "kit"}
    return {"day": day, "deepseek_usd": s.get("deepseek_usd", 0.0), "hswarm_tasks": s.get("tasks", 0),
            "hswarm_jobs": s.get("jobs", 0), "hswarm_cost_unknown_tasks": s.get("cost_unknown_tasks", 0),
            **used, "claude_main_usd": c["main_usd"], "claude_sub_usd": c["sub_usd"],
            "claude_requests": c["requests"], "claude_unpriced_requests": c["unpriced_requests"], "subagent_usd": c["agents"],
            "agent_tokens": c.get("agent_tokens", {}), "by_model": c.get("by_model", {}),
            # The day's own token buckets, and the same split per session: what the per-account view is built from.
            "tokens": c.get("tokens", {}), "by_session": c.get("by_session", {})}


def measure(start: dt.date, end: dt.date, today: dt.date) -> dict[str, dict]:
    claude, swarm, kit = claude_usage.collect(start, end), hswarm_by_day(start, today), kit_claude_by_day(start, end)
    days = [(start + dt.timedelta(n)).isoformat() for n in range((end - start).days + 1)]
    return {d: day_row(d, claude.get(d), swarm.get(d), kit) for d in days}


def load_rows() -> dict[str, dict]:
    rows: dict[str, dict] = {}
    if daily_path().exists():
        for line in daily_path().read_text(encoding="utf-8").splitlines():
            try:
                r = json.loads(line)
                rows[r["day"]] = r
            except (ValueError, KeyError, TypeError):
                continue
    return rows


def save_rows(rows: dict[str, dict]) -> None:
    config.HOME.mkdir(parents=True, exist_ok=True)
    tmp = daily_path().with_suffix(".jsonl.tmp")
    tmp.write_text("".join(json.dumps(rows[k]) + "\n" for k in sorted(rows)), encoding="utf-8")
    os.replace(tmp, daily_path())


def stale_token_days(rows: dict[str, dict], today: dt.date, window: int = POOL_DAYS) -> list[str]:
    """Recorded days from the last `window` days that were measured before token counts existed. They are
    re-measured once, so the per-account and per-token views cover history and not only days from here on."""
    floor, stop = (today - dt.timedelta(window)).isoformat(), today.isoformat()
    # Completed days only: a day that is still being written has no window to re-measure, so flagging it
    # would re-scan the same day every single run and never clear.
    return sorted(d for d, r in rows.items() if floor <= d < stop and not r.get("tokens"))


def record(backfill: int = BACKFILL_DAYS, today: dt.date | None = None) -> list[str]:
    """Measure every completed day not yet on record (on the first run, the last `backfill` days). Idempotent."""
    today = today or dt.date.today()
    rows = load_rows()
    start = dt.date.fromisoformat(max(rows)) + dt.timedelta(1) if rows else today - dt.timedelta(backfill)
    end = today - dt.timedelta(1)
    fresh: dict[str, dict] = {}
    if start <= end:
        try:
            fresh = measure(start, end, today)
        except Exception:
            log("record failed:\n" + traceback.format_exc())
            raise
        rows.update(fresh)
        save_rows(rows)
    stale = stale_token_days(rows, today)
    if stale:
        log(f"token backfill: re-measuring {len(stale)} day(s) recorded before tokens were counted ({stale[0]}..{stale[-1]})")
        remeasure((today - dt.date.fromisoformat(stale[0])).days, today)
        rows = load_rows()
    from . import utilization

    ordered = [rows[k] for k in sorted(rows)]
    # Every completed day's Claude usage sits in the utilization DB too, so a saving can be read as a share of it.
    utilization.record_claude_days(ordered)
    # The recorded days carry every sub-agent's token buckets: that is what sizes the per-utilization estimate.
    if fresh or utilization.current_profile(utilization.connect()) is None:
        prof = utilization.refresh_profile(ordered)
        log(f"profile {prof['id'] + ' (' + prof['basis'] + ' x' + str(prof['sample']) + ', repriced ' + str(prof['repriced']) + ')' if prof else 'not measured: fewer than 5 sub-agents on record'}")
    return sorted(fresh)


def remeasure(days: int, today: dt.date | None = None) -> list[str]:
    """Re-scan the last `days` completed days and overwrite their rows (after a scanner learns a new field, the
    history should carry it too). Refreshes the Claude-days table; leaves the profile and priced rows alone."""
    today = today or dt.date.today()
    start, end = today - dt.timedelta(days), today - dt.timedelta(1)
    fresh = measure(start, end, today)
    rows = load_rows()
    rows.update(fresh)
    save_rows(rows)
    from . import utilization

    utilization.record_claude_days([rows[k] for k in sorted(rows)])
    return sorted(fresh)


def counterfactual(rows: list[dict]) -> dict:
    """Median API-equivalent USD of one real Claude sub-agent across the pooled days."""
    pool = rows[-POOL_DAYS:]
    sonnet = [u for r in pool for u in r["subagent_usd"].get("sonnet", [])]
    every = [u for r in pool for fam in r["subagent_usd"].values() for u in fam]
    basis, sample = ("Sonnet sub-agents", sonnet) if len(sonnet) >= MIN_POOL else ("all sub-agents", every)
    if len(sample) < MIN_POOL:
        return {"usd": None, "basis": f"not measured, only {len(sample)} sub-agents on record", "sample": len(sample)}
    return {"usd": round(statistics.median(sample), 4), "basis": basis, "sample": len(sample)}


def _share(avoided: float, used: float) -> float:
    return round(avoided / (avoided + used), 4) if avoided + used else 0.0


def saving(r: dict, per_agent: float | None) -> dict:
    out = {k: r[k] for k in ("day", "deepseek_usd", "hswarm_tasks", "hswarm_jobs", "claude_usd", "claude_sub_usd")}
    out["claude_source"] = r.get("claude_source", "scan")  # rows recorded before the kit existed came from the scan
    if "claude_tokens" in r:
        out["claude_tokens"] = r["claude_tokens"]
    out["claude_subagents"] = sum(len(v) for v in r["subagent_usd"].values())
    if r.get("partial"):
        out["partial"] = True
    if per_agent is None:
        return out
    low, high = r["hswarm_jobs"] * per_agent, r["hswarm_tasks"] * per_agent
    return out | {"avoided_low_usd": round(low, 4), "avoided_high_usd": round(high, 4),
                  "net_saved_low_usd": round(low - r["deepseek_usd"], 4), "net_saved_high_usd": round(high - r["deepseek_usd"], 4),
                  "claude_share_displaced_low": _share(low, r["claude_usd"]), "claude_share_displaced_high": _share(high, r["claude_usd"])}


def totals(days: list[dict]) -> dict:
    vals = {k: [d.get(k) for d in days] for k in SUMMED}
    return {"days": len(days)} | {k: None if not v or None in v else round(sum(v), 4) for k, v in vals.items()}


def month(days: list[dict]) -> dict | None:
    """30-day projection from the completed days since the hswarm was first used; None before any use."""
    done = [d for d in days if not d.get("partial")]
    first = next((i for i, d in enumerate(done) if d["hswarm_tasks"]), None)
    if first is None:
        return None
    t = totals(done[first:])
    return {"active_days": t["days"]} | {k: None if t[k] is None else round(t[k] / t["days"] * 30, 2) for k in SUMMED if k.endswith("_usd")}


def report(days: int = 14, include_today: bool = True, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    rows = [r for _, r in sorted(load_rows().items())]
    from . import utilization

    if include_today:
        rows.append(measure(today, today, today)[today.isoformat()] | {"partial": True})
        utilization.record_claude_days([rows[-1]], partial=True)  # today's live figure feeds the share too
    cf = counterfactual([r for r in rows if not r.get("partial")] or rows)
    shown = [saving(r, cf["usd"]) for r in rows[-days:]]
    return {"running_total": utilization.summary(10), "per_subagent": cf, "days": shown, "claude_source": shown[-1]["claude_source"] if shown else "scan", "totals": totals(shown), "month": month(shown), "note": NOTE, "file": str(daily_path())}
