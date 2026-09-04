#!/usr/bin/env python3
"""undo.py - ACT: reverse one recorded mutation through the SAME acting script that made it.

Reads the mutation ledger (lib/mutationlib.py) for the row, then drives the inverse act -
archive_chat.py --unarchive, rename_chat.py --to <old title>, migrate_chat.py --to <source
instance>, or hold_chat.py --release / --reason <original reason> - using the before-image
that row already carries. This script invents no actuator of its own: every inverse runs
through the exact same rail-guarded script that performed the original act (gate, breaker,
hold, live-writer refusal and all), via clilib.capture() - the standard chokepoint every lane
script in this repo already uses to run another script's main() as a step.

NOT EVERY MUTATION HAS AN INVERSE. `compact` never does (compaction is lossy by design); a
`rename`/`migrate`/`hold`/`release` whose before-image could not be captured, or whose
recorded outcome was itself unconfirmed (`after=None`), is not undoable either - undo refuses
those before touching anything, deterministically, rather than guessing at a target.

THE OUTCOME IS VERIFIED THE SAME WAY THE ORIGINAL ACT WAS: the underlying script records its
OWN mutation row on its own verified success (every acting script does this now), so undo
does not trust its exit code alone - it looks for that fresh row and links the two together.
An exit 0 with no fresh row (the inverse found nothing to do - already in the target state)
is reported honestly as such, not claimed as an undo.

Usage: python undo.py <mutation-id> [--force] [--json]
  --force   passed through to the underlying script (archive/rename/migrate accept it): a
            deliberate undo is a person's direct word, same as any other --force use in this
            repo, and it still never overrides a live-writer refusal.
Exit:  0 undone and verified (or genuinely nothing to do) - 3 unknown/already-undone/not-
       undoable mutation id, or bad usage (deterministic - recorded nowhere further, there is
       nothing to retry) - whatever exit code the underlying acting script returned otherwise,
       unchanged, so its own Usage: line still explains it - 1 infrastructure failure.
"""

from __future__ import annotations

import importlib
import json
import sys

from lib import clilib, mutationlib


class UndoRefusal(ValueError):
    """No route exists to reverse this mutation - raised by _dispatch, caught by main()."""


def _dispatch(kind: str, session_id: str, before: dict, force: bool) -> tuple[str, list[str]]:
    """The acting script (module name) plus argv that reverses `kind`, built from the
    mutation's own before-image. Raises UndoRefusal for anything this dispatcher does not
    know how to drive - it never invents an actuator for a kind it was not taught."""
    force_flag = ["--force"] if force else []
    if kind == "archive":
        return "archive_chat", [session_id, "--unarchive", "--no-preserve", *force_flag]
    if kind == "unarchive":
        return "archive_chat", [session_id, "--no-preserve", *force_flag]
    if kind == "rename":
        old_title = str((before or {}).get("title") or "").strip()
        if not old_title:
            raise UndoRefusal("the recorded before-image carries no title to rename back to")
        return "rename_chat", [session_id, "--to", old_title, *force_flag]
    if kind == "migrate":
        src = str((before or {}).get("instance") or "").strip()
        if not src:
            raise UndoRefusal("the recorded before-image carries no source instance to migrate back to")
        return "migrate_chat", [session_id, "--to", src, *force_flag]
    if kind == "hold":
        return "hold_chat", [session_id, "--release"]
    if kind == "release":
        reason = str((before or {}).get("reason") or "").strip()
        if not reason:
            raise UndoRefusal("the recorded before-image carries no reason to re-hold with")
        return "hold_chat", [session_id, "--reason", reason]
    raise UndoRefusal(f"no undo route is wired for kind {kind!r}")


def _report(payload: dict, as_json: bool, code: int) -> int:
    if as_json:
        print(json.dumps(payload, indent=2))
    else:
        print(payload["report"])
    return code


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    mutation_id = args[0]

    row = mutationlib.get(mutation_id)
    if row is None:
        return _report(
            {"undone": False, "report": f"REFUSED (deterministic): no mutation {mutation_id!r} on the ledger"},
            as_json, 3,
        )
    if row.get("undoneAt"):
        return _report(
            {"undone": False, "report": f"REFUSED (deterministic): mutation {mutation_id} was "
                                        f"already undone by {row.get('undoneBy')} - re-run "
                                        f"`undo.py {row['undoneBy']}` if you meant the OTHER "
                                        "direction, or leave it: undoing an undo is its own "
                                        "fresh mutation, never a second write to this row."},
            as_json, 3,
        )
    if not row.get("undoable"):
        return _report(
            {"undone": False, "report": f"REFUSED (deterministic): mutation {mutation_id} "
                                        f"({row.get('kind')}) is not undoable - {row.get('whyNot')}"},
            as_json, 3,
        )

    kind = str(row.get("kind"))
    session_id = str(row.get("session") or "")
    inverse_kind = mutationlib.INVERSE_KIND.get(kind)
    if not session_id or inverse_kind is None:
        return _report(
            {"undone": False, "report": f"REFUSED (deterministic): no inverse action exists for "
                                        f"kind {kind!r}, or the mutation carries no session id"},
            as_json, 3,
        )

    try:
        script_name, script_argv = _dispatch(kind, session_id, row.get("before") or {}, force)
    except UndoRefusal as err:
        return _report({"undone": False, "report": f"REFUSED (deterministic): {err}"}, as_json, 3)

    # The underlying script's own mutation row is the proof the inverse landed - see it BEFORE
    # running so a fresh row after can be told apart from one that already existed.
    seen_ids = {r["id"] for r in mutationlib.list_mutations(session_id=session_id, kind=inverse_kind)}

    mod = importlib.import_module(script_name)
    code, output = clilib.capture(mod.main, script_argv)
    print(output)

    if code != 0:
        print(f"\nundo FAILED via {script_name}.py (exit {code}) - the underlying act refused "
              "or failed; nothing here claims it was undone.", file=sys.stderr)
        return code

    after_rows = mutationlib.list_mutations(session_id=session_id, kind=inverse_kind)
    fresh = next((r for r in after_rows if r["id"] not in seen_ids), None)
    if fresh is None:
        return _report(
            {"undone": False,
             "report": f"{script_name}.py exited 0 but recorded no new mutation - it likely "
                       "found nothing to do (the chat may already be in the target state, "
                       "possibly from an earlier undo or an unrelated later change). NOT "
                       f"claiming mutation {mutation_id} was undone; check `mutations.py "
                       f"--session {session_id}` and the chat's own state before retrying."},
            as_json, 0,
        )

    mutationlib.mark_undone(mutation_id, fresh["id"])
    return _report(
        {"undone": True, "undoneBy": fresh["id"],
         "report": f"UNDONE: mutation {mutation_id} ({kind}) reversed via {script_name}.py, "
                   f"verified by its own mutation {fresh['id']} ({inverse_kind})."},
        as_json, 0,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
