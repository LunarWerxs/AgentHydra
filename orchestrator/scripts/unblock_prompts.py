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

Usage: python unblock_prompts.py [--json]        # what is stuck, and what would be pressed
       python unblock_prompts.py --yes [--max N] # press them
Exit:  0 nothing stuck, or everything pressed - 2 something did not clear (each named) -
       1 daemon failure.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from lib import approvallib
from lib import armlib, clilib
from lib import deliverylib
from lib import gatelib
from lib import holdlib
from lib import hydralib
from lib import ledgerlib
from lib import stamplib
from lib import windowlib

ACTUATOR = Path(__file__).resolve().parent / "actuator" / "approve_prompt.ps1"
DEFAULT_MAX = 6
# Below this, an unanswered tool call is simply a command that is still running. A permission
# prompt does not resolve itself, so waiting a little costs nothing and avoids clicking at a
# healthy chat mid-command.
MIN_WAIT_SECS = 4 * 60


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


def find_stuck() -> list[dict]:
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
            f = tpath.get(sid)
            if not f or not f.exists():
                continue
            try:
                quiet = now - f.stat().st_mtime
            except OSError:
                continue
            if quiet < MIN_WAIT_SECS:
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
SELECT_AFTER_SECS = 15 * 60


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


def press(row: dict) -> dict:
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
            if r.returncode == 4 and _row_quiet_secs(row) >= SELECT_AFTER_SECS:
                r = run(select=True)
    except Exception as err:  # a stuck chat is not worth crashing the lane over
        return {**row, "ok": False, "outcome": f"actuator error: {str(err)[:120]}"}
    said = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
    detail = said[-1][:180] if said else ""
    return {**row, "ok": r.returncode == 0, "exit": r.returncode,
            "outcome": ("approved - the chat carries on" if r.returncode == 0
                        else "no prompt showing (it may have cleared)" if r.returncode == 3
                        else "could not reach that chat's pane" if r.returncode == 4
                        else "did NOT clear"),
            "detail": detail}


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
                        denied: list[dict] | None = None, context: str = "unattended") -> None:
    """The human-readable (non --json) report: what is stuck, what was pressed (if anything),
    what got DENIED or ESCALATED by the tri-state gate, and why every remaining stuck chat
    was left alone."""
    queued = queued or []
    denied = denied or []
    if not stuck:
        print("no chat is waiting on a permission prompt.")
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
    if not act and eligible:
        print("\nPLAN ONLY - add --yes to answer the prompts these chats should never have seen.")


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    act = "--yes" in argv
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

    context = _run_context(argv)
    try:
        stuck = find_stuck()
    except hydralib.DaemonError as err:
        print(f"unblock FAILED: {err}", file=sys.stderr)
        return 1
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
                          "queuedForJudgment": queued, "denied": denied}, indent=2))
        return 2 if [r for r in results if not r["ok"]] else 0

    _print_text_report(stuck, results, eligible, act, queued, denied, context)
    return 2 if [r for r in results if not r["ok"]] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
