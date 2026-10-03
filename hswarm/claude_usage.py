"""Claude Code's own usage on this machine, read from its transcripts and priced at Anthropic's list
rates, so a Claude sub-agent and a hswarm task can be compared in one unit.

A subscription bills quota, not dollars; the API-equivalent dollar is simply the unit both sides
share. Three reading rules, each learned the hard way by Connections' token-cost-report (reconciled
against ccusage to 0.18%):
  - one API request is stamped on several transcript lines, so each requestId counts once;
  - the same request is replayed into several files (resume, fork, sub-agent dirs), so the dedupe is
    global, and main transcripts are read first so a replayed parent request is never billed to a
    sub-agent;
  - file mtime only prefilters; every record is bucketed by its own timestamp, in local days.

The scan has three implementations that must agree on every number: the pure-Python one here (the
reference), and the Rust and Go binaries under native/ (see native.py), which bench/native_ab.py
measures against it for wall time, CPU and memory. `collect()` runs the recorded winner when its
binary is built and falls back to Python otherwise, so a fresh clone works with no toolchain.
"""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path

PROJECTS = Path(os.environ.get("HSWARM_CLAUDE_PROJECTS") or (Path.home() / ".claude" / "projects"))
LONG_PATH_PREFIX = "\\\\?\\" if os.name == "nt" else ""  # sub-agent transcripts nest past Windows' 260-char limit
SUBAGENT_DIR = f"{os.sep}subagents{os.sep}"

# (model-id prefix, USD per 1M input, per 1M output, cache-read multiplier): Anthropic first-party list
# prices from the claude-api skill, checked 2026-09-15. Cache writes cost 1.25x input on the 5-minute TTL
# and 2x on the 1-hour TTL. The first matching prefix wins, so a longer id sits above its shorter stem.
PRICES = (
    ("claude-fable-5-1", 10.0, 50.0, 0.025),
    ("claude-fable-5", 10.0, 50.0, 0.1),
    ("claude-opus-5", 5.0, 25.0, 0.1),
    ("claude-opus-4-8", 5.0, 25.0, 0.1),
    ("claude-opus-4-7", 5.0, 25.0, 0.1),
    ("claude-opus-4-6", 5.0, 25.0, 0.1),
    ("claude-sonnet-5", 2.0, 10.0, 0.1),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.1),
    ("claude-haiku-4-5", 1.0, 5.0, 0.1),
)
TOKEN_FIELDS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
# The five buckets one Anthropic request bills, in the order the price formula weighs them.
TOKEN_KEYS = ("input", "cache_read", "cache_5m", "cache_1h", "output")


def _n(usage: dict, key: str) -> int:
    v = usage.get(key)
    return v if isinstance(v, int) else 0


def split_tokens(usage: dict) -> dict:
    """One request's usage as the five billable buckets: cache writes split by TTL (1.25x on 5 min, 2x on 1 h)."""
    cc = usage.get("cache_creation")
    w1h = _n(cc, "ephemeral_1h_input_tokens") if isinstance(cc, dict) else 0  # a bare number here crashed the scan (found by the Go port's edge fixture, 2026-09-15)
    return {"input": _n(usage, "input_tokens"), "cache_read": _n(usage, "cache_read_input_tokens"),
            "cache_5m": max(_n(usage, "cache_creation_input_tokens") - w1h, 0), "cache_1h": w1h, "output": _n(usage, "output_tokens")}


def price_tokens(model: str, t: dict) -> float | None:
    """API-equivalent USD of the token buckets on `model`; None for a model with no known price ("not measured", never zero)."""
    match = next((p for p in PRICES if model.startswith(p[0])), None)
    if match is None:
        return None
    _, inp, out, read_x = match
    weighted_in = t["input"] + t["cache_read"] * read_x + t["cache_5m"] * 1.25 + t["cache_1h"] * 2.0
    return (weighted_in * inp + t["output"] * out) / 1_000_000


def price_request(model: str, usage: dict) -> float | None:
    """API-equivalent USD of one request; None for a model with no known price."""
    return price_tokens(model, split_tokens(usage))


def family(model: str) -> str:
    return next((f for f in ("sonnet", "opus", "fable", "haiku") if f in model), "other")


def empty_tokens() -> dict:
    return dict.fromkeys(TOKEN_KEYS, 0)


def empty_day() -> dict:
    return {"claude_usd": 0.0, "main_usd": 0.0, "sub_usd": 0.0, "requests": 0, "unpriced_requests": 0, "agents": {}, "agent_tokens": {},
            "by_model": {}, "tokens": empty_tokens(), "by_session": {}}


def empty_model() -> dict:
    """Per model id, per day: how many requests, the USD split main loop vs sub-agents, how many sub-agents ran on it,
    and the token buckets they ran through (the tokens are counted whether or not the model has a list price)."""
    return {"requests": 0, "usd": 0.0, "main_usd": 0.0, "sub_usd": 0.0, "agents": 0, "tokens": empty_tokens()}


def empty_session() -> dict:
    """Per session id, per day: what that one chat ran. Sessions are what an account is recognised by (accounts.py)."""
    return {"usd": 0.0, "requests": 0, "tokens": empty_tokens()}


def transcripts(root: Path, since_ts: float) -> list[str]:
    """Every .jsonl under root written since since_ts, main transcripts before sub-agent ones."""
    main: list[str] = []
    sub: list[str] = []
    for dirpath, _dirs, names in os.walk(LONG_PATH_PREFIX + str(Path(root).resolve())):
        for name in names:
            path = os.path.join(dirpath, name)
            try:
                fresh = name.endswith(".jsonl") and os.stat(path).st_mtime >= since_ts
            except OSError:
                continue
            if fresh:
                (sub if SUBAGENT_DIR in path else main).append(path)
    return main + sub


def session_of(path: str) -> str:
    """The FULL session id a transcript belongs to: the file's own stem for a main transcript, and the directory
    after the project slug for a sub-agent one (projects/<slug>/<session-id>/subagents/...). "" when neither
    shape fits. Full, not shortened, because this is what an account is looked up by (accounts.py)."""
    norm = path.replace("/", os.sep)
    if SUBAGENT_DIR not in norm:
        return os.path.basename(norm).removesuffix(".jsonl")
    parts = norm.split(os.sep)
    try:
        i = parts.index("projects")
    except ValueError:
        return ""
    return parts[i + 2] if len(parts) > i + 2 else ""


def agent_session(path: str) -> str:
    """The session a sub-agent transcript belongs to, as the rule check matches it: the first 8 characters, the
    length the routing gate's log writes."""
    return session_of(path)[:8]


def _quick_request_id(line: str) -> str | None:
    """The requestId without a JSON parse: replayed history is most of the corpus and is skipped on sight."""
    i = line.find('"requestId":"')
    if i < 0:
        return None
    start = i + len('"requestId":"')
    return line[start:line.find('"', start)]


class _Collector:
    def __init__(self, since: dt.date, until: dt.date):
        self.since, self.until = since.isoformat(), until.isoformat()
        self.seen: set[str] = set()
        self.days: dict[str, dict] = {}
        self.agents: dict[str, dict] = {}
        self.local_days: dict[str, str | None] = {}

    def read(self, path: str) -> None:
        agent = path if SUBAGENT_DIR in path else None
        session = session_of(path)
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"usage"' in line and _quick_request_id(line) not in self.seen:
                        self.record(line, agent, session)
        except OSError:
            return

    def local_day(self, ts: str) -> str | None:
        key = ts[:16]  # parsing every timestamp is the hot path; a minute always maps to one local day
        if key not in self.local_days:
            try:
                self.local_days[key] = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().date().isoformat()
            except ValueError:
                self.local_days[key] = None
        return self.local_days[key]

    def record(self, line: str, agent: str | None, session: str = "") -> None:
        try:
            rec = json.loads(line)
        except ValueError:
            return
        msg = rec.get("message") if isinstance(rec, dict) else None
        usage = msg.get("usage") if isinstance(msg, dict) else None
        rid = rec.get("requestId") or (msg or {}).get("id") if isinstance(usage, dict) else None
        if not rid or rid in self.seen or not any(_n(usage, k) for k in TOKEN_FIELDS):
            return
        ts = str(rec.get("timestamp") or "")
        day = self.local_day(ts)
        if day is None or not self.since <= day <= self.until:
            return
        self.seen.add(rid)
        self.add(day, str(msg.get("model") or ""), usage, agent, ts, session)

    def add(self, day: str, model: str, usage: dict, agent: str | None, ts: str = "", session: str = "") -> None:
        d = self.days.setdefault(day, empty_day())
        d["requests"] += 1
        m = d["by_model"].setdefault(model, empty_model())
        m["requests"] += 1
        t = split_tokens(usage)
        s = d["by_session"].setdefault(session, empty_session()) if session else None
        if s is not None:
            s["requests"] += 1
        for k in TOKEN_KEYS:  # tokens are counted before the price: a model with no list price still ran them
            d["tokens"][k] += t[k]
            m["tokens"][k] += t[k]
            if s is not None:
                s["tokens"][k] += t[k]
        usd = price_tokens(model, t)
        if usd is None:
            d["unpriced_requests"] += 1
            return
        if s is not None:
            s["usd"] += usd
        d["claude_usd"] += usd
        d["sub_usd" if agent else "main_usd"] += usd
        m["usd"] += usd
        m["sub_usd" if agent else "main_usd"] += usd
        if agent:
            a = self.agents.setdefault(agent, {"day": day, "family": family(model), "model": model, "session": agent_session(agent), "started": ts,
                                               "workflow": f"{os.sep}workflows{os.sep}" in agent, "usd": 0.0, "tokens": dict.fromkeys(TOKEN_KEYS, 0), "requests": 0})
            a["usd"] += usd
            a["requests"] += 1
            for k in TOKEN_KEYS:
                a["tokens"][k] += t[k]

    def finish(self) -> dict[str, dict]:
        for a in self.agents.values():  # a sub-agent belongs to the day it started, and to the model of its first priced request
            d = self.days[a["day"]]
            d["agents"].setdefault(a["family"], []).append(round(a["usd"], 4))
            # The token buckets size the profile; model, session, start and kind are what the daily rule check reads.
            d["agent_tokens"].setdefault(a["family"], []).append(a["tokens"] | {"requests": a["requests"], "model": a["model"], "session": a["session"],
                                                                                "started": a["started"], "workflow": a["workflow"], "usd": round(a["usd"], 4)})
            d["by_model"].setdefault(a["model"], empty_model())["agents"] += 1
        for d in self.days.values():
            for k in ("claude_usd", "main_usd", "sub_usd"):
                d[k] = round(d[k], 4)
            for m in d["by_model"].values():
                for k in ("usd", "main_usd", "sub_usd"):
                    m[k] = round(m[k], 4)
            for s in d["by_session"].values():
                s["usd"] = round(s["usd"], 4)
        return self.days


def collect_python(since: dt.date, until: dt.date, root: Path | None = None) -> dict[str, dict]:
    """The reference scan, pure Python."""
    c = _Collector(since, until)
    start_ts = dt.datetime.combine(since, dt.time.min).astimezone().timestamp()
    for path in transcripts(root or PROJECTS, start_ts):
        c.read(path)
    return c.finish()


def collect(since: dt.date, until: dt.date, root: Path | None = None, scanner: str | None = None) -> dict[str, dict]:
    """Per local day in [since, until]: Claude's API-equivalent USD split main loop vs sub-agents, request
    counts, and for every sub-agent that started that day its USD and token buckets, grouped by model family.

    `scanner` (or HSWARM_SCANNER) picks python | rust | go; unset, the recorded A/B winner runs when its
    binary is built, else Python. Every arm returns the same numbers (bench/native_ab.py checks that).

    A binary built before a field existed would silently drop it, so an auto-chosen arm that answers
    without token counts is not trusted: Python re-runs the same window. An arm asked for BY NAME is
    never second-guessed - the A/B must be able to measure exactly what it asked for."""
    from . import native

    lang = native.choose(scanner)
    if lang == "python":
        return collect_python(since, until, root)
    days = native.scan(lang, root or PROJECTS, since, until)["days"]
    if scanner or not days or all("tokens" in d for d in days.values()):
        return days
    native.log_stale(lang)
    return collect_python(since, until, root)
