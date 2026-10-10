"""`migrate_chat.py --revive`: rebuild a transcript the CLI deleted, or one `--resume` refuses (see the block below).
main() in migrate_chat hands the flags here; `out` is migrate_chat's own printer, passed in so this module never
imports migrate_chat back."""

import re
import time
from pathlib import Path as _Path

from lib import hydralib, ledgerlib


# --- REVIVE: rebuild a transcript the CLI deleted, or one --resume refuses -------------------
#
# WHY: Claude Code deletes transcripts past cleanupPeriodDays, after which `--resume` fails, and
# a chat copied between accounts can carry signed thinking blocks or a dangling tool call that
# make its next turn a 400. A copy often survives (delete_chat's undo copy, another account's
# store the chat moved out of, a file saved by hand). This writes it back under the SAME
# session id, keeping only what a replayed request accepts (lib/revivelib). No daemon call,
# no app touched: the file is the whole job, and the chat is then resumed or imported as usual.

_SESSION_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# An existing transcript written to this recently may have a live CLI appending to it; a rewrite
# would race that writer, so it is refused (exit 4) whatever --force says. Same 300s the move's
# own quiet window uses.
REVIVE_QUIET_SECS = 300


def _revive_stores(into: _Path) -> list[_Path]:
    """Every projects folder a copy of the chat may sit in: the destination, the regular CLI
    store, then each instance's (best-effort - with no daemon, the first two still count)."""
    stores = [into, _Path.home() / ".claude" / "projects"]
    try:
        fleet_data = hydralib.fleet()
    except hydralib.DaemonError:
        fleet_data = {}
    for i in fleet_data.get("instances", []) or []:
        if i.get("dir"):
            stores.append(_Path(str(i["dir"])) / "projects")
    seen, out_stores = set(), []
    for s in stores:
        key = str(s).lower()
        if key not in seen:
            seen.add(key)
            out_stores.append(s)
    return out_stores


def revive(argv: list[str], out) -> int:
    """`--revive <sessionId> [--source FILE] [--into DIR] [--force] [--dry-run] [--json]`.
    Exit 0 revived (or planned), 3 deterministic refusal, 4 the existing file is being written."""
    from lib import revivelib

    as_json = "--json" in argv

    def flag(name: str) -> str | None:
        if name in argv:
            i = argv.index(name)
            return argv[i + 1] if i + 1 < len(argv) else ""
        return None

    def refuse(code: int, why: str, **extra) -> int:
        return out({"ok": False, "code": code, "why": why, **extra,
                    "report": f"REVIVE REFUSED: {why}"}, as_json, code)

    session_id = (flag("--revive") or "").strip()
    if not _SESSION_ID_RE.match(session_id):
        return refuse(3, f"--revive needs a session id (a UUID), got {session_id!r}")
    into = _Path(flag("--into") or (_Path.home() / ".claude" / "projects"))
    force, dry_run = "--force" in argv, "--dry-run" in argv

    existing = next(iter(sorted(into.glob(f"*/{session_id}.jsonl"))), None) if into.exists() else None
    source_arg = flag("--source")
    if source_arg:
        source = _Path(source_arg)
        if not source.is_file():
            return refuse(3, f"--source {source} is not a file")
    else:
        found = revivelib.candidate_sources(session_id, _revive_stores(into),
                                            ledgerlib._state_dir() / "trash")
        if not found:
            return refuse(3, f"no copy of {session_id} found in any projects store or delete_chat's "
                             f"undo copies; pass --source <file.jsonl>")
        source = found[0]

    if existing is not None:
        if not force:
            return refuse(3, f"{existing} already exists; --force rewrites it in place (the "
                             f"original is kept beside it as .pre-revive-<time>)", existing=str(existing))
        quiet = time.time() - existing.stat().st_mtime
        if quiet < REVIVE_QUIET_SECS:
            return refuse(4, f"{existing} was written {int(quiet)}s ago - a live CLI may still be "
                             f"appending; wait until it has been quiet {REVIVE_QUIET_SECS}s",
                          existing=str(existing))

    try:
        records = revivelib.parse_jsonl(source.read_text(encoding="utf-8", errors="replace"))
    except OSError as exc:
        return refuse(3, f"cannot read {source}: {exc}")
    kept, stats = revivelib.rebuild_records(records, session_id)
    if not kept:
        return refuse(3, f"{source} holds nothing replayable (no user or assistant turn on its "
                         f"active branch)", stats=stats)

    if existing is not None:
        dest = existing
    elif source.name == f"{session_id}.jsonl":
        dest = into / source.parent.name / source.name
    else:
        cwd = revivelib.first_cwd(kept)
        if not cwd:
            return refuse(3, f"{source} names no working directory (no record carries a cwd), "
                             f"so the project folder --resume looks in is unknown")
        dest = into / revivelib.project_folder(cwd) / f"{session_id}.jsonl"

    dropped = (f"dropped {stats['thinking']} thinking block(s), {stats['unansweredToolUse']} "
               f"unanswered tool call(s), {stats['orphanToolResult']} orphan result(s), "
               f"{stats['nonConversation']} non-conversation record(s)")
    payload = {"ok": True, "code": 0, "sessionId": session_id, "source": str(source),
               "dest": str(dest), "inPlace": existing is not None, "dryRun": dry_run, **stats}
    if dry_run:
        payload["report"] = (f"DRY RUN: would write {stats['kept']} record(s) of {session_id[:8]} "
                             f"from {source} to {dest}; {dropped}.")
        return out(payload, as_json, 0)

    text = revivelib.render_jsonl(kept)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if existing is not None:
            backup = dest.with_name(f"{dest.name}.pre-revive-{int(time.time())}")
            backup.write_bytes(dest.read_bytes())
            payload["backup"] = str(backup)
        tmp = dest.with_name(dest.name + ".revive-tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(dest)
    except OSError as exc:
        return refuse(3, f"could not write {dest}: {exc}")
    payload["report"] = (f"revived {session_id[:8]}: {stats['kept']} record(s) written to {dest}; "
                         f"{dropped}. Resume it with `claude --resume {session_id}` from its folder, "
                         f"or land it in a desktop app with migrate_chat.")
    return out(payload, as_json, 0)
