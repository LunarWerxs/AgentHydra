#!/usr/bin/env python3
"""unblock_prompts.py - ACT: restart chats that stopped on a permission prompt they should
never have been shown.

THE COMPLAINT (owner, 2026-09-01: "there's literally like four chats currently pending on
someone to push enter, because they're not set to the proper bypass permissions"). Measured
that moment: SIX live chats whose newest transcript record was an unanswered tool call, each
showing an "Allow once" / "Always allow" prompt. Every one of them has
permissionMode=bypassPermissions on disk - they booted BEFORE that stamp landed, so the app is
running them under the old mode and asking. The work is stopped dead and nothing but a human
click restarts it.

⛔ THIS IS NOT A POLICY DECISION, AND IT MUST NEVER BECOME ONE. A chat is unblocked ONLY when
its own configured permission mode is bypassPermissions - the owner's standing doctrine that
this chat is never to be asked. This presses the button that mode would have pressed by itself.
A chat configured any other way is REPORTED and left alone: that one is genuinely a person's
call, and answering it would be inventing consent.

THE FOUR CONDITIONS, all required:
  1. the chat has a LIVE engine (a dead one is not waiting on anything);
  2. its newest transcript record is a tool call with no result - the shape of waiting;
  3. its meta record says bypassPermissions;
  4. it is not held, and its own app is running.
The actuator then adds its own aim rails (the right chat open, an enabled Allow button in the
conversation pane, never a Deny) before a single click.

⛔ EVEN A STRUCTURALLY-ELIGIBLE CHAT IS NOT PRESSED BLIND (2026-09-04, ported idea from
hermes-agent's approval.py - see lib/approvallib.py). The four conditions above earn a
chat a HEARING, not a press: what the pending command would actually DO is classified
APPROVE / DENY / ESCALATE against lib/approval_policy.json first. DENY (hardline-destructive:
rm -rf, a shared-branch hard reset, a credential path, ...) is never pressed, in either
context - the bypass MODE was consent to never being asked, not to any specific command.
ESCALATE (everything the policy does not place) is never pressed UNATTENDED either - it is
queued for interview.py's judgment queue instead. Only the INTERACTIVE run (`--force`, a
person at orch.py) may press an ESCALATE row, and only after showing the command.

TARGETING ONE CHAT (--session, 2026-09-11). The sweep above answers "what in the fleet is
stuck"; a MANAGER chat driving another account has the opposite question - "THIS chat stopped
mid-turn, clear it NOW". `--session <id>` (repeatable, or a comma list) narrows every stage to
the named chats, and reports a named chat that is NOT waiting on a prompt instead of silently
finding nothing. ⛔ IT NARROWS, IT NEVER WIDENS: every rail above still applies to a named
chat - the bypass/spawn doctrine, the hold, the verify snippet, the tri-state verdict. Naming
a chat is a caller saying WHICH one, never a caller saying "press it regardless".

`--min-wait SECS` moves the quiet threshold that MIN_WAIT_SECS sets, and with `--session` it
defaults to 0. The 4-minute wait exists so a SWEEP does not click at a healthy chat whose
command is merely still running; a caller naming one session has already observed that chat
sitting on a prompt, and making it wait out a window it has often already waited is the whole
reason "clear this stall" was not a usable path.

Usage: python unblock_prompts.py [--json]        # what is stuck, and what would be pressed
       python unblock_prompts.py --yes [--max N] # press them
       python unblock_prompts.py --session <id> [--session <id>] [--yes]   # just these
       python unblock_prompts.py --min-wait 0 --json                       # ignore the quiet gate
Exit:  0 nothing stuck, or everything pressed - 2 something did not clear (each named) -
       3 bad usage (an unknown flag) - 1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from lib import approvallib
from lib import configlib
from lib import armlib, clilib
from lib import deliverylib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib
from lib import windowlib

ACTUATOR = Path(__file__).resolve().parent / "actuator" / "approve_prompt.ps1"
DEFAULT_MAX = configlib.get("unblock.max_presses")
# Below this, an unanswered tool call is simply a command that is still running. A permission
# prompt does not resolve itself, so waiting a little costs nothing and avoids clicking at a
# healthy chat mid-command.
MIN_WAIT_SECS = configlib.get("unblock.min_wait_secs")


def _pending_record(transcript: Path) -> dict | None:
    """This chat's newest record, when it is a tool call with no result - that is the
    waiting shape. None otherwise. Returns the record itself (not just a bool) so the
    caller can classify what the pending call would actually DO (approvallib.classify)."""
    raw = gatelib.read_transcript_tail_text(str(transcript), 64 * 1024)
    if not raw:
        return None
    records = gatelib.parse_tail_records(raw[0], raw[1])
    if not records:
        return None
    last = records[-1]
    return last if (last["has_tool_use"] and not last["has_tool_result"]) else None


def find_stuck(only: set[str] | None = None,
               min_wait_secs: float | None = None) -> list[dict]:
    """Every chat waiting on a permission prompt, newest wait first.

    `only` NARROWS the scan to those session ids and nothing else - it is which-chat, never
    a waiver: every rail below (live engine, the waiting shape, bypass/spawn doctrine, the
    hold, the verify snippet) is applied to a named chat exactly as it is to a swept one.
    `min_wait_secs` overrides MIN_WAIT_SECS for this scan; see the module docstring for why a
    named session defaults it to 0."""
    wait_floor = MIN_WAIT_SECS if min_wait_secs is None else max(0.0, float(min_wait_secs))
    fleet = hydralib.fleet()
    tpath = stamplib.transcript_index(fleet)
    live = {s.get("sessionId") for s in
            hydralib.api_get("/api/sessions/live").get("sessions", [])}
    now = time.time()
    out: list[dict] = []
    seen: set[str] = set()
    for store in stamplib.store_roots(fleet):
        for path, meta in stamplib.iter_metas(store["root"]):
            if meta.get("isArchived"):
                continue
            sid = str(meta.get("cliSessionId") or path.stem.replace("local_", ""))
            if not sid or sid in seen or sid not in live:
                continue
            if only and sid not in only:
                continue
            f = tpath.get(sid)
            if not f or not f.exists():
                continue
            try:
                quiet = now - f.stat().st_mtime
            except OSError:
                continue
            if quiet < wait_floor:
                continue
            pending = _pending_record(f)
            if pending is None:
                continue
            seen.add(sid)
            # THE TRI-STATE VERDICT (ported idea, hermes-agent approval.py - see
            # lib/approvallib.py): what the pending tool call would actually DO, not just
            # that its permission mode says never-ask. DENY overrides bypass doctrine
            # entirely - a chat consented to a MODE, never to a specific destructive command.
            tool_name, cmd_text = approvallib.pending_command_text(pending)
            verdict, verdict_reason, verdict_key = approvallib.classify(tool_name, cmd_text)
            held = holdlib.why_blocked(sid)
            # THE IDENTITY PROOF (review 2026-09-01): the actuator identified the chat by TITLE
            # alone, and same-titled chats in two instances are a known fleet shape. The chat's
            # own last words, read from its transcript, are the positive proof - the same rail
            # the courier's composer send uses. No distinctive words = not pressed, and said so.
            # Its own last words; failing those, its FIRST prompt as the pane renders it
            # (live soak, 2026-09-01: a chat sat 29 min on a prompt because its last line
            # was too short to aim on, while its opening request was right there on screen).
            verify = (deliverylib._verify_snippet(deliverylib.transcript_tail_text(str(f)))
                      or deliverylib._verify_snippet(gatelib.pane_words(gatelib.first_user_prompt(str(f)))))
            # A CHAT THE TOOLBOX SPAWNED WITH BYPASS PROMISED (2026-09-01): a deeplink-born
            # chat starts in the app's default mode and its picker is hidden while a prompt
            # is pending, so it can neither be stamped nor switched - and refusing it as "a
            # person's call" leaves a chat nobody configured stuck forever. The spawn record
            # (ledger kind 'spawned', within a day) is the provenance that makes pressing here
            # the doctrine's own word rather than invented consent.
            spawned = any(r.get("kind") == "spawned" and r.get("session") == sid
                          and now * 1000 - r.get("at", 0) < 24 * 3600 * 1000
                          for r in ledgerlib._load())
            bypass_by_promise = spawned and not stamplib.is_bypass(meta)
            out.append({
                "sessionId": sid, "title": meta.get("title") or "",
                "instance": store["instance"], "appRunning": store["isRunning"],
                # the exact profile dir: path-shaped, so the actuator matches the instance
                # EXACTLY instead of by a bare-name substring ('pap3r rotate' vs 'rotate2')
                "instanceDir": str(store["root"].parent),
                "mode": meta.get("permissionMode"), "quietMins": round(quiet / 60, 1),
                "held": held, "verify": verify, "spawnedByToolbox": spawned,
                # THE TRI-STATE VERDICT fields: `eligible` below stays the STRUCTURAL check
                # (mode/hold/app/verify) it always was - main()'s selection intersects it with
                # `verdict` (see _select() below), so nothing here breaks a caller reading
                # `eligible` for the old meaning. DENY/ESCALATE rows are structurally eligible
                # but never make it into a press without the verdict's own say-so.
                "toolName": tool_name, "command": cmd_text[:500],
                "verdict": verdict, "verdictReason": verdict_reason, "verdictKey": verdict_key,
                "eligible": ((stamplib.is_bypass(meta) or bypass_by_promise)
                             and store["isRunning"] and not held and bool(verify)),
                "ineligibleWhy": ("" if verify else
                                  "no distinctive last words to prove the pane - never pressed blind"),
                "why": ("spawned by the toolbox with bypass promised - pressed on that record"
                        if bypass_by_promise else ""),
            })
    out.sort(key=lambda r: -r["quietMins"])
    return out


# Selecting a chat's sidebar row CHANGES WHICH CHAT THE OWNER IS LOOKING AT in that window.
# Below this much waiting, an unanswered tool call is far more likely a long command than a
# prompt, so the row is never selected for it - the pane is only checked as it stands.
SELECT_AFTER_SECS = configlib.get("unblock.select_after_secs")
# This many presses failing in a row for one chat stops being bad luck and becomes something a
# person has to look at - it is raised as an incident rather than re-queued in silence.
SURFACE_AFTER_FAILURES = configlib.get("unblock.surface_after_failures")


def _row_quiet_secs(row: dict) -> float:
    """How long this row has been waiting, in seconds - find_stuck()'s own `quietMins` for a
    normal stuck-prompt row (fault found on review, 2026-09-04: press() is also called with
    an ESCALATION row from interview.py's apply_answers 'approve' branch, shaped by
    approvallib.queue_escalation/get_escalation, which carries `queuedAt` but no `quietMins`
    at all - a bare `row["quietMins"]` raised KeyError there, and press()'s own broad
    `except Exception` turned that into a fabricated-looking "actuator error" that silently
    skipped the -Select retry for every escalation approval). Falls back to the time since
    the row was queued, which is the same "has this been sitting a while" question find_stuck
    answers for its own rows."""
    if "quietMins" in row:
        return row["quietMins"] * 60
    queued_at = row.get("queuedAt")
    if queued_at:
        return max(0.0, (time.time() * 1000 - queued_at) / 1000)
    return 0.0


def _press_streak(row: dict, ok: bool, detail: str) -> int:
    """Remember how this press went; return how many have now failed in a row for this chat.

    ⛔ A PRESS THAT CANNOT REACH ITS PANE RE-QUEUES FOREVER AND SAYS NOTHING (2026-09-11,
    seen twice from the standing overlord chat: `interview --apply` approved a chat and the
    actuator answered exit 4 on both passes). Nothing counted those failures, so a chat that
    can never be reached looks exactly like one that has not been tried yet, and the same
    futile press comes round on every tick. One ledger row per press fixes both halves:
    annotate(failure=True) files the incident the same way every other act in this toolbox
    files one, and the count is what the report can finally say out loud. Bookkeeping never
    fails a lane: any error here leaves the press's own verdict untouched."""
    sid = str(row.get("sessionId") or row.get("id") or "")
    if not sid:
        return 0
    try:
        if ok:
            ledgerlib.clear("approval", sid)  # it cleared: the streak is over
            return 0
        ledgerlib.note("approval", sid, note=f"press for '{row.get('title')}'"[:160])
        ledgerlib.annotate("approval", sid, (detail or "press failed")[:160], failure=True)
        return int(ledgerlib.check("approval", sid).get("attempts") or 0)
    except Exception:  # a ledger hiccup must never change what the actuator said
        return 0


def press(row: dict, always_select: bool = False) -> dict:
    """Press this chat's pending permission prompt through the actuator.

    `always_select` is A PERSON ASKING FOR THIS CHAT (interview.py's approve branch): the
    row selection flips what the owner is looking at, which is why an unattended lane earns
    it only after SELECT_AFTER_SECS - but a person who just answered a question about THIS
    chat has already decided where the window should be. Without it, an escalation answered
    before that window elapsed never got the second attempt at all, and the answer the
    person gave died as "could not reach that chat's pane"."""
    if not ACTUATOR.exists():
        return {**row, "ok": False, "outcome": f"actuator missing at {ACTUATOR}"}

    def run(select: bool):
        args = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ACTUATOR),
                "-Title", str(row["title"]),
                "-Instance", str(row.get("instanceDir") or row["instance"])]
        if row.get("verify"):
            args += ["-VerifyText", str(row["verify"])]  # rail 2b: its own words, or no press
        if select:
            args.append("-Select")
        return clilib.run_text(args, timeout=180)

    try:
        # ONE DRIVER PER WINDOW (windowlib.instance_lock): a sidebar click here while the
        # courier is typing into the same window switches the pane under its keystrokes.
        with windowlib.instance_lock(row["instance"], wait_secs=30) as mine:
            if not mine:
                return {**row, "ok": False,
                        "outcome": ("skipped - that instance's window is busy (another lane "
                                    "is driving it); next pass")}
            # First without touching the sidebar: if this chat is already the open one, the
            # prompt is right there. Only a chat that has waited a long time earns a row
            # selection, because that flips the owner's view of that window (every 5 minutes,
            # for every long-running command, was the first cut's behaviour).
            r = run(select=False)
            if r.returncode == 4 and (always_select or _row_quiet_secs(row) >= SELECT_AFTER_SECS):
                r = run(select=True)
    except Exception as err:  # a stuck chat is not worth crashing the lane over
        return {**row, "ok": False, "outcome": f"actuator error: {str(err)[:120]}"}
    said = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
    detail = said[-1][:180] if said else ""
    ok = r.returncode == 0
    # Exit 3 is "there was no prompt to press" - the chat is not stuck, the row was stale. That is
    # not a press that failed, and counting it would file an incident about a chat that is fine.
    streak = _press_streak(row, ok or r.returncode == 3, detail)
    # ⛔ NAME THE FAILURE, DO NOT JUST LABEL IT. "could not reach that chat's pane" sent a
    # whole session after the wrong thing: the actuator's own last line says WHICH window it
    # drove and which rows it could see, and that line was being dropped into a `detail` field
    # nobody printed. A bare refusal is not diagnosable; this one is.
    outcome = ("approved - the chat carries on" if ok
               else "no prompt showing (it may have cleared)" if r.returncode == 3
               else f"could not reach that chat's pane - {detail}" if r.returncode == 4
               else "did NOT clear")
    if streak >= SURFACE_AFTER_FAILURES:
        outcome += (f" [{streak} presses in a row have failed for this chat - filed as an "
                    "incident; it will keep failing until someone looks]")
    return {**row, "ok": ok, "exit": r.returncode, "outcome": outcome,
            "failedStreak": streak, "detail": detail}


def _run_context(argv: list[str]) -> str:
    """"interactive" when a person ran this by hand - `--force` is that same person's own
    word armlib.refuse_unless_armed already treats specially (a deed a person asks for
    directly, bypassing the tray switch). "unattended" otherwise: the tray-armed scheduled
    run. Reuses armlib's OWN armed/unattended split rather than inventing a second one
    (item 2, 2026-09-04): UNATTENDED presses only the APPROVE class; INTERACTIVE may also
    press ESCALATE, after showing the command in the report."""
    return "interactive" if "--force" in argv else "unattended"


def _select(stuck: list[dict], context: str) -> tuple[list[dict], list[dict], list[dict]]:
    """The structurally-eligible rows (find_stuck's own `eligible`), split by their
    tri-state verdict into (press_candidates, queued_for_judgment, denied). A structurally
    INeligible row (mode/hold/app/verify) never appears in any of the three - that bucket is
    about the CHAT's doctrine, not what the pending command would do.

    DENY is never pressed in either context - a chat's bypassPermissions mode is consent to
    never being ASKED, not consent to any specific destructive command that happens to be
    pending. ESCALATE presses only when a person is watching (context == 'interactive');
    unattended, it goes to the judgment queue instead of being pressed on a guess."""
    press_candidates: list[dict] = []
    queued: list[dict] = []
    denied: list[dict] = []
    for r in stuck:
        if not r["eligible"]:
            continue
        if r["verdict"] == approvallib.DENY:
            denied.append(r)
        elif r["verdict"] == approvallib.APPROVE:
            press_candidates.append(r)
        elif context == "interactive":
            press_candidates.append(r)
        else:
            queued.append(r)
    return press_candidates, queued, denied


def _resolve_max_cap(argv: list[str]) -> tuple[int, str | None]:
    """--max N from argv, or DEFAULT_MAX when the flag is absent. `error` is set (and `cap`
    unusable) when the value given is not a positive whole number - the caller prints it to
    stderr and exits 1."""
    if "--max" not in argv:
        return DEFAULT_MAX, None
    i = argv.index("--max")
    raw = argv[i + 1] if i + 1 < len(argv) else ""
    if not raw.isdigit() or int(raw) < 1:
        return DEFAULT_MAX, f"unblock FAILED: --max needs a positive whole number, got {raw!r}"
    return int(raw), None


# WHAT THIS BUILD UNDERSTANDS, stated in its own --json payload.
#
# ⛔ THE FAILURE THIS EXISTS TO PREVENT, and it is silent. main() below reads the flags it knows
# out of argv; an OLDER copy of this script does not know `--session`, and argv parsing by
# lookup IGNORES what it does not recognise. So a caller that names one chat and is answered by
# a build predating this flag does not get an error - it gets a FLEET-WIDE run, with `--yes`,
# pressing prompts in chats nobody named. That is exactly backwards from what was asked for.
# The daemon makes this a live risk rather than a theoretical one: it runs whatever orchestrator
# copy is INSTALLED next to it (server/src/orchestrator.ts, AGENTHYDRA_ORCHESTRATOR_DIR), which
# is not necessarily this checkout. A caller acting on named sessions therefore plans first and
# refuses to act unless it sees its flag named here (server/src/mcp.ts, `unblock_prompts`).
SUPPORTS = ("session", "min-wait")

# Flags main() knows. A flag NOT in here is a typo or a newer caller's word, and either way
# acting on it as though it had been understood is the silent fleet-wide press described above.
_FLAGS_NO_VALUE = frozenset({"--json", "--yes", "--force", "--help", "-h"})
_FLAGS_WITH_VALUE = frozenset({"--max", "--session", "--min-wait"})


def _unknown_args(argv: list[str]) -> list[str]:
    """Anything in argv this build does not understand. Values belonging to a known flag are
    consumed with it, so `--max 3` never reports `3` as unknown."""
    unknown: list[str] = []
    i = 0
    while i < len(argv):
        word = argv[i]
        if word in _FLAGS_WITH_VALUE:
            i += 2
            continue
        if word in _FLAGS_NO_VALUE:
            i += 1
            continue
        unknown.append(word)
        i += 1
    return unknown


def _requested_sessions(argv: list[str]) -> list[str]:
    """Every `--session` value, in order, de-duplicated. A comma list counts as several, so
    one `--session a,b` and two `--session` flags mean the same thing."""
    out: list[str] = []
    for i, word in enumerate(argv):
        if word != "--session" or i + 1 >= len(argv):
            continue
        for part in str(argv[i + 1]).split(","):
            sid = part.strip()
            if sid and sid not in out:
                out.append(sid)
    return out


def _resolve_min_wait(argv: list[str], targeted: bool) -> tuple[float, str | None]:
    """(the quiet threshold for this run, error). Absent `--min-wait`, a TARGETED run waits 0
    and a sweep keeps MIN_WAIT_SECS - the docstring's own reasoning: the wait protects a chat
    found by a sweep from being clicked at mid-command, and a caller naming a session has
    already looked at it."""
    if "--min-wait" not in argv:
        return (0.0 if targeted else float(MIN_WAIT_SECS)), None
    i = argv.index("--min-wait")
    raw = argv[i + 1] if i + 1 < len(argv) else ""
    try:
        secs = float(raw)
    except ValueError:
        return 0.0, f"unblock FAILED: --min-wait needs a number of seconds, got {raw!r}"
    if secs < 0:
        return 0.0, f"unblock FAILED: --min-wait cannot be negative, got {raw!r}"
    return secs, None


def _missing_report(requested: list[str], stuck: list[dict]) -> list[dict]:
    """The named chats that produced no row: named, with the honest reason, rather than left
    to read as "nothing was stuck". A caller steering one chat needs to tell "I cleared it"
    apart from "that chat is not waiting on anything I can press"."""
    found = {r["sessionId"] for r in stuck}
    return [{"sessionId": sid,
             "why": ("not waiting on a permission prompt right now - its engine is not live, "
                     "its newest record is not an unanswered tool call, or it has not been "
                     "quiet long enough (--min-wait)")}
            for sid in requested if sid not in found]


def _ineligible_reason(row: dict) -> str:
    """Why one stuck-but-not-eligible chat was left alone, for the text report.
    r["ineligibleWhy"] is already computed (find_stuck) for the verify-snippet failure - use
    it first so a chat whose app IS running but only failed that check never gets blamed for
    "its app is not running" (a bug found on review, 2026-09-01: the verify-snippet reason was
    computed and then never read here)."""
    if row["ineligibleWhy"]:
        return row["ineligibleWhy"]
    if row["held"]:
        return "the owner put it on HOLD"
    if row["mode"] != stamplib.BYPASS:
        return (f"its mode is {row['mode']}, not bypassPermissions - this one is genuinely "
                "a person's call")
    return "its app is not running"


def _print_text_report(stuck: list[dict], results: list[dict], eligible: list[dict],
                        act: bool, queued: list[dict] | None = None,
                        denied: list[dict] | None = None, context: str = "unattended",
                        missing: list[dict] | None = None) -> None:
    """The human-readable (non --json) report: what is stuck, what was pressed (if anything),
    what got DENIED or ESCALATED by the tri-state gate, why every remaining stuck chat was
    left alone, and (when sessions were named) which named chat was not waiting at all."""
    queued = queued or []
    denied = denied or []
    missing = missing or []

    def _say_missing() -> None:
        for row in missing:
            print(f"  -- {row['sessionId']}: {row['why']}")

    if not stuck:
        print("no chat is waiting on a permission prompt.")
        _say_missing()
        return
    print(f"{len(stuck)} chat(s) waiting on a permission prompt ({context} run):")
    for r in (results or eligible):
        mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
        tag = (f"  [ESCALATE, shown then pressed: {r['command'][:100]!r}]"
               if r.get("verdict") == approvallib.ESCALATE else "")
        print(f"  {mark}[{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m"
              + (f" -> {r['outcome']}" if results else "") + tag)
    for r in denied:
        print(f"  XX [{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m: "
              f"DENIED - {r['verdictReason']} (command: {r['command'][:120]!r})")
    for r in queued:
        print(f"  >> [{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m: "
              f"ESCALATED to the judgment queue - {r['verdictReason']} "
              f"(command: {r['command'][:120]!r})")
    for r in stuck:
        if r["eligible"]:
            continue
        print(f"  ?? [{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m: "
              f"{_ineligible_reason(r)}")
    _say_missing()
    if not act and eligible:
        print("\nPLAN ONLY - add --yes to answer the prompts these chats should never have seen.")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv
    # A FLAG THIS BUILD DOES NOT KNOW IS A REFUSAL, NOT A SHRUG (see SUPPORTS above). Argv is
    # read by lookup, so an unrecognised word used to be ignored in silence - and the word most
    # likely to be mistyped is the one that NARROWS the run, which means the typo's punishment
    # was a fleet-wide press. Nothing is scanned or pressed until argv is understood.
    unknown = _unknown_args(argv)
    if unknown:
        print(f"unblock FAILED: unknown argument(s) {' '.join(unknown)} - this build understands "
              f"{' '.join(sorted(_FLAGS_NO_VALUE | _FLAGS_WITH_VALUE))}", file=sys.stderr)
        return 3
    if act and not configlib.get("unblock.enabled"):
        # THE MASTER SWITCH (2026-09-17). Stuck prompts are still found and still reported -
        # they are simply never pressed, so every one of them becomes yours to answer.
        print("PLAN ONLY - answering permission prompts is switched OFF in your policy "
              "(unblock.enabled).")
        act = False
    # THE ARMED WINDOW (owner order, 2026-09-01): unattended acting needs a person's open
    # window (`python orch.py arm`) or --force. Disarmed: fall back to plan-only and say so.
    if act:
        refusal = armlib.refuse_unless_armed(argv, "pressing permission prompts")
        if refusal:
            print(refusal)
            act = False
    cap, cap_error = _resolve_max_cap(argv)
    if cap_error:
        print(cap_error, file=sys.stderr)
        return 1
    requested = _requested_sessions(argv)
    min_wait, wait_error = _resolve_min_wait(argv, bool(requested))
    if wait_error:
        print(wait_error, file=sys.stderr)
        return 1

    context = _run_context(argv)
    try:
        stuck = find_stuck(only=set(requested) or None, min_wait_secs=min_wait)
    except hydralib.DaemonError as err:
        print(f"unblock FAILED: {err}", file=sys.stderr)
        return 1
    missing = _missing_report(requested, stuck)
    press_candidates, queued, denied = _select(stuck, context)
    eligible = press_candidates[:cap]
    results = [press(r) for r in eligible] if act else []
    # Queuing an ESCALATE row for the judgment queue is itself an ACT (it mutates shared
    # state other lanes read), so it is gated on `act` exactly like a press - a plan-only or
    # disarmed run must observe without writing (armlib's own "seeing is not doing").
    if act:
        for r in queued:
            approvallib.queue_escalation(
                r["sessionId"], title=r["title"], instance=r["instance"],
                instance_dir=r.get("instanceDir") or r["instance"], verify=r["verify"],
                command=r["command"], tool_name=r["toolName"], reason=r["verdictReason"])

    if as_json:
        print(json.dumps({"stuck": stuck, "results": results, "context": context,
                          "queuedForJudgment": queued, "denied": denied,
                          # `supports` is this build naming its own flags, so a caller can tell
                          # "narrowed to the chat I named" from "an older copy ignored --session
                          # and swept the fleet" - the two are otherwise identical on the wire.
                          "supports": list(SUPPORTS),
                          "requested": requested, "notFound": missing}, indent=2))
        return 2 if [r for r in results if not r["ok"]] else 0

    _print_text_report(stuck, results, eligible, act, queued, denied, context, missing)
    return 2 if [r for r in results if not r["ok"]] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
