"""archivewatchlib - did a move archive a chat it was never asked to touch?

THE INCIDENT (2026-09-16, operation 98008cf6). A four-chat move_chats batch off a running
account landed and settled every chat it was given, and in the same two minutes three chats
that were NOT in it went `isArchived` - one of them in an account the move never named. Every
rail on the move verified the INTENDED rows, so the report, the exit code and the journal all
read clean, and the owner found out by noticing chats missing from his sidebar.

The logs could not name the writer (2026-09-17 investigation): the daemon's archive paths do
not log, the actuator's menu search is already scoped to the target app's own process, the
doctrine lane stamped two other chats that minute, and the #55 archive fell inside the batch's
IMPORT phase, not its settle. So a move now PROVES it instead of assuming it: every chat record
in every profile is read before the first chat moves and again after the last phase, and any
record that went from visible to archived without belonging to the move is COLLATERAL - named
in the move's report, filed as an incident, and it makes the move not-ok.

It detects whatever the cause - the actuator, the importer, the app itself, or another lane or
agent acting in the same minutes - which is why the report says "while it ran", never "by".
"""

from __future__ import annotations

from pathlib import Path

from lib import hydralib, stamplib


def record_ids(path: Path, meta: dict) -> set[str]:
    """Every id one chat record answers to: its cli session id, the ids it rolled through, and
    the id its filename carries (an imported chat is filed as local_<cliSessionId>)."""
    ids = {str(meta.get("cliSessionId") or "")}
    ids |= {str(x) for x in (meta.get("priorCliSessionIds") or []) if x}
    stem = Path(path).stem
    if stem.startswith("local_"):
        ids.add(stem[len("local_"):])
    ids.discard("")
    return ids


def snapshot(fleet_data: dict | None = None) -> dict[str, dict] | None:
    """path -> {archived, ids, title, instance, sessionId} for every chat record on this
    machine. None when the fleet cannot be read: no snapshot means no claim either way, never
    "nothing changed"."""
    if fleet_data is None:
        try:
            fleet_data = hydralib.fleet()
        except hydralib.DaemonError:
            return None
    out: dict[str, dict] = {}
    for store in stamplib.store_roots(fleet_data):
        for path, meta in stamplib.iter_metas(store["root"]):
            out[str(path)] = {
                "archived": meta.get("isArchived") is True,
                "ids": record_ids(path, meta),
                "sessionId": str(meta.get("cliSessionId") or Path(path).stem.replace("local_", "")),
                "title": meta.get("title"),
                "instance": store["instance"],
            }
    return out


def collateral(before: dict | None, after: dict | None, moved_ids: set[str]) -> list[dict]:
    """Records that were VISIBLE before, are ARCHIVED after, and share no id with the move.
    A record that did not exist before (a landing) or already was archived is never counted,
    and neither is any copy of a chat the move was given - archiving the move's own source rows
    and twins is the move doing its job."""
    if before is None or after is None:
        return []
    out = []
    for path, now in after.items():
        was = before.get(path)
        if was is None or was["archived"] or not now["archived"]:
            continue
        if (now["ids"] | was["ids"]) & moved_ids:
            continue
        out.append({"instance": now["instance"], "title": now["title"],
                    "sessionId": now["sessionId"], "path": path})
    return sorted(out, key=lambda r: (str(r["instance"]), str(r["title"])))


def ids_for_match(match: dict | None, session_id: str | None = None) -> set[str]:
    """The ids a move is ALLOWED to archive for one chat: its session id plus every id its
    desktop record answers to (the dossier match's lineage)."""
    ids = {str(session_id or "")}
    m = match or {}
    ids.add(str(m.get("cliSessionId") or ""))
    ids |= {str(x) for x in (m.get("lineageIds") or []) if x}
    ids |= {str(x) for x in (m.get("priorCliSessionIds") or []) if x}
    chat_id = str(m.get("chatId") or "")
    if chat_id.startswith("local_"):
        ids.add(chat_id[len("local_"):])
    ids.discard("")
    return ids


def report_lines(rows: list[dict], incident: str | None = None) -> list[str]:
    """The report block. Loud on purpose: this is the one outcome a clean-looking move hid."""
    if not rows:
        return []
    lines = [f"⛔ COLLATERAL: {len(rows)} chat(s) that were NOT part of this move were archived "
             "while it ran:"]
    for r in rows:
        lines.append(f"    - '{r['title']}' in {r['instance']} ({str(r['sessionId'])[:8]})")
    lines.append("  Unarchive each from its own account's app (Archived view -> Unarchive); a "
                 "disk write is undone by a running app. The move's own chats are unaffected."
                 + (f" Incident {incident}." if incident else ""))
    return lines


def file_incident(rows: list[dict], what: str) -> str | None:
    """One incident per move that caused collateral, keyed by the move, never swallowed."""
    if not rows:
        return None
    try:
        from lib import incidentlib

        names = ", ".join(f"'{r['title']}' ({r['instance']})" for r in rows)
        return incidentlib.record(
            "move-collateral", what,
            f"{len(rows)} chat(s) outside the move were archived while it ran: {names}",
            meta={"chats": rows})
    except Exception:  # an incident store that cannot be written must not hide the report
        return None
