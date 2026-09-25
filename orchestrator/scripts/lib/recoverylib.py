"""recoverylib - RECOVERY RECIPES: a closed table of known failures, one automatic try each.

WHY: the reaction to a stuck chat used to be ad hoc - each lane decided for itself whether to
retry, how often, and when to tell a person. That is how retry loops start, and it leaves "why did
this escalate to me" unanswerable. This file is the one table: every failure kind the toolbox
knows how to meet has a fixed automatic step, at most ONE automatic attempt, and an escalation
policy for when that attempt is spent or fails. Every attempt and every escalation is written to
the recovery ledger (state/recoveries.json), which `fan_out status` shows.

The idea is adapted from ultraworkers/claw-code rust/crates/runtime/src/recovery_recipes.rs
(MIT): recipe_for + attempt_recovery with a per-scenario attempt cap and a ledger. Written fresh
here for the orchestrator's own failure kinds; no code was copied.

The laws, in the same spirit as ledgerlib's breaker:
  - The table is CLOSED. An unknown kind is a programming error and raises, so a caller cannot
    invent a recipe on the fly and slip past the cap.
  - ONE automatic attempt per (kind, subject) until a success clears it. A recipe whose
    success is only a step taken (chat-stalled: "asked") keeps it spent until the caller
    `clear`s it, once the failure is really gone. The step runs outside
    the ledger lock (a composer send takes minutes), and its outcome is recorded after.
  - A failed attempt escalates AT ONCE, by the recipe's policy: alert-human files an incident
    (list_incidents shows it), abort tells the caller to stop this act, log-and-continue only
    writes the row. A kind whose attempt is already spent escalates without trying again.
  - A kind with no safe automatic step (arming the tray is the owner's switch) has
    maxAttempts 0 and escalates straight away - the row still says why.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable

from lib import incidentlib, ledgerlib

ALERT_HUMAN = "alert-human"
ABORT = "abort"
LOG_AND_CONTINUE = "log-and-continue"
ESCALATIONS = (ALERT_HUMAN, ABORT, LOG_AND_CONTINUE)

# The closed table. `step` is what the one automatic attempt does, in words a person reads in the
# ledger; the caller supplies the code that does it.
RECIPES: dict[str, dict] = {
    "delivery-failed": {
        "step": ("re-send the same text once, only when the message route refused before typing "
                 "(an unconfirmed send is never repeated blind)"),
        "maxAttempts": 1,
        "escalation": ALERT_HUMAN,
    },
    "account-at-cap": {
        "step": "re-rank the accounts once and spawn the task into one that now has room",
        "maxAttempts": 1,
        "escalation": LOG_AND_CONTINUE,
    },
    "chat-stalled": {
        "step": "ask the chat once, through its composer, whether it is stuck",
        "maxAttempts": 1,
        "escalation": ALERT_HUMAN,
        # A delivered question is not a recovered chat: the attempt stays spent until the
        # member leaves the stalled state (the caller's `clear`), or every recover asks again.
        "onSuccess": "asked",
    },
    "tray-not-armed": {
        "step": None,  # arming is a person's act: nothing here ever puts the icon up
        "maxAttempts": 0,
        "escalation": ABORT,
    },
}

# The ledger is a record for people, not a store: keep the newest rows only.
LEDGER_CAP = 500


def recipe_for(kind: str) -> dict:
    """The recipe for one failure kind, with its kind stamped in. Raises on an unknown kind."""
    if kind not in RECIPES:
        raise ValueError(f"no recovery recipe for {kind!r} - known: {', '.join(sorted(RECIPES))}")
    return {"kind": kind, **RECIPES[kind]}


def _path() -> Path:
    return ledgerlib._state_dir() / "recoveries.json"


def _load() -> list[dict]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    rows = raw.get("recoveries", []) if isinstance(raw, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"recoveries": rows[-LEDGER_CAP:]}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def attempts_used(kind: str, subject: str, _rows: list[dict] | None = None) -> int:
    """Automatic attempts spent on (kind, subject) since its last recovery or clear."""
    used = 0
    for r in (_rows if _rows is not None else _load()):
        if r.get("kind") != kind or r.get("subject") != subject:
            continue
        if r.get("outcome") in ("recovered", "cleared"):
            used = 0
        elif r.get("attempted"):
            used += 1
    return used


def _append(row: dict) -> None:
    """Write one ledger row. A repeat escalation of the same (kind, subject) with nothing tried
    in between refreshes the last row's count instead of stacking identical rows."""
    with ledgerlib.locked("recoveries"):
        rows = _load()
        last = next((r for r in reversed(rows)
                     if r.get("kind") == row["kind"] and r.get("subject") == row["subject"]), None)
        if (last and not row["attempted"] and not last.get("attempted")
                and last.get("outcome") == row["outcome"]):
            last["count"] = int(last.get("count", 1)) + 1
            last["lastAt"] = row["at"]
            last["detail"] = row["detail"]
        else:
            rows.append(row)
        _save(rows)


def _escalate(recipe: dict, subject: str, why: str) -> dict:
    """Apply the recipe's escalation policy. Returns the fields it adds to the ledger row."""
    out = {"outcome": "escalated", "escalation": recipe["escalation"]}
    if recipe["escalation"] == ALERT_HUMAN:
        out["incident"] = incidentlib.record("recovery", f"{recipe['kind']}:{subject}",
                                             f"{recipe['kind']}: {why}")
    return out


def attempt_recovery(kind: str, subject: str, step: Callable[[], tuple[bool, str]] | None = None,
                     *, context: str = "") -> dict:
    """Meet one failure with its recipe. `step` performs the recipe's automatic attempt and
    returns (ok, detail); it runs only while the attempt is unspent. Returns the ledger row:
    outcome recovered | asked | escalated, the escalation applied, and why."""
    recipe = recipe_for(kind)
    used = attempts_used(kind, subject)
    row = {"at": int(time.time() * 1000), "kind": kind, "subject": str(subject),
           "context": context, "step": recipe["step"], "attempted": False}
    if step is None or used >= recipe["maxAttempts"]:
        why = ("no automatic step - " if step is None or recipe["maxAttempts"] == 0 else
               f"the one automatic attempt is already spent ({used}/{recipe['maxAttempts']}) - ")
        row["detail"] = why + context if context else why.rstrip(" -")
        row.update(_escalate(recipe, subject, row["detail"]))
        _append(row)
        return row
    try:
        ok, detail = step()
    except Exception as err:  # noqa: BLE001 - a crashing step is a failed attempt, never a traceback
        ok, detail = False, f"the step raised {type(err).__name__}: {err}"
    row["attempted"] = True
    row["detail"] = detail
    if ok:
        row["outcome"] = recipe.get("onSuccess", "recovered")
    else:
        row.update(_escalate(recipe, subject, detail))
    _append(row)
    return row


def clear(kind: str, subject: str, detail: str = "") -> dict | None:
    """The failure is gone on its own (a stalled chat is working again): free the spent attempt
    so a LATER failure of the same kind gets its one try. A no-op, and None, when none is spent."""
    recipe_for(kind)
    if not attempts_used(kind, subject):
        return None
    row = {"at": int(time.time() * 1000), "kind": kind, "subject": str(subject),
           "context": "", "step": None, "attempted": False, "outcome": "cleared",
           "detail": detail}
    _append(row)
    return row


def ledger(subject_prefix: str | None = None) -> list[dict]:
    """Ledger rows, oldest first, optionally only those whose subject starts with a prefix."""
    rows = _load()
    if subject_prefix is None:
        return rows
    return [r for r in rows if str(r.get("subject", "")).startswith(subject_prefix)]
