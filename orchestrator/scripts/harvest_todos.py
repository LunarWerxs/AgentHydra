#!/usr/bin/env python3
"""harvest_todos.py - ACT: rescue the work left inside ARCHIVED chats into to-do markdown.

THE ASK (owner, 2026-09-01: "for the archived ones with work left - either restore the chats
or move the pending items to a ToDo md file"). Restoring 769 chats would flood the fleet and
every account's quota; the work inside them is what actually matters, and it is only ever a
few lines per chat. So: read each below-the-bar archived chat's own closing words, take the
items it left open, and file them where the fleet already looks for work - each codebase's
`docs/todo/`, the convention odin's sweep already consolidates.

WHAT COUNTS AS A PENDING ITEM, taken from the chat's own recap and nothing invented:
  - every bullet under "Do I recommend anything else?" that is not a "nothing"
  - the "Am I 100% done?" line when it does not claim done (that line says what is left)
  - for a chat that crashed or was interrupted, a single line saying so, because the work is
    wherever it stopped and only a person can judge whether to resume it

WHICH CODEBASE, derived not guessed: a chat's transcript lives under a project folder whose
name is its working directory with the separators flattened (`D--PublicProjects-orchestrator`).
Every real directory under the known roots is encoded the same way and matched back, so a chat
lands in its own repo or in nobody's - never in a wrong one. Unresolved chats go to one
fallback file rather than being dropped.

⛔ IT ONLY EVER ADDS A FILE. One `docs/todo/from-archived-chats.md` per codebase, rewritten
whole on each run so it never grows duplicates, and it stages nothing and commits nothing -
these trees have other sessions working in them.

Usage: python harvest_todos.py [--json] [--limit N]     # what it WOULD write
       python harvest_todos.py --yes                    # write the files
Exit:  0 wrote (or nothing to write) - 1 fleet read failed, or a write failed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import audit_done_bar
from lib import armlib, clilib
from lib import gatelib
from lib import hydralib
from lib import stamplib

# Where codebases live on this machine. A chat outside these is still harvested - it just
# lands in the fallback file instead of a repo.
ROOTS = [Path(r"D:\PublicProjects"), Path(r"D:\NEWProjects"), Path(r"H:\LargeProjects")]
FALLBACK = Path(__file__).resolve().parents[1] / "docs" / "todo"
TODO_NAME = "from-archived-chats.md"


def _encode(path: Path) -> str:
    """The app's own project-folder encoding: separators and dots flattened to '-'."""
    return str(path).replace(":", "-").replace("\\", "-").replace("/", "-").replace(".", "-")


def _repo_index() -> dict[str, Path]:
    """encoded-name (lowercased) -> real directory, three levels under the roots.

    THREE DETAILS, each of which cost a batch of unresolved chats when it was missing
    (measured 2026-09-01, 640 of 681 unresolved on the first cut):
      - the folder names are CASE-INSENSITIVE against the real path ('d--NEWProjects…' for
        'D:\\NEWProjects…', 'agenthydra' for 'AgentHydra') - 312 chats hung on that one;
      - the ROOTS THEMSELVES are working directories, not just their children;
      - real trees go three deep (D:\\NEWProjects\\active\\RustTor\\rLibtorrent).
    """
    out: dict[str, Path] = {}

    def add(p: Path):
        out.setdefault(_encode(p).lower(), p)

    def walk(d: Path, depth: int):
        if depth <= 0:
            return
        try:
            for child in d.iterdir():
                if child.is_dir() and not child.name.startswith("."):
                    add(child)
                    walk(child, depth - 1)
        except OSError:
            return

    for root in ROOTS:
        if not root.exists():
            continue
        add(root)
        walk(root, 3)
    return out


def _items_from(verdict: dict) -> list[str]:
    """The chat's own open items - never anything invented."""
    fin = verdict.get("finished") or {}
    if verdict["state"] == "crashed":
        kind = (verdict.get("crashed") or {}).get("kind")
        return [f"Stopped mid-work ({kind}); whatever it was doing is unfinished - "
                "read the chat before restarting it."]
    if fin.get("interrupted"):
        return ["A person interrupted this one deliberately - it is theirs to pick back up."]
    items = list(fin.get("open_recommendations") or [])
    text = gatelib.recap_view(fin.get("last_assistant_text") or "")
    # One definition of the done-claim line, shared with the gate (gatelib.done_claim_section).
    line = gatelib.done_claim_section(text)
    if line and fin.get("done_claim") != "yes":
        items.insert(0, f"Not finished: {line}")
    return items


def build() -> dict:
    rep = audit_done_bar.scan()
    fleet = hydralib.fleet()
    tpath = stamplib.transcript_index(fleet)
    repos = _repo_index()

    by_repo: dict[str, dict] = {}
    skipped = 0
    for row in rep["real"]:
        p = tpath.get(row["sessionId"])
        if not p:
            skipped += 1
            continue
        verdict = gatelib.gate(row["sessionId"], str(p), None)
        if not verdict:
            skipped += 1
            continue
        items = _items_from(verdict)
        if not items:
            skipped += 1
            continue
        repo = repos.get(p.parent.name.lower())
        key = str(repo) if repo else "(unresolved)"
        bucket = by_repo.setdefault(key, {"repo": str(repo) if repo else None, "chats": []})
        bucket["chats"].append({"title": row["title"], "sessionId": row["sessionId"],
                                "ageDays": row["ageDays"], "why": row["why"], "items": items})
    return {"repos": by_repo, "skipped": skipped,
            "chats": sum(len(b["chats"]) for b in by_repo.values())}


def _render(key: str, bucket: dict) -> str:
    where = bucket["repo"] or "chats whose codebase could not be resolved"
    lines = [
        "# Work left inside archived chats",
        "",
        f"Harvested by the orchestrator's `harvest_todos.py` from chats that were ARCHIVED",
        f"while their own closing words still listed open work. Scope: {where}.",
        "",
        "Each entry is the chat's OWN wording, not a summary. The session id is there so the",
        "chat itself can be brought back (`python scripts/audit_archived.py --restore`) if the",
        "notes are not enough. Delete an item when it is done - odin's sweep reads a deleted",
        "to-do as finished and never re-files it.",
        "",
    ]
    for chat in sorted(bucket["chats"], key=lambda c: c["ageDays"]):
        lines.append(f"## {chat['title']}")
        lines.append("")
        lines.append(f"_archived {chat['ageDays']:.0f} days ago - {chat['why']} - "
                     f"session `{chat['sessionId']}`_")
        lines.append("")
        for item in chat["items"]:
            lines.append(f"- [ ] {item}")
        lines.append("")
    return "\n".join(lines)


def write(plan: dict) -> list[dict]:
    out = []
    roots = {str(r).lower() for r in ROOTS}
    for key, bucket in plan["repos"].items():
        repo = Path(bucket["repo"]) if bucket["repo"] else None
        # A CONTAINER IS NOT A CODEBASE. A chat whose working directory was D:\PublicProjects
        # itself belongs to no repo in particular, and dropping a docs/todo/ into the root of a
        # projects folder would be litter. Those go to the orchestrator's own to-do folder,
        # named for the root they came from.
        if repo is not None and str(repo).lower() in roots:
            target, name = FALLBACK, f"from-archived-chats-{repo.name}.md"
        elif repo is not None:
            # A repo may forbid loose files at its docs/todo/ ROOT (Connections: owner directive,
            # Michael, 2026-07-30, gated there by `todo-root-loose-file-gate` - every to-do belongs
            # to an owner folder or a standing intake folder). Machine-filed intake there lives in
            # `docs/todo/loki/` beside the other harvester-written files, so write into that folder
            # when the repo has one; a repo without it keeps the plain docs/todo/ convention.
            todo = repo / "docs" / "todo"
            target, name = (todo / "loki" if (todo / "loki").is_dir() else todo), TODO_NAME
        else:
            target, name = FALLBACK, TODO_NAME
        try:
            target.mkdir(parents=True, exist_ok=True)
            path = target / name
            # ⛔ NEVER OVERWRITE AN EXISTING ONE. A ticked-off or deleted to-do means DONE and
            # must never be re-filed (odin's rule, and the reason its sweep is trusted). This
            # file is generated from chats that are already archived and will never change
            # their minds, so a second run would only resurrect items a person had cleared.
            if path.exists():
                out.append({"path": str(path), "chats": len(bucket["chats"]), "ok": True,
                            "why": "already exists - left alone so cleared items stay cleared"})
                continue
            path.write_text(_render(key, bucket), encoding="utf-8")
            out.append({"path": str(path), "chats": len(bucket["chats"]), "ok": True})
        except OSError as err:
            out.append({"path": str(target / name), "chats": len(bucket["chats"]),
                        "ok": False, "why": str(err)[:120]})
    return out


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else 30
    try:
        plan = build()
    except hydralib.DaemonError as err:
        print(f"harvest FAILED: {err}", file=sys.stderr)
        return 1
    do_write = "--yes" in argv
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so.
    if do_write:
        refusal = armlib.refuse_unless_armed(argv, "writing to-do files into repos")
        if refusal:
            print(refusal)
            do_write = False
    results = write(plan) if do_write else []
    failed = any(not r["ok"] for r in results)
    if "--json" in argv:
        print(json.dumps({**plan, "results": results}, indent=2)[:200000])
        return 1 if failed else 0
    print(f"{plan['chats']} archived chat(s) with open work, across "
          f"{len(plan['repos'])} codebase(s) ({plan['skipped']} had nothing extractable)")
    for key, bucket in sorted(plan["repos"].items(),
                              key=lambda kv: -len(kv[1]["chats"]))[:limit]:
        name = Path(key).name if bucket["repo"] else key
        items = sum(len(c["items"]) for c in bucket["chats"])
        print(f"  {len(bucket['chats']):4d} chat(s), {items:4d} item(s)  {name}")
    for r in results:
        note = f" - {r['why']}" if r.get("why") else ""
        print(f"  {'OK ' if r['ok'] else 'XX '}{r['path']}  ({r['chats']} chat(s)){note}")
    if not results:
        print("\nPLAN ONLY - nothing written. Add --yes to write the to-do files.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
