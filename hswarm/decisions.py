"""Typed decisions: an item is a state, a question, and a closed set of answers - `choice` (one option of a set),
`noul` (yes/no), or `score` (one level of an ordered scale).

This is what `hswarm_decide` answers, and the SAME code renders and grades bench/decide.py, so the tool asks
exactly what the benchmark measured. The cascade it runs is the one measured on 2026-09-21 (465 items,
8 suites, docs/BENCH-2026-09-21-jev.md): TypeSafe's Jev answers every item first (about 0.15 s and
$0.00004 each, with a calibrated confidence), and every answer below `escalate_below` confidence is re-asked on
the tool-free default generative model. At 0.7 that matched the generative model's own accuracy while sending
it only about a third of the items; Jev alone trailed gpt-oss-120b by a few points.

Rules the benchmark set, which the code enforces:
- Jev never sees a batch of more than 5 unrelated items in one call. At 5 its accuracy held (85.5% vs 85.2%
  one per call); at 20 it fell to 74.7% (a 77-way intent question fell from 78% to 38%), the "large state full
  of irrelevant detail" failure TypeSafe documents for jev-1.13.
- Items that carry the SAME state are one call whatever `batch` says: Jev reads the state once and answers every
  question against it in parallel, which is how its API is meant to be used ("speculative fan-out"), with no
  unrelated state to dilute it. Dredd asks about 40 questions of one ask (3,480 over its 87 gold asks, 2026-10-02);
  that was one call per question, each re-billing the ask.
- Escalations go one item per message. Batching a shared state's open questions into one Free-account message was
  measured on Dredd's gold asks on 2026-10-08 and not shipped: within noise of the same Free models one question at
  a time, but 6-7 points under the paid per-item route on choice questions (hswarm/docs/BENCH-2026-10-08-free-batch.md;
  re-run with scripts/rsi/decide-free-batch.py when the Free models change).
- Arithmetic, counting, dates and generation are not decisions: route those to hswarm_ask, not here
  (Jev scored 76% on the trap-arithmetic suite where gpt-oss-120b scored 94%).
"""
from __future__ import annotations

import asyncio
import json
import re
import time

from . import typesafe

# The generative arm's instructions. ⛔ Changing this string (or render) changes the benchmark's suite version,
# so every stored bench result for the decision suites stops being reused - that is deliberate: it is a new test.
SYSTEM = ("You answer one typed decision question about the STATE you are given. Read the state and the options "
          "carefully and think it through. Then end your reply with a line in exactly this format: 'FINAL: <key>' "
          "where <key> is exactly one of the option keys listed, and nothing else is on that line.")
MAX_BATCH = 5
MAX_SHARED = 64  # questions put to one shared state in one call; past it the group splits
BATCH_STATE_CHARS, BATCH_TOTAL_CHARS = 60_000, 150_000  # Jev's 32k/64k-token limits at a conservative ~3 chars/token
TYPES = {"choice": "choice", "noul": "noul", "yesno": "noul", "yes_no": "noul", "bool": "noul", "score": "score", "scale": "score"}


# ---------------------------------------------------------------- the item

def normalize(raw: dict, i: int = 0) -> dict:
    """A caller's item -> {id, type, state, instructions, criteria}. Accepts `question` or `instructions`, and
    `options` as a list of keys, a {key: description} map, or (score) an ordered list of level descriptions."""
    if not isinstance(raw, dict):
        raise ValueError("each item must be an object with at least `state` and `question`")
    q = raw.get("question") or raw.get("instructions")
    if not q or "state" not in raw:
        raise ValueError("an item needs `state` and `question`")
    opts = raw.get("options", raw.get("criteria"))
    t = TYPES.get(str(raw.get("type") or ("choice" if opts else "noul")).lower())
    if t is None:
        raise ValueError(f"type must be choice, yesno or score, got {raw.get('type')!r}")
    if t == "choice":
        if isinstance(opts, list):
            opts = {str(o): None for o in opts}
        if not isinstance(opts, dict) or len(opts) < 2:
            raise ValueError("a choice needs at least two options")
        if len(opts) > 255:
            raise ValueError("a choice takes at most 255 options")
    elif t == "score":
        if not isinstance(opts, list) or not 2 <= len(opts) <= 10:
            raise ValueError("a score needs an ordered list of 2 to 10 level descriptions")
    else:
        if isinstance(opts, dict):
            opts = {"true": opts.get("true", opts.get("yes")), "false": opts.get("false", opts.get("no"))}
            opts = {k: v for k, v in opts.items() if v} or None
        else:
            opts = None
    # Jev takes structured instructions (the question in one field, the data it names in others); str() of a dict
    # would send Python's repr instead.
    ins = q if isinstance(q, (dict, list)) else str(q)
    return {"id": str(raw.get("id") or f"d{i}"), "type": t, "state": raw["state"], "instructions": ins, "criteria": opts}


def options(item: dict) -> list[tuple[str, object]]:
    t, c = item["type"], item.get("criteria")
    if t == "noul":
        c = c or {}
        return [("yes", c.get("true")), ("no", c.get("false"))]
    if t == "score":
        return [(str(i), d) for i, d in enumerate(c)]
    return list(c.items())


# ---------------------------------------------------------------- a generative model's view of the item

def render(item: dict) -> str:
    st = item["state"]
    state = st if isinstance(st, str) else json.dumps(st, indent=1, ensure_ascii=False)
    ins = item["instructions"]
    ins = ins if isinstance(ins, str) else json.dumps(ins, indent=1, ensure_ascii=False)
    lines = [f"STATE:\n{state}\n", f"QUESTION: {ins}\n", "OPTIONS (answer with the key before the colon):"]
    for k, d in options(item):
        if d is None or d == "":
            lines.append(f"- {k}")
        elif isinstance(d, str) and "\n" in d:
            lines.append(f"- {k}:\n```\n{d}\n```")
        else:
            lines.append(f"- {k}: {d if isinstance(d, str) else json.dumps(d, ensure_ascii=False)}")
    return "\n".join(lines)


def parse_final(answer: str, keys: list[str]) -> str | None:
    """The option key on the model's last FINAL line, or None when it named none (or several)."""
    if not answer:
        return None
    m = list(re.finditer(r"final\s*[:\-]\s*(.+)", answer, re.I))
    tail = m[-1].group(1) if m else answer.strip().splitlines()[-1]
    tail = tail.strip().strip(".`*'\"<>[]() ").strip()
    low = {k.lower(): k for k in keys}
    if tail.lower() in low:
        return low[tail.lower()]
    alias = {"true": "yes", "false": "no"}
    if tail.lower() in alias and alias[tail.lower()] in low:
        return low[alias[tail.lower()]]
    found = [k for k in keys if re.search(rf"(?<![\w/.]){re.escape(k.lower())}(?![\w/.])", tail.lower())]
    return found[0] if len(found) == 1 else None


# ---------------------------------------------------------------- Jev's view of the item

def jev_question(item: dict) -> dict:
    q = {"type": item["type"], "instructions": item["instructions"]}
    if item.get("criteria") is not None:
        q["criteria"] = item["criteria"]
    return q


def batched_question(item: dict, i: int) -> dict:
    """The item's question, pointed at its own slot `items[i]` of a shared state."""
    q = jev_question(item)
    ins = item["instructions"]
    if not isinstance(ins, str):
        q["instructions"] = {"about": f"`items[{i}]`", "question": ins}
    elif isinstance(item["state"], dict):
        for k in item["state"]:
            ins = ins.replace(f"`{k}`", f"`items[{i}].{k}`")
        q["instructions"] = ins if f"items[{i}]" in ins else f"About `items[{i}]`: {ins}"
    else:
        q["instructions"] = f"About `items[{i}]`: {ins}"
    return q


def pack(items: list[dict], n: int) -> list[list[dict]]:
    """Consecutive groups of at most n items whose states fit Jev's context together."""
    groups, cur, st, tot = [], [], 0, 0
    for it in items:
        s = len(json.dumps(it["state"], ensure_ascii=False))
        q = len(json.dumps(jev_question(it), ensure_ascii=False))
        if cur and (len(cur) >= n or st + s > BATCH_STATE_CHARS or tot + s + q > BATCH_TOTAL_CHARS):
            groups.append(cur)
            cur, st, tot = [], 0, 0
        cur.append(it)
        st, tot = st + s, tot + s + q
    return groups + ([cur] if cur else [])


def share(items: list[dict]) -> list[list[int]]:
    """Item indexes grouped by identical state, in first-seen order, each group cut to fit one call (MAX_SHARED
    questions, Jev's context). A state no other item carries comes back as a group of one."""
    by: dict[str, list[int]] = {}
    for k, it in enumerate(items):
        by.setdefault(json.dumps(it["state"], ensure_ascii=False, sort_keys=True), []).append(k)
    groups = []
    for key, ks in by.items():
        cur, tot = [], len(key)
        for k in ks:
            q = len(json.dumps(jev_question(items[k]), ensure_ascii=False))
            if cur and (len(cur) >= MAX_SHARED or tot + q > BATCH_TOTAL_CHARS):
                groups.append(cur)
                cur, tot = [], len(key)
            cur.append(k)
            tot += q
        groups.append(cur)
    return groups


def read_answer(item: dict, a: dict) -> dict:
    """One typed Jev answer -> the predicted option key, its probabilities and confidence."""
    if item["type"] == "noul":
        p = float(a["noul"])
        # A Noul carries no confidence field; distance from 0.5, scaled to 0..1, is the honest stand-in.
        return {"pred": "yes" if p >= 0.5 else "no", "probs": {"yes": p, "no": 1 - p}, "conf": abs(p - 0.5) * 2, "raw": p, "parsed": True}
    if item["type"] == "choice":
        return {"pred": a["choice"], "probs": a["probabilities"], "conf": a.get("confidence"), "parsed": True}
    probs = a["probabilities"]  # score: the most probable level, not the expectation (which can land between levels)
    return {"pred": max(probs, key=probs.get), "probs": probs, "conf": a.get("confidence"), "raw": a.get("score"), "parsed": True}


async def jev_answers(jev: typesafe.Jev, items: list[dict], model: str = typesafe.MODEL, batch: int = 1) -> tuple[list[dict], dict]:
    """Every item through Jev: items sharing a state in one call (share), the rest one call each or packs of
    <= MAX_BATCH. Returns per-item results in the items' order, and call stats."""
    batch = max(1, min(int(batch or 1), MAX_BATCH))
    shared = share(items)
    solo = [g[0] for g in shared if len(g) == 1]
    calls = [(True, g) for g in shared if len(g) > 1]
    if batch > 1:
        rest = iter(solo)  # pack() keeps order and cuts consecutive runs, so its groups consume solo in turn
        calls += [(False, [next(rest) for _ in p]) for p in pack([items[s] for s in solo], batch)]
    else:
        calls += [(False, [s]) for s in solo]
    stats = {"calls": 0, "in": 0, "out": 0, "cost_usd": 0.0, "secs": 0.0, "model": model, "errors": 0}
    results: list[dict] = [{}] * len(items)

    async def one(same_state: bool, group: list[int]) -> None:
        its = [items[k] for k in group]
        if same_state or len(its) == 1:
            state, qs = its[0]["state"], {f"q{i}": jev_question(it) for i, it in enumerate(its)}
        else:
            state, qs = {"items": [it["state"] for it in its]}, {f"q{i}": batched_question(it, i) for i, it in enumerate(its)}
        res = await jev.ask(state, qs, model=model)
        stats["calls"] += 1
        if res["status"] != "ok":
            stats["errors"] += 1
            for k in group:
                results[k] = {"status": "error", "error": res["error"]}
            return
        stats["in"] += res["in"]
        stats["out"] += res["out"]
        stats["cost_usd"] += res["cost_usd"]
        stats["secs"] += res["secs"]
        stats["model"] = res["model"]
        for i, (k, it) in enumerate(zip(group, its)):
            a = res["answers"].get(f"q{i}")
            try:
                results[k] = {"status": "ok", **read_answer(it, a)} if a else {"status": "error", "error": f"no answer for q{i}"}
            except (KeyError, TypeError, ValueError):  # one malformed answer escalates its item, never sinks the call
                results[k] = {"status": "error", "error": f"malformed answer for q{i}: {json.dumps(a)[:120]}"}

    await asyncio.gather(*(one(s, g) for s, g in calls))
    return results, stats


# ---------------------------------------------------------------- the cascade

async def decide(raw_items: list[dict], mgr=None, *, escalate_below: float | None = 0.7, fallback_model: str | None = None,
                 model: str = typesafe.MODEL, batch: int = 1, reasoning_effort: str | None = None, jev: typesafe.Jev | None = None) -> dict:
    """Answer typed decisions: Jev first, then the generative fallback for every answer under `escalate_below`
    confidence (and for every item Jev could not answer). escalate_below=0 is Jev alone: nothing escalates, and an
    item Jev could not answer comes back unanswered with Jev's error, for the caller's own fallback. None escalates
    only the items Jev could not answer; 1.01 sends everything to the fallback. `mgr` is a JobManager, needed only
    when something escalates."""
    from . import config

    t0 = time.perf_counter()
    items, bad = [], []
    for i, raw in enumerate(raw_items):
        try:
            items.append(normalize(raw, i))
        except ValueError as e:
            bad.append({"id": str((raw or {}).get("id") or f"d{i}") if isinstance(raw, dict) else f"d{i}", "error": str(e)})
    fallback = config.resolve_model(fallback_model) if fallback_model and fallback_model != config.AUTO else config.AUTO
    own = jev is None
    jev = jev or typesafe.Jev.for_model(model)
    try:
        if own:
            await jev.__aenter__()
        jres, stats = await jev_answers(jev, items, model, batch) if jev.usable else ([{"status": "error", "error": f"no {jev.provider} key"} for _ in items], {"calls": 0, "errors": 0, "cost_usd": 0.0})
    finally:
        if own:
            await jev.__aexit__(None, None, None)
    thr = -1.0 if escalate_below is None else float(escalate_below)
    # 0 is Jev alone even when Jev fails (HTTP 402 since 2026-10-06): Dredd asks its yes/no questions at 0 because the
    # fallback's yes/no answers convened the right instruments on 19 of 39 gold dockets against Jev's 39 of 39, and
    # its own keyword heuristic answers what Jev leaves unanswered.
    todo = [] if escalate_below is not None and thr <= 0 else [k for k, r in enumerate(jres) if r["status"] != "ok" or (r.get("conf") or 0.0) < thr]
    fb_results: list = []

    async def escalate(k: int) -> None:
        it = items[k]
        keys = [o for o, _ in options(it)]
        try:
            r = await mgr.ask_routed(render(it), fallback, system=SYSTEM, reasoning_effort=reasoning_effort, max_tokens=8000,
                                     **({"profile": "decision"} if fallback == config.AUTO else {}))
        except Exception as e:  # noqa: BLE001 - one item's fallback crashing must not lose every other answer
            jres[k]["fallback"] = {"answer": None, "model": fallback, "status": "error", "error": f"{type(e).__name__}: {e}"[:160]}
            return
        fb_results.append(r)
        pred = parse_final(r.answer or "", keys) if r.status == "ok" else None
        jres[k]["fallback"] = {"answer": pred, "model": r.model, "status": r.status, **({"error": (r.error or "")[:160]} if r.status != "ok" else {})}

    if todo:
        own_mgr = mgr is None
        if own_mgr:
            from .jobs import JobManager

            mgr = JobManager()
        try:
            await asyncio.gather(*(escalate(k) for k in todo))
        finally:
            if own_mgr:
                await mgr.aclose()
    answers = []
    for it, r in zip(items, jres):
        fb = r.get("fallback") or {}
        if fb.get("answer") is not None:
            ans, src = fb["answer"], fb["model"]
        elif r["status"] == "ok" and not fb:
            ans, src = r["pred"], "jev"
        else:
            ans, src = None, "none"
        row = {"id": it["id"], "answer": ans, "source": src}
        if it["type"] == "score" and ans is not None:
            row["level"] = int(ans)
        if r["status"] == "ok":
            row["jev"] = {"answer": r["pred"], "confidence": round(float(r.get("conf") or 0.0), 3),
                          "probabilities": {k: round(float(v), 3) for k, v in (r.get("probs") or {}).items()}}
        else:
            row["jev"] = {"error": r.get("error", "")[:160]}
        if fb:
            row["fallback"] = fb
            if ans is None:
                row["error"] = "UnresolvedDecision: JEV required escalation but no stronger Swarm answer was obtained"
        elif ans is None:
            row["error"] = f"JevUnanswered: escalate_below={escalate_below} escalates nothing; Jev: {r.get('error', '')}"[:200]
        answers.append(row)
    fb_cost = sum((x.cost_usd or 0.0) for x in fb_results)
    return {"answers": answers + [{"id": b["id"], "answer": None, "source": "none", "error": b["error"]} for b in bad],
            "summary": {"items": len(raw_items), "by_jev": sum(a["source"].startswith("jev") for a in answers), "escalated": len(todo),
                        "unanswered": sum(a["answer"] is None for a in answers) + len(bad), "invalid": len(bad), "escalate_below": escalate_below,
                        "fallback_model": fallback, "jev_model": stats.get("model", model), "jev_calls": stats.get("calls", 0),
                        "jev_cost_usd": round(stats.get("cost_usd", 0.0), 6), "fallback_cost_usd": round(fb_cost, 6), "seconds": round(time.perf_counter() - t0, 2)},
            "_jev_stats": stats, "_fallback_results": fb_results}
