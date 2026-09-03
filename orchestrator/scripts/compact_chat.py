#!/usr/bin/env python3
"""compact_chat.py - ACT: COMPACT one console/CLI chat's context instead of abandoning it.

Sometimes the answer to a full context is a fresh chat; sometimes (owner, 2026-08-31) it is
worth COMPACTING the one that exists. There is no supported on-demand headless /compact
(checked against the docs, 2026-08-31), but the same pass CAN be forced: resume the saved
session headlessly with a small --autocompact window and a do-nothing prompt, and the
engine's own auto-compact fires before the turn runs. This script owns that maneuver plus
the rails around it.

SCOPE - CONSOLE/CLI SESSIONS ONLY. A desktop chat is REFUSED (deterministic): resuming it
outside its app would fork the conversation behind the app's back (the same reason imports
refuse live sessions). Desktop chats compact through their app's own autocompact; and the
owner never restarts the apps, so nothing here touches them.

WHAT A RUN COSTS, honestly: one real model turn on the session's account, and compaction
itself is lossy by design - detail is summarized away. Pick subjects accordingly; the
--min floor keeps it away from small chats where a fresh start is free.

THE NO-WORK GUARANTEE IS MECHANICAL, not words (owner law, 2026-08-31: never rely on
prompt advice where a parameter exists): the turn runs with `--tools ""`, the CLI's
documented switch that disables EVERY tool - the model cannot run a command, edit a file,
or continue work no matter how it reads the prompt. The prompt text is just an honest
label for the transcript.

VERIFICATION: context is measured from the transcript's own usage stamps before and after;
success = a compact marker in the continued transcript OR a real shrink. The continuation
keeps whatever session id the engine reports (same id, or a rolled one - both are handled
and reported).

Usage: python compact_chat.py <session id | title fragment> [--window N] [--min N] [--json]
       --window N   the autocompact budget handed to the engine (default 100000 tokens)
       --min N      refuse-as-unnecessary floor: contexts under this are not compacted
                    (default 150000 tokens)
Exit:  0 compacted and verified (or honestly not needed - under --min) - 2 the turn ran but
       no compaction was observed (context vs window reported) - 3 deterministic refusal
       (desktop chat, unknown chat, missing transcript/cwd) - 4 possibly mid-work (recent
       transcript activity; transient) - 5 breaker - 6 held - 1 failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from lib import clilib, holdlib
from lib import hydralib
from lib import ledgerlib

DEFAULT_WINDOW = 100_000
DEFAULT_MIN = 150_000
QUIET_SECS = 180  # matches the gate's idle threshold: newer activity = possibly mid-work
TURN_TIMEOUT_SECS = 1800  # compaction of a huge context is a long model pass
TAIL_BYTES = 4_000_000  # usage stamps live near the end; never read a 500MB transcript whole
COMPACT_MARKERS = ("compact_boundary", "isCompactSummary")
MAINTENANCE_PROMPT = (
    "This is an automated context-maintenance turn from the orchestrator (tools are disabled "
    "for this turn). Nothing is asked of you. Reply with exactly: MAINTENANCE OK"
)


def context_tokens(transcript: str | Path) -> int | None:
    """The chat's current context size, from the LAST usage stamp in its transcript tail.
    None when no stamp is readable - unknown must never read as 'small'."""
    p = Path(transcript)
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line the seek landed in
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    for line in reversed(tail.splitlines()):
        if '"usage"' not in line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage = ((row.get("message") or {}).get("usage")) or row.get("usage") or {}
        total = sum(
            int(usage.get(k) or 0)
            for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        )
        if total:
            return total
    return None


def resolve_claude() -> str | None:
    """The claude CLI executable, overridable for odd installs via ORCHESTRATOR_CLAUDE_EXE."""
    override = os.environ.get("ORCHESTRATOR_CLAUDE_EXE")
    if override:
        return override
    for name in ("claude.cmd", "claude.exe", "claude"):
        hit = shutil.which(name)
        if hit and not hit.lower().endswith(".ps1"):  # a .ps1 shim is not directly runnable
            return hit
    # the npm shim's own target, the standard install location
    exe = Path.home() / "AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    return str(exe) if exe.exists() else None


def run_turn(exe: str, session_id: str, window: int, cwd: str) -> tuple[int, str]:
    """The forced-autocompact resume turn. Returns (exit code, stdout)."""
    r = subprocess.run(
        [exe, "-p", "--resume", session_id, "--autocompact", str(window),
         # MECHANICAL no-work guarantee (docstring): every tool disabled for this turn.
         "--tools", "",
         "--output-format", "json", MAINTENANCE_PROMPT],
        capture_output=True, text=True, timeout=TURN_TIMEOUT_SECS, cwd=cwd,
    )
    return r.returncode, (r.stdout or "") + (("\n" + r.stderr) if r.returncode != 0 else "")


def out(payload: dict, as_json: bool, code: int) -> int:
    print(json.dumps(payload, indent=2) if as_json else payload["report"])
    return code


def main(argv: list[str], runner=None) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    window, floor = DEFAULT_WINDOW, DEFAULT_MIN
    args: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--window" and i + 1 < len(argv):
            window = int(argv[i + 1]); i += 2; continue
        if a == "--min" and i + 1 < len(argv):
            floor = int(argv[i + 1]); i += 2; continue
        if not a.startswith("--"):
            args.append(a)
        i += 1
    if len(args) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 3

    try:
        rows = hydralib.sessions()
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"compact FAILED: {err}"}, as_json, 1)
    hits = [r for r in rows if r.get("session_id") == args[0]]
    if not hits:
        q = args[0].lower()
        hits = [r for r in rows if q in str(r.get("title") or "").lower()]
    if not hits:
        return out({"ok": False, "report": f"REFUSED (deterministic): no session matches {args[0]!r}"},
                   as_json, 3)
    if len(hits) > 1:
        names = ", ".join(f"[{h.get('instance') or 'console'}] {h.get('title')}" for h in hits[:6])
        return out({"ok": False, "report": f"REFUSED (deterministic): {len(hits)} sessions match: {names}"},
                   as_json, 3)
    row = hits[0]
    sid = row.get("session_id") or ""
    title = row.get("title")

    if row.get("instance"):
        return out(
            {"ok": False, "report": (
                f"REFUSED (deterministic): '{title}' lives in the DESKTOP ({row['instance']}). "
                "Resuming it outside its app would fork the conversation behind the app's back. "
                "Desktop chats compact through their app's own autocompact.")},
            as_json, 3)

    hold_why = holdlib.why_blocked(sid)
    if hold_why:
        return out({"ok": False, "held": True, "report": f"REFUSED: {hold_why}"}, as_json, 6)

    transcript = row.get("transcript_path") or ""
    tp = Path(transcript)
    if not transcript or not tp.exists():
        return out({"ok": False, "report": (
            f"REFUSED (deterministic): '{title}' has no readable transcript at {transcript!r}")},
            as_json, 3)
    cwd = row.get("cwd") or ""
    if not cwd or not Path(cwd).is_dir():
        return out({"ok": False, "report": (
            f"REFUSED (deterministic): '{title}' worked in {cwd!r}, which no longer exists - "
            "a resume there cannot run")}, as_json, 3)

    quiet = time.time() - tp.stat().st_mtime
    if quiet < QUIET_SECS:
        return out({"ok": False, "report": (
            f"REFUSED: '{title}' wrote to its transcript {int(quiet)}s ago - possibly mid-work. "
            f"Retry once it has been quiet {QUIET_SECS}s.")}, as_json, 4)
    # A QUIET TRANSCRIPT IS NOT A DEAD ENGINE (review 2026-09-01). A session parked at its
    # prompt, or inside a long tool call, writes nothing for minutes while its process is
    # alive - and a second `--resume` against a live session forks the transcript both then
    # append to, the very thing imports refuse. The fleet has the pid-checked signal
    # (migrate_chat refuses on it); ask it. Unknown never reads as "not live".
    try:
        live = hydralib.live_for(sid)
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": (
            f"compact FAILED: cannot tell whether '{title}' holds a live engine ({err}) - "
            "unknown never reads as 'not live'")}, as_json, 1)
    if live:
        return out({"ok": False, "report": (
            f"REFUSED: '{title}' still holds a LIVE engine (pid {live.get('pid')}) even though "
            f"its transcript has been quiet {int(quiet)}s - a second --resume would fork it. "
            "Retry once the session has exited.")}, as_json, 4)

    before = context_tokens(tp)
    if before is None:
        return out({"ok": False, "report": (
            f"REFUSED (deterministic): '{title}' has no readable usage stamp - context size "
            "unknown, and unknown never reads as small")}, as_json, 3)
    if before < floor:
        return out({"ok": True, "compacted": False, "contextTokens": before, "report": (
            f"nothing to do: '{title}' is at ~{before // 1000}k tokens, under the --min floor "
            f"of {floor // 1000}k - a fresh chat is cheaper than a lossy compact")}, as_json, 0)

    brake = ledgerlib.check("compact", sid)
    if brake["suppressed"]:
        return out({"ok": False, "breaker": brake,
                    "report": f"SUPPRESSED by the breaker: {brake['why']}"}, as_json, 5)

    # The machine-wide concurrency cap: a compact turn IS a running chat for its duration.
    try:
        running = hydralib.running_count()
    except hydralib.DaemonError as err:
        return out({"ok": False, "report": f"compact FAILED: cannot count running chats ({err}) "
                    "- an unknown count never reads as room under the cap"}, as_json, 1)
    if running >= hydralib.MAX_RUNNING_CHATS:
        return out({"ok": False, "report": (
            f"REFUSED: {running} chat(s) already running - the machine-wide cap is "
            f"{hydralib.MAX_RUNNING_CHATS}. Transient; retry on a later cycle.")}, as_json, 4)

    exe = resolve_claude()
    if exe is None:
        return out({"ok": False, "report": (
            "compact FAILED: no claude CLI found (set ORCHESTRATOR_CLAUDE_EXE)")}, as_json, 1)

    ledgerlib.note("compact", sid, note=f"'{title}' ~{before // 1000}k -> window {window // 1000}k")
    run = runner or run_turn
    try:
        code, said = run(exe, sid, window, cwd)
    except subprocess.TimeoutExpired:
        return out({"ok": False, "report": (
            f"compact turn TIMED OUT after {TURN_TIMEOUT_SECS}s - attempt recorded; the "
            "session may still be finishing, check it before retrying")}, as_json, 1)
    if code != 0:
        return out({"ok": False, "report": (
            f"compact turn FAILED (claude exit {code}): {said.strip()[:300]} - attempt recorded")},
            as_json, 1)

    # Verify from the artifacts, not the exit code: the continued transcript must show a
    # compact marker or a real shrink.
    new_sid = sid
    try:
        payload = json.loads(said)
        new_sid = payload.get("session_id") or sid
    except json.JSONDecodeError:
        pass
    target = tp if new_sid == sid else tp.parent / f"{new_sid}.jsonl"
    marker = False
    if target.exists():
        try:
            with open(target, "rb") as f:
                size = target.stat().st_size
                if size > TAIL_BYTES:
                    f.seek(size - TAIL_BYTES)
                blob = f.read().decode("utf-8", errors="replace")
            marker = any(m in blob for m in COMPACT_MARKERS)
        except OSError:
            pass
    after = context_tokens(target) if target.exists() else None
    shrunk = after is not None and after < before * 0.6
    # "unknown" is not "0k": a tail with no readable usage stamp yet (normal right after a
    # compact boundary) must not print as a measured zero.
    after_txt = f"~{after // 1000}k" if after is not None else "unknown (no usage stamp yet)"

    if marker or shrunk:
        ledgerlib.clear("compact", sid)
        rolled = "" if new_sid == sid else f" (session id rolled to {new_sid})"
        return out({"ok": True, "compacted": True, "contextBefore": before, "contextAfter": after,
                    "sessionId": new_sid, "report": (
                        f"COMPACTED and verified: '{title}' ~{before // 1000}k -> "
                        f"{after_txt} tokens{rolled}.")}, as_json, 0)
    return out({"ok": False, "compacted": False, "contextBefore": before, "contextAfter": after,
                "sessionId": new_sid, "report": (
                    f"the turn ran but NO compaction was observed: '{title}' measured "
                    f"~{before // 1000}k before, {after_txt} after, window "
                    f"{window // 1000}k, no compact marker. Attempt recorded - check the "
                    "window against the context before retrying.")}, as_json, 2)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
