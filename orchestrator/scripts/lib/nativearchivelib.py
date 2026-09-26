"""Native archive transport shared by archive and migration source settlement.

Only a proven availability no-op permits the old UI path. A lost POST reply is
unknown, even when the caller cannot tell whether the daemon received it.
"""

from __future__ import annotations

import json
import ntpath
import posixpath
from urllib.parse import quote

from lib import hydralib

NATIVE_VERIFIED = 100
NATIVE_TERMINAL = 101
HTTP_TIMEOUT_SECS = 45

# CLI ids of every chat the CURRENT move is taking off its source (migrate_batch fills it for
# the settle phase). The app's archive stops every server registered under the chat's cwd, so a
# batch sharing one cwd refused each archive over its siblings' servers and left every source
# row visible (2026-09-26); a sibling that is leaving too is not a bystander.
_leaving: tuple[str, ...] = ()


def set_leaving(session_ids) -> None:
    global _leaving
    _leaving = tuple(str(s) for s in (session_ids or ()) if s)


def _terminal(reason: str, *, dispatch: str = "not-sent") -> tuple[int, str]:
    return NATIVE_TERMINAL, json.dumps({
        "available": True, "ok": False, "verified": False,
        "dispatch": dispatch, "reason": reason,
    })


def result(detail: str) -> dict:
    """Decode only a native sentinel's detail, never actuator prose."""
    return json.loads(detail)


def _profile_dir(instance: str) -> str:
    value = instance.removeprefix("desktop:")
    def absolute(path: str) -> bool:
        drive, tail = ntpath.splitdrive(path)
        return posixpath.isabs(path) or bool(drive and tail.startswith(("\\", "/")))

    if absolute(value):
        return value
    # Do not choose the first same-name profile or resolve by fuzzy email/title.
    rows = [row for row in hydralib.fleet().get("instances", [])
            if str(row.get("name") or "").casefold() == value.casefold()]
    if len(rows) != 1 or not absolute(str(rows[0].get("dir") or "")):
        raise ValueError("native archive requires one exact source profile directory")
    return str(rows[0]["dir"])


def try_archive(session_id: str, instance: str) -> tuple[int, str] | None:
    """Return verified/terminal native result, or None for safe legacy fallback."""
    if not session_id:
        return _terminal("native archive requires a CLI session ID")
    try:
        profile = _profile_dir(instance)
    except (hydralib.DaemonError, ValueError) as err:
        return _terminal(f"native archive source identity could not be resolved: {err}")
    path = f"/api/sessions/{quote(session_id, safe='')}/native-archive"
    try:
        request = {"instance_ref": f"desktop:{profile}"}
        leaving = [s for s in _leaving if s != session_id]
        if leaving:
            request["leaving"] = leaving
        body = hydralib.api_post_once(path, request, timeout=HTTP_TIMEOUT_SECS)
    except hydralib.DaemonError as err:
        try:
            body = json.loads(err.detail)
        except (ValueError, TypeError):
            body = None
        # Old daemons have no native route. A structured native refusal, including
        # a 404 for a missing target, must never be mistaken for a missing route.
        if err.status == 404 and not (isinstance(body, dict) and "available" in body):
            return None
        if not (isinstance(body, dict) and "available" in body):
            return _terminal(f"native archive reply was not confirmed: {err.detail}",
                             dispatch="unknown")
    if not isinstance(body, dict):
        return _terminal("native archive returned an invalid response", dispatch="unknown")
    if (body.get("available") is False and body.get("dispatch") == "not-sent"
            and body.get("ok") is False and body.get("verified") is False):
        return None
    if (body.get("available") is True and body.get("ok") is True
            and body.get("verified") is True and body.get("dispatch") in ("sent", "not-sent")):
        return NATIVE_VERIFIED, json.dumps(body)
    if body.get("available") is not True or body.get("dispatch") not in ("sent", "not-sent", "unknown"):
        return _terminal("native archive returned an inconsistent response", dispatch="unknown")
    return NATIVE_TERMINAL, json.dumps(body)
