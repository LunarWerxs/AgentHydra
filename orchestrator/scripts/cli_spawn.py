#!/usr/bin/env python3
"""cli_spawn.py - ACT: start a CONSOLE chat, visible, on a chosen account.

⛔ VISIBLE IS NOT OPTIONAL (owner law, 2026-08-27, restated all through the desktop work: "no
chats you cannot see"). Every chat this starts opens in a REAL terminal - a Windows Terminal
tab when one is available, a console window otherwise. You can read it, scroll it, type into
it and Ctrl-C it exactly like a chat you started yourself. Nothing here is headless; the
console fleet keeps the law and drops only the accessibility automation.

THE DOCTRINE IS A LAUNCH FLAG HERE, AND THAT IS THE POINT (owner, 2026-09-01: "I am getting
sick of having to change things from manual edits to bypass permissions"). On the desktop side
the permission mode is a record on disk that a running app can re-save over, which is why it
needed a stamp at landing, a stamp before every wake, and a five-minute sweep. In the console
it is `--dangerously-skip-permissions` and `--effort max` on the command line: set when the
process starts, impossible to drift, and no prompt is ever shown. The model is passed only
when the caller names one - a chat keeps whatever it was assigned, same standing rule.

Usage: python cli_spawn.py --folder <path> [--prompt "..."] [--account <name>]
                           [--model <id>] [--resume <sessionId>] [--force] [--json]
Exit:  0 started - 2 no usable account, the account is past its usage target, or the chat is
       HELD (--force is a person's word and overrides the latter two) - 3 bad usage -
       1 launch failure.

THE SAME DOORS AS EVERY OTHER LANE (review 2026-09-01): a wake here is a TURN, and a turn is
burn, so the usage bands (bandlib) decide which account may take it, and a HOLD on the chat
being resumed is a person's hands-off word. cli_saturate gated both outside this script; the
direct invocation did not, so a person typing the command by hand could resume a held chat or
fill a cooked account without meaning to. --force lifts both for one act - wired here, as
holdlib says an act script must do for itself.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import cli_accounts
from lib import clilib, peerlib

# The doctrine, as arguments. Nothing else can set these once the process is up, and nothing
# else needs to.
DOCTRINE_ARGS = ["--dangerously-skip-permissions", "--effort", "max"]
# How long to wait for a started chat to publish its session record.
START_WAIT_SECS = 45


def claude_exe() -> str:
    """The Claude CLI on this machine, resolved once and passed absolutely.

    `shutil.which` finds the npm shim (`claude.CMD`) which is what a shell resolves too; the
    native binary under ~/.local/bin is the fallback. Either is fine - what is NOT fine is
    handing a bare name to a terminal we just opened and hoping its PATH agrees.
    """
    for cand in (shutil.which("claude"),
                 str(Path.home() / ".local" / "bin" / "claude.exe"),
                 str(Path.home() / "AppData" / "Roaming" / "npm" / "claude.cmd")):
        if cand and Path(cand).exists():
            return cand
    return "claude"


def _terminal_cmd(config_dir: str, folder: str, claude_args: list[str],
                  title: str) -> tuple[list[str], dict]:
    """The command that opens a VISIBLE terminal running claude with that account's env.

    Windows Terminal when present (a tab per chat, which is the shape the owner asked to see);
    otherwise a plain console window. The env carries CLAUDE_CONFIG_DIR, which is what makes
    this an account choice rather than a directory choice.
    """
    env = {**os.environ, "CLAUDE_CONFIG_DIR": config_dir}
    # ⛔ RESOLVE THE EXECUTABLE, NEVER TRUST PATH INSIDE THE NEW TERMINAL. The first cut passed
    # a bare "claude" to `wt new-tab`; the tab opened, could not resolve it, and closed itself
    # instantly - a spawn that reported success and produced nothing. `claude` here is a .CMD
    # shim, which is also why it is run THROUGH cmd rather than exec'd directly.
    exe = claude_exe()
    inner = " ".join([f'"{exe}"', *(f'"{a}"' for a in claude_args)])
    wt = shutil.which("wt.exe")
    if wt:
        # `cmd /k` keeps the tab open if claude exits, so a failure is READABLE instead of a
        # tab that blinks out of existence.
        return [wt, "-w", "0", "new-tab", "--title", title[:60],
                "--startingDirectory", folder, "cmd", "/k", inner], env
    # No Windows Terminal: a normal console window, still visible, still yours to type into.
    return ["cmd", "/c", "start", title[:60], "cmd", "/k",
            f'cd /d "{folder}" && {inner}'], env


def spawn(folder: str, prompt: str | None, account: str | None,
          model: str | None, resume: str | None, force: bool = False) -> dict:
    from lib import bandlib
    from lib import holdlib
    from lib import hydralib

    # A HOLD outranks the resume unless a person says --force (holdlib's contract, wired here).
    if resume and not force:
        held = holdlib.why_blocked(resume)
        if held:
            return {"ok": False, "why": f"the chat is HELD: {held}"}
    # ⛔ NEVER START THE SAME TASK TWICE (owner, 2026-09-01) - the desktop spawner's rule, here
    # too: a visible chat anywhere in the fleet already carrying this first prompt means this
    # is a duplicate, refused with the existing chat named unless a person says --force.
    if prompt and not resume and not force:
        try:
            dups = hydralib.same_task_chats(prompt)
        except hydralib.DaemonError:
            dups = []  # the daemon is optional for the console fleet; no read, no refusal
        if dups:
            d = dups[0]
            return {"ok": False, "duplicateOf": dups,
                    "why": (f"a chat for this exact task already exists: '{d.get('title')}' in "
                            f"{d.get('instance')} ({'running' if d.get('live') else 'dormant'}) "
                            "- not starting a second one (--force insists)")}
    ready = [a for a in cli_accounts.accounts() if a["loggedIn"]]
    if not ready:
        return {"ok": False, "why": "no console account is logged in yet - "
                                    "run cli_accounts.py to see what each one needs"}
    # THE USAGE BANDS, at this door too. Advisory by design: an unreadable survey blocks
    # nothing (bandlib.snapshot never raises), a cooked account takes no new work.
    bands = bandlib.snapshot()

    def closed(a: dict) -> str:
        band = bandlib.band_of(a["name"], bands)
        return band if band in bandlib.CLOSED_BANDS else ""

    if account:
        picked = next((a for a in ready if account.lower() in a["name"].lower()), None)
        if not picked:
            return {"ok": False, "why": f"no logged-in console account matches {account!r}"}
        if closed(picked) and not force:
            return {"ok": False, "why": (f"account '{picked['name']}' is past its usage target "
                                         f"({closed(picked)}) - it takes no new work; pick "
                                         "another account or --force")}
    else:
        usable = [a for a in ready if not closed(a)]
        if not usable and not force:
            return {"ok": False, "why": ("every logged-in console account is past its usage "
                                         "target - none may take new work until a window "
                                         "resets (--force overrides)")}
        picked = (usable or ready)[0]

    args = list(DOCTRINE_ARGS)
    if model:
        args += ["--model", model]
    if resume:
        args += ["--resume", resume]
    if prompt:
        args.append(prompt)

    # ⛔ A DOUBLE-QUOTE IN AN ARG BREAKS OUT OF cmd's QUOTING. _terminal_cmd wraps each arg in
    # `"..."` and hands the joined string to `cmd /k`; an embedded `"` closes that early and any
    # `&`/`|` that follows runs as a separate cmd command. No current caller passes one (doctrine
    # args are fixed, resume is a session id) - refuse rather than silently mangling or opening
    # the door if one ever does.
    if any('"' in a for a in args):
        return {"ok": False, "why": "a launch argument contains a double-quote character, "
                                    "which cannot be passed through cmd.exe safely - remove it"}

    # ⛔ NEVER RESUME A LIVE ENGINE (review 2026-09-01) - the same rule compact_chat.py applies
    # before touching a transcript: a second `--resume` against a session that already has a
    # live process forks the transcript both then append to. Checked immediately before the
    # terminal command is built, not earlier, so nothing can start between the check and the
    # launch. Unknown never reads as "not live" - a daemon read failure refuses, it does not wave
    # the launch through.
    if resume:
        try:
            live = hydralib.live_for(resume)
        except hydralib.DaemonError as err:
            return {"ok": False, "why": (
                f"cannot tell whether {resume} holds a live engine ({err}) - unknown never "
                "reads as 'not live', refusing rather than risking a forked transcript")}
        if live:
            return {"ok": False, "why": (
                f"chat {resume} already has a live engine (pid {live.get('pid')}) - a second "
                "--resume would fork its transcript")}

    title = f"orch:{Path(folder).name}"
    cmd, env = _terminal_cmd(picked["configDir"], folder, args, title)
    before = {r.get("sessionId") for r in peerlib.live_sessions(picked["configDir"])}
    if resume and resume in before:
        return {"ok": False, "why": (
            f"chat {resume} already has a live engine on '{picked['name']}' - a second "
            "--resume would fork its transcript")}
    try:
        subprocess.Popen(cmd, env=env, close_fds=True)
    except OSError as err:
        return {"ok": False, "why": f"could not open a terminal: {err}"}

    # ⛔ OPENING A TERMINAL IS NOT STARTING A CHAT. The first cut reported success the moment
    # Popen returned, and every one of those "successes" was a tab that opened and died -
    # first because `claude` was not on the new terminal's PATH, then because the account's
    # OAuth had expired. A session that started REGISTERS itself; wait for that, and when it
    # does not appear say so rather than claiming a chat exists.
    started = None
    deadline = time.time() + START_WAIT_SECS
    while time.time() < deadline and started is None:
        time.sleep(2)
        for rec in peerlib.live_sessions(picked["configDir"]):
            same_cwd = (str(rec.get("cwd") or "").lower()
                        == str(Path(folder).resolve()).lower())
            if rec.get("sessionId") not in before and same_cwd:
                started = rec.get("sessionId")
                break
    return {"ok": started is not None, "account": picked["name"],
            "configDir": picked["configDir"], "folder": folder, "model": model,
            "resumed": resume, "args": args, "sessionId": started,
            "terminal": "windows-terminal" if "wt.exe" in cmd[0].lower() else "console",
            "why": ("" if started else
                    "the terminal opened but no session registered - the tab is still open, "
                    "read it: the usual cause is that account not being signed in")}


def main(argv: list[str]) -> int:
    clilib.use_utf8_console()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        return 0
    as_json = "--json" in argv
    opts = {"--folder": None, "--prompt": None, "--account": None,
            "--model": None, "--resume": None}
    i = 0
    while i < len(argv):
        if argv[i] in opts and i + 1 < len(argv):
            opts[argv[i]] = argv[i + 1]
            i += 2
            continue
        i += 1
    folder, prompt = opts["--folder"], opts["--prompt"]
    account, model, resume = opts["--account"], opts["--model"], opts["--resume"]
    if not folder and not resume:
        print(__doc__.strip(), file=sys.stderr)
        return 3
    if folder and not Path(folder).is_dir():
        print(f"REFUSED: {folder!r} is not a directory", file=sys.stderr)
        return 3
    folder = folder or str(Path.cwd())

    got = spawn(folder, prompt, account, model, resume, force="--force" in argv)
    if as_json:
        print(json.dumps(got, indent=2))
    elif got["ok"]:
        print(f"started a console chat on '{got['account']}' in {got['folder']} "
              f"({got['terminal']}) - session {str(got['sessionId'])[:8]}, "
              "permissions and effort set at launch.")
    else:
        print(f"REFUSED: {got['why']}", file=sys.stderr)
    return 0 if got["ok"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
