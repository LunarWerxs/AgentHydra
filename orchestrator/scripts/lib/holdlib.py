"""holdlib - PER-CHAT AUTOMATION OPT-OUT: the owner's "hands off this chat" switch.

The v1/v2 postmortems' standing safety valve, ported as the fourth shared library. A hold
says: the unattended machinery must not touch this chat, whatever its gate verdict says,
because a person is working it (or has decided its fate themselves).

The law it lives under, inherited from v2's holds.ts:
  - A hold DEMANDS A REASON. A silent hold is a mystery three days later.
  - A hold OUTRANKS THE BREAKER and every verdict: it is a person's word, and a person's
    word is the highest input (rule 5).
  - A hold NEVER blocks a deed a person asks for DIRECTLY (--force on an act script, or
    holding/releasing itself) - where that script wires a --force check. It bounds the
    UNATTENDED path only, exactly like the breaker; wiring the override into a given act
    script is that script's job, not this library's (adversarial review, 2026-09-01: not
    every act script does yet - see why_blocked()'s message below).
  - A held chat STAYS VISIBLE. Holding is not hiding: the chat still appears in every
    observe surface, labeled as held, so nothing quietly falls off the board.
  - A hold is FOREVER until released, or until its own expiry passes. No implicit decay.

State lives beside the attempt ledger in <repo>/state/holds.json (override:
ORCHESTRATOR_STATE_DIR), with the same atomic-write discipline.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from lib import ledgerlib


def _holds_path() -> Path:
    return ledgerlib._state_dir() / "holds.json"


def _load() -> dict[str, dict]:
    try:
        raw = json.loads(_holds_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    holds = raw.get("holds", {}) if isinstance(raw, dict) else {}
    return {k: v for k, v in holds.items() if isinstance(v, dict)}


def _save(holds: dict[str, dict]) -> None:
    path = _holds_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"holds": holds}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _expired(entry: dict, now_ms: int) -> bool:
    until = entry.get("until")
    return until is not None and now_ms >= until


def hold(session_id: str, reason: str, by: str = "owner", until_ms: int | None = None,
         now_ms: int | None = None) -> dict:
    """Place a hold. A reason is REQUIRED - a hold nobody can explain is a bug in three days.

    Writers take the cross-process mutex and are the ONLY place expired holds get pruned
    (adversarial review, 2026-08-31: check() used to prune-and-save on a READ, so a
    dashboard refresh racing a fresh hold could rewrite holds.json without it - a person's
    hold silently vanishing is exactly what this lib exists to forbid)."""
    if not str(reason).strip():
        raise ValueError("a hold demands a reason - never hold a chat silently")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    with ledgerlib.locked("holds"):
        holds = {k: v for k, v in _load().items() if not _expired(v, now_ms)}
        entry = {"session": session_id, "reason": str(reason).strip(), "by": by,
                 "at": now_ms, "until": until_ms}
        holds[session_id] = entry
        _save(holds)
    return entry


def release(session_id: str, now_ms: int | None = None) -> bool:
    """Lift a hold. Returns whether one was there. Prunes expired holds while it owns the write."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    with ledgerlib.locked("holds"):
        holds = _load()
        was_there = session_id in holds and not _expired(holds[session_id], now_ms)
        holds = {k: v for k, v in holds.items()
                 if k != session_id and not _expired(v, now_ms)}
        _save(holds)
    return was_there


def check(session_id: str, now_ms: int | None = None,
          _holds: dict[str, dict] | None = None) -> dict | None:
    """The live hold on this chat, or None. An expired hold is not a hold. STRICTLY
    READ-ONLY (adversarial review, 2026-08-31): this used to prune-and-save expired holds,
    which let a read path clobber a hold written concurrently by someone else - reads never
    write now; writers (hold/release) prune while they own the mutex.

    `_holds` mirrors ledgerlib.check()'s `_rows`: a planning loop that gates many chats
    loads the file ONCE and passes it in, instead of re-reading per chat."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    holds = _holds if _holds is not None else _load()
    entry = holds.get(session_id)
    if entry is None or _expired(entry, now_ms):
        return None
    return entry


def held(now_ms: int | None = None) -> list[dict]:
    """Every live hold, for the status surfaces - loud, never silent. One read."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    holds = _load()
    out = [e for e in holds.values() if not _expired(e, now_ms)]
    out.sort(key=lambda e: e.get("at", 0), reverse=True)
    return out


def why_blocked(session_id: str, now_ms: int | None = None,
                _holds: dict[str, dict] | None = None) -> str | None:
    """One human-readable line for an act script's refusal, or None when not held."""
    entry = check(session_id, now_ms, _holds=_holds)
    if not entry:
        return None
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(entry.get("at", 0) / 1000))
    until = entry.get("until")
    expiry = (f", until {time.strftime('%Y-%m-%d %H:%M', time.localtime(until / 1000))}"
              if until else "")
    return (f"HELD by {entry.get('by', 'owner')} since {when}{expiry}: "
            f"{entry.get('reason')} - the unattended machinery leaves held chats alone. "
            "A direct request (--force, on scripts that support it) is never blocked by a hold.")
