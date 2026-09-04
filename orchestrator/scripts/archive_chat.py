#!/usr/bin/env python3
"""archive_chat.py - ACT: archive (or unarchive) ONE chat, with every rule the rewrite inherits.

Both previous orchestrators died on exactly this act, so this script is deliberately paranoid:

  rule 1  a chat that offers to carry on is WAITING - the gate refuses the archive lane.
  rule 2  never act on a live turn - a chat with a live writer process is refused, ALWAYS.
          --force does not override this one; quit the writer first, on purpose, yourself.
  rule 3  every attempt is counted in the ledger; the cap suppresses futile repetition and a
          deterministic refusal (no match / ambiguous title) suppresses after ONE.
  rule 4  a disk write a running app will overwrite is NOT an archive - so under a RUNNING
          app this script does not write flags at all: it drives THE APP'S OWN archive
          control (focus-free UI Automation), which is immediate and durable because the app
          makes the write itself. The owner NEVER restarts the desktop apps (standing order,
          repeated 2026-08-31), so a wait-for-restart path does not exist here. The disk-flag
          path is used only when the app is CLOSED (where it is durable and cheaper).
  rule 5  a person's word is the highest input - the dossier is re-fetched immediately before
          acting, and any movement since the verdict aborts the act.
  rule 6  the output says what changed, not what exists.

--force is the person's direct word: it overrides the gate verdict and the breaker (a deed a
person asks for directly is never blocked), and nothing else.

KNOWLEDGE IS PRESERVED BEFORE ARCHIVING (owner rule, 2026-09-01): the final act before an
archive is to ask the chat to update any relevant markdown files, so what it learned outlives
it. This is a TWO-PHASE step driven by the 5-minute sweep, not a block:
  phase 1  first time an archive candidate reaches the act, the preserve prompt is delivered
           (the native peer channel) and the archive is DEFERRED (exit 8) - the chat runs one
           turn updating its docs.
  phase 2  a later pass sees the chat quiet again with its transcript grown since the request,
           and archives for real.
A dormant chat that never runs the turn is archived anyway after a grace window (a dead chat
cannot update docs). `--no-preserve` skips the whole step (retries of an already-archived
chat, drills, and unarchive never re-preserve).

Usage: python archive_chat.py <title fragment | session id> [--unarchive] [--force]
       [--no-preserve] [--json]
Exit:  0 changed and verified (or genuinely nothing to do) - 2 refused by gate or by movement
       between deciding and acting - 3 deterministic refusal (no match / ambiguous / no id;
       recorded, stops after one) - 4 live writer - 5 breaker - 6 the chat is HELD (a person's
       hands-off switch; --force overrides) - 7 the app is RUNNING and its own control could
       not reach the row (collapsed/virtualized/ambiguous) - honest, retryable, never a
       silent flag - 8 archive DEFERRED: the chat was asked to update its docs first and will
       be archived on a later pass (not a failure) - 1 daemon/infrastructure failure or verify
       failed.
"""

from __future__ import annotations

import json
import sys

from lib import clilib, gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib
from lib import mutationlib
from lib import windowlib


def out(payload: dict, as_json: bool, code: int) -> int:
    if as_json:
        print(json.dumps(payload, indent=2))
    else:
        print(payload["report"])
    return code


from pathlib import Path as _Path

# Relocated into this repo 2026-09-01 (owner: "I own both codebases") from AgentHydra's
# public misc/ folder; same script, the orchestrator's copy.
ACTUATOR = _Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"

# THE PRESERVATION STEP (owner rule, 2026-09-01). Brief on purpose - "doesn't need to be
# comprehensive": just ask for the docs worth keeping.
PRESERVE_PROMPT = (
    "Before this chat is archived, update any relevant markdown files so the knowledge here is "
    "preserved - notes, READMEs, to-do or progress docs, whatever is actually worth keeping. "
    "Keep it brief; you do not need to be comprehensive. When the docs are updated, you're done "
    "and this chat will be archived."
)
# How long to wait for a chat to run its preservation turn before archiving anyway (a dormant
# chat that never took the turn must not wedge the archive forever).
PRESERVE_GRACE_MIN = 20

# The preserve POST asks the daemon's message endpoint to watch for up to confirm_secs before
# answering - hydralib's generic TIMEOUT_SECS (30s) is sized for a plain read, not for that
# wait, so it can time out the HTTP call before the endpoint itself even answers "not
# confirmed" (courier.py and spawn_chat.py hit the same shape and both pass their own
# explicit timeout for it). +60 gives the endpoint's own wait room to finish and reply.
PRESERVE_CONFIRM_SECS = 20
PRESERVE_HTTP_TIMEOUT = PRESERVE_CONFIRM_SECS + 60


def _transcript_size(session_id: str) -> int | None:
    row = hydralib.session_row(session_id)
    path = (row or {}).get("transcript_path")
    if not path:
        return None
    try:
        return _Path(path).stat().st_size
    except OSError:
        return None


def _newest_preserve(session_id: str) -> dict | None:
    rows = [r for r in ledgerlib._load()
            if r.get("kind") == "preserve" and r.get("session") == session_id]
    return max(rows, key=lambda r: r.get("at", 0)) if rows else None


def _request_preservation(session_id: str) -> tuple[bool, str]:
    """Deliver the preserve prompt over the daemon's message endpoint (native peer channel for
    a live chat; composer-boot for a dormant one). Best-effort: a delivery that does not
    confirm still records the request, because the message has almost certainly enqueued and
    the grace window backstops a chat that truly cannot run."""
    try:
        got = hydralib.api_post(f"/api/sessions/{session_id}/message",
                                {"text": PRESERVE_PROMPT, "confirm_secs": PRESERVE_CONFIRM_SECS},
                                timeout=PRESERVE_HTTP_TIMEOUT)
        if isinstance(got, dict) and got.get("delivered"):
            return True, str(got.get("route") or "daemon")
        return False, str((got or {}).get("detail") or (got or {}).get("error") or got)[:160]
    except hydralib.DaemonError as err:
        return False, (err.detail or str(err))[:160]


def _ui_archive(instance: str, title: str, unarchive: bool) -> tuple[int, str]:
    """Drive the running app's OWN Archive/Unarchive control (focus-free UIA). The app makes
    the write itself, so its later memory->disk re-saves cannot undo it - this is the only
    immediate-and-durable path under a running app, and restarts are never an option.

    The actuator's exits: 0 done (row acted on and left/joined the sidebar) - 1 error or
    ambiguity - 2 invoked but the row did not move - 3 the row is not rendered."""
    import subprocess

    if not ACTUATOR.exists():
        return 1, f"the UIA actuator is missing at {ACTUATOR}"
    # Driving the app's own sidebar control opens a context menu inside its window; note the
    # window's placement and put it back if that moved it (windowlib - the owner's "you end up
    # full screening the desktop instance"). A no-op when nothing changed, which it usually is.
    # ONE DRIVER PER WINDOW (windowlib.instance_lock): the courier's composer send and this
    # sidebar control on the same instance must never interleave. Busy means retry next pass.
    with windowlib.instance_lock(instance, wait_secs=60) as mine:
        if not mine:
            return 7, ("REFUSED: that instance's window is busy - another lane is driving it "
                       "right now; retry next pass")
        with windowlib.keep_placement(instance):
            r = clilib.run_text(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR),
                 "-Title", str(title), "-Instance", str(instance),
                 "-Action", "Unarchive" if unarchive else "Archive"],
                timeout=240,
            )
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def _instance_app_running(instance_name) -> bool:
    """Is the named instance's app running? RAISES DaemonError on a failed fleet read -
    this answer picks the running-app-UI vs disk-flag route and gates the settle check, so
    'unknown reads as closed' was a false green waiting to happen (a swallowed error here
    made a bare 'nothing to do' out of an unverifiable state; adversarial review,
    2026-08-31). Callers catch and report the failure loudly."""
    if not instance_name:
        return False
    return any(
        i.get("isRunning") and str(i.get("name", "")).lower() == str(instance_name).lower()
        for i in hydralib.fleet().get("instances", [])
    )


def _resolve_match(query: str, verb: str, as_json: bool) -> tuple[dict | None, int | None]:
    """Resolve the query to one dossier row. Returns (match, None) to continue, or
    (None, stop_code) when the caller should return stop_code immediately - the resolve
    itself is deterministic (rule 3: no match / ambiguous / no id all count and stop after
    one), so every failure branch here is recorded before it reports."""
    try:
        match = hydralib.resolve_one(query)
    except hydralib.ChatNotFound as err:
        return None, out({"changed": False, "report": f"REFUSED (deterministic): {err}"}, as_json, 3)
    except hydralib.AmbiguousChat as err:
        for m in err.matches:
            sid = m.get("cliSessionId")
            if sid:
                ledgerlib.note("archive", sid, deterministic=True, note=str(err))
        return None, out(
            {
                "changed": False,
                "report": (
                    f"REFUSED (deterministic): {err}\n"
                    "Two rows sharing a title is the refusal v2 retried forever - narrow the "
                    "query (use the session id) instead of retrying."
                ),
            },
            as_json,
            3,
        )
    except hydralib.DaemonError as err:
        return None, out({"changed": False, "report": f"{verb} FAILED: {err}"}, as_json, 1)

    session_id = match.get("cliSessionId") or ""
    title = match.get("title")
    if not session_id:
        return None, out(
            {
                "changed": False,
                "report": (
                    f"REFUSED (deterministic): the dossier match for '{title}' carries no "
                    "cliSessionId, so there is no id to act on or to count attempts against."
                ),
            },
            as_json,
            3,
        )
    return match, None


def _handle_already_settled(match: dict, desired: bool, verb: str, title, as_json: bool) -> int | None:
    """Rule 4 does not stop applying just because the flag already matches: under a RUNNING
    app the chat can still be on screen, and calling that 'nothing to do' is how v2's
    'archived' came to mean 'still there'. Returns a stop exit code, or None when the flag
    does not already match desired (continue with the normal act)."""
    if bool(match.get("archived")) != desired:
        return None
    try:
        settle_check = desired and _instance_app_running(match.get("instance"))
    except hydralib.DaemonError as err:
        return out(
            {"changed": False,
             "report": f"archive FAILED: the fleet could not be read ({err}), so whether "
                       f"'{title}' is truly settled under a running app is UNKNOWN - not "
                       "claiming 'nothing to do'; retry."},
            as_json, 1)
    if settle_check:
        # The flag is set but the RUNNING app may still show the row (a leftover from an
        # old disk-flag write). Settle it through the app's own control: exit 3 (row not
        # rendered) means the screen already agrees - settled; exit 0 means the row WAS
        # still there and has now been archived for real.
        code, ui_out = _ui_archive(str(match.get("instance")), str(title), unarchive=False)
        if code == 3:
            return out(
                {"changed": False, "durable": True,
                 "report": f"settled: '{title}' is archived on disk and shows no row in "
                           f"{match.get('instance')}'s sidebar - screen and disk agree."},
                as_json, 0)
        if code == 0:
            # A REAL mutation happened here too (the row was visibly ON screen and the app
            # just took it off), even though the disk flag never moved - so it gets a row
            # like any other landed archive, not just the disk-flag branch below.
            mutationlib.record(
                verb, match.get("cliSessionId") or "", instance=str(match.get("instance") or ""),
                title=str(title), before={"archived": bool(match.get("archived")), "visible": True},
                after={"archived": desired, "visible": False}, undoable=True,
            )
            return out(
                {"changed": True, "durable": True,
                 "report": f"settled via the app's own control: '{title}' was still on "
                           f"screen despite the flag; the app has now archived it itself."},
                as_json, 0)
        return out(
            {"changed": False, "durable": False,
             "report": f"flag set but the screen could not be confirmed: the app's own "
                       f"control answered '{ui_out.splitlines()[-1] if ui_out else code}'. "
                       "Retryable - nothing silent happened."},
            as_json, 7)
    return out(
        {"changed": False, "report": f"nothing to do: '{title}' is already {verb}d"},
        as_json,
        0,
    )


def _check_hold_and_live(session_id: str, match: dict, force: bool, verb: str, title, as_json: bool) -> int | None:
    """A HOLD is a person's word and outranks every verdict below; --force is the person
    speaking again, so it lifts it for one act (never the live-writer rail - rule 2)."""
    hold_why = holdlib.why_blocked(session_id)
    if hold_why and not force:
        return out({"changed": False, "held": True, "report": f"REFUSED: {hold_why}"}, as_json, 6)

    if match.get("live"):
        pid = match["live"].get("pid")
        return out(
            {
                "changed": False,
                "report": (
                    f"REFUSED: '{title}' has a LIVE writer (pid {pid}). Nothing may {verb} a "
                    "chat that still has a writer - not even --force. If this chat is truly "
                    "done, stop its process first, deliberately, yourself."
                ),
            },
            as_json,
            4,
        )
    return None


def _check_gate(match: dict, unarchive: bool, force: bool, title, as_json: bool) -> int | None:
    """Rule 1: only an archive-candidate may be archived unattended."""
    if unarchive:
        return None
    verdict = gatelib.gate_match(match, hydralib.session_row)
    if verdict is None and not force:
        return out(
            {
                "changed": False,
                "report": (
                    f"REFUSED: '{title}' has no transcript to gate - a thing that cannot "
                    "be gated cannot be acted on. --force overrides if you have read it yourself."
                ),
            },
            as_json,
            2,
        )
    ok_lane = (
        verdict is not None
        and verdict["state"] == "finished"
        and verdict["finished"]["lane"] == "archive-candidate"
    )
    if not ok_lane and not force:
        cause = verdict["cause"] if verdict else "ungateable"
        return out(
            {
                "changed": False,
                "gate": verdict,
                "report": (
                    f"REFUSED by the gate: {cause}\n"
                    f"'{title}' is not an archive candidate. If a person has decided "
                    "otherwise, --force expresses that word."
                ),
            },
            as_json,
            2,
        )
    return None


def _recheck_before_acting(session_id: str, match: dict, title, verb: str, as_json: bool) -> tuple[dict | None, int | None]:
    """Rule 5: re-check immediately before acting. Returns (recheck, None) to continue, or
    (None, stop_code) when the resolve failed or the chat moved since the verdict."""
    try:
        recheck = hydralib.resolve_one(session_id)
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        # Deterministic at THIS stage too: the same session-id query will answer the same way
        # next run, and an unrecorded refusal here would be retried forever (review finding).
        ledgerlib.note("archive", session_id, deterministic=True, note=f"re-check: {err}")
        return None, out(
            {
                "changed": False,
                "report": f"REFUSED (deterministic): re-check before acting failed ({err})",
            },
            as_json,
            3,
        )
    except hydralib.DaemonError as err:
        # A daemon blip is infrastructure, not policy: exit 1 so a caller retries it as
        # routine instead of treating it as a gate refusal needing --force.
        return None, out(
            {"changed": False, "report": f"{verb} FAILED: re-check read failed ({err})"},
            as_json,
            1,
        )
    if recheck.get("live") or recheck.get("lastActivityAt") != match.get("lastActivityAt"):
        return None, out(
            {
                "changed": False,
                "report": (
                    f"ABORTED: '{title}' moved between deciding and acting "
                    f"(activity {match.get('lastActivityAt')} -> {recheck.get('lastActivityAt')}"
                    f"{', now has a live writer' if recheck.get('live') else ''}). A person's "
                    "word is the highest input - re-run to re-decide against the new state."
                ),
            },
            as_json,
            2,
        )
    return recheck, None


def _first_preserve_request(session_id: str, title, as_json: bool) -> int:
    """Phase 1, first time this chat reaches the act: deliver the preserve prompt and defer."""
    cur_size = _transcript_size(session_id)
    ok_sent, how = _request_preservation(session_id)
    # An undelivered request is filed as such (live smoke, 2026-09-01: it used to be
    # reported as 'asked'): later passes ask AGAIN while the grace window runs, and the
    # report says what really happened. Preservation stays best-effort - a chat nothing can
    # reach is still archived after the grace window, or it would sit in the fleet forever.
    size_note = f"size={cur_size if cur_size is not None else ''}"
    ledgerlib.note("preserve", session_id,
                   note=size_note if ok_sent else f"undelivered;{size_note}")
    return out(
        {
            "changed": False,
            "preserving": True,
            "report": (
                f"DEFERRED: asked '{title}' to update its markdown files before "
                f"archiving (delivered via {how}). It will be archived on a later "
                "pass once its docs are updated."
                if ok_sent else
                f"DEFERRED: the request for '{title}' to update its markdown files "
                f"was NOT delivered ({how}). Nothing archived; it is asked again on "
                f"each pass and archived after {PRESERVE_GRACE_MIN}m regardless."
            ),
        },
        as_json, 8,
    )


def _pending_preserve_check(session_id: str, title, prev: dict, as_json: bool) -> int | None:
    """Phase 2: a later pass, checking whether the earlier preserve request has been acted on.
    Returns a stop exit code to defer the archive again, or None once the docs turn ran
    (transcript grew) or the grace window has elapsed - either way the archive may proceed."""
    cur_size = _transcript_size(session_id)
    req_size = None
    try:
        raw = str(prev.get("note") or "").split("size=", 1)[-1].strip()
        req_size = int(raw) if raw else None
    except ValueError:
        req_size = None
    grew = cur_size is not None and req_size is not None and cur_size > req_size
    age_min = (int(__import__("time").time() * 1000) - prev.get("at", 0)) / 60000
    if not grew and age_min < PRESERVE_GRACE_MIN and \
            str(prev.get("note") or "").startswith("undelivered"):
        # The last request never reached the chat: ask again (best effort). When it lands
        # now, the grace window restarts from a REAL ask.
        ok_sent, how = _request_preservation(session_id)
        if ok_sent:
            ledgerlib.note("preserve", session_id,
                           note=f"size={cur_size if cur_size is not None else ''}")
            return out(
                {"changed": False, "preserving": True,
                 "report": (f"DEFERRED: asked '{title}' to update its markdown files "
                            f"before archiving (delivered via {how}, after an earlier "
                            "undelivered request). Archived on a later pass.")},
                as_json, 8,
            )
    if not grew and age_min < PRESERVE_GRACE_MIN:
        return out(
            {
                "changed": False,
                "preserving": True,
                "report": (
                    f"DEFERRED: still waiting for '{title}' to update its docs "
                    f"({int(age_min)}m of {PRESERVE_GRACE_MIN}m grace). Re-checking on the next pass."
                ),
            },
            as_json, 8,
        )
    # Either the turn ran (grew) or the grace elapsed with no preservation turn (a dormant
    # chat that never ran: a dead chat cannot update docs, so archive anyway rather than
    # wedge). THE PRESERVE ROW IS CLEARED ONLY WHEN THE ARCHIVE LANDS (below in the caller's
    # caller): clearing it here, before the act, meant every transient act failure re-sent
    # the whole doc-update prompt on the next pass to a chat that had already written its
    # docs - a redundant turn per retry.
    return None


def _preserve_before_archive(session_id: str, title, desired: bool, no_preserve: bool, as_json: bool) -> int | None:
    """KNOWLEDGE PRESERVATION (owner rule, 2026-09-01): the final act before an archive is to
    ask the chat to update its docs. --force does NOT skip this (capturing knowledge is
    orthogonal to permission), only --no-preserve does, and only unarchive/no-preserve skip
    it outright. Returns a stop exit code to defer, or None once the act may proceed."""
    if not desired or no_preserve:
        return None
    prev = _newest_preserve(session_id)
    if prev is None:
        return _first_preserve_request(session_id, title, as_json)
    return _pending_preserve_check(session_id, title, prev, as_json)


def _archive_via_running_app(session_id: str, instance, title, unarchive: bool, verb: str, as_json: bool) -> tuple[dict | None, int | None]:
    """Rule 4, the running-app way: never write a flag the app will re-save away - drive the
    app's OWN control instead (immediate, durable, focus-free). Restarting is never an option
    (owner's standing order), so this is THE path, not a fallback. Returns (result, None) to
    continue to verification, or (None, stop_code) when the control could not land the act."""
    code, ui_out = _ui_archive(str(instance), str(title), unarchive)
    last = ui_out.splitlines()[-1] if ui_out else f"exit {code}"
    if code != 0:
        if "AMBIGUOUS" in ui_out:
            # Two rendered rows share this title - the same deterministic shape as an
            # ambiguous resolve; retrying without renaming one cannot succeed.
            ledgerlib.note("archive", session_id, deterministic=True,
                           note=f"UI ambiguity: {last[:120]}")
        return None, out(
            {"changed": False, "durable": False, "actuator": ui_out[-400:],
             "report": (f"{verb} did NOT land: the app's own control answered '{last}'. "
                        "Attempt recorded - nothing silent happened.")},
            as_json, 7)
    return {"ok": True, "via": "app-ui", "detail": last}, None


def _archive_via_disk_flag(session_id: str, desired: bool, verb: str, as_json: bool) -> tuple[dict | None, int | None]:
    """App closed: the disk flag is durable and cheaper - no UI to fight. Returns (result,
    None) to continue to verification, or (None, stop_code) when the write did not land."""
    try:
        result = hydralib.api_post(f"/api/sessions/{session_id}/desktop-archive", {"archived": desired})
    except hydralib.DaemonError as err:
        return None, out({"changed": False, "report": f"{verb} FAILED: {err} (attempt recorded)"}, as_json, 1)
    if not (isinstance(result, dict) and result.get("ok")):
        reason = (result or {}).get("reason") if isinstance(result, dict) else None
        return None, out(
            {
                "changed": False,
                "daemon": result,
                "report": f"{verb} did NOT land: daemon says ok=false ({reason}). Attempt recorded.",
            },
            as_json,
            1,
        )
    if any(h.get("changed") and h.get("wasRunning") for h in result.get("hits", [])):
        # The app opened in the race window between our check and the POST. The flag is
        # now the un-durable kind - re-run immediately: the running-app path will take
        # over and settle it through the app's own control.
        return None, out(
            {"changed": True, "durable": False, "daemon": result,
             "report": (f"the app opened mid-act, so the flag write is not durable - "
                        "re-run this command now and the app's own control will settle it.")},
            as_json, 7)
    return result, None


def _verify_archive(session_id: str, desired: bool, verb: str, title, result, as_json: bool,
                     *, before: dict | None = None, instance: str = "") -> int:
    """Verify: never claim an act landed without checking, then clear the ledger on success -
    the brake is for futility, not for a real change.

    MUTATION LEDGER: `before` is the pre-act state the caller captured immediately before
    driving the actuator; it is written down here alongside whatever the re-read after-state
    turns out to be, so an undo has a real before/after pair to act on. A verify that cannot
    confirm the outcome still gets a row - `after=None` - because SOMETHING may have changed
    on screen even though this process cannot say what; recording nothing there would be the
    exact "false quiet" this repo's rules exist to forbid."""
    try:
        after = hydralib.resolve_one(session_id)
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError) as err:
        mutationlib.record(
            verb, session_id, instance=instance, title=str(title), before=before, after=None,
            undoable=False, why_not=f"the act was attempted but verify failed ({err}) - the "
                                     "resulting state is unconfirmed, so no inverse can be trusted",
        )
        return out(
            {
                "changed": True,
                "durable": None,
                "report": f"{verb} posted ok but VERIFY FAILED ({err}) - not claiming success. Attempt recorded.",
            },
            as_json,
            1,
        )
    if bool(after.get("archived")) != desired:
        mutationlib.record(
            verb, session_id, instance=instance, title=str(title), before=before, after=None,
            undoable=False, why_not=f"the act was attempted but the dossier still says "
                                     f"archived={after.get('archived')} - not landed, so there "
                                     "is no confirmed after-state to build an inverse from",
        )
        return out(
            {
                "changed": False,
                "daemon": result,
                "report": (
                    f"{verb} posted ok but the dossier still says archived={after.get('archived')} "
                    "- NOT landed. Attempt recorded; the breaker will stop a futile loop."
                ),
            },
            as_json,
            1,
        )

    mutationlib.record(verb, session_id, instance=instance, title=str(title), before=before,
                       after={"archived": bool(after.get("archived"))}, undoable=True)
    ledgerlib.clear("archive", session_id)  # success clears - the brake is for futility
    ledgerlib.clear("preserve", session_id)  # the preservation cycle is complete with it
    return out(
        {
            "changed": True,
            "durable": True,
            "report": f"{verb}d and VERIFIED: '{title}' ({session_id}) - dossier now says archived={desired}.",
        },
        as_json,
        0,
    )


def _act_and_verify(session_id: str, match: dict, unarchive: bool, desired: bool, verb: str, title, force: bool, as_json: bool) -> int:
    """Act, counting the attempt BEFORE claiming anything about the outcome, via whichever
    route rule 4 picks, then verify it really landed."""
    ledgerlib.note("archive", session_id, note=f"{verb} '{title}'{' (forced)' if force else ''}")

    try:
        app_running = _instance_app_running(match.get("instance"))
    except hydralib.DaemonError as err:
        return out(
            {"changed": False,
             "report": f"{verb} FAILED: the fleet could not be read ({err}), so the "
                       "running-app vs disk route cannot be picked honestly. Attempt "
                       "recorded; retry."},
            as_json, 1)

    # The before-image, captured now - immediately before the actuator/disk-flag call, the
    # freshest read this process has (rule 5's re-check already confirmed nothing moved since).
    instance = str(match.get("instance") or "")
    before = {"archived": bool(match.get("archived")), "instance": instance,
              "live": bool(match.get("live"))}

    if app_running:
        result, stop = _archive_via_running_app(session_id, match.get("instance"), title, unarchive, verb, as_json)
    else:
        result, stop = _archive_via_disk_flag(session_id, desired, verb, as_json)
    if stop is not None:
        return stop

    return _verify_archive(session_id, desired, verb, title, result, as_json,
                           before=before, instance=instance)


def _run_locked_archive(session_id: str, match: dict, unarchive: bool, desired: bool, verb: str, title,
                         force: bool, no_preserve: bool, as_json: bool) -> int:
    """ONE ARCHIVE RUN PER CHAT AT A TIME (review 2026-09-01). The groundskeeper's lane and
    the /orchestrate chat's sweep both derive archive candidates from the same shared
    definition on the same 5-minute clock, and the preserve step below READS the ledger,
    POSTS a 20s prompt, then WRITES - so two runs landing on one chat inside that window
    both asked it to update its docs. Non-blocking: the second run defers, never waits.
    stale_secs=300: the default 30s window is right for a quick state mutation, but this
    lock is held for the WHOLE act - the UI actuator alone runs up to 240s (subprocess
    timeout in _ui_archive), plus the preserve POST - so 30s let a second concurrent
    invocation decide this one had crashed and steal the lock mid-act, running the
    preserve/archive rails twice on one chat (adversarial review, 2026-09-01)."""
    with ledgerlib.try_locked(f"archive-{session_id}", stale_secs=300) as ours:
        if not ours:
            return out(
                {"changed": False, "preserving": True,
                 "report": (f"DEFERRED: another archive run holds '{title}' right now and will "
                            "report its outcome - nothing sent twice; re-checked next pass.")},
                as_json, 8)

        # -- rule 3: the breaker. A direct --force is never blocked, but is still recorded.
        brake = ledgerlib.check("archive", session_id)
        if brake["suppressed"] and not force:
            return out(
                {
                    "changed": False,
                    "breaker": brake,
                    "report": f"SUPPRESSED by the breaker: {brake['why']}",
                },
                as_json,
                5,
            )

        _recheck, stop = _recheck_before_acting(session_id, match, title, verb, as_json)
        if stop is not None:
            return stop

        preserve_stop = _preserve_before_archive(session_id, title, desired, no_preserve, as_json)
        if preserve_stop is not None:
            return preserve_stop

        return _act_and_verify(session_id, match, unarchive, desired, verb, title, force, as_json)


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    unarchive = "--unarchive" in argv
    no_preserve = "--no-preserve" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    query = args[0]
    desired = not unarchive
    verb = "unarchive" if unarchive else "archive"

    # -- resolve: zero or many matches is deterministic - record it so unattended callers
    #    stop after one, and say which chats collided.
    match, stop = _resolve_match(query, verb, as_json)
    if stop is not None:
        return stop
    session_id = match.get("cliSessionId") or ""
    title = match.get("title")

    # -- already there? then say so, unless rule 4's settle check finds it still on screen.
    settled = _handle_already_settled(match, desired, verb, title, as_json)
    if settled is not None:
        return settled

    stop = _check_hold_and_live(session_id, match, force, verb, title, as_json)
    if stop is not None:
        return stop

    # -- rule 1: the gate. Only an archive-candidate may be archived unattended.
    stop = _check_gate(match, unarchive, force, title, as_json)
    if stop is not None:
        return stop

    return _run_locked_archive(session_id, match, unarchive, desired, verb, title, force, no_preserve, as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
