"""The tool-receipt ledger: what an `api` worker actually did, checked against what it says it did.

A worker's final message is free text, and the orchestrator used to re-verify every "done" by hand.
Here every Sandbox call is stamped as a numbered receipt r1..rN (tool, args hash, ok/ERROR, output
sha256; a bash call also keeps its exit code, command and output tail), the worker is told to cite
[rN tool] for each action it claims, and two verdicts come back on the Result:

- citations: resolved / mismatched / unknown / uncited, so the orchestrator re-checks only the
  claims no receipt backs.
- green: for a task that asked for green evidence at a level, whether the "done" names a passing
  command receipt at that level (and, at merge_ready, the base sha a git receipt printed), with
  the list of what is missing.

Ideas from bytedance/deer-flow (tool receipts and cited self-reports, MIT) and ultraworkers/claw-code
(the evidence-graded green contract, MIT); written fresh for hswarm, no code copied.
"""
from __future__ import annotations

import hashlib
import json
import re

# Ordered lowest first: a claim at one level satisfies a task asking for any level below it.
GREEN_LEVELS = ("targeted_tests", "package", "workspace", "merge_ready")
# The level from which a green claim must also name the base it was tested on.
BASE_REQUIRED_FROM = "merge_ready"

TAIL_CHARS = 200  # the end of a bash output kept on its receipt: exit summaries and `git rev-parse` land there
MAX_LISTED = 5  # claims listed per verdict bucket; the counts stay exact
CLAIM_CHARS = 160

RECEIPT_CLAUSE = ("\n- Every tool result starts with its receipt, like [r3 grep]. For every action you claim in your final answer "
                  "(ran, edited, wrote, verified ...), cite the receipt that did it, like \"tests pass [r7 bash]\". "
                  "A claim with no receipt is reported to the orchestrator as unverified.")

GREEN_CLAUSE = ("\n- This task asks for green evidence at level {level} (levels, lowest first: " + ", ".join(GREEN_LEVELS) + "). "
                "Run the check with bash; if it passes, end your answer with one line: "
                "GREEN: level=<level reached> receipt=<rN of the passing run>{base}. "
                "If it did not pass, say so and write no GREEN line.")
GREEN_BASE = " base=<sha printed by a git rev-parse receipt>"

_CITE_RE = re.compile(r"\[(r\d+)(?:\s+([A-Za-z_]+))?\]")
_GREEN_RE = re.compile(r"^\s*GREEN:\s*(.+)$", re.MULTILINE)
_EXIT_RE = re.compile(r"^exit=(-?\d+)")
# Verbs that claim an action was taken. Plain findings ("X is defined at a.py:3") are not claims of
# action and are left alone; the file:line is the orchestrator's to open.
_RUN_VERBS = r"ran|executed|tested|compiled|tests?\s+(?:all\s+)?pass(?:ed|es)?"
_WRITE_VERBS = r"edited|wrote|written|created|updated|modified|fixed|deleted|removed|added|changed|replaced|renamed"
_CHECK_VERBS = r"verified|confirmed|checked"
_ACTION_RE = re.compile(rf"\b(?:{_RUN_VERBS}|{_WRITE_VERBS}|{_CHECK_VERBS})\b", re.IGNORECASE)
_RUN_RE = re.compile(rf"\b(?:{_RUN_VERBS})\b", re.IGNORECASE)
_WRITE_RE = re.compile(rf"\b(?:{_WRITE_VERBS})\b", re.IGNORECASE)
_PASS_RE = re.compile(r"\b(?:pass(?:ed|es|ing)?|green|succeeded)\b", re.IGNORECASE)
# The tools that can back each kind of claim: a test run needs a command, an edit needs a write (or a command).
_RUN_TOOLS = {"bash"}
_WRITE_TOOLS = {"write_file", "edit_file", "bash"}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def open_receipt(ledger: list[dict], name: str, args: dict) -> dict:
    """Number the call before it runs, so ids follow call order even when one turn's calls run concurrently."""
    rec = {"id": f"r{len(ledger) + 1}", "tool": name,
           "args_sha": _sha(json.dumps(args or {}, sort_keys=True, ensure_ascii=False, default=str)), "status": "pending"}
    if name == "bash":
        rec["command"] = str((args or {}).get("command") or "")[:CLAIM_CHARS]
    ledger.append(rec)
    return rec


def close_receipt(rec: dict, out: str) -> None:
    rec["status"] = "error" if out.startswith("ERROR") else "ok"
    rec["out_sha"] = _sha(out)
    if rec["tool"] == "bash":
        m = _EXIT_RE.match(out)
        rec["exit"] = int(m.group(1)) if m else None
        rec["tail"] = out[-TAIL_CHARS:]


def stamp(rec: dict, out: str) -> str:
    """The tool output the model sees: its receipt label first, so the model has an id to cite."""
    return f"[{rec['id']} {rec['tool']}]\n{out}"


def _claims(answer: str) -> list[str]:
    """The answer cut into sentence-sized claims (lines, then sentence ends), GREEN and FAILED lines dropped."""
    out = []
    for line in answer.splitlines():
        if _GREEN_RE.match(line) or line.strip().startswith("FAILED:"):
            continue
        out.extend(s.strip() for s in re.split(r"(?<=[.!?;])\s+", line) if s.strip())
    return out


def _label_fits(label: str | None, tool: str) -> bool:
    """A bare [rN] is fine; a label must name the receipt's tool (`read` passes for read_file)."""
    if not label:
        return True
    label = label.lower()
    return label == tool or tool.startswith(label + "_")


def _short(claim: str) -> str:
    return claim if len(claim) <= CLAIM_CHARS else claim[:CLAIM_CHARS] + "..."


def _action_re(tools: set[str] | None) -> re.Pattern:
    """The action verbs worth flagging when uncited. A task whose tools cannot write or run uses "added" or
    "changed" to describe code ("this commit added a guard"), not to claim an action, so those verbs drop out."""
    if tools is None:
        return _ACTION_RE
    tools = set(tools)  # a task's tools arrive as a list; `list & set` crashed every citation check on 2026-09-26
    verbs = [_CHECK_VERBS] + ([_RUN_VERBS] if tools & _RUN_TOOLS else []) + ([_WRITE_VERBS] if tools & _WRITE_TOOLS else [])
    return re.compile(rf"\b(?:{'|'.join(verbs)})\b", re.IGNORECASE)


def verify_citations(answer: str, ledger: list[dict], tools: set[str] | None = None) -> dict:
    """Check every [rN tool] citation in `answer` against the ledger and list the action claims no receipt backs.

    verdict (worst first): unknown - a cited id no call ever had (a hallucinated receipt); mismatched - the id
    exists but is a different tool, or a run/edit claim cites only receipts that cannot do that; uncited - an
    action claim cites nothing; resolved - every claim is backed; none - no action claimed, nothing cited.
    `tools` (the task's granted tool names) narrows the uncited check to the actions those tools could take."""
    action_re = _action_re(tools)
    by_id = {r["id"]: r for r in ledger}
    resolved, mismatched, unknown, uncited = 0, [], [], []
    for claim in _claims(answer or ""):
        cites = _CITE_RE.findall(claim)
        if not cites:
            if action_re.search(claim):
                uncited.append(_short(claim))
            continue
        backing = []
        for rid, label in cites:
            rec = by_id.get(rid)
            if rec is None:
                unknown.append(f"[{rid}{' ' + label if label else ''}] {_short(claim)}")
            elif not _label_fits(label, rec["tool"]):
                mismatched.append(f"[{rid} {label}] is {rec['tool']}: {_short(claim)}")
            else:
                resolved += 1
                backing.append(rec)
        tools = {r["tool"] for r in backing}
        if tools and ((_RUN_RE.search(claim) and not tools & _RUN_TOOLS) or (_WRITE_RE.search(claim) and not tools & _WRITE_TOOLS)):
            mismatched.append(f"cites {', '.join(sorted(tools))} for: {_short(claim)}")
        elif _PASS_RE.search(claim) and "bash" in tools and not any(r.get("exit") == 0 for r in backing if r["tool"] == "bash"):
            # "tests pass" citing a run that exited non-zero: the receipt exists, and it says the opposite.
            mismatched.append(f"claims a pass, but the cited run exited non-zero: {_short(claim)}")
    verdict = ("unknown" if unknown else "mismatched" if mismatched else "uncited" if uncited
               else "resolved" if resolved else "none")
    return {"verdict": verdict, "resolved": resolved, "receipts": len(ledger),
            "mismatched": mismatched[:MAX_LISTED], "unknown": unknown[:MAX_LISTED], "uncited": uncited[:MAX_LISTED],
            "counts": {"mismatched": len(mismatched), "unknown": len(unknown), "uncited": len(uncited)}}


def parse_green(answer: str, data: object = None) -> dict | None:
    """The worker's green claim: a `GREEN: level=.. receipt=.. base=..` line in the answer, or a `green` object
    (same keys) in its structured data. None when it claimed nothing."""
    if isinstance(data, dict) and isinstance(data.get("green"), dict):
        return _clean_claim({k: v for k, v in data["green"].items() if k in ("level", "receipt", "base") and v})
    if isinstance(data, dict) and isinstance(data.get("green"), str):
        answer = "GREEN: " + data["green"]
    m = None
    for m in _GREEN_RE.finditer(answer or ""):
        pass  # the last GREEN line wins: a worker that re-ran after a fix reports the final state
    if m is None:
        return None
    return _clean_claim(dict(kv.split("=", 1) for kv in m.group(1).split() if "=" in kv))


def _clean_claim(claim: dict) -> dict:
    """Workers decorate: `receipt=[r7 bash]`, `level="package"`. Keep the bare values."""
    out = {k: str(v).strip("[]<>'\",`") for k, v in claim.items()}
    if out.get("receipt"):
        m = re.search(r"r\d+", out["receipt"])
        out["receipt"] = m.group(0) if m else out["receipt"]
    return out


def evaluate_green(required: str, claim: dict | None, ledger: list[dict]) -> dict:
    """Whether a "done" carries the evidence the task asked for, and exactly what is missing when it does not."""
    out = {"required": required, "verdict": "unverified", "missing": []}
    missing = out["missing"]
    if claim is None:
        missing.append("no GREEN line: the answer claims no passing check")
        return out
    level, rid, base = claim.get("level"), claim.get("receipt"), claim.get("base")
    out.update({"claimed": level, "receipt": rid})
    if level not in GREEN_LEVELS:
        missing.append(f"level {level!r} is not one of {', '.join(GREEN_LEVELS)}")
    elif GREEN_LEVELS.index(level) < GREEN_LEVELS.index(required):
        missing.append(f"level: claimed {level}, the task asks for {required}")
    rec = next((r for r in ledger if r["id"] == rid), None)
    if rec is None:
        missing.append(f"receipt {rid!r} is not in the ledger: no such tool call was made")
    elif rec["tool"] != "bash":
        missing.append(f"receipt {rid} is a {rec['tool']} call, not a command run")
    else:
        out.update({"command": rec.get("command"), "exit_code": rec.get("exit")})
        if rec.get("exit") != 0:
            missing.append(f"command exited {rec.get('exit')}, not 0")
    if GREEN_LEVELS.index(required) >= GREEN_LEVELS.index(BASE_REQUIRED_FROM):
        if not base:
            missing.append("base: a merge_ready claim must name the base sha it was tested on")
        elif len(base) < 7 or not any(_is_git(r) and base in (r.get("tail") or "") for r in ledger):
            missing.append(f"base {base} was not printed by any git receipt")
        else:
            out["base_sha"] = base
    if not missing:
        out["verdict"] = "verified"
    return out


def _is_git(rec: dict) -> bool:
    """A git command receipt: a base sha an `echo` printed proves nothing about the tree tested."""
    return rec["tool"] == "bash" and str(rec.get("command") or "").lstrip().startswith("git ")


def unverified_ids(results: list[dict]) -> list[str]:
    """The finished tasks whose "done" the orchestrator should re-check first: a failed green contract, citations
    that do not hold up (unknown, mismatched, uncited), or a verdict that could not be computed (error)."""
    return [r["id"] for r in results if r.get("status") == "ok" and (
        (r.get("green") or {}).get("verdict") == "unverified"
        or (r.get("citations") or {}).get("verdict") in ("unknown", "mismatched", "uncited", "error"))]
