"""Review with an evidence bar: the contracts review roles carry, and the checks that need no model.

WHY (harvest 2026-09-25): cheap reviewer workers hand back confident findings nobody can check ("this field
does not exist") and flag code the change never touched, and the orchestrator pays to re-read every one. So:
- the `judge` role carries an evidence bar: say what you read, cite path:line with the verbatim quote and a
  concrete failure mode or it is only a question, at most five nits, a re-review reports only the delta;
- every finding's quote is checked MECHANICALLY against the file it cites, and one that is not there is
  demoted below the display line before the orchestrator reads it;
- each finding is anchored in_diff / off_diff by 3-gram overlap with the diff's changed lines, and a
  `refute` worker with repo read access then tries to disprove each one (attacker and victim named, cited
  evidence only, default SURVIVES, off_diff held to a stricter bar); a refute pass that fails keeps them all;
- the `doubt` role reviews an ARTIFACT against its CONTRACT and is never handed the author's claim, which
  biases a reviewer toward agreeing; its issues come back in a fixed precedence, and two or more cycles with
  substantive issues but nothing actionable is flagged as doubt theater.

Ideas from anthropics/claude-code security-guidance (diff anchor and adversarial refute; ideas only),
addyosmani/agent-skills doubt-driven-development, garrytan/gstack's confidence gate and electron/electron
REVIEW.md. Written fresh for hswarm; no code copied. Nothing here talks to the network; run_review and
run_doubt drive the JobManager they are handed."""
from __future__ import annotations

import time

import asyncio
import copy
import json
import re
import subprocess
from pathlib import Path

from .procgate import CREATE_NO_WINDOW

JUDGE_CONTRACT = """Evidence bar for every finding you report:
- First say what you could see: the files you actually read. A claim about code you did not read is not a finding; ask it as a question (severity "question").
- An "important" finding needs a path and line in a file you read, the verbatim line(s) that motivate it in `quote`, and a concrete failure mode (the input or sequence that breaks, and what happens). Missing any of the three, it is a question.
- `quote` is copied character for character from the file, without line-number prefixes. A finding whose quote is not in the cited file is dropped before anyone reads it.
- At most 5 nits; give a count of the rest instead of listing them.
- Report nothing a compiler, type checker, linter, formatter or the test suite already enforces.
- On a re-review, report only important findings, and for each earlier finding whether it is now fixed."""

REFUTE_CONTRACT = """You are the refute pass. Each candidate finding below came from another reviewer. Try to DISPROVE each one by reading and searching the repository.
- For each finding name the attacker (who or what triggers the failure) and the victim (who or what is harmed). No plausible attacker and victim means the finding is refuted.
- Refute only with cited evidence: a path:line you read showing the code does not behave as claimed (a guard, a caller that never passes that value, a test that pins the behaviour). Doubt without a citation is not a refutation.
- When unsure, the finding SURVIVES.
- A finding marked off_diff cites code the change did not touch. Hold it to a stricter bar: list it as survived only when you confirmed the failure yourself and it is reachable from the changed code.
- Submit `survived` (the indices that stand) and `refuted` (one entry per refuted index, with attacker, victim and the path:line evidence)."""

DOUBT_CONTRACT = """You are a fresh, adversarial reviewer. You are given an ARTIFACT and the CONTRACT it must satisfy, and nothing else. Report issues only: no praise, no summary, no overall verdict.
Classify each issue as exactly one kind:
- contract_misread: the artifact answers a different question than the contract asks
- actionable: a concrete defect with a specific fix
- tradeoff: a real cost the author may have chosen knowingly; name the cost
- noise: style, taste or preference
Say where in the artifact each issue is (a short quote or line). An empty list is a valid answer."""

# The contract each review role carries on top of the caller's own system prompt (spec.Task, hswarm_ask).
ROLE_CONTRACTS = {"judge": JUDGE_CONTRACT, "refute": REFUTE_CONTRACT, "doubt": DOUBT_CONTRACT}

SEVERITIES = ("important", "nit", "question")
FINDINGS_SCHEMA = {
    "type": "object",
    "properties": {
        "read": {"type": "array", "items": {"type": "string"}, "description": "files you actually read"},
        "findings": {"type": "array", "items": {"type": "object", "properties": {
            "path": {"type": "string"},
            "line": {"type": "integer"},
            "quote": {"type": "string", "description": "the verbatim line(s) from `path` that motivate the finding"},
            "severity": {"type": "string", "enum": list(SEVERITIES)},
            "claim": {"type": "string"},
            "failure_mode": {"type": "string", "description": "the input or sequence that breaks, and what happens"},
            "confidence": {"type": "integer", "minimum": 1, "maximum": 10},
        }, "required": ["path", "quote", "severity", "claim", "confidence"]}},
        "nits_not_listed": {"type": "integer"},
    },
    "required": ["read", "findings"],
}
REFUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "survived": {"type": "array", "items": {"type": "integer"}},
        "refuted": {"type": "array", "items": {"type": "object", "properties": {
            "index": {"type": "integer"}, "attacker": {"type": "string"}, "victim": {"type": "string"},
            "evidence": {"type": "string", "description": "path:line you read that disproves the finding"},
        }, "required": ["index", "evidence"]}},
    },
    "required": ["survived", "refuted"],
}
DOUBT_KINDS = ("contract_misread", "actionable", "tradeoff", "noise")  # reconciliation precedence, first wins
DOUBT_SCHEMA = {
    "type": "object",
    "properties": {"issues": {"type": "array", "items": {"type": "object", "properties": {
        "kind": {"type": "string", "enum": list(DOUBT_KINDS)}, "issue": {"type": "string"},
        "where": {"type": "string"}, "fix": {"type": "string"},
    }, "required": ["kind", "issue"]}}},
    "required": ["issues"],
}

NIT_CAP = 5
SHOW_AT = 5  # confidence 5-10 is shown; 3-4 goes to the appendix; 1-2 is suppressed
APPENDIX_AT = 3
UNVERIFIED_CAP = 4  # a finding whose quote is not in its file can never reach the shown list
ANCHOR_OVERLAP = 0.5  # share of a quote's 3-grams that must appear in the diff's changed lines to count as in_diff
MAX_REFUTE_DIFF_CHARS = 60_000
MAX_DOUBT_CYCLES = 3


def with_contract(role: str | None, system: str | None) -> str | None:
    """The caller's system prompt with the role's contract ahead of it; unchanged for a role without one."""
    contract = ROLE_CONTRACTS.get((role or "").strip().lower())
    if not contract or (system and contract in system):
        return system
    return contract + ("\n\n" + system.strip() if system and system.strip() else "")


# ---- the quote check ----

_WS = re.compile(r"\s+")
_LINE_NO = re.compile(r"^\s*\d+\t")  # read_file prefixes "N\t"; a worker that copies it has still quoted the file


def _squash(text: str) -> str:
    return _WS.sub(" ", text).strip()


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def quote_found(root: str | Path, path: str | None, quote: str | None) -> bool:
    """True when `quote` appears in the file `path` names (whitespace runs compared as one space). A path
    outside `root`, a missing file or an empty quote is False: unverifiable reads the same as wrong."""
    if not path or not quote or not _squash(quote):
        return False
    base = Path(root).resolve()
    p = Path(path)
    p = (p if p.is_absolute() else base / p).resolve()
    if not _inside(p, base) or not p.is_file():
        return False
    try:
        text = _squash(p.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return False
    if _squash(quote) in text:
        return True
    unnumbered = _squash("\n".join(_LINE_NO.sub("", ln) for ln in quote.splitlines()))
    return bool(unnumbered) and unnumbered in text


# ---- the diff anchor ----

_DIFF_FILE = re.compile(r"^\+\+\+ (?:b/)?(.+?)\s*$")
_DIFF_HEADER = re.compile(r"^(?:\+\+\+|---) (?:[ab]/|/dev/null)")
_TOKEN = re.compile(r"\w+|[^\w\s]")


def changed_lines(diff: str) -> dict[str, list[str]]:
    """The added and removed lines of a unified diff, per file (the post-image path; '' before any header)."""
    out: dict[str, list[str]] = {}
    current = ""
    for ln in (diff or "").splitlines():
        m = _DIFF_FILE.match(ln)
        if m:
            current = "" if m.group(1) == "/dev/null" else m.group(1)
            continue
        if _DIFF_HEADER.match(ln):
            continue
        if ln[:1] in ("+", "-") and ln[1:].strip():
            out.setdefault(current, []).append(ln[1:])
    return out


def _grams(text: str) -> set[tuple[str, ...]]:
    toks = _TOKEN.findall(text)
    if len(toks) < 3:
        return {tuple(toks)} if toks else set()
    return {tuple(toks[i:i + 3]) for i in range(len(toks) - 2)}


def _same_file(a: str, b: str) -> bool:
    """A finding may cite a path relative, absolute or './'-prefixed; the diff names it from the repo root."""
    a, b = (s.replace("\\", "/").removeprefix("./") for s in (a, b))
    return bool(a and b) and (a == b or a.endswith("/" + b) or b.endswith("/" + a))


def anchor(finding: dict, changed: dict[str, list[str]]) -> str:
    """'in_diff' when most of the finding's quoted code is among the diff's changed lines of the same file
    (any file when the finding names none), else 'off_diff'."""
    want = _grams(str(finding.get("quote") or ""))
    if not want:
        return "off_diff"
    path = str(finding.get("path") or "")
    for f, lines in changed.items():
        if path and f and not _same_file(path, f):
            continue
        have = set().union(*(_grams(ln) for ln in lines))
        if len(want & have) / len(want) >= ANCHOR_OVERLAP:
            return "in_diff"
    return "off_diff"


# ---- the gate: quote check, citation rule, confidence display, nit cap ----

def _confidence(f: dict) -> int:
    try:
        return max(1, min(10, int(f.get("confidence"))))
    except (TypeError, ValueError):
        return SHOW_AT


def gate(findings: list[dict], root: str | Path, diff: str | None = None, nit_cap: int = NIT_CAP) -> dict:
    """Apply the evidence bar to raw findings. Each keeps its input position as `index`. A quote not found in
    its cited file caps confidence at 4 (so it can only reach the appendix) and makes an important finding a
    question; an important finding with no line or no failure mode is a question too. Confidence 5+ is shown,
    3-4 is the appendix, 1-2 is suppressed; nits past `nit_cap` become a count."""
    changed = changed_lines(diff) if diff else None
    shown: list[dict] = []
    appendix: list[dict] = []
    suppressed = unverified = 0
    for i, raw in enumerate(findings or []):
        if not isinstance(raw, dict):
            continue
        f = dict(raw, index=i, confidence=_confidence(raw))
        sev = str(f.get("severity") or "question").lower()
        f["severity"] = sev if sev in SEVERITIES else "question"
        f["verified"] = quote_found(root, f.get("path"), f.get("quote"))
        if not f["verified"]:
            unverified += 1
            f["confidence"] = min(f["confidence"], UNVERIFIED_CAP)
            if f["severity"] == "important":
                f["severity"], f["demoted"] = "question", "quote not found in the cited file"
        elif f["severity"] == "important" and not (f.get("line") and str(f.get("failure_mode") or "").strip()):
            f["severity"], f["demoted"] = "question", "no line or no concrete failure mode"
        if changed is not None:
            f["anchor"] = anchor(f, changed)
        if f["confidence"] >= SHOW_AT:
            shown.append(f)
        elif f["confidence"] >= APPENDIX_AT:
            appendix.append(f)
        else:
            suppressed += 1
    nits = sorted((f for f in shown if f["severity"] == "nit"), key=lambda f: -f["confidence"])
    over = {id(f) for f in nits[max(0, nit_cap):]}
    return {"findings": [f for f in shown if id(f) not in over], "appendix": appendix, "suppressed": suppressed,
            "unverified": unverified, "nits_omitted": len(over)}


# ---- the refute pass ----

_CITATION = re.compile(r"[\w./\\-]+:\d+")


def refute_prompt(findings: list[dict], diff: str, focus: str = "") -> str:
    keep = ("index", "anchor", "severity", "path", "line", "quote", "claim", "failure_mode")
    listed = [{k: f[k] for k in keep if k in f} for f in findings]
    body = diff if len(diff) <= MAX_REFUTE_DIFF_CHARS else diff[:MAX_REFUTE_DIFF_CHARS] + "\n... [diff truncated]"
    return ((f"Review focus: {focus}\n\n" if focus else "") + "CANDIDATE FINDINGS:\n" + json.dumps(listed, indent=1)
            + "\n\nTHE CHANGE UNDER REVIEW (unified diff):\n" + body)


def apply_refute(findings: list[dict], status: str, data) -> dict:
    """Which findings stand after the refute pass. A failed or malformed pass keeps every finding. An in_diff
    finding falls only to a refutation citing path:line; an off_diff one must also be listed as survived."""
    if status != "ok" or not isinstance(data, dict) or not isinstance(data.get("survived"), list):
        return {"kept": list(findings), "refuted": [], "note": f"refute pass did not complete ({status}): every finding kept"}
    survived = {s for s in data["survived"] if isinstance(s, int)}
    cited = {}
    for r in data.get("refuted") or []:
        if isinstance(r, dict) and isinstance(r.get("index"), int) and _CITATION.search(str(r.get("evidence") or "")):
            cited[r["index"]] = r
    kept, refuted = [], []
    for f in findings:
        i = f.get("index")
        if i in cited and i not in survived:
            refuted.append(dict(f, refutation=cited[i]))
        elif f.get("anchor") == "off_diff" and i not in survived:
            refuted.append(dict(f, refutation={"evidence": "off_diff and not confirmed by the refute pass"}))
        else:
            kept.append(f)
    return {"kept": kept, "refuted": refuted, "note": ""}


def git_diff(cwd: str, base: str = "HEAD") -> str:
    """`git diff <base>` in cwd: the change a review is anchored to. Empty when git fails."""
    try:
        p = subprocess.run(["git", "-C", cwd, "diff", base, "--"], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return p.stdout if p.returncode == 0 else ""


def investigate_prompt(diff: str, focus: str = "") -> str:
    body = diff if len(diff) <= MAX_REFUTE_DIFF_CHARS else diff[:MAX_REFUTE_DIFF_CHARS] + "\n... [diff truncated]"
    return ("Review the change below. Read the files it touches and their callers before you claim anything about them."
            + (f"\nReview focus: {focus}" if focus else "") + "\n\nTHE CHANGE (unified diff):\n" + body)


async def _one(mgr, task, label: str, wait_s: float, budget_usd: float | None):
    """One single-task job, waited on; (job id, its Result or None). A job the manager books like any hswarm_run."""
    job = mgr.submit([task], label=label, budget_usd=budget_usd)
    job = await mgr.wait(job.id, wait_s)
    return job.id, job.results.get(task.id)


async def run_review(mgr, cwd: str, diff: str, focus: str = "", findings: list[dict] | None = None, refute: bool = True,
                     nit_cap: int = NIT_CAP, wait_s: float = 600, budget_usd: float | None = None) -> dict:
    """Investigate (unless `findings` are handed in), gate, then refute. Two jobs at most, both inside `wait_s`: the
    MCP caller is dropped once a call is silent for ~300 s (mcp_server.RUN_WAIT_MAX_S), so refute waits what is left."""
    end = time.monotonic() + wait_s
    from .spec import Task

    jobs: list[str] = []
    read: list[str] = []
    if findings is None:
        task = Task.from_dict({"prompt": investigate_prompt(diff, focus), "id": "investigate", "cwd": cwd, "tools": "read",
                               "system": JUDGE_CONTRACT, "schema": FINDINGS_SCHEMA})
        job_id, res = await _one(mgr, task, "review:investigate", wait_s, budget_usd)
        jobs.append(job_id)
        # A job that outlives wait_s keeps running (and spending): say so and name the job, not "did not complete".
        if res is None or res.status in ("pending", "running"):
            return {"error": f"investigate pass still running after {wait_s:g}s; read it later with "
                             f"hswarm_results(job_id={job_id!r}), then hand its findings back in", "jobs": jobs}
        if res.status != "ok" or not isinstance(res.data, dict):
            return {"error": f"investigate pass did not complete ({getattr(res, 'status', 'missing')}): "
                             f"{getattr(res, 'error', '') or 'no structured result'}", "jobs": jobs}
        findings = res.data.get("findings") or []
        read = res.data.get("read") or []
    out = gate(findings, cwd, diff, nit_cap)
    out["read"], out["refuted"], out["refute"] = read, [], "skipped"
    if refute and out["findings"]:
        task = Task.from_dict({"prompt": refute_prompt(out["findings"], diff, focus), "id": "refute", "cwd": cwd,
                               "tools": "read", "role": "refute", "schema": REFUTE_SCHEMA})
        job_id, res = await _one(mgr, task, "review:refute", max(1.0, end - time.monotonic()), budget_usd)
        jobs.append(job_id)
        applied = apply_refute(out["findings"], getattr(res, "status", "missing"), getattr(res, "data", None))
        out["findings"], out["refuted"], out["refute"] = applied["kept"], applied["refuted"], applied["note"] or "done"
    out["jobs"] = jobs
    return out


# ---- the doubt cycle ----

def doubt_prompt(artifact: str, contract: str) -> str:
    """ARTIFACT and CONTRACT only: the author's claim is never an input, so it cannot bias the reviewer."""
    return f"CONTRACT:\n{contract.strip()}\n\nARTIFACT:\n{artifact.strip()}"


def reconcile(issues: list[dict]) -> list[dict]:
    """Issues in fixed precedence (contract_misread, actionable, tradeoff, noise); an unknown kind is noise."""
    fixed = [dict(i, kind=i.get("kind") if i.get("kind") in DOUBT_KINDS else "noise") for i in issues or [] if isinstance(i, dict)]
    return sorted(fixed, key=lambda i: DOUBT_KINDS.index(i["kind"]))


def doubt_verdict(cycles: list[list[dict]]) -> dict:
    """Whether to run another doubt cycle. Stop after MAX_DOUBT_CYCLES, when the latest cycle found nothing
    substantive (anything but noise), or on doubt theater: two or more cycles with substantive issues and none
    actionable (a contract misread counts as actionable)."""
    substantive = [sum(i.get("kind") != "noise" for i in c) for c in cycles]
    actionable = [sum(i.get("kind") in ("contract_misread", "actionable") for i in c) for c in cycles]
    theater = sum(1 for s, a in zip(substantive, actionable) if s and not a) >= 2
    if theater:
        reason = "doubt theater: substantive issues in two or more cycles, none actionable"
    elif len(cycles) >= MAX_DOUBT_CYCLES:
        reason = f"cycle cap ({MAX_DOUBT_CYCLES}) reached"
    elif cycles and not substantive[-1]:
        reason = "latest cycle found nothing substantive"
    else:
        reason = ""
    return {"cycle": len(cycles), "stop": bool(reason), "reason": reason, "doubt_theater": theater}


async def run_doubt(mgr, artifact: str, contract: str, history: list[list[dict]] | None = None) -> tuple[dict, object]:
    """One doubt cycle on the `doubt` role's model; returns the payload and the Result (for the caller's ledger)."""
    r = await mgr.ask_role("doubt", doubt_prompt(artifact, contract), system=DOUBT_CONTRACT, schema=DOUBT_SCHEMA)
    if r.status != "ok" or not isinstance(r.data, dict):
        return {"error": f"doubt pass did not complete ({r.status}): {r.error or 'no structured result'}", "model": r.model}, r
    issues = reconcile(r.data.get("issues") or [])
    return {"issues": issues, "model": r.model, **doubt_verdict([*(history or []), issues])}, r


async def diff_for(cwd: str, diff: str | None, base: str) -> str:
    return diff if diff else await asyncio.to_thread(git_diff, cwd, base)


# ---- coverage receipts and the `review` role's rubric --------------------------------------------------
# Review work: the coverage receipt a reviewing worker hands back, and the written rubric of the `review` role.
#
# A cheap worker's commonest review failure is the silent partial review: it reads three files of ten and reports
# "no issues", and the orchestrator takes that at face value. A task that declares its input `inventory` must return
# `reviewed_paths` equal to it, and hswarm checks that mechanically, never the worker itself: a path the worker could
# not assess is left out, so the review fails instead of passing on what nobody read. The receipt idea is adapted from
# astral-sh/uv's security-review prompt (Apache-2.0); the rubric's evidence classes and failure shapes follow the
# ideas of clash-verge-rev's PR review, written fresh here (no text taken). Nothing here talks to the network.

RECEIPT_KEY = "reviewed_paths"
ROLE = "review"
_LISTED = 20  # paths named per side in a rejection; the rest are counted, so an error stays readable


def norm_path(p: str) -> str:
    """One spelling per path, so `.\\src\\a.py`, `./src/a.py` and `src/a.py` are the same receipt line."""
    s = str(p).strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return s.rstrip("/") or s


def with_receipt(schema: dict | None) -> dict:
    """The task's output schema with `reviewed_paths` added and required. No schema gets a minimal one, so declaring
    an inventory alone is enough to demand the receipt."""
    out = copy.deepcopy(schema) if schema else {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}
    out.setdefault("type", "object")
    out.setdefault("properties", {})[RECEIPT_KEY] = {
        "type": "array", "items": {"type": "string"},
        "description": "Every inventory path you FULLY reviewed, spelled as given. Leave out any you could not assess.",
    }
    required = list(out.get("required") or [])
    out["required"] = required + ([RECEIPT_KEY] if RECEIPT_KEY not in required else [])
    return out


def receipt_clause(inventory: list[str]) -> str:
    """The per-task half of the contract, appended to the prompt (the shared system prompt stays cacheable)."""
    return (f"Coverage receipt: this review covers exactly the {len(inventory)} path(s) below, including any the change "
            f"deletes (judge a deletion from the diff). In `{RECEIPT_KEY}` list every one you fully reviewed, spelled as "
            "given. Leave out any you could not assess: an incomplete receipt fails the whole review, which is the honest "
            "outcome. Never list a path you did not read.\n" + "\n".join(f"- {p}" for p in inventory))


def _names(paths: list[str]) -> str:
    head = ", ".join(paths[:_LISTED])
    return head + (f" (+{len(paths) - _LISTED} more)" if len(paths) > _LISTED else "")


def receipt_gap(inventory: list[str], data: object) -> str | None:
    """Why `data`'s receipt does not equal `inventory`, or None when it does. Both sides compare as normalised sets:
    a path left out is an unreviewed input, and a path not in the inventory is a claim about work nobody asked for."""
    got = data.get(RECEIPT_KEY) if isinstance(data, dict) else None
    if not isinstance(got, list) or not all(isinstance(p, str) for p in got):
        return f"IncompleteReview: no `{RECEIPT_KEY}` receipt (a list of path strings) for an inventory of {len(inventory)} path(s)"
    want = [norm_path(p) for p in inventory]
    have = {norm_path(p) for p in got}
    missing = [p for p in want if p not in have]
    extra = sorted(have - set(want))
    if not missing and not extra:
        return None
    parts = ([f"not reviewed {_names(missing)}"] if missing else []) + ([f"not in the inventory {_names(extra)}"] if extra else [])
    return f"IncompleteReview: `{RECEIPT_KEY}` does not match the task's inventory of {len(want)} path(s): " + "; ".join(parts)


def unread_gap(inventory: list[str], cwd, files_read: set[Path]) -> str | None:
    """Why a matching receipt is still not trusted, or None. The worker has the whole inventory in its prompt, so on
    a retry it could list every path without opening one; on the api backend the sandbox records each file read_file
    opened, and every inventory path that still exists as a file must be among them. A deleted path is judged from
    the diff, so it needs no read."""
    base = Path(cwd)
    unread = [p for p in inventory if (q := (base / p).resolve()).is_file() and q not in files_read]
    if not unread:
        return None
    return f"IncompleteReview: `{RECEIPT_KEY}` lists {len(unread)} path(s) never opened with read_file: {_names(unread)}"


def enforce_receipt(res, inventory: list[str]) -> None:
    """The job-level gate, run by hswarm on every finished task that declared an inventory, whatever the backend: an
    `ok` result whose receipt does not match becomes an error. Its answer and data stay, so the caller sees what the
    worker did cover."""
    if res.status == "ok" and (gap := receipt_gap(inventory, res.data)):
        res.status, res.error = "error", gap


# The `review` role's rubric (config.ROLES wires its model). Authorship-neutral on purpose: the task and the code
# decide, never who or what wrote them. Evidence classes and failure shapes are the ones agent-written diffs show.
RUBRIC = """You review a change made for a task. Judge the change against the task and the code, never against its author: who or what wrote it decides nothing.

Read the diff and every file it touches before you judge. The change's own description, commit message and comments are claims, not evidence: the code is the evidence.

Weigh three kinds of evidence:
- problem: does the change address the problem the task states? Point at the lines that do, or say what is missing.
- solution: is it correct and complete, consistent with the code around it, and free of regressions?
- ownership: does every changed file and hunk exist because the task needs it?

Report each problem as a finding with an exact path, side (old or new) and line range, and one of these shapes:
- defect: a bug, a regression or a broken contract.
- scope_drift: files or hunks the task does not need: renames, reformatting, unrelated refactors, drive-by fixes.
- test_padding: tests that pin nothing the change does, repeat existing ones, or would still pass with the change removed.
- defensive_padding: guards, fallbacks or try/except for cases that cannot happen, added to look careful.
- explanation_only: a resubmission whose code did not change, only its explanation, message or comments.
- other: anything else that blocks acceptance.

Rerun stability: the verdict follows the code. The same code judged again gets the same verdict; a rewritten explanation with no code change never earns a better one.

Verdict: accept when there is no defect and no scope_drift; revise when the fixes are small and named; reject when the change does not address the task or its evidence is missing."""


def review_schema() -> dict:
    """The default output of a `review` task that names no schema of its own."""
    finding = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "side": {"type": "string", "enum": ["old", "new"]},
            "line_start": {"type": "integer"},
            "line_end": {"type": "integer"},
            "shape": {"type": "string", "enum": ["defect", "scope_drift", "test_padding", "defensive_padding", "explanation_only", "other"]},
            "issue": {"type": "string"},
        },
        "required": ["path", "side", "line_start", "line_end", "shape", "issue"],
    }
    return {
        "type": "object",
        "properties": {
            "verdict": {"type": "string", "enum": ["accept", "revise", "reject"]},
            "problem": {"type": "string", "description": "evidence the change addresses the task's problem, or what is missing"},
            "solution": {"type": "string", "description": "evidence the change is correct and complete, or what is wrong"},
            "ownership": {"type": "string", "description": "whether every changed file and hunk is needed by the task"},
            "findings": {"type": "array", "items": finding},
            "summary": {"type": "string"},
        },
        "required": ["verdict", "problem", "solution", "ownership", "findings", "summary"],
    }
