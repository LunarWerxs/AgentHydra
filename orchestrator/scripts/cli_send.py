#!/usr/bin/env python3
"""cli_send.py - ACT: deliver a message into a running CONSOLE chat, natively.

THE CONTRAST WORTH SEEING, because it is the argument for the whole console fleet. On the
desktop side a delivery is: resolve the chat, find its window, expand collapsed sidebar groups,
select its row, prove the pane belongs to that chat by matching a render-true snippet of its
own last words, type into the composer, press Send, then watch the transcript for growth -
seven rails, an accessibility tree, and every one of today's clicking defects.

Here it is: write two lines into the pipe that session published. The session id addresses it
and its token authenticates. There is no window, no snippet, nothing to aim.

WHAT STAYS, because it is judgment rather than transport: a HOLD is still hands-off, a turn
IN FLIGHT is still never interrupted for a composer-style send (the peer channel is safe
mid-turn - it enqueues and the session drains it after the current turn, like any SendMessage),
and a send is still not a delivery until the transcript MOVES.

Usage: python cli_send.py <sessionId> --text "..." [--force] [--json]
       python cli_send.py --list                     # what can be messaged right now
Exit:  0 delivered and the chat moved - 2 sent but not confirmed - 3 refused (held / not
       running / no token) - 1 failure.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cli_accounts
from lib import clilib, gatelib
from lib import holdlib
from lib import peerlib

CONFIRM_SECS = 90


def _targets() -> list[dict]:
    out = []
    for acct in cli_accounts.accounts():
        for rec in peerlib.live_sessions(acct["configDir"]):
            # THE CONSOLE LANE OWNS CONSOLE CHATS ONLY. A registry record whose entrypoint is
            # the desktop app's belongs to a desktop chat (its store may share a config dir);
            # messaging it from here would bypass every desktop rail (hydralib's ownership
            # rule, mirrored: positive evidence decides, never "no meta record").
            if str(rec.get("entrypoint") or "").startswith("claude-desktop"):
                continue
            out.append({**rec, "account": acct["name"]})
    return out


def send(session_id: str, text: str, force: bool = False) -> dict:
    rec = next((r for r in _targets() if str(r.get("sessionId")) == session_id), None)
    if not rec:
        return {"ok": False, "code": 3,
                "why": "no RUNNING console session with that id - start or resume it first"}
    held = holdlib.why_blocked(session_id)
    if held and not force:
        return {"ok": False, "code": 3, "why": f"the chat is HELD: {held}"}
    if not rec.get("token"):
        return {"ok": False, "code": 3,
                "why": "that session published no peer token - it cannot be messaged"}

    # The transcript is the only honest confirmation, exactly as on the desktop side.
    cfg = Path(rec["configDir"]) / "projects"

    def _transcript():
        return next(iter(cfg.glob(f"*/{session_id}.jsonl")), None)

    tp = _transcript()
    before = tp.stat().st_size if (tp and tp.exists()) else 0

    ok, detail = peerlib.send(rec, text)
    if not ok:
        return {"ok": False, "code": 1, "why": detail}

    deadline = time.time() + CONFIRM_SECS
    while time.time() < deadline:
        time.sleep(2)
        if tp is None:
            # A session that had not written its transcript yet at send time creates it on
            # its first turn: keep looking, or the confirm loop could never see it grow.
            tp = _transcript()
        if tp and tp.exists() and tp.stat().st_size > before:
            return {"ok": True, "code": 0, "account": rec["account"],
                    "detail": "enqueued and the chat moved"}
    return {"ok": False, "code": 2, "account": rec["account"],
            "why": f"enqueued, but the transcript has not grown in {CONFIRM_SECS}s - "
                   "it may still be finishing its current turn"}


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv

    if "--list" in argv:
        rows = _targets()
        if as_json:
            print(json.dumps([{k: v for k, v in r.items() if k != "token"} for r in rows],
                             indent=2))
            return 0
        print(f"{len(rows)} console chat(s) can be messaged right now:")
        for r in rows:
            verdict = None
            for p in (Path(r["configDir"]) / "projects").glob(f"*/{r['sessionId']}.jsonl"):
                verdict = gatelib.gate(r["sessionId"], str(p), {"pid": r["pid"]})
                break
            state = (verdict or {}).get("state", "?")
            print(f"  [{r['account']:<10}] {state:<8} {str(r.get('name'))[:28]:<28} "
                  f"{r['sessionId'][:8]}  pid {r['pid']}")
        return 0

    # Lift --text AND ITS VALUE out before collecting positionals (review 2026-09-01: the
    # value does not start with "--", so it counted as a second positional and the documented
    # invocation always failed with exit 3 - the same code that means held / not running).
    rest = list(argv)
    text = None
    if "--text" in rest:
        i = rest.index("--text")
        text = rest[i + 1] if i + 1 < len(rest) else None
        del rest[i:i + 2]
    args = [a for a in rest if not a.startswith("--")]
    if len(args) != 1 or not text:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    got = send(args[0], text, force="--force" in argv)
    if as_json:
        print(json.dumps(got, indent=2))
    elif got["ok"]:
        print(f"delivered to {got['account']}: {got['detail']}")
    else:
        print(f"NOT delivered: {got['why']}", file=sys.stderr)
    return got["code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
