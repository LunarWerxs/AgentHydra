"""incidentlib - THE INCIDENT LEDGER: groups repeated failures into one thing to look at.

Ported from NousResearch/hermes-agent cron/incidents.py (MIT, Copyright (c) Nous Research).
Adapted for AgentHydra: hermes shared its incidents table with a SQLite executions database;
this orchestrator has no database anywhere - every piece of state is JSON rows in
<repo>/state/*.json (ledgerlib's attempts.json, deliverylib's deliveries.json, holdlib's
holds.json), so incidents keep that same shape rather than being the one file here that
reaches for SQLite. The normalize/redact/signature/classify/upsert/ack model is unchanged.

WHY THIS EXISTS (README.md rule 3: "count every attempt; an act that has failed N times stops,
loudly, and says why"). ledgerlib counts attempts and stops a chat that keeps failing - but it
has no notion of WHY. Four rows that all read "deterministic-stop" could be four unrelated
causes, or one daemon blip hitting four different chats in the same pass; either way ledgerlib
shows four anonymous rows and an operator has to open each one to find out. incidentlib groups
failures by a normalized error SIGNATURE - (scope, key) + the error text, where scope is a
ledgerlib kind ("archive", "migrate", ...) and key is the chat/session id - so the SAME cause
recurring on the SAME chat collapses into ONE incident instead of re-alerting every attempt.
`error_fingerprint()` is the sibling half: the error text ALONE, no scope/key, so sweep.py's
shared-cause breaker can tell whether several DIFFERENT chats are failing for the same reason.

Lifecycle: open -> acked -> resolved. The SAME (scope, key) + same normalized error resolves to
the SAME incident id, so a resolved incident stays resolved until the error text changes and
mints a new one - a resolve is a person's word that this signature is understood, not a snooze
button that should quietly re-open on its own just because the symptom repeated. The cure for a
recurring identical failure is fixing the cause (which changes the text and mints a fresh
incident), not re-alerting on an id someone already closed.

State lives in <repo>/state/incidents.json (override: ORCHESTRATOR_STATE_DIR), with the same
atomic-write (temp file + os.replace) and locked() discipline as ledgerlib/deliverylib - one
canonical storage style across this toolbox, never a second database.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from lib import ledgerlib

INCIDENT_STATES = ("open", "acked", "resolved")

# Classification is best-effort and ordered: the FIRST matching bucket wins, same as hermes.
# Tuned to the vocabulary this toolbox's own act scripts actually write (ledgerlib.note/
# annotate call sites use words like "held", "breaker", "not rendered", "still visible",
# "quota handoff") alongside hermes' original network/agent categories.
_FAILURE_TYPE_ORDER = (
    ("rate_limit", (r"\b429\b", "rate limit", "usage limit", "quota")),
    ("timeout", ("timeout", "timed out")),
    ("auth", (r"\b401\b", "unauthorized", "authentication", "auth")),
    ("hold", ("held by", " hold", "holds.json")),
    ("breaker", ("suppressed", "breaker", "without sticking", "deterministically")),
    ("ui", ("not rendered", "could not reach", "ambiguous", "collision", "still visible")),
    ("delivery", ("delivery", "deliver", "delivering", "verify-snippet", "verify_text")),
    ("config", ("config", "configuration", "validation")),
    ("daemon", ("daemon", "connection refused", "http error", r"\b5\d\d\b")),
    ("agent", ("agent", "model", "provider", "inference")),
)
MAX_ERROR_CHARS = 500
_MAX_SIGNATURE_ERROR_CHARS = 200

# Best-effort secret scrub before an error is ever written to disk (this toolbox has no
# agent.redact module of its own - the hermes original imported one lazily and swallowed a
# missing import; here there is nothing to import, so the patterns live inline). Not a
# guarantee, a floor: never rely on this instead of keeping secrets out of error text upstream.
# Each match is replaced by a FIXED placeholder, never one derived from the match text - a
# derived replacement (e.g. "keep the first word") leaks the whole secret back out again for
# any single-token match, which is exactly the case a bare API key is.
_SECRET_PATTERNS = (
    (re.compile(r"(?i)\b(bearer|authorization)\b\s*[:=]?\s*\S+"), "Authorization [REDACTED]"),
    (re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+"), "credential=[REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9]{10,}\b"), "[REDACTED]"),
)


def _state_dir() -> Path:
    return ledgerlib._state_dir()


def _path() -> Path:
    return _state_dir() / "incidents.json"


def _load() -> list[dict]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    rows = raw.get("incidents", []) if isinstance(raw, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique temp name per writer, same discipline as ledgerlib._save/deliverylib._save: a
    # fixed temp name lets two concurrent writers interleave bytes into one file and the
    # mangled JSON reads back as an empty ledger, wiping every incident it held.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"incidents": rows}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _normalize_error(error: str) -> str:
    """Strip whitespace and lowercase before signing (dedup normalization)."""
    return re.sub(r"\s+", " ", str(error or "")).strip().lower()


def _redact_error(error: str) -> str:
    """Scrub obvious secrets (best-effort; never raises) then bound the length."""
    text = str(error or "")
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:MAX_ERROR_CHARS]


def _error_signature(scope: str, key: str, error: str) -> str:
    """Dedup key: stable for the same (scope, key) + the same normalized error prefix."""
    normalized = _normalize_error(error)[:_MAX_SIGNATURE_ERROR_CHARS]
    return hashlib.sha256(f"{scope}\x1f{key}".encode() + normalized.encode()).hexdigest()[:12]


def error_fingerprint(error: str) -> str:
    """The error text ALONE, no scope/key - for comparing whether several DIFFERENT chats'
    failures share one underlying cause (the sweep.py shared-cause breaker's question), as
    opposed to _error_signature()'s per-(scope,key) dedup key which deliberately differs
    per chat even for the identical error text."""
    normalized = _normalize_error(error)[:_MAX_SIGNATURE_ERROR_CHARS]
    return hashlib.sha256(normalized.encode()).hexdigest()[:12]


def _incident_id(scope: str, key: str, sig: str) -> str:
    return f"{scope[:12]}_{key[:6]}_{sig}"


def classify_failure_type(error: str) -> str:
    """Classify a failure from error-text keywords; ``unknown`` is the default."""
    text = _normalize_error(error)
    if not text:
        return "unknown"
    for kind, patterns in _FAILURE_TYPE_ORDER:
        for pattern in patterns:
            if pattern.startswith("\\b") and pattern.endswith("\\b"):
                if re.search(pattern, text):
                    return kind
            elif pattern in text:
                return kind
    return "unknown"


def upsert_incident(scope: str, key: str, error: str, *, failure_type: str | None = None,
                     meta: dict[str, Any] | None = None, now_ms: int | None = None) -> tuple[str, bool]:
    """Record (or refresh) the incident for (scope, key) failing with ``error``. Returns
    ``(incident_id, is_new)``. An existing row for the signature refreshes ``last_seen_at``/
    ``error``/``count``/``meta`` and keeps its lifecycle STATE - a ``resolved`` incident stays
    resolved (a changed error text mints a new incident instead; see module docstring)."""
    scope = str(scope or "")
    key = str(key or "")
    sig = _error_signature(scope, key, error)
    stored_error = _redact_error(error)
    incident_id = _incident_id(scope, key, sig)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    failure_type = failure_type or classify_failure_type(error)

    with ledgerlib.locked("incidents"):
        rows = _load()
        for row in rows:
            if row.get("id") == incident_id:
                row["last_seen_at"] = now
                row["error"] = stored_error
                row["count"] = int(row.get("count", 1)) + 1
                if meta:
                    row["meta"] = {**(row.get("meta") or {}), **meta}
                _save(rows)
                return incident_id, False
        rows.append({
            "id": incident_id, "scope": scope, "key": key, "error_sig": sig,
            "state": "open", "failure_type": failure_type,
            "first_seen_at": now, "last_seen_at": now,
            "acked_at": None, "resolved_at": None,
            "error": stored_error, "count": 1, "meta": meta or {},
        })
        _save(rows)
        return incident_id, True


def record(scope: str, key: str, error: str, *, failure_type: str | None = None,
           meta: dict[str, Any] | None = None) -> str:
    """The call shape ledgerlib and sweep.py actually use:
    ``incidentlib.record(scope=kind, key=session_id, error=why)``. Thin wrapper over
    upsert_incident() that returns just the id, for a caller that only wants something to
    stamp onto its own row and does not care whether the incident was new."""
    incident_id, _is_new = upsert_incident(scope, key, error, failure_type=failure_type, meta=meta)
    return incident_id


def set_incident_state(incident_id: str, state: str) -> bool:
    """Transition an incident's lifecycle state; return whether it changed. ``resolved`` is
    terminal for that signature (re-open happens by a changed error minting a NEW incident,
    never by re-transitioning this id). Unknown states are rejected (no-op, ``False``)."""
    if state not in INCIDENT_STATES:
        return False
    now = int(time.time() * 1000)
    with ledgerlib.locked("incidents"):
        rows = _load()
        for row in rows:
            if row.get("id") != incident_id:
                continue
            if row.get("state") in (state, "resolved"):
                return False
            if state == "acked":
                row["state"] = "acked"
                row["acked_at"] = now
            elif state == "resolved":
                row["state"] = "resolved"
                row["resolved_at"] = now
                row["acked_at"] = row.get("acked_at") or now
            else:
                row["state"] = state
            _save(rows)
            return True
    return False


def ack_incident(incident_id: str) -> bool:
    """Acknowledge an incident (open -> acked): seen it, stop it re-alerting on repeats of
    the same signature. ``False`` when missing, already acked, or resolved."""
    return set_incident_state(incident_id, "acked")


def resolve_incident(incident_id: str) -> bool:
    """Close an incident for good (-> resolved). ``False`` when missing or already resolved."""
    return set_incident_state(incident_id, "resolved")


def _state_filter(state: str | None) -> tuple[str, ...]:
    return INCIDENT_STATES if state is None else (state,)


def list_incidents(state: str | None = None) -> list[dict]:
    """Every incident, newest-activity first, optionally filtered to one state. ``state=None``
    (the default) returns every state, open through resolved - callers that want only the
    live ones filter for ``{"open", "acked"}`` themselves, the same way ledgerlib.suppressed()
    leaves 'which rows still matter' to its own logic rather than baking one answer in here."""
    if state is not None and state not in INCIDENT_STATES:
        return []
    wanted = _state_filter(state)
    rows = [r for r in _load() if r.get("state") in wanted]
    rows.sort(key=lambda r: (r.get("last_seen_at", 0), r.get("id", "")), reverse=True)
    return rows


def get_incident(incident_id: str) -> dict | None:
    return next((r for r in _load() if r.get("id") == incident_id), None)


def count_incidents(state: str | None = None) -> int:
    if state is not None and state not in INCIDENT_STATES:
        return 0
    wanted = _state_filter(state)
    return sum(1 for r in _load() if r.get("state") in wanted)
