"""act - move MANY chats between accounts in ONE run, sequentially, sharing every read.

WHY THIS EXISTS (owner, 2026-09-05, angry, twice): moving 13 chats took ~15 minutes and he
had to watch it. His words: "this shouldn't be a serialized thing" and "this needs to happen
in like... 10 seconds". Doing it by hand meant 13 separate move_chat calls, and that shape is
pathological three times over:

  1. THE DAEMON REFUSES CONCURRENCY ANYWAY. server/src/orchestrator.ts keys its in-flight map
     by SCRIPT NAME, so every migrate_chat run in the fleet collides on one key. Firing the
     calls in parallel does not overlap them - it returns `409 busy` for all but one and
     times sockets out on the rest. Measured live: a 6-wide parallel burst produced one
     success, one 409, and four refusals.
  2. EVERY RUN RE-PAID THE FLEET READS. Each spawn is a cold interpreter that re-reads the
     fleet, re-scans ~500 sessions on a fuzzy title, and can re-run an ~80s usage survey.
     N chats paid that N times for an answer that does not change between them.
  3. THE WAITS DID NOT OVERLAP. Per chat: 8s of bypass watch, up to 4s of re-stamp, ~3s of
     settle confirmation. None of it is work; all of it was serial.

WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO
Runs migrate_chat's OWN pipeline inside a single interpreter, BY PHASE rather than by chat
(owner, 2026-09-06: "Move the chat, then you archive, then you set the permission. Move them
all, archive them all, then set all the permissions. That would make the most sense"):

  PHASE 1  migrate_chat.move_only  - resolve, gate, import, verify. Every chat.
  PHASE 2  migrate_chat.phase_settle - settle the source row. Every chat.
  PHASE 3  ONE shared bypass watch, then phase_stamp - doctrine + verdict. Every chat.

The gates did not move and did not weaken. All of them - hold, breaker, archived,
live-writer, the quiet window - live in phase one, BEFORE the import, which is exactly why
phases two and three are safe to defer: nothing they do can decide whether a move was
allowed. Every chat is still RE-RESOLVED immediately before its own gates, never from a row
read at batch start; liveness read 90 seconds ago is not liveness, and a stale `match`
carries a pid the OS may have recycled.

What is actually saved is the waste, not the safety:
  - ONE route-lock acquisition instead of N, so nothing 409s and nothing races.
  - ONE interpreter and one warm module import instead of N cold starts.
  - The fleet, session and usage-survey caches stay warm across the whole batch, so chats
    2..N resolve off reads chat 1 already paid for.
  - ONE 8-SECOND BYPASS WATCH FOR THE WHOLE BATCH instead of one per chat. That watch is a
    once-a-second re-read of a landed record, and N of them overlap perfectly; run per chat
    they were 40 of the 189 seconds a 5-chat batch took, and they grew with the batch.
  - The chats are usable sooner: phase one ends with every chat verified in its new account,
    and what follows is tidying a move that has already happened.

⛔ THE PHASES OVERLAP THE WAITING, NEVER THE DRIVING. The source settle and the permission
picker each drive a real application window under its own instance lock, one at a time, in
phase order. Two of those at once is two scripts fighting over one sidebar.

⛔ IMPORTS ARE NOT PARALLELISED AND MUST NOT BE. /api/sessions/:id/import-desktop does not
take the daemon's act lock, the resume deeplink drives Electron's single-instance channel,
and two concurrent imports into one store can create a duplicate row that makes the chat
permanently unreachable. The per-chat import stays one at a time. This script is faster
because it stops repeating itself, NOT because it does several things at once.

⛔ A REFUSAL IS NOT A FAILURE OF THE BATCH. A chat with a live engine is skipped, reported by
name with its reason, and the batch moves on. The exit code reflects whether anything landed
and whether anything refused - it never hides a refusal behind a batch-level success.

Usage:
  python migrate_batch.py --to here --chat "first title" --chat "second title" [--json]
  python migrate_batch.py --to 8 --from 11 --all-unarchived     # every movable chat
  python migrate_batch.py --to here --chat "..." --dry-run      # plan only, moves none
  python orch.py migrate_batch --to here --all-unarchived       # the same, via the driver

  python migrate_batch.py --to here --from 15 --all-unarchived --terminate-live \
      --resume "MIGRATION NOTICE: you were moved to a fresh account; carry on."

  python migrate_batch.py --to here --chat "7e1fa278" --chat-title "Logos for Connections products"

Flags other than --chat/--all-unarchived are passed through to every chat's own move, so
--now, --force, --archived, --title, --idle-wait and --stop-idle mean exactly what they mean
for a single move. --title is refused for a multi-chat batch: one new name cannot be right
for several different chats. --chat-title is the per-chat door that --title cannot be: it
binds to the --chat named right before it and names THAT chat's real title, which the naming
door always accepts outright - useful when the daemon's session title and the desktop
record's title disagree (2026-09-15) and neither restated alone is guaranteed to clear the
door's confirm_title check.

⛔ ARCHIVED CHATS ARE GATED HERE AS WELL AS PER CHAT (_archive_gate, added 2026-09-13 after an
agent set --archived for itself and queued an account's 22 archived chats behind its 3 live
ones). --archived on a BATCH is not enough on its own: the batch must also state
--archived-count N, N must EQUAL the number of archived chats it actually holds, and archived
chats must be the WHOLE batch - never mixed in with unarchived ones. Any of the three failing
refuses the batch whole, with the owner directive quoted. Stating the count is the point: it
cannot be set reflexively, and the number reaches the human before anything moves.

TWO FLAGS ARE THE BATCH'S OWN, added 2026-09-06 after draining two accounts (Carlos at 95%
of its window, Martin at 88% of its week) took ~25 round trips by hand:

  --terminate-live   A PERSON'S WORD. A chat refused for a live engine - working, or quiet
                     but not yet past its window - has that engine KILLED (the whole process
                     tree, enginelib.terminate_engine) and is then moved. The transcript
                     survives; a tool result still in flight is lost, so say so in --resume.
                     --force never implies this: --force overrides a hold, nothing more.
  --resume [TEXT]    PHASE FOUR. After every landed chat is moved, settled and stamped, TEXT
                     is staged as a reply to each one (stage_reply's own evidence rule) and
                     delivered through the courier's named-delivery path - by hand, so no
                     tray icon and no fair-share cap. That is what makes a migrated chat
                     CONTINUE WORKING instead of sitting dormant in its new account. A chat
                     whose engine booted on landing and is mid-turn keeps the reply STAGED;
                     its result names the exact retry. Read each result's `resume`. TEXT is
                     optional - a bare --resume stages _DEFAULT_RESUME_TEXT, which tells the
                     chat to read journal.jsonl in its own transcript directory and resume with
                     Workflow({ scriptPath, resumeFromRunId }), so a person moving a chat off
                     an account that just hit its usage wall does not have to remember the words.

Exit: 0 every named chat landed (or, under --dry-run, every plan resolved) - 2 the flags do
  not make sense - 4 nothing landed - 5 a PARTIAL batch: some landed, some were refused.
  5 is deliberately its own code. A batch that mostly worked must never return the same
  answer as one that entirely worked, because the refusals are the reason to look.
"""

from __future__ import annotations

import json
import sys
import threading
import time

import migrate_chat
import stage_reply
from lib import archivewatchlib
from lib import clilib, deliverylib, enginelib, hydralib, ledgerlib


#: Flags this driver consumes itself; everything else is forwarded to each chat's own move.
_BATCH_ONLY = {"--chat", "--chat-title", "--all-unarchived", "--json", "--limit", "--resume",
               "--terminate-live", "--archived-count"}

#: The DEFAULT `--resume` text when the flag is given with no TEXT of its own (2026-09-15,
#: closing the filed defect docs/todo/improvements/tooling/workflow-runs-die-on-account-limits-
#: and-leave-half-written-files.md item 3, Connections repo). "Already done by hand overnight -
#: every resume message carried this - it should be the default text migrate_batch --resume
#: stages, so a person does not have to remember it." A Workflow fan-out killed mid-run by its
#: account's usage wall journals every completed agent; the resumed chat's whole job is to read
#: that journal and hand the SAME script back to the engine by run id, never re-author the work.
_DEFAULT_RESUME_TEXT = (
    "MIGRATION NOTICE: you were moved to a fresh account mid-run. Read journal.jsonl in this "
    "run's own transcript directory to see which agents already completed, then resume the "
    "workflow with Workflow({ scriptPath, resumeFromRunId }) - completed agents replay from the "
    "journal at zero cost; only the first edited/unstarted agent and everything after it runs "
    "live."
)

#: The law this batch enforces, quoted at the caller in every refusal so the reason arrives
#: WITH the refusal rather than in a doc nobody opens at that moment.
_ARCHIVE_LAW = (
    "owner directive (Michael, 2026-09-05, restated ANGRILY 2026-09-13): only move UNARCHIVED "
    "chats. An archived chat moves ONLY when the human explicitly asked for that chat - never "
    "because an agent set a flag for itself while sweeping an account."
)

#: Exit codes. 0 every chat landed - 4 nothing landed - 5 a partial batch (some landed, some
#: refused). A partial batch gets its OWN code because "mostly worked" must never read to a
#: caller as "worked": the refusals are the whole point of looking.
EXIT_OK, EXIT_NONE, EXIT_PARTIAL = 0, 4, 5
#: A --from nobody has is a DETERMINISTIC refusal, code 3, exactly as migrate_chat
#: answers the same mistake. It must never collapse into EXIT_NONE: "nothing to move"
#: and "that account does not exist" are different facts and only one is safe to trust.
EXIT_REFUSED = 3

#: ⛔ EVERY POST-LANDING PHASE IS BOUNDED, SO A STUCK ONE STILL YIELDS A VERDICT (found
#: 2026-09-13: a ONE-chat batch ran 15+ minutes past its documented 15-25s and returned no
#: report at all - the MCP call died on a bare transport timeout with no operationId, no
#: per-chat result, no `resume.delivered`). Every sub-call already carries its OWN timeout
#: (the picker's actuator: 180s: the source-settle actuator: 240s: the courier's send: 300s)
#: but nothing capped what a WHOLE PHASE could cost across N chats, so worst-case sub-timeouts
#: chained instead of being bounded as a group - and if any single one of them ever fails to
#: fire (a hung window, a zombie process a kill signal missed), there was NOTHING behind it.
#: Each ceiling below is generous per chat - well above the documented per-chat budget, so a
#: healthy batch never trips it - and scales WITH the batch, never a fixed ceiling that starves
#: a big batch of the same wall-clock room a one-chat move gets. Tripping one no longer holds
#: the run: `_run_bounded` gives up WAITING (Python cannot safely kill a thread mid syscall)
#: and the phase's own marker function names exactly which chat, and which phase, did not
#: finish - never a silent hang, never a report lost to the caller's transport.
# The naming pass takes the instance lock with wait_secs=0, so a sibling lane driving the same
# app loses it outright. Retrying costs seconds; not retrying costs the chat its name, and a
# nameless chat cannot be aimed at by anything downstream.
NAMING_ATTEMPTS = 3
NAMING_RETRY_WAIT_SECS = 4.0

SETTLE_PHASE_TIMEOUT_SECS = 90.0
STAMP_PHASE_TIMEOUT_SECS = 240.0
RESUME_PHASE_TIMEOUT_SECS = 300.0


def _run_bounded(phase_name: str, timeout_secs: float, fn) -> bool:
    """Run `fn()` - one phase's own blocking work, across every chat in it - on a worker
    thread, and stop WAITING on it after `timeout_secs`. Returns True if `fn` finished inside
    the budget.

    ⛔ THIS IS A DEADLINE ON WAITING, NEVER A KILL. Python has no safe way to terminate a
    thread mid UI-automation or mid subprocess wait, so a phase that blows its budget is
    ABANDONED, not stopped - the caller (each phase's own `_mark_*_timeout`) reads whatever
    state the abandoned thread had already written and names anything still missing a verdict
    as timed-out, then the batch moves on to build its report. The worker is a daemon thread:
    it dies with the process rather than outliving this script or leaking into the next run.
    """
    done = threading.Event()
    failure: list[BaseException] = []

    def _worker() -> None:
        try:
            fn()
        except BaseException as err:  # noqa: BLE001 - re-raised below, never swallowed
            failure.append(err)
        finally:
            done.set()

    threading.Thread(target=_worker, name=f"migrate_batch-{phase_name}", daemon=True).start()
    if not done.wait(timeout_secs):
        return False
    if failure:
        raise failure[0]
    return True


class _UnknownSource(Exception):
    """--from named no instance in the fleet."""


class _BatchArgs:
    __slots__ = ("chats", "chat_titles", "passthrough", "as_json", "all_unarchived", "source",
                 "limit", "dry_run", "resume_text", "terminate_live", "archived_count")

    def __init__(self) -> None:
        self.chats: list[str] = []
        # Parallel to `chats`, same length and order (2026-09-15, TODO item 1): the per-chat
        # `--title` a caller names alongside a `--chat`, or None. `--title` on the batch itself
        # is refused for more than one chat (one new name cannot be right for several chats,
        # below) - this is the door MCP callers had no way through: `move_chats` could not name
        # a chat's own real title, so the naming door's confirm_title check (restating the
        # CURRENT title exactly) was the only path in, and a caller who could not read the
        # daemon's own title for that chat had no way past a mismatch between it and the
        # dossier's. A per-chat --title sidesteps confirm_title entirely: it is a real new name,
        # which the naming door always accepts outright (chat-title.ts's `title` door).
        self.chat_titles: list[str | None] = []
        self.passthrough: list[str] = []
        self.as_json = False
        self.all_unarchived = False
        self.source: str | None = None
        self.limit = 0
        self.dry_run = False
        # The batch's own two (docstring): neither reaches a per-chat move's argv.
        self.resume_text = ""
        self.terminate_live = False
        # -1 = never stated. 0 is a REAL value ("I know this batch holds no archived chat"),
        # so it must not collapse into "not given" - hence -1 rather than 0 as the sentinel.
        self.archived_count = -1


def _parse(argv: list[str]) -> _BatchArgs | int:
    """Same hand-rolled convention as migrate_chat: unknown flags are forwarded, not fatal."""
    a = _BatchArgs()
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "--chat" and i + 1 < len(argv):
            a.chats.append(argv[i + 1])
            a.chat_titles.append(None)
            i += 2
            continue
        if tok == "--chat-title" and i + 1 < len(argv):
            # Binds to the MOST RECENTLY named --chat, same convention as pairing a value with
            # the flag right before it (--chat "query" --chat-title "real name"). A --chat-title
            # with no --chat before it names nothing, so it is a usage error, not a silent no-op.
            if not a.chat_titles:
                print("--chat-title must come right after the --chat it names",
                      file=sys.stderr)
                return 2
            a.chat_titles[-1] = argv[i + 1]
            i += 2
            continue
        if tok == "--resume":
            # TEXT is optional (2026-09-15): a bare --resume, or one immediately followed by
            # another flag, stages _DEFAULT_RESUME_TEXT rather than doing nothing - the prior
            # shape silently swallowed a trailing bare --resume (it is in _BATCH_ONLY, so it
            # never even reached the passthrough) and would misread the NEXT flag as the text.
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                a.resume_text = argv[i + 1]
                i += 2
            else:
                a.resume_text = _DEFAULT_RESUME_TEXT
                i += 1
            continue
        if tok == "--terminate-live":
            a.terminate_live = True
            i += 1
            continue
        if tok == "--limit" and i + 1 < len(argv):
            try:
                a.limit = max(0, int(argv[i + 1]))
            except ValueError:
                print(f"--limit wants a number, got {argv[i + 1]!r}", file=sys.stderr)
                return 2
            i += 2
            continue
        if tok == "--archived-count" and i + 1 < len(argv):
            try:
                a.archived_count = max(0, int(argv[i + 1]))
            except ValueError:
                print(f"--archived-count wants a number, got {argv[i + 1]!r}", file=sys.stderr)
                return 2
            i += 2
            continue
        if tok == "--all-unarchived":
            a.all_unarchived = True
            i += 1
            continue
        if tok == "--json":
            a.as_json = True
            i += 1
            continue
        if tok == "--dry-run":
            a.dry_run = True
            a.passthrough.append(tok)
            i += 1
            continue
        if tok == "--from" and i + 1 < len(argv):
            a.source = argv[i + 1]
            a.passthrough += [tok, argv[i + 1]]
            i += 2
            continue
        if tok not in _BATCH_ONLY:
            a.passthrough.append(tok)
        i += 1
    return a


def _archived_named(queries: list[str]) -> list[str] | None:
    """Which of these queries name an ARCHIVED chat? None = the fleet could not be read.

    PRECISE, not merely conservative - the first cut of this was "any substring hit on an
    archived row counts", and a query as ordinary as "one" then matched a dozen real titles and
    refused batches that named nothing archived at all. An over-eager gate is not a safe gate:
    it gets switched off. So a query counts as archived only when it is UNAMBIGUOUSLY archived:

      * it is an exact session id (or exact title) of an archived chat - the shape every
        enumeration and every bulk caller uses, and the shape the 2026-09-13 incident had; or
      * it is a fragment that matches archived chats and NO unarchived one, so there is nothing
        else it could have meant.

    A fragment that matches both is left to migrate_chat's own per-chat --archived refusal,
    which resolves the one chat it really picked and gates THAT. Two gates, each precise about
    what it can actually see, rather than one that guesses.

    Reads hydralib.chats, the same per-store scan _movable_chats reads: this file asks "what is
    on these accounts" exactly once, in one voice. The collapsed session view would answer for
    a half-moved chat with ONE of its two copies, and this gate's whole job is to notice the
    archived one.
    """
    try:
        rows = hydralib.chats()
    except Exception:  # noqa: BLE001 - any read failure means "cannot tell", handled by the gate
        return None
    named: list[str] = []
    for q in queries:
        ql = str(q).strip().lower()
        if not ql:
            continue
        exact = fuzzy_archived = fuzzy_unarchived = False
        for r in rows:
            sid = str(r.get("sessionId") or r.get("session_id") or "").lower()
            title = str(r.get("title") or "").lower()
            is_arch = bool(r.get("archived"))
            if ql == sid or (title and ql == title):
                if is_arch:
                    exact = True
                else:
                    # An exact hit on a LIVE row settles it: this is not the archive's copy.
                    exact = False
                    fuzzy_archived = False
                    break
            elif title and ql in title:
                if is_arch:
                    fuzzy_archived = True
                else:
                    fuzzy_unarchived = True
        if exact or (fuzzy_archived and not fuzzy_unarchived):
            named.append(q)
    return named


def _archive_gate(parsed: "_BatchArgs") -> tuple[int, str] | None:
    """The stopgap. Returns (exit_code, report) to REFUSE the whole batch, or None to proceed.

    Why this exists on top of migrate_chat's own per-chat `--archived` refusal: that gate asks
    "was the flag set?", and on 2026-09-13 an agent asked to migrate an account set the flag
    for itself and queued all 22 of its archived chats behind 3 unarchived ones. A lone boolean
    cannot tell a human's instruction from an agent's own initiative. A COUNT can: stating it
    requires having enumerated the archive first, and the number lands in the transcript where
    the human sees "22 archived" BEFORE anything moves.

    Three keys, all required, and the batch is refused whole rather than in part - a partial
    archive move is the outcome that then needs undoing by hand.
    """
    named = _archived_named(parsed.chats)
    if named is None:
        # Could not read the fleet. Only fatal when archived chats were being asked for at all;
        # otherwise the ordinary unarchived path is unaffected and must not be held hostage.
        if "--archived" in parsed.passthrough:
            return EXIT_REFUSED, ("REFUSED: could not read the fleet to check which of these "
                                  f"chats are archived, and --archived was passed. {_ARCHIVE_LAW}")
        return None
    if not named:
        # Nothing archived here, so --archived is inert. STRIP it rather than forwarding a live
        # override into per-chat moves that never needed it: a flag that reaches a gate it did
        # not have to is the shape that eventually opens one.
        parsed.passthrough = [t for t in parsed.passthrough if t != "--archived"]
        return None

    shown = ", ".join(named[:5]) + (f" (+{len(named) - 5} more)" if len(named) > 5 else "")
    if "--archived" not in parsed.passthrough:
        return EXIT_REFUSED, (f"REFUSED: {len(named)} of the {len(parsed.chats)} chats named are "
                              f"ARCHIVED [{shown}]. {_ARCHIVE_LAW} Move the unarchived ones "
                              "alone, or - if the human named these archived chats - re-run "
                              f"with --archived --archived-count {len(named)}.")
    if parsed.archived_count != len(named):
        stated = "not stated" if parsed.archived_count < 0 else str(parsed.archived_count)
        return EXIT_REFUSED, (f"REFUSED: --archived needs --archived-count to MATCH. This batch "
                              f"holds {len(named)} archived chat(s) [{shown}]; the count given "
                              f"was {stated}. {_ARCHIVE_LAW} Stating the number is what proves "
                              "the archive was looked at rather than swept along.")
    if len(named) != len(parsed.chats):
        return EXIT_REFUSED, (f"REFUSED: this batch MIXES {len(named)} archived chat(s) with "
                              f"{len(parsed.chats) - len(named)} unarchived one(s). {_ARCHIVE_LAW} "
                              "Archived chats move in a batch of their own, so no archive can "
                              "ride along on a routine account move; run the unarchived ones "
                              "first, then the archived ones deliberately.")
    return None


def _movable_chats(source: str | None, limit: int) -> tuple[list[dict], str]:
    """Every UNARCHIVED desktop chat, newest first, optionally scoped to one source account.

    Reads the SAME endpoint `list_chats` serves (hydralib.chats -> /api/chats), which is the
    whole point: two enumerators that disagree about what an account holds is how a batch
    reported "0 unarchived desktop chat(s)" on an account list_chats showed three on, minutes
    after a killed move (2026-09-13). Naming those three ids by hand then moved them cleanly.
    Archived rows are excluded here because --all-unarchived means what it says; a specific
    archived chat still moves by name with --archived.
    """
    # ⛔ NOT hydralib.sessions(). That endpoint resolves each session id to ONE owning profile
    # (live beats archived, else newest mtime), which is right for "where is this chat now"
    # and wrong for "what does this account still hold": a half-moved chat exists on two
    # accounts at once, and the collapse hides it from the account it is sitting on - exactly
    # the state a killed batch leaves. See hydralib.chats for the measurement.
    # --from arrives as whatever the caller typed, and the MCP ALWAYS sends a NUMBER ("27").
    # A session row carries only the instance FOLDER name ("anothuh1"), so comparing the raw
    # argument against it matched nothing for every spelling but one - and the miss was
    # SILENT: a batch scoped to a real, full account reported "nothing to move", which reads
    # exactly like "that account is already clean". Resolve it through the fleet first, the
    # way migrate_chat's own --from does, so the two paths cannot disagree about an account.
    source_name = None
    if source:
        fleet = hydralib.fleet()
        src = hydralib.resolve_instance(fleet, str(source))
        if src is None:
            known = ", ".join(f"#{i.get('num')} {i.get('name')}"
                              for i in fleet.get("instances", []))
            raise _UnknownSource(f"--from names no instance ({source!r}). Known: {known}")
        source_name = str(src.get("name") or "")
    # Scoped server-side when we know the account (one store scan instead of the fleet's), and
    # filtered locally again anyway: the endpoint passes an unknown label through rather than
    # 404ing, so trusting the scope alone could read another account's rows as this one's.
    rows = hydralib.chats(source_name or None)
    picked = []
    for row in rows:
        if row.get("isArchived", row.get("archived")):
            continue
        inst = str(row.get("instance") or "")
        if not inst:
            continue  # not a desktop chat: nothing to move it off
        if source_name and inst.lower() != source_name.lower():
            continue
        if not str(row.get("sessionId") or ""):
            continue  # a chat with no CLI session id cannot be resolved, so it cannot be moved
        # One shape downstream, whichever endpoint fed it: the batch resolves by session id.
        picked.append({**row, "session_id": row.get("sessionId"),
                       "last_activity_at": str(row.get("lastActivityAt") or "")})
    picked.sort(key=lambda r: r.get("last_activity_at") or "", reverse=True)
    note = (f"{len(picked)} unarchived desktop chat(s)"
            + (f" on {source_name}" if source_name else ""))
    if limit and len(picked) > limit:
        picked = picked[:limit]
        note += f", taking the {limit} most recent"
    return picked, note


class _Item:
    """One chat's place in the batch: its query, its landing while it is still unfinished,
    and the payload it ends up printing. `landing is None` after phase one means this chat
    is DONE being touched - refused, planned, or crashed - and every later phase skips it."""

    __slots__ = ("query", "landing", "payload", "errors", "terminated")

    def __init__(self, query: str) -> None:
        self.query = query
        self.landing = None
        self.payload: dict = {}
        # A later phase that raised, one line each. The landing stays alive through the
        # remaining phases (each is its own tidy-up), and the payload says what did not finish.
        self.errors: list[str] = []
        # What --terminate-live did to this chat's engine, if anything: enginelib's own
        # answer, attached to whichever payload the chat ends up with (landed or refused).
        self.terminated: dict | None = None


def _crash(query: str, err: Exception, started: float, doing: str) -> dict:
    """A chat that raised. Never a landing, always named, and it never stops the batch."""
    return {"chat": query, "ok": False, "landed": False, "exitCode": 1,
            "report": f"{doing} raised {type(err).__name__}: {str(err)[:200]}",
            "secs": round(time.time() - started, 2)}


#: migrate_chat's exit code for "a live engine stood in the way" - the ONLY refusal that
#: --terminate-live may answer. A hold (6), the breaker (5), archived (7) and the
#: deterministic refusals (3) are decisions, not obstacles, and a kill answers none of them.
_EXIT_LIVE_ENGINE = 4


def _terminate_for(query: str) -> dict:
    """Re-read the chat NOW and kill its engine, on a person's word (--terminate-live).

    Never from a pid carried in the refusal: liveness read a moment ago is not liveness, and
    a stale pid may already belong to someone else's process. The kill goes on the attempt
    ledger under its own kind, so the mutation trail says an engine was stopped deliberately
    and by which flag."""
    try:
        match = hydralib.resolve_one(query)
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat, hydralib.DaemonError) as err:
        return {"stopped": False, "pid": None,
                "why": f"could not re-read the chat to terminate it: {err}"}
    if not match.get("live"):
        return {"stopped": False, "pid": None, "why": "no live engine to terminate"}
    sid = str(match.get("cliSessionId") or "")
    stopped = enginelib.terminate_engine(match)
    ledgerlib.note(
        "terminate", sid,
        note=(f"--terminate-live: pid {stopped.get('pid')} for '{match.get('title')}' - "
              f"{'stopped' if stopped.get('stopped') else 'NOT stopped'}: "
              f"{str(stopped.get('why') or '')[:120]}"))
    return stopped


def _attach_terminated(item: _Item) -> None:
    """Put the terminate verdict on the payload the chat ended up with. Idempotent, because
    a landed chat's payload is rebuilt after the finishing phases."""
    if item.terminated is not None and item.payload:
        item.payload["terminated"] = dict(item.terminated)


def _move_one(query: str, passthrough: list[str], terminate_live: bool = False,
              chat_title: str | None = None) -> _Item:
    """PHASE ONE for ONE chat: migrate_chat's own move_only() - resolve, gate, import, verify.

    Calls the same function main() calls, so this driver still cannot drift from the
    single-chat path: every gate, the import and the read-back verify are whatever
    migrate_chat says they are today. What it does NOT do is finish the move; the source
    settle and the permission stamp are run later, across the whole batch at once.

    `terminate_live` (a person's word) answers exactly one refusal - a live engine, code 4 -
    by killing that engine and running THE SAME MOVE AGAIN, every gate included, against a
    chat that now has no writer. An unconfirmed kill leaves the refusal in place.

    `chat_title` (2026-09-15, TODO item 1) is THIS chat's own --chat-title, appended AFTER
    `passthrough` so it wins over any batch-wide --title migrate_chat's own parser would
    otherwise see first (last --title in argv wins, same rule _parse_migrate_argv always used).
    Without --title (or an accepted confirm_title), migrate_chat falls back to restating a
    current name for the naming door - which is exactly the path that could 400 when the
    daemon's session title and the desktop record's title disagree. A caller who names the
    chat's real title here skips that restatement entirely.
    """
    item = _Item(query)
    started = time.time()
    argv = [query, *passthrough, *(["--title", chat_title] if chat_title else [])]
    try:
        outcome = migrate_chat.move_only(argv)
        if (outcome.landing is None and terminate_live
                and outcome.code == _EXIT_LIVE_ENGINE):
            item.terminated = _terminate_for(query)
            if item.terminated.get("stopped"):
                outcome = migrate_chat.move_only(argv)
    except Exception as err:  # a crash in one chat must not take the batch with it
        item.payload = _crash(query, err, started, "migrate")
        _attach_terminated(item)
        return item
    if outcome.landing is not None:
        item.landing = outcome.landing
        return item
    # A refusal or a dry-run plan: already a finished payload, nothing left to do to it.
    payload = dict(outcome.payload or {})
    payload.setdefault("report", "")
    payload["chat"] = query
    payload["exitCode"] = outcome.code
    payload.setdefault("landed", False)
    payload["ok"] = outcome.code == 0 and bool(payload.get("landed"))
    item.payload = payload
    _attach_terminated(item)
    return item


def _resume_window(match: dict) -> int:
    """The gate's quiet window for delivering a landed chat's resume, in seconds.

    ⛔ LANDING IS ACTIVITY, SO THE STANDING WINDOW CALLS EVERY FRESH LANDING MID-TURN (pinned
    live 2026-09-14, #63 -> #13). The import stamps the chat's activity with the landing time,
    so for IDLE_AFTER_SECS (180s) after landing the gate reads a live engine as `running`, not
    idle, whatever the transcript says. The courier then marks the delivery `peer_only`, the peer
    channel dead-letters on a chat that is not actually taking turns, and the row is deferred as
    "mid-turn". The timings proved it: the one chat couriered 194s after landing was delivered,
    the four couriered under 180s were all deferred, and the operation then sat for nine minutes
    and was cancelled. None of the five was mid-turn - every transcript ended on a finished turn
    and the app itself reported `isRunning:false` for each.

    The quiet window exists to tell a finished turn from a working one, and a landed chat's
    finishing is already settled by the move itself, so the resume gates it the way `--now`
    gates a move: migrate_chat.quiet_window's fast window, but ONLY when the transcript was
    scanned and no background job is outstanding - otherwise the standing window, unchanged.
    This shortens only how long the gate waits before reading the tail. The tail must still show
    a finished turn, so a chat genuinely working after it landed is still gated as working.
    """
    try:
        _, idle_after, _ = migrate_chat.quiet_window(match, now=True)
    except Exception:  # an unreadable scan is no proof of anything: keep the standing window
        return migrate_chat.gatelib_idle_after()
    return idle_after


def _restage(item: _Item, sid: str, text: str) -> dict | None:
    """Stage `text` against one landed chat again. Returns the new row, or None if it could
    not be staged (the reason is written onto the item's verdict).

    ⛔ A RETRY HAS TO RE-STAGE, it cannot just re-run the courier. A delivery that was
    ATTEMPTED and failed is marked `failed`, which means it is no longer staged - so the
    obvious retry (`courier --yes --only <id>`) answers "nothing staged - the courier has
    nothing to deliver" and looks like success. That is exactly what happened by hand on
    2026-09-12 before this existed."""
    # dedupe=True: this is the batch's own AUTOMATIC retry, not a person's reply, and a row
    # still staged for this chat (a deferral the courier kept) is the one to deliver - writing a
    # second is a second wake. See deliverylib.stage.
    try:
        match = hydralib.resolve_one(sid)
        evidence = stage_reply.gather_evidence(match, sid)
        entry = deliverylib.stage(
            sid, text,
            title=str(match.get("title") or item.payload.get("title") or ""),
            instance=str(match.get("instance") or item.payload.get("to") or ""),
            evidence=evidence, by="migrate-resume-retry", dedupe=True)
        return {**entry, "idleAfterSecs": _resume_window(match)}
    except Exception as err:
        item.payload["resume"]["why"] += (
            f" | retry could not re-stage: {type(err).__name__}: {str(err)[:120]}")
        return None


def _retry_hard_failures(hard: dict[str, _Item], text: str, tally: dict) -> None:
    """ONE more attempt for each chat whose delivery was tried and FAILED.

    ⛔ WHY ONLY THE HARD FAILURES. A row the courier SKIPPED is a deliberate deferral - a
    mid-turn chat is never interrupted, and a tripped breaker is telling the machinery to
    stop - so those keep their staged reply and their named retry, and hammering them is the
    futile cycle the breaker exists to end. A row that was attempted and failed is the other
    case entirely: on 2026-09-12 one of three chats failed on a transient and the batch,
    having no retry, left the chat that MOST needed its resume (it had just been cut off by
    the source account's quota wall) sitting dormant.

    Every outcome is still reported. A retry that also fails says so, and keeps the retry
    command for the new row so a person has something that works.
    """
    import courier

    restaged: dict[str, _Item] = {}
    windows: dict[str, int] = {}
    for item in hard.values():
        sid = str(item.payload["sessionId"])
        entry = _restage(item, sid, text)
        if entry is None:
            continue
        restaged[entry["id"]] = item
        windows[entry["id"]] = int(entry["idleAfterSecs"])
        item.payload["resume"]["deliveryId"] = entry["id"]
        item.payload["resume"]["retry"] = f"python orch.py courier --yes --only {entry['id']}"
    if not restaged:
        return
    try:
        report = courier.run(len(restaged), set(restaged), act=True, hand_run=True,
                             idle_after=windows)
    except Exception as err:
        for item in restaged.values():
            item.payload["resume"]["why"] += (
                f" | retry raised {type(err).__name__}: {str(err)[:120]}")
        return
    outcome = {r.get("id"): r for r in report.get("results", [])}
    skipped = {s.get("id"): s.get("why") for s in report.get("skipped", [])}
    for did, item in restaged.items():
        verdict = item.payload["resume"]
        res = outcome.get(did)
        if res and res.get("ok"):
            verdict["delivered"] = True
            verdict["why"] = f"delivered on retry: {res.get('outcome') or ''}".strip()
            verdict.pop("retry", None)
            tally["delivered"] += 1
            tally["staged"] = max(0, tally["staged"] - 1)
            tally["retried"] = tally.get("retried", 0) + 1
        else:
            why = (skipped.get(did) or (res or {}).get("detail")
                   or (res or {}).get("outcome") or "still not delivered")
            verdict["why"] += f" | retried once: {why}"


def _stage_resume_for(item: _Item, text: str) -> tuple[str, int] | None:
    """Stage `text` as one landed chat's resume. Returns (delivery id, quiet window) on
    success; on failure the reason is named on THAT item's own verdict and None comes back,
    so one chat's staging failure never costs the others their resume."""
    sid = str(item.payload["sessionId"])
    try:
        match = hydralib.resolve_one(sid)
        evidence = stage_reply.gather_evidence(match, sid)
        # reuse_identical: a batch that was cancelled with this resume still staged and is
        # then fired again must not queue a SECOND copy of the same words (2026-09-14: two
        # rows each for two chats). Different text staged for the chat is left alone.
        entry = deliverylib.stage(
            sid, text,
            title=str(match.get("title") or item.payload.get("title") or ""),
            instance=str(match.get("instance") or item.payload.get("to") or ""),
            evidence=evidence, by="migrate-resume", reuse_identical=True)
        window = _resume_window(match)
    except Exception as err:  # one chat's staging must not cost the others their resume
        item.payload["resume"] = {
            "staged": False, "delivered": False,
            "why": f"staging raised {type(err).__name__}: {str(err)[:160]}"}
        return None
    item.payload["resume"] = {
        "deliveryId": entry["id"], "staged": True, "delivered": False, "why": "",
        "retry": f"python orch.py courier --yes --only {entry['id']}"}
    if entry.get("reused"):
        item.payload["resume"]["reused"] = True
    return entry["id"], window


def _apply_resume_outcome(verdict: dict, res: dict | None, skip_why: str | None) -> bool:
    """Write one chat's verdict from the courier's report. True when the reply went; otherwise
    the row is STILL STAGED and `why` carries whatever the courier said about it."""
    if res and res.get("ok"):
        verdict["delivered"] = True
        verdict["why"] = str(res.get("outcome") or "delivered")
        verdict.pop("retry", None)
        return True
    verdict["why"] = str(skip_why or (res or {}).get("detail")
                         or (res or {}).get("outcome") or "not delivered - still staged")
    return False


def _is_hard_failure(did: str, res: dict | None, skipped: dict) -> bool:
    """A row the courier ATTEMPTED and FAILED is retried once by the caller; a row it SKIPPED is
    a deliberate deferral and is left alone. See _retry_hard_failures.

    ⛔ A DEFERRED RESULT IS NOT A HARD FAILURE (2026-09-14). The courier now keeps a row STAGED
    when the chat is mid-turn and tags its result `deferred` - but it still arrives in
    `results`, not `skipped`, so this test used to read it as "attempted and failed", re-staged
    a SECOND copy of the resume and fired the courier into the same live turn again. Two copies
    of one resume are two wakes. A not-yet is a skip."""
    return did not in skipped and res is not None and not res.get("deferred")


def _record_resume_outcomes(by_delivery: dict[str, _Item], report: dict,
                            tally: dict) -> dict[str, _Item]:
    """Write every chat's resume verdict from the ONE courier run, and return the rows whose
    delivery was attempted and failed - the ones `_retry_hard_failures` gives one more go."""
    outcome = {r.get("id"): r for r in report.get("results", [])}
    skipped = {s.get("id"): s.get("why") for s in report.get("skipped", [])}
    hard: dict[str, _Item] = {}
    for did, item in by_delivery.items():
        res = outcome.get(did)
        if _apply_resume_outcome(item.payload["resume"], res, skipped.get(did)):
            tally["delivered"] += 1
        else:
            tally["staged"] += 1
            if _is_hard_failure(did, res, skipped):
                hard[did] = item
    return hard


def _resume_landed(items: list[_Item], text: str) -> dict:
    """PHASE FOUR: tell every landed chat to carry on. Returns the batch-level tally.

    A LANDED CHAT IS DORMANT. The import stops its engine and nothing wakes it, so a migrated
    chat nobody types into just sits in its new sidebar - which is how seven chats were
    "migrated" on 2026-09-06 and none of them was working until each was staged and couriered
    by hand. Staging goes through stage_reply's own evidence rule, so the courier can still
    prove it is typing into the right chat; delivery goes through the courier's HAND-RUN path
    (a person's named rows: no tray icon, no fair-share cap). A chat whose engine booted on
    landing and is mid-turn keeps its reply staged - the courier never interrupts a live turn -
    and its result names the exact retry. Every chat's `resume` says which it was.
    """
    landed = [i for i in items if i.payload.get("landed") and i.payload.get("sessionId")]
    tally = {"asked": len(landed), "delivered": 0, "staged": 0}
    if not landed:
        return tally
    by_delivery: dict[str, _Item] = {}
    windows: dict[str, int] = {}
    for item in landed:
        staged = _stage_resume_for(item, text)
        if staged is None:
            continue
        did, window = staged
        by_delivery[did] = item
        windows[did] = window
    if not by_delivery:
        return tally
    import courier  # local: the actuator libs it pulls in are no concern of a batch without --resume

    try:
        report = courier.run(len(by_delivery), set(by_delivery), act=True, hand_run=True,
                             idle_after=windows)
    except Exception as err:
        for item in by_delivery.values():
            item.payload["resume"]["why"] = (
                f"the courier raised {type(err).__name__}: {str(err)[:160]}")
        tally["staged"] = len(by_delivery)
        return tally
    hard = _record_resume_outcomes(by_delivery, report, tally)
    if hard:
        _retry_hard_failures(hard, text, tally)
    return tally


def _mark_unresumed_after_timeout(landed_items: list[_Item], budget: float) -> None:
    """PHASE FOUR's own deadline gave up waiting on `_resume_landed` (most likely `courier.run`
    itself, waiting on an engine it believes is mid-turn - see the module docstring's PHASE
    FOUR note). Sweep every landed chat and make sure its `resume` verdict says so BY NAME:

    ⛔ THE SILENT-DORMANT SHAPE THIS WHOLE FIX EXISTS TO CLOSE (found 2026-09-13) is a chat
    that staged fine - `_resume_landed`'s first pass runs before the long courier call, so
    EVERY landed chat usually already has `resume = {staged: True, delivered: False, why: ""}`
    by the time the timeout trips - and then never gets `why` filled in because the courier
    call that would have confirmed or denied delivery was abandoned. A landed chat with
    `resume.delivered` false and an EMPTY `why` reads exactly like a caller forgot to check;
    it must instead read as "known: not confirmed", with the retry command still attached.
    """
    for item in landed_items:
        verdict = item.payload.get("resume")
        if not isinstance(verdict, dict):
            # Timed out before this chat was even staged (the timeout tripped inside the
            # staging loop itself, before `by_delivery` was built) - name that too.
            item.payload["resume"] = {
                "staged": False, "delivered": False,
                "why": f"the resume phase timed out after {budget:.0f}s before this chat's "
                       "reply could be staged - resume NOT delivered.",
            }
            continue
        if verdict.get("delivered"):
            continue  # a real verdict already landed for this chat before the deadline hit
        if not str(verdict.get("why") or "").strip():
            verdict["why"] = (
                f"the resume phase timed out after {budget:.0f}s waiting on the courier - "
                "the reply is staged but delivery was never confirmed for this chat.")


def _finish_one(item: _Item) -> None:
    """Turn a finished landing into the payload the report reads. Never raises.

    ⛔ A LANDING THAT CRASHED LATER IS STILL A LANDING (review finding, 2026-09-06). Phases two
    and three only ever run on a chat that _verify_landing_or_raise confirmed lives in the
    target account and that the mutation ledger already records as moved. Reporting such a
    chat `landed: False` sent the operator to "re-run" a move that had already happened, and
    counted a fully-landed batch as partial. So a later-phase raise keeps `landed: True`, sets
    `ok: False` with a non-zero exit code, and names exactly what did not finish.
    """
    started = time.time()
    try:
        item.payload = migrate_chat.landing_payload(item.landing)
    except Exception as err:
        item.payload = {"landed": True, "chat": item.query, "ok": False, "exitCode": 1,
                        "report": (f"LANDED but finishing raised {type(err).__name__}: "
                                   f"{str(err)[:200]} - the chat IS in its new account; "
                                   "do not re-move it"),
                        "secs": round(time.time() - started, 2)}
        item.landing = None
        return
    item.payload["chat"] = item.query
    if item.errors:
        item.payload["ok"] = False
        item.payload["exitCode"] = 1
        item.payload["unfinished"] = list(item.errors)
        item.payload["report"] = (
            "LANDED but not finished: " + "; ".join(item.errors)
            + " - the chat IS in its new account; finish the tidy-up by hand "
              "(settle the source row / stamp the mode), do not re-move it.\n"
            + str(item.payload.get("report") or ""))
        return
    item.payload["exitCode"] = 0
    item.payload["ok"] = bool(item.payload.get("landed"))


def _run_phases(items: list[_Item]) -> None:
    """PHASES TWO AND THREE, each run across EVERY chat before the next one starts.

    THE ORDER IS THE OWNER'S (2026-09-06): "Move them all, archive them all, then set all the
    permissions." Two things come out of it, and only one of them is speed:

      - The chats are USABLE sooner. Phase one ends with every chat verified in its new
        account; the settling and stamping that follow are tidying a move that has already
        happened. Interleaving them meant chat five had not moved at all until the first four
        had been fully tidied.
      - ONE BYPASS WATCH INSTEAD OF N. watch_bypass is an 8-second once-a-second re-read of a
        landed record, and N of those windows overlap perfectly. Run per chat they cost 8s x
        N - 40 of the 189 seconds a 5-chat batch took - and shared they cost 8s for any batch
        size. That is the single largest saving here and it is pure waiting, not work.

    ⛔ WHAT IS STILL SERIAL, AND MUST STAY SERIAL: the source settle and the permission picker
    each drive a real application window through its own instance lock. Two of those at once
    is two scripts fighting over one sidebar. The phases overlap the WAITING; they do not
    overlap the driving.

    ⛔ EACH SUB-PHASE BELOW IS NOW ITS OWN BOUNDED GROUP (module-level SETTLE_PHASE_TIMEOUT_SECS
    / STAMP_PHASE_TIMEOUT_SECS). A phase that blows its budget is abandoned, not awaited
    forever: `_mark_settle_timeout` / `_mark_stamp_timeout` name whichever chats never got a
    verdict, and the batch still reaches its report instead of holding the whole run hostage.
    """
    live = [i for i in items if i.landing is not None]
    if not live:
        return

    def _settle_all() -> None:
        for item in live:
            try:
                migrate_chat.phase_settle(item.landing)
            except Exception as err:
                # The chat is in its new account regardless; the settle is one tidy-up of two.
                # Its landing stays alive so the stamp phase still runs for it, and the payload
                # will say the source row is in an unknown state rather than claim a settle.
                item.errors.append(f"settling raised {type(err).__name__}: {str(err)[:200]}")
                item.landing.settle_note = (f" ⚠ Source row NOT settled - settling raised "
                                            f"{type(err).__name__}: {str(err)[:120]}.")
                item.landing.source_row = "unknown"

    settle_budget = SETTLE_PHASE_TIMEOUT_SECS * len(live)
    if not _run_bounded("settle", settle_budget, _settle_all):
        _mark_settle_timeout(live, settle_budget)

    _name_landings(live)

    def _stamp_all() -> None:
        # The shared watch. It re-stamps any record the app flipped back, exactly as each
        # chat's own watch did, so this is the same guarantee bought once instead of N times.
        try:
            watched = migrate_chat.watch_bypass_many(
                [migrate_chat.landed_meta_path(i.landing) for i in live])
        except Exception:
            # ⛔ NEVER SILENTLY SKIP THE WATCH. A missing verdict means each chat watches its
            # own record below (watched=None), which is slower and correct - not faster and
            # unproven.
            watched = {}
        for item in live:
            try:
                path = migrate_chat.landed_meta_path(item.landing)
                migrate_chat.phase_stamp(item.landing, watched=watched.get(path))
            except Exception as err:
                item.errors.append(f"stamping raised {type(err).__name__}: {str(err)[:200]}")

    stamp_budget = STAMP_PHASE_TIMEOUT_SECS * len(live) + migrate_chat.BYPASS_WATCH_SECS
    if not _run_bounded("stamp", stamp_budget, _stamp_all):
        _mark_stamp_timeout(live, stamp_budget)

    for item in items:
        if item.landing is not None:
            _finish_one(item)


def _mark_settle_timeout(live: list[_Item], budget: float) -> None:
    """The settle phase's own deadline gave up waiting. Any chat whose source row is still
    unset never got a settle verdict; name the timeout on its own item so the report cannot
    read as a clean settle that simply never happened. `_finish_one`/`landing_payload` already
    turn an `errors` entry into 'LANDED but not finished', which is exactly the right shape -
    the chat IS in its new account, only its tidy-up is outstanding."""
    for item in live:
        land = item.landing
        if land is not None and land.source_row is None:
            item.errors.append(
                f"settle phase timed out after {budget:.0f}s - source row NOT settled; "
                "the chat IS in its new account, do not re-move it")


def _mark_stamp_timeout(live: list[_Item], budget: float) -> None:
    """The stamp phase's own deadline gave up waiting. Any chat whose doctrine is still unset
    never got a permission-mode verdict; `landing_payload`'s own fallback ('the stamp phase
    did not run') already reports it honestly, so this only needs to name WHY, on the record
    the caller actually reads (`item.errors` -> the 'LANDED but not finished' report)."""
    for item in live:
        land = item.landing
        if land is not None and land.doctrine is None:
            item.errors.append(
                f"stamp phase timed out after {budget:.0f}s - permission mode NOT adjudicated; "
                f"remedy: {migrate_chat._bypass_remedy_cmd(land.session_id, land.chat_title)}")


def _landed_titles_by_instance(live: list) -> dict[str, dict[str, str]]:
    """The intended title of every chat that landed, grouped by the account it landed in. A
    chat with no instance, no session id or no intended title has nothing to name and is left
    out - nothing of it landed to name."""
    by_instance: dict[str, dict[str, str]] = {}
    for item in live:
        inst = str((item.landing.target or {}).get("name") or "")
        sid = str(item.landing.session_id or "")
        title = str(item.landing.chat_title or "")
        if inst and sid and title:
            by_instance.setdefault(inst, {})[sid] = title
    return by_instance


def _record_naming_error(live: list, inst: str, msg: str) -> None:
    """A naming failure belongs to every chat that landed in that account."""
    for item in live:
        if str((item.landing.target or {}).get("name") or "") == inst:
            item.errors.append(msg)


def _run_name_pass(live: list, inst: str, titles: dict[str, str]) -> dict | None:
    """Drive the naming pass for one account, retrying the shape that means it never ran.
    Returns the pass's own verdict, or None when it raised (named on the items) - a name is a
    courtesy, a landed chat is the deliverable.

    ⛔ AND THE PASS MUST BE TOLD WHAT WE LANDED, OR IT JUDGES THE WRONG SURFACE (second false
    green, found live 2026-09-15: a 4-chat move reported 4/4 OK with 3 chats left nameless on
    screen and their bypass stamps fallen back to disk-only). The importer writes a title into
    the landed record and the daemon says so honestly (`titled: true, titleDurable: false`);
    the RUNNING app then re-saves that record from its own memory and erases it. The pass's own
    "is anything nameless?" test reads the disk copy, so inside that window it saw four real
    titles and did nothing at all. `require` moves the question to what the app is RENDERING,
    which is the only surface the permission picker, the renamer and the courier can aim at.

    ⛔ `remaining: None` IS "THE PASS NEVER RAN", NOT "NOTHING NAMELESS" (false green found
    2026-09-13). name_pass returns that shape when it finds no store, and when another lane
    already holds the instance lock - and it takes that lock with wait_secs=0, so a sibling
    phase driving the same app loses the whole naming pass. The old test was `if
    got.get("needsJudgment") or got.get("remaining")`, and None is falsy, so the batch read
    "never ran" as "clean" and reported OK. name_chats.main() has always drawn this distinction
    ("this is NOT 'nothing nameless' - exit 1, not a false 0"); the batch path simply never did.
    Measured cost: a 4-chat move reported 4/4 OK with two chats left nameless, which then
    rendered as identical 'General coding session' rows, and a nameless row cannot be aimed at -
    so their bypass stamp failed too, and the remedy the move printed failed for the same
    reason. Retry, because the lock is usually transient."""
    import name_chats

    got = None
    for attempt in range(1, NAMING_ATTEMPTS + 1):
        try:
            got = name_chats.name_pass(inst, extra_titles=titles, require=titles)
        except Exception as err:  # a name is a courtesy; a landed chat is the deliverable
            _record_naming_error(live, inst,
                                 f"naming raised {type(err).__name__}: {str(err)[:150]}")
            return None
        if got.get("remaining") is not None:
            return got  # the pass actually ran; its own verdict stands
        if attempt < NAMING_ATTEMPTS:
            time.sleep(NAMING_RETRY_WAIT_SECS)
    return got


def _report_name_pass(got: dict | None, live: list, inst: str) -> None:
    """Say what the pass itself reported, in the pass's own words. Silent only when the pass
    ran and left nothing outstanding - never when it never ran, and never when it left a chat
    unrendered under its real name."""
    if got is None:
        return
    if got.get("remaining") is None:
        _record_naming_error(
            live, inst,
            f"naming pass on '{inst}' NEVER RAN after {NAMING_ATTEMPTS} attempts"
            + (f": {got['why']}" if got.get("why") else ""))
    elif got.get("needsJudgment") or got.get("remaining") or got.get("unrendered"):
        _record_naming_error(
            live, inst,
            f"naming pass on '{inst}' left {len(got.get('remaining') or [])} nameless / "
            f"{len(got.get('needsJudgment') or [])} needing an AI-written name / "
            f"{len(got.get('unrendered') or [])} not rendered under their real name"
            + (f": {got['why']}" if got.get("why") else ""))


def _screen_rendered_titles(by_instance: dict) -> dict[str, list[str] | None]:
    """What each account's app is RENDERING, read ONCE per instance and held. None = the
    sidebar could not be read, which is never read as a miss."""
    import name_chats

    return {inst: name_chats.rendered_titles(inst) for inst in by_instance}


def _report_unnamed_landings(live: list, screen: dict[str, list[str] | None]) -> None:
    """THE VERDICT THAT DOES NOT TRUST THE PASS. Whatever the pass believed, a nameless landing
    is the condition that breaks the stamp phase next, so it is read back per chat from the
    record on disk. This catches every cause, including the one no verdict can see: the running
    app re-saving a title away AFTER the pass verified it (`titleDurable: false`).

    ...and the disk copy cannot answer it alone, because the running app's memory outranks it
    for everything that aims by name, so the sidebar was read above and is handed in here."""
    import name_chats

    for item in live:
        inst = str((item.landing.target or {}).get("name") or "")
        title = str(item.landing.chat_title or "")
        rows = screen.get(inst)
        if rows is not None and title and not name_chats.renders(rows, title):
            item.errors.append(
                f"landed but the app is NOT rendering it as '{title}' - the sidebar shows it "
                "under a generic name, so the permission picker, the renamer and the courier "
                "all have nothing to aim at. Its bypass stamp is disk-only for the same reason. "
                f"Fix with: python scripts/name_chats.py {inst}")
        try:
            with open(str(migrate_chat.landed_meta_path(item.landing)), encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            continue  # the landing itself is verified elsewhere; do not invent a naming failure
        if name_chats._needs_probe(meta.get("title")):
            item.errors.append(
                f"landed NAMELESS (title={meta.get('title')!r}): it renders as a generic row, so "
                "nothing can aim at it by name - its bypass stamp will fail for the same reason. "
                f"Fix with: misc/Manage-DesktopChat.ps1 -Instance <dir> -Title 'General coding "
                f"session' -Action Rename -NewTitle '{item.landing.chat_title}' -Ordinal 1 "
                "(then verify by dossier which chat took the name)")


def _name_landings(live: list) -> None:
    """Give every nameless landing its real name BEFORE the stamp phase tries to aim at one.

    ⛔ AN IMPORT LANDS NAMELESS, AND A NAMELESS CHAT CANNOT BE STAMPED (found 2026-09-09,
    reproduced and fixed 09-10). `session-launch` reports `titleDurable: false` for a landing
    into a RUNNING app and means it: the title is written to disk and the app re-saves over it
    from memory, so the record comes back with `title: null` while the sidebar renders a name
    derived from the transcript. Everything that aims BY NAME then breaks at once - the
    permission picker is handed an empty `-Title` and dies inside PowerShell's parameter
    validation (which reads like an environment fault and is not one), `chat_rename` cannot
    find the row, and the `disk-only` remedy the move itself prints fails on the exact
    population it exists to serve. The durable channel has always been the app's OWN rename;
    that is what the naming pass drives, and the batch is the last place that still knows each
    chat's intended title, so this is where the two have to meet.

    Best-effort and never fatal: by this point every chat is moved and verified, and a name is
    not worth failing a landing over. Reported on the item, never swallowed.
    """
    by_instance = _landed_titles_by_instance(live)
    for inst, titles in by_instance.items():
        _report_name_pass(_run_name_pass(live, inst, titles), live, inst)

    _report_unnamed_landings(live, _screen_rendered_titles(by_instance))


def _report_dry_run(results: list[dict], note: str, secs: float) -> str:
    lines = [f"DRY RUN: {len(results)} chat(s) planned in {secs:.0f}s"
             + (f" ({note})" if note else "")]
    for r in results:
        first = (r.get("report") or "").splitlines()
        lines.append(f"  PLAN {(first[0] if first else r['chat'])[:170]}")
    lines.append("Nothing was moved. Re-run without --dry-run to execute.")
    return "\n".join(lines)


def _report_resume_tally(results: list[dict]) -> str:
    # ⛔ THE HEADLINE MUST NOT OVER-REPORT (found 2026-09-09, fixed 09-10). A landed chat is
    # DORMANT until something types into it, so when a caller asked for --resume, "3/3 landed"
    # described a migration in which zero chats had actually been told to carry on - and that
    # is the number people read. The per-chat RESUME lines below were right the whole time and
    # were scrolled past. Counted only when a resume was ASKED for; a plain move says nothing
    # about resumes, because there was nothing to say.
    asked_resume = [r for r in results if r.get("resume")]
    if not asked_resume:
        return ""
    told = len([r for r in asked_resume if (r.get("resume") or {}).get("delivered")])
    tally = f", {told}/{len(asked_resume)} told to carry on"
    if told < len(asked_resume):
        tally += " (the rest are moved but DORMANT)"
    return tally


def _report_landed_lines(clean: list[dict], unfinished: list[dict], refused: list[dict]) -> list[str]:
    lines = []
    for r in clean:
        title = r.get("title") or r["chat"]
        verdict = r.get("bypassVerdict") or "?"
        lines.append(f"  OK   {title} -> {r.get('to') or '?'} [bypass: {verdict}]")
    for r in unfinished:
        title = r.get("title") or r["chat"]
        why = (r.get("report") or "").splitlines()
        lines.append(f"  LANDED but not finished: {title} -> {r.get('to') or '?'}: "
                     f"{(why[0] if why else 'a later phase raised')[:150]}")
    for r in refused:
        why = (r.get("report") or "").splitlines()
        lines.append(f"  SKIP {r['chat']}: {(why[0] if why else 'refused')[:150]}")
    return lines


def _report_terminated_lines(results: list[dict]) -> list[str]:
    # WHAT --terminate-live DID, chat by chat. A kill is the one act in this script that is
    # not a move, so it is never folded into a move's line.
    lines = []
    for r in results:
        t = r.get("terminated")
        if not t:
            continue
        title = r.get("title") or r["chat"]
        if t.get("stopped"):
            lines.append(f"  TERMINATED pid {t.get('pid')} for '{title}' on a person's word, "
                         "then moved again")
        else:
            lines.append(f"  TERMINATE FAILED for '{title}': {str(t.get('why') or '')[:140]}")
    return lines


def _report_resume_lines(results: list[dict]) -> list[str]:
    # WHAT --resume DID. "Moved" and "told to carry on" are different facts; a chat that was
    # moved and left dormant reads as done to anyone who only counts landings.
    lines = []
    for r in results:
        rs = r.get("resume")
        if not rs:
            continue
        title = r.get("title") or r["chat"]
        if rs.get("delivered"):
            lines.append(f"  RESUME delivered -> {title}")
        elif rs.get("staged"):
            lines.append(f"  RESUME staged, NOT delivered -> {title}: "
                         f"{str(rs.get('why') or '')[:120]} (retry: {rs.get('retry')})")
        else:
            lines.append(f"  RESUME NOT staged -> {title}: {str(rs.get('why') or '')[:140]}")
    return lines


def _report(results: list[dict], note: str, secs: float) -> str:
    # A DRY RUN IS NOT A REFUSAL. Reporting a plan as SKIP made a clean plan read like 13
    # blocked chats, which is the same class of lie as calling a skipped step a pass.
    if results and all(r.get("dryRun") for r in results):
        return _report_dry_run(results, note, secs)
    landed = [r for r in results if r.get("landed")]
    clean = [r for r in landed if r.get("ok")]
    # LANDED BUT NOT FINISHED is its own bucket: these chats ARE in the new account, and the
    # "was NOT moved - re-run it" trailer below must never be printed about one of them.
    unfinished = [r for r in landed if not r.get("ok")]
    refused = [r for r in results if not r.get("landed")]
    resume_tally = _report_resume_tally(results)
    lines = [f"{len(landed)}/{len(results)} landed in {secs:.0f}s{resume_tally}"
             + (f" ({note})" if note else "")]
    lines.extend(_report_landed_lines(clean, unfinished, refused))
    lines.extend(_report_terminated_lines(results))
    lines.extend(_report_resume_lines(results))
    if unfinished:
        lines.append("A LANDED-but-unfinished chat IS in its new account - do not re-move it; "
                     "finish its tidy-up (settle the source row / stamp the mode) by hand.")
    if refused:
        lines.append("A skipped chat was NOT moved - re-run it once its engine is idle.")
    return "\n".join(lines)


def _emit(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def _resolve_all_unarchived(parsed):
    """Populate `parsed.chats` for --all-unarchived. Returns the batch `note` string on
    success, or an int exit code the caller must return unchanged on refusal."""
    try:
        rows, note = _movable_chats(parsed.source, parsed.limit)
    except _UnknownSource as err:
        # NOT EXIT_NONE. An empty batch and an account that does not exist look identical
        # to a caller who only reads `moved`, and one of them means the work is still
        # sitting there untouched.
        return _emit({"ok": False, "moved": 0, "results": [],
                      "report": f"REFUSED (deterministic): {err}"}, parsed.as_json, EXIT_REFUSED)
    # Resolve by SESSION ID, never by title: two accounts can hold the same title, and a
    # fuzzy re-match at move time could pick the wrong one.
    parsed.chats = [str(r.get("session_id") or "") for r in rows if r.get("session_id")]
    # --all-unarchived names no per-chat title (nothing here read one new name per chat), so
    # `chat_titles` is rebuilt in lockstep - all None, same length as the fresh `chats`.
    parsed.chat_titles = [None] * len(parsed.chats)
    return note


def _refuse_if_no_chats(parsed, note: str):
    if parsed.chats:
        return None
    # An account that RESOLVED and is genuinely empty is a different fact from a caller
    # who named nothing, and telling the first one to "use --all-unarchived" when that is
    # exactly what it did is how a real answer gets mistaken for a usage error.
    report = (f"nothing to move: {note}" if parsed.all_unarchived and note
              else ("nothing to move: name chats with --chat, or use "
                    "--all-unarchived (optionally with --from)"))
    return _emit({"ok": False, "moved": 0, "results": [], "report": report}, parsed.as_json, EXIT_NONE)


def _refuse_via_archive_gate(parsed):
    # THE ARCHIVE STOPGAP - after the chat list is final (so --all-unarchived is covered too),
    # and before a single chat is touched. Refuses the batch WHOLE; see _archive_gate.
    gate = _archive_gate(parsed)
    if gate is None:
        return None
    code, report = gate
    return _emit({"ok": False, "moved": 0, "results": [], "report": report}, parsed.as_json, code)


def _run_resume_phase(items: list, parsed) -> dict:
    # PHASE FOUR, only on a real run: a dry run lands nothing, so there is nothing to wake.
    # Bounded exactly like phases two and three (module-level RESUME_PHASE_TIMEOUT_SECS): the
    # courier can wait on an engine it believes is mid-turn, and that must never hold the
    # batch's report hostage - see `_mark_unresumed_after_timeout`.
    landed_for_resume = [i for i in items if i.payload.get("landed") and i.payload.get("sessionId")]
    resume_box: dict = {}

    def _do_resume() -> None:
        resume_box["tally"] = _resume_landed(items, parsed.resume_text)

    resume_budget = RESUME_PHASE_TIMEOUT_SECS * max(1, len(landed_for_resume))
    if _run_bounded("resume", resume_budget, _do_resume):
        return resume_box.get("tally") or {"asked": len(landed_for_resume),
                                            "delivered": 0, "staged": 0}
    resume = {
        "asked": len(landed_for_resume),
        "delivered": sum(1 for i in landed_for_resume
                          if isinstance(i.payload.get("resume"), dict)
                          and i.payload["resume"].get("delivered")),
        "staged": sum(1 for i in landed_for_resume
                      if isinstance(i.payload.get("resume"), dict)
                      and i.payload["resume"].get("staged")),
        "timedOut": True,
        "why": (f"the resume phase did not finish within {resume_budget:.0f}s - read "
                "each chat's own `resume` block, never trust this summary alone"),
    }
    _mark_unresumed_after_timeout(landed_for_resume, resume_budget)
    return resume


#: PHASE FIVE's budget, per chat. It is one store scan and, at worst, one re-settle - the same
#: work phase two already did - so it is bounded like every other phase rather than trusted.
RECHECK_PHASE_TIMEOUT_SECS = 90.0


def _recheck_one_settle(item, fleet: dict) -> dict:
    """Re-read ONE provisionally-settled source row and repair it if the app undid the settle."""
    land = item.landing
    sid = str(land.session_id or "")
    src = str(land.src_instance or (land.match or {}).get("instance") or "")
    out = {"sessionId": sid, "source": src, "cameBack": False, "repaired": False}
    visible = migrate_chat.source_still_visible(sid, src, fleet)
    if visible:
        # The app wrote its UN-ARCHIVED copy back over the settle. Re-drive the phase - the same
        # call `migrate_reconcile --finish` makes, inventing no actuator of its own.
        out["cameBack"] = True
        try:
            migrate_chat.phase_settle(land)
            out["repaired"] = land.source_row in ("settled", "flagged", "none")
            out["sourceRow"] = land.source_row
        except Exception as err:
            item.errors.append(f"the source row came back and re-settling it raised "
                               f"{type(err).__name__}: {str(err)[:150]}")
            out["why"] = f"{type(err).__name__}: {str(err)[:150]}"
        return out
    # Not visible - but an ARCHIVED resurrection is still a resurrection (the 2026-09-18 pair
    # came back archived), and only the tombstone can see that one.
    tomb = migrate_chat.clear_resurrected_source_record(sid, src, land.target, fleet)
    if tomb:
        out["cameBack"] = True
        out["repaired"] = True
        out["sourceRow"] = "settled"
        out["detail"] = "the record was re-saved by the source app and tombstoned again"
    return out


def _recheck_provisional_settles(items: list) -> dict | None:
    """PHASE FIVE: re-read every source row that was settled against a RUNNING app.

    ⛔ WHY THIS PHASE EXISTS (2026-09-18, and the owner had to clean it up by hand). A two-chat
    move off a running #15 settled both source rows and tombstoned both records; `list_chats`
    read `all: 200, unarchived: 0` and the move was reported settled. Seventy-five minutes later
    the same call read `all: 202` - the app had held both chats in memory and written them back.
    A disk read taken seconds after a settle cannot answer what a running app will write NEXT,
    so the only honest verdict at that moment is "provisional", and the only way to improve on it
    is to look again later. This phase is the later look the batch can afford: it runs after the
    resume phase, which is minutes of real time on any batch that has one.

    It is not the whole guarantee and does not pretend to be - an app can write back after this
    too. That is why `phase_stamp` also leaves the journal owed (`stamped-source-running`), so
    `migrate_reconcile` keeps re-checking the row on its own clock long after this process is
    gone. This phase catches the common case at once; reconcile catches the rest.
    """
    live = [i for i in items
            if i.landing is not None and i.payload.get("sourceRowProvisional")]
    if not live:
        return None
    try:
        fleet = hydralib.fleet()
    except hydralib.DaemonError as err:
        for item in live:
            item.payload["sourceRowRecheck"] = {
                "checked": False,
                "why": f"the fleet could not be re-read ({str(err)[:120]}) - the source rows are "
                       "still PROVISIONAL; run `migrate_reconcile` before calling this move done",
            }
        return {"checked": 0, "cameBack": 0, "repaired": 0, "why": str(err)[:160]}

    box: dict = {"rows": []}

    def _all() -> None:
        for item in live:
            got = _recheck_one_settle(item, fleet)
            item.payload["sourceRowRecheck"] = {"checked": True, **got}
            if got["cameBack"]:
                # The payload's own settle verdict must follow the repair, not the first attempt.
                item.payload["sourceRow"] = got.get("sourceRow") or item.payload.get("sourceRow")
                item.payload["sourceSettled"] = got["repaired"]
            box["rows"].append(got)

    budget = RECHECK_PHASE_TIMEOUT_SECS * len(live)
    if not _run_bounded("recheck", budget, _all):
        for item in live:
            item.payload.setdefault("sourceRowRecheck", {
                "checked": False,
                "why": f"the re-check phase timed out after {budget:.0f}s - this source row is "
                       "still PROVISIONAL; run `migrate_reconcile` before calling this move done",
            })
        return {"checked": len(box["rows"]), "cameBack": 0, "repaired": 0, "timedOut": True}
    rows = box["rows"]
    return {
        "checked": len(rows),
        "cameBack": sum(1 for r in rows if r["cameBack"]),
        "repaired": sum(1 for r in rows if r["repaired"]),
    }


def _batch_ids(items: list) -> set[str]:
    """Every id the batch was given, read right after phase one while each landing still
    carries its dossier match: the records the batch is ALLOWED to archive (its own source rows
    and twins). A refused chat counts too - it was named, so a change to it is not a bystander's."""
    ids: set[str] = set()
    for item in items:
        land = item.landing
        if land is not None:
            ids |= archivewatchlib.ids_for_match(getattr(land, "match", None),
                                                 getattr(land, "session_id", None))
        ids |= archivewatchlib.ids_for_match(None, (item.payload or {}).get("sessionId"))
    return ids


def _build_batch_payload(items: list, parsed, note: str, secs: float, resume) -> dict:
    results = [i.payload for i in items]
    landed = sum(1 for r in results if r.get("landed"))
    # `moved` counts LANDINGS (the chat is in its new account); `ok` demands that every chat
    # also FINISHED its tidy-up. A chat that landed and then crashed in a later phase is moved
    # and not ok, and the batch is partial - never "not moved".
    finished = sum(1 for r in results if r.get("ok"))
    # A dry run's success is "every plan resolved", not "everything landed" - nothing landed
    # by construction, and grading it against landings reports a working plan as a failure.
    planned_ok = parsed.dry_run and all(r.get("exitCode") == 0 for r in results)
    all_ok = planned_ok or finished == len(results)
    payload = {
        "ok": all_ok,
        "moved": landed,
        "asked": len(results),
        "refused": len(results) - landed,
        "unfinished": 0 if parsed.dry_run else landed - finished,
        "secs": round(secs, 2),
        "secsPerChat": round(secs / max(1, len(results)), 2),
        "dryRun": parsed.dry_run,
        "results": results,
        "report": _report(results, note, secs),
    }
    if resume is not None:
        # The batch-level tally: `asked` landed chats were told to carry on, `delivered` of
        # them took it, `staged` still hold the reply. Present only when --resume ran.
        payload["resume"] = resume
    # ⛔ THE SOURCE-SIDE WARNING LEADS, because the one time it mattered the owner found out by
    # opening his own sidebar (2026-09-18). A row settled against a RUNNING app can come back;
    # phase five looked once, and whatever it found has to be in the PROSE, not only the JSON.
    provisional = [r for r in results if r.get("sourceRowProvisional")]
    if provisional:
        came_back = [r for r in provisional
                     if (r.get("sourceRowRecheck") or {}).get("cameBack")]
        unchecked = [r for r in provisional
                     if not (r.get("sourceRowRecheck") or {}).get("checked")]
        lines = []
        if came_back:
            lines.append(
                f"⚠ {len(came_back)} source row(s) CAME BACK after the settle - the source app "
                "re-saved them from memory; they were settled again here. Re-read the source "
                "before calling this move done.")
        if unchecked:
            lines.append(
                f"⚠ {len(unchecked)} source row(s) are still PROVISIONAL - not re-checked. Run "
                "`migrate_reconcile` (and `--finish` anything it calls unsettled).")
        if not came_back and not unchecked:
            lines.append(
                f"note: {len(provisional)} source row(s) were settled against a RUNNING app and "
                "re-read afterwards - all still settled. The journal keeps them owed until "
                "`migrate_reconcile` has seen them once more.")
        payload["report"] = "\n".join(lines) + "\n" + payload["report"]
    return payload


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    parsed = _parse(argv)
    if isinstance(parsed, int):
        return parsed

    note = ""
    if parsed.all_unarchived:
        resolved = _resolve_all_unarchived(parsed)
        if isinstance(resolved, int):
            return resolved
        note = resolved

    refusal = _refuse_if_no_chats(parsed, note)
    if refusal is not None:
        return refusal

    refusal = _refuse_via_archive_gate(parsed)
    if refusal is not None:
        return refusal

    if len(parsed.chats) > 1 and "--title" in parsed.passthrough:
        print("--title renames ONE chat; it cannot be right for a batch of several.",
              file=sys.stderr)
        return 2

    t0 = time.time()
    # THE COLLATERAL WATCH (lib/archivewatchlib): read before the first chat moves - the
    # 2026-09-16 bystander in another account went archived during PHASE ONE, not the settle.
    before = None if parsed.dry_run else archivewatchlib.snapshot()
    # PHASE ONE across every chat, then the finishing phases across every chat (_run_phases).
    items = [_move_one(q, parsed.passthrough, terminate_live=parsed.terminate_live,
                        chat_title=parsed.chat_titles[idx] if idx < len(parsed.chat_titles) else None)
             for idx, q in enumerate(parsed.chats)]
    moved_ids = _batch_ids(items)
    _run_phases(items)
    # A landed chat's payload was just rebuilt by the finishing phases; put the terminate
    # verdict back on it. (A refused chat already carries its own.)
    for item in items:
        _attach_terminated(item)

    resume = _run_resume_phase(items, parsed) if parsed.resume_text and not parsed.dry_run else None
    # PHASE FIVE, after the resume has spent real time: did a running source app write any
    # settled row back? (_recheck_provisional_settles - the 2026-09-18 resurrection.)
    recheck = None if parsed.dry_run else _recheck_provisional_settles(items)
    secs = time.time() - t0

    payload = _build_batch_payload(items, parsed, note, secs, resume)
    if recheck is not None:
        payload["sourceRecheck"] = recheck
    migrate_chat.flag_collateral(payload, before, moved_ids,
                                 f"migrate_batch {len(items)} chat(s)")
    print(json.dumps(payload, indent=2) if parsed.as_json else payload["report"])
    if payload["ok"]:
        return EXIT_OK
    return EXIT_PARTIAL if payload["moved"] else EXIT_NONE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
