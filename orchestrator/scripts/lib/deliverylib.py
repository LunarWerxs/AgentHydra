"""deliverylib - THE STAGING LEDGER: replies decided but not yet sent.

The courier's memory, and the reason staging is a separate act from sending. v1 delivered
things it had decided moments earlier against a world that had changed; the shape that
survives is: write the reply down (with the chat it is for and the evidence it was based on),
then deliver as a distinct act that re-checks everything immediately before typing.

A staged reply nobody sent is visible and harmless. A sent reply nobody checked is how work
gets corrupted. So every entry carries its whole life: who staged it, on what evidence, when
it was delivered, and what happened.

States:
  staged      decided, written down, not sent
  delivered   typed into the chat AND the chat was observed to move afterwards
  failed      the courier tried and could not land it (reason recorded; attempts counted)
  cancelled   a person withdrew it before it went
  expired     it waited too long, or its premise stopped being true - never sent, never lost

WHY `expired` EXISTS (2026-09-07, reproduced 09-09; fixed 09-10). A staged reply had no end:
the queue held rows up to six days old, several of them migration notices reading "this chat
was migrated from X to Y" for chats that had since been migrated BACK. Arming the tray on
that queue would have delivered a batch of statements that were no longer true. The fix is
NOT to delete them - a decision nobody acted on must not silently disappear, which is exactly
why _prune leaves staged rows alone. It is to give a staged reply a shelf life and a premise,
and to move it to a terminal state that is still READABLE in --list, with the reason on it.
Two things end a staged reply: age past STAGED_TTL_SECS, and a premise that has gone void
(the courier expires a notice whose chat has changed accounts since it was written).

State lives beside the attempt ledger and the holds file in <repo>/state/deliveries.json
(override: ORCHESTRATOR_STATE_DIR), same atomic-write discipline.
"""

from __future__ import annotations

import json
import os
import re as _re
import time
import uuid
from pathlib import Path

from lib import joblocklib, ledgerlib

VALID_STATES = ("staged", "delivered", "failed", "cancelled", "expired")

# HOW LONG A DECIDED-BUT-UNSENT REPLY STAYS TRUE. A staged reply is a judgment about a chat's
# situation at a moment; two days later that situation is someone else's. Measured 2026-09-10:
# 37 staged rows, the oldest 5.9 days, addressed to accounts some of which no longer exist by
# that name. This is deliberately generous - the courier retries every 5 minutes, so a reply
# that has not gone in two days is not waiting on a cycle, it is waiting on something that
# never happened.
STAGED_TTL_SECS = 48 * 3600

# A DEFERRAL IS NOT A FAILURE, BUT IT IS NOT FREE EITHER. The courier defers a delivery whose
# refusal is transient (the target app is closed, the daemon dropped the socket) and leaves the
# row staged. Without a ceiling that is an infinite retry against a chat nobody will ever open
# again, which is how the queue filled with rows retried into a wall for days.
MAX_DEFERRALS = 12

# A settled row (delivered/failed/cancelled) this old has nothing left to say: nobody reads
# deliveries.json for its history, only for what is pending or recent (recent_delivery(),
# RECENT_DELIVERY_SECS = 180 - four orders of magnitude under this). Left unpruned, 228 rows
# and climbing meant every stage/mark/cancel rewrote a file that only grows (found 2026-09-01).
# STAGED rows are never touched here - a reply nobody has acted on is not "settled" no matter
# how old, and pruning it would silently disappear a decision nobody made yet.
PRUNE_AFTER_SECS = 14 * 24 * 3600


def _path() -> Path:
    return ledgerlib._state_dir() / "deliveries.json"


def _load() -> list[dict]:
    try:
        raw = json.loads(_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    rows = raw.get("deliveries", []) if isinstance(raw, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def _prune(rows: list[dict], now_ms: int | None = None) -> list[dict]:
    """Drop settled rows (delivered/failed/cancelled) whose newest timestamp is older than
    PRUNE_AFTER_SECS. "Newest" is deliveredAt when set, else stagedAt - a failed or cancelled
    row never gets a deliveredAt, so it ages from when it was staged."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    floor = now_ms - PRUNE_AFTER_SECS * 1000
    kept = []
    for r in rows:
        if r.get("state") in ("delivered", "failed", "cancelled", "expired"):
            newest = r.get("deliveredAt") or r.get("stagedAt") or 0
            if int(newest) < floor:
                continue
        kept.append(r)
    return kept


def _save(rows: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = _prune(rows)
    # Unique temp name per writer, atomic replace - same discipline as ledgerlib._save (a
    # fixed temp name lets two concurrent writers interleave bytes into one file and the
    # mangled JSON reads back empty, wiping the whole ledger).
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({"deliveries": rows}, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def stage(session_id: str, text: str, *, title: str = "", instance: str = "",
          verify_text: str = "", evidence: str = "", by: str = "ai",
          now_ms: int | None = None, dedupe: bool = False) -> dict:
    """Write a reply down for one chat. Sends nothing.

    `verify_text` is the safety rail, not decoration: the actuator refuses to type until it
    can SEE that snippet in the conversation it selected, so a wrong row navigates and then
    stops rather than putting your words into someone else's work. It defaults to a slice of
    the evidence the reply was based on, which by construction came from the right chat.

    `dedupe=True` is for the AUTOMATIC lanes (saturate, overlord): when a reply for this chat
    is already staged, the existing row is returned (flagged `reused`) instead of a second one
    being written, so two lanes planning from their own reads in the same window cannot each
    inject a wake into one chat. A person's reply is never folded into someone else's row -
    stage_reply and interview leave this off.

    The lookup and the append happen against ONE locked snapshot (audit AH-06, reproduced
    2026-09-05): checked before the lock, two synchronized lanes both saw no pending row and
    then both appended under the lock - two ids, neither `reused`, and the courier's per-id
    claim and one-per-chat-per-pass rules only DELAYED the second wake rather than dropping it.
    """
    if not str(text).strip():
        raise ValueError("a staged reply needs text - staging an empty message is not a decision")
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    if not verify_text:
        verify_text = _verify_snippet(evidence)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "session": session_id,
        "title": title,
        "instance": instance,
        "text": str(text).strip(),
        "verifyText": verify_text,
        "evidence": (evidence or "")[-600:],
        "by": by,
        "stagedAt": now_ms,
        "state": "staged",
        "attempts": 0,
        "deliveredAt": None,
        "lastError": None,
    }
    with ledgerlib.locked("deliveries"):
        rows = _load()
        if dedupe:
            already = sorted(
                (r for r in rows if r.get("state") == "staged" and r.get("session") == session_id),
                key=lambda r: r.get("stagedAt", 0),
            )
            if already:
                return {**already[0], "reused": True}
        rows.append(entry)
        _save(rows)
    return entry


# Below this a snippet stops being PROOF: a handful of characters can occur in any
# conversation, and the whole point of the verify text is that it identifies THIS chat.
MIN_VERIFY_LEN = 10

#: The app's own rate-limit banner, which is NOT the chat's words: every walled chat on one
#: account renders the identical line, so it identifies an account and never a conversation.
#: Lives here, once, because two things need the same answer - _verify_snippet skips such a
#: line when choosing a snippet, and stage_reply.last_rendered_text must keep walking BACK
#: past a turn that is nothing else. Two copies of this regex would drift and the drift would
#: show up as a chat that cannot be woken.
_LIMIT_BANNER_RE = _re.compile(r"(?i)\b(session|usage|weekly|rate) limit\b|too many requests")

#: LENGTH IS THE DISCRIMINATOR, and it belongs here rather than in each caller. The banner is
#: one short line the APP renders; a chat's own paragraph that happens to discuss a session
#: limit is the chat's words and identifies it perfectly well. The migration chats discuss
#: limits constantly, so matching on the phrase alone would throw away real evidence - and
#: when one caller applied a length rule and this one did not, they disagreed about the same
#: text and the chat became unwakeable again by a different route.
BANNER_MAX_LEN = 200


def is_limit_banner(text: str) -> bool:
    """Is this ONLY the app's rate-limit banner, rather than something the chat itself said?

    Every walled chat on one account renders the identical line, so it identifies an ACCOUNT
    and never a conversation - which is exactly what a verify snippet must do. Both the
    snippet chooser below and stage_reply's transcript walk ask this one question, so they
    cannot disagree about a given piece of text.
    """
    t = (text or "").strip()
    return bool(t) and len(t) <= BANNER_MAX_LEN and bool(_LIMIT_BANNER_RE.search(t))


def _verify_snippet(evidence: str, prefer_len: int = 24, max_len: int = 80) -> str:
    """A distinctive line from the chat's own last words, for the actuator to match on.

    Prefers the LAST substantial line: it is the most recently rendered text in that
    conversation, so it is the one most likely to be on screen when the actuator looks.

    Falls back to the longest short line when nothing long exists - a chat whose entire last
    turn is "WINDOW TEST OK" is perfectly identifiable by those 14 characters, and refusing it
    outright made the courier unable to answer exactly the terse chats it most often meets
    (found on the first live test). Below MIN_VERIFY_LEN it still refuses: a snippet that
    short is not proof of anything.
    """
    lines = [l.strip() for l in (evidence or "").splitlines() if l.strip()]
    if not lines:
        return ""
    # TWO render truths (measured live 2026-09-01): the evidence is RAW MARKDOWN while the
    # pane shows RENDERED text (strip `*_#> and the line matches - inline code keeps its
    # characters), AND the pane shows the END of a long message - so the snippet must come
    # from the LAST lines, never an earlier "cleaner" one that is scrolled off-screen. Link
    # lines are skipped ("[text](url)" renders as just "text").
    import re

    for raw in reversed(lines):
        if len(raw) < MIN_VERIFY_LEN or "](" in raw:
            continue
        # a leading "- " / "1. " renders as a bullet GLYPH, not text (measured live
        # 2026-09-01: the pane's list items start at the first word, so a dash-prefixed
        # snippet can never match on screen)
        cand = re.sub(r"^([-*+]|\d+[.)])\s+", "", raw)
        cand = re.sub(r"[`*_#>]", "", cand).strip()
        # ⛔ A LINE EVERY CHAT ENDS WITH PROVES NOTHING (caught live 2026-09-01: a reply was
        # staged with the verify text "Signed: Software Engineer"). The house style ends
        # replies with a "- Signed: <Employee>" footer, and this function deliberately prefers
        # the LAST substantial line - so for every chat following that convention the snippet
        # became the footer. It is long enough to pass the length check and utterly
        # non-distinctive: the one thing the verify text exists to do is prove the actuator is
        # looking at THIS conversation, and a footer shared across the whole fleet would match
        # a dozen panes. Skip it and keep walking backwards to real content.
        if re.match(r"(?i)^signed\s*[:\-]", cand):
            continue
        # ⛔ THE APP'S OWN LIMIT BANNER IS NOT THE CHAT'S WORDS (seen live 2026-09-01: the
        # overlord's wake went out with the verify text "You've hit your session limit ·
        # resets 5:50pm"). Every rate-limited chat on that account shows the same line, so
        # it proves nothing about WHICH chat is on screen - and it is exactly the moment the
        # wrong-chat guard matters most. Keep walking back to real content.
        if is_limit_banner(cand):
            continue
        if len(cand) >= MIN_VERIFY_LEN:
            return cand[:max_len]
    return ""


def expire_stale(now_ms: int | None = None) -> list[dict]:
    """Move every staged row past STAGED_TTL_SECS to `expired`, and say which.

    Expiry happens HERE, on the read every delivery passes through, rather than on a separate
    sweep nobody remembers to run: a queue is only dangerous at the moment something tries to
    send from it. The row is kept and readable - only its right to be delivered ends.
    """
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    floor = now_ms - STAGED_TTL_SECS * 1000
    dead = [r for r in _load()
            if r.get("state") == "staged" and int(r.get("stagedAt") or 0) < floor]
    out = []
    for r in dead:
        age_h = (now_ms - int(r.get("stagedAt") or 0)) / 3_600_000
        got = expire(r["id"], f"staged {age_h:.0f}h ago and never sent - past the "
                              f"{STAGED_TTL_SECS // 3600}h shelf life, so it is no longer "
                              "known to be true; re-stage it if it still is")
        if got:
            out.append(got)
    return out


def pending(session_id: str | None = None, now_ms: int | None = None) -> list[dict]:
    """Staged replies waiting to go, oldest first (delivery order is decision order).

    Stale rows are expired first, so nothing past its shelf life can be handed to a sender -
    this is the one door every lane's deliveries come through.
    """
    expire_stale(now_ms)
    rows = [r for r in _load() if r.get("state") == "staged"]
    if session_id:
        rows = [r for r in rows if r.get("session") == session_id]
    return sorted(rows, key=lambda r: r.get("stagedAt", 0))


def all_rows() -> list[dict]:
    return sorted(_load(), key=lambda r: r.get("stagedAt", 0), reverse=True)


def get(delivery_id: str) -> dict | None:
    return next((r for r in _load() if r.get("id") == delivery_id), None)


def _update(delivery_id: str, *, only_from: tuple[str, ...] | None = None,
            **fields) -> dict | None:
    # Serialized like every state-file writer (ledgerlib.locked docstring): two overlapping
    # courier runs each rewriting the whole list must not drop each other's rows.
    # `only_from` makes a transition CONDITIONAL on the row's current state, read under the
    # same lock: an outcome written by a run that planned from a stale snapshot must never
    # overwrite a person's cancel (review 2026-09-01), nor "failed" overwrite "delivered".
    with ledgerlib.locked("deliveries"):
        rows = _load()
        hit = None
        for r in rows:
            if r.get("id") == delivery_id:
                if only_from is not None and r.get("state") not in only_from:
                    return None
                r.update(fields)
                hit = r
        if hit:
            _save(rows)
    return hit


def note_attempt(delivery_id: str) -> dict | None:
    row = get(delivery_id)
    if not row:
        return None
    return _update(delivery_id, attempts=int(row.get("attempts", 0)) + 1)


def mark_delivered(delivery_id: str, now_ms: int | None = None) -> dict | None:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    return _update(delivery_id, only_from=("staged",),
                   state="delivered", deliveredAt=now_ms, lastError=None)


def mark_failed(delivery_id: str, why: str) -> dict | None:
    """Failed means TRIED AND DID NOT LAND. A reply the courier deliberately skipped (held,
    live, breaker) stays STAGED - skipping is not failing, and it must be retried later.
    A refusal that says the world was not ready - the target app is closed, the daemon dropped
    the socket - is not a failure either: that is defer()."""
    return _update(delivery_id, only_from=("staged",), state="failed", lastError=str(why)[:400])


def defer(delivery_id: str, why: str) -> dict | None:
    """The delivery could not be ATTEMPTED, so the row stays staged and is counted.

    THE FAILED GRAVEYARD (measured 2026-09-10: 42 failed rows, 41 of them with attempts=1).
    Almost every one was `HTTP 409 instance is not running` or `WinError 10054` - the target
    app was closed, or the daemon dropped the socket. Neither is a delivery that went wrong;
    both are "not now". Recording them as `failed` burned the row permanently, so the next
    cycle staged a NEW one for the same chat, which failed the same way - the queue grew a
    layer of headstones per closed app rather than retrying one row.

    Past MAX_DEFERRALS the row is expired instead, with the reason: an unopenable chat must
    not be retried forever, but it must not be silently dropped either.
    """
    row = get(delivery_id)
    if not row or row.get("state") != "staged":
        return None
    n = int(row.get("deferrals", 0)) + 1
    if n >= MAX_DEFERRALS:
        return expire(delivery_id,
                      f"deferred {n} times and never became sendable - last reason: {str(why)[:200]}")
    return _update(delivery_id, only_from=("staged",), deferrals=n, lastError=str(why)[:400])


def expire(delivery_id: str, why: str) -> dict | None:
    """End a staged reply WITHOUT sending it, and keep it readable with the reason.

    Not a delete and not a failure: the courier never tried. Used for a row past its shelf
    life, a premise that has gone void (its chat changed accounts after it was written), and
    a row that has been deferred to the ceiling.
    """
    return _update(delivery_id, only_from=("staged",), state="expired", lastError=str(why)[:400])


# A per-delivery courier CLAIM older than this belongs to a dead run and is reclaimable
# (send pipeline worst case: actuator timeout 300s + confirm + margin). Lives here, beside
# the row states, because cancel() has to read it too. Since 2026-09-09 age is only the
# FALLBACK: a claim whose owner is provably gone is reclaimable immediately (claim_owner_alive).
CLAIM_STALE_SECS = 600


def claim_path(delivery_id: str) -> Path:
    """The courier's at-most-once claim for one delivery (an atomic mkdir; courier._claim)."""
    return ledgerlib._state_dir() / "locks" / f"deliver-{delivery_id}"


def write_claim_owner(path: Path) -> None:
    """Record WHO holds this claim, so a later run can prove death instead of waiting out a
    clock. Same record and same primitive as the UI lock in windowlib - PID plus that PID's OS
    creation time, so a recycled PID can never impersonate the original holder. Best-effort: a
    claim with no readable owner simply falls back to age, which is the old behaviour."""
    try:
        (path / "owner.json").write_text(
            json.dumps({"pid": os.getpid(), "started_at": joblocklib._process_start_time(os.getpid())}),
            encoding="utf-8",
        )
    except OSError:
        pass


def claim_owner_alive(path: Path) -> bool | None:
    """True: the run holding this claim is still running. False: PROVABLY gone. None: unknown
    (no owner record, or a platform/permission we cannot read). ⛔ None is not permission to
    take over - it means fall back to age."""
    try:
        data = json.loads((path / "owner.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return joblocklib._owner_alive(int(data.get("pid") or -1), data.get("started_at"))
    except (TypeError, ValueError):
        return None


def claim_expires_at(delivery_id: str) -> float | None:
    """Wall-clock epoch at which an age-based claim stops blocking, or None if there is no
    claim. Exists so a refusal can say WHEN to come back instead of 'present and fresh',
    which told a caller nothing and invited a retry loop that could never win."""
    try:
        return claim_path(delivery_id).stat().st_mtime + CLAIM_STALE_SECS
    except OSError:
        return None


def claimed(delivery_id: str) -> bool:
    """Is a LIVE courier run sending this delivery right now?

    PROOF FIRST, AGE ONLY AS FALLBACK (2026-09-09), the same ladder windowlib._may_reclaim
    uses for UI locks. The old rule was age alone, so a run whose CALLER died - an MCP
    transport timeout, the normal case for a multi-chat batch - left a claim that refused
    every retry for a silent ten minutes while no courier process existed anywhere on the
    machine. Measured that day: a claim from a run dead for fifteen minutes still reported
    'present and fresh'.
    """
    path = claim_path(delivery_id)
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False  # no claim at all
    alive = claim_owner_alive(path)
    if alive is True:
        return True  # a living owner is never stale, whatever the age says
    if alive is False:
        return False  # provably gone: reclaim now rather than waiting out the clock
    return age <= CLAIM_STALE_SECS  # unknown: age only, so we can never wedge the lane


class InFlight(RuntimeError):
    """A courier run holds this delivery's claim: it is being sent this very moment."""


def cancel(delivery_id: str) -> dict | None:
    """Withdraw a staged reply. Raises InFlight when a courier run has already claimed it -
    the text may be in the composer as we speak, and "cancelled" would then be a lie the
    ledger later contradicts with "delivered" (review 2026-09-01)."""
    row = get(delivery_id)
    if not row or row.get("state") != "staged":
        return None
    if claimed(delivery_id):
        raise InFlight(f"delivery {delivery_id} is claimed by a courier run that is sending it "
                       "right now - too late to cancel; check --list for its outcome shortly")
    return _update(delivery_id, only_from=("staged",), state="cancelled")


def recent_delivery(session_id: str, within_secs: int, now_ms: int | None = None) -> dict | None:
    """The newest reply DELIVERED to this chat within `within_secs`, or None - the automatic
    lanes ask before staging a wake, so one chat is not booted twice in one window."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    rows = [r for r in _load()
            if r.get("session") == session_id and r.get("state") == "delivered"
            and r.get("deliveredAt") and now_ms - int(r["deliveredAt"]) <= within_secs * 1000]
    return max(rows, key=lambda r: r["deliveredAt"]) if rows else None


def transcript_tail_text(transcript_path: str | None, nbytes: int = 8000, last_n: int = 3) -> str:
    """The chat's own last words: the text blocks of the last `last_n` records in the
    transcript's tail, joined - the input _verify_snippet wants. Empty when unreadable.
    (Lifted from overlord.nudge, where it was measured live; saturate now derives its wake
    verify text the same way instead of shipping a placeholder.)"""
    if not transcript_path:
        return ""
    try:
        p = Path(transcript_path)
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > nbytes:
                f.seek(size - nbytes)
                f.readline()
            raw = f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
    texts: list[str] = []
    for line in raw.splitlines():
        if '"text"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        for c in ((rec.get("message") or {}).get("content") or []):
            if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                texts.append(c["text"])
    return "\n".join(texts[-last_n:])


def requeue(delivery_id: str, now_ms: int | None = None) -> dict | None:
    """Put a failed or expired reply back in the queue - a person's word after fixing the cause.

    ⛔ THE CLOCK RESTARTS, or this is a silent no-op (2026-09-10, caught while adding the shelf
    life). A row keeps its original `stagedAt`, so putting a five-day-old one back as `staged`
    without touching that field means the very next pending() expires it again, instantly and
    invisibly: the person is told it was requeued and nothing is ever sent. Re-staging IS a new
    decision - it gets a new clock and a clean deferral count.
    """
    row = get(delivery_id)
    if not row or row.get("state") not in ("failed", "expired"):
        return None
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    return _update(delivery_id, state="staged", lastError=None,
                   stagedAt=now_ms, deferrals=0)
