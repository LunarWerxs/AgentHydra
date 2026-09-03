#!/usr/bin/env python3
"""trust_workspace.py - ACT (machine config): pre-trust a workspace so a chat can start in it.

THE WALL THIS REMOVES (owner, 2026-09-01: "you don't seem to understand how to trust
workspaces when starting a chat on one that's not trusted"): the desktop app refuses to run
a chat in a folder it has never been told to trust, and the trust dialog is a HUMAN click
nothing programmatic can answer. So a landing or a spawned chat in an untrusted folder
stalls on a modal - invisible to every rail we have.

HIS OWN SOLUTION, and it is the right one: the trust list is a FILE, so write to it ahead of
time. `~/.claude.json` carries `projects["<path>"].hasTrustDialogAccepted`, and that file is
SHARED by every desktop instance (they all use the one CLI home), so a single write covers
the whole fleet. Measured on this machine 2026-09-01: 145 projects known, 84 of them not
trusted - every one a stall waiting to happen.

⛔ SCOPE IS A DELIBERATE DECISION, NEVER A BLANKET SWEEP. Trust is a security boundary: it
says "run code from this folder unattended". This script trusts a folder ONLY when a caller
names it, or - with --known - when the folder is ALREADY a workspace of this fleet's own
chats (a cwd the daemon reports for a real session). It never trusts a path nobody is
working in, and `--dry-run` (the default) shows exactly what would change.

Usage: python trust_workspace.py <path> [--yes]        # trust one folder
       python trust_workspace.py --known [--yes]       # trust every folder our chats use
       python trust_workspace.py --status [--json]     # what is trusted, what is not
Exit:  0 nothing to do / applied cleanly - 2 some writes failed - 3 bad usage.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from lib import clilib, hydralib

CONFIG = Path(os.environ.get("CLAUDE_CONFIG_PATH") or (Path.home() / ".claude.json"))


def _norm(p: str) -> str:
    """The app keys projects by the path as it first saw it - casing and slash style both
    vary in the live file. Compare on a normalized form so one folder is never 'trusted'
    under one spelling and untrusted under another."""
    return str(p).replace("\\", "/").rstrip("/").lower()


def load() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def save(cfg: dict) -> None:
    """Atomic, with a one-generation backup. This file holds every project's MCP wiring and
    history - a truncated write would be a bad day, so never write it in place.

    ORDER MATTERS (bug found on review, 2026-09-01): the first cut wrote the new content to a
    tmp file, then RENAMED the live CONFIG out of the way to the backup path, then renamed tmp
    into place - two renames, not one. A crash between them leaves CONFIG missing entirely,
    and CONFIG is `~/.claude.json`, shared by every instance on the machine. Copying the
    backup (leaves the original in place on any OSError) before the single os.replace() means
    CONFIG exists at every step: before, mid-copy, and after the one rename that ever touches it.
    """
    tmp = CONFIG.with_name(f"{CONFIG.name}.trust.tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        shutil.copy2(CONFIG, CONFIG.with_name(f"{CONFIG.name}.bak-trust"))
    except OSError:
        pass
    os.replace(tmp, CONFIG)


def trusted_state(cfg: dict) -> dict[str, bool]:
    return {k: (v or {}).get("hasTrustDialogAccepted") is True
            for k, v in (cfg.get("projects") or {}).items()}


def workspaces_in_use() -> set[str]:
    """Every folder this fleet's own chats actually work in (the daemon's session rows)."""
    out = set()
    for row in hydralib.sessions():
        cwd = row.get("cwd")
        if cwd:
            out.add(str(cwd))
    return out


def apply_trust(paths: list[str], act: bool) -> dict:
    cfg = load()
    projects = cfg.setdefault("projects", {})
    by_norm = {_norm(k): k for k in projects}
    changed, already = [], []
    seen: set[str] = set()
    for p in paths:
        # ONE FOLDER, ONE ENTRY: the daemon reports cwds in whatever slash style and casing
        # each session recorded, so the same folder arrives twice ('D:/x' and 'D:\x') and a
        # naive loop would write TWO project keys for it - a second, silently untrusted
        # spelling of a folder we just trusted (caught by the first dry run, 2026-09-01).
        n = _norm(p)
        if n in seen:
            continue
        seen.add(n)
        # THE KEY FORM IS PART OF THE FIX (measured live 2026-09-01): the app stores project
        # keys with FORWARD slashes, and it looks a folder up by that spelling. A key written
        # with backslashes is invisible to it - the trust flag sits in the file, says true,
        # and the app still shows the dialog. Match an existing key when there is one;
        # otherwise CREATE the key in the app's own canonical form.
        key = by_norm.get(n, str(p).replace("\\", "/").rstrip("/"))
        entry = projects.get(key)
        if entry is not None and entry.get("hasTrustDialogAccepted") is True:
            already.append(key)
            continue
        if act:
            # A folder the app has never seen gets a minimal entry - the app fills the rest
            # on first use; the only field that matters here is the trust flag itself.
            projects.setdefault(key, {})["hasTrustDialogAccepted"] = True
        changed.append(key)
    if act and changed:
        save(cfg)
    return {"trusted": changed, "alreadyTrusted": already, "applied": bool(act and changed)}


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv

    if not CONFIG.exists():
        print(f"no config at {CONFIG} - nothing to trust against", file=sys.stderr)
        return 3

    if "--status" in argv:
        state = trusted_state(load())
        untrusted = sorted(k for k, v in state.items() if not v)
        if as_json:
            print(json.dumps({"total": len(state), "untrusted": untrusted}, indent=2))
        else:
            print(f"{len(state)} project(s) known, {len(untrusted)} NOT trusted "
                  "(a chat starting in one of those stalls on a human dialog):")
            for p in untrusted[:40]:
                print(f"  - {p}")
            if len(untrusted) > 40:
                print(f"  ... and {len(untrusted) - 40} more")
        return 0

    if "--known" in argv:
        try:
            paths = sorted(workspaces_in_use())
        except hydralib.DaemonError as err:
            print(f"cannot read the fleet's workspaces ({err})", file=sys.stderr)
            return 2
    else:
        args = [a for a in argv if not a.startswith("--")]
        if len(args) != 1:
            print(__doc__.strip(), file=sys.stderr)
            return 3
        paths = [args[0]]

    result = apply_trust(paths, act)
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        verb = "TRUSTED" if act else "would trust"
        for p in result["trusted"]:
            print(f"  {verb}: {p}")
        if result["alreadyTrusted"]:
            print(f"  ({len(result['alreadyTrusted'])} already trusted)")
        if not result["trusted"]:
            print("nothing to do - every named workspace is already trusted.")
        elif not act:
            print("\nDRY RUN - nothing written. Re-run with --yes to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
