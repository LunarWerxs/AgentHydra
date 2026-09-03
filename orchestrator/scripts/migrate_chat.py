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
       [--title "New title"] [--force] [--stop-idle] [--json]
  --stop-idle   a chat whose engine is alive but IDLE (finished its turn, quiet 5+ min) is
                stopped deliberately first, and confirmed gone, then moved - the desktop
                never stops an engine on its own, so without this no desktop chat could ever
                move (owner: "only chats that are stopped, waiting, chilling"). A working or
                stuck engine still refuses. The sweep's move and land lanes pass it.
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
import subprocess
import time
import sys
from pathlib import Path as _Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib


ELIDED = ("…", "...")


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
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_ACTUATOR),
         "-Instance", instance, "-Action", "Archive", "-Title", title],
        capture_output=True, text=True, timeout=240,
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


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    force = "--force" in argv
    stop_idle = "--stop-idle" in argv
    to = title = None
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
        if not a.startswith("--"):
            args.append(a)
        i += 1
    if len(args) != 1 or not to:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    try:
        match = resolve_for_migrate(args[0])
        fleet = hydralib.fleet()
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        return out({"landed": False, "report": f"REFUSED (deterministic): {err}"}, as_json, 3)
    except hydralib.DaemonError as err:
        return out({"landed": False, "report": f"migrate FAILED: {err}"}, as_json, 1)

    session_id = match.get("cliSessionId") or ""
    chat_title = match.get("title")
    door_title = _untruncated_title(session_id, chat_title)

    target = resolve_instance(fleet, to)
    if target is None:
        known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
        ledgerlib.note("migrate", session_id, deterministic=True, note=f"no instance matches {to!r}")
        return out(
            {
                "landed": False,
                "report": f"REFUSED (deterministic): no instance matches {to!r}. Known: {known}",
            },
            as_json,
            3,
        )
    if str(match.get("instance", "")).lower() == str(target.get("name", "")).lower():
        return out(
            {"landed": False, "report": f"nothing to do: '{chat_title}' already lives in {target.get('name')}"},
            as_json,
            0,
        )

    # A HOLD is a person's word: the unattended machinery leaves held chats alone (--force
    # is that person speaking again).
    hold_why = holdlib.why_blocked(session_id)
    if hold_why and not force:
        return out({"landed": False, "held": True, "report": f"REFUSED: {hold_why}"}, as_json, 6)

    # Rule 2, absolute: the import rewrites the transcript, and the daemon itself refuses a
    # live session - refusing here first keeps the reason honest and the attempt un-spent.
    #
    # --stop-idle (live smoke, 2026-09-01): the desktop keeps an engine alive indefinitely
    # after the turn ends, so without this every desktop chat had a "live writer" forever
    # and nothing could ever move. The owner's line is "only chats that are stopped,
    # waiting, chilling": lib/enginelib stops an engine that finished its turn and has been
    # quiet for minutes - never one mid-turn or stuck - and confirms it is gone before we go
    # on. The sweep's move and land lanes pass it; a hand run may too.
    if match.get("live") and stop_idle:
        from lib import enginelib

        stopped = enginelib.stop_idle_engine(match)
        if stopped.get("stopped"):
            ledgerlib.annotate("migrate", session_id,
                               f"stopped idle engine pid {stopped.get('pid')} ({stopped.get('why')})")
            try:
                match = resolve_for_migrate(args[0])
            except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError) as err:
                return out({"landed": False, "report": f"migrate FAILED after stopping the idle engine: {err}"},
                           as_json, 1)
        else:
            return out(
                {"landed": False,
                 "report": f"REFUSED: '{chat_title}' has a live engine and it is not safely idle - "
                           f"{stopped.get('why')}. Not moving."},
                as_json, 4,
            )
    if match.get("live"):
        pid = match["live"].get("pid")
        return out(
            {
                "landed": False,
                "report": (
                    f"REFUSED: '{chat_title}' has a LIVE writer (pid {pid}) and importing "
                    "rewrites the transcript. Not even --force. Let it finish or stop it "
                    "deliberately first."
                ),
            },
            as_json,
            4,
        )

    brake = ledgerlib.check("migrate", session_id)
    if brake["suppressed"] and not force:
        return out(
            {"landed": False, "breaker": brake, "report": f"SUPPRESSED by the breaker: {brake['why']}"},
            as_json,
            5,
        )

    body: dict = {"instance_ref": target.get("ref") or f"desktop:{target.get('dir')}"}
    if title:
        body["title"] = title
    else:
        # THE NAMING DOOR (daemon rule): every import must carry a real title, or restate the
        # current one exactly as proof of a programmatic review. We just read it from the
        # dossier - that IS the review - so restate it. Without this the daemon 400s every
        # bare invocation, and v2's shape would have retried that forever.
        #
        # RESTATE THE SESSION'S TITLE, NOT THE ON-SCREEN ONE, when they differ: the desktop
        # record elides a long title with an ellipsis and the daemon compares against the
        # untruncated one, so a bare move of any long-titled chat was a deterministic 400
        # that only --title could clear (hit live 2026-09-03, moving the Agos chats).
        # chat_title itself stays as-is - the settle actuator matches the ROW ON SCREEN.
        body["confirm_title"] = door_title
    if force:
        body["force"] = True

    # TRUST THE WORKSPACE FIRST (owner, 2026-09-01): a chat whose cwd the app does not trust
    # stops on a human dialog no rail can answer - so the landing pre-writes the trust flag
    # for its own working folder. Best-effort and silent-on-success: the trust list is shared
    # by every instance, so one write covers wherever this chat ends up.
    try:
        import trust_workspace

        row = hydralib.session_row(session_id) or {}
        if row.get("cwd"):
            trust_workspace.apply_trust([str(row["cwd"])], act=True)
    except Exception:  # trust is a convenience rail; never let it block a landing
        pass

    ledgerlib.note("migrate", session_id, note=f"'{chat_title}' -> {target.get('name')}")
    try:
        from lib import windowlib

        # The landing drives the TARGET app (the daemon fires its resume deeplink at it, which
        # foregrounds and can re-show the window): put it back if that moved it.
        with windowlib.keep_placement(target.get("dir") or target.get("name")):
            result = hydralib.api_post(f"/api/sessions/{session_id}/import-desktop", body)
    except hydralib.DaemonError as err:
        if err.status == 409:
            ledgerlib.note("migrate", session_id, deterministic=True, note="superseded lineage")
            return out(
                {
                    "landed": False,
                    "report": (
                        f"REFUSED (deterministic): the daemon says this lineage is SUPERSEDED "
                        f"({err.detail[:200]}). It was retired on purpose; only a person's "
                        "--force re-lands it."
                    ),
                },
                as_json,
                3,
            )
        if err.status == 400:
            # A 400 is the daemon rejecting these exact inputs (bad instance_ref, title door):
            # the same call will 400 again, so retrying it is v2's futile loop. Stop after one.
            ledgerlib.note("migrate", session_id, deterministic=True, note=f"400: {err.detail[:150]}")
            return out(
                {
                    "landed": False,
                    "report": (
                        f"REFUSED (deterministic): the daemon rejected the request "
                        f"({err.detail[:200]}). Same inputs will be rejected again - fix the "
                        "inputs (e.g. pass --title) rather than retrying."
                    ),
                },
                as_json,
                3,
            )
        if err.status == 422 and "live" in err.detail.lower():
            # The daemon refused a LIVE session - transient, not deterministic: the same call
            # is fine once the session's writer finishes. Attempt stays counted; the breaker
            # bounds a hot retry loop.
            return out(
                {
                    "landed": False,
                    "report": (
                        f"REFUSED by the daemon: the session is LIVE and the import rewrites "
                        f"the transcript ({err.detail[:150]}). Retry after it finishes its turn."
                    ),
                },
                as_json,
                4,
            )
        return out(
            {"landed": False, "report": f"migrate FAILED: {err} (attempt recorded)"}, as_json, 1
        )

    if not (isinstance(result, dict) and result.get("ok", True)):
        return out(
            {
                "landed": False,
                "daemon": result,
                "report": f"migrate did NOT land: daemon says ok=false. Attempt recorded.",
            },
            as_json,
            1,
        )

    # Verify the landing: the dossier must now place the chat in the target instance.
    try:
        after = hydralib.dossier(session_id)
    except hydralib.DaemonError as err:
        return out(
            {
                "landed": None,
                "daemon": result,
                "report": f"import posted ok but VERIFY FAILED ({err}) - not claiming success.",
            },
            as_json,
            1,
        )
    landed = any(
        str(m.get("instance", "")).lower() == str(target.get("name", "")).lower() for m in after
    )
    if not landed:
        return out(
            {
                "landed": False,
                "daemon": result,
                "report": (
                    f"import posted ok but the dossier does not show '{chat_title}' in "
                    f"{target.get('name')} yet - NOT claiming success. Attempt recorded."
                ),
            },
            as_json,
            1,
        )

    # (The 'migrate' attempt is cleared below, AFTER the settle - a landing whose source row
    # is still visible is not a clean move, and its annotation must have a row to land on.)

    # Settle the superseded SOURCE row (_settle_source docstring): only when the chat came
    # from a desktop instance whose app is RUNNING - a closed app's disk flag is durable on
    # its own. Best-effort and loud: a failed settle leaves a stale twin, and the report
    # says exactly that.
    src_name = str(match.get("instance") or "")
    settle_note = ""
    if src_name and src_name.lower() != str(target.get("name", "")).lower():
        src_inst = resolve_instance(fleet, src_name)
        if src_inst and src_inst.get("isRunning"):
            code_s, out_s = _settle_source(src_name, str(chat_title))
            # DOUBLE-CHECK, NEVER ASSUME (owner, 2026-09-01: "it can't do it blind; it must
            # always double check, confirm"). Exit 3 used to be read as "already settled";
            # a row the app virtualized off-screen is not rendered AND still visible when
            # scrolled. So the source meta is re-read from disk after the settle, and only an
            # archived flag that STAYS archived counts - otherwise the twin is named, the
            # attempt annotated, and the twins lane keeps settling it every pass.
            if code_s in (0, 3):
                time.sleep(2)
                still = _source_still_visible(session_id, src_name)
                if still:
                    ledgerlib.annotate("migrate", session_id,
                                       f"landed in {target.get('name')} but the source row in "
                                       f"{src_name} is still visible (settle exit {code_s})")
                    settle_note = (f" ⚠ Source row in {src_name} is STILL VISIBLE after the settle "
                                   f"(actuator exit {code_s}) - a twin is on screen; the twins lane "
                                   "will keep settling it. Not claiming a clean move.")
                else:
                    settle_note = " Source row settled through its app's own control (verified on disk)."
            else:
                # ⛔ NEVER LEAVE THE SOURCE VISIBLE (owner, 2026-09-01: "there are a few
                # duplicate chats happening"). The app's own control is the immediate and
                # durable route, but it can fail - an ambiguous title, a row not rendered - and
                # every one of those failures left a twin on screen until a later sweep caught
                # it. The disk flag is weaker under a running app, and weaker beats nothing.
                fallback = _archive_source_on_disk(session_id, src_name)
                settle_note = (
                    f" Source row could not be settled through the app ({code_s}); its archive "
                    "flag was written on disk instead - it clears at that app's next restart."
                    if fallback else
                    f" Source row NOT settled (actuator said: "
                    f"{(out_s.splitlines()[-1][:100] if out_s else code_s)}) - a stale twin "
                    f"may linger in {src_name}; archive it there."
                )

    if "STILL VISIBLE" not in settle_note:
        ledgerlib.clear("migrate", session_id)  # a clean move: the brake is for futility

    # The automation doctrine (docstring): stamp bypassPermissions on every verified landing.
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

    # ...and ultracode, mechanically, into the landed chat's meta record (stamplib docstring).
    landed_match = next(
        (m for m in after
         if str(m.get("instance", "")).lower() == str(target.get("name", "")).lower()),
        {},
    )
    meta_path = landed_match.get("metaPath")
    if meta_path:
        # ⛔ BOTH STAMPS ON DISK, AND STAMPED TWICE (owner, 2026-09-01: "I am getting sick of
        # having to change things from manual edits to bypass permissions"). Three chats moved
        # minutes earlier were sitting on acceptEdits: the daemon's /automation endpoint is the
        # only thing that had been setting the permission half, and the app writes the landed
        # chat's record on its own schedule - so our single stamp raced it and lost. Writing
        # both halves ourselves, then again after the app has settled, is what makes it stick.
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
