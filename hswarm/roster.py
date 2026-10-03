"""The review roster and its rules, with no model call in it: which reviewers run on a diff, how their findings
merge, which suppressions and dismissals count, and the verdict floor. hswarm/reviewverb.py fans the workers out.

Designs taken from four MIT-licensed review systems and written fresh for hswarm: react/react-native's
.expo-code-review (a reviewer per markdown file, a coordinator verdict, dismissal rules enforced in code),
garrytan/gstack's review army (specialists routed by the changed files, merged by fingerprint with a +1
agreement boost), mattpocock/skills' code-review (standards and spec as separate axes, never merged) and
mui/material-ui's review skill (a depth dial with hard fan-out caps).
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path

BUILTIN = Path(__file__).parent / "reviewers"
PROMPTS = ("shared", "coordinator")  # prompt files in a roster dir, not reviewers
SEVERITIES = ("minor", "important", "critical")
VERDICTS = ("approve", "approve_with_comments", "request_changes")
AXES = ("code", "spec")
IGNORE_MARK = "hswarm-review-ignore:"

# The depth dial: how many reviewer workers one review may start, whether the coordinator runs, and whether each
# surviving important-or-worse finding gets an independent verifier. The cost of a review scales with its risk.
DEPTHS = {
    "low": {"workers": 1, "coordinator": False, "verify": False},
    "medium": {"workers": 3, "coordinator": True, "verify": False},
    "high": {"workers": 5, "coordinator": True, "verify": False},
    "xhigh": {"workers": 8, "coordinator": True, "verify": False},
    "max": {"workers": None, "coordinator": True, "verify": True},
}


@dataclass
class Reviewer:
    name: str
    body: str
    description: str = ""
    axis: str = "code"
    always_run: bool = False
    priority: int = 100
    paths: list[str] = field(default_factory=list)
    when: str = ""  # "deletions": runs only on a diff that deletes lines
    needs: str = ""  # "spec": runs only when a spec is given


def frontmatter(text: str) -> tuple[dict, str]:
    """`key: value` lines between two `---` fences, then the body. Flat on purpose: no YAML dependency."""
    m = re.match(r"\A---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        return {}, text.strip()
    meta = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip():
            meta[k.strip()] = v.strip()
    return meta, text[m.end():].strip()


def load_roster(dirs: list[Path]) -> tuple[dict[str, Reviewer], dict[str, str]]:
    """Every `<name>.md` in `dirs`, a later dir overriding an earlier one by name: a reviewer is added by adding a file."""
    reviewers: dict[str, Reviewer] = {}
    prompts: dict[str, str] = {}
    for d in dirs:
        for p in sorted(Path(d).glob("*.md")) if Path(d).is_dir() else []:
            meta, body = frontmatter(p.read_text(encoding="utf-8"))
            if p.stem in PROMPTS:
                prompts[p.stem] = body
                continue
            axis = meta.get("axis", "code")
            if axis not in AXES:
                raise ValueError(f"reviewer {p}: axis must be one of {AXES}, not {axis!r}")
            reviewers[p.stem] = Reviewer(
                name=p.stem, body=body, description=meta.get("description", ""), axis=axis,
                always_run=meta.get("always_run", "").lower() in ("true", "yes", "1"), priority=int(meta.get("priority") or 100),
                paths=[g.strip() for g in meta.get("paths", "").split(",") if g.strip()], when=meta.get("when", ""), needs=meta.get("needs", ""))
    return reviewers, prompts


def changed_files(diff: str) -> list[str]:
    """The paths a unified diff touches (the new name; the old one for a deleted file)."""
    out: list[str] = []
    old = ""
    for line in diff.splitlines():
        if line.startswith("--- "):
            old = line[4:].strip()
        elif line.startswith("+++ "):
            new = line[4:].strip()
            path = old if new == "/dev/null" else new
            path = path[2:] if path[:2] in ("a/", "b/") else path
            if path != "/dev/null" and path not in out:
                out.append(path)
    return out


def has_deletions(diff: str) -> bool:
    return any(line.startswith("-") and not line.startswith("---") for line in diff.splitlines())


def _match(path: str, pattern: str) -> bool:
    return fnmatch(path, pattern) or (pattern.startswith("**/") and _match(path, pattern[3:]))


def select(reviewers: dict[str, Reviewer], files: list[str], deletions: bool, has_spec: bool, depth: str,
           only: list[str] | None = None) -> tuple[list[Reviewer], list[str]]:
    """The reviewers this diff calls for, always-run ones first, each group by priority, cut at the depth's cap.
    Returns (chosen, left out by the cap)."""
    wanted = []
    for r in sorted(reviewers.values(), key=lambda r: (not r.always_run, r.priority, r.name)):
        if only:
            if r.name in only:
                wanted.append(r)
            continue
        if (r.needs == "spec" and not has_spec) or (r.when == "deletions" and not deletions):
            continue
        if r.always_run or (r.when and not r.paths) or any(_match(f, g) for f in files for g in r.paths):
            wanted.append(r)
    cap = DEPTHS[depth]["workers"]
    if cap is None or only:
        return wanted, []
    return wanted[:cap], [r.name for r in wanted[cap:]]


def _norm_path(p: str) -> str:
    p = str(p or "").replace("\\", "/").strip()
    return p[2:] if p[:2] in ("./", "a/", "b/") else p


def fingerprint(axis: str, f: dict) -> str:
    """Same axis, file and line = same finding, whichever reviewer saw it. No line: the title stands in."""
    where = str(f.get("line")) if f.get("line") else re.sub(r"\W+", " ", str(f.get("title", "")).lower()).strip()
    return hashlib.sha1(f"{axis}|{_norm_path(f.get('file', ''))}|{where}".encode("utf-8")).hexdigest()[:8]


def worse(a: str, b: str) -> str:
    return max(a, b, key=lambda s: SEVERITIES.index(s) if s in SEVERITIES else 0)


def protected(f: dict) -> bool:
    """A critical or security finding: no ignore marker, dismissal, rerank or coordinator can make it go away."""
    return f.get("severity") == "critical" or bool(f.get("security"))


def _clean(f: dict, rv: Reviewer) -> dict:
    sev = f.get("severity") if f.get("severity") in SEVERITIES else "minor"
    try:
        conf = max(1, min(10, int(f.get("confidence") or 5)))
    except (TypeError, ValueError):
        conf = 5
    try:
        line = int(f.get("line") or 0) or None
    except (TypeError, ValueError):
        line = None
    return {**f, "file": _norm_path(f.get("file", "")), "line": line, "severity": sev, "confidence": conf, "axis": rv.axis,
            "reviewer": rv.name, "security": str(f.get("category", "")).lower() == "security" or rv.name == "security"}


def merge(reports: list[tuple[Reviewer, list[dict]]]) -> list[dict]:
    """Group every finding by fingerprint within its axis: keep the highest-confidence copy, the worst severity any
    copy gave, and add 1 to the confidence when two or more reviewers agree (capped at 10)."""
    groups: dict[str, dict] = {}
    for rv, findings in reports:
        for raw in findings or []:
            if not isinstance(raw, dict):
                continue
            f = _clean(raw, rv)
            fp = fingerprint(rv.axis, f)
            g = groups.get(fp)
            if g is None:
                groups[fp] = {**f, "id": fp, "agreed_by": [rv.name]}
                continue
            agreed = g["agreed_by"] + ([rv.name] if rv.name not in g["agreed_by"] else [])
            sev, sec = worse(g["severity"], f["severity"]), g["security"] or f["security"]
            if f["confidence"] > g["confidence"]:
                g = groups[fp] = {**f, "id": fp}
            g.update(agreed_by=agreed, severity=sev, security=sec)
    for g in groups.values():
        if len(g["agreed_by"]) > 1:
            g["confidence"] = min(10, g["confidence"] + 1)
    return ranked(list(groups.values()))


def ranked(findings: list[dict]) -> list[dict]:
    return sorted(findings, key=lambda f: (-SEVERITIES.index(f["severity"]), -f["confidence"], f["file"], f["line"] or 0))


def ignore_reason(root: Path, f: dict) -> str:
    """The reason of a `hswarm-review-ignore: <reason>` on the finding's line or the line above; '' when none.
    The finding's path is model output, so a path that leaves the review root is never opened."""
    if not f.get("line") or not f.get("file"):
        return ""
    base = Path(root).resolve()
    p = (base / f["file"]).resolve()
    if not p.is_relative_to(base) or not p.is_file():
        return ""
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    for n in (f["line"], f["line"] - 1):
        if 1 <= n <= len(lines) and IGNORE_MARK in lines[n - 1]:
            reason = lines[n - 1].split(IGNORE_MARK, 1)[1].strip(" */#->")
            if reason:
                return reason
    return ""


def apply_rules(findings: list[dict], root: Path, dismissals: dict[str, str], drop_dismissed: bool = False) -> tuple[list[dict], list[dict]]:
    """Suppressions and dismissals, enforced here rather than trusted to a prompt. An inline ignore marker drops a
    finding; a dismissal (`id:<fp>=reason`) only annotates it unless `drop_dismissed`; neither touches a protected one."""
    kept, suppressed = [], []
    for f in findings:
        reason = ignore_reason(root, f)
        if reason and not protected(f):
            suppressed.append({**f, "suppressed": f"ignore marker: {reason}"})
            continue
        if reason:
            f["ignore_refused"] = reason
        if f["id"] in dismissals:
            f["dismissed"] = dismissals[f["id"]]
            if drop_dismissed and not protected(f):
                suppressed.append({**f, "suppressed": f"dismissed: {f['dismissed']}"})
                continue
        kept.append(f)
    return kept, suppressed


def apply_coordinator(findings: list[dict], coord: dict | None) -> list[dict]:
    """The coordinator's duplicates and reranks, on known ids only (it cannot invent or delete a finding), never
    across axes, and never lowering a protected finding."""
    if not coord:
        return findings
    by_id = {f["id"]: f for f in findings}
    for d in coord.get("duplicates") or []:
        a, b = by_id.get(str(d.get("id"))), by_id.get(str(d.get("same_as")))
        if not a or not b or a is b or a["axis"] != b["axis"]:
            continue
        b.update(agreed_by=sorted(set(b["agreed_by"]) | set(a["agreed_by"])), severity=worse(a["severity"], b["severity"]),
                 security=b["security"] or a["security"], merged=b.get("merged", []) + [a["id"]])
        by_id.pop(a["id"])
    for r in coord.get("rerank") or []:
        f, sev = by_id.get(str(r.get("id"))), r.get("severity")
        if not f or sev not in SEVERITIES or sev == f["severity"]:
            continue
        if protected(f) and SEVERITIES.index(sev) < SEVERITIES.index(f["severity"]):
            f["rerank_refused"] = f"{sev}: {r.get('reason', '')}"
        else:
            f.update(severity=sev, reranked=f"{r.get('reason', '')}")
    return ranked(list(by_id.values()))


def apply_verifications(findings: list[dict], checks: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    """Drop what an independent verifier refuted; a protected finding stays, marked unverified."""
    kept, refuted = [], []
    for f in findings:
        c = checks.get(f["id"])
        if c is not None and c.get("real") is False:
            if not protected(f):
                refuted.append({**f, "suppressed": f"refuted by verifier: {c.get('reason', '')}"})
                continue
            f["unverified"] = c.get("reason", "")
        kept.append(f)
    return kept, refuted


def floor(findings: list[dict]) -> str:
    """The least a verdict can be: a critical finding blocks, an important one earns comments, else approve."""
    sevs = {f["severity"] for f in findings}
    return "request_changes" if "critical" in sevs else "approve_with_comments" if "important" in sevs else "approve"


def final_verdict(findings: list[dict], coordinator_verdict: str | None) -> str:
    base = floor(findings)
    if coordinator_verdict in VERDICTS and VERDICTS.index(coordinator_verdict) > VERDICTS.index(base):
        return coordinator_verdict
    return base


def by_axis(findings: list[dict], axes: list[str]) -> dict[str, dict]:
    """Each axis reported on its own, with its own verdict and its worst finding: one never masks the other."""
    out = {}
    for axis in axes:
        fs = [f for f in findings if f["axis"] == axis]
        out[axis] = {"verdict": floor(fs), "worst": (f"{fs[0]['severity']} id:{fs[0]['id']} {fs[0].get('title', '')}" if fs else ""), "findings": fs}
    return out
