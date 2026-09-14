#!/usr/bin/env python3
"""migrate_reconcile.py - OBSERVE (+`--finish` / `--reverse`): which moves stopped half-way?

THE HOLE THIS FILLS (the archive sweep, 2026-09-13). A move is four acts: import the chat onto
the target, verify the landing, settle the source row so the old account stops showing it, and
stamp the permission mode. `migrate_chat.move_only` records the mutation the moment the landing
verifies - correctly, because the chat HAS moved by then - and the later phases used to leave no
trace at all. So when a 25-chat batch was killed mid-flight, 14 archived chats sat IMPORTED onto
the target and STILL unarchived on the source: duplicates, not moves. Nothing on the machine
said which, and the fleet read taken right after the kill still showed every chat on the source,
so the run was reported as "nothing landed" in good faith and the truth surfaced 20 minutes
later, by eye. The 14 were re-archived by hand.

Two halves close it. `mutationlib.advance_phase` gives every migrate row a PHASE (imported ->
settle-<verdict> -> stamped), written by the phases themselves. This script reads those rows and
re-checks each one against the CHAT'S CURRENT STATE, because a journal is a claim and the dossier
is the fact:

  unsettled     the chat is on the target AND still unarchived on the source - a half-move, the
                exact state the kill left. This is what --finish repairs.
  not-landed    the mutation says it moved, the target does not hold it, and the chat is LIVE
                ON SEVERAL other accounts at once. The loudest row here: a verified move whose
                chat now exists twice somewhere else.
  moved-on      not on the target, but whole: exactly one live copy, elsewhere. A later move was
                not written down. Listed, never counted as owed.
  archived-since  not on the target, and every copy is archived: at rest. Listed, never owed.
  target-gone   the account it moved to no longer exists. Listed, never counted as owed.

  The quiet verdicts were earned on this script's first live run (2026-09-14): judging every
  ledger row as it stood, it raised 63 alarms, and every one was the ledger being stale - a chat
  moved again, archived later, or moved into an account since deleted - rather than a move gone
  wrong. A report that cries wolf is a report nobody reads.
  settled       the source row is archived or gone - the move is whole. The journal is advanced
                so a row that was only ever missing its phase stops being re-checked forever.
  gone          the session resolves nowhere any more (deleted, merged): nothing to reconcile.
  unknown       the dossier read failed. Counted WITH the unsettled ones, never as clean - a
                failed read is ignorance, and reconcile.py learned that the same way.

`--finish` re-drives the phases that are still owed through migrate_chat's OWN phase functions
(`phase_settle`, `phase_stamp`) - it invents no actuator, exactly as undo.py invents none. It
drives the source app's archive control, so it is a deliberate act a person asks for by name.
`--reverse <id>` hands the row to undo.py, which migrates it back through the full rails.

Usage: python migrate_reconcile.py [--finish [<mutation-id>]] [--reverse <mutation-id>]
                                   [--limit N] [--force] [--json]
  --finish        with an id, repair that row; bare, repair every unsettled row it found.
  --reverse <id>  undo the move instead (undo.py, which re-runs migrate_chat back to the source).
  --limit N       check at most N migrate rows, newest first (default 200).
Exit:  0 nothing half-moved - 2 half-moves found, or a repair did not land - 3 usage or an
       unknown mutation id (deterministic) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time

from lib import clilib, hydralib, mutationlib

#: How many migrate rows to re-check by default. The ledger is append-only and a fleet's
#: history is long; the half-moves this exists to find are recent by construction, and a row
#: that verifies settled is advanced so it never has to be re-read.
DEFAULT_LIMIT = 200

#: The phase a finished move ends on. Anything else is owed something.
DONE_PHASE = "stamped"

#: Written to an OLDER migrate row once a newer move of the same chat exists. That move is not
#: owed anything: the chat went somewhere else on purpose afterwards, and judging the old row
#: against where the chat is NOW is a false red (see _candidates).
SUPERSEDED_PHASE = "superseded"

#: A row this script has proven whole (VERIFIED_PHASE, below) is finished as far as THIS script
#: is concerned: its job is duplicates and vanished moves, and re-reading every proven row on
#: every run was 125 dossier calls a run on the first live ledger for nothing.
FINISHED_PHASES = (DONE_PHASE, SUPERSEDED_PHASE, "settled-verified")

#: Written back to a row this script has just proven whole. Deliberately NOT "stamped": the
#: mode stamp may still be owed, and claiming it here would be inventing evidence.
VERIFIED_PHASE = "settled-verified"

UNSETTLED_STATES = ("unsettled", "not-landed", "unknown")


def _candidates(limit: int = DEFAULT_LIMIT) -> list[dict]:
    """Migrate rows that could still owe something, newest first - ONE PER CHAT.

    ⛔ ONLY A CHAT'S NEWEST MOVE IS JUDGED (found by this script's first live run, 2026-09-14).
    It checked every migrate row in the ledger, and 63 came back `not-landed` - the loudest
    verdict it has - for chats like Stackspire that had moved #12 -> #8 and then #8 -> #36 on
    purpose. The first row's target no longer holds the chat because the SECOND move took it,
    not because anything failed. A reconciler that cries wolf 63 times gets ignored, which is
    the one way it cannot do its job, so an older row of a chat with a newer move is marked
    superseded once and never read again.

    A row that was undone is not a half-move either (the chat went back on purpose), and a row
    that reached the last phase owes nothing. A row with NO phase field is pre-journal: it is
    included, because "unknown" is the one thing this script exists to resolve.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    superseded: list[str] = []
    for row in mutationlib.list_mutations(kind="migrate"):  # newest first
        sid = str(row.get("session") or "")
        if sid in seen:
            if row.get("phase") not in FINISHED_PHASES:
                superseded.append(str(row.get("id")))
            continue
        seen.add(sid)
        if row.get("undoneAt") or row.get("phase") in FINISHED_PHASES:
            continue
        if not limit or len(rows) < limit:
            rows.append(row)
    for mid in superseded:
        mutationlib.advance_phase(mid, SUPERSEDED_PHASE)
    return rows


def _state_when_not_on_target(matches: list[dict], src: str, tgt: str,
                               fleet_names: set[str] | None) -> dict:
    holders = ", ".join(sorted({str(m.get("instance")) for m in matches}))
    # NOT EVERY MISSING LANDING IS A FAULT (the first live run, 2026-09-14). Two shapes are
    # the ledger being out of date rather than a move going wrong, and shouting them in the
    # same voice as a real vanished move is how a report stops being read:
    if fleet_names is not None and tgt.lower() not in fleet_names:
        return {"state": "target-gone",
                "why": (f"the account it moved to ({tgt!r}) no longer exists; the chat is on: "
                        f"{holders}")}
    live = [m for m in matches if not m.get("archived")]
    if len(live) == 1:
        return {"state": "moved-on",
                "why": (f"not on {tgt}, but whole: exactly one live copy, on "
                        f"{live[0].get('instance')}. A later move was not written down.")}
    if not live:
        # Archived is a resting state: the chat exists, nothing live can be lost or doubled.
        return {"state": "archived-since",
                "why": f"not on {tgt}; it has since been archived, on: {holders}"}
    return {"state": "not-landed",
            "why": (f"the ledger says this chat moved to {tgt!r}, but the target does not "
                    f"hold it, and it has {len(live)} live cop{'y' if len(live) == 1 else 'ies'}. "
                    f"It is on: {holders}")}


def _state_when_on_target(on_src: list[dict], src: str, tgt: str) -> dict:
    visible = [m for m in on_src if not m.get("archived")]
    if visible:
        return {"state": "unsettled",
                "why": (f"it is on {tgt} AND still unarchived on {src}: a duplicate, not a move. "
                        "The source-settle phase never ran.")}
    return {"state": "settled",
            "why": ("the source row is archived or gone" if on_src else
                    "the source account no longer holds it")}


def _state_of(row: dict, fleet_names: set[str] | None = None) -> dict:
    """Re-check ONE migrate row against the chat's current state on disk.

    The dossier is used rather than the session index on purpose: it is a fresh per-instance
    scan with no cross-account collapsing, so a chat that exists on two accounts at once -
    which is precisely what a half-move leaves - is seen as two rows rather than resolved to
    one winner (see hydralib.chats and _movable_chats for the other half of that lesson).
    """
    sid = str(row.get("session") or "")
    src = str((row.get("before") or {}).get("instance") or "")
    tgt = str((row.get("after") or {}).get("instance") or "")
    out = {"mutationId": row.get("id"), "sessionId": sid, "title": row.get("title") or "",
           "source": src, "target": tgt, "phase": row.get("phase") or "unknown",
           "at": row.get("at")}
    try:
        matches = hydralib.dossier(sid) if sid else []
    except hydralib.DaemonError as err:
        return {**out, "state": "unknown", "why": f"the dossier read failed: {err}"}
    if not matches:
        return {**out, "state": "gone", "why": "the session resolves nowhere any more"}
    on_src = [m for m in matches if str(m.get("instance") or "").lower() == src.lower()] if src else []
    on_tgt = [m for m in matches if str(m.get("instance") or "").lower() == tgt.lower()] if tgt else []
    if not on_tgt:
        return {**out, **_state_when_not_on_target(matches, src, tgt, fleet_names)}
    return {**out, **_state_when_on_target(on_src, src, tgt)}


def reconcile(limit: int = DEFAULT_LIMIT) -> dict:
    """Every migrate row that could owe something, re-checked. Observes only."""
    candidates = _candidates(limit)
    try:
        fleet_names = {str(i.get("name") or "").lower() for i in hydralib.fleet().get("instances", [])}
    except hydralib.DaemonError:
        fleet_names = None  # cannot tell a deleted account from a live one: never say "target-gone"
    rows = [_state_of(row, fleet_names) for row in candidates]
    # SELF-HEAL THE JOURNAL, NEVER THE CHAT. A row proven whole is advanced so the next run
    # does not re-read it; nothing about the chat is touched by an observe.
    for r in rows:
        if r["state"] == "settled" and r["phase"] != VERIFIED_PHASE:
            mutationlib.advance_phase(str(r["mutationId"]), VERIFIED_PHASE)
    return {"generatedAt": int(time.time() * 1000), "checked": len(rows), "rows": rows,
            "unsettled": [r for r in rows if r["state"] in UNSETTLED_STATES]}


def _rebuild_landing(row: dict, fleet: dict):
    """A _Landing for a move that already happened, rebuilt from the ledger plus a FRESH read.

    Phase one's gates are not re-run and must not be: they decided whether this move was
    allowed, and it happened. What IS re-read is the state the phases act on (the source row,
    the landed record), because the ledger is a memory of a moment and these phases drive the
    machine as it is now.
    """
    import migrate_chat

    sid = str(row["sessionId"])
    matches = hydralib.dossier(sid)
    src = str(row["source"])
    target = hydralib.resolve_instance(fleet, str(row["target"]))
    if target is None:
        raise _RepairRefusal(f"the target account {row['target']!r} is not in the fleet any more")
    match = next((m for m in matches if str(m.get("instance") or "").lower() == src.lower()), None)
    if match is None:
        # Nothing to settle: the source no longer holds the chat at all. Hand the phases the
        # landed row instead, so a stamp that is still owed can run on its own.
        match = next((m for m in matches
                      if str(m.get("instance") or "").lower() == str(target.get("name") or "").lower()), {})
    return migrate_chat._Landing(
        parsed=None, sw=migrate_chat._Stopwatch(), notes={}, match=match, fleet=fleet,
        target=target, session_id=sid, chat_title=row.get("title") or sid,
        src_instance=src, result=None, after=matches, mutation_id=row["mutationId"])


class _RepairRefusal(ValueError):
    """This row cannot be repaired from here, and says why. Never a silent skip."""


def finish(rows: list[dict], force: bool = False) -> list[dict]:
    """Re-drive the phases still owed, through migrate_chat's own phase functions."""
    import migrate_chat

    fleet = hydralib.fleet()
    out = []
    for row in rows:
        entry = {"mutationId": row["mutationId"], "sessionId": row["sessionId"],
                 "title": row["title"], "ran": []}
        try:
            land = _rebuild_landing(row, fleet)
        except (_RepairRefusal, hydralib.DaemonError) as err:
            out.append({**entry, "ok": False, "outcome": f"not repaired: {err}"})
            continue
        try:
            if row["state"] == "unsettled":
                migrate_chat.phase_settle(land)
                entry["ran"].append(f"settle -> {land.source_row}")
            if not str(row["phase"]).startswith("stamped"):  # a stamp already run is not re-run
                migrate_chat.phase_stamp(land)
                entry["ran"].append(f"stamp -> {(land.doctrine or {}).get('mode')}")
        except Exception as err:  # an actuator failure is this row's failure, never the run's
            out.append({**entry, "ok": False,
                        "outcome": f"{type(err).__name__} while repairing: {str(err)[:200]}"})
            continue
        settled = land.source_row in (None, "settled", "flagged", "none")
        out.append({**entry, "ok": settled,
                    "outcome": ("repaired" if settled else
                                f"the source row is still visible on {row['source']}")})
    return out


def reverse(mutation_id: str, force: bool = False) -> tuple[int, str]:
    """Undo the move instead of finishing it - through undo.py, which owns that route."""
    import undo

    argv = [mutation_id] + (["--force"] if force else [])
    return clilib.capture(undo.main, argv)


def _print(report: dict, repaired: list[dict] | None, reversed_out: tuple[int, str] | None) -> None:
    counts: dict[str, int] = {}
    for r in report["rows"]:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    print(f"checked {report['checked']} migrate row(s) that had not reached '{DONE_PHASE}': "
          + (", ".join(f"{v} {k}" for k, v in counts.items()) or "none"))
    for r in report["rows"]:
        if r["state"] not in UNSETTLED_STATES:
            continue  # counted in the headline; the whole row is in --json
        print(f"\n  [{r['state']}] {r['title'] or r['sessionId']}")
        print(f"    {r['source']} -> {r['target']}, phase '{r['phase']}'")
        print(f"    {r['why']}")
        print(f"    finish: python migrate_reconcile.py --finish {r['mutationId']}"
              f"   reverse: python migrate_reconcile.py --reverse {r['mutationId']}")
    if repaired is not None:
        print()
        for r in repaired:
            print(f"  {'repaired' if r['ok'] else 'NOT repaired'}: {r['title'] or r['sessionId']}"
                  f" - {r['outcome']}" + (f" [{', '.join(r['ran'])}]" if r["ran"] else ""))
    if reversed_out is not None:
        print(f"\n  reverse exited {reversed_out[0]}\n{reversed_out[1]}")


def _value_after(argv: list[str], flag: str) -> str | None:
    """The token after `flag`, or None when it is absent or followed by another flag."""
    if flag not in argv:
        return None
    i = argv.index(flag)
    if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
        return None
    return argv[i + 1]


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    do_finish = "--finish" in argv
    finish_id = _value_after(argv, "--finish")
    reverse_id = _value_after(argv, "--reverse")
    if "--reverse" in argv and not reverse_id:
        print("--reverse needs a mutation id (see the list this prints without it)", file=sys.stderr)
        return 3
    limit_raw = _value_after(argv, "--limit")
    try:
        limit = int(limit_raw) if limit_raw else DEFAULT_LIMIT
    except ValueError:
        print(f"--limit takes a number, not {limit_raw!r}", file=sys.stderr)
        return 3

    if reverse_id:
        if mutationlib.get(reverse_id) is None:
            print(f"no mutation with id {reverse_id!r}", file=sys.stderr)
            return 3
        code, said = reverse(reverse_id, force)
        if as_json:
            print(json.dumps({"reversed": reverse_id, "exit": code, "output": said}, indent=2))
        else:
            _print({"checked": 0, "rows": [], "unsettled": []}, None, (code, said))
        return code

    try:
        report = reconcile(limit)
    except hydralib.DaemonError as err:
        print(f"migrate_reconcile FAILED: {err}", file=sys.stderr)
        return 1

    repaired = None
    if do_finish:
        wanted = report["unsettled"]
        if finish_id:
            wanted = [r for r in report["rows"] if r["mutationId"] == finish_id]
            if not wanted:
                print(f"no unfinished migrate row with id {finish_id!r}", file=sys.stderr)
                return 3
        repaired = finish(wanted, force)

    if as_json:
        print(json.dumps({**report, "repaired": repaired}, indent=2))
    else:
        _print(report, repaired, None)

    if repaired is not None:
        return 0 if all(r["ok"] for r in repaired) else 2
    return 2 if report["unsettled"] else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
