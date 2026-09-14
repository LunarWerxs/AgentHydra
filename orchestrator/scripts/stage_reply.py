#!/usr/bin/env python3
"""stage_reply.py - ACT (state only): write down a reply for one chat. SENDS NOTHING.

This is where an AI's judgment becomes a record. The toolbox decides mechanically and hands
the waiting chats to an AI (the judgment queue); the AI reads one, decides what to say, and
stages it here. `courier.py` is what actually types it, later, as a separate deliberate act.

The staged reply carries the EVIDENCE it was based on - the chat's own last words, pulled
from the gate - so the courier can prove at send time that it is looking at the right chat,
and so a person reviewing the queue can see what the AI was answering.

Usage: python stage_reply.py <title fragment | session id> --text "the reply" [--by name] [--json]
         (--dedupe is for the AUTOMATIC lanes: when a reply for this chat is already staged it
          returns THAT row, flagged `reused`, instead of writing a second one - two staged
          replies is two wakes into one chat. A person's reply is never folded into someone
          else's row, so it is off by default. --json carries `id` and `reused` at the top.)
       python stage_reply.py --list [--state staged,failed|all] [--instance NAME] [--limit N] [--json]
         (--list defaults to the ACTIONABLE rows - staged and failed - newest first, capped at
          50. It used to print every row ever held, which no caller could read.)
       python stage_reply.py --cancel <delivery id> [--json]
         (Every flag above TAKES A VALUE, and a value that starts with -- is not a value:
          `--state --limit 200` is refused as bad usage rather than read as a state named
          "--limit". --state is case-folded, so `All` and `all` are the same word.)
Exit:  0 staged/listed/cancelled - 3 not resolvable or bad usage - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from lib import clilib, deliverylib
from lib import gatelib
from lib import hydralib


_TAIL_BYTES = 400_000

# ⛔ --list USED TO MEAN 'EVERY ROW THIS MACHINE HAS EVER HELD' (found 2026-09-12, diagnosing
# a migration whose resume did not arrive). That was 178,575 characters over 120+ rows across
# 15 instances, most of them expired or cancelled and belonging to other accounts, each
# carrying a full reply body - so it blew the caller's token cap and was REFUSED, and the one
# fact anybody wanted (which of three chats got its reply) could not be read from the tool
# that owns it. The question --list exists to answer is 'what is waiting to go out now', and
# those rows are a handful. History is still reachable with --state all.
ACTIONABLE_STATES = ("staged", "failed")
_ALL_STATES = ("staged", "delivered", "failed", "cancelled", "expired")
_LIST_TEXT_CHARS = 100
_DEFAULT_LIST_LIMIT = 20
# A LIST ROW IS AN INDEX ENTRY, NOT THE RECORD. Trimming only `text` still left 67KB for 50
# rows, because a row also carries `evidence` (up to 600 chars of the chat's own words) and
# `verifyText`. Those matter when you are looking at ONE delivery and are pure weight in a
# list, so the list projects. Ask for a row by id to see everything it holds.
_LIST_FIELDS = ("id", "session", "title", "instance", "state", "by", "stagedAt",
                "deliveredAt", "attempts", "deferrals")
# ⛔ THE TAIL WINDOW IS A FIRST GUESS, NOT THE SEARCH (found live 2026-09-12, on a chat
# walled after eleven minutes of tool work). The banner walk-back below is bounded by the
# window it reads, so a chat whose last REAL words are older than _TAIL_BYTES of tool
# records yielded the banner, nothing else, and an empty verify snippet - leaving exactly
# the walled chat the walk-back exists for unwakeable all over again, by a third route.
# The scan now widens until it finds real words or reaches the file; this is the ceiling,
# so a pathological transcript cannot be read whole into memory.
_MAX_SCAN_BYTES = 32_000_000


@dataclass
class _ParsedArgs:
    """The result of splitting argv into flags and the one positional target."""

    as_json: bool = False
    text: str | None = None
    by: str | None = None
    cancel_id: str | None = None
    do_list: bool = False
    states: list[str] | None = None
    instance: str | None = None
    limit: int | None = None
    # OFF by default, and that default is the rule, not an oversight: a PERSON's reply is
    # never folded into someone else's row (deliverylib.stage's own docstring). See --dedupe.
    dedupe: bool = False
    positional: list[str] = field(default_factory=list)
    # Set when argv itself is malformed, so main() can refuse LOUDLY (exit 3) instead of
    # running a command built out of a misread flag. See _parse_argv.
    usage_error: str | None = None


def last_rendered_text(sid: str) -> str:
    """The chat's most recent rendered words, read straight from its own transcript.

    ⛔ THE GAP THIS FILLS, and it is the whole reason stalled chats were unrecoverable
    (found live 2026-09-01, on a chat frozen for seven hours): the gate reports
    `last_assistant_text` only for a FINISHED or IDLE chat. One that froze mid-tool is
    NEITHER - it still reads as 'running' - so the gate hands back nothing, the verify
    snippet comes out empty, and the courier refuses to type. The one class of chat that
    most needs waking was therefore the single class that could never be woken, and the
    refusal looked like a working safety rail rather than a dead end.

    This widens where the evidence COMES FROM; it does not weaken what the courier
    demands. The text sitting above a stuck tool call is still the last thing rendered in
    that pane, so it proves identity exactly as well as a finished turn's last line.
    """
    row = hydralib.session_row(sid) or {}
    tp = row.get("transcript_path")
    if not tp:
        # The same disk lookup the GATE got (gatelib.find_transcript_on_disk). Adding it
        # there and not here left the two halves disagreeing: a chat could be gated fine
        # from its on-disk transcript and still produce no verify snippet, so it stayed
        # unwakeable for the very reason that had just been fixed.
        tp = gatelib.find_transcript_on_disk(sid)
    if not tp:
        return ""
    try:
        p = Path(tp)
        size = p.stat().st_size
    except OSError:
        return ""
    # Widen the window until real words turn up, the whole file has been read, or the
    # ceiling is hit. One pass over _TAIL_BYTES answers the ordinary chat; a walled one
    # that worked hard first needs to look further back, and looking further back is
    # cheap compared with a chat that cannot be woken at all.
    window = _TAIL_BYTES
    while True:
        try:
            with open(p, "rb") as f:
                if size > window:
                    f.seek(size - window)
                    f.readline()
                raw = f.read().decode("utf-8", errors="replace")
        except OSError:
            return ""
        found = _last_non_banner_assistant_text(raw)
        if found:
            return found
        if window >= size or window >= _MAX_SCAN_BYTES:
            return ""
        window = min(size, _MAX_SCAN_BYTES, window * 8)


def _last_non_banner_assistant_text(raw: str) -> str:
    """The last thing the CHAT said in this slice of transcript, banner turns skipped.

    Split out of last_rendered_text so the same rule can be applied to a widening series
    of windows: the rule must not change with how much was read, or two window sizes
    would disagree about the same chat.
    """
    for line in reversed(raw.splitlines()):
        if '"text"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "assistant":
            continue
        content = ((rec.get("message") or {}).get("content"))
        if not isinstance(content, list):
            continue
        texts = [b.get("text") for b in content
                 if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
        if not texts:
            continue
        joined = "\n".join(texts)
        # ⛔ A TURN THAT IS ONLY THE APP'S LIMIT BANNER IS NOT WORDS TO IDENTIFY A CHAT BY, AND
        # STOPPING ON ONE MADE WALLED CHATS UNWAKEABLE (found live 2026-09-06, on two chats
        # moved off an account that had hit its 5-hour cap). A chat killed by a usage wall ends
        # with exactly one assistant record - "You've hit your session limit - resets 10pm" -
        # which every walled chat on that account renders identically. deliverylib rightly
        # refuses it as a verify snippet, so the evidence collapsed to nothing, the courier
        # refused to type, and the actuator died on an empty -VerifyText. The class of chat
        # that most needs waking was, again, the one class that could not be woken.
        #
        # The guard is not weakened: the banner is still never used as proof. We simply keep
        # walking BACK to the last thing the chat actually said, which is on screen above it.
        if deliverylib.is_limit_banner(joined):
            continue
        return joined
    return ""


# Every flag that consumes the argument after it. Named in one place so the missing-value
# guard below cannot drift onto five of the six, and so a seventh flag added later inherits it.
_VALUE_FLAGS = ("--text", "--by", "--cancel", "--state", "--instance", "--limit")


def _parse_argv(argv: list[str]) -> _ParsedArgs:
    """Split argv into the known flags plus whatever positional args are left over.

    ⛔ A VALUE-TAKING FLAG WITH NO VALUE MUST NOT EAT THE NEXT FLAG. The guard used to be
    `i + 1 < len(argv)` - "is there another word" - which is true of the NEXT FLAG, so
    `--state --limit 200` read "--limit" as the state to filter on, matched nothing, and then
    fell back to the DEFAULT limit because --limit had already been swallowed: two wrong
    answers from one typo, both silent, and the list that came back could not be trusted to
    mean what it said. courier._parse_only has had the right guard ("a value that starts with
    -- is not a value") since 2026-09-06; this is the same guard, on every flag that takes one.
    The cost is that a reply body genuinely starting with "--" now has to be refused rather
    than mis-parsed, and a refusal a person can see beats a silent misread.
    """
    # The value-LESS flags, read by presence. They are deliberately NOT in _VALUE_FLAGS: a
    # flag that takes no value must never consume the token after it, or `--dedupe --json`
    # would swallow --json exactly as `--state --limit` swallowed --limit.
    parsed = _ParsedArgs(as_json="--json" in argv, do_list="--list" in argv,
                         dedupe="--dedupe" in argv)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in _VALUE_FLAGS:
            if i + 1 >= len(argv):
                parsed.usage_error = f"{a} needs a value and got nothing"
                return parsed
            if argv[i + 1].startswith("--"):
                parsed.usage_error = (
                    f"{a} needs a value and was handed the next flag, {argv[i + 1]} - a value "
                    "that starts with -- is not a value")
                return parsed
            value = argv[i + 1]
            i += 2
            if a == "--text":
                parsed.text = value
            elif a == "--by":
                parsed.by = value
            elif a == "--cancel":
                parsed.cancel_id = value
            elif a == "--instance":
                parsed.instance = value
            elif a == "--state":
                # ⛔ CASE-FOLD BEFORE COMPARING (found 2026-09-12, alongside the guard above).
                # select_rows() lower-cases what it filters on, so `--state Staged` worked -
                # but "all" was matched here, case-SENSITIVELY, so `--state All` set states to
                # the literal ["All"], which matches no row's state at all - an empty list
                # beside the full match count, from a word nobody would look at twice.
                raw = [s.strip().lower() for s in value.split(",") if s.strip()]
                parsed.states = list(_ALL_STATES) if "all" in raw else raw
            elif a == "--limit":
                # A LIMIT THAT IS NOT A NUMBER IS A TYPO, NOT A DEFAULT. This used to set
                # limit=None, which is the "use the default cap" signal - so `--limit 2O` (a
                # letter O) silently answered with 20 rows and looked deliberate.
                try:
                    parsed.limit = max(0, int(value))
                except ValueError:
                    parsed.usage_error = f"--limit needs a whole number, got {value!r}"
                    return parsed
            continue
        if not a.startswith("--"):
            parsed.positional.append(a)
        i += 1
    return parsed


def select_rows(rows: list[dict], states: list[str] | None, instance: str | None,
                limit: int | None) -> tuple[list[dict], int]:
    """Apply the filters, newest first, and say how many matched BEFORE the limit.

    Split out so a test can pin the defaults without going through argv: the defaults ARE the
    fix, and a default that silently widens again is the bug coming back.
    """
    want = [s.lower() for s in (states if states is not None else ACTIONABLE_STATES)]
    out = [r for r in rows if str(r.get("state", "")).lower() in want]
    if instance:
        needle = instance.lower()
        out = [r for r in out if needle in str(r.get("instance", "")).lower()]
    out.sort(key=lambda r: int(r.get("stagedAt") or 0), reverse=True)
    total = len(out)
    cap = _DEFAULT_LIST_LIMIT if limit is None else limit
    if cap:
        out = out[:cap]
    return out, total


def _trim(row: dict) -> dict:
    """One list row, projected to the fields a list is read FOR.

    Everything bulky is dropped rather than shortened: the full `text`, `evidence` and
    `verifyText` belong to a single row's record, never to an index of them.
    """
    out = {k: row[k] for k in _LIST_FIELDS if k in row}
    body = str(row.get("text") or "")
    out["text"] = body[:_LIST_TEXT_CHARS]
    if len(body) > _LIST_TEXT_CHARS:
        out["textTruncated"] = True
    err = str(row.get("lastError") or "")
    if err:
        out["lastError"] = err[:200]
    return out


def _run_list(as_json: bool, states: list[str] | None = None, instance: str | None = None,
              limit: int | None = None) -> int:
    """Print the delivery rows worth acting on. Defaults to staged+failed, newest first.

    ⛔ The default is NOT every state. See ACTIONABLE_STATES. `--state all` restores history,
    and one row's full body is still readable by asking for that row.
    """
    rows, total = select_rows(deliverylib.all_rows(), states, instance, limit)
    if as_json:
        print(json.dumps({
            "deliveries": [_trim(r) for r in rows],
            "shown": len(rows),
            "matched": total,
            "states": list(states if states is not None else ACTIONABLE_STATES),
            "note": ("full history with --state all; each row's text is trimmed to "
                     f"{_LIST_TEXT_CHARS} chars"),
        }, indent=2))
    elif not rows:
        print("nothing staged - the courier has nothing to deliver"
              + ("" if states is None else f" in state(s) {','.join(states)}"))
    else:
        for r in rows:
            mark = {"staged": "·", "delivered": "✓", "failed": "✗",
                    "cancelled": "-", "expired": "⌛"}.get(r["state"], "?")
            print(f"  {mark} [{r['state']}] {r['id']}  {r.get('title') or r['session']}")
            print(f"      {r['text'][:_LIST_TEXT_CHARS]}")
            if r.get("deferrals"):
                print(f"      deferred {r['deferrals']}x (still staged - the world was not ready)")
            if r.get("lastError"):
                # An expired row's lastError is its REASON, not an error - say which, so the
                # reader does not read a shelf-life expiry as something that went wrong.
                label = "reason" if r["state"] == "expired" else "last error"
                print(f"      {label}: {r['lastError'][:120]}")
        if total > len(rows):
            print(f"  ... {total - len(rows)} more match; raise --limit to see them")
    return 0


def _run_cancel(cancel_id: str, as_json: bool) -> int:
    """Cancel one staged delivery by id, reporting InFlight as a refusal rather than an error."""
    try:
        row = deliverylib.cancel(cancel_id)
    except deliverylib.InFlight as err:
        # Too late, and said so: a courier run has claimed it and may be typing it now.
        msg = f"NOT cancelled: {err}"
        print(json.dumps({"cancelled": False, "report": msg}, indent=2) if as_json else msg)
        return 3
    msg = (f"cancelled {cancel_id}" if row
           else f"nothing to cancel: {cancel_id} is not a staged reply")
    print(json.dumps({"cancelled": bool(row), "report": msg}, indent=2) if as_json else msg)
    return 0 if row else 3


def _resolve_target(query: str) -> tuple[dict | None, int]:
    """Resolve the CLI's chat argument to a match dict, or an exit code on failure."""
    try:
        return hydralib.resolve_one(query), 0
    except (hydralib.ChatNotFound, hydralib.AmbiguousChat) as err:
        print(f"REFUSED (deterministic): {err}", file=sys.stderr)
        return None, 3
    except hydralib.DaemonError as err:
        print(f"stage FAILED: {err}", file=sys.stderr)
        return None, 1


def gather_evidence(match: dict, sid: str) -> str:
    """What this chat actually last said, pulled from the gate rather than typed by hand,
    so the verify snippet provably comes from THIS chat. Falls back to the raw transcript
    for a chat mid-turn or stalled (see last_rendered_text).

    Public because migrate_batch --resume stages a reply against every chat it lands, and
    the evidence rule must be THIS one - a second copy would be a second place for the
    limit-banner trap below to be forgotten."""
    verdict = gatelib.gate_match(match, hydralib.session_row)
    evidence = ""
    if verdict:
        src = verdict.get("finished") or verdict.get("idle") or {}
        evidence = src.get("last_assistant_text") or ""
    # ⛔ THE GATE'S ANSWER IS NOT AUTOMATICALLY USABLE EVIDENCE. For a chat stopped by a usage
    # wall the gate reports the app's own limit banner as `last_assistant_text` - it IS the
    # last assistant text, honestly - but deliverylib refuses it as proof of identity, because
    # every walled chat on that account shows the same line. Non-empty-but-unusable then beat
    # the transcript fallback to the punch and the chat could not be woken at all. Treat a
    # banner-only answer as no answer and walk the transcript for what the chat really said.
    if not evidence or deliverylib.is_limit_banner(evidence):
        evidence = last_rendered_text(sid) or evidence
    return evidence


#: The name this had while it was private; kept so an older caller (and the courier tests
#: that pin the limit-banner trap through it) keep working.
_gather_evidence = gather_evidence


def _run_stage(query: str, text: str, by: str | None, as_json: bool,
               dedupe: bool = False) -> int:
    """Resolve the target chat, gather its evidence, and stage the reply against it.

    `dedupe` is for the AUTOMATIC lanes only (deliverylib.stage's own docstring): when a reply
    for this chat is already staged, that row is returned flagged `reused` rather than a second
    one being written. The daemon uses it when a refused `move_chats` stages its resume text
    against each named chat - re-firing the refused call must not leave TWO staged replies,
    which is two wakes into one chat. A person's reply is never folded into someone else's row,
    so this stays OFF unless asked for.
    """
    match, code = _resolve_target(query)
    if match is None:
        return code

    sid = match.get("cliSessionId") or ""
    evidence = gather_evidence(match, sid)

    entry = deliverylib.stage(
        sid, text, title=match.get("title") or "", instance=match.get("instance") or "",
        evidence=evidence, by=by or "ai", dedupe=dedupe,
    )
    reused = bool(entry.get("reused"))
    msg = (f"{'reused already-staged' if reused else 'staged'} {entry['id']} for "
           f"'{entry['title']}' ({entry['instance']}):\n"
           f"  {entry['text'][:160]}\n"
           f"  verify snippet: {entry['verifyText'][:80] or '(none - the courier will refuse)'}\n"
           "  Nothing sent. Deliver with: python scripts/courier.py --yes")
    # `id` and `reused` sit at the TOP LEVEL as well as inside `staged`: the daemon reads both
    # directly, and a caller should not have to know which nested key holds the id.
    print(json.dumps({"id": entry["id"], "reused": reused, "staged": entry, "report": msg},
                     indent=2) if as_json else msg)
    if not entry["verifyText"]:
        print("\n⚠ no verify snippet could be derived from this chat's last words - the courier "
              "refuses to type without one, because it is what proves the right chat. Re-run "
              "after the chat has said something, or stage against a chat with a readable tail.",
              file=sys.stderr)
    return 0


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0

    parsed = _parse_argv(argv)
    if parsed.usage_error:
        # Named, then the usage text: a reader who mistyped one flag should not have to diff
        # the whole synopsis against what they typed to find it.
        print(f"bad usage: {parsed.usage_error}\n", file=sys.stderr)
        print(__doc__.strip(), file=sys.stderr)
        return 3

    if parsed.do_list:
        return _run_list(parsed.as_json, parsed.states, parsed.instance, parsed.limit)

    if parsed.cancel_id:
        return _run_cancel(parsed.cancel_id, parsed.as_json)

    if len(parsed.positional) != 1 or not parsed.text:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    return _run_stage(parsed.positional[0], parsed.text, parsed.by, parsed.as_json,
                      dedupe=parsed.dedupe)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
