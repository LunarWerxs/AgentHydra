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

Usage: python migrate_chat.py <title fragment | session id> --to <instance num|name|dir|best>
       [--from <instance>] [--now] [--title "New title"] [--force] [--stop-idle]
       [--idle-wait N] [--dry-run] [--json]
  <title>       matched exactly first, then FUZZILY: case, punctuation and a misspelling
                ("arkitecht cleanup" finds "Arkitekt cleanup") - every word of the query must
                closely match a word of the title. Two different chats that both fit stay a
                deterministic refusal naming both; a title that fits one chat is that chat.
  --from X      the chat lives on THIS instance (num, name, label or email): scopes the
                search to it, so the same title on two accounts is not ambiguous, and a typo
                cannot select a chat on an account you did not name.
  --to best     pick the target: the RUNNING desktop instance with the most real headroom
                (tier x remaining weekly %, from the daemon's own usage survey), never the
                source, never an account with no usage read or a 5-hour window at the wall.
  --now         A PERSON'S MOVE (the MCP move_chat tool passes it): a chat whose turn is
                finished and whose transcript shows NO background job outstanding is idle
                after NOW_QUIET_SECS (15s), not the standing 300s. The 300s window existed to
                tell "waiting" from "background work" by time alone; this reads the work
                itself (enginelib.background_work). An outstanding job, a working engine, a
                stuck engine and a live writer all keep every rail they have.
  --dry-run     resolve the chat, the target, the hold and the engine's idleness, print the
                plan, and STOP - nothing is posted, nothing is stopped, nothing is counted.
  --stop-idle   a chat whose engine is alive but IDLE (finished its turn, quiet 5+ min) is
                stopped deliberately first, and confirmed gone, then moved - the desktop
                never stops an engine on its own, so without this no desktop chat could ever
                move (owner: "only chats that are stopped, waiting, chilling"). A working or
                stuck engine still refuses. The sweep's move and land lanes pass it.
                A chat parked at a USAGE WALL (the daemon's limit_stop.pending, read from the
                CLI's own error record) is idle AT ONCE - no quiet window: its engine cannot
                write until the account resets, and it is the chat you most want moved.
                Every report ends with per-phase seconds ([12.3s: resolve 1.1 · import ...]).
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
chat, but it is reported, never hidden. And (c) - owner, 2026-09-04, "when moving, ALWAYS
change to bypass permissions" - the landed record is WATCHED for a few seconds after the
stamp: the app boots the chat within ~2s of landing and its boot re-save can put the old
mode back, so the mode is re-read from disk until it has stayed bypass, re-stamped if it
flipped, and the payload's `permissionMode` is what the disk said LAST, never what was written.
"""

from __future__ import annotations

import difflib
import json
import re
import time
import sys
from dataclasses import dataclass
from pathlib import Path as _Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib
from lib import mutationlib
from lib import stamplib


ELIDED = ("…", "...")

# --idle-wait is bounded no matter what a caller passes. Six minutes covers the one thing it
# is for (a 300s quiet window that has partly elapsed) with headroom; anything longer is a
# caller wanting a scheduler, not a flag, and a script that can block indefinitely is a
# script that will one day wedge a lane behind it.
IDLE_WAIT_CAP = 360
# How often to re-ask while waiting, when the deficit is not itself the answer.
IDLE_WAIT_POLL_SECS = 15
# How long to give the source app to write its archive flag after its own control settled
# the row. Polled, not slept: the usual case lands in well under a second.
SETTLE_CONFIRM_SECS = 3.0
# How long the landed record is watched for the app's boot re-save putting a prompting mode
# back (owner, 2026-09-04: a move must ALWAYS leave the chat on bypassPermissions). The app
# boots a landed chat within ~2s; its re-save follows. Polled every second, re-stamped on a
# flip, and only a mode that STAYS bypass is reported as bypass.
BYPASS_WATCH_SECS = 8.0
# Fuzzy title matching: every query word must match some title word at least this closely
# (difflib ratio), OR the whole normalized query must match the whole title this closely.
# 0.8 lets one letter-pair slip in a nine-letter word ("arkitecht"/"arkitekt" = 0.82) and
# still rejects "cleanup" against "expansion" (0.25).
FUZZY_WORD_RATIO = 0.8
FUZZY_WHOLE_RATIO = 0.85
# Two candidates whose scores are this close are a tie, and a tie is a refusal, not a pick.
FUZZY_TIE_MARGIN = 0.05


def _wait_until(pred, timeout_secs: float, step_secs: float = 0.25) -> bool:
    """Poll `pred` until it is true or `timeout_secs` elapse. True if it came true."""
    deadline = time.time() + timeout_secs
    while True:
        if pred():
            return True
        if time.time() >= deadline:
            return False
        time.sleep(step_secs)


class _Stopwatch:
    """Per-phase seconds for the report, so 'that took a minute' becomes 'settle took 41s'.
    Built after a 46s move whose time could not be attributed to anything (2026-09-04)."""

    def __init__(self) -> None:
        self.t0 = time.time()
        self.mark = self.t0
        self.phases: dict[str, float] = {}

    def lap(self, name: str) -> None:
        now = time.time()
        self.phases[name] = round(self.phases.get(name, 0.0) + (now - self.mark), 2)
        self.mark = now

    def total(self) -> float:
        return round(time.time() - self.t0, 2)

    def text(self) -> str:
        parts = " · ".join(f"{k} {v:.1f}" for k, v in self.phases.items() if v >= 0.05)
        return f" [{self.total():.1f}s: {parts}]" if parts else f" [{self.total():.1f}s]"


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


def _norm_title(text: str) -> str:
    """Lower-case, punctuation folded to spaces, whitespace collapsed - the shape both sides
    of a fuzzy comparison are put in, so case and punctuation can never be the difference."""
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def fuzzy_title_score(query: str, title: str) -> float:
    """0.0-1.0: how well `query` names `title`. 1.0 is a normalized substring (the old exact
    rule); below that, the weaker of (a) every query word's best match against a title word
    and (b) the whole-string ratio - whichever criterion the pair clears. A query with a word
    that matches NOTHING in the title ("cleanup" vs "...design critic expansion") scores that
    word's ratio, well under the bar, so a misspelling is forgiven but a different chat is not."""
    q, t = _norm_title(query), _norm_title(title)
    if not q or not t:
        return 0.0
    if q in t:
        return 1.0
    words = t.split()
    per_word = [max((difflib.SequenceMatcher(None, qw, tw).ratio() for tw in words), default=0.0)
                for qw in q.split()]
    word_score = min(per_word) if per_word else 0.0
    whole = difflib.SequenceMatcher(None, q, t).ratio()
    if word_score >= FUZZY_WORD_RATIO or whole >= FUZZY_WHOLE_RATIO:
        return max(word_score, whole)
    return min(word_score, whole)


def _fuzzy_pick(query: str, rows: list[dict]) -> list[dict]:
    """The sessions-table rows `query` names fuzzily: the best-scoring chat alone when it is
    clearly best, every tied chat when it is not (the caller refuses on more than one), and
    nothing when nothing clears the bar. Rows are the daemon's (`title`, `session_id`)."""
    scored = []
    for r in rows:
        s = fuzzy_title_score(query, str(r.get("title") or ""))
        if s >= FUZZY_WORD_RATIO:
            scored.append((s, r))
    if not scored:
        return []
    scored.sort(key=lambda x: -x[0])
    best = scored[0][0]
    top = [r for s, r in scored if best - s <= FUZZY_TIE_MARGIN]
    # The same chat can sit on several rows only through lineage ids; distinct session ids
    # are distinct chats, and one chat at the top is the answer even if it tied with itself.
    if len({r.get("session_id") for r in top}) == 1:
        return top[:1]
    return top


def _in_source(instance_name, source_name: str | None) -> bool:
    return source_name is None or str(instance_name or "").lower() == source_name.lower()


def _row_to_match(row: dict) -> dict:
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


def resolve_for_migrate(query: str, source_name: str | None = None) -> dict:
    """Resolve the chat to migrate. The dossier only knows chats that ALREADY have a desktop
    record - which is exactly what a console-only session lacks, and landing those is this
    script's main job (found live 2026-08-31: every console landing died on 'no chat
    matches'). So: dossier first; on no-match, fall back to the daemon's sessions table and
    build the same match shape from the row. Ambiguity stays a deterministic refusal.

    `source_name` (--from) is the instance the chat is said to live on: dossier matches and
    table rows on any other instance are not candidates. That is what makes a title shared
    by two accounts unambiguous, and what stops a fuzzy match from ever selecting a chat on
    an account the caller did not name.

    THE FUZZY RUNG (2026-09-04, "arkitecht cleanup" for a chat titled "Arkitekt cleanup"):
    an exact-substring miss used to be the end - the operator then spent round trips listing
    the instance's chats to find the spelling. Now the table is scored (fuzzy_title_score); a
    row it names is re-resolved THROUGH THE DOSSIER by its session id, so a chat that has a
    desktop record comes back with its real live block and metaPath (a bare table row has
    neither, and moving on it would post an import against a possibly-live engine)."""
    all_matches = hydralib.dossier(query)
    matches = [m for m in all_matches if _in_source(m.get("instance"), source_name)]
    if source_name and matches and all(m.get("archived") for m in matches):
        # Only a retired twin sits on the named account: the chat itself lives elsewhere. Say
        # where, rather than moving a chat off an account the caller did not name - and this
        # is a final answer, not a miss for the table fallback to second-guess.
        elsewhere = sorted({str(m.get("instance")) for m in all_matches
                            if not m.get("archived") and not _in_source(m.get("instance"), source_name)})
        if elsewhere:
            raise hydralib.ChatNotFound(
                f"{query} - only an archived copy is on {source_name}; its live copy is on "
                f"{', '.join(elsewhere)}")
    try:
        return hydralib.choose_match(query, matches)
    except hydralib.ChatNotFound:
        rows = [r for r in hydralib.sessions() if _in_source(r.get("instance"), source_name)]
        hits = [r for r in rows if r.get("session_id") == query]
        if not hits:
            q = query.lower()
            hits = [r for r in rows if q in str(r.get("title") or "").lower()]
        if not hits:
            hits = _fuzzy_pick(query, rows)
        if not hits:
            raise
        if len(hits) > 1:
            raise hydralib.AmbiguousChat(
                query,
                [{"instance": h.get("instance"), "title": h.get("title"),
                  "cliSessionId": h.get("session_id")} for h in hits],
            ) from None
        row = hits[0]
        sid = str(row.get("session_id") or "")
        if sid and sid != query:
            # Found by title: the dossier may well know this chat under its id even though
            # the misspelled fragment found nothing - prefer its answer (live block, metaPath).
            try:
                by_id = [m for m in hydralib.dossier(sid) if _in_source(m.get("instance"), source_name)]
                if by_id:
                    return hydralib.choose_match(sid, by_id)
            except hydralib.DaemonError:
                pass  # the table row is still a real answer; the daemon's import gates liveness
        return _row_to_match(row)


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


def _source_still_visible(session_id: str, src_instance: str, fleet_data: dict | None = None) -> bool:
    """Does the SOURCE instance's store still carry an un-archived record of this chat? The
    confirm step after a settle: the app's own control said one thing, the disk is the check.

    `fleet_data` is the fleet the caller already holds; only its instance DIRS are read here,
    which do not change mid-move, so re-fetching it per check (measured 2026-09-04: 0.7s warm,
    4.6s cold, and this ran three times per move) bought nothing."""
    from lib import stamplib

    if fleet_data is None:
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


def _archive_source_on_disk(session_id: str, src_instance: str, fleet_data: dict | None = None) -> bool:
    """Last-resort retirement of a superseded source row: flip isArchived on its meta record.

    Weaker than the app's own control (a running app can re-save it away) and deliberately
    scoped to the SOURCE instance only, so the freshly landed copy is never touched.
    `fleet_data`: see _source_still_visible."""
    from lib import stamplib

    if fleet_data is None:
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
    source: str | None = None   # --from: the instance the chat lives on
    now: bool = False           # --now: a person's move, the fast quiet window
    dry_run: bool = False       # --dry-run: plan, post nothing


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
    now = "--now" in argv
    dry_run = "--dry-run" in argv
    to = title = source = None
    idle_wait = 0
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--to" and i + 1 < len(argv):
            to = argv[i + 1]
            i += 2
            continue
        if a == "--from" and i + 1 < len(argv):
            source = argv[i + 1]
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
    if now and not stop_idle:
        stop_idle = True  # --now IS a stop-idle move; saying so twice is not required
    return MigrateArgs(as_json, force, stop_idle, to, title, idle_wait, args[0],
                       source=source, now=now, dry_run=dry_run)


def _resolve_chat_or_raise(query: str, source: str | None = None) -> tuple[dict, dict]:
    """Resolve the chat to migrate plus the fleet, or raise the same refusal main() used to
    return inline. `source` (--from) is resolved to a fleet row FIRST: an instance nobody has
    is a deterministic refusal, not an empty search that reads as 'no such chat'."""
    try:
        fleet = hydralib.fleet()
        source_name = None
        if source:
            src = resolve_instance(fleet, source)
            if src is None:
                known = ", ".join(f"#{i.get('num')} {i.get('name')}" for i in fleet.get("instances", []))
                raise _MigrateRefusal(
                    {"landed": False,
                     "report": f"REFUSED (deterministic): --from names no instance ({source!r}). Known: {known}"},
                    3,
                )
            source_name = str(src.get("name") or "")
        match = resolve_for_migrate(query, source_name)
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        where = f" on {source}" if source else ""
        raise _MigrateRefusal({"landed": False, "report": f"REFUSED (deterministic): {err}{where}"}, 3) from err
    except hydralib.DaemonError as err:
        raise _MigrateRefusal({"landed": False, "report": f"migrate FAILED: {err}"}, 1) from err
    return match, fleet


def _tier_multiplier(fleet_row: dict) -> int:
    """How much quota a 'percent left' is worth on this account: Max 20x = 20, Max 5x = 5,
    Pro (or unknown) = 1. Read off the fleet row's plan label, which the daemon renders from
    the rate-limit tier; the '×' can arrive mojibaked, so only the digits are trusted."""
    label = str((fleet_row.get("account") or {}).get("planLabel") or "")
    m = re.search(r"max\D*(\d+)", label, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return 1


def best_target(fleet: dict, exclude_name: str | None, survey: dict | None = None) -> tuple[dict | None, list[dict]]:
    """--to best: the desktop instance with the most REAL headroom, from the daemon's own
    usage survey. Returns (winner, the ranked shortlist it was chosen from) so the report can
    say who came second and by how much.

    The ranking is deliberately simple and stated: a RUNNING app beats a closed one (a chat
    landed in a closed app sits there until someone opens it); then tier x remaining weekly %
    (Max 20x at 60% used has 8 'Pro-weeks' left, Max 5x at 0% has 5); then the emptier 5-hour
    window. Excluded outright: the source instance, any row without a real usage read
    (severity 'unknown' is not headroom - AgentHydra's own rule), and a 5-hour window at or
    past 95% (that account is walled NOW, whatever its weekly says)."""
    if survey is None:
        survey = hydralib.usage_survey(max_age_secs=120)
    by_num = {int(i.get("num")): i for i in fleet.get("instances", []) if i.get("num") is not None}
    ranked: list[dict] = []
    for row in survey.get("rows", []):
        if row.get("kind") != "desktop":
            continue
        inst = by_num.get(int(row.get("num") or -1))
        if not inst or not inst.get("signedIn", True):
            continue
        if exclude_name and str(inst.get("name", "")).lower() == exclude_name.lower():
            continue
        advice = row.get("advice") or (row.get("result") or {}).get("advice") or {}
        snap = (row.get("result") or {}).get("snapshot") or {}
        week = (snap.get("weekAll") or {}).get("pct")
        sess = (snap.get("session") or {}).get("pct")
        if advice.get("severity") == "unknown" or not isinstance(week, (int, float)):
            continue
        if isinstance(sess, (int, float)) and sess >= 95:
            continue
        mult = _tier_multiplier(inst)
        ranked.append({
            "num": inst.get("num"), "name": inst.get("name"), "isRunning": bool(inst.get("isRunning")),
            "weekPct": week, "sessionPct": sess if isinstance(sess, (int, float)) else None,
            "tierX": mult, "headroom": round(mult * (100 - float(week)), 1),
        })
    ranked.sort(key=lambda r: (not r["isRunning"], -r["headroom"], r["sessionPct"] or 0))
    return (by_num.get(int(ranked[0]["num"])) if ranked else None), ranked


def _resolve_target_or_raise(fleet: dict, to: str, match: dict, session_id: str, chat_title,
                             choice_out: dict | None = None) -> dict:
    """Resolve --to to a real instance, and short-circuit a no-op move. `--to best` asks
    best_target and records its shortlist into `choice_out` for the report."""
    if str(to).strip().lower() == "best":
        try:
            target, ranked = best_target(fleet, str(match.get("instance") or "") or None)
        except hydralib.DaemonError as err:
            raise _MigrateRefusal({"landed": False, "report": f"migrate FAILED: usage survey unavailable ({err})"}, 1) from err
        if choice_out is not None:
            choice_out["ranked"] = ranked[:5]
        if target is None:
            raise _MigrateRefusal(
                {"landed": False, "report": "REFUSED (deterministic): --to best found no desktop instance "
                                            "with a real usage read and headroom (besides the source)."},
                3,
            )
    else:
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


def quiet_window(match: dict, now: bool) -> tuple[int, int, dict | None]:
    """(min_quiet_secs, idle_after_secs, background) for this move. The standing window
    unless --now AND the transcript was scanned AND no background job is outstanding - then
    enginelib.NOW_QUIET_SECS for both. `background` is enginelib.background_work's answer
    (None when --now was not asked, so nothing was scanned) for the report."""
    from lib import enginelib

    if not now:
        return enginelib.IDLE_STOP_SECS, gatelib_idle_after(), None
    bg = enginelib.background_work(match)
    if bg.get("scanned") and not bg.get("outstanding"):
        return enginelib.NOW_QUIET_SECS, enginelib.NOW_QUIET_SECS, bg
    return enginelib.IDLE_STOP_SECS, gatelib_idle_after(), bg


def gatelib_idle_after() -> int:
    from lib import gatelib

    return gatelib.IDLE_AFTER_SECS


def _stop_idle_engine_or_raise(match: dict, query: str, chat_title, session_id: str,
                                idle_wait: int, force: bool, now: bool = False,
                                source_name: str | None = None, notes: dict | None = None) -> dict:
    """--stop-idle's wait dance: stop an engine that is idle, or wait out the one refusal
    (R_TOO_SOON) that more time actually cures, re-checking liveness and any newly-placed
    hold on every lap. Returns the re-resolved match once it is safe to proceed; raises the
    same refusal main() used to return inline otherwise. `now` picks the fast window when
    the transcript shows no background job (quiet_window); `notes` receives what was decided
    so the report can say which window applied and why."""
    from lib import enginelib

    min_quiet, idle_after, bg = quiet_window(match, now)
    if notes is not None:
        notes["quietWindowSecs"] = min_quiet
        if bg is not None:
            notes["backgroundTasks"] = bg
    stopped = enginelib.stop_idle_engine(match, min_quiet, idle_after)
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
            match = resolve_for_migrate(query, source_name)
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
        # Re-decide the window too: a background job the engine launched during the nap
        # would otherwise be stopped under the fast window it no longer qualifies for.
        min_quiet, idle_after, bg = quiet_window(match, now)
        if notes is not None:
            notes["quietWindowSecs"] = min_quiet
            if bg is not None:
                notes["backgroundTasks"] = bg
        stopped = enginelib.stop_idle_engine(match, min_quiet, idle_after)
    if stopped.get("stopped"):
        waited = f" after waiting {int(waited_for)}s" if waited_for else ""
        ledgerlib.annotate("migrate", session_id,
                           f"stopped idle engine pid {stopped.get('pid')}{waited} ({stopped.get('why')})")
        try:
            return resolve_for_migrate(query, source_name)
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
                                  stop_idle: bool, idle_wait: int, force: bool,
                                  now: bool = False, source_name: str | None = None,
                                  notes: dict | None = None) -> dict:
    """Rule 2, absolute: the import rewrites the transcript, and the daemon itself refuses a
    live session - refusing here first keeps the reason honest and the attempt un-spent.
    --stop-idle (live smoke, 2026-09-01) is the one escape hatch: the desktop keeps an engine
    alive indefinitely after the turn ends, so without it every desktop chat had a "live
    writer" forever and nothing could ever move."""
    if match.get("live") and stop_idle:
        match = _stop_idle_engine_or_raise(match, query, chat_title, session_id, idle_wait, force,
                                           now=now, source_name=source_name, notes=notes)
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


def _verify_landing_or_raise(session_id: str, target: dict, chat_title, result: dict,
                              src_instance: str = "") -> list[dict]:
    """Verify the landing: the dossier must now place the chat in the target instance.

    Records the read-back verdict onto the SAME ledger row `main()`'s ledgerlib.note() opened
    (never-claim-landed doctrine): True once the dossier actually shows it, False when the
    dossier came back but disagrees, and UNKNOWN (never False) when the read-back itself could
    not be performed - the daemon posted the import fine, but we genuinely do not know whether
    it landed. unknown must never be silently retried, only surfaced for a person to look at.

    MUTATION LEDGER: the daemon POST already ran by the time this is called - something MAY
    have moved even when this function cannot confirm it - so both refusal branches record an
    unconfirmed (`after=None`, `undoable=False`) mutation rather than staying silent."""
    try:
        after = hydralib.dossier(session_id)
    except hydralib.DaemonError as err:
        ledgerlib.verify("migrate", session_id, None, note=f"verify read-back failed: {err}")
        mutationlib.record(
            "migrate", session_id, instance=target.get("name") or "", title=str(chat_title),
            before={"instance": src_instance}, after=None, undoable=False,
            why_not=f"the import was posted but verify failed ({err}) - the resulting "
                    "location is unconfirmed, so no inverse can be trusted",
        )
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
        mutationlib.record(
            "migrate", session_id, instance=target.get("name") or "", title=str(chat_title),
            before={"instance": src_instance}, after=None, undoable=False,
            why_not="the import was posted but the dossier does not show the chat in the "
                    "target instance yet - unconfirmed, so no inverse can be trusted",
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


def _settle_source_row(match: dict, target: dict, fleet: dict, session_id: str,
                       chat_title) -> tuple[str, str]:
    """Settle the superseded SOURCE row (_settle_source docstring).

    Returns (report suffix, STATE) where state is the machine half - 'none' nothing to
    settle, 'settled' the app's own control did it, 'flagged' the disk flag did it (weaker;
    a running app could re-save it, and the twins lane keeps watch), 'visible' the twin is
    still there. ⛔ CALLERS BRANCH ON THE STATE, NEVER ON THE PROSE: a batch caller sniffing
    the sentence for "STILL VISIBLE" is how nine warnings turned into nine ticks.
    """
    src_name = str(match.get("instance") or "")
    if not src_name or src_name.lower() == str(target.get("name", "")).lower():
        return "", "none"
    src_inst = resolve_instance(fleet, src_name)
    # A CLOSED APP IS NOT AUTOMATICALLY SETTLED (found live 2026-09-04: two closed-instance
    # twins from older moves). The import is supposed to flag the source copy on disk; this
    # verifies that it did, which costs one store scan and is the difference between "a move
    # is a move" and a claim.
    if not (src_inst and src_inst.get("isRunning")):
        if not _source_still_visible(session_id, src_name, fleet):
            return "", "none"
        return ((" Source row flagged archived on disk in the closed instance "
                 f"{src_name} (the import had not)."), "flagged") \
            if _archive_source_on_disk(session_id, src_name, fleet) else \
            (f" ⚠ Source row is STILL VISIBLE in {src_name} and its flag could not be "
             "written. Not claiming a clean move.", "visible")
    code_s, out_s = _settle_source(src_name, str(chat_title))
    # DOUBLE-CHECK, NEVER ASSUME (owner, 2026-09-01: "it can't do it blind; it must always
    # double check, confirm"). Exit 3 used to be read as "already settled"; a row the app
    # virtualized off-screen is not rendered AND still visible when scrolled. So the source
    # meta is re-read from disk after the settle, and only an archived flag that STAYS
    # archived counts - otherwise the twin is named, the attempt annotated, and the twins
    # lane keeps settling it every pass.
    if code_s in (0, 3):
        # The app writes the flag on its own schedule, usually well under a second; poll for
        # it rather than sleeping a flat 2s (the old shape) and then looking once. Then look
        # once more after a beat: only a flag that STAYS archived counts (a running app can
        # re-save it away), which is what the old single look after 2s was really testing.
        if _wait_until(lambda: not _source_still_visible(session_id, src_name, fleet),
                       SETTLE_CONFIRM_SECS):
            time.sleep(0.5)
            if not _source_still_visible(session_id, src_name, fleet):
                return " Source row settled through its app's own control (verified on disk).", "settled"
        # ⛔ NEVER LEAVE THE SOURCE VISIBLE (owner, 2026-09-01) - and this branch used to do
        # exactly that: it warned and stopped, so a window that renders no rows (minimized,
        # collapsed, virtualized) returned exit 3 and every move off it left a twin nobody
        # cleared. Nine of them, live, 2026-09-04. The flag is weaker under a running app,
        # and weaker beats a twin: that app never rendered the row, so there is nothing on
        # screen for it to re-save from, and the ghost sweep finishes it when it does.
        if _archive_source_on_disk(session_id, src_name, fleet) and \
                not _source_still_visible(session_id, src_name, fleet):
            return ((f" Source row in {src_name} did not answer its app's own control "
                     f"(exit {code_s}); its archive flag was written on disk instead - the "
                     "ghost sweep clears the row the moment that app renders it."), "flagged")
        ledgerlib.annotate("migrate", session_id,
                           f"landed in {target.get('name')} but the source row in "
                           f"{src_name} is still visible (settle exit {code_s})",
                           failure=True)
        return (f" ⚠ Source row in {src_name} is STILL VISIBLE after the settle "
                f"(actuator exit {code_s}) - a twin is on screen; the twins lane "
                "will keep settling it. Not claiming a clean move.", "visible")
    # The app's own control is the immediate and durable route, but it can fail - an
    # ambiguous title, a row not rendered - and every one of those failures left a twin on
    # screen until a later sweep caught it.
    fallback = _archive_source_on_disk(session_id, src_name, fleet)
    return (
        (f" Source row could not be settled through the app ({code_s}); its archive "
         "flag was written on disk instead - it clears at that app's next restart."), "flagged"
    ) if fallback else (
        (f" Source row NOT settled (actuator said: "
         f"{(out_s.splitlines()[-1][:100] if out_s else code_s)}) - a stale twin "
         f"may linger in {src_name}; archive it there."), "visible"
    )


def watch_bypass(meta_path: str, watch_secs: float = BYPASS_WATCH_SECS,
                 sleep=time.sleep, clock=time.time) -> dict:
    """Keep the landed record on bypassPermissions THROUGH the app's boot re-save.

    Reads the mode back from disk once a second for `watch_secs`; any read that is not
    bypass is re-stamped (stamplib.stamp_doctrine) and counted. Returns {mode, flips,
    stable}: `mode` is what the disk said on the LAST read - never what was written - and
    `stable` is whether the final second of the watch saw bypass hold. A record that cannot
    be read reports mode None; the caller says so rather than claiming bypass."""
    flips = 0
    mode = None
    deadline = clock() + watch_secs
    while True:
        try:
            meta = stamplib.read_meta(meta_path)
            mode = meta.get("permissionMode")
        except (OSError, ValueError):
            mode = None
        if mode != stamplib.BYPASS:
            got = stamplib.stamp_doctrine(meta_path)
            if got.get("bypass"):
                flips += 1
                mode = stamplib.BYPASS
        if clock() >= deadline:
            break
        sleep(1)
    return {"mode": mode, "flips": flips, "stable": mode == stamplib.BYPASS}


def _stamp_automation_doctrine(session_id: str, target: dict, after: list[dict]) -> tuple[bool, str, bool, str, str | None]:
    """The automation doctrine (module docstring): stamp bypassPermissions on every verified
    landing, and ultracode, mechanically, into the landed chat's meta record (stamplib
    docstring). Returns (stamped, stamp_note, ultracode_ok, ultracode_note, permission_mode)
    where permission_mode is what the disk said LAST (watch_bypass), or None when no record
    could be read."""
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
        # ALWAYS BYPASS, VERIFIED, NOT HOPED (owner, 2026-09-04): watch the record through the
        # app's boot re-save and re-stamp any flip; report what the disk said last.
        watched = watch_bypass(meta_path)
        mode = watched["mode"]
        if watched["flips"]:
            uc_note += (f"; the app re-saved a prompting mode {watched['flips']}x during the "
                        f"{int(BYPASS_WATCH_SECS)}s watch and was re-stamped each time")
        if not watched["stable"]:
            uc_note += f" - ⚠ permissionMode on disk is {mode!r}, NOT bypass; re-stamp before it runs"
            stamped = False
    else:
        uc_ok = False
        mode = None
        uc_note = "not stamped - the dossier gave no metaPath; run automation_chat.py on it"
    return stamped, stamp_note, uc_ok, uc_note, mode


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
    now, source, dry_run = parsed.now, parsed.source, parsed.dry_run

    sw = _Stopwatch()
    notes: dict = {}  # what the fast path decided (window, background scan, target choice)
    try:
        match, fleet = _resolve_chat_or_raise(query, source)
        session_id = match.get("cliSessionId") or ""
        chat_title = match.get("title")
        door_title = _untruncated_title(session_id, chat_title)
        src_name = str(match.get("instance") or "")
        sw.lap("resolve")

        choice: dict = {}
        target = _resolve_target_or_raise(fleet, to, match, session_id, chat_title, choice_out=choice)
        if choice:
            notes["targetChoice"] = choice
        if dry_run:
            return out(_dry_run_plan(match, target, session_id, chat_title, now, notes, sw), as_json, 0)
        _check_hold_or_raise(session_id, force)
        match = _settle_live_writer_or_raise(match, query, chat_title, session_id, stop_idle, idle_wait, force,
                                             now=now, source_name=src_name or None, notes=notes)
        sw.lap("stop-idle")
        _check_breaker_or_raise(session_id, force)

        body = _build_import_body(target, title, door_title, force)
        _pretrust_workspace(session_id)

        ledgerlib.note("migrate", session_id, note=f"'{chat_title}' -> {target.get('name')}")
        result = _post_import_or_raise(session_id, target, body)
        sw.lap("import")
        after = _verify_landing_or_raise(session_id, target, chat_title, result,
                                          src_instance=str(match.get("instance") or ""))
        sw.lap("verify")
    except _MigrateRefusal as refusal:
        refusal.payload["secs"] = sw.total()
        refusal.payload["timings"] = sw.phases
        refusal.payload.update(notes)
        return out(refusal.payload, as_json, refusal.code)

    # MUTATION LEDGER: before = where it lived, after = the verified landing target. Recorded
    # unconditionally on a VERIFIED landing (we only reach here once _verify_landing_or_raise
    # has confirmed the dossier places the chat in the target) - the source-settle outcome
    # below does not change WHERE the chat is, only whether a stale twin lingers, so it is not
    # part of the before/after pair an undo (migrate back) needs.
    src_instance = str(match.get("instance") or "")
    mutationlib.record("migrate", session_id, instance=target.get("name") or "", title=str(chat_title),
                       before={"instance": src_instance}, after={"instance": target.get("name")},
                       undoable=True)

    # (The 'migrate' attempt is cleared below, AFTER the settle - a landing whose source row
    # is still visible is not a clean move, and its annotation must have a row to land on.)
    settle_note, source_row = _settle_source_row(match, target, fleet, session_id, chat_title)
    sw.lap("settle-source")
    if source_row != "visible":
        ledgerlib.clear("migrate", session_id)  # a clean move: the brake is for futility

    stamped, stamp_note, uc_ok, uc_note, mode = _stamp_automation_doctrine(session_id, target, after)
    sw.lap("stamp")

    return out(
        {
            "landed": True,
            "sessionId": session_id,
            "title": chat_title,
            "from": src_instance,
            "to": target.get("name"),
            "toNum": target.get("num"),
            "bypassStamped": stamped,
            "permissionMode": mode,
            "ultracodeStamped": uc_ok,
            # sourceRow is the machine half; sourceSettled stays for older readers.
            "sourceRow": source_row,
            "sourceSettled": source_row in ("settled", "flagged", "none"),
            "daemon": result,
            "secs": sw.total(),
            "timings": sw.phases,
            **notes,
            "report": (
                f"landed and VERIFIED: '{chat_title}' now lives in {target.get('name')}. "
                f"{stamp_note}; {uc_note}.{settle_note}{sw.text()}"
            ),
        },
        as_json,
        0,
    )


def _dry_run_plan(match: dict, target: dict, session_id: str, chat_title, now: bool,
                  notes: dict, sw: _Stopwatch) -> dict:
    """--dry-run: everything the move would decide, decided, and nothing done. The hold is
    read (not enforced), the engine's idleness is read under the window --now would pick,
    and the background scan is reported - so a caller can see 'would wait 240s' or 'HELD'
    before spending the act."""
    from lib import enginelib

    held = holdlib.why_blocked(session_id)
    min_quiet, idle_after, bg = quiet_window(match, now)
    idle = enginelib.idle_report(match, min_quiet, idle_after) if match.get("live") else None
    if idle is None:
        would = "no live engine - the import would post at once"
    elif idle.get("idle"):
        would = f"engine idle ({idle.get('why')}) - it would be stopped and the import posted"
    elif idle.get("reason") == enginelib.R_TOO_SOON:
        deficit = int(idle.get("needs_secs") or 0) - int(idle.get("quiet_secs") or 0)
        would = f"engine quiet only {idle.get('quiet_secs')}s - --idle-wait would sleep ~{max(deficit, 0)}s first"
    else:
        would = f"REFUSE: {idle.get('why')}"
    sw.lap("dry-run")
    return {
        "dryRun": True,
        "landed": False,
        "sessionId": session_id,
        "title": chat_title,
        "from": match.get("instance"),
        "to": target.get("name"),
        "toNum": target.get("num"),
        "held": held,
        "live": match.get("live"),
        "quietWindowSecs": min_quiet,
        "backgroundTasks": bg,
        "idle": idle,
        "secs": sw.total(),
        "timings": sw.phases,
        **notes,
        "report": (f"DRY RUN: would move '{chat_title}' ({session_id[:8]}) from {match.get('instance')} "
                   f"to {target.get('name')} (#{target.get('num')}). "
                   + (f"HELD: {held} " if held else "")
                   + would + f". Quiet window {min_quiet}s"
                   + (f"; {bg.get('why')}" if bg else "") + f".{sw.text()}"),
    }


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
