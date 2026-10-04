"""Published benchmark eligibility and cost ordering, independent of model calls.

Floors below are operational policy, not probabilities of success. CritPt is under review
and intentionally never qualifies a route. Evidence carries exact model/effort identities.
"""
from __future__ import annotations

import json
import math
import os
import time
from functools import lru_cache
from importlib.resources import files

PROFILES = {
    "routine": {"humanitys-last-exam": .19},
    "general": {"humanitys-last-exam": .30, "long-context": .75},
    "code": {"terminalbench-4-0": .30, "scicode": .50},
    "decision": {"gdpval-aa": 1400, "automationbench-aa": .60},
    "research": {"humanitys-last-exam": .45, "long-context": .80},
    "critical": {"terminalbench-4-0": .50, "humanitys-last-exam": .50, "gdpval-aa": 1700},
}

# WHAT THE TASK'S OUTPUT IS FOR - a capability of the ROUTE, not of the model, because some providers' own terms
# limit what their answers may be used for. A provider file that says `evaluation_only = true` (NVIDIA's trial
# keys: "internal testing and evaluation only", and it may train on what it is sent) is served only a task that
# declares `purpose = "evaluation"`; every other task routes past it. It is the honest reading of the terms, and
# it costs the free tier nothing it is allowed to have: evals, benchmarks, probes and second opinions still go
# there first, ahead of every paid route.
#
# `production` is the DEFAULT because the unmarked case is the dangerous one: an agent that forgets the field gets
# a paid route (safe, a few cents), never a terms-breaching one. Owner, Michael, 2026-09-29, on the free tier:
# "I'm not gonna flag off it or disable it if it functions. However, you can certainly wire in route capabilities
# ... and then route it to where you think or need it should go."
PURPOSES = {
    "production": "the answer ships, or is read into work that ships (code, copy, translations, a decision)",
    "evaluation": "the answer is only measured or compared: a benchmark, an eval, a probe, a spike, a scratch test",
}

# Model families AUTO never picks, on any leg: evaluated, sibling or backup. Haiku only: the 2026-09-24 never-Sonnet
# ruling was retired on 2026-10-03 because it predated Sonnet 5.5, so Sonnet is an ordinary AUTO candidate again and
# the benchmark order decides. Naming the model (`model=`) is the explicit override: a pinned model never goes through
# this plan.
AUTO_BARRED_FAMILIES = ("claude-haiku",)


def auto_barred(entry) -> bool:
    """True when the model belongs to a family AUTO never picks, read off its benchmark slug and its API id."""
    ids = (entry.get("benchmark_slug") or "", (entry.get("api_id") or "").rsplit("/", 1)[-1])
    return any(i.startswith(AUTO_BARRED_FAMILIES) for i in ids)


@lru_cache(maxsize=1)
def evidence():
    """The published benchmark scores and costs, by slug."""
    return json.loads(files("hswarm").joinpath("data", "published-models.json").read_text(encoding="utf-8"))


def auto_models():
    """The models AUTO can rank: every registered model whose provider file names a `benchmark_slug`."""
    from . import config

    return [(n, m) for n, m in config.MODELS.items() if m.get("benchmark_slug")]


def priority_rank(model):
    """The model's priority number (config.PRIORITY, starred in `hswarm ui`); unnumbered models tie after every
    numbered one, so with none set the cost order stands."""
    from . import config

    return config.PRIORITY.get(model, math.inf)


def profile_for(role=None, tools="none"):
    from . import config

    if role and role not in ("default", "vision"):
        profiles = {"code": "code", "judge": "decision", "summarize": "general", "search": "research", "review": "code",
                    # grader and doubt judge what they are handed; refute must read the repo to disprove a finding
                    "grader": "decision", "refute": "code", "doubt": "decision"}
        if role in PROFILES:
            return role
        if role not in profiles:
            raise ValueError(f"unknown role {role!r}")
        return profiles[role]
    return "general" if config.is_tool_free(tools) else "code"


# Owner, Michael, 2026-09-25: "When something is out of keys, we always advance to the next model in the list
# instead of just... stop." An evaluated model's same-provider siblings are the last legs of its plan: a provider
# rate-limits each model on its own (Gemini's per-model, per-region quota saturated 3.8 Flash that afternoon while
# 3.7 Flash, 3.5 Flash and 3.5 Flash-Lite all answered), so a task advances onto them instead of dying. They carry
# no benchmark evidence of their own: they come after every evaluated candidate and are marked `unevidenced`, and
# the orchestrator's acceptance check judges their answer. A model lists them as `siblings` in its provider file.


def _last_resort(candidates, *, excluded=(), usable=None, min_context=0, profile="general", tools="none", backend="api", vision=False,
                 strict=False, purpose="production"):
    from . import config

    have, extra = {c["model"] for c in candidates}, []
    # A backup route is picked by provider health, not by evidence, so the purpose gate has to be repeated here or a
    # task whose tested routes are all busy would fall onto a provider its terms bar (see PURPOSES). The sibling loop
    # below needs no such guard: a sibling is on the SAME provider as a candidate that already passed the gate.
    barred = lambda entry: purpose != "evaluation" and bool(config.PROVIDERS[entry["provider"]].get("evaluation_only"))  # noqa: E731

    def unfit(entry) -> bool:  # what the task needs that the model's file does not say it can do
        return ((not config.is_tool_free(tools) and not entry.get("tools")) or (vision and not entry.get("vision"))
                or (min_context and entry.get("ctx", 0) < min_context)
                or (backend == "cc" and not config.PROVIDERS[entry["provider"]].get("anthropic_url")))

    for c in candidates:
        for name in config.MODELS.get(c["model"], {}).get("siblings") or ():
            entry = config.MODELS.get(name)
            if not entry or name in have or name in excluded or entry["provider"] != c["provider"] or name in config.DISABLED_MODELS:
                continue
            if auto_barred(entry):
                continue
            if unfit(entry) or (usable is not None and not usable(entry["provider"])):
                continue
            have.add(name)
            extra.append({**c, "model": name, "configuration": f"{name} (unevidenced sibling of {c['configuration']})",
                          "rates": config.price(name), "unevidenced": True})
    # Backups (owner, 2026-09-26: "why do I have to have other AIs making decisions?"): a model its provider file marks
    # `backup = true` runs after every tested leg and sibling, on any provider with a ready key, so a task whose tested
    # routes are all busy or dead moves onto capacity that is up instead of waiting or dying. Only in a live plan (one that
    # knows which keys work), never for a critical task or one that demands an effort or scores (strict), and only where it
    # fits (tools, images, context, a cc worker's endpoint).
    for name, entry in config.MODELS.items():
        if usable is None or strict or profile == "critical" or not entry.get("backup") or name in have or name in excluded or name in config.DISABLED_MODELS:
            continue
        if barred(entry) or auto_barred(entry):
            continue
        p = entry["provider"]
        if not config.provider_enabled(p) or (usable is not None and not usable(p)):
            continue
        if unfit(entry):
            continue
        have.add(name)
        extra.append({"model": name, "reasoning_effort": None, "thinking": None, "benchmark_slug": "", "score": None,
                      "benchmark_cost_usd": None, "source": "", "scores": {}, "rates": config.price(name), "provider": p,
                      "configuration": f"{name} (backup on {p}, without test scores of its own)", "unevidenced": True, "backup": True})
    return extra


def plan(profile="general", *, tools="none", backend="api", usable=None, reasoning_effort=None,
         thinking=None, min_scores=None, exclude_models=(), min_context=0, vision=False, purpose="production", zdr=False):
    from . import config, zdr as zdr_mod

    if profile not in PROFILES:
        raise ValueError(f"unknown capability profile {profile!r}; choose {sorted(PROFILES)}")
    if purpose not in PURPOSES:
        raise ValueError(f"unknown purpose {purpose!r}; choose {sorted(PURPOSES)}")
    if backend not in ("api", "cc"):
        raise ValueError(f"unknown backend {backend!r}")
    if profile == "routine" and not config.is_tool_free(tools):
        raise ValueError("routine is tool-free only; tool work requires a stronger capability profile")
    data = evidence()
    points = {p["slug"]: p for p in data["points"]}
    floors = dict(PROFILES[profile])
    valid = set(next(iter(points.values()))["scores"]) - {"critpt"}
    for key, value in (min_scores or {}).items():
        if key not in valid or not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError(f"invalid score requirement {key!r}; CritPt is excluded while under review")
        floors[key] = max(floors.get(key, float("-inf")), value)
    excluded = set(exclude_models or ())
    # Every route that is not a candidate is named in `rejected` with the FIRST filter it failed, in the order
    # below, so "why was X skipped" is answered by the plan (and the job result carrying it), not by a re-run.
    candidates, rejected = [], []
    identity = ("benchmark_slug", "api_id", "provider", "default_reasoning_effort", "default_thinking")
    for name, entry in auto_models():
        p = points.get(entry["benchmark_slug"])
        # A user's file must not keep a shipped model's evidence while changing the model or effort it runs.
        expected = config.BUILTIN_MODELS.get(name, entry)
        short = [k for k, v in floors.items() if p and (p["scores"].get(k) is None or p["scores"][k] < v)]
        effort = entry.get("default_reasoning_effort")
        if name in config.DISABLED_MODELS or not config.provider_enabled(entry["provider"]):
            why = ("disabled", "switched off in settings")
        elif auto_barred(entry):
            why = ("family", "Claude Haiku is never picked automatically; name the model to use one")
        elif purpose != "evaluation" and config.PROVIDERS[entry["provider"]].get("evaluation_only"):
            why = ("purpose", f"{entry['provider']}'s own terms allow evaluation only; this task's purpose is {purpose!r}")
        elif not p:
            why = ("evidence", f"no published scores for {entry['benchmark_slug']}")
        elif zdr and (zdr_why := zdr_mod.refusal(name)):
            why = ("zdr", zdr_why)
        elif name in excluded or p["slug"] in excluded or entry.get("api_id") in excluded:
            why = ("excluded", "named in exclude_models")
        elif any(entry.get(k) != expected.get(k) for k in identity):
            why = ("identity", "a user file changed model or effort: " + ", ".join(k for k in identity if entry.get(k) != expected.get(k)))
        elif short:
            why = ("floor", "below " + ", ".join(f"{k} {floors[k]}" for k in short))
        elif reasoning_effort is not None and effort != reasoning_effort:
            why = ("effort", f"runs at {effort}, not {reasoning_effort}")
        elif thinking is False and entry.get("default_thinking") is not False:
            why = ("thinking", "cannot run with thinking off")
        elif not config.is_tool_free(tools) and not entry.get("tools"):
            why = ("tools", "no tool calling")
        elif vision and not entry.get("vision"):
            why = ("vision", "cannot read images")
        elif min_context and entry.get("ctx", 0) < min_context:
            why = ("context", f"ctx {entry.get('ctx', 0)} < {min_context}")
        elif backend == "cc" and (not config.PROVIDERS[entry["provider"]].get("anthropic_url") or not entry.get("cc_effort")):
            why = ("backend", "no verified Anthropic endpoint and effort transport for cc")
        elif usable is not None and not usable(entry["provider"]):
            why = ("usable", f"{entry['provider']} has no key ready")
        else:
            why = None
        if why:
            rejected.append({"model": name, "filter": why[0], "reason": why[1]})
            continue
        factor = .5 if entry["provider"] == "deepseek" and not config.is_peak() else 1
        candidates.append({"model": name, "reasoning_effort": effort, "thinking": entry.get("default_thinking"),
                           "benchmark_slug": p["slug"], "score": p["score"], "benchmark_cost_usd": p["cost"]*factor,
                           "source": p["source"], "scores": {k: p["scores"][k] for k in floors},
                           "rates": config.price(name), "provider": entry["provider"], "configuration": p["name"],
                           "free": bool(config.PROVIDERS[entry["provider"]].get("free_calls"))})
    # A provider whose calls cost nothing (`free_calls`, NVIDIA's trial keys) serves first; among free routes, and among
    # paid ones, the cheapest capable model still goes first, so a free route never means a bigger model than needed.
    candidates.sort(key=lambda c: (priority_rank(c["model"]), not c["free"], c["benchmark_cost_usd"], -c["score"], c["model"]))
    last = _last_resort(candidates, excluded=excluded, usable=usable, min_context=min_context, profile=profile,
                        tools=tools, backend=backend, vision=vision, strict=reasoning_effort is not None or bool(min_scores),
                        purpose=purpose)
    if zdr:  # a backup route is picked by provider health, so the clearance is repeated here
        last = [c for c in last if zdr_mod.cleared(c["model"])]
    candidates += last
    return {"profile": profile, "purpose": purpose, "evidence_date": data["as_of_utc"], "candidates": candidates,
            "requirements": floors, "rejected": rejected,
            "explanation": "Cheapest observed benchmark cost among configurations meeting every task score floor; route availability is checked separately.",
            "warnings": ["Floors are operational policy, not a guarantee; the orchestrator verifies task acceptance.",
                         "Benchmark cost is a workload estimate, not the production bill; prices and provider behavior can change.",
                         "CritPt is under review and excluded from eligibility; cc admits only verified effort transport."]}


# ---- load bias: steer the ORDER of capable candidates by live load, never their evidence ----
# The idea is DeepSeek-V3's MoE gate (a per-expert bias picks the top-k, the unbiased score weighs them), written
# fresh here: per provider, this process counts the tasks committed to it and its recent slow/saturated marks.
_INFLIGHT: dict[str, int] = {}
_SLOW: dict[str, list[float]] = {}
# A leg that ended with every key rate-limited (client._rate_limited_message) left no mark at all, so the next task
# ranked the same exhausted model first and waited its 30 s again: 7,878 such legs and 68 task-hours in the week to
# 2026-10-02, 872 of 1,862 gemini-3-8-flash first legs. It counts against the provider here and marks the MODEL in
# note_speed, because a provider rate-limits each model on its own.
_RATE_LIMITED = "every key is rate-limited"
_SLOW_ERRORS = ("SlowLeg:", "PoolSaturated", "GateQueued:", _RATE_LIMITED)


def claim(provider):
    if provider:
        _INFLIGHT[provider] = _INFLIGHT.get(provider, 0) + 1


def release(provider):
    if provider and _INFLIGHT.get(provider):
        _INFLIGHT[provider] -= 1


def note_result(provider, error, now=None):
    """A leg that crawled or found every key resting counts against its provider for config.SLOW_MARK_S."""
    if provider and error and any(s in error for s in _SLOW_ERRORS):
        _SLOW.setdefault(provider, []).append(time.monotonic() if now is None else now)


def reset_load():
    _INFLIGHT.clear(), _SLOW.clear(), _CRAWL.clear()
    _CRAWL_SEEN[0] = None
    _crawl_path().unlink(missing_ok=True)


# Per MODEL, not per provider: NVIDIA queues each model on its own, and on 2026-09-27 GLM 5.3 Flash took 46-104 s for a
# one-line answer while GLM 5.3 beside it took 1-4 s. A model whose last call ran slower than config.SLOW_LEG_TURN_S a
# turn (or timed out, or found every key rate-limited) is tried after the capable models that are not crawling, until the mark ages out
# (config.SLOW_MARK_S); then one call finds out whether it has recovered.
#
# The readings are shared by every hswarm process on the machine through config.HOME/crawl.json: the MCP server and a
# `hswarm run` job are separate processes, and the same day a CLI job sent all 27 of its tasks to the GLM 5.3 Flash
# the server had just watched crawl. Each entry is a model's latest reading, [wall-clock time, crawled?, when it last
# found every key rate-limited], and the newest reading wins across processes, so a recovery seen anywhere clears the
# crawl mark everywhere.
#
# The rate-limit time is kept apart from the speed reading and no ok clears it: with about half of a model's first
# legs exhausted (872 of 1,862 on gemini-3-8-flash) the other half finish ok within seconds, and an ok from a call
# that found a free key says nothing about the quota being back. It ages out on its own after config.SLOW_MARK_S.
_CRAWL: dict[str, list] = {}
_CRAWL_SEEN: list = [None]  # (mtime_ns, size) of the file when this process last merged it
_CRAWL_KEEP_S = 86400.0  # readings older than a day are dropped when the file is written


def _crawl_path():
    from . import config

    return config.HOME / "crawl.json"


def _merge_crawl():
    """Fold the other processes' newer readings in; a missing or half-written file is simply not news."""
    path = _crawl_path()
    try:
        st = path.stat()
        # A file written in the last two seconds is always read again: a coarse file clock (Windows) stamps two writes
        # in one tick alike, and then an equal size is a coin flip (the Windows CI leg lost it on 2026-09-27).
        if (st.st_mtime_ns, st.st_size) == _CRAWL_SEEN[0] and time.time() - st.st_mtime_ns / 1e9 > 2.0:
            return
        theirs = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    _CRAWL_SEEN[0] = (st.st_mtime_ns, st.st_size)
    for model, reading in (theirs if isinstance(theirs, dict) else {}).items():
        if not (isinstance(reading, list) and len(reading) == 3):
            continue
        ours = _CRAWL.get(model, [float("-inf"), False, 0.0])
        newest = reading if float(reading[0]) > ours[0] else ours
        _CRAWL[model] = [float(newest[0]), bool(newest[1]), max(float(reading[2]), ours[2])]


def _record_speed(model, at, crawled, limited=False):
    _merge_crawl()
    _CRAWL[model] = [at, crawled, at if limited else _CRAWL.get(model, [0.0, False, 0.0])[2]]
    for m in [m for m, (t, _, _) in _CRAWL.items() if at - t > _CRAWL_KEEP_S]:
        del _CRAWL[m]
    path = _crawl_path()
    tmp = path.with_name(f"crawl.{os.getpid()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(_CRAWL), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)  # a hint, never a failure: this reading still counts in this process


def note_speed(model, res, now=None):
    from . import config

    if not model:
        return
    now = time.time() if now is None else now
    err = res.error or ""
    per_turn = (res.api_seconds or res.seconds or 0.0) / max(1, res.turns or 1)
    if _RATE_LIMITED in err:
        _record_speed(model, now, True, limited=True)
    elif "timeout" in err.lower() or "SlowLeg:" in err or (res.status == "ok" and per_turn > config.SLOW_LEG_TURN_S):
        _record_speed(model, now, True)
    elif res.status == "ok":
        _record_speed(model, now, False)


def note_crawl(model, now=None):
    """One turn slower than config.SLOW_LEG_CALL_S: news for every task on the model now, not when this leg ends."""
    if model:
        _record_speed(model, time.time() if now is None else now, True)


def crawling(model, now=None):
    from . import config

    _merge_crawl()
    at, crawled, limited_at = _CRAWL.get(model, (0.0, False, 0.0))
    now = time.time() if now is None else now
    return bool(crawled and now - at < config.SLOW_MARK_S) or bool(limited_at and now - limited_at < config.SLOW_MARK_S)


def pressure(provider, capacity, now=None):
    """0..1: committed tasks plus recent slow marks over what the provider's usable keys can carry."""
    from . import config

    now = time.monotonic() if now is None else now
    marks = _SLOW[provider] = [t for t in _SLOW.get(provider, ()) if now - t < config.SLOW_MARK_S]
    return min(1.0, (_INFLIGHT.get(provider, 0) + len(marks)) / max(1, capacity))


def rebias(candidates, pressure_of):
    """Re-rank by benchmark cost x (1 + LOAD_BIAS x pressure). Each keeps its unbiased benchmark_cost_usd and says
    the bias it was ranked with; the sort is stable, so with no load the plan's own order stands. Unevidenced
    siblings (_last_resort) stay behind every evaluated candidate, starred or not: a star orders, it never admits."""
    from . import config

    out = [{**c, "load_bias": round(config.LOAD_BIAS * pressure_of(c["provider"]), 4) if c.get("provider") else 0.0}
           for c in candidates]
    for c in out:
        if crawling(c["model"]):
            c["crawling"] = True
    # Crawling before free: a marked model goes behind every healthy route, paid ones included (owner: free routes
    # first, but a crawling model last). Free-first above it put a marked NVIDIA model at the head of every task:
    # 6,393 NVIDIA first legs served 308 times (4.8%) in the week to 2026-10-02, 205 task-hours on legs that failed over.
    out.sort(key=lambda c: (bool(c.get("unevidenced")), priority_rank(c["model"]), bool(c.get("crawling")), not c.get("free"),
                            (c.get("benchmark_cost_usd") or 0.0) * (1 + c["load_bias"]), -(c.get("score") or 0)))
    return out
