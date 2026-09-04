#!/usr/bin/env python3
"""migrate_chat.py - ACT: land ONE chat in a desktop instance (the account-migration move).

Drives POST /api/sessions/:id/import-desktop. The daemon owns the mechanics (it can inject its
migration notice so the chat introduces itself in its new home); this script owns the rules:

  - the target instance must exist and be resolvable BEFORE anything is posted; an unknown
    target is a deterministic refusal, not a retry loop.
  - a 409 "superseded" from the daemon is deterministic: this lineage was retired on purpose,
    and only a person's --force re-lands it.
  - every attempt is counted (kind 'migrate'); the cap stops a futile loop, success clears.
  - the landing is VERIFIED: after the daemon says ok, the dossier must show the chat in the
    target instance, or this script does not claim it.

Usage: python migrate_chat.py <title fragment | session id> --to <instance num|name|dir>
       [--title "New title"] [--force] [--stop-idle] [--idle-wait N] [--json]
  --stop-idle   a chat whose engine is alive but IDLE (finished its turn, quiet 5+ min) is
                stopped deliberately first, and confirmed gone, then moved - the desktop
                never stops an engine on its own, so without this no desktop chat could ever
                move (owner: "only chats that are stopped, waiting, chilling"). A working or
                stuck engine still refuses. The sweep's move and land lanes pass it.
  --idle-wait N wait up to N seconds (capped at 360) for a chat that is idle but has NOT YET
                been quiet long enough, then move it. OPT-IN, and only ever satisfies that
                ONE refusal: a working engine, a stuck engine and a live writer all still
                refuse instantly. Needs --stop-idle; without it there is nothing to wait for.

                Why it exists: the refusal already knows the exact deficit ("quiet 253s,
                needs 300s"), and before this flag it threw that number away. An operator -
                or an AI - then re-ran the command on a guess, so a 47-second wait cost
                several minutes of round trips and four near-identical refusals. Waiting is
                the same 300 seconds either way; this just stops paying a round trip to
                discover it has not elapsed. Because quiet is wall-clock age, waiting out
                one chat ages the rest of a batch on the same clock.
Exit:  0 landed and verified - 3 deterministic refusal (chat/instance not resolvable,
       superseded, or a 400 the daemon will repeat) - 4 live writer (import rewrites the
       transcript; never overridden) - 5 breaker - 6 the chat is HELD (--force overrides) -
       1 daemon failure or verify failed.

Without --title, the chat's CURRENT title (just read from the dossier) is restated as
confirm_title - the daemon's naming door demands a real title or exactly that proof of a
programmatic review on every import.

THE AUTOMATION DOCTRINE (owner, 2026-08-31): chats run bypassPermissions wherever possible,
keep whatever model they were assigned (nothing here ever changes a chat's model), and use
ultracode - MECHANICALLY, never by words in a prompt (owner correction, same day). So every
VERIFIED landing also (a) asks the daemon to stamp bypassPermissions (POST
/api/sessions/:id/automation) and (b) stamps sessionSettings.ultracode=true + effort=xhigh
into the chat's meta record on disk (stamplib) - a fresh landing has not booted yet, which
is the one moment the stamp is durable. Best-effort: a failed stamp never un-lands the
chat, but it is reported, never hidden.
"""

from __future__ import annotations

import json
import time
import sys
from dataclasses import dataclass
from pathlib import Path as _Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib


ELIDED = ("…", "...")

# --idle-wait is bounded no matter what a caller passes. Six minutes covers the one thing it
# is for (a 300s quiet window that has partly elapsed) with headroom; anything longer is a
# caller wanting a scheduler, not a flag, and a script that can block indefinitely is a
# script that will one day wedge a lane behind it.
IDLE_WAIT_CAP = 360
# How often to re-ask while waiting, when the deficit is not itself the answer.
IDLE_WAIT_POLL_SECS = 15


def _untruncated_title(session_id: str, shown: str | None) -> str | None:
    """The title the NAMING DOOR wants: the session's own, whenever the desktop record's is
    elided. The app stores a long chat title cut short with an ellipsis, and the daemon
    compares confirm_title against the full one, so restating what the record shows is a
    guaranteed rejection. Only an actually-elided title is looked up - a normal title is
    never second-guessed, and a failed lookup degrades to what we already had."""
    text = str(shown or "")
    if not text.endswith(ELIDED):
        return shown
    try:
        for row in hydralib.sessions():
            if row.get("session_id") == session_id:
                full = str(row.get("title") or "")
                if full and not full.endswith(ELIDED):
                    return full
                break
    except hydralib.DaemonError:
        pass
    return shown


def resolve_for_migrate(query: str) -> dict:
    """Resolve the chat to migrate. The dossier only knows chats that ALREADY have a desktop
    record - which is exactly what a console-only session lacks, and landing those is this
    script's main job (found live 2026-08-31: every console landing died on 'no chat
    matches'). So: dossier first; on no-match, fall back to the daemon's sessions table and
    build the same match shape from the row. Ambiguity stays a deterministic refusal."""
    try:
        return hydralib.resolve_one(query)
    except hydralib.ChatNotFound:
        rows = hydralib.sessions()
        hits = [r for r in rows if r.get("session_id") == query]
        if not hits:
            q = query.lower()
            hits = [r for r in rows if q in str(r.get("title") or "").lower()]
        if not hits:
            raise
        if len(hits) > 1:
            raise hydralib.AmbiguousChat(
                query,
                [{"instance": h.get("instance"), "title": h.get("title"),
                  "cliSessionId": h.get("session_id")} for h in hits],
            ) from None
        row = hits[0]
        return {
            "cliSessionId": row.get("session_id"),
            "chatId": None,
            "title": row.get("title"),
            "instance": row.get("instance"),
            "archived": bool(row.get("archived")),
            "lastActivityAt": row.get("last_activity_at"),
            # No desktop record means no registry-backed liveness here; the daemon's import
            # itself refuses a live session, and we surface that refusal honestly below.
            "live": None,
            "_from_sessions_table": True,
        }


# The instance resolver lives in hydralib (shared judgment); this alias keeps migrate's own
# call sites readable without other scripts importing THIS module for it.
resolve_instance = hydralib.resolve_instance

_ACTUATOR = _Path(__file__).resolve().parent / "actuator" / "manage_desktop_chat.ps1"  # relocated 2026-09-01


def _settle_source(instance: str, title: str) -> tuple[int, str]:
    """Archive the SUPERSEDED source row through its RUNNING app's own control.

    THE ZOMBIE-ROW LEAK (found live 2026-08-31, five fresh cases in minutes): the daemon's
    import flags the source copy archived on disk, but a RUNNING source app re-saves the
    flag away - so every migration off an open account left a visible stale twin, and the
    twins made every later resolve of that chat ambiguous. Settling through the app's own
    archive control is immediate and durable (the app makes the write itself). Exit 3 (row
    not rendered) means the screen already agrees - settled."""
    r = clilib.run_text(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_ACTUATOR),
         "-Instance", instance, "-Action", "Archive", "-Title", title],
        timeout=240,
    )
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def _source_still_visible(session_id: str, src_instance: str) -> bool:
    """Does the SOURCE instance's store still carry an un-archived record of this chat? The
    confirm step after a settle: the app's own control said one thing, the disk is the check."""
    from lib import stamplib

    try:
        fleet_data = hydralib.fleet()
    except hydralib.DaemonError:
        return False  # unknown is not "visible"; the twins lane re-reads on its own clock
    for store in stamplib.store_roots(fleet_data):
        if str(store["instance"]).lower() != str(src_instance).lower():
            continue
        for path, meta in stamplib.iter_metas(store["root"]):
            cli = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            if cli == session_id and not meta.get("isArchived"):
                return True
    return False


def _archive_source_on_disk(session_id: str, src_instance: str) -> bool:
    """Last-resort retirement of a superseded source row: flip isArchived on its meta record.

    Weaker than the app's own control (a running app can re-save it away) and deliberately
    scoped to the SOURCE instance only, so the freshly landed copy is never touched."""
    from lib import stamplib

    try:
        fleet_data = hydralib.fleet()
    except hydralib.DaemonError:
        return False
    done = False
    for store in stamplib.store_roots(fleet_data):
        if str(store["instance"]).lower() != str(src_instance).lower():
            continue
        for path, meta in stamplib.iter_metas(store["root"]):
            cli = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            if cli != session_id or meta.get("isArchived"):
                continue
            meta["isArchived"] = True
            try:
                path.write_text(json.dumps(meta), encoding="utf-8")
                done = True
            except OSError:
                pass
    return done


@dataclass
class MigrateArgs:
    """Parsed migrate_chat.py argv - see main()'s Usage docstring for the flags."""

    as_json: bool
    force: bool
    stop_idle: bool
    to: str
    title: str | None
    idle_wait: int
    query: str


class _MigrateRefusal(Exception):
    """Carries a finished out() payload up to main(): every phase below raises this instead
    of returning early, so main() reads as one straight line wrapped in a single try/except
    rather than a refusal check after every step."""

    def __init__(self, payload: dict, code: int):
        super().__init__(payload.get("report", ""))
        self.payload = payload
        self.code = code


def _parse_migrate_argv(argv: list[str]) -> MigrateArgs | int:
    """Hand-rolled flag parsing (kept out of argparse so an unknown flag is just ignored, not
    a hard error - other scripts in this suite share that convention). Returns the parsed
    flags, or prints usage/an error and returns the exit code to use when parsing itself
    fails (never routed through out(), matching the original behaviour)."""
    as_json = "--json" in argv
    force = "--force" in argv
    stop_idle = "--stop-idle" in argv
    to = title = None
    idle_wait = 0
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--to" and i + 1 < len(argv):
            to = argv[i + 1]
            i += 2
            continue
        if a == "--title" and i + 1 < len(argv):
            title = argv[i + 1]
            i += 2
            continue
        if a == "--idle-wait":
            if i + 1 >= len(argv):
                print(__doc__.strip(), file=sys.stderr)
                return 3
            try:
                idle_wait = int(argv[i + 1])
            except ValueError:
                print(f"--idle-wait needs a whole number of seconds, got {argv[i + 1]!r}",
                      file=sys.stderr)
                return 3
            if idle_wait < 0:
                print("--idle-wait cannot be negative", file=sys.stderr)
                return 3
            idle_wait = min(idle_wait, IDLE_WAIT_CAP)  # bounded, always - never a hang
            i += 2
            continue
        if not a.startswith("--"):
            args.append(a)
        i += 1
    if len(args) != 1 or not to:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    return MigrateArgs(as_json, force, stop_idle, to, title, idle_wait, args[0])


def _resolve_chat_or_raise(query: str) -> tuple[dict, dict]:
    """Resolve the chat to migrate plus the fleet, or raise the same refusal main() used to
    return inline."""
    try:
        match = resolve_for_migrate(query)
        fleet = hydralib.fleet()
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        raise _MigrateRefusal({"landed": False, "report": f"REFUSED (deterministic): {err}"}, 3) from err
    except hydralib.DaemonError as err:
        raise _MigrateRefusal({"landed": False, "report": f"migrate FAILED: {err}"}, 1) from err
    return match, fleet


def _resolve_target_or_raise(fleet: dict, to: str, match: dict, session_id: str, chat_title) -> dict:
    """Resolve --to to a real instance, and short-circuit a no-op move."""
    target = resolve_instance(fleet, to)
    if target is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        ledgerlib.note("migrate", session_id, deterministic=True, note=f"no instance matches {to!r}")
        raise _MigrateRefusal(
            {
                "landed": False,
                "report": f"REFUSED (deterministic): no instance matches {to!r}. Known: {known}",
            },
            3,
        )
    if str(match.get("instance", "")).lower() == str(target.get("name", "")).lower():
        raise _MigrateRefusal(
            {"landed": False, "report": f"nothing to do: '{chat_title}' already lives in {target.get('name')}"},
            0,
        )
    return target


def _check_hold_or_raise(session_id: str, force: bool) -> None:
    """A HOLD is a person's word: the unattended machinery leaves held chats alone (--force
    is that person speaking again)."""
    hold_why = holdlib.why_blocked(session_id)
    if hold_why and not force:
        raise _MigrateRefusal({"landed": False, "held": True, "report": f"REFUSED: {hold_why}"}, 6)


def _stop_idle_engine_or_raise(match: dict, query: str, chat_title, session_id: str,
                                idle_wait: int, force: bool) -> dict:
    """--stop-idle's wait dance: stop an engine that is idle, or wait out the one refusal
    (R_TOO_SOON) that more time actually cures, re-checking liveness and any newly-placed
    hold on every lap. Returns the re-resolved match once it is safe to proceed; raises the
    same refusal main() used to return inline otherwise."""
    from lib import enginelib

    stopped = enginelib.stop_idle_engine(match)
    # --idle-wait: the ONE refusal that more time actually cures is R_TOO_SOON - the engine
    # finished its turn and simply has not been quiet long enough yet. Every other code
    # (STUCK, WORKING, ungateable, unreadable) falls straight through to the refusal below at
    # today's speed, because no amount of sleeping makes those safe.
    deadline = time.time() + idle_wait
    waited_for = 0
    # The budget is bounded TWO ways on purpose - by the wall clock and by the seconds we
    # have actually slept. Either alone is a way to hang: a clock that does not advance (a
    # suspended host, a frozen mock) defeats the deadline, and a sleep that returns early
    # defeats the counter. Whichever runs out first ends the wait.
    while (idle_wait
           and stopped.get("reason") == enginelib.R_TOO_SOON
           and waited_for < idle_wait
           and time.time() < deadline):
        # Sleep the actual deficit when we know it, never a fixed poll: that is the whole
        # point of carrying needs_secs, and it turns four guessed retries into one wait.
        deficit = int(stopped.get("needs_secs") or 0) - int(stopped.get("quiet_secs") or 0)
        left = min(idle_wait - waited_for, max(0, int(deadline - time.time())))
        nap = max(1, min(deficit if deficit > 0 else IDLE_WAIT_POLL_SECS, left))
        time.sleep(nap)
        waited_for += nap
        # ⛔ RE-RESOLVE, never re-use the pre-sleep match: stop_idle_engine taskkills
        # match["live"]["pid"], and a pid captured minutes ago can have been recycled by the
        # OS onto an unrelated process by the time we would act on it.
        try:
            match = resolve_for_migrate(query)
        except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError) as err:
            raise _MigrateRefusal(
                {"landed": False, "report": f"migrate FAILED while waiting out the idle window: {err}"}, 1
            ) from err
        if not match.get("live"):
            stopped = {"stopped": True, "pid": None, "reason": enginelib.R_IDLE,
                       "why": f"the engine exited on its own while waiting {int(waited_for)}s"}
            break
        # ⛔ A HOLD PLACED DURING THE WAIT MUST STILL LAND. The check above ran minutes ago; a
        # person who said "leave this one alone" in the meantime outranks a move that was
        # already in flight.
        hold_now = holdlib.why_blocked(session_id)
        if hold_now and not force:
            raise _MigrateRefusal({"landed": False, "held": True, "report": f"REFUSED: {hold_now}"}, 6)
        stopped = enginelib.stop_idle_engine(match)
    if stopped.get("stopped"):
        waited = f" after waiting {int(waited_for)}s" if waited_for else ""
        ledgerlib.annotate("migrate", session_id,
                           f"stopped idle engine pid {stopped.get('pid')}{waited} ({stopped.get('why')})")
        try:
            return resolve_for_migrate(query)
        except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError) as err:
            raise _MigrateRefusal(
                {"landed": False, "report": f"migrate FAILED after stopping the idle engine: {err}"}, 1
            ) from err
    waited = f" (waited {int(waited_for)}s)" if waited_for else ""
    raise _MigrateRefusal(
        {
            "landed": False,
            "stopReason": stopped.get("reason"),
            "waitedSecs": int(waited_for),
            "report": f"REFUSED: '{chat_title}' has a live engine and it is not safely idle - "
                      f"{stopped.get('why')}{waited}. Not moving.",
        },
        4,
    )


def _settle_live_writer_or_raise(match: dict, query: str, chat_title, session_id: str,
                                  stop_idle: bool, idle_wait: int, force: bool) -> dict:
    """Rule 2, absolute: the import rewrites the transcript, and the daemon itself refuses a
    live session - refusing here first keeps the reason honest and the attempt un-spent.
    --stop-idle (live smoke, 2026-09-01) is the one escape hatch: the desktop keeps an engine
    alive indefinitely after the turn ends, so without it every desktop chat had a "live
    writer" forever and nothing could ever move."""
    if match.get("live") and stop_idle:
        match = _stop_idle_engine_or_raise(match, query, chat_title, session_id, idle_wait, force)
    if match.get("live"):
        pid = match["live"].get("pid")
        raise _MigrateRefusal(
            {
                "landed": False,
                "report": (
                    f"REFUSED: '{chat_title}' has a LIVE writer (pid {pid}) and importing "
                    "rewrites the transcript. Not even --force. Let it finish or stop it "
                    "deliberately first."
                ),
                # No stopReason: this refusal is reached WITHOUT --stop-idle, so nothing
                # gated it. A caller must not read its absence as "waiting might help".
            },
            4,
        )
    return match


def _check_breaker_or_raise(session_id: str, force: bool) -> None:
    brake = ledgerlib.check("migrate", session_id)
    if brake["suppressed"] and not force:
        raise _MigrateRefusal(
            {"landed": False, "breaker": brake, "report": f"SUPPRESSED by the breaker: {brake['why']}"},
            5,
        )


def _build_import_body(target: dict, title: str | None, door_title, force: bool) -> dict:
    """THE NAMING DOOR (daemon rule): every import must carry a real title, or restate the
    current one exactly as proof of a programmatic review. We just read it from the dossier -
    that IS the review - so restate it. Without this the daemon 400s every bare invocation.

    RESTATE THE SESSION'S TITLE, NOT THE ON-SCREEN ONE, when they differ: the desktop record
    elides a long title with an ellipsis and the daemon compares against the untruncated one,
    so a bare move of any long-titled chat was a deterministic 400 that only --title could
    clear (hit live 2026-09-03, moving the Agos chats)."""
    body: dict = {"instance_ref": target.get("ref") or f"desktop:{target.get('dir')}"}
    if title:
        body["title"] = title
    else:
        body["confirm_title"] = door_title
    if force:
        body["force"] = True
    return body


def _pretrust_workspace(session_id: str) -> None:
    """TRUST THE WORKSPACE FIRST (owner, 2026-09-01): a chat whose cwd the app does not trust
    stops on a human dialog no rail can answer - so the landing pre-writes the trust flag for
    its own working folder. Best-effort and silent-on-success: the trust list is shared by
    every instance, so one write covers wherever this chat ends up."""
    try:
        import trust_workspace

        row = hydralib.session_row(session_id) or {}
        if row.get("cwd"):
            trust_workspace.apply_trust([str(row["cwd"])], act=True)
    except Exception:  # trust is a convenience rail; never let it block a landing
        pass


def _migrate_import_error(err: "hydralib.DaemonError", session_id: str) -> _MigrateRefusal:
    """Translate a failed import-desktop POST into the right refusal. A 409/400 is
    deterministic (the daemon is rejecting these exact inputs, so retrying is futile); a 422
    on a live session is transient; anything else is a bare failure with the attempt already
    recorded by the caller."""
    if err.status == 409:
        ledgerlib.note("migrate", session_id, deterministic=True, note="superseded lineage")
        return _MigrateRefusal(
            {
                "landed": False,
                "report": (
                    f"REFUSED (deterministic): the daemon says this lineage is SUPERSEDED "
                    f"({err.detail[:200]}). It was retired on purpose; only a person's "
                    "--force re-lands it."
                ),
            },
            3,
        )
    if err.status == 400:
        # A 400 is the daemon rejecting these exact inputs (bad instance_ref, title door):
        # the same call will 400 again, so retrying it is v2's futile loop. Stop after one.
        ledgerlib.note("migrate", session_id, deterministic=True, note=f"400: {err.detail[:150]}")
        return _MigrateRefusal(
            {
                "landed": False,
                "report": (
                    f"REFUSED (deterministic): the daemon rejected the request "
                    f"({err.detail[:200]}). Same inputs will be rejected again - fix the "
                    "inputs (e.g. pass --title) rather than retrying."
                ),
            },
            3,
        )
    if err.status == 422 and "live" in err.detail.lower():
        # The daemon refused a LIVE session - transient, not deterministic: the same call is
        # fine once the session's writer finishes. Attempt stays counted; the breaker bounds
        # a hot retry loop.
        return _MigrateRefusal(
            {
                "landed": False,
                "report": (
                    f"REFUSED by the daemon: the session is LIVE and the import rewrites "
                    f"the transcript ({err.detail[:150]}). Retry after it finishes its turn."
                ),
            },
            4,
        )
    return _MigrateRefusal(
        {"landed": False, "report": f"migrate FAILED: {err} (attempt recorded)"}, 1
    )


def _post_import_or_raise(session_id: str, target: dict, body: dict) -> dict:
    """POST the import and translate a daemon failure into the right refusal (see
    _migrate_import_error). Runs under the target app's own window-placement guard, since the
    daemon's resume deeplink can foreground and reshow the target window mid-call."""
    from lib import windowlib

    try:
        with windowlib.keep_placement(target.get("dir") or target.get("name")):
            result = hydralib.api_post(f"/api/sessions/{session_id}/import-desktop", body)
    except hydralib.DaemonError as err:
        raise _migrate_import_error(err, session_id) from err
    if not (isinstance(result, dict) and result.get("ok", True)):
        raise _MigrateRefusal(
            {
                "landed": False,
                "daemon": result,
                "report": "migrate did NOT land: daemon says ok=false. Attempt recorded.",
            },
            1,
        )
    return result


def _verify_landing_or_raise(session_id: str, target: dict, chat_title, result: dict) -> list[dict]:
    """Verify the landing: the dossier must now place the chat in the target instance.

    Records the read-back verdict onto the SAME ledger row `main()`'s ledgerlib.note() opened
    (never-claim-landed doctrine): True once the dossier actually shows it, False when the
    dossier came back but disagrees, and UNKNOWN (never False) when the read-back itself could
    not be performed - the daemon posted the import fine, but we genuinely do not know whether
    it landed. unknown must never be silently retried, only surfaced for a person to look at.
    """
    try:
        after = hydralib.dossier(session_id)
    except hydralib.DaemonError as err:
        ledgerlib.verify("migrate", session_id, None, note=f"verify read-back failed: {err}")
        raise _MigrateRefusal(
            {
                "landed": None,
                "daemon": result,
                "report": f"import posted ok but VERIFY FAILED ({err}) - not claiming success.",
            },
            1,
        ) from err
    landed = any(
        str(m.get("instance", "")).lower() == str(target.get("name", "")).lower() for m in after
    )
    if not landed:
        ledgerlib.verify(
            "migrate", session_id, False,
            note=f"dossier does not show '{chat_title}' in {target.get('name')} after import",
        )
        raise _MigrateRefusal(
            {
                "landed": False,
                "daemon": result,
                "report": (
                    f"import posted ok but the dossier does not show '{chat_title}' in "
                    f"{target.get('name')} yet - NOT claiming success. Attempt recorded."
                ),
            },
            1,
        )
    ledgerlib.verify("migrate", session_id, True)
    return after


def _settle_source_row(match: dict, target: dict, fleet: dict, session_id: str, chat_title) -> str:
    """Settle the superseded SOURCE row (_settle_source docstring): only when the chat came
    from a desktop instance whose app is RUNNING - a closed app's disk flag is durable on its
    own. Best-effort and loud: a failed settle leaves a stale twin, and the report says
    exactly that. Returns the settle_note suffix for the final report ("" when there is
    nothing to settle)."""
    src_name = str(match.get("instance") or "")
    if not src_name or src_name.lower() == str(target.get("name", "")).lower():
        return ""
    src_inst = resolve_instance(fleet, src_name)
    if not (src_inst and src_inst.get("isRunning")):
        return ""
    code_s, out_s = _settle_source(src_name, str(chat_title))
    # DOUBLE-CHECK, NEVER ASSUME (owner, 2026-09-01: "it can't do it blind; it must always
    # double check, confirm"). Exit 3 used to be read as "already settled"; a row the app
    # virtualized off-screen is not rendered AND still visible when scrolled. So the source
    # meta is re-read from disk after the settle, and only an archived flag that STAYS
    # archived counts - otherwise the twin is named, the attempt annotated, and the twins
    # lane keeps settling it every pass.
    if code_s in (0, 3):
        time.sleep(2)
        still = _source_still_visible(session_id, src_name)
        if still:
            ledgerlib.annotate("migrate", session_id,
                               f"landed in {target.get('name')} but the source row in "
                               f"{src_name} is still visible (settle exit {code_s})")
            return (f" ⚠ Source row in {src_name} is STILL VISIBLE after the settle "
                    f"(actuator exit {code_s}) - a twin is on screen; the twins lane "
                    "will keep settling it. Not claiming a clean move.")
        return " Source row settled through its app's own control (verified on disk)."
    # ⛔ NEVER LEAVE THE SOURCE VISIBLE (owner, 2026-09-01: "there are a few duplicate chats
    # happening"). The app's own control is the immediate and durable route, but it can fail
    # - an ambiguous title, a row not rendered - and every one of those failures left a twin
    # on screen until a later sweep caught it. The disk flag is weaker under a running app,
    # and weaker beats nothing.
    fallback = _archive_source_on_disk(session_id, src_name)
    return (
        f" Source row could not be settled through the app ({code_s}); its archive "
        "flag was written on disk instead - it clears at that app's next restart."
        if fallback else
        f" Source row NOT settled (actuator said: "
        f"{(out_s.splitlines()[-1][:100] if out_s else code_s)}) - a stale twin "
        f"may linger in {src_name}; archive it there."
    )


def _stamp_automation_doctrine(session_id: str, target: dict, after: list[dict]) -> tuple[bool, str, bool, str]:
    """The automation doctrine (module docstring): stamp bypassPermissions on every verified
    landing, and ultracode, mechanically, into the landed chat's meta record (stamplib
    docstring). Returns (stamped, stamp_note, ultracode_ok, ultracode_note)."""
    try:
        stamp = hydralib.api_post(f"/api/sessions/{session_id}/automation", {})
        stamped = bool(isinstance(stamp, dict) and stamp.get("ok"))
        stamp_note = (
            "automation stamped bypassPermissions"
            if stamped
            else "automation stamp did NOT take (daemon says ok=false) - re-stamp before it boots"
        )
    except hydralib.DaemonError as err:
        stamped = False
        stamp_note = f"automation stamp failed ({err}) - stamp bypassPermissions before it boots"

    landed_match = next(
        (m for m in after
         if str(m.get("instance", "")).lower() == str(target.get("name", "")).lower()),
        {},
    )
    meta_path = landed_match.get("metaPath")
    if meta_path:
        # ⛔ BOTH STAMPS ON DISK, AND STAMPED TWICE (owner, 2026-09-01: "I am getting sick of
        # having to change things from manual edits to bypass permissions"). Three chats
        # moved minutes earlier were sitting on acceptEdits: the daemon's /automation
        # endpoint is the only thing that had been setting the permission half, and the app
        # writes the landed chat's record on its own schedule - so our single stamp raced it
        # and lost. Writing both halves ourselves, then again after the app has settled, is
        # what makes it stick.
        got = stamplib.stamp_doctrine(meta_path)
        if not (got["bypass"] and got["ultracode"]):
            time.sleep(4)
            got = stamplib.stamp_doctrine(meta_path)
        if got["bypass"] and got["ultracode"]:
            uc_note = "bypassPermissions + ultracode stamped into the landed record"
        else:
            uc_note = (f"doctrine stamp INCOMPLETE (bypass={got['bypass']}, "
                       f"ultracode={got['ultracode']}, {got['error']}) - run automation_chat.py")
        uc_ok = bool(got["bypass"] and got["ultracode"])
        stamped = stamped or got["bypass"]
    else:
        uc_ok = False
        uc_note = "not stamped - the dossier gave no metaPath; run automation_chat.py on it"
    return stamped, stamp_note, uc_ok, uc_note


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    parsed = _parse_migrate_argv(argv)
    if isinstance(parsed, int):
        return parsed
    as_json, force, stop_idle = parsed.as_json, parsed.force, parsed.stop_idle
    to, title, idle_wait, query = parsed.to, parsed.title, parsed.idle_wait, parsed.query

    try:
        match, fleet = _resolve_chat_or_raise(query)
        session_id = match.get("cliSessionId") or ""
        chat_title = match.get("title")
        door_title = _untruncated_title(session_id, chat_title)

        target = _resolve_target_or_raise(fleet, to, match, session_id, chat_title)
        _check_hold_or_raise(session_id, force)
        match = _settle_live_writer_or_raise(match, query, chat_title, session_id, stop_idle, idle_wait, force)
        _check_breaker_or_raise(session_id, force)

        body = _build_import_body(target, title, door_title, force)
        _pretrust_workspace(session_id)

        ledgerlib.note("migrate", session_id, note=f"'{chat_title}' -> {target.get('name')}")
        result = _post_import_or_raise(session_id, target, body)
        after = _verify_landing_or_raise(session_id, target, chat_title, result)
    except _MigrateRefusal as refusal:
        return out(refusal.payload, as_json, refusal.code)

    # (The 'migrate' attempt is cleared below, AFTER the settle - a landing whose source row
    # is still visible is not a clean move, and its annotation must have a row to land on.)
    settle_note = _settle_source_row(match, target, fleet, session_id, chat_title)
    if "STILL VISIBLE" not in settle_note:
        ledgerlib.clear("migrate", session_id)  # a clean move: the brake is for futility

    stamped, stamp_note, uc_ok, uc_note = _stamp_automation_doctrine(session_id, target, after)

    return out(
        {
            "landed": True,
            "bypassStamped": stamped,
            "ultracodeStamped": uc_ok,
            "sourceSettled": bool(settle_note.startswith(" Source row settled")),
            "daemon": result,
            "report": (
                f"landed and VERIFIED: '{chat_title}' now lives in {target.get('name')}. "
                f"{stamp_note}; {uc_note}.{settle_note}"
            ),
        },
        as_json,
        0,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
