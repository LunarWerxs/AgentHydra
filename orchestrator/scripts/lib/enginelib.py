"""enginelib - stop an IDLE desktop engine deliberately, so a stopped chat can move.

THE PROBLEM IT CLOSES (live smoke, 2026-09-01): the desktop app keeps a chat's claude.exe
alive indefinitely after the turn ends - 12+ minutes idle after a one-word answer, and a
freshly landed chat boots one straight away. migrate_chat's rule 2 (the import rewrites the
transcript, so a live writer refuses, force included) is right, but read against that fact
it meant NO desktop chat could ever move or be archived unattended: every one of them has a
writer, forever. The owner's order draws the line elsewhere: "Never move active chats. Only
chats that are stopped, waiting, chilling." A chat that finished its turn and has sat quiet
for minutes is chilling. Its engine is not working; it is waiting.

So this module is the one place that turns "idle" into "stopped", on purpose, with the same
evidence the gate uses:

  - the gate must say the engine is alive AND idle (its newest record is a completed
    assistant turn, or a tool call that predates this engine - nothing is in flight);
  - it must have been quiet for at least IDLE_STOP_SECS (a long quiet can be background
    work; five minutes after a completed turn is not);
  - a STUCK or mid-turn engine is never touched - that is the owner's line, and killing it
    would lose work.

Then the process is stopped (taskkill, the whole tree) and the daemon's own liveness read is
polled until it no longer lists the chat, so the caller acts on a confirmed state, never on
the kill having been issued. The transcript is already flushed by then - the engine had
finished writing minutes earlier - which is why this is safe where killing a mid-turn engine
is not. The desktop simply shows the chat as not running, and the next instruction (or a
landing elsewhere) resumes it with a fresh engine.

Callers: migrate_chat --stop-idle (the sweep's move and land lanes pass it) and archive_chat.
"""

from __future__ import annotations

import subprocess
import time

from lib import clilib
from lib import gatelib
from lib import hydralib

# A completed turn followed by this much silence is a chat that is waiting, not working.
IDLE_STOP_SECS = 300
# How long to wait for the daemon to stop listing the chat as live after the kill.
STOP_CONFIRM_SECS = 20

# Reason codes - the machine half of `why`. A caller deciding what to do next must branch on
# these, NEVER on the prose: string-sniffing a refusal is how "STUCK, a person decides" ends
# up treated like "quiet for 40s, come back later".
#
# ⛔ ONLY R_TOO_SOON is satisfiable by waiting. Every other code is a refusal that more time
# cannot cure - R_WORKING may become idle eventually but the wait is unbounded, and R_STUCK
# is explicitly a person's call. Anything that loops on this enum must test for R_TOO_SOON
# by equality and let every other code fall straight through to the refusal.
R_NO_ENGINE = "no_engine"
R_UNREADABLE = "gate_unreadable"
R_UNGATEABLE = "ungateable"
R_NOT_RUNNING = "not_running"
R_STUCK = "stuck"
R_WORKING = "working"
R_TOO_SOON = "too_soon"
R_IDLE = "idle"


def idle_report(match: dict, min_quiet_secs: int = IDLE_STOP_SECS) -> dict:
    """{idle, reason, why, quiet_secs, needs_secs}: may this engine be stopped right now?

    `match` is a resolved dossier match (hydralib.resolve_one) with its live block. Answers
    idle=False for anything the gate cannot read, anything mid-turn, anything stuck, and
    anything quiet for less than `min_quiet_secs` - `reason` says which, in one word a
    caller can branch on, and `needs_secs` is set ONLY on R_TOO_SOON, where the deficit is
    a real number of seconds rather than an open question."""
    def no(reason: str, why: str, **extra) -> dict:
        return {"idle": False, "reason": reason, "why": why,
                "quiet_secs": None, "needs_secs": None, **extra}

    live = match.get("live")
    if not live:
        return no(R_NO_ENGINE, "no engine is alive - nothing to stop")
    try:
        verdict = gatelib.gate_match(match, hydralib.session_row)
    except hydralib.DaemonError as err:
        return no(R_UNREADABLE, f"the gate could not read the chat ({err}) - not stopping blind")
    if verdict is None:
        return no(R_UNGATEABLE, "the transcript cannot be gated - not stopping blind")
    if verdict.get("state") != "running":
        return no(R_NOT_RUNNING,
                  f"the gate says {verdict.get('state')}, not a live engine - nothing to stop")
    if verdict.get("stalled"):
        return no(R_STUCK,
                  f"the engine looks STUCK, not idle ({verdict['stalled'].get('why', '')[:120]}) - a person decides")
    idle = verdict.get("idle")
    if not idle:
        return no(R_WORKING,
                  f"the engine is alive and may be working ({verdict.get('cause', '')[:140]})")
    quiet = int(idle.get("quiet_secs") or 0)
    if quiet < min_quiet_secs:
        return {"idle": False, "reason": R_TOO_SOON,
                "why": f"idle for only {quiet}s (needs {min_quiet_secs}s) - giving it time",
                "quiet_secs": quiet, "needs_secs": int(min_quiet_secs)}
    return {"idle": True, "reason": R_IDLE,
            "why": (f"idle: finished its turn and quiet {quiet}s"
                    + (" (pending call predates this engine)" if idle.get("orphaned_tool_call") else "")),
            "quiet_secs": quiet, "needs_secs": int(min_quiet_secs)}


def idle_verdict(match: dict, min_quiet_secs: int = IDLE_STOP_SECS) -> tuple[bool, str]:
    """(idle, why) - the long-standing 2-tuple shape, over idle_report's richer answer."""
    report = idle_report(match, min_quiet_secs)
    return report["idle"], report["why"]


def stop_idle_engine(match: dict, min_quiet_secs: int = IDLE_STOP_SECS) -> dict:
    """Stop the chat's idle engine and CONFIRM it is gone. Returns
    {stopped: bool, pid, why, reason, quiet_secs, needs_secs, confirmedSecs}. Never touches a
    working or stuck engine. `reason` is idle_report's code, so a caller can tell the one
    refusal that time cures (R_TOO_SOON) from every refusal that it does not."""
    report = idle_report(match, min_quiet_secs)
    idle, why = report["idle"], report["why"]
    pid = (match.get("live") or {}).get("pid")
    # The refusal carries the machine-readable reason and, on R_TOO_SOON, the exact deficit -
    # so a caller that is allowed to wait can sleep the right number of seconds instead of
    # guessing, and a caller that is not can still tell a stuck engine from a young one.
    refusal = {"stopped": False, "pid": pid, "why": why, "reason": report["reason"],
               "quiet_secs": report["quiet_secs"], "needs_secs": report["needs_secs"]}
    if not idle:
        return refusal
    try:
        clilib.run_text(["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                       timeout=30)
    except (OSError, ValueError, subprocess.TimeoutExpired) as err:
        return {**refusal, "why": f"taskkill failed: {err}"}
    sid = match.get("cliSessionId") or match.get("sessionId") or ""
    t0 = time.time()
    while time.time() - t0 < STOP_CONFIRM_SECS:
        try:
            if not hydralib.live_for(sid):
                return {**refusal, "stopped": True, "reason": R_IDLE, "why": why,
                        "confirmedSecs": round(time.time() - t0, 1)}
        except hydralib.DaemonError:
            pass  # a flaky read is not a confirmation either way - keep polling
        time.sleep(1)
    return {**refusal,
            "why": f"taskkill was issued for pid {pid} but the daemon still lists the chat as live "
                   f"after {STOP_CONFIRM_SECS}s - not proceeding on an unconfirmed stop"}
