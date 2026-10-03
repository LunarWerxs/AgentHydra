"""Blind panel: one review prompt to two or three models at once, then an anonymised, shuffled rebuttal round.

WHY: a reviewer who is told what an earlier one said anchors on it, and a reviewer who knows which vendor wrote a
point defers to (or discounts) the name. So round 1 sends the SAME prompt to every panelist in parallel and none
sees another's answer. Round 2 shows each panelist the others' numbered findings as "Reviewer A / B / C", with the
letters dealt out again for every panelist, and asks for one position per line: UPHOLD / REJECT a finding such as
B3, CONCEDE one of its own (Y2), or name something every reviewer MISSED. Those lines are regrouped by finding, and
a finding that someone rejects while someone still stands behind it is CONTESTED - the place a reader looks first.

The idea is from Shubhamsaboo/awesome-llm-apps (llm_panel_agent_team, Apache-2.0); this is written fresh for hswarm.
It is tool-free on purpose: every call is an ask on the routed path (jobs.ask_routed), so a spent free leg fails
over exactly the way hswarm_ask does, and each call is booked like one.
"""
from __future__ import annotations

import asyncio
import random
import re
import string
import time

MAX_PANEL = 5
MAX_FINDINGS = 12
STANCES = ("uphold", "reject", "concede", "missed")

ROUND1_SYSTEM = ("You are one reviewer on an independent panel. Review what you are given on your own. List your findings "
                 "one per line, numbered '1.', '2.' and so on, most important first, at most {n}. Make each finding "
                 "concrete and checkable in a single line. Only the numbered lines are read.")
ROUND2_RULES = ("Take a position on the other reviewers' findings, one per line, in exactly this form:\n"
                "UPHOLD <ref>: <why it holds>\n"
                "REJECT <ref>: <why it is wrong>\n"
                "CONCEDE <your ref, such as Y2>: <why you withdraw your own finding>\n"
                "MISSED: <a finding every reviewer missed>\n"
                "<ref> is a label such as A2. Judge each finding on its merits; the reviewers are anonymous and their "
                "order means nothing. Only these lines are read.")

_FINDING = re.compile(r"^[\s>*_#`]*(\d{1,2})[.)]\s+(.+?)\s*$")
_POSITION = re.compile(r"^[\s>*_#`\-]*(UPHOLD|REJECT|CONCEDE|MISSED)\b[\s*_:`\-]*(?:([A-Za-z]\d{1,2})\b)?[\s*_:`.\-)]*(.*?)\s*$", re.I)


# ---------------------------------------------------------------- who sits

def panelists(models: list[str] | None = None) -> list[str]:
    """The panel's models, resolved: an entry may be a model, an alias or a role name (judge, summarize, ...).
    Two to MAX_PANEL distinct models; the default is config.PANEL (`panel` in settings.toml), and with none set,
    two makers' models this machine's keys reach (dispatch.default_panel)."""
    from . import config
    from .dispatch import default_panel

    out: list[str] = []
    for name in models or config.PANEL or default_panel():
        n = str(name).strip().lower()
        m = config.resolve_role(n) if n in config.ROLES else config.resolve_model(n)
        if m in out:
            raise ValueError(f"the panel names {m} twice; a panel needs distinct models")
        out.append(m)
    if not 2 <= len(out) <= MAX_PANEL:
        raise ValueError(f"a panel takes 2 to {MAX_PANEL} models, got {len(out)}")
    return out


def seatings(n: int, rng: random.Random) -> list[dict[str, int]]:
    """For each panelist, the letter each OTHER panelist wears in its rebuttal prompt, dealt in a fresh random
    order per panelist, so "Reviewer A" is nobody in particular and nobody can track one voice across prompts."""
    out = []
    for me in range(n):
        others = [j for j in range(n) if j != me]
        rng.shuffle(others)
        out.append(dict(zip(string.ascii_uppercase, others)))
    return out


# ---------------------------------------------------------------- reading replies

def parse_findings(text: str, cap: int = MAX_FINDINGS) -> list[str]:
    """The numbered lines of a round-1 reply, in order, at most `cap`. Anything else in the reply is ignored."""
    out = []
    for line in (text or "").splitlines():
        m = _FINDING.match(line)
        if m and m.group(2).strip("*_` "):
            out.append(m.group(2).strip())
            if len(out) >= cap:
                break
    return out


def parse_positions(text: str) -> list[dict]:
    """The UPHOLD / REJECT / CONCEDE / MISSED lines of a round-2 reply as {stance, ref, why}. Tolerates the bullets
    and bold a model wraps them in. A MISSED line keeps its whole remainder as the new finding."""
    out = []
    for line in (text or "").splitlines():
        m = _POSITION.match(line)
        if not m:
            continue
        stance, ref, why = m.group(1).lower(), (m.group(2) or "").upper(), m.group(3).strip()
        if stance == "missed":
            rest = line[m.end(1):].lstrip(" *_:`-").strip()
            if rest:
                out.append({"stance": "missed", "ref": "", "why": rest})
        elif ref:
            out.append({"stance": stance, "ref": ref, "why": why})
    return out


# ---------------------------------------------------------------- prompts

def rebuttal_prompt(prompt: str, mine: list[str], seat: dict[str, int], findings: list[list[str]]) -> str:
    """Round 2 for one panelist: the original task, its own findings as Y1.., the others' as A1.., B1.. by seat."""
    parts = [prompt, "", "---", "Your own findings from round 1:"]
    parts += [f"Y{k}. {f}" for k, f in enumerate(mine, 1)] or ["(none)"]
    parts += ["", "The other reviewers' findings:"]
    for letter, j in seat.items():
        parts.append(f"Reviewer {letter}:")
        parts += [f"{letter}{k}. {f}" for k, f in enumerate(findings[j], 1)] or ["(no findings)"]
    parts += ["---", ROUND2_RULES]
    return "\n".join(parts)


# ---------------------------------------------------------------- regrouping

def tally(models: list[str], findings: list[list[str]], seats: list[dict[str, int]], positions: list[list[dict]]) -> dict:
    """Regroup every panelist's positions by the finding they are about, decoding each ref through THAT panelist's
    own seating. A finding is CONTESTED when someone rejects it while someone still stands behind it (the author,
    unless it conceded, or another panelist's UPHOLD)."""
    rows = {(i, k): {"id": f"P{i + 1}.{k + 1}", "by": models[i], "finding": f, "upheld_by": [], "rejected_by": [], "conceded": False, "why": []}
            for i, fs in enumerate(findings) for k, f in enumerate(fs)}
    missed, unresolved = [], 0
    for i, plist in enumerate(positions):
        for p in plist:
            if p["stance"] == "missed":
                missed.append({"by": models[i], "finding": p["why"]})
                continue
            letter, num = p["ref"][0], int(p["ref"][1:]) - 1
            if letter == "Y":
                key = (i, num)
            elif letter in seats[i]:
                key = (seats[i][letter], num)
            else:
                key = None
            row = rows.get(key) if key else None
            if row is None:
                unresolved += 1
                continue
            own = key[0] == i
            if own and p["stance"] == "concede":
                row["conceded"] = True
            elif own:
                continue  # a panelist upholding or rejecting its own finding says nothing new
            elif p["stance"] in ("uphold", "concede"):  # conceding another's point is agreeing with it
                row["upheld_by"].append(models[i])
            else:
                row["rejected_by"].append(models[i])
            if p["why"]:
                row["why"].append(f"{models[i]} {p['stance'].upper()}: {p['why']}")
    out = []
    for row in rows.values():
        row["upheld_by"], row["rejected_by"] = sorted(set(row["upheld_by"])), sorted(set(row["rejected_by"]))
        stands = row["upheld_by"] or not row["conceded"]
        if row["rejected_by"] and stands:
            row["status"] = "contested"
        elif row["conceded"] and not row["upheld_by"]:
            row["status"] = "conceded"
        elif row["upheld_by"]:
            row["status"] = "upheld"
        else:
            row["status"] = "unreviewed"
        out.append(row)
    order = {"contested": 0, "upheld": 1, "unreviewed": 2, "conceded": 3}
    out.sort(key=lambda r: (order[r["status"]], -len(r["upheld_by"])))
    return {"findings": out, "contested": [r["id"] for r in out if r["status"] == "contested"], "missed": missed, "unresolved_refs": unresolved}


# ---------------------------------------------------------------- the two rounds

async def panel(prompt: str, mgr=None, *, models: list[str] | None = None, system: str | None = None, max_findings: int = 8,
                reasoning_effort: str | None = "low", max_tokens: int = 8000, seed: int | None = None) -> dict:
    """Run the blind panel. Returns {findings, contested, missed, panel, summary, _results} where _results are the
    finished asks (for the caller to book). `mgr` is a JobManager; one is opened and closed here when None."""
    if not str(prompt or "").strip():
        raise ValueError("a panel needs a prompt to review")
    if not 1 <= int(max_findings) <= MAX_FINDINGS:
        raise ValueError(f"max_findings must be 1 to {MAX_FINDINGS}")
    t0 = time.perf_counter()
    seated = panelists(models)
    rng = random.Random(seed)
    head = ROUND1_SYSTEM.format(n=max_findings)
    sys1 = f"{system}\n\n{head}" if system else head
    results: list = []
    own_mgr = mgr is None
    if own_mgr:
        from .jobs import JobManager

        mgr = JobManager()

    async def one(model: str, text: str, sys: str):
        try:
            r = await mgr.ask_routed(text, model, system=sys, reasoning_effort=reasoning_effort, max_tokens=max_tokens)
        except Exception as e:  # noqa: BLE001 - one panelist crashing must not lose the others' reviews
            return None, f"{type(e).__name__}: {e}"[:200]
        results.append(r)
        return r, None if r.status == "ok" else (r.error or r.status)[:200]

    try:
        # Round 1: the same prompt to everyone at once, so no answer can colour another.
        first = await asyncio.gather(*(one(m, prompt, sys1) for m in seated))
        findings = [parse_findings(r.answer if r and not err else "", max_findings) for r, err in first]
        live = [i for i, (_, err) in enumerate(first) if not err]
        seats = [{} for _ in seated]
        positions: list[list[dict]] = [[] for _ in seated]
        second: dict[int, tuple] = {}
        if len(live) >= 2:
            # Round 2 only among panelists that answered, each seeing the others under freshly shuffled letters.
            dealt = seatings(len(live), rng)
            for pos, i in enumerate(live):
                seats[i] = {letter: live[j] for letter, j in dealt[pos].items()}
            sys2 = system or "You are one reviewer on an anonymous panel, weighing the other reviewers' findings."
            outs = await asyncio.gather(*(one(seated[i], rebuttal_prompt(prompt, findings[i], seats[i], findings), sys2) for i in live))
            for i, (r, err) in zip(live, outs):
                second[i] = (r, err)
                positions[i] = parse_positions(r.answer) if r and not err else []
    finally:
        if own_mgr:
            await mgr.aclose()
    out = tally(seated, findings, seats, positions)
    board = []
    for i, m in enumerate(seated):
        r1, err1 = first[i]
        row = {"seat": f"P{i + 1}", "model": m, "served_by": getattr(r1, "model", None) or m, "findings": len(findings[i])}
        if err1:
            row["error"] = err1
        elif i in second:
            row["positions"] = len(positions[i])
            if second[i][1]:
                row["rebuttal_error"] = second[i][1]
        board.append(row)
    cost = sum((getattr(r, "cost_usd", None) or 0.0) for r in results)
    note = None if len(live) >= 2 else "fewer than two panelists answered, so there was no rebuttal round"
    summary = {"panelists": len(seated), "answered": len(live), "findings": len(out["findings"]), "contested": len(out["contested"]),
               "missed": len(out["missed"]), "cost_usd": round(cost, 6), "seconds": round(time.perf_counter() - t0, 2)}
    if note:
        summary["note"] = note
    return out | {"panel": board, "summary": summary, "_results": results}
