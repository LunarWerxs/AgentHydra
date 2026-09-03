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

Usage: python unblock_prompts.py [--json]        # what is stuck, and what would be pressed
       python unblock_prompts.py --yes [--max N] # press them
Exit:  0 nothing stuck, or everything pressed - 2 something did not clear (each named) -
       1 daemon failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

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


def _pending(row_meta: dict, transcript: Path) -> bool:
    """Is this chat's newest record a tool call with no result? That is the waiting shape."""
    raw = gatelib.read_transcript_tail_text(str(transcript), 64 * 1024)
    if not raw:
        return False
    records = gatelib.parse_tail_records(raw[0], raw[1])
    if not records:
        return False
    last = records[-1]
    return bool(last["has_tool_use"] and not last["has_tool_result"])


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
            if quiet < MIN_WAIT_SECS or not _pending(meta, f):
                continue
            seen.add(sid)
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
        return subprocess.run(args, capture_output=True, text=True, timeout=180)

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
            if r.returncode == 4 and row["quietMins"] * 60 >= SELECT_AFTER_SECS:
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
    cap = DEFAULT_MAX
    if "--max" in argv:
        i = argv.index("--max")
        raw = argv[i + 1] if i + 1 < len(argv) else ""
        if not raw.isdigit() or int(raw) < 1:
            print(f"unblock FAILED: --max needs a positive whole number, got {raw!r}",
                  file=sys.stderr)
            return 1
        cap = int(raw)

    try:
        stuck = find_stuck()
    except hydralib.DaemonError as err:
        print(f"unblock FAILED: {err}", file=sys.stderr)
        return 1
    eligible = [r for r in stuck if r["eligible"]][:cap]
    results = [press(r) for r in eligible] if act else []

    if as_json:
        print(json.dumps({"stuck": stuck, "results": results}, indent=2))
        return 2 if [r for r in results if not r["ok"]] else 0

    if not stuck:
        print("no chat is waiting on a permission prompt.")
        return 0
    print(f"{len(stuck)} chat(s) waiting on a permission prompt:")
    for r in (results or eligible):
        mark = ("OK " if r.get("ok") else "XX ") if results else "-  "
        print(f"  {mark}[{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m"
              + (f" -> {r['outcome']}" if results else ""))
    for r in stuck:
        if r["eligible"]:
            continue
        # r["ineligibleWhy"] is already computed (find_stuck) for the verify-snippet failure -
        # use it first so a chat whose app IS running but only failed that check never gets
        # blamed for "its app is not running" (a bug found on review, 2026-09-01: the
        # verify-snippet reason was computed and then never read here).
        why = (r["ineligibleWhy"] or
               ("the owner put it on HOLD" if r["held"]
                else f"its mode is {r['mode']}, not bypassPermissions - this one is genuinely "
                     "a person's call" if r["mode"] != stamplib.BYPASS
                else "its app is not running"))
        print(f"  ?? [{r['instance']}] {r['title'][:52]} - waiting {r['quietMins']:.0f}m: {why}")
    if not act and eligible:
        print("\nPLAN ONLY - add --yes to answer the prompts these chats should never have seen.")
    return 2 if [r for r in results if not r["ok"]] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
