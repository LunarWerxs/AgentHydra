"""Mine the tool procedures agents keep re-deriving into skill candidates - deterministic, no model call.

Every tool call in a Claude Code transcript is reduced to a signature with its paths and arguments
thrown away (`Read(*.py)`, `Bash(pytest)`, `Bash(git status)`). Runs of 3-6 consecutive signatures
that recur in at least 3 sessions and cost at least 15k tokens between them are ranked by that cost,
and the top few are staged as `trust: unreviewed` candidates for the Script Vault or a skill.

The number reported is the MEASURED cost of re-deriving the procedure (output tokens the model spent
issuing the steps plus the tool-result tokens it read back, at chars/4), never a claimed saving.
Nothing leaves the machine; the default only prints the ranking, --apply writes the staging files.

    python -m hswarm procedures --since 30            # print the ranked candidates
    python -m hswarm procedures --since 30 --apply    # also stage them in claude-memory's staging/ (hswarm triage --candidates judges them)

Idea from JuliusBrussee/caveman (proxy/internal/store/detect_procedures.go); no code copied, written fresh.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from . import config, triage
from .candidates import _slug
from .transcripts import find_transcripts, redact

FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"}
# Programs whose first word alone says too little: `git status` and `git commit` are different steps.
SUBCOMMAND_PROGRAMS = {"git", "gh", "npm", "pnpm", "yarn", "npx", "cargo", "go", "uv", "pip", "docker", "dotnet", "kubectl", "make"}
PYTHONS = {"python", "python3", "py"}
# Where `hswarm triage` used to move a staged candidate once judged; a candidate there is already staged.
TRIAGE_SUBDIRS = ("keep", "duplicate", "trivial")
_WORD = re.compile(r"^[a-z][a-z0-9_.-]*$")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# A quoted program path with spaces is one word; backslashes survive (shlex would eat them).
_TOKEN = re.compile(r"\"[^\"]*\"|'[^']*'|\S+")


def _program(word: str) -> str:
    name = re.split(r"[\\/]", word.strip("\"'"))[-1].lower()
    return re.sub(r"\.(exe|cmd|bat|ps1)$", "", name)


def bash_signature(command: str) -> str:
    """`cd "D:/x" && python -m pytest -q tests/` -> `Bash(pytest)`: the program, never its arguments."""
    # The first segment that is not a `cd` is the step; a chain's later segments are its plumbing.
    segments = [s.strip() for s in re.split(r"&&|\|\||;|\|", command or "") if s.strip()]
    words = next((_TOKEN.findall(s) for s in segments if not s.startswith(("cd ", "pushd "))), [])
    while words and (_ENV_ASSIGN.match(words[0]) or words[0] in ("sudo", "env", "time")):
        words = words[1:]
    if not words:
        return "Bash"
    prog, rest = _program(words[0]), words[1:]
    if prog in PYTHONS and len(rest) >= 2 and rest[0] == "-m":
        prog, rest = _program(rest[1]), rest[2:]
    if not _WORD.match(prog):
        return "Bash"  # a quoted path or an odd token: keep the step, drop the text
    # `git -C <path> status`, `git -c k=v commit`, `make -C <dir> all`: the subcommand follows the pair.
    while prog in SUBCOMMAND_PROGRAMS and len(rest) >= 2 and rest[0] in ("-C", "-c"):
        rest = rest[2:]
    if prog in SUBCOMMAND_PROGRAMS and rest and _WORD.match(rest[0]):
        return f"Bash({prog} {rest[0]})"
    return f"Bash({prog})"


def tool_signature(block: dict) -> str:
    """A tool_use block as a path- and argument-free signature."""
    name = str(block.get("name") or "?")
    inp = block.get("input") or {}
    if name == "Bash":
        return bash_signature(str(inp.get("command") or ""))
    if name in FILE_TOOLS:
        suffix = Path(str(inp.get("file_path") or inp.get("notebook_path") or "")).suffix.lower()
        return f"{name}(*{suffix})" if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else f"{name}(*)"
    return name


def _result_chars(block: dict) -> int:
    c = block.get("content")
    if isinstance(c, str):
        return len(c)
    return sum(len(x.get("text") or "") for x in (c or []) if isinstance(x, dict))


def session_steps(transcript_path: Path) -> dict:
    """{session_id, date, steps: [(signature, tokens)]} in call order, from one JSONL transcript."""
    uses: list[tuple[str, str, str]] = []  # (signature, message id, tool_use id)
    out_tokens: dict[str, int] = {}
    result_chars: dict[str, int] = {}
    date = None
    with transcript_path.open(encoding="utf-8", errors="replace") as f:
        for raw in f:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(rec, dict):
                continue
            if date is None and rec.get("timestamp") and rec.get("type") in ("user", "assistant"):
                date = str(rec["timestamp"])[:10]
            msg = rec.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            if rec.get("type") == "assistant":
                # Claude Code writes one record per content block, each repeating the message's usage.
                mid = str(msg.get("id") or rec.get("uuid") or len(uses))
                usage = msg.get("usage") or {}
                out_tokens[mid] = max(out_tokens.get(mid, 0), int(usage.get("output_tokens") or 0))
                uses += [(tool_signature(b), mid, str(b.get("id") or "")) for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
            elif rec.get("type") == "user":
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        result_chars[str(b.get("tool_use_id") or "")] = _result_chars(b)
    per_message: dict[str, int] = {}
    for _, mid, _ in uses:
        per_message[mid] = per_message.get(mid, 0) + 1
    steps = [(sig, out_tokens.get(mid, 0) // per_message[mid] + result_chars.get(tid, 0) // 4) for sig, mid, tid in uses]
    return {"session_id": transcript_path.stem, "date": date or "unknown", "steps": steps}


def _contains(longer: tuple, shorter: tuple) -> bool:
    n = len(shorter)
    return any(longer[i:i + n] == shorter for i in range(len(longer) - n + 1))


def _same_procedure(a: tuple, b: tuple) -> bool:
    """One run inside the other, or a rotation of the same loop: (Read,Bash,Edit) and (Bash,Edit,Read)."""
    # Doubling a run makes every rotation and every lap of its loop a plain contiguous slice.
    return _contains(a + a, b) or _contains(b + b, a)


def mine(sessions: list[dict], min_len: int = 3, max_len: int = 6, min_sessions: int = 3,
         min_tokens: int = 15_000, top: int = 5) -> list[dict]:
    """Rank the step n-grams that recur across sessions by what re-deriving them cost; top `top` survive."""
    stats: dict[tuple, dict] = {}
    for s in sessions:
        sigs = [sig for sig, _ in s["steps"]]
        costs = [tok for _, tok in s["steps"]]
        for n in range(min_len, max_len + 1):
            for i in range(len(sigs) - n + 1):
                gram = tuple(sigs[i:i + n])
                if len(set(gram)) < 2:
                    continue  # the same call n times is a loop, not a procedure
                st = stats.setdefault(gram, {"sessions": {}, "runs": 0, "tokens": 0})
                st["sessions"][s["session_id"]] = s["date"]
                st["runs"] += 1
                st["tokens"] += sum(costs[i:i + n])
    ranked = sorted((g for g, st in stats.items() if len(st["sessions"]) >= min_sessions and st["tokens"] >= min_tokens),
                    key=lambda g: (-stats[g]["tokens"], -len(g), g))
    kept: list[tuple] = []
    for g in ranked:
        # A sub-, super-sequence or rotation of a kept procedure is the same procedure counted twice.
        if any(_same_procedure(k, g) for k in kept):
            continue
        kept.append(g)
        if len(kept) >= top:
            break
    out = []
    for g in kept:
        st = stats[g]
        out.append({"steps": list(g), "sessions": len(st["sessions"]), "runs": st["runs"], "rederive_tokens": st["tokens"],
                    "tokens_per_run": st["tokens"] // st["runs"], "session_ids": sorted(st["sessions"]),
                    "last_seen": max((d for d in st["sessions"].values() if d != "unknown"), default="unknown")})
    return out


def _candidate_doc(name: str, c: dict) -> str:
    chain = " -> ".join(c["steps"])
    return "\n".join([
        "---",
        f"name: {name}",
        f"description: Repeated tool procedure ({len(c['steps'])} steps, {c['sessions']} sessions): {chain}",
        "metadata:",
        "  type: procedure",
        "  trust: unreviewed",
        "  confidence: 0.30",
        f"  source: hswarm procedures miner, {c['sessions']} sessions (last seen {c['last_seen']})",
        "---",
        "",
        "Steps:",
        *[f"{i}. `{s}`" for i, s in enumerate(c["steps"], 1)],
        "",
        f"Seen {c['runs']} times across {c['sessions']} sessions. Re-deriving it cost {c['rederive_tokens']:,} tokens in total "
        f"({c['tokens_per_run']:,} per run): output tokens spent issuing the steps plus tool-result tokens read back (chars/4). "
        "That is a measured cost, not a claimed saving. Candidate: bank it as a Script Vault script or a skill if the steps "
        "are the same job each time.",
        "",
        f"**Evidence:** sessions {', '.join(sid[:12] for sid in c['session_ids'][:8])}",
        "",
    ])


def default_out_dir() -> Path:
    shared = triage.MEMORY_REPO / "staging"
    return shared if shared.parent.exists() else (config.HOME / "distill")


def write_candidates(out_dir: Path, candidates: list[dict]) -> list[Path]:
    """Stage each candidate as its own file in claude-memory's staging/: write-once, secret shapes refused."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for c in candidates:
        name = "procedure-" + _slug("-".join(c["steps"]))[:70]
        doc = _candidate_doc(name, c)
        if redact(doc)[1]:
            continue
        # Named by the step chain alone: last_seen moves on as sessions repeat the procedure, and triage
        # moves a staged file into a verdict subfolder, so either would let a later --apply stage it again.
        p = out_dir / f"{name}.md"
        if any(q.exists() for q in [p, *(out_dir / sub / p.name for sub in TRIAGE_SUBDIRS)]):
            continue  # write-once: a human may have edited or triaged the earlier copy
        p.write_text(doc, encoding="utf-8")
        written.append(p)
    return written


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="hswarm procedures", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path.home() / ".claude" / "projects"))
    ap.add_argument("--project", help="substring filter on the project slug dir")
    ap.add_argument("--exclude", action="append", default=[], help="skip project slug dirs containing this substring (repeatable)")
    ap.add_argument("--since", type=float, default=30.0, help="days")
    ap.add_argument("--limit", type=int, default=500, help="newest N transcripts")
    ap.add_argument("--file", action="append", help="explicit transcript path(s); overrides --root scanning")
    ap.add_argument("--min-len", dest="min_len", type=int, default=3)
    ap.add_argument("--max-len", dest="max_len", type=int, default=6)
    ap.add_argument("--min-sessions", dest="min_sessions", type=int, default=3)
    ap.add_argument("--min-tokens", dest="min_tokens", type=int, default=15_000)
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--out", default=str(default_out_dir()))
    ap.add_argument("--apply", action="store_true", help="write the candidates into --out (default: print only)")
    a = ap.parse_args(argv)
    paths = [Path(f) for f in a.file] if a.file else find_transcripts(Path(a.root), a.since, a.project, a.exclude)[: a.limit]
    sessions = [session_steps(p) for p in paths]
    cands = mine(sessions, a.min_len, a.max_len, a.min_sessions, a.min_tokens, a.top)
    report = {"sessions": len(sessions), "tool_calls": sum(len(s["steps"]) for s in sessions), "candidates": cands,
              "apply": a.apply, "out_dir": str(a.out), "written": []}
    if a.apply:
        report["written"] = [str(p) for p in write_candidates(Path(a.out), cands)]
    print(json.dumps(report, indent=1))
    return 0
