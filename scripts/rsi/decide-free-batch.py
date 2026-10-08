"""Batched-Free against per-item escalation answers for hswarm_decide, graded on gold labels: the gate for a batched
escalation leg (free_batch below: one Free-account message carrying a shared state once and its open questions
numbered). Run 2026-10-08 on Dredd's 87 gold asks, it failed: not shipped (hswarm/docs/BENCH-2026-10-08-free-batch.md).
free_batch is the exact code that was measured; re-run this when the Free accounts' models change.

Input (--items): a JSON list of {ask, items: [typed decide items sharing one state], gold: {item id: gold key or list}},
for example Dredd's gold asks run through its buildQuestions; the gold text stays outside this public repo. Arms, on
the SAME graded items:
  jev        Jev alone, one call per ask (its confidence marks the items the cascade escalates at 0.7)
  item-paid  one ask per item on the decision profile's paid route, as the cascade's per-item leg runs with no idle
             account; every graded question, yes/no included
  item-free  one ask per item on an idle Free account, as that leg runs when one is idle; choice and score questions
  batch4     free_batch with the ask's choice and score questions (Dredd's cascade group)
  batch40    free_batch with every question of the ask, its yes/no ones too (Dredd's whole ask while Jev is down)
Rows append to --out as JSONL, so a stopped run resumes where it stopped; --report prints the comparison.

    python scripts/rsi/decide-free-batch.py --items items.json --out rows.jsonl
    python scripts/rsi/decide-free-batch.py --out rows.jsonl --report
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hswarm import decisions as D  # noqa: E402
from hswarm import free_route, typesafe  # noqa: E402
from hswarm.spec import Task  # noqa: E402

FREE_AT_ONCE = 3  # of the 6 accounts, so live work keeps the rest
PAID_AT_ONCE = 8
TRIES = 3  # a message no account served (or whose reply was unusable) is sent again, up to this many times
ARMS = ("item-paid", "item-free", "batch4", "batch40")  # plus jev when TypeSafe has credit
CHOICE = ("choice", "score")


# The batched message's own instructions; decisions.SYSTEM and render() stay the per-item benchmark's.
BATCH_SYSTEM = ("You answer several typed decision questions about the one STATE you are given. Read the state, then each "
                "numbered question and its options carefully, and answer every question on its own, as if it were the only "
                "one asked: another question's options are never an answer to it.")


def render_batch(items: list[dict]) -> str:
    """Items that share one state as one message: the state once, then every question numbered q0..qN-1. Each
    question's text is render()'s own with the state cut off the front, so it reads exactly as the per-item benchmark
    asks it."""
    # "STATE:\n<state>\n\n", what every item's render() starts with (rsplit: the state may itself hold "QUESTION: ")
    head = D.render({**items[0], "instructions": "", "criteria": None, "type": "noul"}).rsplit("\nQUESTION: ", 1)[0] + "\n"
    n = len(items)
    parts = [head.rstrip("\n"), f"There are {n} questions about this STATE, q0 to q{n - 1}. Answer every one."]
    for i, it in enumerate(items):
        text = D.render(it)
        if not text.startswith(head):
            raise ValueError("render_batch takes items that share one state")
        parts.append(f"## q{i}\n{text[len(head):]}")
    parts.append(f"Reply with one JSON object that maps each question id (q0 to q{n - 1}) to the key of the option you choose for it.")
    return "\n\n".join(parts)


async def free_batch(items: list[dict]) -> tuple[list[str | None], object]:
    """Items that share one state, asked in ONE message on an idle Free web account (free_route.consult): each item's
    option key (None where the reply named no valid key) and the Result, or all None and no Result when no account
    served the message."""
    qs = [f"q{i}" for i in range(len(items))]
    schema = {"type": "object", "properties": {q: {"type": ["string", "integer", "boolean"]} for q in qs}, "required": qs}
    task = Task(prompt=render_batch(items), id="decide", system=BATCH_SYSTEM, schema=schema, tools="none", profile="decision", timeout_s=120)
    res, _ = await free_route.consult(f"decide-{uuid.uuid4().hex[:8]}", task)
    if res is None or not isinstance(res.data, dict):
        return [None] * len(items), None
    picks = []
    for q, it in zip(qs, items):
        v = res.data.get(q)
        picks.append(D.parse_final(str(v), [o for o, _ in D.options(it)]) if isinstance(v, (str, int, bool)) else None)
    return picks, res


def passes(pred, gold) -> bool | None:
    """A gold list passes any of its keys; a score's gold level may be stored as a number, its key is a string."""
    if gold is None or pred is None:
        return None
    return str(pred) in [str(g) for g in (gold if isinstance(gold, list) else [gold])]


class Bench:
    def __init__(self, out: Path):
        self.out = out
        self.done: set[tuple] = set()
        if out.exists():
            for line in out.read_text(encoding="utf-8").splitlines():
                r = json.loads(line)
                if r.get("unit"):
                    self.done.add(tuple(r["unit"]))
        self.free = asyncio.Semaphore(FREE_AT_ONCE)
        self.paid = asyncio.Semaphore(PAID_AT_ONCE)

    def write(self, rows: list[dict], unit: tuple) -> None:
        rows.append({"unit": list(unit), "ts": time.time()})
        with self.out.open("a", encoding="utf-8") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        self.done.add(unit)

    async def wait_idle(self) -> None:
        for _ in range(450):  # 15 minutes
            try:
                st = await free_route._call("free_status", {}, free_route.STATUS_TIMEOUT_S)
            except free_route._ERRORS:
                st = {}  # an unreadable status counts as no idle account; the next poll reads it again
            now = time.monotonic()
            if free_route._idle(st) - sum(1 for t in free_route._SENT if now - t < free_route.UNSEEN_S) > 0:
                return
            await asyncio.sleep(2)

    async def jev(self, a: dict, jev) -> None:
        unit = ("jev", a["ask"])
        if unit in self.done:
            return
        items = [D.normalize(r, i) for i, r in enumerate(a["items"])]
        res, _ = await D.jev_answers(jev, items)
        self.write([{"arm": "jev", "ask": a["ask"], "id": it["id"], "type": it["type"], "pred": r.get("pred"),
                     "conf": r.get("conf"), "gold": a["gold"].get(it["id"]), "pass": passes(r.get("pred"), a["gold"].get(it["id"]))}
                    for it, r in zip(items, res)], unit)

    async def item_paid(self, a: dict, raw: dict, mgr) -> None:
        unit = ("item-paid", a["ask"], raw["id"])
        if unit in self.done:
            return
        from hswarm.dispatch import ask_selected

        it = D.normalize(raw)
        async with self.paid:
            t0 = time.perf_counter()
            r = await ask_selected(mgr, D.render(it), profile="decision", route=True, purpose="production",
                                   system=D.SYSTEM, reasoning_effort=None, max_tokens=8000)
        pred = D.parse_final(r.answer or "", [o for o, _ in D.options(it)]) if r.status == "ok" else None
        g = a["gold"].get(it["id"])
        self.write([{"arm": "item-paid", "ask": a["ask"], "id": it["id"], "type": it["type"], "pred": pred, "gold": g,
                     "pass": passes(pred, g), "model": r.model, "status": r.status, "cost": r.cost_usd,
                     "secs": round(time.perf_counter() - t0, 1)}], unit)

    async def item_free(self, a: dict, raw: dict) -> None:
        unit = ("item-free", a["ask"], raw["id"])
        if unit in self.done:
            return
        it = D.normalize(raw)
        keys = [o for o, _ in D.options(it)]
        res, tries = None, 0
        async with self.free:
            while res is None and tries < TRIES:
                tries += 1
                await self.wait_idle()
                # exactly the Task jobs._ask_selected builds for an escalation's free leg
                task = Task(prompt=D.render(it), id="ask", system=D.SYSTEM, schema=None, tools="none", profile="decision", timeout_s=120)
                res, _ = await free_route.consult(f"bench-{uuid.uuid4().hex[:8]}", task)
        pred = D.parse_final(res.answer or "", keys) if res else None
        g = a["gold"].get(it["id"])
        self.write([{"arm": "item-free", "ask": a["ask"], "id": it["id"], "type": it["type"], "pred": pred, "gold": g,
                     "pass": passes(pred, g), "model": res.model if res else None, "tries": tries,
                     "served": res is not None, "secs": res.seconds if res else None}], unit)

    async def batch(self, a: dict, arm: str) -> None:
        unit = (arm, a["ask"])
        if unit in self.done:
            return
        raws = [r for r in a["items"] if arm == "batch40" or r.get("type") in CHOICE]
        items = [D.normalize(r, i) for i, r in enumerate(raws)]
        picks, res, tries = [None] * len(items), None, 0
        async with self.free:
            while res is None and tries < TRIES:
                tries += 1
                await self.wait_idle()
                picks, res = await free_batch(items)
        rows = [{"arm": arm, "ask": a["ask"], "id": it["id"], "type": it["type"], "pred": p, "gold": a["gold"].get(it["id"]),
                 "pass": passes(p, a["gold"].get(it["id"])), "model": res.model if res else None, "tries": tries,
                 "served": res is not None, "n": len(items), "secs": res.seconds if res else None}
                for it, p in zip(items, picks)]
        self.write(rows, unit)


async def run(items_path: Path, out: Path, arms: list[str], limit: int | None) -> None:
    asks = json.loads(items_path.read_text(encoding="utf-8"))[:limit]
    b = Bench(out)
    graded = [(a, r) for a in asks for r in a["items"] if a["gold"].get(r["id"]) is not None]
    choice = [(a, r) for a, r in graded if r.get("type") in CHOICE]
    work = []
    if "jev" in arms:
        async with typesafe.Jev.for_model(typesafe.MODEL) as jev:
            await asyncio.gather(*(b.jev(a, jev) for a in asks))
    from hswarm.jobs import JobManager

    mgr = JobManager()
    try:
        if "item-paid" in arms:
            work += [b.item_paid(a, r, mgr) for a, r in graded]
        free = []
        if "item-free" in arms:
            free += [("item-free", a, r) for a, r in choice]  # yes/no per item would be ~800 more free messages
        free += [(arm, a, None) for arm in ("batch4", "batch40") if arm in arms for a in asks]
        random.Random(7).shuffle(free)  # the free arms interleave, so a slow or locked-out hour hits them alike
        work += [b.item_free(a, r) if arm == "item-free" else b.batch(a, arm) for arm, a, r in free]
        await asyncio.gather(*work)
    finally:
        await mgr.aclose()


def report(out: Path, boots: int = 10_000) -> dict:
    """Accuracy per arm on the graded choice/score and yes/no questions, and each new arm's paired difference from a
    per-item arm with a 95% interval from a bootstrap over asks (one ask's questions share a message)."""
    rows = [r for r in (json.loads(x) for x in out.read_text(encoding="utf-8").splitlines()) if r.get("arm")]
    by: dict[str, dict[tuple, dict]] = {}
    for r in rows:
        r["pass"] = passes(r.get("pred"), r.get("gold"))  # graded here, so a grading fix re-grades stored rows
        by.setdefault(r["arm"], {})[(r["ask"], r["id"])] = r
    kinds = {"choice": lambda r: r["type"] in CHOICE, "yesno": lambda r: r["type"] == "noul"}
    rep: dict = {"arms": {}, "pairs": {}}
    for arm, rs in by.items():
        line: dict = {}
        for kind, of in kinds.items():
            ans = [r for r in rs.values() if of(r) and r.get("pass") is not None]
            if ans:
                line[kind] = {"answered": len(ans), "acc": round(sum(r["pass"] for r in ans) / len(ans), 4)}
        msgs = {r["ask"]: r for r in rs.values() if arm.startswith("batch")}
        if msgs:
            line |= {"messages": len(msgs), "served": sum(m["served"] for m in msgs.values()),
                     "first_try": sum(m["served"] and m["tries"] == 1 for m in msgs.values())}
        line["models"] = {}
        for r in rs.values():
            if r.get("model") and r["type"] in CHOICE and r.get("pass") is not None:
                m = line["models"].setdefault(r["model"], {"choice": 0, "right": 0})
                m["choice"] += 1
                m["right"] += r["pass"]
        rep["arms"][arm] = line
    rng = random.Random(11)
    for new in ("batch4", "batch40", "item-free"):
        for base in ("item-paid", "item-free"):
            if new == base or new not in by or base not in by:
                continue
            for kind, of in kinds.items():
                ks = [k for k, r in by[new].items() if of(r) and r.get("pass") is not None and by[base].get(k, {}).get("pass") is not None]
                if not ks:
                    continue
                d = [int(by[new][k]["pass"]) - int(by[base][k]["pass"]) for k in ks]
                asks: dict[str, list[int]] = {}
                for k, x in zip(ks, d):
                    asks.setdefault(k[0], []).append(x)
                groups = list(asks.values())
                sims = []
                for _ in range(boots):
                    pick = [groups[rng.randrange(len(groups))] for _ in groups]
                    sims.append(sum(sum(p) for p in pick) / sum(len(p) for p in pick))
                sims.sort()
                rep["pairs"][f"{new} - {base} ({kind})"] = {
                    "n": len(ks), "new_acc": round(sum(by[new][k]["pass"] for k in ks) / len(ks), 4),
                    "base_acc": round(sum(by[base][k]["pass"] for k in ks) / len(ks), 4), "diff": round(sum(d) / len(d), 4),
                    "ci95": [round(sims[int(0.025 * boots)], 4), round(sims[int(0.975 * boots)], 4)],
                    "new_only_right": sum(x > 0 for x in d), "base_only_right": sum(x < 0 for x in d)}
    return rep


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--items", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--arms", default=",".join(ARMS))
    p.add_argument("--limit", type=int)
    p.add_argument("--report", action="store_true")
    a = p.parse_args()
    if not a.report:
        asyncio.run(run(a.items, a.out, a.arms.split(","), a.limit))
    print(json.dumps(report(a.out), indent=1))


if __name__ == "__main__":
    main()
